//! Devices (design section 5): one table for every physical thing, placed
//! in a room, in a rack, on a tray, or unplaced.
//!
//! Placement in requests and responses:
//!   {"type": "room", "room_id": 3, "x": 120.5, "y": 80, "rotation": 0}
//!   {"type": "rack", "rack_id": 7, "u": 12, "face": "front", "mount": "full_width"}
//!   {"type": "tray", "tray_id": 41}
//!   {"type": "unplaced"}
//!
//! Moving a device needs edit rights where it is and where it goes.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, QueryBuilder, Sqlite, SqliteConnection};

use super::places::{audit_unplaced, check_len, check_user_exists, merge_text};
use super::racks::{load_rack, rack_slots};
use super::{apply_nullable, optional_body, require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::device_types::{can_place, Placement, Target, TRAY_KEY};
use crate::domain::naming::{next_free_code, normalize_code, unique_variant};
use crate::domain::permissions::{Action, Chain, ScopeType};
use crate::domain::rack::{
    check_fit, height_to_half, pos_half_to_u, u_to_pos_half, Face, FitError, Mount, Slot,
};
use crate::error::{AppError, AppResult};
use crate::hierarchy::{self, ContentsMode, Subtree};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

// ---------------------------------------------------------------- reading

#[derive(FromRow, Clone)]
pub struct DeviceRow {
    pub id: i64,
    pub project_id: i64,
    pub device_type_id: i64,
    pub type_key: String,
    pub type_label: String,
    pub type_prefix: String,
    pub type_placement: String,
    pub code: String,
    pub name: Option<String>,
    pub room_id: Option<i64>,
    pub plan_x: Option<f64>,
    pub plan_y: Option<f64>,
    pub plan_rotation: Option<f64>,
    pub rack_id: Option<i64>,
    pub rack_pos_half: Option<i64>,
    pub rack_face: Option<String>,
    pub rack_mount: Option<String>,
    pub parent_device_id: Option<i64>,
    pub u_height_half: Option<i64>,
    pub depth: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub serial_number: Option<String>,
    pub asset_tag: Option<String>,
    pub purchase_date: Option<String>,
    pub warranty_expiry: Option<String>,
    pub in_service_date: Option<String>,
    pub responsible_user_id: Option<i64>,
    pub status: String,
    pub hostname: Option<String>,
    pub mac: Option<String>,
    pub os: Option<String>,
    pub firmware: Option<String>,
    pub source: String,
    pub external_id: Option<String>,
    pub icon_color: Option<String>,
    pub text_color: Option<String>,
    pub notes: Option<String>,
    pub template_id: Option<i64>,
    pub template_version: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub path: String,
    pub location_id: Option<i64>,
    pub floor_id: Option<i64>,
}

macro_rules! device_select {
    () => {
        "SELECT d.id, d.project_id, d.device_type_id, dt.key AS type_key, dt.label AS type_label, dt.prefix AS type_prefix, \
         dt.placement AS type_placement, d.code, d.name, d.room_id, d.plan_x, d.plan_y, d.plan_rotation, d.rack_id, \
         d.rack_pos_half, d.rack_face, d.rack_mount, d.parent_device_id, d.u_height_half, d.depth, d.manufacturer, d.model, \
         d.serial_number, d.asset_tag, d.purchase_date, d.warranty_expiry, d.in_service_date, d.responsible_user_id, \
         d.status, d.hostname, d.mac, d.os, d.firmware, d.source, d.external_id, d.icon_color, d.text_color, d.notes, \
         d.template_id, d.template_version, d.created_at, d.updated_at, s.path, s.location_id, s.floor_id \
         FROM devices d JOIN device_types dt ON dt.id = d.device_type_id \
         JOIN search_entries s ON s.kind = 'device' AND s.ref_id = d.id "
    };
}

impl DeviceRow {
    pub fn placement(&self) -> Value {
        if let Some(room_id) = self.room_id {
            json!({ "type": "room", "room_id": room_id, "x": self.plan_x, "y": self.plan_y, "rotation": self.plan_rotation })
        } else if let Some(rack_id) = self.rack_id {
            json!({
                "type": "rack", "rack_id": rack_id, "u": self.rack_pos_half.map(pos_half_to_u),
                "face": self.rack_face, "mount": self.rack_mount,
            })
        } else if let Some(tray_id) = self.parent_device_id {
            json!({ "type": "tray", "tray_id": tray_id })
        } else {
            json!({ "type": "unplaced" })
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "project_id": self.project_id, "code": self.code, "name": self.name, "path": self.path,
            "device_type": { "id": self.device_type_id, "key": self.type_key, "label": self.type_label, "prefix": self.type_prefix },
            "placement": self.placement(),
            "u_height": self.u_height_half.map(|h| h as f64 / 2.0), "depth": self.depth,
            "manufacturer": self.manufacturer, "model": self.model, "serial_number": self.serial_number,
            "asset_tag": self.asset_tag, "purchase_date": self.purchase_date, "warranty_expiry": self.warranty_expiry,
            "in_service_date": self.in_service_date, "responsible_user_id": self.responsible_user_id,
            "status": self.status, "hostname": self.hostname, "mac": self.mac, "os": self.os, "firmware": self.firmware,
            "source": self.source, "external_id": self.external_id, "icon_color": self.icon_color,
            "text_color": self.text_color, "notes": self.notes,
            "template_id": self.template_id, "template_version": self.template_version, "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }

    /// Values compared for the audit log.
    fn audit_view(&self) -> Value {
        let mut v = self.to_json();
        if let Some(o) = v.as_object_mut() {
            o.remove("updated_at");
            o.remove("created_at");
            o.remove("device_type");
            o.insert("device_type".into(), json!(self.type_key));
        }
        v
    }
}

pub async fn load_device(conn: &mut SqliteConnection, id: i64) -> AppResult<DeviceRow> {
    sqlx::query_as::<_, DeviceRow>(concat!(device_select!(), "WHERE d.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

/// Devices placed on a floor's plan (in any room of the floor).
pub async fn floor_devices(conn: &mut SqliteConnection, floor_id: i64) -> AppResult<Vec<Value>> {
    let rows = sqlx::query_as::<_, DeviceRow>(concat!(
        device_select!(),
        "WHERE s.floor_id = ? AND d.room_id IS NOT NULL ORDER BY d.code"
    ))
    .bind(floor_id)
    .fetch_all(conn)
    .await?;
    Ok(rows.iter().map(DeviceRow::to_json).collect())
}

/// Devices placed directly in a room (not in its racks).
pub async fn room_devices(conn: &mut SqliteConnection, room_id: i64) -> AppResult<Vec<Value>> {
    let rows = sqlx::query_as::<_, DeviceRow>(concat!(
        device_select!(),
        "WHERE d.room_id = ? ORDER BY d.code"
    ))
    .bind(room_id)
    .fetch_all(conn)
    .await?;
    Ok(rows.iter().map(DeviceRow::to_json).collect())
}

/// Everything in a rack, including devices on its trays (placement type
/// "tray" with the tray's id).
pub async fn rack_devices(conn: &mut SqliteConnection, rack_id: i64) -> AppResult<Vec<Value>> {
    let rows = sqlx::query_as::<_, DeviceRow>(concat!(
        device_select!(),
        "WHERE s.rack_id = ? ORDER BY d.rack_pos_half DESC, d.code"
    ))
    .bind(rack_id)
    .fetch_all(conn)
    .await?;
    Ok(rows.iter().map(DeviceRow::to_json).collect())
}

#[derive(Deserialize)]
pub struct ListFilters {
    location_id: Option<i64>,
    floor_id: Option<i64>,
    room_id: Option<i64>,
    rack_id: Option<i64>,
    unplaced: Option<bool>,
    device_type: Option<String>,
    status: Option<String>,
    q: Option<String>,
    after_id: Option<i64>,
    limit: Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    Query(f): Query<ListFilters>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let limit = f.limit.unwrap_or(200).clamp(1, 1000);
    let mut q: QueryBuilder<Sqlite> = QueryBuilder::new(device_select!());
    q.push("WHERE d.project_id = ").push_bind(project_id);
    if let Some(v) = f.location_id {
        q.push(" AND s.location_id = ").push_bind(v);
    }
    if let Some(v) = f.floor_id {
        q.push(" AND s.floor_id = ").push_bind(v);
    }
    if let Some(v) = f.room_id {
        q.push(" AND s.room_id = ").push_bind(v);
    }
    if let Some(v) = f.rack_id {
        q.push(" AND s.rack_id = ").push_bind(v);
    }
    if f.unplaced == Some(true) {
        q.push(" AND s.room_id IS NULL");
    }
    if let Some(v) = f.device_type {
        q.push(" AND dt.key = ").push_bind(v);
    }
    if let Some(v) = f.status {
        q.push(" AND d.status = ").push_bind(v);
    }
    if let Some(text) = f.q.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        let like = format!(
            "%{}%",
            text.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        q.push(" AND (s.path LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR s.text LIKE ")
            .push_bind(like)
            .push(" ESCAPE '\\')");
    }
    if let Some(v) = f.after_id {
        q.push(" AND d.id > ").push_bind(v);
    }
    q.push(" ORDER BY d.id LIMIT ").push_bind(limit + 1);
    let mut rows: Vec<DeviceRow> = q.build_query_as().fetch_all(&state.pool).await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = if more {
        rows.last().map(|r| r.id)
    } else {
        None
    };
    Ok(Json(
        json!({ "devices": rows.iter().map(DeviceRow::to_json).collect::<Vec<_>>(), "next_after_id": next }),
    ))
}

pub async fn get_one(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Device, id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let device = load_device(&mut conn, id).await?;
    let mut v = device.to_json();
    if device.type_key == TRAY_KEY {
        let children = sqlx::query_as::<_, DeviceRow>(concat!(
            device_select!(),
            "WHERE d.parent_device_id = ? ORDER BY d.code"
        ))
        .bind(id)
        .fetch_all(&mut *conn)
        .await?;
        v["on_tray"] = json!(children.iter().map(DeviceRow::to_json).collect::<Vec<_>>());
    }
    v["power"] = json!(super::power::load_device_power(&mut conn, id).await?);
    v["can_edit"] = json!(current.principal.can(Action::Write, &placed.chain));
    Ok(Json(v))
}

// ---------------------------------------------------------------- placement

#[derive(Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlacementIn {
    Room {
        room_id: i64,
        x: Option<f64>,
        y: Option<f64>,
        rotation: Option<f64>,
    },
    Rack {
        rack_id: i64,
        u: Option<f64>,
        face: Option<String>,
        mount: Option<String>,
    },
    Tray {
        tray_id: i64,
    },
    Unplaced,
}

/// A validated destination.
struct Resolved {
    target: Target,
    chain: Chain,
    parent_key: String,
    room_id: Option<i64>,
    plan: (Option<f64>, Option<f64>, Option<f64>),
    rack: Option<(i64, i64)>, // (rack id, rack height in U)
    rack_pos_half: Option<i64>,
    face: Option<Face>,
    mount: Option<Mount>,
    tray_id: Option<i64>,
}

async fn resolve(
    conn: &mut SqliteConnection,
    project_id: i64,
    p: &PlacementIn,
) -> AppResult<Resolved> {
    let blank = |target, chain, parent_key: String| Resolved {
        target,
        chain,
        parent_key,
        room_id: None,
        plan: (None, None, None),
        rack: None,
        rack_pos_half: None,
        face: None,
        mount: None,
        tray_id: None,
    };
    let same_project = |pid: i64| -> AppResult<()> {
        if pid != project_id {
            return Err(AppError::bad("That place belongs to another project"));
        }
        Ok(())
    };
    match p {
        PlacementIn::Unplaced => Ok(blank(
            Target::Unplaced,
            Chain::project(project_id),
            format!("u:{project_id}"),
        )),
        PlacementIn::Room {
            room_id,
            x,
            y,
            rotation,
        } => {
            let room = hierarchy::find(conn, ScopeType::Room, *room_id)
                .await?
                .ok_or_else(|| AppError::bad("Room not found"))?;
            same_project(room.project_id)?;
            for v in [x, y, rotation].into_iter().flatten() {
                if !v.is_finite() {
                    return Err(AppError::bad("Plan coordinates must be finite numbers"));
                }
            }
            let mut r = blank(Target::Room, room.chain, format!("r:{room_id}"));
            r.room_id = Some(*room_id);
            r.plan = (*x, *y, *rotation);
            Ok(r)
        }
        PlacementIn::Rack {
            rack_id,
            u,
            face,
            mount,
        } => {
            let rack = hierarchy::find(conn, ScopeType::Rack, *rack_id)
                .await?
                .ok_or_else(|| AppError::bad("Rack not found"))?;
            same_project(rack.project_id)?;
            let height = load_rack(conn, *rack_id).await?.u_height;
            let mount = match mount {
                Some(m) => Mount::parse(m).ok_or_else(|| AppError::bad("mount must be full_width, half_left, half_right, zero_u_left or zero_u_right"))?,
                None => Mount::FullWidth,
            };
            let face = match face {
                Some(f) => Face::parse(f)
                    .ok_or_else(|| AppError::bad("face must be front, rear or both"))?,
                None => Face::Front,
            };
            let pos = match u {
                Some(u) => Some(u_to_pos_half(*u).map_err(AppError::bad)?),
                None if mount.is_zero_u() => None,
                None => return Err(AppError::bad("A rack position (u) is required")),
            };
            let mut r = blank(Target::Rack, rack.chain, format!("k:{rack_id}"));
            r.rack = Some((*rack_id, height));
            r.rack_pos_half = pos;
            r.face = Some(face);
            r.mount = Some(mount);
            Ok(r)
        }
        PlacementIn::Tray { tray_id } => {
            let tray = hierarchy::find(conn, ScopeType::Device, *tray_id)
                .await?
                .ok_or_else(|| AppError::bad("Tray not found"))?;
            same_project(tray.project_id)?;
            let (key, rack_id): (String, Option<i64>) = sqlx::query_as(
                "SELECT dt.key, d.rack_id FROM devices d JOIN device_types dt ON dt.id = d.device_type_id WHERE d.id = ?",
            )
            .bind(tray_id)
            .fetch_one(&mut *conn)
            .await?;
            if key != TRAY_KEY || rack_id.is_none() {
                return Err(AppError::bad(
                    "Devices can only sit on a shelf/tray that is mounted in a rack",
                ));
            }
            let mut r = blank(Target::Tray, tray.chain, format!("d:{tray_id}"));
            r.tray_id = Some(*tray_id);
            Ok(r)
        }
    }
}

/// The floor a destination is on (None for Unplaced).
async fn target_floor(conn: &mut SqliteConnection, t: &Resolved) -> AppResult<Option<i64>> {
    if let Some(room) = t.room_id {
        return Ok(Some(
            sqlx::query_scalar("SELECT floor_id FROM rooms WHERE id = ?")
                .bind(room)
                .fetch_one(conn)
                .await?,
        ));
    }
    if let Some((rack, _)) = t.rack {
        return Ok(Some(
            sqlx::query_scalar(
                "SELECT r.floor_id FROM racks k JOIN rooms r ON r.id = k.room_id WHERE k.id = ?",
            )
            .bind(rack)
            .fetch_one(conn)
            .await?,
        ));
    }
    if let Some(tray) = t.tray_id {
        return Ok(sqlx::query_scalar(
            "SELECT floor_id FROM search_entries WHERE kind = 'device' AND ref_id = ?",
        )
        .bind(tray)
        .fetch_optional(conn)
        .await?
        .flatten());
    }
    Ok(None)
}

fn fit_error(e: FitError, code_of: impl Fn(i64) -> String) -> AppError {
    match e {
        FitError::Overlap { device_id } => AppError::Conflict(format!(
            "That space is already taken by {}",
            code_of(device_id)
        )),
        other => AppError::bad(other.to_string()),
    }
}

async fn check_rack_fit(
    conn: &mut SqliteConnection,
    r: &Resolved,
    device_id: i64,
    height_half: i64,
) -> AppResult<()> {
    let Some((rack_id, rack_u)) = r.rack else {
        return Ok(());
    };
    let slot = Slot {
        device_id,
        pos_half: r.rack_pos_half,
        height_half,
        face: r.face.unwrap_or(Face::Front),
        mount: r.mount.unwrap_or(Mount::FullWidth),
    };
    let others = rack_slots(conn, rack_id, Some(device_id)).await?;
    if let Err(e) = check_fit(&slot, &others, rack_u) {
        let codes: Vec<(i64, String)> =
            sqlx::query_as("SELECT id, code FROM devices WHERE rack_id = ?")
                .bind(rack_id)
                .fetch_all(&mut *conn)
                .await?;
        return Err(fit_error(e, |id| {
            codes
                .iter()
                .find(|(i, _)| *i == id)
                .map(|(_, c)| c.clone())
                .unwrap_or_default()
        }));
    }
    Ok(())
}

/// Picks or checks a code in the destination's namespace.
async fn choose_code(
    conn: &mut SqliteConnection,
    parent_key: &str,
    wanted: Option<&str>,
    prefix: &str,
    self_id: Option<i64>,
    self_code: Option<&str>,
) -> AppResult<String> {
    let mut taken = hierarchy::sibling_codes(conn, parent_key).await?;
    // A device keeps its own code when it doesn't move.
    if let (Some(id), Some(code)) = (self_id, self_code) {
        let still_here: Option<i64> =
            sqlx::query_scalar("SELECT id FROM devices WHERE id = ? AND parent_key = ?")
                .bind(id)
                .bind(parent_key)
                .fetch_optional(&mut *conn)
                .await?;
        if still_here.is_some() {
            if let Some(pos) = taken.iter().position(|t| t.eq_ignore_ascii_case(code)) {
                taken.remove(pos);
            }
        }
    }
    match wanted {
        Some(c) => {
            let code = normalize_code(c).map_err(AppError::bad)?;
            if taken.iter().any(|t| t.eq_ignore_ascii_case(&code)) {
                return Err(AppError::Conflict(format!(
                    "{code} is already used there; try {}",
                    unique_variant(&code, &taken)
                )));
            }
            Ok(code)
        }
        None => Ok(next_free_code(prefix, &taken)),
    }
}

// ---------------------------------------------------------------- writing

#[derive(Deserialize, Default)]
pub struct DeviceFields {
    /// Create from this template (create only): type, height, power and
    /// ports come from it unless given.
    template_id: Option<i64>,
    device_type_id: Option<i64>,
    /// Alternative to device_type_id: the type's key, e.g. "switch".
    device_type: Option<String>,
    code: Option<String>,
    name: Option<String>,
    placement: Option<PlacementIn>,
    u_height: Option<f64>,
    #[serde(default, deserialize_with = "super::nullable")]
    depth: Option<Option<String>>,
    manufacturer: Option<String>,
    model: Option<String>,
    serial_number: Option<String>,
    asset_tag: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    purchase_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::nullable")]
    warranty_expiry: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::nullable")]
    in_service_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::nullable")]
    responsible_user_id: Option<Option<i64>>,
    status: Option<String>,
    hostname: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    mac: Option<Option<String>>,
    os: Option<String>,
    firmware: Option<String>,
    icon_color: Option<String>,
    text_color: Option<String>,
    notes: Option<String>,
}

fn check_date(field: &str, v: &Option<String>) -> AppResult<()> {
    if let Some(d) = v {
        let ok = d.len() == 10
            && time::Date::parse(d, time::macros::format_description!("[year]-[month]-[day]"))
                .is_ok();
        if !ok {
            return Err(AppError::bad(format!(
                "{field} must be a date like 2027-06-30"
            )));
        }
    }
    Ok(())
}

/// Accepts aa:bb:cc:dd:ee:ff, aa-bb-…, aabb.ccdd.eeff or aabbccddeeff;
/// stores lowercase with colons.
pub fn normalize_mac(input: &str) -> AppResult<String> {
    let hex: String = input.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let separators_ok = input
        .chars()
        .all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '-' | '.'));
    if hex.len() != 12 || !separators_ok {
        return Err(AppError::bad(
            "MAC address must have 12 hex digits, e.g. aa:bb:cc:dd:ee:ff",
        ));
    }
    let hex = hex.to_ascii_lowercase();
    Ok((0..6)
        .map(|i| &hex[i * 2..i * 2 + 2])
        .collect::<Vec<_>>()
        .join(":"))
}

const STATUSES: &[&str] = &["planned", "active", "spare", "faulty", "retired"];

async fn device_type(
    conn: &mut SqliteConnection,
    project_id: i64,
    id: Option<i64>,
    key: Option<&str>,
) -> AppResult<Option<(i64, String, String, Placement)>> {
    let row: Option<(i64, String, String, String)> = match (id, key) {
        (Some(id), _) => sqlx::query_as(
            "SELECT id, key, prefix, placement FROM device_types WHERE id = ? AND project_id = ?",
        )
        .bind(id)
        .bind(project_id)
        .fetch_optional(&mut *conn)
        .await?,
        (None, Some(key)) => sqlx::query_as(
            "SELECT id, key, prefix, placement FROM device_types WHERE key = ? AND project_id = ?",
        )
        .bind(key)
        .bind(project_id)
        .fetch_optional(&mut *conn)
        .await?,
        (None, None) => return Ok(None),
    };
    let (id, key, prefix, placement) =
        row.ok_or_else(|| AppError::bad("Device type not found in this project"))?;
    Ok(Some((
        id,
        key,
        prefix,
        Placement::parse(&placement).unwrap_or(Placement::Either),
    )))
}

fn text(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<DeviceFields>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let mut tx = state.pool.begin().await?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(&mut *tx)
        .await?;
    exists.ok_or(AppError::NotFound)?;
    let template = match body.template_id {
        None => None,
        Some(t) => {
            let (row, p) =
                super::templates::load_prepared(&mut tx, t)
                    .await
                    .map_err(|e| match e {
                        AppError::NotFound => AppError::bad("Template not found"),
                        other => other,
                    })?;
            if row.project_id.is_some_and(|p| p != project_id) {
                return Err(AppError::bad("That template belongs to another project"));
            }
            Some((row, p))
        }
    };
    let template_type = template.as_ref().map(|(_, p)| p.t.device_type.clone());
    let (type_id, type_key, prefix, type_placement) = device_type(
        &mut tx,
        project_id,
        body.device_type_id,
        body.device_type.as_deref().or(template_type.as_deref()),
    )
    .await?
    .ok_or_else(|| AppError::bad("device_type_id or device_type is required"))?;
    if template_type.as_ref().is_some_and(|t| *t != type_key) {
        return Err(AppError::bad(
            "The device type comes from the template; leave it out",
        ));
    }
    let mut placement = body.placement.clone().unwrap_or(PlacementIn::Unplaced);
    // Zero-U and half-width templates choose their mount unless given.
    if let (Some((_, p)), PlacementIn::Rack { mount, u, .. }) = (&template, &mut placement) {
        if mount.is_none() {
            if p.u_half == Some(0) {
                *mount = Some("zero_u_left".into());
                *u = None;
            } else if p.t.half_width {
                *mount = Some("half_left".into());
            }
        }
    }
    let target = resolve(&mut tx, project_id, &placement).await?;
    require(&current, Action::Write, &target.chain)?;
    if !can_place(&type_key, type_placement, target.target) {
        return Err(AppError::bad(format!("A {type_key} can't be placed there")));
    }
    let template_height = template
        .as_ref()
        .and_then(|(_, p)| p.u_half)
        .filter(|h| *h > 0);
    let height_half = match body.u_height {
        Some(h) => Some(height_to_half(h).map_err(AppError::bad)?),
        None if template_height.is_some() => template_height,
        None if target.rack.is_some() => Some(2),
        None => None,
    };
    let code = choose_code(
        &mut tx,
        &target.parent_key,
        body.code.as_deref(),
        &prefix,
        None,
        None,
    )
    .await?;
    check_rack_fit(&mut tx, &target, -1, height_half.unwrap_or(2)).await?;

    let status = body.status.as_deref().unwrap_or("active");
    if !STATUSES.contains(&status) {
        return Err(AppError::bad(
            "status must be planned, active, spare, faulty or retired",
        ));
    }
    let depth = body.depth.flatten();
    if depth.as_deref().is_some_and(|d| d != "half" && d != "full") {
        return Err(AppError::bad("depth must be half or full"));
    }
    let (purchase, warranty, in_service) = (
        body.purchase_date.flatten(),
        body.warranty_expiry.flatten(),
        body.in_service_date.flatten(),
    );
    check_date("purchase_date", &purchase)?;
    check_date("warranty_expiry", &warranty)?;
    check_date("in_service_date", &in_service)?;
    let mac = body.mac.flatten().map(|m| normalize_mac(&m)).transpose()?;
    let name = text(body.name);
    check_len("Name", &name, 255)?;
    let responsible = body.responsible_user_id.flatten();
    check_user_exists(&mut tx, responsible).await?;

    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO devices (project_id, device_type_id, code, name, room_id, plan_x, plan_y, plan_rotation, rack_id,
         rack_pos_half, rack_face, rack_mount, parent_device_id, u_height_half, depth, manufacturer, model, serial_number,
         asset_tag, purchase_date, warranty_expiry, in_service_date, responsible_user_id, status, hostname, mac, os,
         firmware, icon_color, text_color, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(type_id)
    .bind(&code)
    .bind(&name)
    .bind(target.room_id)
    .bind(target.plan.0)
    .bind(target.plan.1)
    .bind(target.plan.2)
    .bind(target.rack.map(|r| r.0))
    .bind(target.rack_pos_half)
    .bind(target.face.map(Face::as_str))
    .bind(target.mount.map(Mount::as_str))
    .bind(target.tray_id)
    .bind(height_half)
    .bind(&depth)
        .bind(text(body.manufacturer).or(template.as_ref().and_then(|(_, p)| p.t.manufacturer.clone())))
    .bind(text(body.model).or(template.as_ref().and_then(|(_, p)| p.t.model.clone())))
    .bind(text(body.serial_number))
    .bind(text(body.asset_tag))
    .bind(&purchase)
    .bind(&warranty)
    .bind(&in_service)
    .bind(responsible)
    .bind(status)
    .bind(text(body.hostname))
    .bind(&mac)
    .bind(text(body.os))
    .bind(text(body.firmware))
    .bind(text(body.icon_color))
    .bind(text(body.text_color))
    .bind(text(body.notes))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    hierarchy::reindex(&mut tx, Subtree::Device(id)).await?;
    let mut ports_made = 0;
    if let Some((row, p)) = &template {
        sqlx::query("UPDATE devices SET template_id = ?, template_version = ? WHERE id = ?")
            .bind(row.id)
            .bind(row.version)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        ports_made = super::templates::instantiate(&mut tx, id, p).await?;
    }
    let device = load_device(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "device", Some(id))
            .path(device.path.clone())
            .project(Some(project_id))
            .changes(
                json!({ "code": device.code, "type": type_key, "placement": device.placement(),
                        "template_id": device.template_id, "ports": ports_made }),
            ),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(device.to_json())))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<DeviceFields>,
) -> AppResult<Json<Value>> {
    if body.template_id.is_some() {
        return Err(AppError::bad(
            "A device's template is chosen when it's created",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Device, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let old = load_device(&mut tx, id).await?;
    let project_id = old.project_id;

    let (type_id, type_key, prefix, type_placement) = match device_type(
        &mut tx,
        project_id,
        body.device_type_id,
        body.device_type.as_deref(),
    )
    .await?
    {
        Some(t) => t,
        None => (
            old.device_type_id,
            old.type_key.clone(),
            old.type_prefix.clone(),
            Placement::parse(&old.type_placement).unwrap_or(Placement::Either),
        ),
    };

    // Current placement, as an input, so unchanged devices are re-validated
    // the same way as moved ones.
    let current_placement = match (old.room_id, old.rack_id, old.parent_device_id) {
        (Some(room_id), _, _) => PlacementIn::Room {
            room_id,
            x: old.plan_x,
            y: old.plan_y,
            rotation: old.plan_rotation,
        },
        (_, Some(rack_id), _) => PlacementIn::Rack {
            rack_id,
            u: old.rack_pos_half.map(pos_half_to_u),
            face: old.rack_face.clone(),
            mount: old.rack_mount.clone(),
        },
        (_, _, Some(tray_id)) => PlacementIn::Tray { tray_id },
        _ => PlacementIn::Unplaced,
    };
    let moving = body.placement.is_some();
    let placement = body.placement.clone().unwrap_or(current_placement);
    let target = resolve(&mut tx, project_id, &placement).await?;
    if moving {
        require(&current, Action::Write, &target.chain)?;
    }
    if !can_place(&type_key, type_placement, target.target) {
        return Err(AppError::bad(format!("A {type_key} can't be placed there")));
    }
    if old.type_key == TRAY_KEY && target.target != Target::Rack {
        let on_tray: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE parent_device_id = ?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if on_tray > 0 {
            return Err(AppError::Conflict(
                "Move or remove the devices on this tray first".into(),
            ));
        }
    }
    let height_half = match body.u_height {
        Some(h) => Some(height_to_half(h).map_err(AppError::bad)?),
        None => old
            .u_height_half
            .or(if target.rack.is_some() { Some(2) } else { None }),
    };
    let code = match (&body.code, moving) {
        (Some(c), _) => {
            choose_code(
                &mut tx,
                &target.parent_key,
                Some(c),
                &prefix,
                Some(id),
                Some(&old.code),
            )
            .await?
        }
        (None, true) => {
            choose_code(
                &mut tx,
                &target.parent_key,
                Some(&old.code),
                &prefix,
                Some(id),
                Some(&old.code),
            )
            .await?
        }
        (None, false) => old.code.clone(),
    };
    check_rack_fit(&mut tx, &target, id, height_half.unwrap_or(2)).await?;

    let status = body.status.clone().unwrap_or(old.status.clone());
    if !STATUSES.contains(&status.as_str()) {
        return Err(AppError::bad(
            "status must be planned, active, spare, faulty or retired",
        ));
    }
    let depth = apply_nullable(body.depth, old.depth.clone());
    if depth.as_deref().is_some_and(|d| d != "half" && d != "full") {
        return Err(AppError::bad("depth must be half or full"));
    }
    let purchase = apply_nullable(body.purchase_date, old.purchase_date.clone());
    let warranty = apply_nullable(body.warranty_expiry, old.warranty_expiry.clone());
    let in_service = apply_nullable(body.in_service_date, old.in_service_date.clone());
    check_date("purchase_date", &purchase)?;
    check_date("warranty_expiry", &warranty)?;
    check_date("in_service_date", &in_service)?;
    let mac = match body.mac {
        None => old.mac.clone(),
        Some(None) => None,
        Some(Some(m)) if m.trim().is_empty() => None,
        Some(Some(m)) => Some(normalize_mac(&m)?),
    };
    let responsible = apply_nullable(body.responsible_user_id, old.responsible_user_id);
    check_user_exists(&mut tx, responsible).await?;
    let name = merge_text(body.name, old.name.clone());
    check_len("Name", &name, 255)?;

    // Cables stay when a device moves within its floor; otherwise those to
    // anything that isn't moving with it are removed.
    let mut cables_removed = Vec::new();
    if moving {
        let new_floor = target_floor(&mut tx, &target).await?;
        if new_floor.is_none() || new_floor != old.floor_id {
            let mut moving_ids = vec![id];
            moving_ids.extend(hierarchy::devices_in(&mut tx, Subtree::Device(id)).await?);
            // Unplaced devices aren't cabled at all.
            cables_removed = crate::cabling::cut(&mut tx, &moving_ids, new_floor.is_some()).await?;
        }
    }

    sqlx::query(
        "UPDATE devices SET device_type_id = ?, code = ?, name = ?, room_id = ?, plan_x = ?, plan_y = ?, plan_rotation = ?,
         rack_id = ?, rack_pos_half = ?, rack_face = ?, rack_mount = ?, parent_device_id = ?, u_height_half = ?, depth = ?,
         manufacturer = ?, model = ?, serial_number = ?, asset_tag = ?, purchase_date = ?, warranty_expiry = ?,
         in_service_date = ?, responsible_user_id = ?, status = ?, hostname = ?, mac = ?, os = ?, firmware = ?,
         icon_color = ?, text_color = ?, notes = ?, updated_at = ? WHERE id = ?",
    )
    .bind(type_id)
    .bind(&code)
    .bind(&name)
    .bind(target.room_id)
    .bind(target.plan.0)
    .bind(target.plan.1)
    .bind(target.plan.2)
    .bind(target.rack.map(|r| r.0))
    .bind(target.rack_pos_half)
    .bind(target.face.map(Face::as_str))
    .bind(target.mount.map(Mount::as_str))
    .bind(target.tray_id)
    .bind(height_half)
    .bind(&depth)
    .bind(merge_text(body.manufacturer, old.manufacturer.clone()))
    .bind(merge_text(body.model, old.model.clone()))
    .bind(merge_text(body.serial_number, old.serial_number.clone()))
    .bind(merge_text(body.asset_tag, old.asset_tag.clone()))
    .bind(&purchase)
    .bind(&warranty)
    .bind(&in_service)
    .bind(responsible)
    .bind(&status)
    .bind(merge_text(body.hostname, old.hostname.clone()))
    .bind(&mac)
    .bind(merge_text(body.os, old.os.clone()))
    .bind(merge_text(body.firmware, old.firmware.clone()))
    .bind(merge_text(body.icon_color, old.icon_color.clone()))
    .bind(merge_text(body.text_color, old.text_color.clone()))
    .bind(merge_text(body.notes, old.notes.clone()))
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    hierarchy::reindex_device_tree(&mut tx, id).await?;
    let new = load_device(&mut tx, id).await?;
    let mut changes = audit::diff(&old.audit_view(), &new.audit_view(), &[]);
    if !cables_removed.is_empty() {
        if let Some(o) = changes.as_object_mut() {
            o.insert("cables_removed".into(), json!(cables_removed));
        }
    }
    let action = if new.path != old.path && moving {
        "move"
    } else {
        "update"
    };
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new(action, "device", Some(id))
            .path(new.path.clone())
            .project(Some(project_id))
            .changes(changes),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(new.to_json()))
}

#[derive(Deserialize, Default)]
pub struct DeleteDevice {
    /// For a tray with devices on it: what to do with them.
    devices: Option<ContentsMode>,
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    body: axum::body::Bytes,
) -> AppResult<StatusCode> {
    let body: DeleteDevice = optional_body(&body)?;
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Device, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let (count, moved) =
        hierarchy::clear_contents(&mut tx, Subtree::Device(id), body.devices).await?;
    let cables = crate::cabling::count_for_device(&mut tx, id).await?;
    // Its IP addresses stay documented, unassigned.
    let addresses: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM ip_addresses WHERE device_id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "device", Some(id))
            .path(placed.path.clone())
            .project(Some(placed.project_id))
            .changes(json!({ "devices_on_tray": count, "cables_removed": cables, "addresses_unassigned": addresses })),
    )
    .await?;
    sqlx::query("DELETE FROM devices WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    hierarchy::drop_subtree(&mut tx, Subtree::Device(id)).await?;
    audit_unplaced(&mut tx, &ctx, &current, placed.project_id, &moved).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- next code

#[derive(Deserialize)]
pub struct NextCodeQuery {
    device_type_id: Option<i64>,
    /// "rack" to get the next rack code for a room.
    kind: Option<String>,
    room_id: Option<i64>,
    rack_id: Option<i64>,
    tray_id: Option<i64>,
}

#[derive(Serialize)]
pub struct NextCode {
    code: String,
}

/// The code the UI should pre-fill: prefix plus the next free number among
/// the destination's siblings.
pub async fn next_code(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    Query(q): Query<NextCodeQuery>,
) -> AppResult<Json<NextCode>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let mut conn = state.pool.acquire().await?;
    if q.kind.as_deref() == Some("rack") {
        let room_id = q
            .room_id
            .ok_or_else(|| AppError::bad("room_id is required"))?;
        let room = hierarchy::get(&mut conn, ScopeType::Room, room_id).await?;
        if room.project_id != project_id {
            return Err(AppError::NotFound);
        }
        let taken = hierarchy::room_codes(&mut conn, room_id).await?;
        return Ok(Json(NextCode {
            code: next_free_code(crate::domain::device_types::RACK_PREFIX, &taken),
        }));
    }
    let (_, _, prefix, _) = device_type(&mut conn, project_id, q.device_type_id, None)
        .await?
        .ok_or_else(|| AppError::bad("device_type_id is required"))?;
    let placement = match (q.room_id, q.rack_id, q.tray_id) {
        (Some(room_id), None, None) => PlacementIn::Room {
            room_id,
            x: None,
            y: None,
            rotation: None,
        },
        (None, Some(rack_id), None) => PlacementIn::Rack {
            rack_id,
            u: Some(1.0),
            face: None,
            mount: None,
        },
        (None, None, Some(tray_id)) => PlacementIn::Tray { tray_id },
        (None, None, None) => PlacementIn::Unplaced,
        _ => {
            return Err(AppError::bad(
                "Give at most one of room_id, rack_id and tray_id",
            ))
        }
    };
    let target = resolve(&mut conn, project_id, &placement).await?;
    let code = choose_code(&mut conn, &target.parent_key, None, &prefix, None, None).await?;
    Ok(Json(NextCode { code }))
}

#[cfg(test)]
mod tests {
    use super::normalize_mac;

    #[test]
    fn mac_formats() {
        assert_eq!(
            normalize_mac("AA:BB:CC:DD:EE:FF").unwrap(),
            "aa:bb:cc:dd:ee:ff"
        );
        assert_eq!(
            normalize_mac("aa-bb-cc-dd-ee-ff").unwrap(),
            "aa:bb:cc:dd:ee:ff"
        );
        assert_eq!(
            normalize_mac("aabb.ccdd.eeff").unwrap(),
            "aa:bb:cc:dd:ee:ff"
        );
        assert_eq!(normalize_mac("aabbccddeeff").unwrap(), "aa:bb:cc:dd:ee:ff");
        assert!(normalize_mac("aa:bb:cc").is_err());
        assert!(normalize_mac("gg:bb:cc:dd:ee:ff").is_err());
        assert!(normalize_mac("aa bb cc dd ee ff").is_err());
    }
}
