//! HTTP routes. Every handler that touches data takes `CurrentUser`, checks
//! permissions with the pure engine in `domain::permissions`, and writes its
//! audit entry in the same transaction as the change.

pub mod account;
pub mod audit_log;
pub mod auth;
pub mod invitations;
pub mod projects;
pub mod users;

use axum::extract::{FromRequest, Request};
use axum::routing::{delete, get, post};
use axum::{middleware as axum_mw, Json, Router};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::json;
use sqlx::SqliteConnection;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::auth::{CurrentUser, UserRow};
use crate::domain::permissions::{Action, Chain, ScopeType};
use crate::error::{AppError, AppResult};
use crate::middleware;
use crate::state::AppState;

/// JSON body extractor whose errors use the API's normal error format.
pub struct JsonBody<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for JsonBody<T> {
    type Rejection = AppError;
    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(JsonBody(value)),
            Err(rejection) => Err(AppError::bad(rejection.body_text())),
        }
    }
}

pub fn router(state: AppState) -> Router {
    let mut app = Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({ "status": "ok" })) }),
        )
        // Sign-in and the signed-in user's own account
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/mfa", post(auth::mfa))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        .route("/api/auth/change-password", post(auth::change_password))
        .route("/api/auth/totp/setup", post(auth::totp_setup))
        .route("/api/auth/totp/enable", post(auth::totp_enable))
        .route("/api/auth/totp/disable", post(auth::totp_disable))
        .route(
            "/api/auth/totp/recovery-codes",
            post(auth::regenerate_recovery_codes),
        )
        .route("/api/sessions", get(auth::list_own_sessions))
        .route("/api/sessions/{id}", delete(auth::revoke_session))
        // Users and grants
        .route("/api/users", get(users::list).post(users::create))
        .route(
            "/api/users/{id}",
            get(users::get_one)
                .patch(users::update)
                .delete(users::remove),
        )
        .route(
            "/api/users/{id}/reset-password",
            post(users::reset_password),
        )
        .route("/api/users/{id}/reset-2fa", post(users::reset_two_factor))
        .route(
            "/api/users/{id}/sessions",
            get(users::list_sessions).delete(users::revoke_sessions),
        )
        .route(
            "/api/users/{id}/grants",
            get(users::list_grants).post(users::add_grant),
        )
        .route(
            "/api/users/{id}/grants/{grant_id}",
            delete(users::remove_grant),
        )
        // Invitations
        .route(
            "/api/invitations",
            get(invitations::list).post(invitations::create),
        )
        .route("/api/invitations/{id}", delete(invitations::revoke))
        .route("/api/invitations/{id}/reissue", post(invitations::reissue))
        .route(
            "/api/invitations/accept/{token}",
            get(invitations::preview).post(invitations::accept),
        )
        // Projects
        .route("/api/projects", get(projects::list).post(projects::create))
        .route(
            "/api/projects/{id}",
            get(projects::get_one)
                .patch(projects::update)
                .delete(projects::remove),
        )
        // Account
        .route(
            "/api/account/settings",
            get(account::get_settings).patch(account::update_settings),
        )
        .route(
            "/api/account/transfer-ownership",
            post(account::transfer_ownership),
        )
        // Change history
        .route("/api/audit", get(audit_log::list))
        .fallback(|| async { AppError::NotFound });

    for (name, value) in middleware::security_headers() {
        app = app.layer(SetResponseHeaderLayer::if_not_present(name, value));
    }
    app.layer(RequestBodyLimitLayer::new(1024 * 1024))
        .layer(axum_mw::from_fn_with_state(
            state.clone(),
            middleware::same_origin,
        ))
        .layer(axum_mw::from_fn_with_state(
            state.clone(),
            middleware::request_context,
        ))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

/// Where a grant points: the chain used for permission checks, the project
/// it belongs to, and a readable path for the audit log.
pub struct ResolvedScope {
    pub chain: Chain,
    pub project_id: Option<i64>,
    pub path: String,
}

pub async fn resolve_scope(
    conn: &mut SqliteConnection,
    scope_type: ScopeType,
    scope_id: Option<i64>,
) -> AppResult<ResolvedScope> {
    match scope_type {
        ScopeType::Account => {
            if scope_id.is_some() {
                return Err(AppError::bad("Account-wide grants have no scope_id"));
            }
            Ok(ResolvedScope {
                chain: Chain::account(),
                project_id: None,
                path: "account".into(),
            })
        }
        ScopeType::Project => {
            let id = scope_id.ok_or_else(|| AppError::bad("scope_id is required"))?;
            let code: Option<String> = sqlx::query_scalar("SELECT code FROM projects WHERE id = ?")
                .bind(id)
                .fetch_optional(conn)
                .await?;
            let code = code.ok_or_else(|| AppError::bad("Project not found"))?;
            Ok(ResolvedScope {
                chain: Chain::project(id),
                project_id: Some(id),
                path: code,
            })
        }
        // Locations, floors, rooms, racks and devices arrive in phase 2.
        _ => Err(AppError::bad(
            "Grants on locations, rooms, racks and devices become available once those exist",
        )),
    }
}

/// Public view of a user (never includes hashes or secrets).
#[derive(Serialize)]
pub struct UserView {
    pub id: i64,
    pub username: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub is_owner: bool,
    pub must_change_password: bool,
    pub totp_enabled: bool,
    pub disabled: bool,
    pub last_login_at: Option<String>,
    pub created_at: String,
}

impl From<&UserRow> for UserView {
    fn from(u: &UserRow) -> Self {
        UserView {
            id: u.id,
            username: u.username.clone(),
            email: u.email.clone(),
            display_name: u.display_name.clone(),
            is_owner: u.is_owner,
            must_change_password: u.must_change_password,
            totp_enabled: u.totp_enabled,
            disabled: u.disabled_at.is_some(),
            last_login_at: u.last_login_at.clone(),
            created_at: u.created_at.clone(),
        }
    }
}

/// Read access → 404 when missing; write/manage → 403 if the user can at
/// least see the resource, else 404 (so its existence isn't revealed).
pub fn require(current: &CurrentUser, action: Action, chain: &Chain) -> AppResult<()> {
    if current.principal.can(action, chain) {
        return Ok(());
    }
    if action != Action::Read && current.principal.can(Action::Read, chain) {
        return Err(AppError::forbidden("You don't have permission to do that"));
    }
    Err(AppError::NotFound)
}

pub fn require_account_admin(current: &CurrentUser) -> AppResult<()> {
    if current.principal.is_account_admin() {
        Ok(())
    } else {
        Err(AppError::forbidden(
            "Only account administrators can do that",
        ))
    }
}
