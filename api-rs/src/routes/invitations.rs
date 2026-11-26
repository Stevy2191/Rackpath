//! Invitations. An admin creates one with the grants the new user should
//! get (each within the admin's own scope) and sends the link however they
//! like; Rackpath sends no email. The link works once, for 7 days, and is
//! stored only as a hash. When accepted, the grants are checked again
//! against the inviter's current rights.

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::FromRow;
use time::Duration;

use super::users::{parse_grant, GrantBody};
use super::{resolve_scope, JsonBody, UserView};
use crate::audit::{self, Entry};
use crate::auth::{create_session, load_principal, load_user, session_cookie, CurrentUser};
use crate::domain::password;
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::{now_ts, random_token, sha256_hex, ts_in};

const VALID_FOR: Duration = Duration::days(7);
const MAX_ACCEPT_FAILURES_PER_IP: usize = 20;

#[derive(Deserialize)]
pub struct CreateInvitation {
    email: Option<String>,
    note: Option<String>,
    grants: Vec<GrantBody>,
}

fn link(state: &AppState, token: &str) -> Option<String> {
    state
        .config
        .public_url
        .as_ref()
        .map(|base| format!("{base}/invite/{token}"))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<CreateInvitation>,
) -> AppResult<(StatusCode, Json<Value>)> {
    if !current.principal.is_any_admin() {
        return Err(AppError::forbidden("Only administrators can invite users"));
    }
    if body.grants.is_empty() {
        return Err(AppError::bad("An invitation needs at least one grant"));
    }
    let mut tx = state.pool.begin().await?;
    let mut stored = Vec::new();
    for g in &body.grants {
        let (role, scope_type) = parse_grant(g)?;
        let scope = resolve_scope(&mut tx, scope_type, g.scope_id).await?;
        if !current.principal.can_grant(role, &scope.chain) {
            return Err(AppError::forbidden(
                "You can't grant one of those roles at that scope",
            ));
        }
        stored.push(json!({ "role": role.as_str(), "scope_type": scope_type.as_str(), "scope_id": g.scope_id }));
    }
    let token = random_token();
    let expires_at = ts_in(VALID_FOR);
    let email = body
        .email
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty());
    let id = sqlx::query(
        "INSERT INTO invitations (email, note, grants, token_hash, invited_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&email)
    .bind(body.note.as_deref().map(str::trim))
    .bind(Value::Array(stored.clone()).to_string())
    .bind(sha256_hex(&token))
    .bind(current.user.id)
    .bind(now_ts())
    .bind(&expires_at)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("create", "invitation", Some(id))
            .changes(json!({ "email": email, "grants": stored })),
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": id,
            "token": token,
            "url": link(&state, &token),
            "expires_at": expires_at,
        })),
    ))
}

#[derive(FromRow, serde::Serialize)]
pub struct InvitationView {
    id: i64,
    email: Option<String>,
    note: Option<String>,
    #[sqlx(json)]
    grants: Value,
    invited_by: Option<i64>,
    created_at: String,
    expires_at: String,
}

/// Pending invitations: all of them for account admins, otherwise the ones
/// you created.
pub async fn list(
    State(state): State<AppState>,
    current: CurrentUser,
) -> AppResult<Json<Vec<InvitationView>>> {
    if !current.principal.is_any_admin() {
        return Err(AppError::forbidden(
            "Only administrators can see invitations",
        ));
    }
    let all = current.principal.is_account_admin();
    let rows = sqlx::query_as::<_, InvitationView>(
        "SELECT id, email, note, grants, invited_by, created_at, expires_at FROM invitations
         WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND (? OR invited_by = ?)
         ORDER BY created_at DESC",
    )
    .bind(now_ts())
    .bind(all)
    .bind(current.user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

async fn owned_pending(state: &AppState, current: &CurrentUser, id: i64) -> AppResult<()> {
    let row: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT invited_by FROM invitations WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let (invited_by,) = row.ok_or(AppError::NotFound)?;
    if invited_by != Some(current.user.id) && !current.principal.is_account_admin() {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn revoke(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    owned_pending(&state, &current, id).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE invitations SET revoked_at = ? WHERE id = ?")
        .bind(now_ts())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("delete", "invitation", Some(id)),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A new link for the same invitation; the old link stops working.
pub async fn reissue(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    owned_pending(&state, &current, id).await?;
    let token = random_token();
    let expires_at = ts_in(VALID_FOR);
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE invitations SET token_hash = ?, expires_at = ? WHERE id = ?")
        .bind(sha256_hex(&token))
        .bind(&expires_at)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("update", "invitation", Some(id)).changes(json!({ "link": "reissued" })),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({ "id": id, "token": token, "url": link(&state, &token), "expires_at": expires_at }),
    ))
}

#[derive(FromRow)]
struct PendingInvitation {
    id: i64,
    email: Option<String>,
    grants: String,
    invited_by: Option<i64>,
    expires_at: String,
}

async fn find_valid(state: &AppState, token: &str) -> AppResult<PendingInvitation> {
    sqlx::query_as::<_, PendingInvitation>(
        "SELECT id, email, grants, invited_by, expires_at FROM invitations
         WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
    )
    .bind(sha256_hex(token))
    .bind(now_ts())
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)
}

fn check_accept_rate(state: &AppState, ctx: &RequestCtx) -> AppResult<String> {
    let key = format!("invite:ip:{}", ctx.ip.as_deref().unwrap_or("unknown"));
    let wait = state
        .limiter
        .retry_after(&[(&key, MAX_ACCEPT_FAILURES_PER_IP)]);
    if wait > 0 {
        return Err(AppError::TooManyRequests {
            retry_after_secs: wait,
        });
    }
    Ok(key)
}

/// Public: what the invitation page shows before the person signs up.
pub async fn preview(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    Path(token): Path<String>,
) -> AppResult<Json<Value>> {
    let key = check_accept_rate(&state, &ctx)?;
    let invitation = match find_valid(&state, &token).await {
        Ok(i) => i,
        Err(e) => {
            state.limiter.record_failure(&[&key]);
            return Err(e);
        }
    };
    let inviter: Option<String> = match invitation.invited_by {
        Some(id) => {
            sqlx::query_scalar("SELECT COALESCE(display_name, username) FROM users WHERE id = ?")
                .bind(id)
                .fetch_optional(&state.pool)
                .await?
        }
        None => None,
    };
    Ok(Json(
        json!({ "email": invitation.email, "invited_by": inviter, "expires_at": invitation.expires_at }),
    ))
}

#[derive(Deserialize)]
pub struct AcceptBody {
    username: String,
    password: String,
    display_name: Option<String>,
    email: Option<String>,
}

/// Public: creates the account, applies the grants and signs the person in.
pub async fn accept(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    Path(token): Path<String>,
    JsonBody(body): JsonBody<AcceptBody>,
) -> AppResult<Response> {
    let key = check_accept_rate(&state, &ctx)?;
    let invitation = match find_valid(&state, &token).await {
        Ok(i) => i,
        Err(e) => {
            state.limiter.record_failure(&[&key]);
            return Err(e);
        }
    };
    let username = body.username.trim().to_string();
    if username.is_empty()
        || username.len() > 64
        || !username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@'))
    {
        return Err(AppError::bad(
            "Username may only contain letters, digits, '.', '_', '-' and '@'",
        ));
    }
    password::validate_new(&body.password).map_err(AppError::bad)?;
    if body.password.eq_ignore_ascii_case(&username) {
        return Err(AppError::bad("The password can't be your username"));
    }

    let mut tx = state.pool.begin().await?;
    // The inviter must still be allowed to give every grant.
    let inviter_id = invitation
        .invited_by
        .ok_or_else(|| AppError::forbidden("This invitation is no longer valid"))?;
    let inviter = load_user(&mut tx, inviter_id)
        .await?
        .filter(|u| u.disabled_at.is_none())
        .ok_or_else(|| AppError::forbidden("This invitation is no longer valid"))?;
    let inviter_principal = load_principal(&mut tx, &inviter).await?;
    let grants: Vec<GrantBody> = serde_json::from_str::<Vec<Value>>(&invitation.grants)
        .map_err(AppError::internal)?
        .into_iter()
        .map(|g| GrantBody {
            role: g["role"].as_str().unwrap_or_default().to_string(),
            scope_type: g["scope_type"].as_str().unwrap_or_default().to_string(),
            scope_id: g["scope_id"].as_i64(),
        })
        .collect();
    let mut resolved = Vec::new();
    for g in &grants {
        let (role, scope_type) = parse_grant(g)?;
        let scope = resolve_scope(&mut tx, scope_type, g.scope_id).await?;
        if !inviter_principal.can_grant(role, &scope.chain) {
            return Err(AppError::forbidden("This invitation is no longer valid"));
        }
        resolved.push((role, scope_type, g.scope_id, scope));
    }

    let now = now_ts();
    let email = body
        .email
        .or(invitation.email)
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty());
    let user_id = sqlx::query(
        "INSERT INTO users (username, email, display_name, password_hash, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(&username)
    .bind(&email)
    .bind(body.display_name.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()))
    .bind(password::hash(&body.password))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    for (role, scope_type, scope_id, scope) in &resolved {
        sqlx::query(
            "INSERT INTO role_grants (user_id, role, scope_type, scope_id, project_id, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(user_id)
        .bind(role.as_str())
        .bind(scope_type.as_str())
        .bind(scope_id)
        .bind(scope.project_id)
        .bind(inviter_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        audit::record(
            &mut tx,
            &ctx,
            Some((inviter_id, &inviter.username)),
            Entry::new("grant", "user", Some(user_id))
                .path(username.clone())
                .project(scope.project_id)
                .changes(
                    json!({ "role": role.as_str(), "scope": scope.path, "via": "invitation" }),
                ),
        )
        .await?;
    }
    sqlx::query("UPDATE invitations SET accepted_at = ?, accepted_user_id = ? WHERE id = ?")
        .bind(&now)
        .bind(user_id)
        .bind(invitation.id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((user_id, &username)),
        Entry::new("create", "user", Some(user_id))
            .path(username.clone())
            .changes(json!({ "username": username, "invitation_id": invitation.id })),
    )
    .await?;
    let session = create_session(&mut tx, user_id, true, &ctx).await?;
    tx.commit().await?;
    state.limiter.clear(&key);

    let user = {
        let mut conn = state.pool.acquire().await?;
        load_user(&mut conn, user_id)
            .await?
            .ok_or(AppError::NotFound)?
    };
    let mut response = (
        StatusCode::CREATED,
        Json(json!({ "user": UserView::from(&user) })),
    )
        .into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        session_cookie(&session, state.config.cookie_secure),
    );
    Ok(response)
}
