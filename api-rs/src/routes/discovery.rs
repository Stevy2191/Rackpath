//! Network discovery API: per-prefix scan settings and "Scan now", SNMP
//! sources, run status, and the review list of discovered hosts.
//!
//! Turning scanning on, scanning, and managing SNMP sources need admin
//! rights on the project. Documenting or ignoring what was found needs edit
//! rights. Reading is project-wide; SNMP credentials are write-only.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{FromRow, SqliteConnection};

use super::{require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::discovery::{
    self, load_prefix_target, load_snmp_source, open_run, snmp_target, SnmpSource, Starter,
};
use crate::domain::discovery::{check_interval, check_snmp_host, check_sweep};
use crate::domain::ip::{parse_cidr, Cidr};
use crate::domain::permissions::{Action, Chain};
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::snmp_source_columns;
use crate::state::AppState;
use crate::util::now_ts;

fn starter(ctx: &RequestCtx, current: &CurrentUser) -> Starter {
    Starter {
        ctx: ctx.clone(),
        actor: Some((current.user.id, current.user.username.clone())),
        trigger: "manual",
    }
}

fn busy() -> AppError {
    AppError::Conflict("Another scan or SNMP poll is running; try again when it finishes".into())
}

#[derive(FromRow)]
struct RunRow {
    id: i64,
    prefix_id: Option<i64>,
    snmp_source_id: Option<i64>,
    trigger: String,
    status: String,
    started_at: String,
    finished_at: Option<String>,
    probed: i64,
    found: i64,
    new_hosts: i64,
    message: Option<String>,
}

impl RunRow {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "prefix_id": self.prefix_id, "snmp_source_id": self.snmp_source_id,
            "trigger": self.trigger, "status": self.status, "started_at": self.started_at,
            "finished_at": self.finished_at, "probed": self.probed, "found": self.found,
            "new_hosts": self.new_hosts, "message": self.message,
        })
    }
}

macro_rules! run_columns {
    () => {
        "id, prefix_id, snmp_source_id, trigger, status, started_at, finished_at, probed, found, new_hosts, message"
    };
}

async fn recent_runs(
    conn: &mut SqliteConnection,
    prefix_id: Option<i64>,
    source_id: Option<i64>,
) -> AppResult<Vec<Value>> {
    let rows = sqlx::query_as::<_, RunRow>(
        concat!(
            "SELECT ",
            run_columns!(),
            " FROM discovery_runs WHERE prefix_id IS ?1 AND snmp_source_id IS ?2 ORDER BY id DESC LIMIT 10"
        ),
    )
    .bind(prefix_id)
    .bind(source_id)
    .fetch_all(conn)
    .await?;
    Ok(rows.iter().map(RunRow::to_json).collect())
}

// ---------------------------------------------------------------- prefixes

pub async fn prefix_discovery(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let p = load_prefix_target(&mut conn, id).await?;
    require(&current, Action::Read, &Chain::project(p.project_id))?;
    let (interval, last): (Option<i64>, Option<String>) =
        sqlx::query_as("SELECT scan_interval_minutes, last_scan_at FROM prefixes WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;
    let scannable = parse_cidr(&p.cidr).and_then(|c| check_sweep(&c));
    Ok(Json(json!({
        "prefix_id": id,
        "scan_enabled": p.scan_enabled,
        "scan_interval_minutes": interval,
        "last_scan_at": last,
        "scannable": scannable.is_ok(),
        "not_scannable_reason": scannable.err(),
        "runs": recent_runs(&mut conn, Some(id), None).await?,
        "can_manage": current.principal.can(Action::Manage, &Chain::project(p.project_id)),
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScanSettings {
    scan_enabled: Option<bool>,
    #[serde(default, deserialize_with = "super::nullable")]
    scan_interval_minutes: Option<Option<i64>>,
}

pub async fn update_prefix_discovery(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<ScanSettings>,
) -> AppResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let p = load_prefix_target(&mut tx, id).await?;
    require(&current, Action::Manage, &Chain::project(p.project_id))?;
    let (old_interval,): (Option<i64>,) =
        sqlx::query_as("SELECT scan_interval_minutes FROM prefixes WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let enabled = body.scan_enabled.unwrap_or(p.scan_enabled);
    let interval = match body.scan_interval_minutes {
        Some(v) => check_interval(v).map_err(AppError::bad)?,
        None => old_interval,
    };
    if enabled {
        check_sweep(&parse_cidr(&p.cidr).map_err(AppError::bad)?).map_err(AppError::bad)?;
    }
    sqlx::query("UPDATE prefixes SET scan_enabled = ?, scan_interval_minutes = ? WHERE id = ?")
        .bind(enabled)
        .bind(interval)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "prefix", Some(id))
            .path(p.cidr.clone())
            .project(Some(p.project_id))
            .changes(audit::diff(
                &json!({ "scan_enabled": p.scan_enabled, "scan_interval_minutes": old_interval }),
                &json!({ "scan_enabled": enabled, "scan_interval_minutes": interval }),
                &[],
            )),
    )
    .await?;
    tx.commit().await?;
    prefix_discovery(State(state), current, Path(id)).await
}

/// Starts a sweep now. Returns at once; follow it at /api/discovery-runs/{id}.
pub async fn scan_prefix(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let p = load_prefix_target(&mut *state.pool.acquire().await?, id).await?;
    require(&current, Action::Manage, &Chain::project(p.project_id))?;
    if !p.scan_enabled {
        return Err(AppError::bad("Turn on scanning for this prefix first"));
    }
    check_sweep(&parse_cidr(&p.cidr).map_err(AppError::bad)?).map_err(AppError::bad)?;
    let guard = state
        .discovery_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| busy())?;
    let run = open_run(&state, p.project_id, Some(p.id), None, "manual").await?;
    let who = starter(&ctx, &current);
    let st = state.clone();
    tokio::spawn(async move {
        discovery::sweep_prefix(&st, &p, run, &who).await;
        drop(guard);
    });
    Ok((StatusCode::ACCEPTED, Json(json!({ "run_id": run }))))
}

pub async fn get_run(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let r = sqlx::query_as::<_, RunRow>(concat!(
        "SELECT ",
        run_columns!(),
        " FROM discovery_runs WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let project_id: i64 = sqlx::query_scalar("SELECT project_id FROM discovery_runs WHERE id = ?")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    require(&current, Action::Read, &Chain::project(project_id))?;
    Ok(Json(r.to_json()))
}

// ---------------------------------------------------------------- review list

#[derive(FromRow)]
struct HostRow {
    id: i64,
    project_id: i64,
    space_id: i64,
    address: String,
    mac: Option<String>,
    dns_name: Option<String>,
    switch_port: Option<String>,
    seen_by_ping: bool,
    seen_by_snmp: bool,
    state: String,
    first_seen_at: String,
    last_seen_at: String,
}

macro_rules! host_columns {
    () => {
        "id, project_id, space_id, address, mac, dns_name, switch_port, seen_by_ping, seen_by_snmp, state, \
         first_seen_at, last_seen_at"
    };
}

async fn load_host(conn: &mut SqliteConnection, id: i64) -> AppResult<HostRow> {
    sqlx::query_as::<_, HostRow>(concat!(
        "SELECT ",
        host_columns!(),
        " FROM discovered_hosts WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
pub struct HostQuery {
    state: Option<String>,
    prefix_id: Option<i64>,
}

pub async fn list_hosts(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    Query(q): Query<HostQuery>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let want = q.state.as_deref().unwrap_or("new");
    if !["new", "ignored", "all"].contains(&want) {
        return Err(AppError::bad("state must be new, ignored or all"));
    }
    let mut conn = state.pool.acquire().await?;
    let prefixes: Vec<(i64, i64, String)> =
        sqlx::query_as("SELECT id, space_id, cidr FROM prefixes WHERE project_id = ?")
            .bind(project_id)
            .fetch_all(&mut *conn)
            .await?;
    let prefixes: Vec<(i64, i64, String, Cidr)> = prefixes
        .into_iter()
        .filter_map(|(id, s, t)| parse_cidr(&t).ok().map(|c| (id, s, t, c)))
        .collect();
    let rows = sqlx::query_as::<_, HostRow>(concat!(
        "SELECT ",
        host_columns!(),
        " FROM discovered_hosts WHERE project_id = ?1 AND (?2 = 'all' OR state = ?2) ORDER BY family, addr_bin"
    ))
    .bind(project_id)
    .bind(want)
    .fetch_all(&mut *conn)
    .await?;
    // The documented address a MAC already has, if it's elsewhere.
    let macs: Vec<(String, String)> = sqlx::query_as(
        "SELECT mac, address FROM ip_addresses WHERE project_id = ? AND mac IS NOT NULL",
    )
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::new();
    for h in rows {
        let Ok(a) = crate::domain::ip::parse_addr(&h.address) else {
            continue;
        };
        // Smallest containing prefix in the host's space.
        let prefix = prefixes
            .iter()
            .filter(|(_, s, _, c)| *s == h.space_id && c.contains(a))
            .max_by_key(|(_, _, _, c)| c.len);
        if let Some(want_prefix) = q.prefix_id {
            if prefix.map(|p| p.0) != Some(want_prefix) {
                continue;
            }
        }
        let documented_as = h
            .mac
            .as_ref()
            .and_then(|m| macs.iter().find(|(mm, _)| mm == m))
            .map(|(_, addr)| addr.clone());
        out.push(json!({
            "id": h.id, "address": h.address, "mac": h.mac, "dns_name": h.dns_name,
            "switch_port": h.switch_port, "seen_by_ping": h.seen_by_ping, "seen_by_snmp": h.seen_by_snmp,
            "state": h.state, "first_seen_at": h.first_seen_at, "last_seen_at": h.last_seen_at,
            "prefix_id": prefix.map(|p| p.0), "prefix": prefix.map(|p| p.2.clone()),
            "mac_documented_at": documented_as,
        }));
    }
    Ok(Json(json!({
        "hosts": out,
        "can_edit": current.principal.can(Action::Write, &Chain::project(project_id)),
    })))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct DocumentFields {
    description: Option<String>,
    device_id: Option<i64>,
    /// Override the reverse DNS name (empty: none).
    dns_name: Option<String>,
}

/// Documents a discovered host as an address and takes it off the list.
pub async fn document_host(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<DocumentFields>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let mut tx = state.pool.begin().await?;
    let h = load_host(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(h.project_id))?;
    let dns = body
        .dns_name
        .or(h.dns_name.clone())
        .filter(|d| !d.trim().is_empty())
        .and_then(|d| super::ipam::check_dns_name(&d).ok());
    let fields = json!({
        "address": h.address, "space_id": h.space_id, "mac": h.mac, "dns_name": dns,
        "description": body.description.filter(|d| !d.trim().is_empty()),
        "device_id": body.device_id,
    });
    let fields = serde_json::from_value(fields).map_err(|e| AppError::bad(e.to_string()))?;
    let address =
        super::ipam::create_address_in(&mut tx, &ctx, &current, h.project_id, fields).await?;
    let addr_id = address["id"].as_i64().unwrap_or_default();
    sqlx::query(
        "UPDATE ip_addresses SET last_seen_at = ?, last_seen_mac = ?, last_seen_port = ? WHERE id = ?",
    )
    .bind(&h.last_seen_at)
    .bind(&h.mac)
    .bind(&h.switch_port)
    .bind(addr_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM discovered_hosts WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "discovered_host", Some(id))
            .path(h.address.clone())
            .project(Some(h.project_id))
            .changes(json!({ "documented_as_ip_address": addr_id })),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(address)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IgnoreBody {
    ignored: bool,
}

/// Ignores a host (it stays on the ignored list and is never offered
/// again), or brings it back.
pub async fn ignore_host(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<IgnoreBody>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let h = load_host(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(h.project_id))?;
    let new_state = if body.ignored { "ignored" } else { "new" };
    sqlx::query("UPDATE discovered_hosts SET state = ? WHERE id = ?")
        .bind(new_state)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "discovered_host", Some(id))
            .path(h.address.clone())
            .project(Some(h.project_id))
            .changes(json!({ "state": [h.state, new_state] })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes a host from the list (it comes back if it's seen again).
pub async fn delete_host(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let h = load_host(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(h.project_id))?;
    sqlx::query("DELETE FROM discovered_hosts WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "discovered_host", Some(id))
            .path(h.address.clone())
            .project(Some(h.project_id)),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- SNMP sources

const AUTH_PROTOCOLS: &[&str] = &["sha1", "sha256", "sha384", "sha512"];
const PRIV_PROTOCOLS: &[&str] = &["aes128", "aes192", "aes256"];

fn source_json(s: &SnmpSource) -> Value {
    let security = match (s.version.as_str(), s.v3_priv_enc.is_some()) {
        ("2c", _) => "v2c",
        (_, true) => "v3_auth_priv",
        _ => "v3_auth_no_priv",
    };
    let mut warnings = Vec::new();
    if s.version == "2c" {
        warnings.push("SNMP v2c sends its community string unencrypted; use SNMPv3 with privacy where the device supports it");
    } else if s.v3_priv_enc.is_none() {
        warnings.push("Without a privacy password the replies (ARP and MAC tables) cross the network unencrypted");
    }
    if s.v3_auth_protocol.as_deref() == Some("sha1") {
        warnings.push("SHA-1 is weak; use SHA-256 or better if the device supports it");
    }
    json!({
        "id": s.id, "project_id": s.project_id, "name": s.name, "host": s.host, "port": s.port,
        "version": s.version, "security": security, "warnings": warnings,
        "has_community": s.community_enc.is_some(), "v3_username": s.v3_username,
        "v3_auth_protocol": s.v3_auth_protocol, "has_auth_password": s.v3_auth_enc.is_some(),
        "v3_priv_protocol": s.v3_priv_protocol, "has_priv_password": s.v3_priv_enc.is_some(),
        "space_id": s.space_id, "read_arp": s.read_arp, "read_mac_table": s.read_mac_table,
        "enabled": s.enabled, "poll_interval_minutes": s.poll_interval_minutes,
        "last_poll_at": s.last_poll_at, "last_status": s.last_status, "last_message": s.last_message,
        "created_at": s.created_at, "updated_at": s.updated_at,
    })
}

pub async fn list_sources(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let rows = sqlx::query_as::<_, SnmpSource>(concat!(
        "SELECT ",
        snmp_source_columns!(),
        " FROM snmp_sources WHERE project_id = ? ORDER BY name"
    ))
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "sources": rows.iter().map(source_json).collect::<Vec<_>>(),
        "can_manage": current.principal.can(Action::Manage, &Chain::project(project_id)),
    })))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct SourceFields {
    name: Option<String>,
    host: Option<String>,
    port: Option<i64>,
    version: Option<String>,
    /// Secrets: omitted = unchanged.
    community: Option<String>,
    v3_username: Option<String>,
    v3_auth_protocol: Option<String>,
    v3_auth_password: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    v3_priv_protocol: Option<Option<String>>,
    v3_priv_password: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    space_id: Option<Option<i64>>,
    read_arp: Option<bool>,
    read_mac_table: Option<bool>,
    enabled: Option<bool>,
    #[serde(default, deserialize_with = "super::nullable")]
    poll_interval_minutes: Option<Option<i64>>,
}

/// The stored values a create or update writes.
struct SourceValues {
    name: String,
    host: String,
    port: i64,
    version: String,
    community_enc: Option<String>,
    v3_username: Option<String>,
    v3_auth_protocol: Option<String>,
    v3_auth_enc: Option<String>,
    v3_priv_protocol: Option<String>,
    v3_priv_enc: Option<String>,
    space_id: Option<i64>,
    read_arp: bool,
    read_mac_table: bool,
    enabled: bool,
    poll_interval_minutes: Option<i64>,
}

fn secret_text(v: &Option<String>, what: &str, min: usize) -> AppResult<Option<String>> {
    match v {
        None => Ok(None),
        Some(s) if s.len() < min || s.len() > 256 => Err(AppError::bad(format!(
            "The {what} must be {min} to 256 characters"
        ))),
        Some(s) => Ok(Some(s.clone())),
    }
}

async fn source_values(
    state: &AppState,
    conn: &mut SqliteConnection,
    project_id: i64,
    f: SourceFields,
    old: Option<&SnmpSource>,
) -> AppResult<SourceValues> {
    let name = f
        .name
        .as_deref()
        .map(str::trim)
        .map(str::to_string)
        .or(old.map(|o| o.name.clone()))
        .filter(|n| !n.is_empty() && n.chars().count() <= 80)
        .ok_or_else(|| AppError::bad("name is required (at most 80 characters)"))?;
    let host = match (&f.host, old) {
        (Some(h), _) => check_snmp_host(h).map_err(AppError::bad)?.to_string(),
        (None, Some(o)) => o.host.clone(),
        (None, None) => return Err(AppError::bad("host is required")),
    };
    let port = f.port.or(old.map(|o| o.port)).unwrap_or(161);
    if !(1..=65535).contains(&port) {
        return Err(AppError::bad("port must be 1 to 65535"));
    }
    let version = f
        .version
        .clone()
        .or(old.map(|o| o.version.clone()))
        .unwrap_or_else(|| "3".into());
    if version != "2c" && version != "3" {
        return Err(AppError::bad("version must be 3 (recommended) or 2c"));
    }
    let same_version = old.map(|o| o.version == version).unwrap_or(false);
    let keep = |v: Option<&Option<String>>| {
        if same_version {
            v.cloned().flatten()
        } else {
            None
        }
    };
    let enc = |s: Option<String>| s.map(|s| state.secrets.encrypt(&s));
    let mut v = SourceValues {
        name,
        host,
        port,
        version: version.clone(),
        community_enc: None,
        v3_username: None,
        v3_auth_protocol: None,
        v3_auth_enc: None,
        v3_priv_protocol: None,
        v3_priv_enc: None,
        space_id: match f.space_id {
            Some(s) => s,
            None => old.and_then(|o| o.space_id),
        },
        read_arp: f.read_arp.or(old.map(|o| o.read_arp)).unwrap_or(true),
        read_mac_table: f
            .read_mac_table
            .or(old.map(|o| o.read_mac_table))
            .unwrap_or(true),
        enabled: f.enabled.or(old.map(|o| o.enabled)).unwrap_or(true),
        poll_interval_minutes: match f.poll_interval_minutes {
            Some(m) => check_interval(m).map_err(AppError::bad)?,
            None => old.and_then(|o| o.poll_interval_minutes),
        },
    };
    if !v.read_arp && !v.read_mac_table {
        return Err(AppError::bad(
            "Read the ARP table, the MAC address table, or both",
        ));
    }
    if version == "2c" {
        v.community_enc = enc(secret_text(&f.community, "community string", 1)?)
            .or(keep(old.map(|o| &o.community_enc)));
        if v.community_enc.is_none() {
            return Err(AppError::bad("community is required for SNMP v2c"));
        }
    } else {
        v.v3_username = f
            .v3_username
            .as_deref()
            .map(str::trim)
            .map(str::to_string)
            .or(old.and_then(|o| o.v3_username.clone()))
            .filter(|u| !u.is_empty() && u.len() <= 32);
        if v.v3_username.is_none() {
            return Err(AppError::bad(
                "v3_username is required for SNMPv3 (at most 32 characters)",
            ));
        }
        let auth_protocol = f
            .v3_auth_protocol
            .clone()
            .or(keep(old.map(|o| &o.v3_auth_protocol)))
            .unwrap_or_else(|| "sha256".into());
        if !AUTH_PROTOCOLS.contains(&auth_protocol.as_str()) {
            return Err(AppError::bad(format!(
                "v3_auth_protocol must be one of {}",
                AUTH_PROTOCOLS.join(", ")
            )));
        }
        v.v3_auth_protocol = Some(auth_protocol);
        // SNMPv3 passwords are at least 8 characters (RFC 3414).
        v.v3_auth_enc = enc(secret_text(
            &f.v3_auth_password,
            "authentication password",
            8,
        )?)
        .or(keep(old.map(|o| &o.v3_auth_enc)));
        if v.v3_auth_enc.is_none() {
            return Err(AppError::bad("v3_auth_password is required for SNMPv3"));
        }
        let priv_password = secret_text(&f.v3_priv_password, "privacy password", 8)?;
        let priv_protocol = match f.v3_priv_protocol {
            Some(p) => p,
            None => keep(old.map(|o| &o.v3_priv_protocol))
                .or(priv_password.as_ref().map(|_| "aes128".to_string())),
        };
        match priv_protocol {
            None => {}
            Some(p) if PRIV_PROTOCOLS.contains(&p.as_str()) => {
                v.v3_priv_enc = enc(priv_password).or(keep(old.map(|o| &o.v3_priv_enc)));
                if v.v3_priv_enc.is_none() {
                    return Err(AppError::bad(
                        "v3_priv_password is required with a privacy protocol",
                    ));
                }
                v.v3_priv_protocol = Some(p);
            }
            Some(_) => {
                return Err(AppError::bad(format!(
                    "v3_priv_protocol must be one of {}",
                    PRIV_PROTOCOLS.join(", ")
                )))
            }
        }
    }
    if let Some(space) = v.space_id {
        let owner: Option<i64> =
            sqlx::query_scalar("SELECT project_id FROM address_spaces WHERE id = ?")
                .bind(space)
                .fetch_optional(&mut *conn)
                .await?;
        if owner != Some(project_id) {
            return Err(AppError::bad("Address space not found in this project"));
        }
    }
    Ok(v)
}

/// What an audit entry shows of a source: never a secret, only whether it changed.
fn source_audit(v: &SourceValues) -> Value {
    json!({
        "name": v.name, "host": v.host, "port": v.port, "version": v.version,
        "v3_username": v.v3_username, "v3_auth_protocol": v.v3_auth_protocol,
        "v3_priv_protocol": v.v3_priv_protocol, "space_id": v.space_id, "read_arp": v.read_arp,
        "read_mac_table": v.read_mac_table, "enabled": v.enabled,
        "poll_interval_minutes": v.poll_interval_minutes,
        "community": v.community_enc.as_ref().map(|_| audit::REDACTED),
        "v3_auth_password": v.v3_auth_enc.as_ref().map(|_| audit::REDACTED),
        "v3_priv_password": v.v3_priv_enc.as_ref().map(|_| audit::REDACTED),
    })
}

fn unique_name(e: sqlx::Error, name: &str) -> AppError {
    match &e {
        sqlx::Error::Database(d) if d.is_unique_violation() => {
            AppError::Conflict(format!("An SNMP device named {name} already exists"))
        }
        _ => e.into(),
    }
}

pub async fn create_source(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<SourceFields>,
) -> AppResult<(StatusCode, Json<Value>)> {
    require(&current, Action::Manage, &Chain::project(project_id))?;
    let mut tx = state.pool.begin().await?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(&mut *tx)
        .await?;
    exists.ok_or(AppError::NotFound)?;
    let v = source_values(&state, &mut tx, project_id, body, None).await?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO snmp_sources (project_id, name, host, port, version, community_enc, v3_username, v3_auth_protocol,
         v3_auth_enc, v3_priv_protocol, v3_priv_enc, space_id, read_arp, read_mac_table, enabled, poll_interval_minutes,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(&v.name)
    .bind(&v.host)
    .bind(v.port)
    .bind(&v.version)
    .bind(&v.community_enc)
    .bind(&v.v3_username)
    .bind(&v.v3_auth_protocol)
    .bind(&v.v3_auth_enc)
    .bind(&v.v3_priv_protocol)
    .bind(&v.v3_priv_enc)
    .bind(v.space_id)
    .bind(v.read_arp)
    .bind(v.read_mac_table)
    .bind(v.enabled)
    .bind(v.poll_interval_minutes)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| unique_name(e, &v.name))?
    .last_insert_rowid();
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "snmp_source", Some(id))
            .path(v.name.clone())
            .project(Some(project_id))
            .changes(source_audit(&v)),
    )
    .await?;
    let s = load_snmp_source(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(source_json(&s))))
}

pub async fn update_source(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<SourceFields>,
) -> AppResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let old = load_snmp_source(&mut tx, id).await?;
    require(&current, Action::Manage, &Chain::project(old.project_id))?;
    let changed_secrets: Vec<&str> = [
        ("community", body.community.is_some()),
        ("v3_auth_password", body.v3_auth_password.is_some()),
        ("v3_priv_password", body.v3_priv_password.is_some()),
    ]
    .into_iter()
    .filter_map(|(k, set)| set.then_some(k))
    .collect();
    let v = source_values(&state, &mut tx, old.project_id, body, Some(&old)).await?;
    sqlx::query(
        "UPDATE snmp_sources SET name = ?, host = ?, port = ?, version = ?, community_enc = ?, v3_username = ?,
         v3_auth_protocol = ?, v3_auth_enc = ?, v3_priv_protocol = ?, v3_priv_enc = ?, space_id = ?, read_arp = ?,
         read_mac_table = ?, enabled = ?, poll_interval_minutes = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&v.name)
    .bind(&v.host)
    .bind(v.port)
    .bind(&v.version)
    .bind(&v.community_enc)
    .bind(&v.v3_username)
    .bind(&v.v3_auth_protocol)
    .bind(&v.v3_auth_enc)
    .bind(&v.v3_priv_protocol)
    .bind(&v.v3_priv_enc)
    .bind(v.space_id)
    .bind(v.read_arp)
    .bind(v.read_mac_table)
    .bind(v.enabled)
    .bind(v.poll_interval_minutes)
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| unique_name(e, &v.name))?;
    let before = source_audit(&SourceValues {
        name: old.name.clone(),
        host: old.host.clone(),
        port: old.port,
        version: old.version.clone(),
        community_enc: old.community_enc.clone(),
        v3_username: old.v3_username.clone(),
        v3_auth_protocol: old.v3_auth_protocol.clone(),
        v3_auth_enc: old.v3_auth_enc.clone(),
        v3_priv_protocol: old.v3_priv_protocol.clone(),
        v3_priv_enc: old.v3_priv_enc.clone(),
        space_id: old.space_id,
        read_arp: old.read_arp,
        read_mac_table: old.read_mac_table,
        enabled: old.enabled,
        poll_interval_minutes: old.poll_interval_minutes,
    });
    let after = source_audit(&v);
    let secret_keys = ["community", "v3_auth_password", "v3_priv_password"];
    let mut changes = audit::diff(&before, &after, &secret_keys);
    if let Some(o) = changes.as_object_mut() {
        for k in changed_secrets {
            o.insert(k.into(), json!([audit::REDACTED, audit::REDACTED]));
        }
    }
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "snmp_source", Some(id))
            .path(v.name.clone())
            .project(Some(old.project_id))
            .changes(changes),
    )
    .await?;
    let s = load_snmp_source(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(source_json(&s)))
}

pub async fn delete_source(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let s = load_snmp_source(&mut tx, id).await?;
    require(&current, Action::Manage, &Chain::project(s.project_id))?;
    sqlx::query("DELETE FROM snmp_sources WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "snmp_source", Some(id))
            .path(s.name.clone())
            .project(Some(s.project_id)),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Reads the device's tables without saving anything, to check the settings.
pub async fn test_source(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let s = load_snmp_source(&mut *state.pool.acquire().await?, id).await?;
    require(&current, Action::Manage, &Chain::project(s.project_id))?;
    let target = match snmp_target(&state, &s) {
        Ok(t) => t,
        Err(e) => return Ok(Json(json!({ "ok": false, "message": e }))),
    };
    let _guard = state
        .discovery_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| busy())?;
    Ok(Json(match state.network.snmp(target).await {
        Ok(t) => json!({
            "ok": true, "sys_name": t.sys_name, "arp_entries": t.arp.len(), "mac_entries": t.fdb.len(),
        }),
        Err(e) => json!({ "ok": false, "message": e }),
    }))
}

/// Polls a source now. Returns at once; follow it at /api/discovery-runs/{id}.
pub async fn poll_source(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let s = load_snmp_source(&mut *state.pool.acquire().await?, id).await?;
    require(&current, Action::Manage, &Chain::project(s.project_id))?;
    if !s.enabled {
        return Err(AppError::bad("This SNMP device is turned off"));
    }
    let guard = state
        .discovery_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| busy())?;
    let run = open_run(&state, s.project_id, None, Some(s.id), "manual").await?;
    let who = starter(&ctx, &current);
    let st = state.clone();
    tokio::spawn(async move {
        discovery::poll_source(&st, &s, run, &who).await;
        drop(guard);
    });
    Ok((StatusCode::ACCEPTED, Json(json!({ "run_id": run }))))
}

pub async fn source_runs(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let s = load_snmp_source(&mut conn, id).await?;
    require(&current, Action::Read, &Chain::project(s.project_id))?;
    Ok(Json(
        json!({ "runs": recent_runs(&mut conn, None, Some(id)).await? }),
    ))
}
