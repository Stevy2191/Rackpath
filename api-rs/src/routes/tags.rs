//! Device tags: project-wide labels with a colour. Managing the tag list
//! needs edit rights on the project; tagging a device needs edit rights on
//! that device.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;

use super::ports::check_color;
use super::{require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::permissions::{Action, Chain, ScopeType};
use crate::error::{AppError, AppResult};
use crate::hierarchy;
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

#[derive(FromRow, Serialize)]
pub struct Tag {
    id: i64,
    project_id: i64,
    name: String,
    color: Option<String>,
    device_count: i64,
}

async fn load(conn: &mut sqlx::SqliteConnection, id: i64) -> AppResult<Tag> {
    sqlx::query_as::<_, Tag>(
        "SELECT id, project_id, name, color, (SELECT COUNT(*) FROM device_tags x WHERE x.tag_id = tags.id) AS device_count
         FROM tags WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

fn clean_name(n: Option<String>) -> AppResult<Option<String>> {
    match n.map(|s| s.trim().to_string()) {
        None => Ok(None),
        Some(s) if s.is_empty() || s.chars().count() > 40 => {
            Err(AppError::bad("A tag name is 1 to 40 characters"))
        }
        Some(s) => Ok(Some(s)),
    }
}

fn unique(e: sqlx::Error, name: &str) -> AppError {
    match &e {
        sqlx::Error::Database(d) if d.is_unique_violation() => {
            AppError::Conflict(format!("The tag {name} already exists"))
        }
        _ => e.into(),
    }
}

pub async fn list(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let tags = sqlx::query_as::<_, Tag>(
        "SELECT id, project_id, name, color, (SELECT COUNT(*) FROM device_tags x WHERE x.tag_id = tags.id) AS device_count
         FROM tags WHERE project_id = ? ORDER BY name COLLATE NOCASE",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        json!({ "tags": tags, "can_edit": current.principal.can(Action::Write, &Chain::project(project_id)) }),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TagFields {
    name: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    color: Option<Option<String>>,
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<TagFields>,
) -> AppResult<(StatusCode, Json<Tag>)> {
    require(&current, Action::Write, &Chain::project(project_id))?;
    let name = clean_name(body.name)?.ok_or_else(|| AppError::bad("name is required"))?;
    let color = check_color(body.color.flatten())?;
    let mut tx = state.pool.begin().await?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO tags (project_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(&name)
    .bind(&color)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| unique(e, &name))?
    .last_insert_rowid();
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "tag", Some(id))
            .path(name.clone())
            .project(Some(project_id))
            .changes(json!({ "color": color })),
    )
    .await?;
    let tag = load(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(tag)))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<TagFields>,
) -> AppResult<Json<Tag>> {
    let mut tx = state.pool.begin().await?;
    let old = load(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(old.project_id))?;
    let name = clean_name(body.name)?.unwrap_or(old.name.clone());
    let color = match body.color {
        None => old.color.clone(),
        Some(c) => check_color(c)?,
    };
    sqlx::query("UPDATE tags SET name = ?, color = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(&color)
        .bind(now_ts())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| unique(e, &name))?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "tag", Some(id))
            .path(name.clone())
            .project(Some(old.project_id))
            .changes(json!({ "name": [old.name, name], "color": [old.color, color] })),
    )
    .await?;
    let tag = load(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(tag))
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let tag = load(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(tag.project_id))?;
    sqlx::query("DELETE FROM tags WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "tag", Some(id))
            .path(tag.name.clone())
            .project(Some(tag.project_id))
            .changes(json!({ "devices_untagged": tag.device_count })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct DeviceTags {
    tag_ids: Vec<i64>,
}

/// Replaces a device's tags.
pub async fn set_device_tags(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(device_id): Path<i64>,
    JsonBody(body): JsonBody<DeviceTags>,
) -> AppResult<Json<Value>> {
    let mut ids = body.tag_ids;
    ids.sort_unstable();
    ids.dedup();
    if ids.len() > 100 {
        return Err(AppError::bad("At most 100 tags per device"));
    }
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Device, device_id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let mut names = Vec::new();
    for t in &ids {
        let name: Option<String> =
            sqlx::query_scalar("SELECT name FROM tags WHERE id = ? AND project_id = ?")
                .bind(t)
                .bind(placed.project_id)
                .fetch_optional(&mut *tx)
                .await?;
        names.push(name.ok_or_else(|| AppError::bad("Tag not found in this project"))?);
    }
    let before: Vec<String> = sqlx::query_scalar(
        "SELECT t.name FROM device_tags x JOIN tags t ON t.id = x.tag_id WHERE x.device_id = ? ORDER BY t.name",
    )
    .bind(device_id)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM device_tags WHERE device_id = ?")
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    for t in &ids {
        sqlx::query("INSERT INTO device_tags (device_id, tag_id) VALUES (?, ?)")
            .bind(device_id)
            .bind(t)
            .execute(&mut *tx)
            .await?;
    }
    names.sort();
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "device", Some(device_id))
            .path(placed.path.clone())
            .project(Some(placed.project_id))
            .changes(json!({ "tags": [before, names] })),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "tags": names })))
}
