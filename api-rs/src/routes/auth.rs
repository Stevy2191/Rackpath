//! Sign-in, two-factor login, password changes and the user's own sessions.

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::FromRow;

use super::{JsonBody, UserView};
use crate::audit::{self, Entry, REDACTED};
use crate::auth::{
    account_requires_2fa, clear_cookie, create_session, grants_for, rotate_session, session_cookie,
    CurrentUser, UserRow,
};
use crate::domain::{password, totp};
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

const MAX_FAILURES_PER_USERNAME: usize = 10;
const MAX_FAILURES_PER_IP: usize = 50;
const MAX_MFA_FAILURES: usize = 10;

fn with_cookie(mut response: Response, cookie: axum::http::HeaderValue) -> Response {
    response.headers_mut().append(header::SET_COOKIE, cookie);
    response
}

#[derive(Deserialize)]
pub struct LoginBody {
    username: String,
    password: String,
}

pub async fn login(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    JsonBody(body): JsonBody<LoginBody>,
) -> AppResult<Response> {
    let username = body.username.trim().to_string();
    if username.is_empty() || body.password.is_empty() {
        return Err(AppError::bad("username and password are required"));
    }
    let user_key = format!("login:u:{}", username.to_lowercase());
    let ip_key = format!("login:ip:{}", ctx.ip.as_deref().unwrap_or("unknown"));
    let wait = state.limiter.retry_after(&[
        (&user_key, MAX_FAILURES_PER_USERNAME),
        (&ip_key, MAX_FAILURES_PER_IP),
    ]);
    if wait > 0 {
        return Err(AppError::TooManyRequests {
            retry_after_secs: wait,
        });
    }

    let mut tx = state.pool.begin().await?;
    let user = sqlx::query_as::<_, UserRow>(concat!(
        "SELECT ",
        crate::user_columns!(),
        " FROM users WHERE username = ?"
    ))
    .bind(&username)
    .fetch_optional(&mut *tx)
    .await?;

    let verified = match &user {
        Some(u) => crate::passwords::verify(&body.password, &u.password_hash).await,
        None => {
            crate::passwords::verify_dummy(&body.password).await;
            password::Verified {
                ok: false,
                needs_rehash: false,
            }
        }
    };
    let user = match user {
        Some(u) if verified.ok && u.disabled_at.is_none() => u,
        other => {
            state.limiter.record_failure(&[&user_key, &ip_key]);
            let actor = other.as_ref().map(|u| (u.id, u.username.as_str()));
            audit::record(
                &mut tx,
                &ctx,
                actor,
                Entry::new("login_failed", "user", other.as_ref().map(|u| u.id))
                    .changes(json!({ "username": username })),
            )
            .await?;
            tx.commit().await?;
            return Err(AppError::InvalidCredentials);
        }
    };
    state.limiter.clear(&user_key);

    if verified.needs_rehash {
        sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
            .bind(crate::passwords::hash(&body.password).await?)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE users SET last_login_at = ? WHERE id = ?")
        .bind(now_ts())
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    let token = create_session(&mut tx, user.id, !user.totp_enabled, &ctx).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((user.id, &user.username)),
        Entry::new("login", "user", Some(user.id)),
    )
    .await?;
    tx.commit().await?;

    let body = json!({ "user": UserView::from(&user), "mfa_required": user.totp_enabled });
    Ok(with_cookie(
        Json(body).into_response(),
        session_cookie(&token, state.config.cookie_secure),
    ))
}

#[derive(Deserialize)]
pub struct MfaBody {
    code: Option<String>,
    recovery_code: Option<String>,
}

/// Checks a TOTP or recovery code for `user`, recording the use. Shared by
/// sign-in and by the actions that need a fresh second factor.
async fn check_second_factor(
    state: &AppState,
    tx: &mut sqlx::SqliteConnection,
    user: &UserRow,
    code: Option<&str>,
    recovery_code: Option<&str>,
) -> AppResult<bool> {
    let key = format!("mfa:user:{}", user.id);
    let wait = state.limiter.retry_after(&[(&key, MAX_MFA_FAILURES)]);
    if wait > 0 {
        return Err(AppError::TooManyRequests {
            retry_after_secs: wait,
        });
    }
    let ok = if let Some(code) = code {
        let secret = user
            .totp_secret
            .as_deref()
            .ok_or_else(|| AppError::bad("Two-factor login is not enabled"))
            .and_then(|s| state.secrets.decrypt(s).map_err(AppError::internal))?;
        let secret = data_encoding::BASE32_NOPAD
            .decode(secret.as_bytes())
            .map_err(AppError::internal)?;
        let now = time::OffsetDateTime::now_utc().unix_timestamp() as u64;
        match totp::verify(&secret, code, now, user.totp_last_step) {
            Some(step) => {
                sqlx::query("UPDATE users SET totp_last_step = ? WHERE id = ?")
                    .bind(step)
                    .bind(user.id)
                    .execute(&mut *tx)
                    .await?;
                true
            }
            None => false,
        }
    } else if let Some(recovery) = recovery_code {
        let result = sqlx::query("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
            .bind(now_ts())
            .bind(user.id)
            .bind(totp::hash_recovery_code(recovery))
            .execute(&mut *tx)
            .await?;
        result.rows_affected() == 1
    } else {
        return Err(AppError::bad("code or recovery_code is required"));
    };
    if ok {
        state.limiter.clear(&key);
    } else {
        state.limiter.record_failure(&[&key]);
    }
    Ok(ok)
}

pub async fn mfa(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<MfaBody>,
) -> AppResult<Response> {
    if !current.mfa_pending {
        return Err(AppError::bad(
            "No two-factor code is needed for this session",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let ok = check_second_factor(
        &state,
        &mut tx,
        &current.user,
        body.code.as_deref(),
        body.recovery_code.as_deref(),
    )
    .await?;
    let actor = Some((current.user.id, current.user.username.as_str()));
    if !ok {
        audit::record(
            &mut tx,
            &ctx,
            actor,
            Entry::new("login_failed", "user", Some(current.user.id))
                .changes(json!({ "step": "two_factor" })),
        )
        .await?;
        tx.commit().await?;
        return Err(AppError::Unauthorized);
    }
    sqlx::query("UPDATE sessions SET mfa_passed = 1 WHERE id = ?")
        .bind(current.session_id)
        .execute(&mut *tx)
        .await?;
    let token = rotate_session(&mut tx, current.session_id).await?;
    let used_recovery = body.code.is_none();
    audit::record(
        &mut tx,
        &ctx,
        actor,
        Entry::new("login", "user", Some(current.user.id))
            .changes(json!({ "step": "two_factor", "recovery_code_used": used_recovery })),
    )
    .await?;
    tx.commit().await?;
    Ok(with_cookie(
        Json(json!({ "ok": true })).into_response(),
        session_cookie(&token, state.config.cookie_secure),
    ))
}

pub async fn logout(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
) -> AppResult<Response> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(current.session_id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("logout", "user", Some(current.user.id)),
    )
    .await?;
    tx.commit().await?;
    Ok(with_cookie(
        StatusCode::NO_CONTENT.into_response(),
        clear_cookie(state.config.cookie_secure),
    ))
}

pub async fn me(State(state): State<AppState>, current: CurrentUser) -> AppResult<Json<Value>> {
    // Until the second factor is entered, reveal only that it is needed.
    if current.mfa_pending {
        return Ok(Json(json!({
            "user": { "username": current.user.username },
            "mfa_pending": true,
        })));
    }
    let mut conn = state.pool.acquire().await?;
    let grants = grants_for(&mut conn, current.user.id).await?;
    let require_2fa = account_requires_2fa(&mut conn).await?;
    let unused_recovery_codes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
    )
    .bind(current.user.id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Json(json!({
        "user": UserView::from(&current.user),
        "mfa_pending": current.mfa_pending,
        "account_requires_2fa": require_2fa,
        "unused_recovery_codes": unused_recovery_codes,
        "is_account_admin": current.principal.is_account_admin(),
        "grants": grants,
    })))
}

#[derive(Deserialize)]
pub struct ChangePasswordBody {
    current_password: String,
    new_password: String,
}

pub async fn change_password(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<ChangePasswordBody>,
) -> AppResult<Response> {
    password::validate_new(&body.new_password).map_err(AppError::bad)?;
    if body.new_password == body.current_password {
        return Err(AppError::bad(
            "The new password must be different from the current one",
        ));
    }
    if body
        .new_password
        .eq_ignore_ascii_case(&current.user.username)
    {
        return Err(AppError::bad("The password can't be your username"));
    }
    if !crate::passwords::verify(&body.current_password, &current.user.password_hash)
        .await
        .ok
    {
        return Err(AppError::forbidden("Current password is incorrect"));
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?",
    )
    .bind(crate::passwords::hash(&body.new_password).await?)
    .bind(now_ts())
    .bind(current.user.id)
    .execute(&mut *tx)
    .await?;
    // Every other session is signed out; this one gets a fresh token.
    sqlx::query("DELETE FROM sessions WHERE user_id = ? AND id <> ?")
        .bind(current.user.id)
        .bind(current.session_id)
        .execute(&mut *tx)
        .await?;
    let token = rotate_session(&mut tx, current.session_id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("update", "user", Some(current.user.id))
            .path(current.user.username.clone())
            .changes(json!({ "password": [REDACTED, REDACTED] })),
    )
    .await?;
    tx.commit().await?;
    Ok(with_cookie(
        StatusCode::NO_CONTENT.into_response(),
        session_cookie(&token, state.config.cookie_secure),
    ))
}

#[derive(Deserialize)]
pub struct PasswordConfirm {
    password: String,
}

pub async fn totp_setup(
    State(state): State<AppState>,
    current: CurrentUser,
    JsonBody(body): JsonBody<PasswordConfirm>,
) -> AppResult<Json<Value>> {
    if current.user.totp_enabled {
        return Err(AppError::Conflict(
            "Two-factor login is already enabled".into(),
        ));
    }
    if !crate::passwords::verify(&body.password, &current.user.password_hash)
        .await
        .ok
    {
        return Err(AppError::forbidden("Password is incorrect"));
    }
    let secret = totp::generate_secret();
    let encoded = totp::secret_base32(&secret);
    sqlx::query("UPDATE users SET totp_pending_secret = ? WHERE id = ?")
        .bind(state.secrets.encrypt(&encoded))
        .bind(current.user.id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({
        "otpauth_url": totp::otpauth_url(&secret, &current.user.username),
        "secret": encoded,
    })))
}

#[derive(Deserialize)]
pub struct CodeBody {
    code: String,
}

async fn replace_recovery_codes(
    tx: &mut sqlx::SqliteConnection,
    user_id: i64,
) -> AppResult<Vec<String>> {
    sqlx::query("DELETE FROM recovery_codes WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    let codes = totp::generate_recovery_codes();
    let now = now_ts();
    for code in &codes {
        sqlx::query("INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)")
            .bind(user_id)
            .bind(totp::hash_recovery_code(code))
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    Ok(codes)
}

pub async fn totp_enable(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<CodeBody>,
) -> AppResult<Json<Value>> {
    if current.user.totp_enabled {
        return Err(AppError::Conflict(
            "Two-factor login is already enabled".into(),
        ));
    }
    let pending = current
        .user
        .totp_pending_secret
        .as_deref()
        .ok_or_else(|| AppError::bad("Start two-factor setup first"))?;
    let encoded = state.secrets.decrypt(pending).map_err(AppError::internal)?;
    let secret = data_encoding::BASE32_NOPAD
        .decode(encoded.as_bytes())
        .map_err(AppError::internal)?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp() as u64;
    let step = totp::verify(&secret, &body.code, now, None).ok_or_else(|| {
        AppError::bad("That code is not correct. Check the time on your phone and try again.")
    })?;

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled = 1,
         totp_last_step = ?, updated_at = ? WHERE id = ?",
    )
    .bind(step)
    .bind(now_ts())
    .bind(current.user.id)
    .execute(&mut *tx)
    .await?;
    // This session proved the second factor; other sessions must now do so.
    sqlx::query("UPDATE sessions SET mfa_passed = 1 WHERE id = ?")
        .bind(current.session_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE sessions SET mfa_passed = 0 WHERE user_id = ? AND id <> ?")
        .bind(current.user.id)
        .bind(current.session_id)
        .execute(&mut *tx)
        .await?;
    let codes = replace_recovery_codes(&mut tx, current.user.id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("update", "user", Some(current.user.id))
            .path(current.user.username.clone())
            .changes(json!({ "totp_enabled": [false, true] })),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "recovery_codes": codes })))
}

#[derive(Deserialize)]
pub struct ConfirmWithSecondFactor {
    password: String,
    code: Option<String>,
    recovery_code: Option<String>,
}

pub async fn totp_disable(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<ConfirmWithSecondFactor>,
) -> AppResult<StatusCode> {
    if !current.user.totp_enabled {
        return Err(AppError::bad("Two-factor login is not enabled"));
    }
    if !crate::passwords::verify(&body.password, &current.user.password_hash)
        .await
        .ok
    {
        return Err(AppError::forbidden("Password is incorrect"));
    }
    let mut tx = state.pool.begin().await?;
    if !check_second_factor(
        &state,
        &mut tx,
        &current.user,
        body.code.as_deref(),
        body.recovery_code.as_deref(),
    )
    .await?
    {
        tx.commit().await?;
        return Err(AppError::forbidden("Two-factor code is incorrect"));
    }
    sqlx::query("UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0, totp_last_step = NULL, updated_at = ? WHERE id = ?")
        .bind(now_ts())
        .bind(current.user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM recovery_codes WHERE user_id = ?")
        .bind(current.user.id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("update", "user", Some(current.user.id))
            .path(current.user.username.clone())
            .changes(json!({ "totp_enabled": [true, false] })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn regenerate_recovery_codes(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<ConfirmWithSecondFactor>,
) -> AppResult<Json<Value>> {
    if !current.user.totp_enabled {
        return Err(AppError::bad("Two-factor login is not enabled"));
    }
    if !crate::passwords::verify(&body.password, &current.user.password_hash)
        .await
        .ok
    {
        return Err(AppError::forbidden("Password is incorrect"));
    }
    let mut tx = state.pool.begin().await?;
    if !check_second_factor(
        &state,
        &mut tx,
        &current.user,
        body.code.as_deref(),
        body.recovery_code.as_deref(),
    )
    .await?
    {
        tx.commit().await?;
        return Err(AppError::forbidden("Two-factor code is incorrect"));
    }
    let codes = replace_recovery_codes(&mut tx, current.user.id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("update", "user", Some(current.user.id))
            .changes(json!({ "recovery_codes": "regenerated" })),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "recovery_codes": codes })))
}

#[derive(FromRow, serde::Serialize)]
pub struct SessionView {
    pub id: i64,
    pub created_at: String,
    pub last_seen_at: String,
    pub expires_at: String,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    #[sqlx(skip)]
    pub current: bool,
}

pub async fn sessions_for(
    conn: &mut sqlx::SqliteConnection,
    user_id: i64,
    current_session: Option<i64>,
) -> AppResult<Vec<SessionView>> {
    let mut rows = sqlx::query_as::<_, SessionView>(
        "SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC",
    )
    .bind(user_id)
    .fetch_all(conn)
    .await?;
    for row in &mut rows {
        row.current = Some(row.id) == current_session;
    }
    Ok(rows)
}

pub async fn list_own_sessions(
    State(state): State<AppState>,
    current: CurrentUser,
) -> AppResult<Json<Vec<SessionView>>> {
    let mut conn = state.pool.acquire().await?;
    Ok(Json(
        sessions_for(&mut conn, current.user.id, Some(current.session_id)).await?,
    ))
}

/// Signs out one session: your own, or anyone's for account admins.
pub async fn revoke_session(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let owner: Option<i64> = sqlx::query_scalar("SELECT user_id FROM sessions WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let owner = owner.ok_or(AppError::NotFound)?;
    if owner != current.user.id {
        if !current.principal.is_account_admin() {
            return Err(AppError::NotFound);
        }
        let owner_is_account_owner: bool =
            sqlx::query_scalar("SELECT is_owner FROM users WHERE id = ?")
                .bind(owner)
                .fetch_one(&mut *tx)
                .await?;
        if owner_is_account_owner && !current.user.is_owner {
            return Err(AppError::forbidden(
                "Only the owner can sign out the owner's sessions",
            ));
        }
    }
    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("delete", "session", Some(id)).changes(json!({ "user_id": owner })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
