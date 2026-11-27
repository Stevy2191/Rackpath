//! VLANs and WLANs (design section 9). Both belong to a project; creating
//! or changing them needs edit rights on the whole project. Ports are
//! assigned with `PUT /api/ports/{id}/vlans` and a port's `wlan_id`.
//! No WLAN passphrase is ever stored.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, SqliteConnection};

use super::places::{check_len, clean_text, merge_text};
use super::ports::check_color;
use super::{require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::permissions::{Action, Chain};
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

fn unique(e: sqlx::Error, msg: &str) -> AppError {
    match &e {
        sqlx::Error::Database(d) if d.is_unique_violation() => AppError::Conflict(msg.into()),
        _ => e.into(),
    }
}

async fn project_code(conn: &mut SqliteConnection, id: i64) -> AppResult<String> {
    let code: Option<String> = sqlx::query_scalar("SELECT code FROM projects WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    code.ok_or(AppError::NotFound)
}

// ---------------------------------------------------------------- VLANs

#[derive(FromRow, Serialize)]
pub struct Vlan {
    id: i64,
    project_id: i64,
    vid: i64,
    name: String,
    description: Option<String>,
    color: Option<String>,
    notes: Option<String>,
    created_at: String,
    updated_at: String,
}

macro_rules! vlan_columns {
    () => {
        "id, project_id, vid, name, description, color, notes, created_at, updated_at"
    };
}

async fn load_vlan(conn: &mut SqliteConnection, id: i64) -> AppResult<Vlan> {
    sqlx::query_as::<_, Vlan>(concat!(
        "SELECT ",
        vlan_columns!(),
        " FROM vlans WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

fn audit_view<T: Serialize>(v: &T) -> Value {
    let mut v = serde_json::to_value(v).unwrap_or_default();
    if let Some(o) = v.as_object_mut() {
        for k in ["id", "project_id", "created_at", "updated_at"] {
            o.remove(k);
        }
    }
    v
}

pub async fn list_vlans(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        vlan: Vlan,
        ports: i64,
    }
    let rows = sqlx::query_as::<_, Row>(concat!(
        "SELECT ",
        vlan_columns!(),
        ", (SELECT COUNT(*) FROM port_vlans pv WHERE pv.vlan_id = vlans.id) AS ports
         FROM vlans WHERE project_id = ? ORDER BY vid"
    ))
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "vlans": rows.into_iter().map(|r| {
            let mut v = serde_json::to_value(&r.vlan).unwrap_or_default();
            v["port_count"] = json!(r.ports);
            v
        }).collect::<Vec<_>>(),
        "can_edit": current.principal.can(Action::Write, &Chain::project(project_id)),
    })))
}

#[derive(Deserialize, Default)]
pub struct VlanFields {
    vid: Option<i64>,
    name: Option<String>,
    description: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    color: Option<Option<String>>,
    notes: Option<String>,
}

fn check_vlan(vid: i64, name: &Option<String>, description: &Option<String>) -> AppResult<()> {
    if !(1..=4094).contains(&vid) {
        return Err(AppError::bad("VLAN IDs run from 1 to 4094"));
    }
    if name.is_none() {
        return Err(AppError::bad("name is required"));
    }
    check_len("name", name, 80)?;
    check_len("description", description, 255)
}

pub async fn create_vlan(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<VlanFields>,
) -> AppResult<(StatusCode, Json<Vlan>)> {
    require(&current, Action::Write, &Chain::project(project_id))?;
    let vid = body.vid.ok_or_else(|| AppError::bad("vid is required"))?;
    let name = clean_text(body.name);
    let description = clean_text(body.description);
    check_vlan(vid, &name, &description)?;
    let color = check_color(body.color.flatten())?;
    let mut tx = state.pool.begin().await?;
    let code = project_code(&mut tx, project_id).await?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO vlans (project_id, vid, name, description, color, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(vid)
    .bind(&name)
    .bind(&description)
    .bind(&color)
    .bind(clean_text(body.notes))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| unique(e, &format!("VLAN {vid} already exists in this project")))?
    .last_insert_rowid();
    let vlan = load_vlan(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "vlan", Some(id))
            .path(format!("{code}/VLAN {vid}"))
            .project(Some(project_id))
            .changes(audit_view(&vlan)),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(vlan)))
}

pub async fn update_vlan(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<VlanFields>,
) -> AppResult<Json<Vlan>> {
    let mut tx = state.pool.begin().await?;
    let old = load_vlan(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(old.project_id))?;
    let vid = body.vid.unwrap_or(old.vid);
    let name = merge_text(body.name, Some(old.name.clone()));
    let description = merge_text(body.description, old.description.clone());
    check_vlan(vid, &name, &description)?;
    let color = match body.color {
        None => old.color.clone(),
        Some(c) => check_color(c)?,
    };
    sqlx::query(
        "UPDATE vlans SET vid = ?, name = ?, description = ?, color = ?, notes = ?, updated_at = ? WHERE id = ?",
    )
    .bind(vid)
    .bind(&name)
    .bind(&description)
    .bind(&color)
    .bind(merge_text(body.notes, old.notes.clone()))
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| unique(e, &format!("VLAN {vid} already exists in this project")))?;
    let new = load_vlan(&mut tx, id).await?;
    let code = project_code(&mut tx, old.project_id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "vlan", Some(id))
            .path(format!("{code}/VLAN {vid}"))
            .project(Some(old.project_id))
            .changes(audit::diff(&audit_view(&old), &audit_view(&new), &[])),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(new))
}

pub async fn delete_vlan(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let vlan = load_vlan(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(vlan.project_id))?;
    let ports: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM port_vlans WHERE vlan_id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let code = project_code(&mut tx, vlan.project_id).await?;
    sqlx::query("DELETE FROM vlans WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "vlan", Some(id))
            .path(format!("{code}/VLAN {}", vlan.vid))
            .project(Some(vlan.project_id))
            .changes(json!({ "name": vlan.name, "ports_unassigned": ports })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- WLANs

const SECURITY: &[&str] = &["open", "owe", "wpa2", "wpa3", "wpa2_wpa3", "enterprise"];

#[derive(FromRow, Serialize)]
pub struct Wlan {
    id: i64,
    project_id: i64,
    ssid: String,
    description: Option<String>,
    security: String,
    hidden: bool,
    vlan_id: Option<i64>,
    notes: Option<String>,
    /// The integration that brought it in (None: typed in by people).
    source_integration_id: Option<i64>,
    missing_from_source_at: Option<String>,
    created_at: String,
    updated_at: String,
}

macro_rules! wlan_columns {
    () => {
        "id, project_id, ssid, description, security, hidden, vlan_id, notes, source_integration_id, \
         missing_from_source_at, created_at, updated_at"
    };
}

async fn load_wlan(conn: &mut SqliteConnection, id: i64) -> AppResult<Wlan> {
    sqlx::query_as::<_, Wlan>(concat!(
        "SELECT ",
        wlan_columns!(),
        " FROM wlans WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

pub async fn list_wlans(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        wlan: Wlan,
        ports: i64,
    }
    let rows = sqlx::query_as::<_, Row>(concat!(
        "SELECT ",
        wlan_columns!(),
        ", (SELECT COUNT(*) FROM ports p WHERE p.wlan_id = wlans.id) AS ports
         FROM wlans WHERE project_id = ? ORDER BY ssid, id"
    ))
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "wlans": rows.into_iter().map(|r| {
            let mut v = serde_json::to_value(&r.wlan).unwrap_or_default();
            v["port_count"] = json!(r.ports);
            v
        }).collect::<Vec<_>>(),
        "can_edit": current.principal.can(Action::Write, &Chain::project(project_id)),
    })))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct WlanFields {
    ssid: Option<String>,
    description: Option<String>,
    security: Option<String>,
    hidden: Option<bool>,
    #[serde(default, deserialize_with = "super::nullable")]
    vlan_id: Option<Option<i64>>,
    notes: Option<String>,
}

async fn check_wlan(
    conn: &mut SqliteConnection,
    project_id: i64,
    ssid: &Option<String>,
    security: &str,
    vlan_id: Option<i64>,
) -> AppResult<()> {
    match ssid {
        None => return Err(AppError::bad("ssid is required")),
        Some(s) if s.len() > 32 => return Err(AppError::bad("An SSID is at most 32 bytes")),
        _ => {}
    }
    if !SECURITY.contains(&security) {
        return Err(AppError::bad(
            "security must be open, owe, wpa2, wpa3, wpa2_wpa3 or enterprise",
        ));
    }
    if let Some(v) = vlan_id {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT id FROM vlans WHERE id = ? AND project_id = ?")
                .bind(v)
                .bind(project_id)
                .fetch_optional(conn)
                .await?;
        found.ok_or_else(|| AppError::bad("VLAN not found in this project"))?;
    }
    Ok(())
}

pub async fn create_wlan(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<WlanFields>,
) -> AppResult<(StatusCode, Json<Wlan>)> {
    require(&current, Action::Write, &Chain::project(project_id))?;
    let ssid = clean_text(body.ssid);
    let security = body.security.unwrap_or_else(|| "wpa2".into());
    let vlan_id = body.vlan_id.flatten();
    let description = clean_text(body.description);
    check_len("description", &description, 255)?;
    let mut tx = state.pool.begin().await?;
    let code = project_code(&mut tx, project_id).await?;
    check_wlan(&mut tx, project_id, &ssid, &security, vlan_id).await?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO wlans (project_id, ssid, description, security, hidden, vlan_id, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(&ssid)
    .bind(&description)
    .bind(&security)
    .bind(body.hidden.unwrap_or(false))
    .bind(vlan_id)
    .bind(clean_text(body.notes))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    let wlan = load_wlan(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "wlan", Some(id))
            .path(format!("{code}/WLAN {}", wlan.ssid))
            .project(Some(project_id))
            .changes(audit_view(&wlan)),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(wlan)))
}

pub async fn update_wlan(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<WlanFields>,
) -> AppResult<Json<Wlan>> {
    let mut tx = state.pool.begin().await?;
    let old = load_wlan(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(old.project_id))?;
    let ssid = merge_text(body.ssid, Some(old.ssid.clone()));
    let security = body.security.unwrap_or_else(|| old.security.clone());
    let vlan_id = super::apply_nullable(body.vlan_id, old.vlan_id);
    let description = merge_text(body.description, old.description.clone());
    check_len("description", &description, 255)?;
    check_wlan(&mut tx, old.project_id, &ssid, &security, vlan_id).await?;
    sqlx::query(
        "UPDATE wlans SET ssid = ?, description = ?, security = ?, hidden = ?, vlan_id = ?, notes = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&ssid)
    .bind(&description)
    .bind(&security)
    .bind(body.hidden.unwrap_or(old.hidden))
    .bind(vlan_id)
    .bind(merge_text(body.notes, old.notes.clone()))
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let new = load_wlan(&mut tx, id).await?;
    let code = project_code(&mut tx, old.project_id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "wlan", Some(id))
            .path(format!("{code}/WLAN {}", new.ssid))
            .project(Some(old.project_id))
            .changes(audit::diff(&audit_view(&old), &audit_view(&new), &[])),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(new))
}

pub async fn delete_wlan(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let wlan = load_wlan(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(wlan.project_id))?;
    let ports: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ports WHERE wlan_id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let code = project_code(&mut tx, wlan.project_id).await?;
    sqlx::query("DELETE FROM wlans WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "wlan", Some(id))
            .path(format!("{code}/WLAN {}", wlan.ssid))
            .project(Some(wlan.project_id))
            .changes(json!({ "ports_unassigned": ports })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
