//! Sessions and the `CurrentUser` extractor.
//!
//! Sessions are server-side rows keyed by the SHA-256 of a 256-bit random
//! token that lives in an HttpOnly, SameSite=Strict cookie. They expire after
//! 12 hours idle or 7 days in total, and can be revoked instantly.

pub mod ratelimit;

use axum::extract::{FromRequestParts, OriginalUri};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use sqlx::{FromRow, SqliteConnection};
use time::{Duration, OffsetDateTime};

use crate::domain::permissions::{Grant, Principal, Role, Scope, ScopeType};
use crate::error::{AppError, AppResult, CodedError};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::{format_ts, now_ts, parse_ts, random_token, sha256_hex, ts_in};

pub const COOKIE_NAME: &str = "rackpath_session";
pub const IDLE_TIMEOUT: Duration = Duration::hours(12);
pub const ABSOLUTE_TIMEOUT: Duration = Duration::days(7);
const LAST_SEEN_RESOLUTION: Duration = Duration::seconds(60);

#[derive(Clone, Debug, FromRow)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub password_hash: String,
    pub must_change_password: bool,
    pub totp_secret: Option<String>,
    pub totp_pending_secret: Option<String>,
    pub totp_enabled: bool,
    pub totp_last_step: Option<i64>,
    pub is_owner: bool,
    pub disabled_at: Option<String>,
    pub last_login_at: Option<String>,
    pub created_at: String,
}

/// The user columns, as a literal so queries stay compile-time strings.
#[macro_export]
macro_rules! user_columns {
    () => {
        "id, username, email, display_name, password_hash, must_change_password, totp_secret, totp_pending_secret, totp_enabled, totp_last_step, is_owner, disabled_at, last_login_at, created_at"
    };
}

pub async fn load_user(conn: &mut SqliteConnection, id: i64) -> AppResult<Option<UserRow>> {
    Ok(sqlx::query_as::<_, UserRow>(concat!(
        "SELECT ",
        user_columns!(),
        " FROM users WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?)
}

#[derive(FromRow)]
struct GrantRow {
    role: String,
    scope_type: String,
    scope_id: Option<i64>,
    project_id: Option<i64>,
}

pub async fn load_principal(conn: &mut SqliteConnection, user: &UserRow) -> AppResult<Principal> {
    let rows = sqlx::query_as::<_, GrantRow>(
        "SELECT role, scope_type, scope_id, project_id FROM role_grants WHERE user_id = ?",
    )
    .bind(user.id)
    .fetch_all(conn)
    .await?;
    let grants = rows
        .into_iter()
        .filter_map(|r| {
            let kind = ScopeType::parse(&r.scope_type)?;
            Some(Grant {
                role: Role::parse(&r.role)?,
                scope: if kind == ScopeType::Account {
                    Scope::ACCOUNT
                } else {
                    Scope::new(kind, r.scope_id?)
                },
                project_id: r.project_id,
            })
        })
        .collect();
    Ok(Principal {
        is_owner: user.is_owner,
        grants,
    })
}

pub async fn create_session(
    conn: &mut SqliteConnection,
    user_id: i64,
    mfa_passed: bool,
    ctx: &RequestCtx,
) -> AppResult<String> {
    let token = random_token();
    let now = now_ts();
    sqlx::query(
        "INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent, mfa_passed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(sha256_hex(&token))
    .bind(&now)
    .bind(&now)
    .bind(ts_in(ABSOLUTE_TIMEOUT))
    .bind(&ctx.ip)
    .bind(&ctx.user_agent)
    .bind(mfa_passed)
    .execute(conn)
    .await?;
    Ok(token)
}

/// Gives a session a new token (after login steps that raise its privilege),
/// so a token seen before that step can't be reused.
pub async fn rotate_session(conn: &mut SqliteConnection, session_id: i64) -> AppResult<String> {
    let token = random_token();
    sqlx::query("UPDATE sessions SET token_hash = ?, last_seen_at = ? WHERE id = ?")
        .bind(sha256_hex(&token))
        .bind(now_ts())
        .bind(session_id)
        .execute(conn)
        .await?;
    Ok(token)
}

pub fn session_cookie(token: &str, secure: bool) -> HeaderValue {
    let max_age = ABSOLUTE_TIMEOUT.whole_seconds();
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}"
    ))
    .expect("cookie is valid ASCII")
}

pub fn clear_cookie(secure: bool) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{secure}"
    ))
    .expect("valid")
}

fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty())
}

pub async fn account_requires_2fa(conn: &mut SqliteConnection) -> AppResult<bool> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT value FROM account_settings WHERE key = 'require_2fa'")
            .fetch_optional(conn)
            .await?;
    Ok(value.as_deref() == Some("true"))
}

/// The signed-in user for this request, with their effective permissions.
#[derive(Clone, Debug)]
pub struct CurrentUser {
    pub user: UserRow,
    pub session_id: i64,
    pub principal: Principal,
    /// The user has 2FA on but hasn't entered a code in this session yet.
    pub mfa_pending: bool,
}

impl CurrentUser {
    pub fn actor(&self) -> (i64, String) {
        (self.user.id, self.user.username.clone())
    }

    /// (user id, username) for audit entries.
    pub fn actor_ref(&self) -> (i64, &str) {
        (self.user.id, self.user.username.as_str())
    }
}

/// Routes still reachable while a sign-in step is outstanding.
const MFA_PENDING_ALLOWED: &[&str] = &["/api/auth/me", "/api/auth/mfa", "/api/auth/logout"];
const PASSWORD_CHANGE_ALLOWED: &[&str] = &[
    "/api/auth/me",
    "/api/auth/change-password",
    "/api/auth/logout",
];
const TWO_FACTOR_SETUP_ALLOWED: &[&str] = &[
    "/api/auth/me",
    "/api/auth/logout",
    "/api/auth/change-password",
    "/api/auth/totp/setup",
    "/api/auth/totp/enable",
];

fn gate(status: StatusCode, code: &'static str, message: &str) -> Response {
    CodedError {
        status,
        code,
        message: message.to_string(),
    }
    .into_response()
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let unauthorized = || AppError::Unauthorized.into_response();
        let token = read_cookie(&parts.headers, COOKIE_NAME).ok_or_else(unauthorized)?;
        let path = parts
            .extensions
            .get::<OriginalUri>()
            .map(|u| u.0.path().to_string())
            .unwrap_or_else(|| parts.uri.path().to_string());

        let mut conn = state
            .pool
            .acquire()
            .await
            .map_err(|e| AppError::from(e).into_response())?;
        #[derive(FromRow)]
        struct SessionRow {
            id: i64,
            user_id: i64,
            last_seen_at: String,
            expires_at: String,
            mfa_passed: bool,
        }
        let session = sqlx::query_as::<_, SessionRow>(
            "SELECT id, user_id, last_seen_at, expires_at, mfa_passed FROM sessions WHERE token_hash = ?",
        )
        .bind(sha256_hex(&token))
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| AppError::from(e).into_response())?
        .ok_or_else(unauthorized)?;

        let now = OffsetDateTime::now_utc();
        let expired = parse_ts(&session.expires_at).is_none_or(|t| now >= t)
            || parse_ts(&session.last_seen_at).is_none_or(|t| now - t >= IDLE_TIMEOUT);
        if expired {
            let _ = sqlx::query("DELETE FROM sessions WHERE id = ?")
                .bind(session.id)
                .execute(&mut *conn)
                .await;
            return Err(unauthorized());
        }

        let user = load_user(&mut conn, session.user_id)
            .await
            .map_err(IntoResponse::into_response)?
            .filter(|u| u.disabled_at.is_none())
            .ok_or_else(unauthorized)?;

        if parse_ts(&session.last_seen_at).is_some_and(|t| now - t >= LAST_SEEN_RESOLUTION) {
            let _ = sqlx::query("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
                .bind(format_ts(now))
                .bind(session.id)
                .execute(&mut *conn)
                .await;
        }

        let mfa_pending = user.totp_enabled && !session.mfa_passed;
        if mfa_pending && !MFA_PENDING_ALLOWED.contains(&path.as_str()) {
            return Err(gate(
                StatusCode::UNAUTHORIZED,
                "mfa_required",
                "Enter your two-factor code to continue",
            ));
        }
        if user.must_change_password && !PASSWORD_CHANGE_ALLOWED.contains(&path.as_str()) {
            return Err(gate(
                StatusCode::FORBIDDEN,
                "password_change_required",
                "You must change your password before continuing",
            ));
        }
        if !user.totp_enabled
            && !TWO_FACTOR_SETUP_ALLOWED.contains(&path.as_str())
            && account_requires_2fa(&mut conn)
                .await
                .map_err(IntoResponse::into_response)?
        {
            return Err(gate(
                StatusCode::FORBIDDEN,
                "two_factor_setup_required",
                "Set up two-factor login before continuing",
            ));
        }

        let principal = load_principal(&mut conn, &user)
            .await
            .map_err(IntoResponse::into_response)?;
        Ok(CurrentUser {
            user,
            session_id: session.id,
            principal,
            mfa_pending,
        })
    }
}

/// Public view of a grant.
#[derive(Serialize, Clone, Debug)]
pub struct GrantView {
    pub id: i64,
    pub role: String,
    pub scope_type: String,
    pub scope_id: Option<i64>,
    pub project_id: Option<i64>,
    pub created_at: String,
}

pub async fn grants_for(conn: &mut SqliteConnection, user_id: i64) -> AppResult<Vec<GrantView>> {
    #[derive(FromRow)]
    struct Row {
        id: i64,
        role: String,
        scope_type: String,
        scope_id: Option<i64>,
        project_id: Option<i64>,
        created_at: String,
    }
    let rows = sqlx::query_as::<_, Row>(
        "SELECT id, role, scope_type, scope_id, project_id, created_at FROM role_grants WHERE user_id = ? ORDER BY id",
    )
    .bind(user_id)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| GrantView {
            id: r.id,
            role: r.role,
            scope_type: r.scope_type,
            scope_id: r.scope_id,
            project_id: r.project_id,
            created_at: r.created_at,
        })
        .collect())
}
