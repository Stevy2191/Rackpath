//! Floor plan images (decision D6: a floor plan is an image, with rooms
//! drawn and devices placed on top in its pixel coordinates).
//!
//! `PUT /api/floors/{id}/plan-image` with the image as the body (PNG, JPEG
//! or WebP, up to 15 MB), `GET` to fetch it, `DELETE` to remove it. The
//! file goes to `<data dir>/uploads/floor-plans/` under a random name.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::json;

use super::places::{load_floor, Floor};
use super::require;
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::images::sniff;
use crate::domain::permissions::{Action, ScopeType};
use crate::error::{AppError, AppResult};
use crate::hierarchy;
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::{now_ts, random_token};

const MAX_IMAGE: usize = 15 * 1024 * 1024;

fn dir(state: &AppState) -> std::path::PathBuf {
    state.config.data_dir.join("uploads").join("floor-plans")
}

/// Stored names are generated here, but check anyway before touching disk.
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        && !name.starts_with('.')
}

async fn remove_file(state: &AppState, name: Option<&str>) {
    if let Some(n) = name.filter(|n| safe_name(n)) {
        if let Err(e) = tokio::fs::remove_file(dir(state).join(n)).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error = %e, "couldn't remove an old floor plan image");
            }
        }
    }
}

pub async fn put_image(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    body: Bytes,
) -> AppResult<Json<Floor>> {
    if body.len() > MAX_IMAGE {
        return Err(AppError::bad("The image is larger than 15 MB"));
    }
    let info = sniff(&body).ok_or_else(|| AppError::bad("Upload a PNG, JPEG or WebP image"))?;
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Floor, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    drop(conn);

    let name = format!("{}.{}", &random_token()[..32], info.ext);
    let folder = dir(&state);
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(AppError::internal)?;
    tokio::fs::write(folder.join(&name), &body)
        .await
        .map_err(AppError::internal)?;

    let result: AppResult<(Floor, Option<String>)> = async {
        let mut tx = state.pool.begin().await?;
        let old = load_floor(&mut tx, id).await?;
        sqlx::query("UPDATE floors SET plan_image = ?, plan_image_type = ?, plan_width = ?, plan_height = ?, updated_at = ? WHERE id = ?")
            .bind(&name)
            .bind(info.mime)
            .bind(i64::from(info.width))
            .bind(i64::from(info.height))
            .bind(now_ts())
            .bind(id)
            .execute(&mut *tx)
            .await?;
        audit::record(
            &mut tx,
            &ctx,
            Some(current.actor_ref()),
            Entry::new("update", "floor", Some(id))
                .path(placed.path.clone())
                .project(Some(placed.project_id))
                .changes(json!({ "plan_image": { "type": info.mime, "width": info.width, "height": info.height, "bytes": body.len() } })),
        )
        .await?;
        let new = load_floor(&mut tx, id).await?;
        tx.commit().await?;
        Ok((new, old.plan_image))
    }
    .await;
    match result {
        Ok((floor, old)) => {
            remove_file(&state, old.as_deref()).await;
            Ok(Json(floor))
        }
        Err(e) => {
            remove_file(&state, Some(&name)).await;
            Err(e)
        }
    }
}

pub async fn get_image(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Floor, id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let floor = load_floor(&mut conn, id).await?;
    let (Some(name), Some(mime)) = (
        floor.plan_image.filter(|n| safe_name(n)),
        floor.plan_image_type,
    ) else {
        return Err(AppError::NotFound);
    };
    let bytes = tokio::fs::read(dir(&state).join(&name))
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound
            } else {
                AppError::internal(e)
            }
        })?;
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "private, max-age=300".into()),
        ],
        bytes,
    )
        .into_response())
}

pub async fn delete_image(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Floor, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let old = load_floor(&mut tx, id).await?;
    sqlx::query(
        "UPDATE floors SET plan_image = NULL, plan_image_type = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "floor", Some(id))
            .path(placed.path.clone())
            .project(Some(placed.project_id))
            .changes(json!({ "plan_image": "removed" })),
    )
    .await?;
    tx.commit().await?;
    remove_file(&state, old.plan_image.as_deref()).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes image files no floor refers to any more (floors deleted with
/// their location, for example). Files younger than an hour are left, so an
/// upload in progress is never touched.
pub async fn sweep(pool: &sqlx::SqlitePool, data_dir: &std::path::Path) -> AppResult<usize> {
    let folder = data_dir.join("uploads").join("floor-plans");
    let mut entries = match tokio::fs::read_dir(&folder).await {
        Ok(e) => e,
        Err(_) => return Ok(0),
    };
    let used: std::collections::HashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT plan_image FROM floors WHERE plan_image IS NOT NULL",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let mut removed = 0;
    while let Ok(Some(e)) = entries.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        if used.contains(&name) || !safe_name(&name) {
            continue;
        }
        let old = e
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() > 3600);
        if old && tokio::fs::remove_file(e.path()).await.is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}
