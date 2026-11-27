//! IP address management (design section 9). Records the address plan; it
//! never pings or scans.
//!
//! * **Spaces** separate routing domains; every project has `Default`.
//! * **Prefixes** nest by containment, computed (never stored): a prefix's
//!   parent is the smallest prefix in the same space that contains it.
//! * **Ranges** (DHCP pool, reserved, static) sit inside one prefix and
//!   don't overlap.
//! * **Addresses** belong to the smallest prefix containing them (computed);
//!   one outside every prefix is allowed but warned about.
//!
//! Permissions: prefixes on a location need edit rights there (otherwise on
//! the project); ranges follow their prefix; an address assigned to a device
//! needs edit rights on that device (otherwise on the project). Reading is
//! project-wide.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, QueryBuilder, Sqlite, SqliteConnection};

use super::devices::normalize_mac;
use super::places::{check_len, clean_text, merge_text};
use super::{apply_nullable, require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::ip::{self, parse_addr, parse_cidr, Addr, Cidr, Family};
use crate::domain::permissions::{Action, Chain, ScopeType};
use crate::error::{AppError, AppResult};
use crate::hierarchy::{self, Subtree};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

fn unique(e: sqlx::Error, msg: String) -> AppError {
    match &e {
        sqlx::Error::Database(d) if d.is_unique_violation() => AppError::Conflict(msg),
        _ => e.into(),
    }
}

async fn project_exists(conn: &mut SqliteConnection, id: i64) -> AppResult<()> {
    let found: Option<i64> = sqlx::query_scalar("SELECT id FROM projects WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    found.map(|_| ()).ok_or(AppError::NotFound)
}

/// Inserts the Default space for a new project.
pub async fn create_default_space(conn: &mut SqliteConnection, project_id: i64) -> AppResult<()> {
    let now = now_ts();
    sqlx::query(
        "INSERT INTO address_spaces (project_id, name, is_default, created_at, updated_at)
         VALUES (?, 'Default', 1, ?, ?)",
    )
    .bind(project_id)
    .bind(&now)
    .bind(&now)
    .execute(conn)
    .await?;
    Ok(())
}

/// The space to use: the one given (checked against the project) or the
/// project's Default.
async fn space_for(
    conn: &mut SqliteConnection,
    project_id: i64,
    space_id: Option<i64>,
) -> AppResult<i64> {
    let found: Option<i64> = match space_id {
        Some(id) => {
            sqlx::query_scalar("SELECT id FROM address_spaces WHERE id = ? AND project_id = ?")
                .bind(id)
                .bind(project_id)
                .fetch_optional(conn)
                .await?
        }
        None => {
            sqlx::query_scalar(
                "SELECT id FROM address_spaces WHERE project_id = ? AND is_default = 1",
            )
            .bind(project_id)
            .fetch_optional(conn)
            .await?
        }
    };
    found.ok_or_else(|| AppError::bad("Address space not found in this project"))
}

// ---------------------------------------------------------------- spaces

#[derive(FromRow, Serialize)]
pub struct Space {
    id: i64,
    project_id: i64,
    name: String,
    description: Option<String>,
    is_default: bool,
    created_at: String,
    updated_at: String,
}

async fn load_space(conn: &mut SqliteConnection, id: i64) -> AppResult<Space> {
    sqlx::query_as::<_, Space>(
        "SELECT id, project_id, name, description, is_default, created_at, updated_at FROM address_spaces WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

pub async fn list_spaces(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let rows: Vec<(i64, String, Option<String>, bool, i64, i64)> = sqlx::query_as(
        "SELECT s.id, s.name, s.description, s.is_default,
                (SELECT COUNT(*) FROM prefixes p WHERE p.space_id = s.id),
                (SELECT COUNT(*) FROM ip_addresses a WHERE a.space_id = s.id)
         FROM address_spaces s WHERE s.project_id = ? ORDER BY s.is_default DESC, s.name",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "spaces": rows.into_iter().map(|(id, name, description, is_default, prefixes, addresses)| json!({
            "id": id, "name": name, "description": description, "is_default": is_default,
            "prefix_count": prefixes, "address_count": addresses,
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct SpaceFields {
    name: Option<String>,
    description: Option<String>,
}

pub async fn create_space(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<SpaceFields>,
) -> AppResult<(StatusCode, Json<Space>)> {
    require(&current, Action::Write, &Chain::project(project_id))?;
    let name = clean_text(body.name).ok_or_else(|| AppError::bad("name is required"))?;
    check_len("name", &Some(name.clone()), 80)?;
    let mut tx = state.pool.begin().await?;
    project_exists(&mut tx, project_id).await?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO address_spaces (project_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(&name)
    .bind(clean_text(body.description))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| unique(e, format!("A space named {name} already exists")))?
    .last_insert_rowid();
    let space = load_space(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "address_space", Some(id))
            .path(name.clone())
            .project(Some(project_id))
            .changes(json!({ "name": name })),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(space)))
}

pub async fn update_space(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<SpaceFields>,
) -> AppResult<Json<Space>> {
    let mut tx = state.pool.begin().await?;
    let old = load_space(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(old.project_id))?;
    let name = merge_text(body.name, Some(old.name.clone()))
        .ok_or_else(|| AppError::bad("name can't be empty"))?;
    check_len("name", &Some(name.clone()), 80)?;
    sqlx::query("UPDATE address_spaces SET name = ?, description = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(merge_text(body.description, old.description.clone()))
        .bind(now_ts())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| unique(e, format!("A space named {name} already exists")))?;
    let new = load_space(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "address_space", Some(id))
            .path(new.name.clone())
            .project(Some(old.project_id))
            .changes(json!({ "name": [old.name, new.name], "description": [old.description, new.description] })),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(new))
}

pub async fn delete_space(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let space = load_space(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(space.project_id))?;
    if space.is_default {
        return Err(AppError::bad("The Default space can't be deleted"));
    }
    let used: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM prefixes WHERE space_id = ?) + (SELECT COUNT(*) FROM ip_addresses WHERE space_id = ?)",
    )
    .bind(id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if used > 0 {
        return Err(AppError::Conflict(
            "This space still holds prefixes or addresses; delete or move them first".into(),
        ));
    }
    sqlx::query("DELETE FROM address_spaces WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "address_space", Some(id))
            .path(space.name.clone())
            .project(Some(space.project_id)),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- prefixes

#[derive(FromRow, Serialize, Clone)]
pub struct Prefix {
    id: i64,
    project_id: i64,
    space_id: i64,
    cidr: String,
    family: i64,
    prefix_len: i64,
    vlan_id: Option<i64>,
    location_id: Option<i64>,
    role: String,
    status: String,
    gateway: Option<String>,
    dns_servers: Option<String>,
    domain_name: Option<String>,
    description: Option<String>,
    notes: Option<String>,
    source: String,
    external_id: Option<String>,
    missing_from_source_at: Option<String>,
    created_at: String,
    updated_at: String,
}

macro_rules! prefix_columns {
    () => {
        "id, project_id, space_id, cidr, family, prefix_len, vlan_id, location_id, role, status, gateway, dns_servers, \
         domain_name, description, notes, source, external_id, missing_from_source_at, created_at, updated_at"
    };
}

impl Prefix {
    fn cidr(&self) -> Cidr {
        // Stored values were validated on the way in.
        parse_cidr(&self.cidr).unwrap_or(Cidr {
            network: Addr { value: 0, v6: true },
            len: 128,
        })
    }
    fn audit_view(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or_default();
        if let Some(o) = v.as_object_mut() {
            for k in [
                "id",
                "project_id",
                "family",
                "prefix_len",
                "created_at",
                "updated_at",
            ] {
                o.remove(k);
            }
        }
        v
    }
}

async fn load_prefix(conn: &mut SqliteConnection, id: i64) -> AppResult<Prefix> {
    sqlx::query_as::<_, Prefix>(concat!(
        "SELECT ",
        prefix_columns!(),
        " FROM prefixes WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

/// Edit rights for a prefix: its location if it has one, else the project.
async fn prefix_chain(
    conn: &mut SqliteConnection,
    project_id: i64,
    location_id: Option<i64>,
) -> AppResult<Chain> {
    match location_id {
        Some(l) => {
            let placed = hierarchy::find(conn, ScopeType::Location, l)
                .await?
                .ok_or_else(|| AppError::bad("Location not found"))?;
            if placed.project_id != project_id {
                return Err(AppError::bad("That location belongs to another project"));
            }
            Ok(placed.chain)
        }
        None => Ok(Chain::project(project_id)),
    }
}

/// Number of addresses in a prefix, as JSON: a number for IPv4, a string
/// for IPv6 (it can exceed what JSON numbers hold exactly).
fn size_json(c: &Cidr) -> Value {
    match c.family() {
        Family::V4 => json!(c.size() as u64),
        Family::V6 => json!(c.size().to_string()),
    }
}

const NEEDS_VLAN: &[&str] = &["users", "servers", "voice", "printers", "iot"];
const ROLES: &[&str] = &[
    "users",
    "servers",
    "management",
    "voice",
    "printers",
    "iot",
    "guest",
    "transit",
    "wan",
    "loopback",
    "other",
];

#[derive(Deserialize, Default)]
pub struct PrefixFields {
    cidr: Option<String>,
    space_id: Option<i64>,
    #[serde(default, deserialize_with = "super::nullable")]
    vlan_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "super::nullable")]
    location_id: Option<Option<i64>>,
    role: Option<String>,
    status: Option<String>,
    gateway: Option<String>,
    dns_servers: Option<String>,
    domain_name: Option<String>,
    description: Option<String>,
    notes: Option<String>,
}

struct PrefixValues {
    cidr: Cidr,
    vlan_id: Option<i64>,
    location_id: Option<i64>,
    role: String,
    status: String,
    gateway: Option<String>,
    dns_servers: Option<String>,
    domain_name: Option<String>,
    description: Option<String>,
    notes: Option<String>,
}

async fn prefix_values(
    conn: &mut SqliteConnection,
    project_id: i64,
    f: PrefixFields,
    old: Option<&Prefix>,
) -> AppResult<(PrefixValues, Vec<String>)> {
    let cidr = match (&f.cidr, old) {
        (Some(c), _) => parse_cidr(c).map_err(AppError::bad)?,
        (None, Some(o)) => o.cidr(),
        (None, None) => return Err(AppError::bad("cidr is required")),
    };
    let role = f
        .role
        .or(old.map(|o| o.role.clone()))
        .unwrap_or_else(|| "other".into());
    if !ROLES.contains(&role.as_str()) {
        return Err(AppError::bad(format!(
            "role must be one of {}",
            ROLES.join(", ")
        )));
    }
    let status = f
        .status
        .or(old.map(|o| o.status.clone()))
        .unwrap_or_else(|| "active".into());
    if !["planned", "active", "deprecated"].contains(&status.as_str()) {
        return Err(AppError::bad(
            "status must be planned, active or deprecated",
        ));
    }
    let vlan_id = apply_nullable(f.vlan_id, old.and_then(|o| o.vlan_id));
    if let Some(v) = vlan_id {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT id FROM vlans WHERE id = ? AND project_id = ?")
                .bind(v)
                .bind(project_id)
                .fetch_optional(&mut *conn)
                .await?;
        found.ok_or_else(|| AppError::bad("VLAN not found in this project"))?;
    }
    let location_id = apply_nullable(f.location_id, old.and_then(|o| o.location_id));
    let gateway = match merge_text(f.gateway, old.and_then(|o| o.gateway.clone())) {
        None => None,
        Some(g) => {
            let a = parse_addr(&g).map_err(AppError::bad)?;
            if !cidr.contains(a) || cidr.is_network_or_broadcast(a) {
                return Err(AppError::bad(format!(
                    "The gateway must be a usable address in {cidr}"
                )));
            }
            Some(a.to_string())
        }
    };
    let dns_servers = match merge_text(f.dns_servers, old.and_then(|o| o.dns_servers.clone())) {
        None => None,
        Some(list) => {
            let parsed: Vec<String> = list
                .split([',', ' ', ';'])
                .filter(|s| !s.is_empty())
                .map(|s| parse_addr(s).map(|a| a.to_string()))
                .collect::<Result<_, _>>()
                .map_err(AppError::bad)?;
            Some(parsed.join(", "))
        }
    };
    let domain_name = merge_text(f.domain_name, old.and_then(|o| o.domain_name.clone()))
        .map(|d| check_dns_name(&d))
        .transpose()?;
    let description = merge_text(f.description, old.and_then(|o| o.description.clone()));
    check_len("description", &description, 255)?;
    let mut warnings = Vec::new();
    if vlan_id.is_none() && NEEDS_VLAN.contains(&role.as_str()) {
        warnings.push(format!("A {role} prefix usually has a VLAN"));
    }
    Ok((
        PrefixValues {
            cidr,
            vlan_id,
            location_id,
            role,
            status,
            gateway,
            dns_servers,
            domain_name,
            description,
            notes: merge_text(f.notes, old.and_then(|o| o.notes.clone())),
        },
        warnings,
    ))
}

/// Host and domain names: letters, digits, '-' and '_' in dot-separated
/// labels of up to 63 characters, 253 in all. A trailing dot is dropped.
pub fn check_dns_name(name: &str) -> AppResult<String> {
    let n = name.trim().trim_end_matches('.').to_ascii_lowercase();
    let ok = !n.is_empty()
        && n.len() <= 253
        && n.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        });
    if ok {
        Ok(n)
    } else {
        Err(AppError::bad(format!("{name} isn't a valid DNS name")))
    }
}

#[derive(Deserialize)]
pub struct PrefixQuery {
    space_id: Option<i64>,
}

pub async fn list_prefixes(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    Query(q): Query<PrefixQuery>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        prefix: Prefix,
        addresses: i64,
    }
    let mut b: QueryBuilder<Sqlite> = QueryBuilder::new(concat!(
        "SELECT ",
        prefix_columns!(),
        ", (SELECT COUNT(*) FROM ip_addresses a WHERE a.space_id = p.space_id AND a.family = p.family
             AND a.addr_bin BETWEEN p.net_start AND p.net_end) AS addresses
         FROM prefixes p WHERE p.project_id = "
    ));
    b.push_bind(project_id);
    if let Some(s) = q.space_id {
        b.push(" AND p.space_id = ").push_bind(s);
    }
    b.push(" ORDER BY p.space_id, p.family, p.net_start, p.prefix_len");
    let rows: Vec<Row> = b.build_query_as().fetch_all(&state.pool).await?;
    let pools: Vec<(i64, Vec<u8>, Vec<u8>)> = sqlx::query_as(
        "SELECT r.prefix_id, r.start_bin, r.end_bin FROM ip_ranges r JOIN prefixes p ON p.id = r.prefix_id
         WHERE p.project_id = ? AND r.kind = 'dhcp_pool'",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    let mut pool_size: HashMap<i64, u128> = HashMap::new();
    for (prefix, s, e) in pools {
        if let (Some(s), Some(e)) = (Addr::from_bin(&s), Addr::from_bin(&e)) {
            *pool_size.entry(prefix).or_default() += e.value - s.value + 1;
        }
    }
    // Tree by containment: rows are sorted by start then length, so each
    // prefix's parent is on the stack.
    let mut stack: Vec<(i64, i64, Cidr)> = Vec::new(); // (id, space, cidr)
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let c = r.prefix.cidr();
        while let Some((_, space, top)) = stack.last() {
            if *space == r.prefix.space_id && top.contains_cidr(&c) {
                break;
            }
            stack.pop();
        }
        let parent = stack.last().map(|(id, _, _)| *id);
        let depth = stack.len();
        let pool = pool_size.get(&r.prefix.id).copied().unwrap_or(0);
        let (first, last) = c.usable();
        let usable = last.value - first.value + 1;
        let mut v = serde_json::to_value(&r.prefix).unwrap_or_default();
        v["parent_id"] = json!(parent);
        v["depth"] = json!(depth);
        v["size"] = size_json(&c);
        v["address_count"] = json!(r.addresses);
        v["dhcp_pool_size"] = json!(pool as u64);
        if c.family() == Family::V4 {
            let used = (r.addresses as u128 + pool).min(usable);
            v["utilization"] = json!((used * 1000 / usable) as f64 / 10.0);
        }
        stack.push((r.prefix.id, r.prefix.space_id, c));
        out.push(v);
    }
    Ok(Json(json!({
        "prefixes": out,
        "can_edit": current.principal.can(Action::Write, &Chain::project(project_id)),
    })))
}

pub async fn create_prefix(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<PrefixFields>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let mut tx = state.pool.begin().await?;
    let v = create_prefix_in(&mut tx, &ctx, &current, project_id, body).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(v)))
}

/// The work of `create_prefix`, inside the caller's transaction (also used by
/// the CSV importer).
pub async fn create_prefix_in(
    tx: &mut SqliteConnection,
    ctx: &RequestCtx,
    current: &CurrentUser,
    project_id: i64,
    body: PrefixFields,
) -> AppResult<Value> {
    project_exists(&mut *tx, project_id).await?;
    let space_id = space_for(&mut *tx, project_id, body.space_id).await?;
    let (v, warnings) = prefix_values(&mut *tx, project_id, body, None).await?;
    let chain = prefix_chain(&mut *tx, project_id, v.location_id).await?;
    require(current, Action::Write, &chain)?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO prefixes (project_id, space_id, cidr, family, prefix_len, net_start, net_end, vlan_id, location_id,
         role, status, gateway, dns_servers, domain_name, description, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(space_id)
    .bind(v.cidr.to_string())
    .bind(v.cidr.family().number())
    .bind(i64::from(v.cidr.len))
    .bind(v.cidr.start().bin())
    .bind(v.cidr.end().bin())
    .bind(v.vlan_id)
    .bind(v.location_id)
    .bind(&v.role)
    .bind(&v.status)
    .bind(&v.gateway)
    .bind(&v.dns_servers)
    .bind(&v.domain_name)
    .bind(&v.description)
    .bind(&v.notes)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| unique(e, format!("{} already exists in this space", v.cidr)))?
    .last_insert_rowid();
    hierarchy::reindex(&mut *tx, Subtree::Prefix(id)).await?;
    let p = load_prefix(&mut *tx, id).await?;
    audit::record(
        &mut *tx,
        ctx,
        Some(current.actor_ref()),
        Entry::new("create", "prefix", Some(id))
            .path(p.cidr.clone())
            .project(Some(project_id))
            .changes(p.audit_view()),
    )
    .await?;
    let mut out = serde_json::to_value(&p).unwrap_or_default();
    out["warnings"] = json!(warnings);
    Ok(out)
}

#[derive(FromRow, Serialize)]
struct RangeRow {
    id: i64,
    prefix_id: i64,
    start_text: String,
    end_text: String,
    #[serde(skip)]
    start_bin: Vec<u8>,
    #[serde(skip)]
    end_bin: Vec<u8>,
    kind: String,
    description: Option<String>,
    source: String,
    external_id: Option<String>,
    missing_from_source_at: Option<String>,
    created_at: String,
    updated_at: String,
}

impl RangeRow {
    fn bounds(&self) -> Option<(Addr, Addr)> {
        Some((
            Addr::from_bin(&self.start_bin)?,
            Addr::from_bin(&self.end_bin)?,
        ))
    }
}

macro_rules! range_columns {
    () => {
        "id, prefix_id, start_text, end_text, start_bin, end_bin, kind, description, source, external_id, \
         missing_from_source_at, created_at, updated_at"
    };
}

async fn ranges_of(conn: &mut SqliteConnection, prefix_id: i64) -> AppResult<Vec<RangeRow>> {
    Ok(sqlx::query_as::<_, RangeRow>(concat!(
        "SELECT ",
        range_columns!(),
        " FROM ip_ranges WHERE prefix_id = ? ORDER BY start_bin"
    ))
    .bind(prefix_id)
    .fetch_all(conn)
    .await?)
}

/// The prefixes directly inside `p` (computed).
async fn children_of(conn: &mut SqliteConnection, p: &Prefix) -> AppResult<Vec<Prefix>> {
    let c = p.cidr();
    let inside = sqlx::query_as::<_, Prefix>(concat!(
        "SELECT ",
        prefix_columns!(),
        " FROM prefixes WHERE space_id = ? AND family = ? AND id <> ? AND prefix_len > ?
          AND net_start >= ? AND net_end <= ? ORDER BY net_start, prefix_len"
    ))
    .bind(p.space_id)
    .bind(p.family)
    .bind(p.id)
    .bind(p.prefix_len)
    .bind(c.start().bin())
    .bind(c.end().bin())
    .fetch_all(conn)
    .await?;
    // Keep only those not inside another child.
    let mut direct: Vec<Prefix> = Vec::new();
    for q in inside {
        let qc = q.cidr();
        if !direct.iter().any(|d| d.cidr().contains_cidr(&qc)) {
            direct.push(q);
        }
    }
    Ok(direct)
}

/// The smallest prefix containing `p` (other than itself).
async fn parent_of(conn: &mut SqliteConnection, p: &Prefix) -> AppResult<Option<Prefix>> {
    let c = p.cidr();
    Ok(sqlx::query_as::<_, Prefix>(concat!(
        "SELECT ",
        prefix_columns!(),
        " FROM prefixes WHERE space_id = ? AND family = ? AND id <> ? AND prefix_len < ?
          AND net_start <= ? AND net_end >= ? ORDER BY prefix_len DESC LIMIT 1"
    ))
    .bind(p.space_id)
    .bind(p.family)
    .bind(p.id)
    .bind(p.prefix_len)
    .bind(c.start().bin())
    .bind(c.end().bin())
    .fetch_optional(conn)
    .await?)
}

pub async fn get_prefix(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let p = load_prefix(&mut conn, id).await?;
    require(&current, Action::Read, &Chain::project(p.project_id))?;
    let c = p.cidr();
    let children = children_of(&mut conn, &p).await?;
    let parent = parent_of(&mut conn, &p).await?;
    let ranges = ranges_of(&mut conn, id).await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ip_addresses WHERE space_id = ? AND family = ? AND addr_bin BETWEEN ? AND ?",
    )
    .bind(p.space_id)
    .bind(p.family)
    .bind(c.start().bin())
    .bind(c.end().bin())
    .fetch_one(&mut *conn)
    .await?;
    // The page shows the first addresses directly in this prefix; the
    // address list (`?prefix_id=`) pages through all of them.
    let mut addresses =
        addresses_between(&mut conn, p.space_id, c.start(), c.end(), DETAIL_LIMIT + 1).await?;
    let truncated = addresses.len() > DETAIL_LIMIT as usize;
    addresses.truncate(DETAIL_LIMIT as usize);
    addresses.retain(|a| {
        !Addr::from_bin(&a.addr_bin)
            .is_some_and(|x| children.iter().any(|ch| ch.cidr().contains(x)))
    });
    let pool: u128 = ranges
        .iter()
        .filter(|r| r.kind == "dhcp_pool")
        .filter_map(RangeRow::bounds)
        .map(|(s, e)| e.value - s.value + 1)
        .sum();
    let chain = prefix_chain(&mut conn, p.project_id, p.location_id).await?;
    let mut v = serde_json::to_value(&p).unwrap_or_default();
    v["size"] = size_json(&c);
    v["address_count"] = json!(total);
    v["dhcp_pool_size"] = json!(pool as u64);
    v["parent"] = json!(parent.map(|x| json!({ "id": x.id, "cidr": x.cidr })));
    v["children"] = json!(children);
    v["ranges"] = json!(ranges);
    v["addresses"] = json!(addresses
        .iter()
        .map(AddressRow::to_json)
        .collect::<Vec<_>>());
    v["addresses_truncated"] = json!(truncated);
    v["can_edit"] = json!(current.principal.can(Action::Write, &chain));
    Ok(Json(v))
}

pub async fn update_prefix(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<PrefixFields>,
) -> AppResult<Json<Value>> {
    if body.space_id.is_some() {
        return Err(AppError::bad("A prefix can't change address space"));
    }
    let mut tx = state.pool.begin().await?;
    let old = load_prefix(&mut tx, id).await?;
    let old_chain = prefix_chain(&mut tx, old.project_id, old.location_id).await?;
    require(&current, Action::Write, &old_chain)?;
    let (v, warnings) = prefix_values(&mut tx, old.project_id, body, Some(&old)).await?;
    if v.location_id != old.location_id {
        let chain = prefix_chain(&mut tx, old.project_id, v.location_id).await?;
        require(&current, Action::Write, &chain)?;
    }
    if v.cidr != old.cidr() {
        for r in ranges_of(&mut tx, id).await? {
            if let Some((s, e)) = r.bounds() {
                if !v.cidr.contains(s) || !v.cidr.contains(e) {
                    return Err(AppError::Conflict(format!(
                        "The range {}-{} would fall outside {}",
                        r.start_text, r.end_text, v.cidr
                    )));
                }
            }
        }
    }
    sqlx::query(
        "UPDATE prefixes SET cidr = ?, family = ?, prefix_len = ?, net_start = ?, net_end = ?, vlan_id = ?, location_id = ?,
         role = ?, status = ?, gateway = ?, dns_servers = ?, domain_name = ?, description = ?, notes = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(v.cidr.to_string())
    .bind(v.cidr.family().number())
    .bind(i64::from(v.cidr.len))
    .bind(v.cidr.start().bin())
    .bind(v.cidr.end().bin())
    .bind(v.vlan_id)
    .bind(v.location_id)
    .bind(&v.role)
    .bind(&v.status)
    .bind(&v.gateway)
    .bind(&v.dns_servers)
    .bind(&v.domain_name)
    .bind(&v.description)
    .bind(&v.notes)
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| unique(e, format!("{} already exists in this space", v.cidr)))?;
    hierarchy::reindex(&mut tx, Subtree::Prefix(id)).await?;
    let new = load_prefix(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "prefix", Some(id))
            .path(new.cidr.clone())
            .project(Some(new.project_id))
            .changes(audit::diff(&old.audit_view(), &new.audit_view(), &[])),
    )
    .await?;
    tx.commit().await?;
    let mut out = serde_json::to_value(&new).unwrap_or_default();
    out["warnings"] = json!(warnings);
    Ok(Json(out))
}

pub async fn delete_prefix(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let p = load_prefix(&mut tx, id).await?;
    let chain = prefix_chain(&mut tx, p.project_id, p.location_id).await?;
    require(&current, Action::Write, &chain)?;
    let ranges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ip_ranges WHERE prefix_id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM prefixes WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    hierarchy::reindex(&mut tx, Subtree::Prefix(id)).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "prefix", Some(id))
            .path(p.cidr.clone())
            .project(Some(p.project_id))
            .changes(json!({ "ranges_removed": ranges, "addresses_kept": true })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Address intervals a new address can't take in `p`: documented
/// addresses, DHCP pools and reserved ranges, and the gateway.
async fn taken_in(
    conn: &mut SqliteConnection,
    p: &Prefix,
    pools_too: bool,
) -> AppResult<Vec<(Addr, Addr)>> {
    let c = p.cidr();
    // One JSON value instead of one decoded row per address.
    let addrs: Option<String> = sqlx::query_scalar(
        "SELECT json_group_array(hex(addr_bin)) FROM ip_addresses
         WHERE space_id = ? AND family = ? AND addr_bin BETWEEN ? AND ?",
    )
    .bind(p.space_id)
    .bind(p.family)
    .bind(c.start().bin())
    .bind(c.end().bin())
    .fetch_one(&mut *conn)
    .await?;
    let hexes: Vec<String> = crate::routes::ports::from_json_list(addrs)?;
    let mut taken: Vec<(Addr, Addr)> = hexes
        .iter()
        .filter_map(|h| u128::from_str_radix(h, 16).ok())
        .filter_map(|v| Addr::from_bin(&v.to_be_bytes()))
        .map(|a| (a, a))
        .collect();
    if pools_too {
        for r in ranges_of(conn, p.id).await? {
            if r.kind != "static" {
                if let Some(b) = r.bounds() {
                    taken.push(b);
                }
            }
        }
    }
    if let Some(g) = p.gateway.as_deref().and_then(|g| parse_addr(g).ok()) {
        taken.push((g, g));
    }
    Ok(taken)
}

#[derive(Deserialize)]
pub struct NextFreeQuery {
    count: Option<usize>,
    /// Look inside this range (e.g. a static range) instead of the whole prefix.
    range_id: Option<i64>,
}

/// The first free addresses: not documented, not in a DHCP pool or
/// reserved range, not the network, broadcast or gateway address.
pub async fn next_free(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
    Query(q): Query<NextFreeQuery>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let p = load_prefix(&mut conn, id).await?;
    require(&current, Action::Read, &Chain::project(p.project_id))?;
    let count = q.count.unwrap_or(1).clamp(1, 256);
    let free = match q.range_id {
        None => {
            let taken = taken_in(&mut conn, &p, true).await?;
            ip::next_free(&p.cidr(), &taken, count)
        }
        Some(r) => {
            let range = ranges_of(&mut conn, id)
                .await?
                .into_iter()
                .find(|x| x.id == r)
                .ok_or_else(|| AppError::bad("That range isn't in this prefix"))?;
            let (s, e) = range
                .bounds()
                .ok_or_else(|| AppError::internal("bad range"))?;
            let mut taken = taken_in(&mut conn, &p, false).await?;
            let c = p.cidr();
            if c.is_network_or_broadcast(c.start()) {
                taken.push((c.start(), c.start()));
                taken.push((c.end(), c.end()));
            }
            ip::within(s, e, &taken, count)
        }
    };
    Ok(Json(json!({
        "addresses": free.iter().map(Addr::to_string).collect::<Vec<_>>(),
    })))
}

/// One cell per documented address and one run per range, for drawing an
/// IPv4 prefix (up to /22) as a grid. Offsets count from the network address.
pub async fn grid(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let p = load_prefix(&mut conn, id).await?;
    require(&current, Action::Read, &Chain::project(p.project_id))?;
    let c = p.cidr();
    if c.family() != Family::V4 || c.len < 22 {
        return Err(AppError::bad(
            "The grid is for IPv4 prefixes of /22 or smaller; use the address list instead",
        ));
    }
    let base = c.start().value;
    let ranges = ranges_of(&mut conn, id).await?;
    let addresses = addresses_between(&mut conn, p.space_id, c.start(), c.end(), 1024).await?;
    let gateway = p
        .gateway
        .as_deref()
        .and_then(|g| parse_addr(g).ok())
        .map(|g| (g.value - base) as u64);
    // The lease layer: what DHCP servers last reported (not documentation).
    #[allow(clippy::type_complexity)]
    let leases: Vec<(String, Vec<u8>, Option<String>, Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT address, addr_bin, mac, hostname, expires_at, captured_at FROM dhcp_lease_snapshots
         WHERE space_id = ? AND family = 4 AND addr_bin BETWEEN ? AND ? ORDER BY addr_bin LIMIT 1024",
    )
    .bind(p.space_id)
    .bind(c.start().bin())
    .bind(c.end().bin())
    .fetch_all(&mut *conn)
    .await?;
    Ok(Json(json!({
        "leases": leases.iter().filter_map(|(addr, bin, mac, host, exp, seen)| {
            let x = Addr::from_bin(bin)?;
            Some(json!({ "offset": (x.value - base) as u64, "address": addr, "mac": mac, "hostname": host,
                         "expires_at": exp, "seen_at": seen }))
        }).collect::<Vec<_>>(),
        "cidr": p.cidr,
        "size": c.size() as u64,
        "network": if c.len < 31 { Some(0) } else { None },
        "broadcast": if c.len < 31 { Some((c.size() - 1) as u64) } else { None },
        "gateway": gateway,
        "ranges": ranges.iter().filter_map(|r| {
            let (s, e) = r.bounds()?;
            Some(json!({ "id": r.id, "kind": r.kind, "from": (s.value - base) as u64, "to": (e.value - base) as u64,
                         "description": r.description }))
        }).collect::<Vec<_>>(),
        "addresses": addresses.iter().filter_map(|a| {
            let x = Addr::from_bin(&a.addr_bin)?;
            let mut v = a.to_json();
            v["offset"] = json!((x.value - base) as u64);
            Some(v)
        }).collect::<Vec<_>>(),
    })))
}

// ---------------------------------------------------------------- ranges

#[derive(Deserialize)]
pub struct RangeFields {
    start: Option<String>,
    end: Option<String>,
    kind: Option<String>,
    description: Option<String>,
}

async fn load_range(conn: &mut SqliteConnection, id: i64) -> AppResult<RangeRow> {
    sqlx::query_as::<_, RangeRow>(concat!(
        "SELECT ",
        range_columns!(),
        " FROM ip_ranges WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

/// Validates a range in a prefix. Returns warnings.
async fn check_range(
    conn: &mut SqliteConnection,
    p: &Prefix,
    s: Addr,
    e: Addr,
    kind: &str,
    self_id: Option<i64>,
) -> AppResult<Vec<String>> {
    if !["dhcp_pool", "reserved", "static"].contains(&kind) {
        return Err(AppError::bad("kind must be dhcp_pool, reserved or static"));
    }
    let c = p.cidr();
    if !c.contains(s) || !c.contains(e) {
        return Err(AppError::bad(format!(
            "The range must be inside {}",
            p.cidr
        )));
    }
    if s > e {
        return Err(AppError::bad("The range starts after it ends"));
    }
    if c.is_network_or_broadcast(s) || c.is_network_or_broadcast(e) {
        return Err(AppError::bad(
            "A range can't include the network or broadcast address",
        ));
    }
    let clash: Option<(String, String)> = sqlx::query_as(
        "SELECT start_text, end_text FROM ip_ranges WHERE prefix_id = ? AND id <> ? AND start_bin <= ? AND end_bin >= ?",
    )
    .bind(p.id)
    .bind(self_id.unwrap_or(-1))
    .bind(e.bin())
    .bind(s.bin())
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((a, b)) = clash {
        return Err(AppError::Conflict(format!(
            "That overlaps the range {a}-{b}"
        )));
    }
    let mut warnings = Vec::new();
    if kind == "dhcp_pool" {
        let statics: Vec<String> = sqlx::query_scalar(
            "SELECT address FROM ip_addresses WHERE space_id = ? AND family = ? AND addr_bin BETWEEN ? AND ?
             AND dhcp_reservation = 0 AND status <> 'deprecated' ORDER BY addr_bin LIMIT 20",
        )
        .bind(p.space_id)
        .bind(p.family)
        .bind(s.bin())
        .bind(e.bin())
        .fetch_all(&mut *conn)
        .await?;
        if !statics.is_empty() {
            warnings.push(format!(
                "Static addresses inside this DHCP pool: {}",
                statics.join(", ")
            ));
        }
        if let Some(g) = p.gateway.as_deref().and_then(|g| parse_addr(g).ok()) {
            if g >= s && g <= e {
                warnings.push("The gateway is inside this DHCP pool".into());
            }
        }
    }
    Ok(warnings)
}

pub async fn create_range(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(prefix_id): Path<i64>,
    JsonBody(body): JsonBody<RangeFields>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let mut tx = state.pool.begin().await?;
    let v = create_range_in(&mut tx, &ctx, &current, prefix_id, body).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(v)))
}

/// The work of `create_range`, inside the caller's transaction (also used by
/// the CSV importer).
pub async fn create_range_in(
    tx: &mut SqliteConnection,
    ctx: &RequestCtx,
    current: &CurrentUser,
    prefix_id: i64,
    body: RangeFields,
) -> AppResult<Value> {
    let p = load_prefix(&mut *tx, prefix_id).await?;
    let chain = prefix_chain(&mut *tx, p.project_id, p.location_id).await?;
    require(current, Action::Write, &chain)?;
    let s = parse_addr(
        body.start
            .as_deref()
            .ok_or_else(|| AppError::bad("start is required"))?,
    )
    .map_err(AppError::bad)?;
    let e = parse_addr(
        body.end
            .as_deref()
            .ok_or_else(|| AppError::bad("end is required"))?,
    )
    .map_err(AppError::bad)?;
    let kind = body.kind.unwrap_or_else(|| "dhcp_pool".into());
    let warnings = check_range(&mut *tx, &p, s, e, &kind, None).await?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO ip_ranges (prefix_id, start_text, end_text, start_bin, end_bin, kind, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(prefix_id)
    .bind(s.to_string())
    .bind(e.to_string())
    .bind(s.bin())
    .bind(e.bin())
    .bind(&kind)
    .bind(clean_text(body.description))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    let r = load_range(&mut *tx, id).await?;
    audit::record(
        &mut *tx,
        ctx,
        Some(current.actor_ref()),
        Entry::new("create", "ip_range", Some(id))
            .path(format!("{} {}-{}", p.cidr, r.start_text, r.end_text))
            .project(Some(p.project_id))
            .changes(json!({ "kind": kind, "start": r.start_text, "end": r.end_text })),
    )
    .await?;
    let mut v = serde_json::to_value(&r).unwrap_or_default();
    v["warnings"] = json!(warnings);
    Ok(v)
}

pub async fn update_range(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<RangeFields>,
) -> AppResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let old = load_range(&mut tx, id).await?;
    let p = load_prefix(&mut tx, old.prefix_id).await?;
    let chain = prefix_chain(&mut tx, p.project_id, p.location_id).await?;
    require(&current, Action::Write, &chain)?;
    let s = parse_addr(body.start.as_deref().unwrap_or(&old.start_text)).map_err(AppError::bad)?;
    let e = parse_addr(body.end.as_deref().unwrap_or(&old.end_text)).map_err(AppError::bad)?;
    let kind = body.kind.unwrap_or(old.kind.clone());
    let warnings = check_range(&mut tx, &p, s, e, &kind, Some(id)).await?;
    sqlx::query(
        "UPDATE ip_ranges SET start_text = ?, end_text = ?, start_bin = ?, end_bin = ?, kind = ?, description = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(s.to_string())
    .bind(e.to_string())
    .bind(s.bin())
    .bind(e.bin())
    .bind(&kind)
    .bind(merge_text(body.description, old.description.clone()))
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let new = load_range(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "ip_range", Some(id))
            .path(format!("{} {}-{}", p.cidr, new.start_text, new.end_text))
            .project(Some(p.project_id))
            .changes(audit::diff(
                &serde_json::to_value(&old).unwrap_or_default(),
                &serde_json::to_value(&new).unwrap_or_default(),
                &[],
            )),
    )
    .await?;
    tx.commit().await?;
    let mut v = serde_json::to_value(&new).unwrap_or_default();
    v["warnings"] = json!(warnings);
    Ok(Json(v))
}

pub async fn delete_range(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let r = load_range(&mut tx, id).await?;
    let p = load_prefix(&mut tx, r.prefix_id).await?;
    let chain = prefix_chain(&mut tx, p.project_id, p.location_id).await?;
    require(&current, Action::Write, &chain)?;
    sqlx::query("DELETE FROM ip_ranges WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "ip_range", Some(id))
            .path(format!("{} {}-{}", p.cidr, r.start_text, r.end_text))
            .project(Some(p.project_id))
            .changes(json!({ "kind": r.kind })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- addresses

#[derive(FromRow, Serialize)]
pub struct AddressRow {
    id: i64,
    project_id: i64,
    space_id: i64,
    address: String,
    family: i64,
    #[serde(skip)]
    addr_bin: Vec<u8>,
    prefix_len: Option<i64>,
    device_id: Option<i64>,
    port_id: Option<i64>,
    role: String,
    status: String,
    mac: Option<String>,
    dns_name: Option<String>,
    #[serde(skip)]
    dns_aliases: Option<String>,
    dhcp_reservation: bool,
    description: Option<String>,
    notes: Option<String>,
    source: String,
    external_id: Option<String>,
    missing_from_source_at: Option<String>,
    created_at: String,
    updated_at: String,
    device_path: Option<String>,
    port_path: Option<String>,
}

macro_rules! address_select {
    () => {
        "SELECT a.id, a.project_id, a.space_id, a.address, a.family, a.addr_bin, a.prefix_len, a.device_id, a.port_id, \
         a.role, a.status, a.mac, a.dns_name, a.dns_aliases, a.dhcp_reservation, a.description, a.notes, a.source, \
         a.external_id, a.missing_from_source_at, a.created_at, a.updated_at, ds.path AS device_path, ps.path AS port_path \
         FROM ip_addresses a \
         LEFT JOIN search_entries ds ON ds.kind = 'device' AND ds.ref_id = a.device_id \
         LEFT JOIN search_entries ps ON ps.kind = 'port' AND ps.ref_id = a.port_id "
    };
}

impl AddressRow {
    fn aliases(&self) -> Vec<String> {
        self.dns_aliases
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }
    pub fn to_json(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or_default();
        v["dns_aliases"] = json!(self.aliases());
        v
    }
    fn audit_view(&self) -> Value {
        let mut v = self.to_json();
        if let Some(o) = v.as_object_mut() {
            for k in [
                "id",
                "project_id",
                "family",
                "created_at",
                "updated_at",
                "device_path",
            ] {
                o.remove(k);
            }
        }
        v
    }
    fn addr(&self) -> Option<Addr> {
        Addr::from_bin(&self.addr_bin)
    }
}

async fn load_address(conn: &mut SqliteConnection, id: i64) -> AppResult<AddressRow> {
    sqlx::query_as::<_, AddressRow>(concat!(address_select!(), "WHERE a.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

const DETAIL_LIMIT: i64 = 1000;

async fn addresses_between(
    conn: &mut SqliteConnection,
    space_id: i64,
    s: Addr,
    e: Addr,
    limit: i64,
) -> AppResult<Vec<AddressRow>> {
    Ok(sqlx::query_as::<_, AddressRow>(concat!(
        address_select!(),
        "WHERE a.space_id = ? AND a.family = ? AND a.addr_bin BETWEEN ? AND ? ORDER BY a.addr_bin LIMIT ?"
    ))
    .bind(space_id)
    .bind(s.family().number())
    .bind(s.bin())
    .bind(e.bin())
    .bind(limit)
    .fetch_all(conn)
    .await?)
}

/// The smallest prefix containing an address.
async fn prefix_for(
    conn: &mut SqliteConnection,
    space_id: i64,
    a: Addr,
) -> AppResult<Option<Prefix>> {
    Ok(sqlx::query_as::<_, Prefix>(concat!(
        "SELECT ",
        prefix_columns!(),
        " FROM prefixes WHERE space_id = ? AND family = ? AND net_start <= ? AND net_end >= ?
          ORDER BY prefix_len DESC LIMIT 1"
    ))
    .bind(space_id)
    .bind(a.family().number())
    .bind(a.bin())
    .bind(a.bin())
    .fetch_optional(conn)
    .await?)
}

/// Edit rights for an address: its device if assigned, else the project.
async fn address_chain(
    conn: &mut SqliteConnection,
    project_id: i64,
    device_id: Option<i64>,
) -> AppResult<Chain> {
    match device_id {
        Some(d) => Ok(hierarchy::get(conn, ScopeType::Device, d).await?.chain),
        None => Ok(Chain::project(project_id)),
    }
}

#[derive(Deserialize, Default)]
pub struct AddressFields {
    /// The address; omit it and give `prefix_id` to take the next free one.
    address: Option<String>,
    prefix_id: Option<i64>,
    space_id: Option<i64>,
    #[serde(default, deserialize_with = "super::nullable")]
    prefix_len: Option<Option<i64>>,
    #[serde(default, deserialize_with = "super::nullable")]
    device_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "super::nullable")]
    port_id: Option<Option<i64>>,
    role: Option<String>,
    status: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    mac: Option<Option<String>>,
    dns_name: Option<String>,
    dns_aliases: Option<Vec<String>>,
    dhcp_reservation: Option<bool>,
    description: Option<String>,
    notes: Option<String>,
}

struct AddressValues {
    addr: Addr,
    prefix_len: Option<i64>,
    device_id: Option<i64>,
    port_id: Option<i64>,
    role: String,
    status: String,
    mac: Option<String>,
    dns_name: Option<String>,
    dns_aliases: Option<String>,
    dhcp_reservation: bool,
    description: Option<String>,
    notes: Option<String>,
}

async fn address_values(
    conn: &mut SqliteConnection,
    project_id: i64,
    space_id: i64,
    addr: Addr,
    f: AddressFields,
    old: Option<&AddressRow>,
) -> AppResult<(AddressValues, Vec<String>)> {
    let mut warnings = Vec::new();
    let prefix = prefix_for(conn, space_id, addr).await?;
    match &prefix {
        None => warnings.push(format!("{addr} isn't inside any documented prefix")),
        Some(p) => {
            if p.cidr().is_network_or_broadcast(addr) {
                return Err(AppError::bad(format!(
                    "{addr} is the network or broadcast address of {}",
                    p.cidr
                )));
            }
        }
    }
    let prefix_len = apply_nullable(f.prefix_len, old.and_then(|o| o.prefix_len))
        .or(prefix.as_ref().map(|p| p.prefix_len));
    if prefix_len.is_some_and(|l| l < 0 || l > i64::from(addr.family().bits())) {
        return Err(AppError::bad("prefix_len doesn't fit the address family"));
    }
    // Port implies device; both must be in this project.
    let mut port_id = apply_nullable(f.port_id, old.and_then(|o| o.port_id));
    let mut device_id = apply_nullable(f.device_id, old.and_then(|o| o.device_id));
    if f.device_id == Some(None) && f.port_id.is_none() {
        port_id = None;
    }
    if let Some(port) = port_id {
        let found: Option<(i64, i64)> = sqlx::query_as(
            "SELECT o.device_id, d.project_id FROM ports o JOIN devices d ON d.id = o.device_id WHERE o.id = ?",
        )
        .bind(port)
        .fetch_optional(&mut *conn)
        .await?;
        let (dev, proj) = found.ok_or_else(|| AppError::bad("Port not found"))?;
        if proj != project_id {
            return Err(AppError::bad("That port belongs to another project"));
        }
        if device_id.is_some_and(|d| d != dev) && f.device_id.is_some() {
            return Err(AppError::bad("That port belongs to another device"));
        }
        device_id = Some(dev);
    }
    if let Some(d) = device_id {
        let proj: Option<i64> = sqlx::query_scalar("SELECT project_id FROM devices WHERE id = ?")
            .bind(d)
            .fetch_optional(&mut *conn)
            .await?;
        if proj.ok_or_else(|| AppError::bad("Device not found"))? != project_id {
            return Err(AppError::bad("That device belongs to another project"));
        }
    }
    let role = f
        .role
        .or(old.map(|o| o.role.clone()))
        .unwrap_or_else(|| "primary".into());
    if !["primary", "secondary", "gateway", "vip", "loopback"].contains(&role.as_str()) {
        return Err(AppError::bad(
            "role must be primary, secondary, gateway, vip or loopback",
        ));
    }
    let status = f
        .status
        .or(old.map(|o| o.status.clone()))
        .unwrap_or_else(|| {
            if device_id.is_some() {
                "assigned"
            } else {
                "reserved"
            }
            .into()
        });
    if !["reserved", "assigned", "deprecated"].contains(&status.as_str()) {
        return Err(AppError::bad(
            "status must be reserved, assigned or deprecated",
        ));
    }
    let mac = match f.mac {
        None => old.and_then(|o| o.mac.clone()),
        Some(None) => None,
        Some(Some(m)) if m.trim().is_empty() => None,
        Some(Some(m)) => Some(normalize_mac(&m)?),
    };
    let dhcp_reservation = f
        .dhcp_reservation
        .or(old.map(|o| o.dhcp_reservation))
        .unwrap_or(false);
    if dhcp_reservation && mac.is_none() {
        return Err(AppError::bad("A DHCP reservation needs a MAC address"));
    }
    let dns_name = merge_text(f.dns_name, old.and_then(|o| o.dns_name.clone()))
        .map(|d| check_dns_name(&d))
        .transpose()?;
    let dns_aliases = match f.dns_aliases {
        None => old.and_then(|o| o.dns_aliases.clone()),
        Some(list) if list.is_empty() => None,
        Some(list) => {
            if list.len() > 50 {
                return Err(AppError::bad("At most 50 DNS aliases"));
            }
            let clean: Vec<String> = list
                .iter()
                .map(|d| check_dns_name(d))
                .collect::<AppResult<_>>()?;
            Some(serde_json::to_string(&clean).unwrap_or_default())
        }
    };
    let description = merge_text(f.description, old.and_then(|o| o.description.clone()));
    check_len("description", &description, 255)?;

    // Warnings that need the database.
    if let Some(p) = &prefix {
        if !dhcp_reservation && status != "deprecated" {
            let in_pool: Option<String> = sqlx::query_scalar(
                "SELECT start_text || '-' || end_text FROM ip_ranges WHERE prefix_id = ? AND kind = 'dhcp_pool'
                 AND start_bin <= ? AND end_bin >= ?",
            )
            .bind(p.id)
            .bind(addr.bin())
            .bind(addr.bin())
            .fetch_optional(&mut *conn)
            .await?;
            if let Some(pool) = in_pool {
                warnings.push(format!(
                    "{addr} is inside the DHCP pool {pool}; the DHCP server may hand it out"
                ));
            }
        }
        if let (Some(port), Some(vlan)) = (port_id, p.vlan_id) {
            let (has_any, has_this): (i64, i64) = sqlx::query_as(
                "SELECT COUNT(*), COALESCE(SUM(vlan_id = ?), 0) FROM port_vlans WHERE port_id = ?",
            )
            .bind(vlan)
            .bind(port)
            .fetch_one(&mut *conn)
            .await?;
            if has_any > 0 && has_this == 0 {
                warnings.push(format!("{} has a VLAN that isn't on this port", p.cidr));
            }
        }
    }
    if let (Some(m), true) = (&mac, dhcp_reservation) {
        let others: Vec<String> = sqlx::query_scalar(
            "SELECT address FROM ip_addresses WHERE project_id = ? AND mac = ? AND dhcp_reservation = 1 AND id <> ?",
        )
        .bind(project_id)
        .bind(m)
        .bind(old.map(|o| o.id).unwrap_or(-1))
        .fetch_all(&mut *conn)
        .await?;
        if !others.is_empty() {
            warnings.push(format!(
                "{m} also has a reservation for {}",
                others.join(", ")
            ));
        }
    }
    Ok((
        AddressValues {
            addr,
            prefix_len,
            device_id,
            port_id,
            role,
            status,
            mac,
            dns_name,
            dns_aliases,
            dhcp_reservation,
            description,
            notes: merge_text(f.notes, old.and_then(|o| o.notes.clone())),
        },
        warnings,
    ))
}

#[derive(Deserialize)]
pub struct AddressQuery {
    space_id: Option<i64>,
    prefix_id: Option<i64>,
    device_id: Option<i64>,
    port_id: Option<i64>,
    status: Option<String>,
    q: Option<String>,
    after_id: Option<i64>,
    limit: Option<i64>,
}

pub async fn list_addresses(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    Query(f): Query<AddressQuery>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let mut conn = state.pool.acquire().await?;
    let limit = f.limit.unwrap_or(200).clamp(1, 1000);
    let mut q: QueryBuilder<Sqlite> = QueryBuilder::new(address_select!());
    q.push("WHERE a.project_id = ").push_bind(project_id);
    if let Some(v) = f.space_id {
        q.push(" AND a.space_id = ").push_bind(v);
    }
    if let Some(pid) = f.prefix_id {
        let p = load_prefix(&mut conn, pid).await?;
        if p.project_id != project_id {
            return Err(AppError::NotFound);
        }
        let c = p.cidr();
        q.push(" AND a.space_id = ")
            .push_bind(p.space_id)
            .push(" AND a.family = ")
            .push_bind(p.family)
            .push(" AND a.addr_bin BETWEEN ")
            .push_bind(c.start().bin())
            .push(" AND ")
            .push_bind(c.end().bin());
    }
    if let Some(v) = f.device_id {
        q.push(" AND a.device_id = ").push_bind(v);
    }
    if let Some(v) = f.port_id {
        q.push(" AND a.port_id = ").push_bind(v);
    }
    if let Some(v) = f.status {
        q.push(" AND a.status = ").push_bind(v);
    }
    if let Some(text) = f.q.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        let like = format!(
            "%{}%",
            text.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        q.push(" AND (a.address LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR a.dns_name LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR a.mac LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR a.description LIKE ")
            .push_bind(like)
            .push(" ESCAPE '\\')");
    }
    if let Some(v) = f.after_id {
        q.push(" AND a.id > ").push_bind(v);
    }
    q.push(" ORDER BY a.id LIMIT ").push_bind(limit + 1);
    let mut rows: Vec<AddressRow> = q.build_query_as().fetch_all(&mut *conn).await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    rows.sort_by(|a, b| (a.space_id, &a.addr_bin).cmp(&(b.space_id, &b.addr_bin)));
    let next = if more {
        rows.iter().map(|r| r.id).max()
    } else {
        None
    };
    Ok(Json(json!({
        "addresses": rows.iter().map(AddressRow::to_json).collect::<Vec<_>>(),
        "next_after_id": next,
    })))
}

pub async fn get_address(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let a = load_address(&mut conn, id).await?;
    require(&current, Action::Read, &Chain::project(a.project_id))?;
    let prefix = match a.addr() {
        Some(x) => prefix_for(&mut conn, a.space_id, x).await?,
        None => None,
    };
    let chain = address_chain(&mut conn, a.project_id, a.device_id).await?;
    let mut v = a.to_json();
    v["prefix"] = json!(prefix.map(
        |p| json!({ "id": p.id, "cidr": p.cidr, "vlan_id": p.vlan_id, "gateway": p.gateway })
    ));
    v["can_edit"] = json!(current.principal.can(Action::Write, &chain));
    Ok(Json(v))
}

pub async fn create_address(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<AddressFields>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let mut tx = state.pool.begin().await?;
    let v = create_address_in(&mut tx, &ctx, &current, project_id, body).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(v)))
}

/// The work of `create_address`, inside the caller's transaction (also used by
/// the CSV importer).
pub async fn create_address_in(
    tx: &mut SqliteConnection,
    ctx: &RequestCtx,
    current: &CurrentUser,
    project_id: i64,
    mut body: AddressFields,
) -> AppResult<Value> {
    project_exists(&mut *tx, project_id).await?;
    let (space_id, addr) = match (body.address.take(), body.prefix_id) {
        (Some(a), _) => {
            let space_id = space_for(&mut *tx, project_id, body.space_id).await?;
            (space_id, parse_addr(&a).map_err(AppError::bad)?)
        }
        (None, Some(pid)) => {
            let p = load_prefix(&mut *tx, pid).await?;
            if p.project_id != project_id {
                return Err(AppError::bad("Prefix not found in this project"));
            }
            let taken = taken_in(&mut *tx, &p, true).await?;
            let free = ip::next_free(&p.cidr(), &taken, 1);
            let a = *free.first().ok_or_else(|| {
                AppError::Conflict(format!("{} has no free address left", p.cidr))
            })?;
            (p.space_id, a)
        }
        (None, None) => {
            return Err(AppError::bad(
                "address (or prefix_id for the next free one) is required",
            ))
        }
    };
    let (v, warnings) = address_values(&mut *tx, project_id, space_id, addr, body, None).await?;
    let chain = address_chain(&mut *tx, project_id, v.device_id).await?;
    require(current, Action::Write, &chain)?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO ip_addresses (project_id, space_id, address, family, addr_bin, prefix_len, device_id, port_id, role,
         status, mac, dns_name, dns_aliases, dhcp_reservation, description, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(space_id)
    .bind(v.addr.to_string())
    .bind(v.addr.family().number())
    .bind(v.addr.bin())
    .bind(v.prefix_len)
    .bind(v.device_id)
    .bind(v.port_id)
    .bind(&v.role)
    .bind(&v.status)
    .bind(&v.mac)
    .bind(&v.dns_name)
    .bind(&v.dns_aliases)
    .bind(v.dhcp_reservation)
    .bind(&v.description)
    .bind(&v.notes)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| unique(e, format!("{} is already documented in this space", v.addr)))?
    .last_insert_rowid();
    hierarchy::reindex(&mut *tx, Subtree::Address(id)).await?;
    let a = load_address(&mut *tx, id).await?;
    audit::record(
        &mut *tx,
        ctx,
        Some(current.actor_ref()),
        Entry::new("create", "ip_address", Some(id))
            .path(a.address.clone())
            .project(Some(project_id))
            .changes(a.audit_view()),
    )
    .await?;
    let mut out = a.to_json();
    out["warnings"] = json!(warnings);
    Ok(out)
}

pub async fn update_address(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(mut body): JsonBody<AddressFields>,
) -> AppResult<Json<Value>> {
    if body.space_id.is_some() || body.prefix_id.is_some() {
        return Err(AppError::bad(
            "An address can't change space here; give a new address instead",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let old = load_address(&mut tx, id).await?;
    let old_chain = address_chain(&mut tx, old.project_id, old.device_id).await?;
    require(&current, Action::Write, &old_chain)?;
    let addr = match body.address.take() {
        Some(a) => parse_addr(&a).map_err(AppError::bad)?,
        None => old
            .addr()
            .ok_or_else(|| AppError::internal("bad stored address"))?,
    };
    let (v, warnings) = address_values(
        &mut tx,
        old.project_id,
        old.space_id,
        addr,
        body,
        Some(&old),
    )
    .await?;
    if v.device_id != old.device_id {
        let chain = address_chain(&mut tx, old.project_id, v.device_id).await?;
        require(&current, Action::Write, &chain)?;
    }
    sqlx::query(
        "UPDATE ip_addresses SET address = ?, family = ?, addr_bin = ?, prefix_len = ?, device_id = ?, port_id = ?, role = ?,
         status = ?, mac = ?, dns_name = ?, dns_aliases = ?, dhcp_reservation = ?, description = ?, notes = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(v.addr.to_string())
    .bind(v.addr.family().number())
    .bind(v.addr.bin())
    .bind(v.prefix_len)
    .bind(v.device_id)
    .bind(v.port_id)
    .bind(&v.role)
    .bind(&v.status)
    .bind(&v.mac)
    .bind(&v.dns_name)
    .bind(&v.dns_aliases)
    .bind(v.dhcp_reservation)
    .bind(&v.description)
    .bind(&v.notes)
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| unique(e, format!("{} is already documented in this space", v.addr)))?;
    hierarchy::reindex(&mut tx, Subtree::Address(id)).await?;
    let new = load_address(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "ip_address", Some(id))
            .path(new.address.clone())
            .project(Some(new.project_id))
            .changes(audit::diff(&old.audit_view(), &new.audit_view(), &[])),
    )
    .await?;
    tx.commit().await?;
    let mut out = new.to_json();
    out["warnings"] = json!(warnings);
    Ok(Json(out))
}

pub async fn delete_address(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let a = load_address(&mut tx, id).await?;
    let chain = address_chain(&mut tx, a.project_id, a.device_id).await?;
    require(&current, Action::Write, &chain)?;
    sqlx::query("DELETE FROM ip_addresses WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    hierarchy::reindex(&mut tx, Subtree::Address(id)).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "ip_address", Some(id))
            .path(a.address.clone())
            .project(Some(a.project_id))
            .changes(a.audit_view()),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- warnings

/// Everything in a project's address plan worth a second look.
pub async fn warnings(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let mut conn = state.pool.acquire().await?;
    let mut out: Vec<Value> = Vec::new();
    let mut push = |kind: &str, resource_type: &str, id: i64, path: &str, message: String| {
        out.push(json!({ "kind": kind, "resource_type": resource_type, "resource_id": id, "path": path, "message": message }));
    };

    let outside: Vec<(i64, String)> = sqlx::query_as(
        "SELECT a.id, a.address FROM ip_addresses a WHERE a.project_id = ? AND NOT EXISTS (
             SELECT 1 FROM prefixes p WHERE p.space_id = a.space_id AND p.family = a.family
             AND a.addr_bin BETWEEN p.net_start AND p.net_end)
         ORDER BY a.addr_bin LIMIT 500",
    )
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, addr) in outside {
        push(
            "outside_prefix",
            "ip_address",
            id,
            &addr,
            format!("{addr} isn't inside any documented prefix"),
        );
    }

    let dup_macs: Vec<(String, String)> = sqlx::query_as(
        "SELECT mac, group_concat(address, ', ') FROM ip_addresses
         WHERE project_id = ? AND dhcp_reservation = 1 AND mac IS NOT NULL
         GROUP BY space_id, mac HAVING COUNT(*) > 1 LIMIT 500",
    )
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    for (mac, addrs) in dup_macs {
        push(
            "duplicate_mac",
            "mac",
            0,
            &mac,
            format!("{mac} has reservations for {addrs}"),
        );
    }

    let in_pools: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT a.id, a.address, r.start_text || '-' || r.end_text FROM ip_addresses a
         JOIN prefixes p ON p.space_id = a.space_id AND p.family = a.family AND a.addr_bin BETWEEN p.net_start AND p.net_end
         JOIN ip_ranges r ON r.prefix_id = p.id AND r.kind = 'dhcp_pool' AND a.addr_bin BETWEEN r.start_bin AND r.end_bin
         WHERE a.project_id = ? AND a.dhcp_reservation = 0 AND a.status <> 'deprecated'
         GROUP BY a.id ORDER BY a.addr_bin LIMIT 500",
    )
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, addr, pool) in in_pools {
        push(
            "static_in_pool",
            "ip_address",
            id,
            &addr,
            format!("{addr} is documented as static inside the DHCP pool {pool}"),
        );
    }

    let vlan_mismatch: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT x.id, x.address, x.cidr FROM (
             SELECT a.id, a.address, a.port_id, a.addr_bin,
                    (SELECT p.vlan_id FROM prefixes p WHERE p.space_id = a.space_id AND p.family = a.family
                     AND a.addr_bin BETWEEN p.net_start AND p.net_end ORDER BY p.prefix_len DESC LIMIT 1) AS vlan_id,
                    (SELECT p.cidr FROM prefixes p WHERE p.space_id = a.space_id AND p.family = a.family
                     AND a.addr_bin BETWEEN p.net_start AND p.net_end ORDER BY p.prefix_len DESC LIMIT 1) AS cidr
             FROM ip_addresses a WHERE a.project_id = ? AND a.port_id IS NOT NULL) x
         WHERE x.vlan_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM port_vlans pv WHERE pv.port_id = x.port_id)
           AND NOT EXISTS (SELECT 1 FROM port_vlans pv WHERE pv.port_id = x.port_id AND pv.vlan_id = x.vlan_id)
         ORDER BY x.addr_bin LIMIT 500",
    )
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, addr, cidr) in vlan_mismatch {
        push(
            "port_vlan",
            "ip_address",
            id,
            &addr,
            format!("{addr} is in {cidr}, whose VLAN isn't on its port"),
        );
    }

    let no_vlan: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, cidr, role FROM prefixes WHERE project_id = ? AND vlan_id IS NULL AND status <> 'deprecated'
         AND role IN ('users', 'servers', 'voice', 'printers', 'iot') ORDER BY space_id, family, net_start LIMIT 500",
    )
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, cidr, role) in no_vlan {
        push(
            "prefix_without_vlan",
            "prefix",
            id,
            &cidr,
            format!("{cidr} ({role}) has no VLAN"),
        );
    }

    let missing: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT 'prefix', id, cidr FROM prefixes WHERE project_id = ? AND missing_from_source_at IS NOT NULL
         UNION ALL
         SELECT 'ip_address', id, address FROM ip_addresses WHERE project_id = ? AND missing_from_source_at IS NOT NULL
         LIMIT 500",
    )
    .bind(project_id)
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    for (kind, id, what) in missing {
        push(
            "missing_from_source",
            &kind,
            id,
            &what,
            format!("{what} is no longer in the source it was imported from"),
        );
    }
    Ok(Json(json!({ "warnings": out })))
}
