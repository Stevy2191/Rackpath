//! User administration and role grants.
//!
//! * Any admin (at any scope) can list users, so they can grant them access.
//! * Creating, disabling, deleting users and resetting their passwords or
//!   two-factor login is for account admins.
//! * Grants can be given or taken away by admins covering the grant's scope.
//! * The owner can't be disabled, deleted or reset except by the owner.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::auth::{sessions_for, SessionView};
use super::{require_account_admin, resolve_scope, JsonBody, UserView};
use crate::audit::{self, Entry, REDACTED};
use crate::auth::{grants_for, load_user, CurrentUser, GrantView, UserRow};
use crate::domain::password;
use crate::domain::permissions::{Role, ScopeType};
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::{now_ts, random_password};

fn validate_username(username: &str) -> AppResult<String> {
    let u = username.trim();
    if u.is_empty() || u.len() > 64 {
        return Err(AppError::bad("Username must be 1 to 64 characters"));
    }
    if !u
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@'))
    {
        return Err(AppError::bad(
            "Username may only contain letters, digits, '.', '_', '-' and '@'",
        ));
    }
    Ok(u.to_string())
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn validate_email(email: &Option<String>) -> AppResult<()> {
    if let Some(e) = email {
        if e.len() > 254 || !e.contains('@') || e.starts_with('@') || e.ends_with('@') {
            return Err(AppError::bad("Email address is not valid"));
        }
    }
    Ok(())
}

async fn target_user(state: &AppState, id: i64) -> AppResult<UserRow> {
    let mut conn = state.pool.acquire().await?;
    load_user(&mut conn, id).await?.ok_or(AppError::NotFound)
}

/// Owner accounts can only be changed by the owner.
fn guard_owner(current: &CurrentUser, target: &UserRow) -> AppResult<()> {
    if target.is_owner && !current.user.is_owner {
        return Err(AppError::forbidden(
            "Only the owner can change the owner's account",
        ));
    }
    Ok(())
}

pub async fn list(
    State(state): State<AppState>,
    current: CurrentUser,
) -> AppResult<Json<Vec<Value>>> {
    if !current.principal.is_any_admin() {
        return Err(AppError::forbidden("Only administrators can list users"));
    }
    let mut conn = state.pool.acquire().await?;
    let users = sqlx::query_as::<_, UserRow>(concat!(
        "SELECT ",
        crate::user_columns!(),
        " FROM users ORDER BY username"
    ))
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(users.len());
    for u in &users {
        let grants = grants_for(&mut conn, u.id).await?;
        out.push(json!({ "user": UserView::from(u), "grants": grants }));
    }
    Ok(Json(out))
}

pub async fn get_one(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    if id != current.user.id && !current.principal.is_any_admin() {
        return Err(AppError::NotFound);
    }
    let user = target_user(&state, id).await?;
    let mut conn = state.pool.acquire().await?;
    let grants = grants_for(&mut conn, id).await?;
    Ok(Json(
        json!({ "user": UserView::from(&user), "grants": grants }),
    ))
}

#[derive(Deserialize)]
pub struct CreateUser {
    username: String,
    display_name: Option<String>,
    email: Option<String>,
    /// Optional; when omitted a random temporary password is generated.
    password: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<CreateUser>,
) -> AppResult<(StatusCode, Json<Value>)> {
    require_account_admin(&current)?;
    let username = validate_username(&body.username)?;
    let email = clean_optional(body.email);
    validate_email(&email)?;
    let (password, generated) = match body.password {
        Some(p) => {
            password::validate_new(&p).map_err(AppError::bad)?;
            (p, false)
        }
        None => (random_password(), true),
    };
    let now = now_ts();
    let mut tx = state.pool.begin().await?;
    let id = sqlx::query(
        "INSERT INTO users (username, email, display_name, password_hash, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&username)
    .bind(&email)
    .bind(clean_optional(body.display_name))
    .bind(crate::passwords::hash(&password).await?)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("create", "user", Some(id))
            .path(username.clone())
            .changes(json!({ "username": username, "email": email })),
    )
    .await?;
    tx.commit().await?;
    let user = target_user(&state, id).await?;
    // The password is shown once; the user must change it at first sign-in.
    let temporary_password = if generated { Some(password) } else { None };
    Ok((
        StatusCode::CREATED,
        Json(json!({ "user": UserView::from(&user), "temporary_password": temporary_password })),
    ))
}

#[derive(Deserialize)]
pub struct UpdateUser {
    display_name: Option<String>,
    email: Option<String>,
    disabled: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<UpdateUser>,
) -> AppResult<Json<Value>> {
    let target = target_user(&state, id).await?;
    let is_self = id == current.user.id;
    if !is_self {
        require_account_admin(&current)?;
        guard_owner(&current, &target)?;
    }
    if body.disabled.is_some() {
        require_account_admin(&current)?;
        if is_self || target.is_owner {
            return Err(AppError::forbidden(
                "You can't disable your own account or the owner's",
            ));
        }
    }
    let email = match body.email {
        Some(e) => {
            let e = clean_optional(Some(e));
            validate_email(&e)?;
            e
        }
        None => target.email.clone(),
    };
    let display_name = match body.display_name {
        Some(d) => clean_optional(Some(d)),
        None => target.display_name.clone(),
    };
    let disabled_at = match body.disabled {
        Some(true) => target.disabled_at.clone().or_else(|| Some(now_ts())),
        Some(false) => None,
        None => target.disabled_at.clone(),
    };

    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE users SET email = ?, display_name = ?, disabled_at = ?, updated_at = ? WHERE id = ?")
        .bind(&email)
        .bind(&display_name)
        .bind(&disabled_at)
        .bind(now_ts())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if disabled_at.is_some() && target.disabled_at.is_none() {
        sqlx::query("DELETE FROM sessions WHERE user_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    let changes = audit::diff(
        &json!({ "email": target.email, "display_name": target.display_name, "disabled": target.disabled_at.is_some() }),
        &json!({ "email": email, "display_name": display_name, "disabled": disabled_at.is_some() }),
        &[],
    );
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("update", "user", Some(id))
            .path(target.username.clone())
            .changes(changes),
    )
    .await?;
    tx.commit().await?;
    let user = target_user(&state, id).await?;
    Ok(Json(json!({ "user": UserView::from(&user) })))
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    require_account_admin(&current)?;
    let target = target_user(&state, id).await?;
    if target.is_owner || id == current.user.id {
        return Err(AppError::forbidden(
            "You can't delete your own account or the owner's",
        ));
    }
    let mut tx = state.pool.begin().await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("delete", "user", Some(id)).path(target.username.clone()),
    )
    .await?;
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn reset_password(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    require_account_admin(&current)?;
    let target = target_user(&state, id).await?;
    guard_owner(&current, &target)?;
    if id == current.user.id {
        return Err(AppError::bad("Use change password for your own account"));
    }
    let temporary = random_password();
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?",
    )
    .bind(crate::passwords::hash(&temporary).await?)
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(&mut tx, &ctx, Some((current.user.id, &current.user.username)),
        Entry::new("update", "user", Some(id)).path(target.username.clone())
            .changes(json!({ "password": [REDACTED, REDACTED], "must_change_password": [target.must_change_password, true] })))
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "temporary_password": temporary })))
}

/// For a user who lost their authenticator and recovery codes.
pub async fn reset_two_factor(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    require_account_admin(&current)?;
    let target = target_user(&state, id).await?;
    guard_owner(&current, &target)?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0, totp_last_step = NULL, updated_at = ? WHERE id = ?")
        .bind(now_ts())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM recovery_codes WHERE user_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("update", "user", Some(id))
            .path(target.username.clone())
            .changes(json!({ "totp_enabled": [target.totp_enabled, false] })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_sessions(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<SessionView>>> {
    if id != current.user.id {
        require_account_admin(&current)?;
    }
    let mut conn = state.pool.acquire().await?;
    Ok(Json(
        sessions_for(&mut conn, id, Some(current.session_id)).await?,
    ))
}

pub async fn revoke_sessions(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    if id != current.user.id {
        require_account_admin(&current)?;
        let target = target_user(&state, id).await?;
        guard_owner(&current, &target)?;
    }
    let mut tx = state.pool.begin().await?;
    let removed = sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("delete", "session", None)
            .changes(json!({ "user_id": id, "sessions": removed })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_grants(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<GrantView>>> {
    if id != current.user.id && !current.principal.is_any_admin() {
        return Err(AppError::NotFound);
    }
    target_user(&state, id).await?;
    let mut conn = state.pool.acquire().await?;
    Ok(Json(grants_for(&mut conn, id).await?))
}

#[derive(Deserialize)]
pub struct GrantBody {
    pub role: String,
    pub scope_type: String,
    pub scope_id: Option<i64>,
}

pub fn parse_grant(body: &GrantBody) -> AppResult<(Role, ScopeType)> {
    let role = Role::parse(&body.role)
        .ok_or_else(|| AppError::bad("role must be reader, editor or admin"))?;
    let scope = ScopeType::parse(&body.scope_type)
        .ok_or_else(|| AppError::bad("scope_type is not valid"))?;
    if role == Role::Reader && !matches!(scope, ScopeType::Account | ScopeType::Project) {
        return Err(AppError::bad(
            "Readers are granted for a whole project (or the account); reading is project-wide",
        ));
    }
    Ok((role, scope))
}

pub async fn add_grant(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<GrantBody>,
) -> AppResult<(StatusCode, Json<Vec<GrantView>>)> {
    let (role, scope_type) = parse_grant(&body)?;
    let target = target_user(&state, id).await?;
    let mut tx = state.pool.begin().await?;
    let scope = resolve_scope(&mut tx, scope_type, body.scope_id).await?;
    if !current.principal.can_grant(role, &scope.chain) {
        return Err(AppError::forbidden(
            "You can't grant that role at that scope",
        ));
    }
    sqlx::query(
        "INSERT INTO role_grants (user_id, role, scope_type, scope_id, project_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(role.as_str())
    .bind(scope_type.as_str())
    .bind(body.scope_id)
    .bind(scope.project_id)
    .bind(current.user.id)
    .bind(now_ts())
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("grant", "user", Some(id))
            .path(target.username.clone())
            .project(scope.project_id)
            .changes(json!({ "role": role.as_str(), "scope": scope.path })),
    )
    .await?;
    tx.commit().await?;
    let mut conn = state.pool.acquire().await?;
    Ok((StatusCode::CREATED, Json(grants_for(&mut conn, id).await?)))
}

pub async fn remove_grant(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path((id, grant_id)): Path<(i64, i64)>,
) -> AppResult<StatusCode> {
    let target = target_user(&state, id).await?;
    let mut tx = state.pool.begin().await?;
    let row: Option<(String, String, Option<i64>)> = sqlx::query_as(
        "SELECT role, scope_type, scope_id FROM role_grants WHERE id = ? AND user_id = ?",
    )
    .bind(grant_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (role, scope_type, scope_id) = row.ok_or(AppError::NotFound)?;
    let (role, scope_type) = parse_grant(&GrantBody {
        role,
        scope_type,
        scope_id,
    })?;
    let scope = resolve_scope(&mut tx, scope_type, scope_id).await?;
    if !current.principal.can_grant(role, &scope.chain) {
        return Err(AppError::forbidden("You can't remove that grant"));
    }
    sqlx::query("DELETE FROM role_grants WHERE id = ?")
        .bind(grant_id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("revoke", "user", Some(id))
            .path(target.username.clone())
            .project(scope.project_id)
            .changes(json!({ "role": role.as_str(), "scope": scope.path })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
