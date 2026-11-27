//! Request context (request ID, client IP, user agent), cross-site request
//! protection and security headers.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::AppError;
use crate::state::AppState;

/// Who is asking and from where; attached to every request and audit entry.
#[derive(Clone, Debug)]
pub struct RequestCtx {
    pub request_id: String,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

impl RequestCtx {
    /// For work not triggered by an HTTP request (CLI, background jobs).
    pub fn system() -> RequestCtx {
        RequestCtx {
            request_id: ulid::Ulid::new().to_string(),
            ip: None,
            user_agent: Some("rackpath-cli".into()),
        }
    }
}

fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>, trust_proxy: bool) -> Option<String> {
    if trust_proxy {
        if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(first) = forwarded
                .split(',')
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(first.to_string());
            }
        }
    }
    peer.map(|p| p.ip().to_string())
}

pub async fn request_context(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0);
    let ctx = RequestCtx {
        request_id: ulid::Ulid::new().to_string(),
        ip: client_ip(req.headers(), peer, state.config.trust_proxy),
        user_agent: req
            .headers()
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.chars().take(255).collect()),
    };
    let request_id = ctx.request_id.clone();
    req.extensions_mut().insert(ctx);
    let mut response = next.run(req).await;
    if let Ok(v) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", v);
    }
    response
}

/// Rejects state-changing requests that a browser sent from another site.
/// The session cookie is SameSite=Strict already; this is a second layer.
/// Requests without an Origin header (scripts, curl) are allowed: they carry
/// no ambient browser cookies of a victim.
pub async fn same_origin(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(req).await;
    }
    let headers = req.headers();
    if headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site") {
        return AppError::forbidden("Cross-site request refused").into_response();
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let host = headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let origin_host = origin.split("://").nth(1).unwrap_or("");
        let matches_host = !host.is_empty() && origin_host.eq_ignore_ascii_case(host);
        let matches_public = state
            .config
            .public_url
            .as_deref()
            .is_some_and(|u| u.eq_ignore_ascii_case(origin));
        if !(matches_host || matches_public) {
            return AppError::forbidden("Cross-origin request refused").into_response();
        }
    }
    next.run(req).await
}

/// Content security policy for the web app's pages: everything from this
/// origin only. Inline styles are allowed for the diagram and rack drawing
/// libraries; scripts never.
pub const APP_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; \
     form-action 'self'; frame-ancestors 'none'";

pub fn security_headers() -> Vec<(header::HeaderName, HeaderValue)> {
    vec![
        (
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
        ),
        (
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ),
        (header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY")),
        (
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ),
        (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        (
            header::HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("same-origin"),
        ),
    ]
}
