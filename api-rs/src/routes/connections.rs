//! Connections: one row per physical cable, joining two port sides.
//!
//! `POST /api/connections`
//! ```json
//! {"kind": "patch", "a": {"port_id": 12}, "b": {"port_id": 40},
//!  "cable_type": "Cat6a", "length_m": 2, "color": "#1e90ff", "label": "P-0412"}
//! ```
//! Sides default from the kind (patch → front, permanent → rear). The
//! response carries `warnings` for combinations that plug in but probably
//! won't work (single-mode cable on a multimode optic, Cat5e at 10G…);
//! combinations that can't physically be joined are refused.
//!
//! Anyone who can edit either end can add, change or remove a cable.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{FromRow, SqliteConnection};

use super::places::{check_len, merge_text};
use super::ports::{check_color, load_port, PortRow};
use super::{apply_nullable, require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::cabling;
use crate::domain::cabling::{check_sides, EndInfo, Kind, Side};
use crate::domain::media::{self, CableType};
use crate::domain::permissions::{Action, Chain, ScopeType};
use crate::error::{AppError, AppResult};
use crate::hierarchy;
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

#[derive(FromRow)]
struct ConnectionRow {
    id: i64,
    project_id: i64,
    kind: String,
    cable_type: Option<String>,
    length_m: Option<f64>,
    color: Option<String>,
    label: Option<String>,
    notes: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(FromRow)]
struct EndRow {
    port_id: i64,
    side: String,
    path: String,
    device_id: i64,
}

async fn load(conn: &mut SqliteConnection, id: i64) -> AppResult<(ConnectionRow, Vec<EndRow>)> {
    let row = sqlx::query_as::<_, ConnectionRow>(
        "SELECT id, project_id, kind, cable_type, length_m, color, label, notes, created_at, updated_at
         FROM connections WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or(AppError::NotFound)?;
    let ends = sqlx::query_as::<_, EndRow>(
        "SELECT e.port_id, e.side, s.path, s.device_id FROM connection_ends e
         JOIN search_entries s ON s.kind = 'port' AND s.ref_id = e.port_id
         WHERE e.connection_id = ? ORDER BY e.endpoint",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    if ends.len() != 2 {
        return Err(AppError::internal(format!(
            "connection {id} has {} ends",
            ends.len()
        )));
    }
    Ok((row, ends))
}

fn to_json(c: &ConnectionRow, ends: &[EndRow]) -> Value {
    let end = |e: &EndRow| json!({ "port_id": e.port_id, "side": e.side, "path": e.path, "device_id": e.device_id });
    json!({
        "id": c.id, "project_id": c.project_id, "kind": c.kind, "cable_type": c.cable_type,
        "length_m": c.length_m, "color": c.color, "label": c.label, "notes": c.notes,
        "a": end(&ends[0]), "b": end(&ends[1]),
        "created_at": c.created_at, "updated_at": c.updated_at,
    })
}

fn audit_view(c: &ConnectionRow) -> Value {
    json!({
        "kind": c.kind, "cable_type": c.cable_type, "length_m": c.length_m,
        "color": c.color, "label": c.label, "notes": c.notes,
    })
}

async fn device_chain(conn: &mut SqliteConnection, device_id: i64) -> AppResult<Chain> {
    Ok(hierarchy::get(conn, ScopeType::Device, device_id)
        .await?
        .chain)
}

/// Edit rights on a cable: either end will do.
pub async fn require_edit(
    conn: &mut SqliteConnection,
    current: &CurrentUser,
    connection_id: i64,
) -> AppResult<()> {
    let devices: Vec<i64> = sqlx::query_scalar(
        "SELECT o.device_id FROM connection_ends e JOIN ports o ON o.id = e.port_id
         WHERE e.connection_id = ? ORDER BY e.endpoint",
    )
    .bind(connection_id)
    .fetch_all(&mut *conn)
    .await?;
    let [a, b] = devices[..] else {
        return Err(AppError::NotFound);
    };
    let (ca, cb) = (device_chain(conn, a).await?, device_chain(conn, b).await?);
    if current.principal.can_edit_connection(&ca, &cb) {
        return Ok(());
    }
    require(current, Action::Read, &ca)?;
    Err(AppError::forbidden(
        "You need edit rights on one end of this cable",
    ))
}

fn parse_cable_type(s: Option<String>) -> AppResult<Option<String>> {
    match s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => CableType::parse(&s)
            .map(|c| Some(c.name().to_string()))
            .ok_or_else(|| {
                let names: Vec<&str> = media::CABLE_TYPES.iter().map(|(n, _)| *n).collect();
                AppError::bad(format!("cable_type must be one of {}", names.join(", ")))
            }),
    }
}

fn check_length(l: Option<f64>) -> AppResult<Option<f64>> {
    match l {
        Some(v) if !(v.is_finite() && v > 0.0 && v <= 100_000.0) => Err(AppError::bad(
            "length_m must be a positive number of metres",
        )),
        other => Ok(other),
    }
}

/// Media check for a cable between two port sides.
fn check_media(
    a: &PortRow,
    sa: Side,
    b: &PortRow,
    sb: Side,
    cable_type: Option<&str>,
    length_m: Option<f64>,
) -> AppResult<Vec<String>> {
    let (ma, mb) = (a.media(sa), b.media(sb));
    let speed = match (ma.speed(), mb.speed()) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, y) => x.or(y),
    };
    media::check_cable(
        &ma,
        &mb,
        cable_type.and_then(CableType::parse),
        length_m,
        speed,
    )
    .map(|v| v.warnings)
    .map_err(|e| AppError::bad(e.0))
}

pub async fn get_one(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let (c, ends) = load(&mut conn, id).await?;
    require(&current, Action::Read, &Chain::project(c.project_id))?;
    Ok(Json(to_json(&c, &ends)))
}

#[derive(Deserialize)]
pub struct EndIn {
    port_id: i64,
    side: Option<String>,
}

#[derive(Deserialize)]
pub struct NewConnection {
    kind: Option<String>,
    a: EndIn,
    b: EndIn,
    cable_type: Option<String>,
    length_m: Option<f64>,
    color: Option<String>,
    label: Option<String>,
    notes: Option<String>,
}

async fn end_info(conn: &mut SqliteConnection, port: &PortRow, side: Side) -> AppResult<EndInfo> {
    let used: Vec<String> =
        sqlx::query_scalar("SELECT side FROM connection_ends WHERE port_id = ?")
            .bind(port.id)
            .fetch_all(conn)
            .await?;
    Ok(EndInfo {
        port_id: port.id,
        role: port.role(),
        side,
        requires_permanent: port.requires_permanent,
        rear_cabled: used.iter().any(|s| s == "rear"),
        side_taken: used.iter().any(|s| s == side.as_str()),
    })
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<NewConnection>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let kind = match body.kind.as_deref() {
        None => Kind::Patch,
        Some(k) => {
            Kind::parse(k).ok_or_else(|| AppError::bad("kind must be patch, permanent or power"))?
        }
    };
    let side_of = |e: &EndIn| -> AppResult<Side> {
        match &e.side {
            None => Ok(kind.side()),
            Some(s) => Side::parse(s).ok_or_else(|| AppError::bad("side must be front or rear")),
        }
    };
    let (sa, sb) = (side_of(&body.a)?, side_of(&body.b)?);
    let cable_type = parse_cable_type(body.cable_type)?;
    let length_m = check_length(body.length_m)?;
    let color = check_color(body.color)?;
    let label = merge_text(body.label, None);
    check_len("label", &label, 100)?;

    let mut tx = state.pool.begin().await?;
    let pa = load_port(&mut tx, body.a.port_id).await?;
    let pb = load_port(&mut tx, body.b.port_id).await?;
    let ca = device_chain(&mut tx, pa.device_id).await?;
    let cb = device_chain(&mut tx, pb.device_id).await?;
    require(&current, Action::Read, &ca)?;
    require(&current, Action::Read, &cb)?;
    if pa.project_id != pb.project_id {
        return Err(AppError::bad("Both ends must be in the same project"));
    }
    if !current.principal.can_edit_connection(&ca, &cb) {
        return Err(AppError::forbidden(
            "You need edit rights on one end of this cable",
        ));
    }
    for p in [&pa, &pb] {
        if p.room_id.is_none() {
            return Err(AppError::bad(format!(
                "{} is in the Unplaced list; place the device before cabling it",
                p.path
            )));
        }
    }
    let ea = end_info(&mut tx, &pa, sa).await?;
    let eb = end_info(&mut tx, &pb, sb).await?;
    let power_ends = [&pa, &pb].iter().filter(|p| p.medium == "power").count();
    match (kind, power_ends) {
        (Kind::Power, 2) | (Kind::Patch | Kind::Permanent, 0) => {}
        (Kind::Power, _) => {
            return Err(AppError::bad("A power cord joins two power ports"));
        }
        _ => {
            return Err(AppError::bad(
                "Power ports take power cords: use \"kind\": \"power\"",
            ))
        }
    }
    check_sides(kind, &ea, &eb).map_err(AppError::bad)?;
    let warnings = check_media(&pa, sa, &pb, sb, cable_type.as_deref(), length_m)?;

    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO connections (project_id, kind, cable_type, length_m, color, label, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(pa.project_id)
    .bind(kind.as_str())
    .bind(&cable_type)
    .bind(length_m)
    .bind(&color)
    .bind(&label)
    .bind(merge_text(body.notes, None))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    for (endpoint, port, side) in [("a", &pa, sa), ("b", &pb, sb)] {
        sqlx::query("INSERT INTO connection_ends (connection_id, endpoint, port_id, side) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind(endpoint)
            .bind(port.id)
            .bind(side.as_str())
            .execute(&mut *tx)
            .await
            .map_err(|e| match &e {
                sqlx::Error::Database(d) if d.is_unique_violation() => AppError::Conflict(
                    "That port side already has a cable".into(),
                ),
                _ => e.into(),
            })?;
    }
    let (c, ends) = load(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("connect", "connection", Some(id))
            .path(format!("{} ↔ {}", ends[0].path, ends[1].path))
            .project(Some(c.project_id))
            .changes(audit_view(&c)),
    )
    .await?;
    tx.commit().await?;
    let mut v = to_json(&c, &ends);
    v["warnings"] = json!(warnings);
    Ok((StatusCode::CREATED, Json(v)))
}

#[derive(Deserialize)]
pub struct ConnectionFields {
    #[serde(default, deserialize_with = "super::nullable")]
    cable_type: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::nullable")]
    length_m: Option<Option<f64>>,
    #[serde(default, deserialize_with = "super::nullable")]
    color: Option<Option<String>>,
    label: Option<String>,
    notes: Option<String>,
}

/// Changes the cable's details. To move a cable to other ports, remove it
/// and add a new one.
pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<ConnectionFields>,
) -> AppResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let (old, ends) = load(&mut tx, id).await?;
    require_edit(&mut tx, &current, id).await?;
    let cable_type = match body.cable_type {
        None => old.cable_type.clone(),
        Some(v) => parse_cable_type(v)?,
    };
    let length_m = check_length(apply_nullable(body.length_m, old.length_m))?;
    let color = match body.color {
        None => old.color.clone(),
        Some(v) => check_color(v)?,
    };
    let label = merge_text(body.label, old.label.clone());
    check_len("label", &label, 100)?;
    let pa = load_port(&mut tx, ends[0].port_id).await?;
    let pb = load_port(&mut tx, ends[1].port_id).await?;
    let warnings = check_media(
        &pa,
        Side::parse(&ends[0].side).unwrap_or(Side::Front),
        &pb,
        Side::parse(&ends[1].side).unwrap_or(Side::Front),
        cable_type.as_deref(),
        length_m,
    )?;
    sqlx::query(
        "UPDATE connections SET cable_type = ?, length_m = ?, color = ?, label = ?, notes = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&cable_type)
    .bind(length_m)
    .bind(&color)
    .bind(&label)
    .bind(merge_text(body.notes, old.notes.clone()))
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let (new, ends) = load(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "connection", Some(id))
            .path(format!("{} ↔ {}", ends[0].path, ends[1].path))
            .project(Some(new.project_id))
            .changes(audit::diff(&audit_view(&old), &audit_view(&new), &[])),
    )
    .await?;
    tx.commit().await?;
    let mut v = to_json(&new, &ends);
    v["warnings"] = json!(warnings);
    Ok(Json(v))
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let (c, _) = load(&mut tx, id).await?;
    require_edit(&mut tx, &current, id).await?;
    let description = cabling::describe(&mut tx, id).await?;
    sqlx::query("DELETE FROM connections WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("disconnect", "connection", Some(id))
            .path(description)
            .project(Some(c.project_id))
            .changes(audit_view(&c)),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
