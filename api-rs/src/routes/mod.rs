//! HTTP routes. Every handler that touches data takes `CurrentUser`, checks
//! permissions with the pure engine in `domain::permissions`, and writes its
//! audit entry in the same transaction as the change.

pub mod account;
pub mod audit_log;
pub mod auth;
pub mod connections;
pub mod device_types;
pub mod devices;
pub mod invitations;
pub mod ipam;
pub mod places;
pub mod ports;
pub mod projects;
pub mod racks;
pub mod search;
pub mod users;
pub mod vlans;

use axum::extract::{FromRequest, Request};
use axum::routing::{delete, get, patch, post, put};
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
        // Locations, floors, rooms
        .route(
            "/api/projects/{id}/locations",
            get(places::list_locations).post(places::create_location),
        )
        .route(
            "/api/locations/{id}",
            get(places::get_location)
                .patch(places::update_location)
                .delete(places::delete_location),
        )
        .route("/api/locations/{id}/floors", post(places::create_floor))
        .route(
            "/api/floors/{id}",
            get(places::get_floor)
                .patch(places::update_floor)
                .delete(places::delete_floor),
        )
        .route("/api/floors/{id}/rooms", post(places::create_room))
        .route(
            "/api/rooms/{id}",
            get(places::get_room)
                .patch(places::update_room)
                .delete(places::delete_room),
        )
        // Racks
        .route("/api/rooms/{id}/racks", post(racks::create_rack))
        .route(
            "/api/racks/{id}",
            get(racks::get_rack)
                .patch(racks::update_rack)
                .delete(racks::delete_rack),
        )
        // Device types and devices
        .route(
            "/api/projects/{id}/device-types",
            get(device_types::list).post(device_types::create),
        )
        .route(
            "/api/device-types/{id}",
            patch(device_types::update).delete(device_types::remove),
        )
        .route(
            "/api/projects/{id}/devices",
            get(devices::list).post(devices::create),
        )
        .route("/api/projects/{id}/next-code", get(devices::next_code))
        .route(
            "/api/devices/{id}",
            get(devices::get_one)
                .patch(devices::update)
                .delete(devices::remove),
        )
        // Ports and cabling
        .route(
            "/api/devices/{id}/ports",
            get(ports::list_for_device).post(ports::create),
        )
        .route("/api/devices/{id}/ports/bulk", post(ports::create_bulk))
        .route("/api/racks/{id}/ports", get(ports::list_for_rack))
        .route(
            "/api/ports/{id}",
            get(ports::get_one)
                .patch(ports::update)
                .delete(ports::remove),
        )
        .route("/api/ports/{id}/trace", get(ports::trace))
        .route("/api/ports/{id}/chain-color", post(ports::chain_color))
        .route("/api/ports/{id}/vlans", put(ports::set_vlans))
        .route("/api/connections", post(connections::create))
        .route(
            "/api/connections/{id}",
            get(connections::get_one)
                .patch(connections::update)
                .delete(connections::remove),
        )
        // VLANs and WLANs
        .route(
            "/api/projects/{id}/vlans",
            get(vlans::list_vlans).post(vlans::create_vlan),
        )
        .route(
            "/api/vlans/{id}",
            patch(vlans::update_vlan).delete(vlans::delete_vlan),
        )
        .route(
            "/api/projects/{id}/wlans",
            get(vlans::list_wlans).post(vlans::create_wlan),
        )
        .route(
            "/api/wlans/{id}",
            patch(vlans::update_wlan).delete(vlans::delete_wlan),
        )
        // IP address management
        .route(
            "/api/projects/{id}/spaces",
            get(ipam::list_spaces).post(ipam::create_space),
        )
        .route(
            "/api/spaces/{id}",
            patch(ipam::update_space).delete(ipam::delete_space),
        )
        .route(
            "/api/projects/{id}/prefixes",
            get(ipam::list_prefixes).post(ipam::create_prefix),
        )
        .route(
            "/api/prefixes/{id}",
            get(ipam::get_prefix)
                .patch(ipam::update_prefix)
                .delete(ipam::delete_prefix),
        )
        .route("/api/prefixes/{id}/next-free", get(ipam::next_free))
        .route("/api/prefixes/{id}/grid", get(ipam::grid))
        .route("/api/prefixes/{id}/ranges", post(ipam::create_range))
        .route(
            "/api/ranges/{id}",
            patch(ipam::update_range).delete(ipam::delete_range),
        )
        .route(
            "/api/projects/{id}/addresses",
            get(ipam::list_addresses).post(ipam::create_address),
        )
        .route(
            "/api/addresses/{id}",
            get(ipam::get_address)
                .patch(ipam::update_address)
                .delete(ipam::delete_address),
        )
        .route("/api/projects/{id}/ipam/warnings", get(ipam::warnings))
        // Search
        .route("/api/search", get(search::search))
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
        kind => {
            let id = scope_id.ok_or_else(|| AppError::bad("scope_id is required"))?;
            let placed = crate::hierarchy::find(conn, kind, id)
                .await?
                .ok_or_else(|| {
                    AppError::bad("That location, floor, room, rack or device doesn't exist")
                })?;
            Ok(ResolvedScope {
                chain: placed.chain,
                project_id: Some(placed.project_id),
                path: placed.path,
            })
        }
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

/// Parses an optional JSON body: empty → `T::default()`.
pub fn optional_body<T: DeserializeOwned + Default>(bytes: &[u8]) -> AppResult<T> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    serde_json::from_slice(bytes).map_err(|e| AppError::bad(format!("Invalid JSON body: {e}")))
}

/// For `Option<Option<T>>` fields: absent → None (unchanged), `null` →
/// Some(None) (cleared), value → Some(Some(v)). Use with
/// `#[serde(default, deserialize_with = "nullable")]`.
pub fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    <Option<T> as serde::Deserialize>::deserialize(deserializer).map(Some)
}

/// Applies a nullable update to an old value.
pub fn apply_nullable<T>(new: Option<Option<T>>, old: Option<T>) -> Option<T> {
    match new {
        None => old,
        Some(v) => v,
    }
}
