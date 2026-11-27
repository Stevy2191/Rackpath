//! Integrations (design section 15): set-up, test, sync (with dry run),
//! the sync history, held imports, and the Windows DHCP/DNS push endpoint
//! and XML upload.
//!
//! Managing integrations needs admin rights on the project; reading them
//! (never their secrets) is project-wide. Secrets are stored encrypted with
//! `RACKPATH_ENCRYPTION_KEY`; the Windows import token is shown once and
//! only its hash is kept.

use std::io::Read;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::FromRow;

use super::{require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::permissions::{Action, Chain};
use crate::error::{AppError, AppResult};
use crate::imports::apply::{apply, Target};
use crate::imports::http::check_base_url;
use crate::imports::{should_hold, unifi, windows, zabbix, Snapshot};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::{now_ts, parse_ts, random_token, sha256_hex};

const KINDS: &[&str] = &[
    "windows_dhcp",
    "unifi",
    "unifi_protect",
    "unifi_access",
    "zabbix",
];

#[derive(FromRow, Clone)]
pub struct Integration {
    pub id: i64,
    pub project_id: i64,
    pub kind: String,
    pub name: String,
    pub base_url: Option<String>,
    pub username: Option<String>,
    pub secret_enc: Option<String>,
    pub auth_kind: Option<String>,
    pub verify_tls: bool,
    pub space_id: Option<i64>,
    pub options: String,
    pub token_hash: Option<String>,
    pub token_hint: Option<String>,
    pub auto_sync: bool,
    pub sync_interval_minutes: i64,
    pub hold_threshold_pct: i64,
    pub last_sync_at: Option<String>,
    pub last_status: Option<String>,
    pub last_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

macro_rules! integration_columns {
    () => {
        "id, project_id, kind, name, base_url, username, secret_enc, auth_kind, verify_tls, space_id, options, \
         token_hash, token_hint, auto_sync, sync_interval_minutes, hold_threshold_pct, last_sync_at, last_status, \
         last_message, created_at, updated_at"
    };
}

impl Integration {
    fn options(&self) -> Value {
        serde_json::from_str(&self.options).unwrap_or_else(|_| json!({}))
    }
    fn opt_bool(&self, key: &str, default: bool) -> bool {
        self.options()
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or(default)
    }
    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "project_id": self.project_id, "kind": self.kind, "name": self.name,
            "base_url": self.base_url, "username": self.username, "auth_kind": self.auth_kind,
            "has_secret": self.secret_enc.is_some(), "verify_tls": self.verify_tls, "space_id": self.space_id,
            "options": self.options(), "token_hint": self.token_hint, "auto_sync": self.auto_sync,
            "sync_interval_minutes": self.sync_interval_minutes, "hold_threshold_pct": self.hold_threshold_pct,
            "last_sync_at": self.last_sync_at, "last_status": self.last_status, "last_message": self.last_message,
            "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }
}

async fn load(conn: &mut sqlx::SqliteConnection, id: i64) -> AppResult<Integration> {
    sqlx::query_as::<_, Integration>(concat!(
        "SELECT ",
        integration_columns!(),
        " FROM integrations WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

fn manage(current: &CurrentUser, project_id: i64) -> AppResult<()> {
    require(current, Action::Manage, &Chain::project(project_id))
}

// ---------------------------------------------------------------- CRUD

pub async fn list(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let rows = sqlx::query_as::<_, Integration>(concat!(
        "SELECT ",
        integration_columns!(),
        " FROM integrations WHERE project_id = ? ORDER BY name"
    ))
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    let held: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT r.integration_id, r.id FROM sync_runs r JOIN integrations i ON i.id = r.integration_id
         WHERE i.project_id = ? AND r.status = 'held'",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "integrations": rows.iter().map(|i| {
            let mut v = i.to_json();
            v["held_run_id"] = json!(held.iter().find(|(iid, _)| *iid == i.id).map(|(_, r)| r));
            v
        }).collect::<Vec<_>>(),
        "can_manage": current.principal.can(Action::Manage, &Chain::project(project_id)),
    })))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Fields {
    kind: Option<String>,
    name: Option<String>,
    base_url: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    username: Option<Option<String>>,
    /// API key, API token or password. Omitted: unchanged; null: removed.
    #[serde(default, deserialize_with = "super::nullable")]
    secret: Option<Option<String>>,
    auth_kind: Option<String>,
    verify_tls: Option<bool>,
    #[serde(default, deserialize_with = "super::nullable")]
    space_id: Option<Option<i64>>,
    options: Option<Value>,
    auto_sync: Option<bool>,
    sync_interval_minutes: Option<i64>,
    hold_threshold_pct: Option<i64>,
}

/// Checks and normalises the options for a kind.
fn clean_options(kind: &str, v: &Value) -> AppResult<Value> {
    let o = v
        .as_object()
        .ok_or_else(|| AppError::bad("options must be an object"))?;
    let allowed: &[&str] = match kind {
        "unifi" => &["site", "import_dhcp", "lease_snapshot", "remove_missing"],
        "windows_dhcp" => &["lease_snapshot", "dns_zones", "remove_missing"],
        "unifi_protect" | "unifi_access" => &["site", "remove_missing"],
        "zabbix" => &["remove_missing"],
        _ => &[],
    };
    for k in o.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(AppError::bad(format!("Unknown option {k} for {kind}")));
        }
    }
    if let Some(site) = o.get("site") {
        let ok = site.as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        });
        if !ok {
            return Err(AppError::bad("site is a UniFi site name such as default"));
        }
    }
    for k in ["import_dhcp", "lease_snapshot", "remove_missing"] {
        if o.get(k).is_some_and(|v| !v.is_boolean()) {
            return Err(AppError::bad(format!("{k} must be true or false")));
        }
    }
    if let Some(z) = o.get("dns_zones") {
        let ok = z.as_array().is_some_and(|a| {
            a.len() <= 200 && a.iter().all(|x| x.as_str().is_some_and(|s| s.len() <= 253))
        });
        if !ok {
            return Err(AppError::bad("dns_zones is a list of zone names"));
        }
    }
    Ok(Value::Object(o.clone()))
}

async fn check_space(
    conn: &mut sqlx::SqliteConnection,
    project_id: i64,
    space: Option<i64>,
) -> AppResult<()> {
    if let Some(s) = space {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT id FROM address_spaces WHERE id = ? AND project_id = ?")
                .bind(s)
                .bind(project_id)
                .fetch_optional(conn)
                .await?;
        found.ok_or_else(|| AppError::bad("Address space not found in this project"))?;
    }
    Ok(())
}

fn auth_kinds(kind: &str) -> &'static [&'static str] {
    match kind {
        "unifi" | "unifi_protect" | "unifi_access" => &["api_key", "password"],
        "zabbix" => &["token", "password"],
        _ => &[],
    }
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<Fields>,
) -> AppResult<(StatusCode, Json<Value>)> {
    manage(&current, project_id)?;
    let kind = body
        .kind
        .clone()
        .ok_or_else(|| AppError::bad("kind is required"))?;
    if !KINDS.contains(&kind.as_str()) {
        return Err(AppError::bad(format!(
            "kind must be one of {}",
            KINDS.join(", ")
        )));
    }
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty() && n.len() <= 80)
        .ok_or_else(|| AppError::bad("name is required (at most 80 characters)"))?
        .to_string();
    let pulls = kind != "windows_dhcp";
    let base_url = match (&body.base_url, pulls) {
        (Some(u), true) => Some(check_base_url(u).map_err(AppError::bad)?),
        (None, true) => return Err(AppError::bad("base_url is required")),
        (Some(_), false) => {
            return Err(AppError::bad(
                "Windows DHCP pushes to Rackpath; it has no address to call",
            ))
        }
        (None, false) => None,
    };
    let auth_kind = match (&body.auth_kind, pulls) {
        (Some(a), true) if auth_kinds(&kind).contains(&a.as_str()) => Some(a.clone()),
        (None, true) => Some(auth_kinds(&kind)[0].to_string()),
        (Some(_), true) => {
            return Err(AppError::bad(format!(
                "auth_kind must be {}",
                auth_kinds(&kind).join(" or ")
            )))
        }
        (_, false) => None,
    };
    let options = clean_options(&kind, body.options.as_ref().unwrap_or(&json!({})))?;
    let mut tx = state.pool.begin().await?;
    check_space(&mut tx, project_id, body.space_id.flatten()).await?;
    let secret = body
        .secret
        .flatten()
        .filter(|s| !s.is_empty())
        .map(|s| state.secrets.encrypt(&s));
    let token = (kind == "windows_dhcp").then(random_token);
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO integrations (project_id, kind, name, base_url, username, secret_enc, auth_kind, verify_tls, space_id,
         options, token_hash, token_hint, auto_sync, sync_interval_minutes, hold_threshold_pct, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(&kind)
    .bind(&name)
    .bind(&base_url)
    .bind(body.username.flatten())
    .bind(&secret)
    .bind(&auth_kind)
    .bind(body.verify_tls.unwrap_or(true))
    .bind(body.space_id.flatten())
    .bind(options.to_string())
    .bind(token.as_deref().map(sha256_hex))
    .bind(token.as_deref().map(|t| format!("{}…", &t[..6])))
    .bind(body.auto_sync.unwrap_or(false) && pulls)
    .bind(body.sync_interval_minutes.unwrap_or(60).clamp(5, 10080))
    .bind(body.hold_threshold_pct.unwrap_or(50).clamp(1, 100))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(d) if d.is_unique_violation() => AppError::Conflict(format!("An integration named {name} already exists")),
        _ => e.into(),
    })?
    .last_insert_rowid();
    let i = load(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "integration", Some(id))
            .path(name.clone())
            .project(Some(project_id))
            .changes(json!({ "kind": kind, "base_url": base_url, "secret": if secret.is_some() { audit::REDACTED } else { "" } })),
    )
    .await?;
    tx.commit().await?;
    let mut v = i.to_json();
    if let Some(t) = token {
        v["token"] = json!(t);
        v["token_note"] = json!("Shown once. Give it to Register-RackpathTask.ps1; it's stored encrypted on the Windows side.");
    }
    Ok((StatusCode::CREATED, Json(v)))
}

pub async fn get_one(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let i = load(&mut conn, id).await?;
    require(&current, Action::Read, &Chain::project(i.project_id))?;
    Ok(Json(i.to_json()))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<Fields>,
) -> AppResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let old = load(&mut tx, id).await?;
    manage(&current, old.project_id)?;
    if body.kind.as_deref().is_some_and(|k| k != old.kind) {
        return Err(AppError::bad("An integration's kind can't change"));
    }
    let pulls = old.kind != "windows_dhcp";
    let name = match &body.name {
        Some(n) if !n.trim().is_empty() && n.trim().len() <= 80 => n.trim().to_string(),
        Some(_) => return Err(AppError::bad("name must be 1 to 80 characters")),
        None => old.name.clone(),
    };
    let base_url = match &body.base_url {
        Some(u) if pulls => Some(check_base_url(u).map_err(AppError::bad)?),
        Some(_) => return Err(AppError::bad("Windows DHCP has no address to call")),
        None => old.base_url.clone(),
    };
    let auth_kind = match &body.auth_kind {
        Some(a) if auth_kinds(&old.kind).contains(&a.as_str()) => Some(a.clone()),
        Some(_) => return Err(AppError::bad("auth_kind doesn't fit this kind")),
        None => old.auth_kind.clone(),
    };
    let options = match &body.options {
        Some(o) => clean_options(&old.kind, o)?,
        None => old.options(),
    };
    let space = super::apply_nullable(body.space_id, old.space_id);
    check_space(&mut tx, old.project_id, space).await?;
    let secret = match body.secret {
        None => old.secret_enc.clone(),
        Some(None) => None,
        Some(Some(s)) if s.is_empty() => None,
        Some(Some(s)) => Some(state.secrets.encrypt(&s)),
    };
    sqlx::query(
        "UPDATE integrations SET name = ?, base_url = ?, username = ?, secret_enc = ?, auth_kind = ?, verify_tls = ?,
         space_id = ?, options = ?, auto_sync = ?, sync_interval_minutes = ?, hold_threshold_pct = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&name)
    .bind(&base_url)
    .bind(super::apply_nullable(body.username, old.username.clone()))
    .bind(&secret)
    .bind(&auth_kind)
    .bind(body.verify_tls.unwrap_or(old.verify_tls))
    .bind(space)
    .bind(options.to_string())
    .bind(body.auto_sync.unwrap_or(old.auto_sync) && pulls)
    .bind(body.sync_interval_minutes.unwrap_or(old.sync_interval_minutes).clamp(5, 10080))
    .bind(body.hold_threshold_pct.unwrap_or(old.hold_threshold_pct).clamp(1, 100))
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let new = load(&mut tx, id).await?;
    let mut changes = audit::diff(&old.to_json(), &new.to_json(), &[]);
    if secret != old.secret_enc {
        changes["secret"] = json!(audit::REDACTED);
    }
    if let Some(o) = changes.as_object_mut() {
        o.remove("updated_at");
    }
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "integration", Some(id))
            .path(new.name.clone())
            .project(Some(new.project_id))
            .changes(changes),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(new.to_json()))
}

/// Deletes an integration. What it imported stays, as ordinary records.
pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let i = load(&mut tx, id).await?;
    manage(&current, i.project_id)?;
    sqlx::query("DELETE FROM integrations WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "integration", Some(id))
            .path(i.name.clone())
            .project(Some(i.project_id))
            .changes(json!({ "kind": i.kind, "imported_records_kept": true })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A new Windows import token (the old one stops working at once).
pub async fn rotate_token(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let i = load(&mut tx, id).await?;
    manage(&current, i.project_id)?;
    if i.kind != "windows_dhcp" {
        return Err(AppError::bad(
            "Only Windows DHCP integrations use import tokens",
        ));
    }
    let token = random_token();
    sqlx::query(
        "UPDATE integrations SET token_hash = ?, token_hint = ?, updated_at = ? WHERE id = ?",
    )
    .bind(sha256_hex(&token))
    .bind(format!("{}…", &token[..6]))
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "integration", Some(id))
            .path(i.name.clone())
            .project(Some(i.project_id))
            .changes(json!({ "token": "rotated" })),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({ "token": token, "token_hint": format!("{}…", &token[..6]) }),
    ))
}

// ---------------------------------------------------------------- running

fn secret(state: &AppState, i: &Integration) -> AppResult<Option<String>> {
    i.secret_enc
        .as_deref()
        .map(|s| state.secrets.decrypt(s))
        .transpose()
        .map_err(|_| AppError::bad("The stored secret can't be read (was RACKPATH_ENCRYPTION_KEY changed?); enter it again"))
}

/// Calls the source and returns what it has now.
pub async fn fetch(state: &AppState, i: &Integration) -> Result<Snapshot, String> {
    let secret = secret(state, i).map_err(|e| e.to_string())?;
    let base_url = i.base_url.clone().unwrap_or_default();
    let site = i
        .options()
        .get("site")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_string();
    let uses_key = matches!(i.auth_kind.as_deref(), Some("api_key") | Some("token"));
    match i.kind.as_str() {
        "unifi" | "unifi_protect" | "unifi_access" => {
            let cfg = unifi::Config {
                app: match i.kind.as_str() {
                    "unifi" => unifi::App::Network,
                    "unifi_protect" => unifi::App::Protect,
                    _ => unifi::App::Access,
                },
                base_url,
                verify_tls: i.verify_tls,
                api_key: if uses_key { secret.clone() } else { None },
                username: if uses_key { None } else { i.username.clone() },
                password: if uses_key { None } else { secret },
                site,
                import_dhcp: i.opt_bool("import_dhcp", true),
                lease_snapshot: i.opt_bool("lease_snapshot", false),
            };
            unifi::fetch(&cfg).await
        }
        "zabbix" => {
            let cfg = zabbix::Config {
                base_url,
                verify_tls: i.verify_tls,
                token: if uses_key { secret.clone() } else { None },
                username: if uses_key { None } else { i.username.clone() },
                password: if uses_key { None } else { secret },
            };
            zabbix::fetch(&cfg).await
        }
        _ => Err("Windows DHCP pushes its data; run the script or upload an export file".into()),
    }
}

async fn space_of(conn: &mut sqlx::SqliteConnection, i: &Integration) -> AppResult<i64> {
    if let Some(s) = i.space_id {
        return Ok(s);
    }
    let s: Option<i64> =
        sqlx::query_scalar("SELECT id FROM address_spaces WHERE project_id = ? AND is_default = 1")
            .bind(i.project_id)
            .fetch_optional(conn)
            .await?;
    s.ok_or_else(|| AppError::internal("project has no Default space"))
}

/// Applies a snapshot: dry run, held, or committed with its audit entry.
#[allow(clippy::too_many_arguments)]
pub async fn run_import(
    state: &AppState,
    ctx: &RequestCtx,
    actor: Option<(i64, &str)>,
    i: &Integration,
    snap: &Snapshot,
    trigger: &str,
    full_addresses: bool,
    dry_run: bool,
    force: bool,
) -> AppResult<Value> {
    let started = now_ts();
    let mut tx = state.pool.begin().await?;
    let space_id = space_of(&mut tx, i).await?;
    let target = Target {
        integration_id: i.id,
        project_id: i.project_id,
        space_id,
        full_addresses,
        remove_missing: i.opt_bool("remove_missing", false),
    };
    let report = apply(&mut tx, &target, snap).await?;
    let hold = !force
        && should_hold(
            report.owned_before,
            report.changed(),
            report.newly_missing(),
            i.hold_threshold_pct,
        );
    let summary = json!({
        "counts": report.counts, "vlans_created": report.vlans_created, "leases": report.leases,
        "owned_before": report.owned_before, "changed": report.changed(), "newly_missing": report.newly_missing(),
        "warnings": report.warnings.iter().take(100).collect::<Vec<_>>(),
        "changes": report.changes.iter().take(200).collect::<Vec<_>>(),
    });
    if dry_run {
        tx.rollback().await?;
        let mut v = summary;
        v["dry_run"] = json!(true);
        v["would_hold"] = json!(hold);
        return Ok(v);
    }
    if hold {
        tx.rollback().await?;
        let mut tx = state.pool.begin().await?;
        sqlx::query("UPDATE sync_runs SET status = 'superseded', payload = NULL WHERE integration_id = ? AND status = 'held'")
            .bind(i.id)
            .execute(&mut *tx)
            .await?;
        let run = sqlx::query(
            "INSERT INTO sync_runs (integration_id, trigger, status, started_at, finished_at, summary, message, payload)
             VALUES (?, ?, 'held', ?, ?, ?, ?, ?)",
        )
        .bind(i.id)
        .bind(trigger)
        .bind(&started)
        .bind(now_ts())
        .bind(summary.to_string())
        .bind("Held for approval: it would change more than the allowed share of records")
        .bind(serde_json::to_string(snap).unwrap_or_default())
        .execute(&mut *tx)
        .await?
        .last_insert_rowid();
        sqlx::query("UPDATE integrations SET last_status = 'held', last_message = ?, updated_at = ? WHERE id = ?")
            .bind(format!(
                "Held: {} change(s) and {} missing out of {} records",
                report.changed(),
                report.newly_missing(),
                report.owned_before
            ))
            .bind(now_ts())
            .bind(i.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let mut v = summary;
        v["held"] = json!(true);
        v["run_id"] = json!(run);
        return Ok(v);
    }
    audit::record(
        &mut tx,
        ctx,
        actor,
        Entry::new("sync", "integration", Some(i.id))
            .path(i.name.clone())
            .project(Some(i.project_id))
            .changes(json!({ "trigger": trigger, "counts": summary["counts"], "vlans_created": summary["vlans_created"],
                             "changes": summary["changes"] })),
    )
    .await?;
    sqlx::query("UPDATE sync_runs SET status = 'superseded', payload = NULL WHERE integration_id = ? AND status = 'held'")
        .bind(i.id)
        .execute(&mut *tx)
        .await?;
    let run = sqlx::query(
        "INSERT INTO sync_runs (integration_id, trigger, status, started_at, finished_at, summary) VALUES (?, ?, 'success', ?, ?, ?)",
    )
    .bind(i.id)
    .bind(trigger)
    .bind(&started)
    .bind(now_ts())
    .bind(summary.to_string())
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    let message = if report.warnings.is_empty() {
        None
    } else {
        Some(format!("{} warning(s)", report.warnings.len()))
    };
    sqlx::query("UPDATE integrations SET last_sync_at = ?, last_status = 'success', last_message = ?, updated_at = ? WHERE id = ?")
        .bind(now_ts())
        .bind(message)
        .bind(now_ts())
        .bind(i.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let mut v = summary;
    v["run_id"] = json!(run);
    Ok(v)
}

async fn record_failure(
    state: &AppState,
    i: &Integration,
    trigger: &str,
    message: &str,
) -> AppResult<()> {
    let now = now_ts();
    sqlx::query(
        "INSERT INTO sync_runs (integration_id, trigger, status, started_at, finished_at, message) VALUES (?, ?, 'failed', ?, ?, ?)",
    )
    .bind(i.id)
    .bind(trigger)
    .bind(&now)
    .bind(&now)
    .bind(message)
    .execute(&state.pool)
    .await?;
    sqlx::query("UPDATE integrations SET last_sync_at = ?, last_status = 'failed', last_message = ? WHERE id = ?")
        .bind(&now)
        .bind(message)
        .bind(i.id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

/// Checks the connection and shows what a sync would bring, without saving.
pub async fn test(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let i = load(&mut *state.pool.acquire().await?, id).await?;
    manage(&current, i.project_id)?;
    match fetch(&state, &i).await {
        Ok(s) => Ok(Json(json!({
            "ok": true, "devices": s.devices.len(), "networks": s.networks.len(),
            "reservations": s.reservations.len(), "leases": s.leases.map(|l| l.len()),
        }))),
        Err(e) => Ok(Json(json!({ "ok": false, "message": e }))),
    }
}

#[derive(Deserialize, Default)]
pub struct SyncQuery {
    #[serde(default)]
    dry_run: bool,
}

pub async fn sync(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    Query(q): Query<SyncQuery>,
) -> AppResult<Json<Value>> {
    let i = load(&mut *state.pool.acquire().await?, id).await?;
    manage(&current, i.project_id)?;
    let snap = match fetch(&state, &i).await {
        Ok(s) => s,
        Err(e) => {
            if !q.dry_run {
                record_failure(&state, &i, "manual", &e).await?;
            }
            return Err(AppError::bad(format!("Sync failed: {e}")));
        }
    };
    let v = run_import(
        &state,
        &ctx,
        Some(current.actor_ref()),
        &i,
        &snap,
        "manual",
        true,
        q.dry_run,
        false,
    )
    .await?;
    Ok(Json(v))
}

pub async fn runs(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let i = load(&mut *state.pool.acquire().await?, id).await?;
    require(&current, Action::Read, &Chain::project(i.project_id))?;
    #[derive(FromRow)]
    struct Run {
        id: i64,
        trigger: String,
        status: String,
        started_at: String,
        finished_at: Option<String>,
        summary: Option<String>,
        message: Option<String>,
        decided_at: Option<String>,
    }
    let rows = sqlx::query_as::<_, Run>(
        "SELECT id, trigger, status, started_at, finished_at, summary, message, decided_at FROM sync_runs
         WHERE integration_id = ? ORDER BY id DESC LIMIT 100",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "runs": rows.into_iter().map(|r| json!({
            "id": r.id, "trigger": r.trigger, "status": r.status, "started_at": r.started_at,
            "finished_at": r.finished_at, "message": r.message, "decided_at": r.decided_at,
            "summary": r.summary.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
        })).collect::<Vec<_>>(),
    })))
}

async fn held_run(state: &AppState, i: &Integration, run_id: i64) -> AppResult<String> {
    let payload: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT status, payload FROM sync_runs WHERE id = ? AND integration_id = ?")
            .bind(run_id)
            .bind(i.id)
            .fetch_optional(&state.pool)
            .await?;
    match payload {
        Some((s, Some(p))) if s == "held" => Ok(p),
        Some(_) => Err(AppError::Conflict(
            "That import isn't waiting for approval".into(),
        )),
        None => Err(AppError::NotFound),
    }
}

/// Applies a held import as it was received.
pub async fn approve(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path((id, run_id)): Path<(i64, i64)>,
) -> AppResult<Json<Value>> {
    let i = load(&mut *state.pool.acquire().await?, id).await?;
    manage(&current, i.project_id)?;
    let payload = held_run(&state, &i, run_id).await?;
    let snap: Snapshot =
        serde_json::from_str(&payload).map_err(|_| AppError::internal("bad held payload"))?;
    let full = !matches!(
        sqlx::query_scalar::<_, String>("SELECT trigger FROM sync_runs WHERE id = ?")
            .bind(run_id)
            .fetch_one(&state.pool)
            .await?
            .as_str(),
        "upload"
    );
    let v = run_import(
        &state,
        &ctx,
        Some(current.actor_ref()),
        &i,
        &snap,
        "approval",
        full,
        false,
        true,
    )
    .await?;
    sqlx::query("UPDATE sync_runs SET status = 'approved', payload = NULL, decided_by = ?, decided_at = ? WHERE id = ?")
        .bind(current.user.id)
        .bind(now_ts())
        .bind(run_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(v))
}

pub async fn reject(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path((id, run_id)): Path<(i64, i64)>,
) -> AppResult<StatusCode> {
    let i = load(&mut *state.pool.acquire().await?, id).await?;
    manage(&current, i.project_id)?;
    held_run(&state, &i, run_id).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE sync_runs SET status = 'rejected', payload = NULL, decided_by = ?, decided_at = ? WHERE id = ?")
        .bind(current.user.id)
        .bind(now_ts())
        .bind(run_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE integrations SET last_status = 'rejected', last_message = 'A held import was rejected' WHERE id = ?")
        .bind(i.id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("sync", "integration", Some(i.id))
            .path(i.name.clone())
            .project(Some(i.project_id))
            .changes(json!({ "held_import_rejected": run_id })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- Windows

/// Largest decompressed push document.
const MAX_PUSH: u64 = 200 * 1024 * 1024;

fn body_bytes(headers: &HeaderMap, body: &Bytes) -> AppResult<Vec<u8>> {
    let gz = headers
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("gzip"));
    if !gz {
        return Ok(body.to_vec());
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(&body[..])
        .take(MAX_PUSH + 1)
        .read_to_end(&mut out)
        .map_err(|_| AppError::bad("The body isn't valid gzip"))?;
    if out.len() as u64 > MAX_PUSH {
        return Err(AppError::bad("The document is too large"));
    }
    Ok(out)
}

/// `POST /api/imports/windows-dhcp` with `Authorization: Bearer <token>`:
/// what Push-RackpathDhcp.ps1 sends. One import per minute per token.
pub async fn windows_push(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Json<Value>> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or(AppError::Unauthorized)?;
    let i = sqlx::query_as::<_, Integration>(concat!(
        "SELECT ",
        integration_columns!(),
        " FROM integrations WHERE token_hash = ? AND kind = 'windows_dhcp'"
    ))
    .bind(sha256_hex(token))
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;
    let last: Option<String> = sqlx::query_scalar(
        "SELECT started_at FROM sync_runs WHERE integration_id = ? AND trigger = 'push' ORDER BY id DESC LIMIT 1",
    )
    .bind(i.id)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(t) = last.as_deref().and_then(parse_ts) {
        if time::OffsetDateTime::now_utc() - t < time::Duration::seconds(60) {
            return Err(AppError::TooManyRequests {
                retry_after_secs: 60,
            });
        }
    }
    let raw = body_bytes(&headers, &body)?;
    let push: windows::Push = match serde_json::from_slice(&raw) {
        Ok(p) => p,
        Err(e) => {
            let msg = format!("The document isn't valid: {e}");
            record_failure(&state, &i, "push", &msg).await?;
            return Err(AppError::bad(msg));
        }
    };
    if push.version != 1 {
        return Err(AppError::bad(
            "Unsupported document version; update Push-RackpathDhcp.ps1",
        ));
    }
    let (mut snap, skipped) = windows::to_snapshot(&push);
    if !i.opt_bool("lease_snapshot", false) {
        snap.leases = None;
    }
    let mut v = run_import(&state, &ctx, None, &i, &snap, "push", true, false, false).await?;
    v["skipped"] = json!(skipped);
    Ok(Json(v))
}

/// Upload of an `Export-DhcpServer` XML file (DHCP only, no DNS). Never
/// marks addresses missing, since DNS-only addresses aren't in the file.
pub async fn windows_upload(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    Query(q): Query<SyncQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Json<Value>> {
    let i = load(&mut *state.pool.acquire().await?, id).await?;
    manage(&current, i.project_id)?;
    if i.kind != "windows_dhcp" {
        return Err(AppError::bad(
            "Export files are for Windows DHCP integrations",
        ));
    }
    let raw = body_bytes(&headers, &body)?;
    // Export-DhcpServer writes UTF-8, sometimes with a BOM; UTF-16 is converted.
    let text = if raw.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = raw[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        String::from_utf16(&units).map_err(|_| AppError::bad("The file isn't valid UTF-16"))?
    } else {
        String::from_utf8(
            raw.strip_prefix(&[0xEF, 0xBB, 0xBF])
                .unwrap_or(&raw)
                .to_vec(),
        )
        .map_err(|_| AppError::bad("The file isn't UTF-8 text"))?
    };
    let push = windows::parse_export(&text).map_err(AppError::bad)?;
    let (snap, skipped) = windows::to_snapshot(&push);
    let mut v = run_import(
        &state,
        &ctx,
        Some(current.actor_ref()),
        &i,
        &snap,
        "upload",
        false,
        q.dry_run,
        false,
    )
    .await?;
    v["skipped"] = json!(skipped);
    Ok(Json(v))
}

// ---------------------------------------------------------------- schedule

/// Runs due automatic syncs every minute.
pub fn start_auto_sync(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            if let Err(e) = run_due(&state).await {
                tracing::warn!(error = %e, "auto-sync check failed");
            }
        }
    });
}

pub async fn run_due(state: &AppState) -> AppResult<usize> {
    let all = sqlx::query_as::<_, Integration>(concat!(
        "SELECT ",
        integration_columns!(),
        " FROM integrations WHERE auto_sync = 1 AND kind <> 'windows_dhcp'"
    ))
    .fetch_all(&state.pool)
    .await?;
    let now = time::OffsetDateTime::now_utc();
    let mut ran = 0;
    for i in all {
        let due = match i.last_sync_at.as_deref().and_then(parse_ts) {
            None => true,
            Some(t) => now - t >= time::Duration::minutes(i.sync_interval_minutes),
        };
        if !due {
            continue;
        }
        ran += 1;
        let ctx = RequestCtx {
            request_id: format!("auto-sync-{}", i.id),
            ip: None,
            user_agent: Some("rackpath auto-sync".into()),
        };
        match fetch(state, &i).await {
            Ok(snap) => {
                if let Err(e) =
                    run_import(state, &ctx, None, &i, &snap, "auto", true, false, false).await
                {
                    tracing::warn!(integration = i.id, error = %e, "auto-sync failed");
                    record_failure(state, &i, "auto", "The import failed; see the server log")
                        .await?;
                }
            }
            Err(e) => record_failure(state, &i, "auto", &e).await?,
        }
    }
    Ok(ran)
}
