//! Projects: the isolation boundary ("tenant"). In phase 1 they carry only a
//! code, name and description; locations and everything below arrive in
//! phase 2.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;

use super::{require, require_account_admin, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::naming::normalize_code;
use crate::domain::permissions::{Action, Chain};
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

#[derive(FromRow, Serialize, Clone)]
pub struct Project {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

macro_rules! project_columns {
    () => {
        "id, code, name, description, created_at, updated_at"
    };
}

async fn load(state: &AppState, id: i64) -> AppResult<Option<Project>> {
    Ok(sqlx::query_as::<_, Project>(concat!(
        "SELECT ",
        project_columns!(),
        " FROM projects WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?)
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 255 {
        return Err(AppError::bad("Name must be 1 to 255 characters"));
    }
    Ok(name.to_string())
}

pub async fn list(
    State(state): State<AppState>,
    current: CurrentUser,
) -> AppResult<Json<Vec<Project>>> {
    let filter = current.principal.readable_projects();
    let rows = sqlx::query_as::<_, Project>(concat!(
        "SELECT ",
        project_columns!(),
        " FROM projects ORDER BY name"
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter().filter(|p| filter.allows(p.id)).collect(),
    ))
}

pub async fn get_one(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Project>> {
    require(&current, Action::Read, &Chain::project(id))?;
    Ok(Json(load(&state, id).await?.ok_or(AppError::NotFound)?))
}

#[derive(Deserialize)]
pub struct CreateProject {
    code: String,
    name: String,
    description: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<CreateProject>,
) -> AppResult<(StatusCode, Json<Project>)> {
    require_account_admin(&current)?;
    let code = normalize_code(&body.code).map_err(AppError::bad)?;
    let name = clean_name(&body.name)?;
    let now = now_ts();
    let mut tx = state.pool.begin().await?;
    let id = sqlx::query("INSERT INTO projects (code, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&code)
        .bind(&name)
        .bind(body.description.as_deref().map(str::trim).filter(|d| !d.is_empty()))
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?
        .last_insert_rowid();
    super::device_types::seed_builtins(&mut tx, id).await?;
    super::ipam::create_default_space(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("create", "project", Some(id))
            .path(code.clone())
            .project(Some(id))
            .changes(json!({ "code": code, "name": name })),
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(load(&state, id).await?.ok_or(AppError::NotFound)?),
    ))
}

#[derive(Deserialize)]
pub struct UpdateProject {
    code: Option<String>,
    name: Option<String>,
    description: Option<String>,
}

pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<UpdateProject>,
) -> AppResult<Json<Project>> {
    require(&current, Action::Manage, &Chain::project(id))?;
    let old = load(&state, id).await?.ok_or(AppError::NotFound)?;
    let code = match body.code {
        Some(c) => normalize_code(&c).map_err(AppError::bad)?,
        None => old.code.clone(),
    };
    let name = match body.name {
        Some(n) => clean_name(&n)?,
        None => old.name.clone(),
    };
    let description = match body.description {
        Some(d) => Some(d.trim().to_string()).filter(|d| !d.is_empty()),
        None => old.description.clone(),
    };
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE projects SET code = ?, name = ?, description = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&code)
    .bind(&name)
    .bind(&description)
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if code != old.code {
        // Every full path in the project starts with its code.
        crate::hierarchy::reindex(&mut tx, crate::hierarchy::Subtree::Project(id)).await?;
    }
    let changes = audit::diff(
        &json!({ "code": old.code, "name": old.name, "description": old.description }),
        &json!({ "code": code, "name": name, "description": description }),
        &[],
    );
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("update", "project", Some(id))
            .path(code.clone())
            .project(Some(id))
            .changes(changes),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(load(&state, id).await?.ok_or(AppError::NotFound)?))
}

#[derive(Deserialize)]
pub struct DeleteProject {
    /// Must match the project's code, to prevent accidental deletion.
    confirm_code: String,
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<DeleteProject>,
) -> AppResult<StatusCode> {
    require_account_admin(&current)?;
    let project = load(&state, id).await?.ok_or(AppError::NotFound)?;
    if !body.confirm_code.trim().eq_ignore_ascii_case(&project.code) {
        return Err(AppError::bad("Type the project's code to confirm deletion"));
    }
    let mut tx = state.pool.begin().await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("delete", "project", Some(id))
            .path(project.code.clone())
            .project(Some(id)),
    )
    .await?;
    // Grants inside the project are removed by their foreign key.
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
