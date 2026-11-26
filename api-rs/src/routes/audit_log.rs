//! Reading the change history. Account-wide readers see everything; others
//! see entries for the projects they can read.

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, QueryBuilder, Sqlite};

use crate::auth::CurrentUser;
use crate::domain::permissions::ProjectFilter;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct Filters {
    project_id: Option<i64>,
    user_id: Option<i64>,
    action: Option<String>,
    resource_type: Option<String>,
    resource_id: Option<i64>,
    from: Option<String>,
    to: Option<String>,
    before_id: Option<i64>,
    limit: Option<i64>,
}

#[derive(FromRow, Serialize)]
pub struct AuditRow {
    id: i64,
    at: String,
    user_id: Option<i64>,
    username: Option<String>,
    project_id: Option<i64>,
    action: String,
    resource_type: String,
    resource_id: Option<i64>,
    resource_path: Option<String>,
    #[sqlx(json(nullable))]
    changes: Option<Value>,
    request_id: Option<String>,
    ip: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    current: CurrentUser,
    Query(f): Query<Filters>,
) -> AppResult<Json<Value>> {
    let limit = f.limit.unwrap_or(100).clamp(1, 500);
    let mut q: QueryBuilder<Sqlite> = QueryBuilder::new(
        "SELECT id, at, user_id, username, project_id, action, resource_type, resource_id, resource_path, changes, request_id, ip
         FROM audit_log WHERE 1 = 1",
    );
    match current.principal.readable_projects() {
        ProjectFilter::All => {}
        ProjectFilter::Only(ids) => {
            if ids.is_empty() {
                return Err(AppError::forbidden(
                    "You don't have access to any change history",
                ));
            }
            q.push(" AND project_id IN (");
            let mut sep = q.separated(", ");
            for id in ids {
                sep.push_bind(id);
            }
            sep.push_unseparated(")");
        }
    }
    if let Some(v) = f.project_id {
        q.push(" AND project_id = ").push_bind(v);
    }
    if let Some(v) = f.user_id {
        q.push(" AND user_id = ").push_bind(v);
    }
    if let Some(v) = f.action {
        q.push(" AND action = ").push_bind(v);
    }
    if let Some(v) = f.resource_type {
        q.push(" AND resource_type = ").push_bind(v);
    }
    if let Some(v) = f.resource_id {
        q.push(" AND resource_id = ").push_bind(v);
    }
    if let Some(v) = f.from {
        q.push(" AND at >= ").push_bind(v);
    }
    if let Some(v) = f.to {
        q.push(" AND at <= ").push_bind(v);
    }
    if let Some(v) = f.before_id {
        q.push(" AND id < ").push_bind(v);
    }
    q.push(" ORDER BY id DESC LIMIT ").push_bind(limit + 1);
    let mut rows: Vec<AuditRow> = q.build_query_as().fetch_all(&state.pool).await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next_before_id = if more {
        rows.last().map(|r| r.id)
    } else {
        None
    };
    Ok(Json(
        serde_json::json!({ "entries": rows, "next_before_id": next_before_id }),
    ))
}
