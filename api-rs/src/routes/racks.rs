//! Racks. A rack sits in a room (DEFAULT at least) and shares the room's
//! code namespace with floor devices.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, SqliteConnection};

use super::places::{
    audit_unplaced, check_len, check_user_exists, clean_text, code_or_400, merge_text, DeleteBody,
};
use super::{apply_nullable, optional_body, require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::device_types::RACK_PREFIX;
use crate::domain::naming::{next_free_code, unique_variant};
use crate::domain::permissions::{Action, ScopeType};
use crate::domain::rack::{check_fit, Face, Mount, Slot};
use crate::error::{AppError, AppResult};
use crate::hierarchy::{self, Subtree};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

#[derive(FromRow, Serialize, Clone)]
pub struct Rack {
    pub id: i64,
    pub room_id: i64,
    pub code: String,
    pub name: Option<String>,
    pub u_height: i64,
    pub width: String,
    pub depth_mm: Option<i64>,
    pub numbering: String,
    pub rack_type: String,
    pub plan_x: Option<f64>,
    pub plan_y: Option<f64>,
    pub plan_rotation: Option<f64>,
    pub responsible_user_id: Option<i64>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

macro_rules! rack_columns {
    () => {
        "k.id, k.room_id, k.code, k.name, k.u_height, k.width, k.depth_mm, k.numbering, k.rack_type, k.plan_x, k.plan_y, \
         k.plan_rotation, k.responsible_user_id, k.notes, k.created_at, k.updated_at"
    };
}

pub async fn load_rack(conn: &mut SqliteConnection, id: i64) -> AppResult<Rack> {
    sqlx::query_as::<_, Rack>(concat!(
        "SELECT ",
        rack_columns!(),
        " FROM racks k WHERE k.id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

/// Rack summaries on a floor or in a room, with paths and device counts.
pub async fn racks_where(
    conn: &mut SqliteConnection,
    scope: &str,
    id: i64,
) -> AppResult<Vec<Value>> {
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        rack: Rack,
        path: String,
        device_count: i64,
    }
    let sql = match scope {
        "floor" => concat!(
            "SELECT ", rack_columns!(), ", s.path, ",
            "(SELECT COUNT(*) FROM search_entries d WHERE d.kind = 'device' AND d.rack_id = k.id) AS device_count ",
            "FROM racks k JOIN search_entries s ON s.kind = 'rack' AND s.ref_id = k.id WHERE s.floor_id = ? ORDER BY k.code"
        ),
        _ => concat!(
            "SELECT ", rack_columns!(), ", s.path, ",
            "(SELECT COUNT(*) FROM search_entries d WHERE d.kind = 'device' AND d.rack_id = k.id) AS device_count ",
            "FROM racks k JOIN search_entries s ON s.kind = 'rack' AND s.ref_id = k.id WHERE s.room_id = ? ORDER BY k.code"
        ),
    };
    let rows = sqlx::query_as::<_, Row>(sql)
        .bind(id)
        .fetch_all(conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let mut v = serde_json::to_value(&r.rack).unwrap_or_default();
            v["path"] = json!(r.path);
            v["device_count"] = json!(r.device_count);
            v
        })
        .collect())
}

/// Slots of every device mounted in a rack (optionally leaving one out).
pub async fn rack_slots(
    conn: &mut SqliteConnection,
    rack_id: i64,
    except: Option<i64>,
) -> AppResult<Vec<Slot>> {
    #[derive(FromRow)]
    struct Row {
        id: i64,
        rack_pos_half: Option<i64>,
        u_height_half: Option<i64>,
        rack_face: String,
        rack_mount: String,
    }
    let rows = sqlx::query_as::<_, Row>(
        "SELECT id, rack_pos_half, u_height_half, rack_face, rack_mount FROM devices WHERE rack_id = ? AND id <> ?",
    )
    .bind(rack_id)
    .bind(except.unwrap_or(-1))
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            Some(Slot {
                device_id: r.id,
                pos_half: r.rack_pos_half,
                height_half: r.u_height_half.unwrap_or(2),
                face: Face::parse(&r.rack_face)?,
                mount: Mount::parse(&r.rack_mount)?,
            })
        })
        .collect())
}

fn check_enum(field: &str, value: &Option<String>, allowed: &[&str]) -> AppResult<()> {
    if let Some(v) = value {
        if !allowed.contains(&v.as_str()) {
            return Err(AppError::bad(format!(
                "{field} must be one of: {}",
                allowed.join(", ")
            )));
        }
    }
    Ok(())
}

#[derive(Deserialize, Default)]
pub struct RackFields {
    code: Option<String>,
    name: Option<String>,
    room_id: Option<i64>,
    u_height: Option<i64>,
    width: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    depth_mm: Option<Option<i64>>,
    numbering: Option<String>,
    rack_type: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    plan_x: Option<Option<f64>>,
    #[serde(default, deserialize_with = "super::nullable")]
    plan_y: Option<Option<f64>>,
    #[serde(default, deserialize_with = "super::nullable")]
    plan_rotation: Option<Option<f64>>,
    #[serde(default, deserialize_with = "super::nullable")]
    responsible_user_id: Option<Option<i64>>,
    notes: Option<String>,
}

fn validate(body: &RackFields) -> AppResult<()> {
    if body.u_height.is_some_and(|u| !(1..=60).contains(&u)) {
        return Err(AppError::bad("u_height must be between 1 and 60"));
    }
    if body
        .depth_mm
        .flatten()
        .is_some_and(|d| !(100..=2000).contains(&d))
    {
        return Err(AppError::bad("depth_mm must be between 100 and 2000"));
    }
    check_enum("width", &body.width, &["19in", "23in", "10in"])?;
    check_enum("numbering", &body.numbering, &["bottom_up", "top_down"])?;
    check_enum(
        "rack_type",
        &body.rack_type,
        &["enclosed", "open_frame", "wall_mount", "other"],
    )?;
    for v in [body.plan_x, body.plan_y, body.plan_rotation]
        .into_iter()
        .flatten()
        .flatten()
    {
        if !v.is_finite() {
            return Err(AppError::bad("Plan coordinates must be finite numbers"));
        }
    }
    Ok(())
}

async fn rack_json(conn: &mut SqliteConnection, id: i64) -> AppResult<Value> {
    let rack = load_rack(conn, id).await?;
    let path = hierarchy::get(conn, ScopeType::Rack, id).await?.path;
    let mut v = serde_json::to_value(&rack).unwrap_or_default();
    v["path"] = json!(path);
    Ok(v)
}

pub async fn create_rack(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(room_id): Path<i64>,
    JsonBody(body): JsonBody<RackFields>,
) -> AppResult<(StatusCode, Json<Value>)> {
    validate(&body)?;
    let mut tx = state.pool.begin().await?;
    let room = hierarchy::get(&mut tx, ScopeType::Room, room_id).await?;
    require(&current, Action::Write, &room.chain)?;
    let taken = hierarchy::room_codes(&mut tx, room_id).await?;
    let code = match &body.code {
        Some(c) => {
            let c = code_or_400(c)?;
            if taken.iter().any(|t| t.eq_ignore_ascii_case(&c)) {
                return Err(AppError::Conflict(format!(
                    "{c} is already used in this room; try {}",
                    unique_variant(&c, &taken)
                )));
            }
            c
        }
        None => next_free_code(RACK_PREFIX, &taken),
    };
    let name = clean_text(body.name);
    check_len("Name", &name, 255)?;
    let responsible = body.responsible_user_id.flatten();
    check_user_exists(&mut tx, responsible).await?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO racks (room_id, code, name, u_height, width, depth_mm, numbering, rack_type, plan_x, plan_y,
         plan_rotation, responsible_user_id, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(room_id)
    .bind(&code)
    .bind(&name)
    .bind(body.u_height.unwrap_or(42))
    .bind(body.width.as_deref().unwrap_or("19in"))
    .bind(body.depth_mm.flatten())
    .bind(body.numbering.as_deref().unwrap_or("bottom_up"))
    .bind(body.rack_type.as_deref().unwrap_or("enclosed"))
    .bind(body.plan_x.flatten())
    .bind(body.plan_y.flatten())
    .bind(body.plan_rotation.flatten())
    .bind(responsible)
    .bind(clean_text(body.notes))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    hierarchy::reindex(&mut tx, Subtree::Rack(id)).await?;
    let v = rack_json(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "rack", Some(id))
            .path(v["path"].as_str().unwrap_or_default())
            .project(Some(room.project_id))
            .changes(json!({ "code": code, "u_height": v["u_height"] })),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(v)))
}

pub async fn get_rack(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Rack, id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let mut v = rack_json(&mut conn, id).await?;
    v["devices"] = json!(super::devices::rack_devices(&mut conn, id).await?);
    v["can_edit"] = json!(current.principal.can(Action::Write, &placed.chain));
    Ok(Json(v))
}

pub async fn update_rack(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<RackFields>,
) -> AppResult<Json<Value>> {
    validate(&body)?;
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Rack, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let old = load_rack(&mut tx, id).await?;
    let room_id = body.room_id.unwrap_or(old.room_id);
    if room_id != old.room_id {
        let target = hierarchy::get(&mut tx, ScopeType::Room, room_id).await?;
        if target.project_id != placed.project_id {
            return Err(AppError::bad(
                "Racks can't be moved to another project here",
            ));
        }
        require(&current, Action::Write, &target.chain)?;
    }
    let code = match &body.code {
        Some(c) => code_or_400(c)?,
        None => old.code.clone(),
    };
    if room_id != old.room_id || !code.eq_ignore_ascii_case(&old.code) {
        let taken: Vec<String> = hierarchy::room_codes(&mut tx, room_id)
            .await?
            .into_iter()
            .filter(|c| !(room_id == old.room_id && c.eq_ignore_ascii_case(&old.code)))
            .collect();
        if taken.iter().any(|t| t.eq_ignore_ascii_case(&code)) {
            return Err(AppError::Conflict(format!(
                "{code} is already used in that room; try {}",
                unique_variant(&code, &taken)
            )));
        }
    }
    let u_height = body.u_height.unwrap_or(old.u_height);
    if u_height < old.u_height {
        for slot in rack_slots(&mut tx, id, None).await? {
            if check_fit(&slot, &[], u_height).is_err() {
                return Err(AppError::Conflict(
                    "Some devices would no longer fit; move them first".into(),
                ));
            }
        }
    }
    let responsible = apply_nullable(body.responsible_user_id, old.responsible_user_id);
    check_user_exists(&mut tx, responsible).await?;
    let name = merge_text(body.name, old.name.clone());
    check_len("Name", &name, 255)?;
    sqlx::query(
        "UPDATE racks SET room_id = ?, code = ?, name = ?, u_height = ?, width = ?, depth_mm = ?, numbering = ?,
         rack_type = ?, plan_x = ?, plan_y = ?, plan_rotation = ?, responsible_user_id = ?, notes = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(room_id)
    .bind(&code)
    .bind(&name)
    .bind(u_height)
    .bind(body.width.as_deref().unwrap_or(&old.width))
    .bind(apply_nullable(body.depth_mm, old.depth_mm))
    .bind(body.numbering.as_deref().unwrap_or(&old.numbering))
    .bind(body.rack_type.as_deref().unwrap_or(&old.rack_type))
    .bind(apply_nullable(body.plan_x, old.plan_x))
    .bind(apply_nullable(body.plan_y, old.plan_y))
    .bind(apply_nullable(body.plan_rotation, old.plan_rotation))
    .bind(responsible)
    .bind(merge_text(body.notes, old.notes.clone()))
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    hierarchy::reindex(&mut tx, Subtree::Rack(id)).await?;
    let new = load_rack(&mut tx, id).await?;
    let mut changes = audit::diff(
        &serde_json::to_value(&old).unwrap_or_default(),
        &serde_json::to_value(&new).unwrap_or_default(),
        &[],
    );
    if let Some(o) = changes.as_object_mut() {
        o.remove("updated_at");
    }
    let v = rack_json(&mut tx, id).await?;
    let action = if room_id != old.room_id {
        "move"
    } else {
        "update"
    };
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new(action, "rack", Some(id))
            .path(v["path"].as_str().unwrap_or_default())
            .project(Some(placed.project_id))
            .changes(changes),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(v))
}

pub async fn delete_rack(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    body: axum::body::Bytes,
) -> AppResult<StatusCode> {
    let body: DeleteBody = optional_body(&body)?;
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Rack, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let rack = load_rack(&mut tx, id).await?;
    match &body.confirm_code {
        Some(c) if c.trim().eq_ignore_ascii_case(&rack.code) => {}
        _ => {
            return Err(AppError::bad(format!(
                "Type the code {} to confirm deletion",
                rack.code
            )))
        }
    }
    let (count, moved) =
        hierarchy::clear_contents(&mut tx, Subtree::Rack(id), body.devices).await?;
    sqlx::query("DELETE FROM racks WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    hierarchy::drop_subtree(&mut tx, Subtree::Rack(id)).await?;
    audit_unplaced(&mut tx, &ctx, &current, placed.project_id, &moved).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "rack", Some(id))
            .path(placed.path)
            .project(Some(placed.project_id))
            .changes(json!({ "devices": count, "devices_action": body.devices })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
