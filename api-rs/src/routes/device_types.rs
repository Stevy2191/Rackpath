//! Device types per project: the built-ins (seeded for every project) plus
//! custom ones. Project admins manage them; anyone who can read the project
//! can list them. Changing a prefix only affects devices added afterwards.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, SqliteConnection};

use super::{require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::device_types::{validate_key, validate_prefix, Placement, BUILTINS};
use crate::domain::permissions::{Action, Chain};
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

/// Adds any missing built-in types to a project (idempotent).
pub async fn seed_builtins(conn: &mut SqliteConnection, project_id: i64) -> AppResult<()> {
    let now = now_ts();
    for b in BUILTINS {
        sqlx::query(
            "INSERT OR IGNORE INTO device_types (project_id, key, label, prefix, placement, icon, is_builtin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(project_id)
        .bind(b.key)
        .bind(b.label)
        .bind(b.prefix)
        .bind(b.placement.as_str())
        .bind(b.icon)
        .bind(&now)
        .bind(&now)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Seeds built-ins for every project (run at startup, so projects created
/// before this release, and new built-ins in later releases, are covered).
pub async fn seed_all(pool: &sqlx::SqlitePool) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM projects")
        .fetch_all(&mut *tx)
        .await?;
    for id in ids {
        seed_builtins(&mut tx, id).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(FromRow, Serialize)]
pub struct DeviceType {
    id: i64,
    project_id: i64,
    key: String,
    label: String,
    prefix: String,
    placement: String,
    icon: Option<String>,
    is_builtin: bool,
    device_count: i64,
}

macro_rules! type_select {
    () => {
        "SELECT t.id, t.project_id, t.key, t.label, t.prefix, t.placement, t.icon, t.is_builtin, \
         (SELECT COUNT(*) FROM devices d WHERE d.device_type_id = t.id) AS device_count FROM device_types t "
    };
}

async fn load(conn: &mut SqliteConnection, id: i64) -> AppResult<DeviceType> {
    sqlx::query_as::<_, DeviceType>(concat!(type_select!(), "WHERE t.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn list(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Vec<DeviceType>>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let rows = sqlx::query_as::<_, DeviceType>(concat!(
        type_select!(),
        "WHERE t.project_id = ? ORDER BY t.label"
    ))
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct TypeFields {
    key: Option<String>,
    label: Option<String>,
    prefix: Option<String>,
    placement: Option<String>,
    icon: Option<String>,
}

fn label_ok(label: &str) -> AppResult<String> {
    let l = label.trim();
    if l.is_empty() || l.len() > 80 {
        return Err(AppError::bad("Label must be 1 to 80 characters"));
    }
    Ok(l.to_string())
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<TypeFields>,
) -> AppResult<(StatusCode, Json<DeviceType>)> {
    require(&current, Action::Manage, &Chain::project(project_id))?;
    let key = validate_key(body.key.as_deref().unwrap_or("")).map_err(AppError::bad)?;
    let label = label_ok(body.label.as_deref().unwrap_or(""))?;
    let prefix = validate_prefix(body.prefix.as_deref().unwrap_or("")).map_err(AppError::bad)?;
    let placement = Placement::parse(body.placement.as_deref().unwrap_or("either"))
        .ok_or_else(|| AppError::bad("placement must be floor, rack or either"))?;
    let mut tx = state.pool.begin().await?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO device_types (project_id, key, label, prefix, placement, icon, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(project_id)
    .bind(&key)
    .bind(&label)
    .bind(&prefix)
    .bind(placement.as_str())
    .bind(body.icon.map(|i| i.trim().to_string()).filter(|i| !i.is_empty()))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "device_type", Some(id))
            .project(Some(project_id))
            .changes(json!({ "key": key, "label": label, "prefix": prefix })),
    )
    .await?;
    let t = load(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(t)))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<TypeFields>,
) -> AppResult<Json<DeviceType>> {
    let mut tx = state.pool.begin().await?;
    let old = load(&mut tx, id).await?;
    require(&current, Action::Manage, &Chain::project(old.project_id))?;
    if body.key.is_some() {
        return Err(AppError::bad("A type's key can't be changed"));
    }
    let placement = match &body.placement {
        Some(p) => {
            let p = Placement::parse(p)
                .ok_or_else(|| AppError::bad("placement must be floor, rack or either"))?;
            if old.is_builtin && p.as_str() != old.placement {
                return Err(AppError::bad(
                    "A built-in type's placement can't be changed",
                ));
            }
            if old.device_count > 0 && p.as_str() != old.placement {
                return Err(AppError::Conflict(
                    "Placement can't change while devices use this type".into(),
                ));
            }
            p.as_str().to_string()
        }
        None => old.placement.clone(),
    };
    let label = match &body.label {
        Some(l) => label_ok(l)?,
        None => old.label.clone(),
    };
    let prefix = match &body.prefix {
        Some(p) => validate_prefix(p).map_err(AppError::bad)?,
        None => old.prefix.clone(),
    };
    let icon = match body.icon {
        Some(i) => Some(i.trim().to_string()).filter(|i| !i.is_empty()),
        None => old.icon.clone(),
    };
    sqlx::query("UPDATE device_types SET label = ?, prefix = ?, placement = ?, icon = ?, updated_at = ? WHERE id = ?")
        .bind(&label)
        .bind(&prefix)
        .bind(&placement)
        .bind(&icon)
        .bind(now_ts())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let new = load(&mut tx, id).await?;
    let changes = audit::diff(
        &json!({ "label": old.label, "prefix": old.prefix, "placement": old.placement, "icon": old.icon }),
        &json!({ "label": new.label, "prefix": new.prefix, "placement": new.placement, "icon": new.icon }),
        &[],
    );
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "device_type", Some(id))
            .project(Some(old.project_id))
            .changes(changes),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(new))
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let t = load(&mut tx, id).await?;
    require(&current, Action::Manage, &Chain::project(t.project_id))?;
    if t.is_builtin {
        return Err(AppError::bad("Built-in types can't be deleted"));
    }
    if t.device_count > 0 {
        return Err(AppError::Conflict(format!(
            "{} device(s) still use this type",
            t.device_count
        )));
    }
    let templates: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM device_templates WHERE project_id = ? AND device_type_key = ?",
    )
    .bind(t.project_id)
    .bind(&t.key)
    .fetch_one(&mut *tx)
    .await?;
    if templates > 0 {
        return Err(AppError::Conflict(format!(
            "{templates} template(s) still use this type"
        )));
    }
    sqlx::query("DELETE FROM device_types WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "device_type", Some(id))
            .project(Some(t.project_id))
            .changes(json!({ "key": t.key })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
