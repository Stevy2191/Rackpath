//! One error type for every handler. Client errors keep their message;
//! server errors are logged with detail but answered with a generic body,
//! so internals (SQL, paths) never reach the client.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("Authentication required")]
    Unauthorized,
    #[error("Invalid username or password")]
    InvalidCredentials,
    #[error("{0}")]
    Forbidden(String),
    #[error("Not found")]
    NotFound,
    #[error("{0}")]
    Conflict(String),
    #[error("Too many attempts. Try again later.")]
    TooManyRequests { retry_after_secs: u64 },
    #[error("internal error: {0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn bad(msg: impl Into<String>) -> Self {
        AppError::BadRequest(msg.into())
    }
    pub fn forbidden(msg: impl Into<String>) -> Self {
        AppError::Forbidden(msg.into())
    }
    pub fn internal(err: impl std::fmt::Display) -> Self {
        AppError::Internal(err.to_string())
    }

    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::InvalidCredentials => (StatusCode::UNAUTHORIZED, "invalid_credentials"),
            AppError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AppError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            AppError::TooManyRequests { .. } => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            AppError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &err {
            if db.is_unique_violation() {
                return AppError::Conflict("That value is already in use".into());
            }
            if db.is_check_violation() {
                return AppError::BadRequest("A value is not allowed".into());
            }
            if db.is_foreign_key_violation() {
                return AppError::BadRequest("A referenced item does not exist".into());
            }
        }
        AppError::Internal(err.to_string())
    }
}

/// Lets handlers attach a machine-readable code to a 403, e.g. so the
/// frontend can send the user to the change-password page.
pub struct CodedError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl IntoResponse for CodedError {
    fn into_response(self) -> Response {
        (
            self.status,
            axum::Json(json!({ "error": self.message, "code": self.code })),
        )
            .into_response()
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        let message = match &self {
            AppError::Internal(detail) => {
                tracing::error!(error = %detail, "internal error");
                "Internal server error".to_string()
            }
            other => other.to_string(),
        };
        let mut response = (
            status,
            axum::Json(json!({ "error": message, "code": code })),
        )
            .into_response();
        if let AppError::TooManyRequests { retry_after_secs } = self {
            if let Ok(v) = HeaderValue::from_str(&retry_after_secs.to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, v);
            }
        }
        response
    }
}
