//! Locations, floors and rooms (design section 4).
//!
//! * Creating a location creates floor `0`; creating a floor creates its
//!   DEFAULT room, so devices can be placed before any rooms are drawn.
//! * A location keeps at least one floor; DEFAULT rooms can't be deleted or
//!   renamed.
//! * Deleting something that still holds devices needs a choice: move them
//!   to Unplaced, or delete them too.
//! * Text fields in updates: omitted = unchanged, "" = cleared.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, SqliteConnection};

use super::{require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::naming::normalize_code;
use crate::domain::permissions::{Action, Chain, ScopeType};
use crate::error::{AppError, AppResult};
use crate::hierarchy::{self, ContentsMode, Subtree};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

macro_rules! room_columns {
    () => {
        "id, floor_id, code, name, is_default, shape, color, contact_name, contact_phone, contact_email, \
         responsible_user_id, notes, created_at, updated_at"
    };
}

// ---------------------------------------------------------------- helpers

/// Optional text update: None keeps `old`, "" clears, anything else is trimmed.
pub fn merge_text(new: Option<String>, old: Option<String>) -> Option<String> {
    match new {
        None => old,
        Some(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
    }
}

pub fn clean_text(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// A cleaned phone number in its stored form (see `domain::phone`).
fn phone(value: Option<String>) -> Option<String> {
    value.map(|v| crate::domain::phone::format(&v))
}

pub fn check_len(field: &str, value: &Option<String>, max: usize) -> AppResult<()> {
    if value.as_ref().is_some_and(|v| v.chars().count() > max) {
        return Err(AppError::bad(format!(
            "{field} must be at most {max} characters"
        )));
    }
    Ok(())
}

pub fn code_or_400(code: &str) -> AppResult<String> {
    normalize_code(code).map_err(AppError::bad)
}

pub async fn check_user_exists(conn: &mut SqliteConnection, user_id: Option<i64>) -> AppResult<()> {
    if let Some(id) = user_id {
        let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM users WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await?;
        exists.ok_or_else(|| AppError::bad("Responsible user not found"))?;
    }
    Ok(())
}

fn actor(current: &CurrentUser) -> Option<(i64, &str)> {
    Some((current.user.id, current.user.username.as_str()))
}

#[derive(Serialize)]
pub struct WithPath<T: Serialize> {
    #[serde(flatten)]
    pub item: T,
    pub path: String,
}

#[derive(Deserialize, Default)]
pub struct DeleteBody {
    pub confirm_code: Option<String>,
    pub devices: Option<ContentsMode>,
}

fn confirm(body: &DeleteBody, code: &str) -> AppResult<()> {
    match &body.confirm_code {
        Some(c) if c.trim().eq_ignore_ascii_case(code) => Ok(()),
        _ => Err(AppError::bad(format!(
            "Type the code {code} to confirm deletion"
        ))),
    }
}

/// Audit entries for devices moved to Unplaced by a delete.
pub async fn audit_unplaced(
    conn: &mut SqliteConnection,
    ctx: &RequestCtx,
    current: &CurrentUser,
    project_id: i64,
    moved: &[crate::hierarchy::Unplaced],
) -> AppResult<()> {
    for u in moved {
        let (id, before) = (&u.id, &u.before);
        let after: String = sqlx::query_scalar(
            "SELECT path FROM search_entries WHERE kind = 'device' AND ref_id = ?",
        )
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
        audit::record(
            conn,
            ctx,
            actor(current),
            Entry::new("move", "device", Some(*id))
                .path(after.clone())
                .project(Some(project_id))
                .changes(if u.cut.is_empty() {
                    json!({ "path": [before, after] })
                } else {
                    json!({ "path": [before, after], "cables_removed": u.cut })
                }),
        )
        .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------- locations

#[derive(FromRow, Serialize)]
pub struct Location {
    pub id: i64,
    pub project_id: i64,
    pub code: String,
    pub name: Option<String>,
    pub address_street: Option<String>,
    pub address_city: Option<String>,
    pub address_state: Option<String>,
    pub address_postcode: Option<String>,
    pub address_country: Option<String>,
    pub contact_name: Option<String>,
    pub contact_phone: Option<String>,
    pub contact_email: Option<String>,
    pub responsible_user_id: Option<i64>,
    pub isp_primary_name: Option<String>,
    pub isp_primary_circuit: Option<String>,
    pub isp_primary_contact: Option<String>,
    pub isp_secondary_name: Option<String>,
    pub isp_secondary_circuit: Option<String>,
    pub isp_secondary_contact: Option<String>,
    pub notes: Option<String>,
    /// Groups buildings (locations) of one campus; display only.
    pub site: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

macro_rules! location_columns {
    () => {
        "id, project_id, code, name, address_street, address_city, address_state, address_postcode, address_country, \
         contact_name, contact_phone, contact_email, responsible_user_id, isp_primary_name, isp_primary_circuit, \
         isp_primary_contact, isp_secondary_name, isp_secondary_circuit, isp_secondary_contact, notes, site, created_at, updated_at"
    };
}

async fn load_location(conn: &mut SqliteConnection, id: i64) -> AppResult<Location> {
    sqlx::query_as::<_, Location>(concat!(
        "SELECT ",
        location_columns!(),
        " FROM locations WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

#[derive(Deserialize, Default)]
pub struct LocationFields {
    code: Option<String>,
    name: Option<String>,
    address_street: Option<String>,
    address_city: Option<String>,
    address_state: Option<String>,
    address_postcode: Option<String>,
    address_country: Option<String>,
    contact_name: Option<String>,
    contact_phone: Option<String>,
    contact_email: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    responsible_user_id: Option<Option<i64>>,
    isp_primary_name: Option<String>,
    isp_primary_circuit: Option<String>,
    isp_primary_contact: Option<String>,
    isp_secondary_name: Option<String>,
    isp_secondary_circuit: Option<String>,
    isp_secondary_contact: Option<String>,
    notes: Option<String>,
    site: Option<String>,
}

/// Index of the site in `location_values`.
const SITE: usize = 16;

/// The editable text fields of a location, in column order, merged with old values.
fn location_values(f: LocationFields, old: Option<&Location>) -> Vec<Option<String>> {
    let o = |get: fn(&Location) -> Option<String>| old.and_then(get);
    vec![
        merge_text(f.name, o(|l| l.name.clone())),
        merge_text(f.address_street, o(|l| l.address_street.clone())),
        merge_text(f.address_city, o(|l| l.address_city.clone())),
        merge_text(f.address_state, o(|l| l.address_state.clone())),
        merge_text(f.address_postcode, o(|l| l.address_postcode.clone())),
        merge_text(f.address_country, o(|l| l.address_country.clone())),
        merge_text(f.contact_name, o(|l| l.contact_name.clone())),
        phone(merge_text(f.contact_phone, o(|l| l.contact_phone.clone()))),
        merge_text(f.contact_email, o(|l| l.contact_email.clone())),
        merge_text(f.isp_primary_name, o(|l| l.isp_primary_name.clone())),
        merge_text(f.isp_primary_circuit, o(|l| l.isp_primary_circuit.clone())),
        merge_text(f.isp_primary_contact, o(|l| l.isp_primary_contact.clone())),
        merge_text(f.isp_secondary_name, o(|l| l.isp_secondary_name.clone())),
        merge_text(
            f.isp_secondary_circuit,
            o(|l| l.isp_secondary_circuit.clone()),
        ),
        merge_text(
            f.isp_secondary_contact,
            o(|l| l.isp_secondary_contact.clone()),
        ),
        merge_text(f.notes, o(|l| l.notes.clone())),
        merge_text(f.site, o(|l| l.site.clone())),
    ]
}

async fn create_floor_row(
    conn: &mut SqliteConnection,
    location_id: i64,
    code: &str,
    name: Option<&str>,
    level: i64,
) -> AppResult<i64> {
    let now = now_ts();
    let floor_id = sqlx::query("INSERT INTO floors (location_id, code, name, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(location_id)
        .bind(code)
        .bind(name)
        .bind(level)
        .bind(&now)
        .bind(&now)
        .execute(&mut *conn)
        .await?
        .last_insert_rowid();
    sqlx::query("INSERT INTO rooms (floor_id, code, name, is_default, created_at, updated_at) VALUES (?, 'DEFAULT', 'Default room', 1, ?, ?)")
        .bind(floor_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *conn)
        .await?;
    Ok(floor_id)
}

/// Every location, floor, room and rack in a project with its path, for
/// pickers (move a device, filter a list).
pub async fn list_places(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Vec<Value>>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let rows: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT kind, ref_id, path FROM search_entries
         WHERE project_id = ? AND kind IN ('location', 'floor', 'room', 'rack')
         ORDER BY path",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(kind, id, path)| json!({ "kind": kind, "id": id, "path": path }))
            .collect(),
    ))
}

pub async fn list_locations(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Vec<Value>>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    #[derive(FromRow)]
    struct Counts {
        id: i64,
        floors: i64,
        rooms: i64,
        racks: i64,
        devices: i64,
    }
    let mut conn = state.pool.acquire().await?;
    let locations = sqlx::query_as::<_, Location>(concat!(
        "SELECT ",
        location_columns!(),
        " FROM locations WHERE project_id = ? ORDER BY site IS NULL, site COLLATE NOCASE, code"
    ))
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    let counts = sqlx::query_as::<_, Counts>(
        "SELECT l.id,
                (SELECT COUNT(*) FROM floors f WHERE f.location_id = l.id) AS floors,
                (SELECT COUNT(*) FROM search_entries s WHERE s.kind = 'room' AND s.location_id = l.id) AS rooms,
                (SELECT COUNT(*) FROM search_entries s WHERE s.kind = 'rack' AND s.location_id = l.id) AS racks,
                (SELECT COUNT(*) FROM search_entries s WHERE s.kind = 'device' AND s.location_id = l.id) AS devices
         FROM locations l WHERE l.project_id = ?",
    )
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Json(
        locations
            .into_iter()
            .map(|l| {
                let c = counts.iter().find(|c| c.id == l.id);
                let mut v = serde_json::to_value(&l).unwrap_or_default();
                v["counts"] = json!({
                    "floors": c.map_or(0, |c| c.floors), "rooms": c.map_or(0, |c| c.rooms),
                    "racks": c.map_or(0, |c| c.racks), "devices": c.map_or(0, |c| c.devices),
                });
                v
            })
            .collect(),
    ))
}

pub async fn create_location(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<LocationFields>,
) -> AppResult<(StatusCode, Json<WithPath<Location>>)> {
    require(&current, Action::Write, &Chain::project(project_id))?;
    let code = code_or_400(body.code.as_deref().unwrap_or(""))?;
    let responsible = body.responsible_user_id.flatten();
    let values = location_values(body, None);
    check_len("Name", &values[0], 255)?;
    check_len("Site", &values[SITE], 100)?;
    let mut tx = state.pool.begin().await?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(&mut *tx)
        .await?;
    exists.ok_or(AppError::NotFound)?;
    check_user_exists(&mut tx, responsible).await?;
    let now = now_ts();
    let mut q = sqlx::query(
        "INSERT INTO locations (project_id, code, name, address_street, address_city, address_state, address_postcode,
         address_country, contact_name, contact_phone, contact_email, isp_primary_name, isp_primary_circuit,
         isp_primary_contact, isp_secondary_name, isp_secondary_circuit, isp_secondary_contact, notes, site,
         responsible_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(&code);
    for v in &values {
        q = q.bind(v);
    }
    let id = q
        .bind(responsible)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .last_insert_rowid();
    create_floor_row(&mut tx, id, "0", Some("Ground floor"), 0).await?;
    hierarchy::reindex(&mut tx, Subtree::Location(id)).await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Location, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        actor(&current),
        Entry::new("create", "location", Some(id))
            .path(placed.path.clone())
            .project(Some(project_id))
            .changes(json!({ "code": code, "name": values[0], "site": values[SITE] })),
    )
    .await?;
    let item = load_location(&mut tx, id).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(WithPath {
            item,
            path: placed.path,
        }),
    ))
}

pub async fn get_location(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Location, id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let location = load_location(&mut conn, id).await?;
    let floors = floor_summaries(&mut conn, id).await?;
    let mut v = serde_json::to_value(&location).unwrap_or_default();
    v["path"] = json!(placed.path);
    v["floors"] = json!(floors);
    v["can_edit"] = json!(current.principal.can(Action::Write, &placed.chain));
    Ok(Json(v))
}

pub async fn update_location(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<LocationFields>,
) -> AppResult<Json<WithPath<Location>>> {
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Location, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let old = load_location(&mut tx, id).await?;
    let code = match &body.code {
        Some(c) => code_or_400(c)?,
        None => old.code.clone(),
    };
    let responsible = super::apply_nullable(body.responsible_user_id, old.responsible_user_id);
    check_user_exists(&mut tx, responsible).await?;
    let values = location_values(body, Some(&old));
    check_len("Name", &values[0], 255)?;
    check_len("Site", &values[SITE], 100)?;
    let mut q = sqlx::query(
        "UPDATE locations SET code = ?, name = ?, address_street = ?, address_city = ?, address_state = ?,
         address_postcode = ?, address_country = ?, contact_name = ?, contact_phone = ?, contact_email = ?,
         isp_primary_name = ?, isp_primary_circuit = ?, isp_primary_contact = ?, isp_secondary_name = ?,
         isp_secondary_circuit = ?, isp_secondary_contact = ?, notes = ?, site = ?, responsible_user_id = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&code);
    for v in &values {
        q = q.bind(v);
    }
    q.bind(responsible)
        .bind(now_ts())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    hierarchy::reindex(&mut tx, Subtree::Location(id)).await?;
    let new = load_location(&mut tx, id).await?;
    let path = hierarchy::get(&mut tx, ScopeType::Location, id).await?.path;
    let changes = audit::diff(
        &serde_json::to_value(&old).unwrap_or_default(),
        &serde_json::to_value(&new).unwrap_or_default(),
        &[],
    );
    let mut changes = changes;
    if let Some(obj) = changes.as_object_mut() {
        obj.remove("updated_at");
    }
    audit::record(
        &mut tx,
        &ctx,
        actor(&current),
        Entry::new("update", "location", Some(id))
            .path(path.clone())
            .project(Some(placed.project_id))
            .changes(changes),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(WithPath { item: new, path }))
}

pub async fn delete_location(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    body: axum::body::Bytes,
) -> AppResult<StatusCode> {
    let body: DeleteBody = super::optional_body(&body)?;
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Location, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let code: String = sqlx::query_scalar("SELECT code FROM locations WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    confirm(&body, &code)?;
    let (count, moved) =
        hierarchy::clear_contents(&mut tx, Subtree::Location(id), body.devices).await?;
    sqlx::query("DELETE FROM locations WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    hierarchy::drop_subtree(&mut tx, Subtree::Location(id)).await?;
    audit_unplaced(&mut tx, &ctx, &current, placed.project_id, &moved).await?;
    audit::record(
        &mut tx,
        &ctx,
        actor(&current),
        Entry::new("delete", "location", Some(id))
            .path(placed.path)
            .project(Some(placed.project_id))
            .changes(json!({ "devices": count, "devices_action": body.devices })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- floors

#[derive(FromRow, Serialize)]
pub struct Floor {
    pub id: i64,
    pub location_id: i64,
    pub code: String,
    pub name: Option<String>,
    pub level: i64,
    pub plan_width: Option<i64>,
    pub plan_height: Option<i64>,
    pub scale_px_per_m: Option<f64>,
    #[serde(skip)]
    pub plan_image: Option<String>,
    /// Set when the floor has a plan image (GET /api/floors/{id}/plan-image).
    pub plan_image_type: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

macro_rules! floor_columns {
    () => {
        "id, location_id, code, name, level, plan_width, plan_height, scale_px_per_m, plan_image, plan_image_type, notes, \
         created_at, updated_at"
    };
}

pub async fn load_floor(conn: &mut SqliteConnection, id: i64) -> AppResult<Floor> {
    sqlx::query_as::<_, Floor>(concat!(
        "SELECT ",
        floor_columns!(),
        " FROM floors WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

async fn floor_summaries(conn: &mut SqliteConnection, location_id: i64) -> AppResult<Vec<Value>> {
    #[derive(FromRow, Serialize)]
    struct Row {
        id: i64,
        code: String,
        name: Option<String>,
        level: i64,
        rooms: i64,
        racks: i64,
        devices: i64,
    }
    let rows = sqlx::query_as::<_, Row>(
        "SELECT f.id, f.code, f.name, f.level,
                (SELECT COUNT(*) FROM rooms r WHERE r.floor_id = f.id AND r.is_default = 0) AS rooms,
                (SELECT COUNT(*) FROM search_entries s WHERE s.kind = 'rack' AND s.floor_id = f.id) AS racks,
                (SELECT COUNT(*) FROM search_entries s WHERE s.kind = 'device' AND s.floor_id = f.id) AS devices
         FROM floors f WHERE f.location_id = ? ORDER BY f.level",
    )
    .bind(location_id)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| serde_json::to_value(r).unwrap_or_default())
        .collect())
}

#[derive(Deserialize, Default)]
pub struct FloorFields {
    code: Option<String>,
    name: Option<String>,
    level: Option<i64>,
    plan_width: Option<i64>,
    plan_height: Option<i64>,
    scale_px_per_m: Option<f64>,
    notes: Option<String>,
}

pub async fn create_floor(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(location_id): Path<i64>,
    JsonBody(body): JsonBody<FloorFields>,
) -> AppResult<(StatusCode, Json<WithPath<Floor>>)> {
    let mut tx = state.pool.begin().await?;
    let parent = hierarchy::get(&mut tx, ScopeType::Location, location_id).await?;
    require(&current, Action::Write, &parent.chain)?;
    let code = code_or_400(body.code.as_deref().unwrap_or(""))?;
    let level = match body.level {
        Some(l) => l,
        None => sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(level) + 1 FROM floors WHERE location_id = ?",
        )
        .bind(location_id)
        .fetch_one(&mut *tx)
        .await?
        .unwrap_or(0),
    };
    let name = clean_text(body.name);
    check_len("Name", &name, 255)?;
    let id = create_floor_row(&mut tx, location_id, &code, name.as_deref(), level).await?;
    sqlx::query("UPDATE floors SET notes = ? WHERE id = ?")
        .bind(clean_text(body.notes))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    hierarchy::reindex(&mut tx, Subtree::Floor(id)).await?;
    let path = hierarchy::get(&mut tx, ScopeType::Floor, id).await?.path;
    audit::record(
        &mut tx,
        &ctx,
        actor(&current),
        Entry::new("create", "floor", Some(id))
            .path(path.clone())
            .project(Some(parent.project_id))
            .changes(json!({ "code": code, "level": level })),
    )
    .await?;
    let item = load_floor(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(WithPath { item, path })))
}

pub async fn get_floor(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Floor, id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let floor = load_floor(&mut conn, id).await?;
    let rooms = sqlx::query_as::<_, Room>(concat!(
        "SELECT ",
        room_columns!(),
        " FROM rooms WHERE floor_id = ? ORDER BY is_default DESC, code"
    ))
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let racks: Vec<Value> = super::racks::racks_where(&mut conn, "floor", id).await?;
    let devices: Vec<Value> = super::devices::floor_devices(&mut conn, id).await?;
    let mut v = serde_json::to_value(&floor).unwrap_or_default();
    v["path"] = json!(placed.path);
    v["rooms"] = serde_json::to_value(rooms.into_iter().map(Room::into_json).collect::<Vec<_>>())
        .unwrap_or_default();
    v["racks"] = json!(racks);
    v["devices"] = json!(devices);
    v["can_edit"] = json!(current.principal.can(Action::Write, &placed.chain));
    Ok(Json(v))
}

pub async fn update_floor(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<FloorFields>,
) -> AppResult<Json<WithPath<Floor>>> {
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Floor, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let old = load_floor(&mut tx, id).await?;
    let code = match &body.code {
        Some(c) => code_or_400(c)?,
        None => old.code.clone(),
    };
    for (field, v) in [
        ("plan_width", body.plan_width),
        ("plan_height", body.plan_height),
    ] {
        if v.is_some_and(|v| v <= 0) {
            return Err(AppError::bad(format!("{field} must be positive")));
        }
    }
    if body
        .scale_px_per_m
        .is_some_and(|s| !s.is_finite() || s <= 0.0)
    {
        return Err(AppError::bad("scale_px_per_m must be positive"));
    }
    let name = merge_text(body.name, old.name.clone());
    check_len("Name", &name, 255)?;
    sqlx::query(
        "UPDATE floors SET code = ?, name = ?, level = ?, plan_width = ?, plan_height = ?, scale_px_per_m = ?, notes = ?,
         updated_at = ? WHERE id = ?",
    )
    .bind(&code)
    .bind(&name)
    .bind(body.level.unwrap_or(old.level))
    .bind(body.plan_width.or(old.plan_width))
    .bind(body.plan_height.or(old.plan_height))
    .bind(body.scale_px_per_m.or(old.scale_px_per_m))
    .bind(merge_text(body.notes, old.notes.clone()))
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    hierarchy::reindex(&mut tx, Subtree::Floor(id)).await?;
    let new = load_floor(&mut tx, id).await?;
    let path = hierarchy::get(&mut tx, ScopeType::Floor, id).await?.path;
    let mut changes = audit::diff(
        &serde_json::to_value(&old).unwrap_or_default(),
        &serde_json::to_value(&new).unwrap_or_default(),
        &[],
    );
    if let Some(o) = changes.as_object_mut() {
        o.remove("updated_at");
    }
    audit::record(
        &mut tx,
        &ctx,
        actor(&current),
        Entry::new("update", "floor", Some(id))
            .path(path.clone())
            .project(Some(placed.project_id))
            .changes(changes),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(WithPath { item: new, path }))
}

pub async fn delete_floor(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    body: axum::body::Bytes,
) -> AppResult<StatusCode> {
    let body: DeleteBody = super::optional_body(&body)?;
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Floor, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let floor = load_floor(&mut tx, id).await?;
    let siblings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM floors WHERE location_id = ?")
        .bind(floor.location_id)
        .fetch_one(&mut *tx)
        .await?;
    if siblings <= 1 {
        return Err(AppError::Conflict(
            "A location must keep at least one floor".into(),
        ));
    }
    confirm(&body, &floor.code)?;
    let (count, moved) =
        hierarchy::clear_contents(&mut tx, Subtree::Floor(id), body.devices).await?;
    sqlx::query("DELETE FROM floors WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    hierarchy::drop_subtree(&mut tx, Subtree::Floor(id)).await?;
    audit_unplaced(&mut tx, &ctx, &current, placed.project_id, &moved).await?;
    audit::record(
        &mut tx,
        &ctx,
        actor(&current),
        Entry::new("delete", "floor", Some(id))
            .path(placed.path)
            .project(Some(placed.project_id))
            .changes(json!({ "devices": count, "devices_action": body.devices })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- rooms

#[derive(FromRow, Serialize)]
pub struct Room {
    pub id: i64,
    pub floor_id: i64,
    pub code: String,
    pub name: Option<String>,
    pub is_default: bool,
    #[sqlx(json(nullable))]
    pub shape: Option<Value>,
    pub color: Option<String>,
    pub contact_name: Option<String>,
    pub contact_phone: Option<String>,
    pub contact_email: Option<String>,
    pub responsible_user_id: Option<i64>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Room {
    fn into_json(self) -> Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

async fn load_room(conn: &mut SqliteConnection, id: i64) -> AppResult<Room> {
    sqlx::query_as::<_, Room>(concat!(
        "SELECT ",
        room_columns!(),
        " FROM rooms WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

/// A room outline: `{"type": "polygon", "points": [[x, y], …]}` with 3 to
/// 500 points in floor-plan pixels.
pub fn validate_shape(shape: &Value) -> AppResult<Value> {
    let bad = || {
        AppError::bad(
            "shape must be {\"type\": \"polygon\", \"points\": [[x, y], ...]} with 3 to 500 points",
        )
    };
    if shape.get("type").and_then(Value::as_str) != Some("polygon") {
        return Err(bad());
    }
    let points = shape
        .get("points")
        .and_then(Value::as_array)
        .ok_or_else(bad)?;
    if !(3..=500).contains(&points.len()) {
        return Err(bad());
    }
    let mut clean = Vec::with_capacity(points.len());
    for p in points {
        let pair = p.as_array().filter(|a| a.len() == 2).ok_or_else(bad)?;
        let x = pair[0].as_f64().filter(|v| v.is_finite()).ok_or_else(bad)?;
        let y = pair[1].as_f64().filter(|v| v.is_finite()).ok_or_else(bad)?;
        clean.push(json!([x, y]));
    }
    Ok(json!({ "type": "polygon", "points": clean }))
}

#[derive(Deserialize, Default)]
pub struct RoomFields {
    code: Option<String>,
    name: Option<String>,
    shape: Option<Value>,
    color: Option<String>,
    contact_name: Option<String>,
    contact_phone: Option<String>,
    contact_email: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    responsible_user_id: Option<Option<i64>>,
    notes: Option<String>,
}

pub async fn create_room(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(floor_id): Path<i64>,
    JsonBody(body): JsonBody<RoomFields>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let mut tx = state.pool.begin().await?;
    let parent = hierarchy::get(&mut tx, ScopeType::Floor, floor_id).await?;
    require(&current, Action::Write, &parent.chain)?;
    let code = code_or_400(body.code.as_deref().unwrap_or(""))?;
    if code == "DEFAULT" {
        return Err(AppError::bad(
            "DEFAULT is reserved for the floor's automatic room",
        ));
    }
    let shape = body.shape.as_ref().map(validate_shape).transpose()?;
    let name = clean_text(body.name);
    check_len("Name", &name, 255)?;
    let responsible = body.responsible_user_id.flatten();
    check_user_exists(&mut tx, responsible).await?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO rooms (floor_id, code, name, shape, color, contact_name, contact_phone, contact_email,
         responsible_user_id, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(floor_id)
    .bind(&code)
    .bind(&name)
    .bind(shape.as_ref().map(Value::to_string))
    .bind(clean_text(body.color))
    .bind(clean_text(body.contact_name))
    .bind(phone(clean_text(body.contact_phone)))
    .bind(clean_text(body.contact_email))
    .bind(responsible)
    .bind(clean_text(body.notes))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    hierarchy::reindex(&mut tx, Subtree::Room(id)).await?;
    let path = hierarchy::get(&mut tx, ScopeType::Room, id).await?.path;
    audit::record(
        &mut tx,
        &ctx,
        actor(&current),
        Entry::new("create", "room", Some(id))
            .path(path.clone())
            .project(Some(parent.project_id))
            .changes(json!({ "code": code, "name": name })),
    )
    .await?;
    let mut v = load_room(&mut tx, id).await?.into_json();
    tx.commit().await?;
    v["path"] = json!(path);
    Ok((StatusCode::CREATED, Json(v)))
}

pub async fn get_room(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Room, id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let mut v = load_room(&mut conn, id).await?.into_json();
    v["path"] = json!(placed.path);
    v["racks"] = json!(super::racks::racks_where(&mut conn, "room", id).await?);
    v["devices"] = json!(super::devices::room_devices(&mut conn, id).await?);
    v["can_edit"] = json!(current.principal.can(Action::Write, &placed.chain));
    Ok(Json(v))
}

pub async fn update_room(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<RoomFields>,
) -> AppResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Room, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let old = load_room(&mut tx, id).await?;
    if old.is_default && (body.code.is_some() || body.shape.is_some()) {
        return Err(AppError::bad(
            "The DEFAULT room's code and shape can't be changed",
        ));
    }
    let code = match &body.code {
        Some(c) => {
            let c = code_or_400(c)?;
            if c == "DEFAULT" {
                return Err(AppError::bad(
                    "DEFAULT is reserved for the floor's automatic room",
                ));
            }
            // Floor devices and racks share the room's namespace, so a room
            // code doesn't clash with them; only sibling rooms matter (index).
            c
        }
        None => old.code.clone(),
    };
    let shape = match &body.shape {
        Some(Value::Null) => None,
        Some(s) => Some(validate_shape(s)?),
        None => old.shape.clone(),
    };
    let responsible = super::apply_nullable(body.responsible_user_id, old.responsible_user_id);
    check_user_exists(&mut tx, responsible).await?;
    let name = merge_text(body.name, old.name.clone());
    check_len("Name", &name, 255)?;
    sqlx::query(
        "UPDATE rooms SET code = ?, name = ?, shape = ?, color = ?, contact_name = ?, contact_phone = ?, contact_email = ?,
         responsible_user_id = ?, notes = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&code)
    .bind(&name)
    .bind(shape.as_ref().map(Value::to_string))
    .bind(merge_text(body.color, old.color.clone()))
    .bind(merge_text(body.contact_name, old.contact_name.clone()))
    .bind(phone(merge_text(body.contact_phone, old.contact_phone.clone())))
    .bind(merge_text(body.contact_email, old.contact_email.clone()))
    .bind(responsible)
    .bind(merge_text(body.notes, old.notes.clone()))
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    hierarchy::reindex(&mut tx, Subtree::Room(id)).await?;
    let new = load_room(&mut tx, id).await?;
    let path = hierarchy::get(&mut tx, ScopeType::Room, id).await?.path;
    let mut changes = audit::diff(
        &serde_json::to_value(&old).unwrap_or_default(),
        &serde_json::to_value(&new).unwrap_or_default(),
        &[],
    );
    if let Some(o) = changes.as_object_mut() {
        o.remove("updated_at");
    }
    audit::record(
        &mut tx,
        &ctx,
        actor(&current),
        Entry::new("update", "room", Some(id))
            .path(path.clone())
            .project(Some(placed.project_id))
            .changes(changes),
    )
    .await?;
    tx.commit().await?;
    let mut v = new.into_json();
    v["path"] = json!(path);
    Ok(Json(v))
}

pub async fn delete_room(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    body: axum::body::Bytes,
) -> AppResult<StatusCode> {
    let body: DeleteBody = super::optional_body(&body)?;
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Room, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let room = load_room(&mut tx, id).await?;
    if room.is_default {
        return Err(AppError::Conflict(
            "The DEFAULT room can't be deleted".into(),
        ));
    }
    confirm(&body, &room.code)?;
    let (count, moved) =
        hierarchy::clear_contents(&mut tx, Subtree::Room(id), body.devices).await?;
    sqlx::query("DELETE FROM rooms WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    hierarchy::drop_subtree(&mut tx, Subtree::Room(id)).await?;
    audit_unplaced(&mut tx, &ctx, &current, placed.project_id, &moved).await?;
    audit::record(
        &mut tx,
        &ctx,
        actor(&current),
        Entry::new("delete", "room", Some(id))
            .path(placed.path)
            .project(Some(placed.project_id))
            .changes(json!({ "devices": count, "devices_action": body.devices })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
