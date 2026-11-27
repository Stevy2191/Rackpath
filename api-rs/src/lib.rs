//! Rackpath v2 API. See docs/design/v2-data-model.md.

pub mod audit;
pub mod auth;
pub mod cabling;
pub mod config;
pub mod db;
pub mod domain;
pub mod error;
pub mod hierarchy;
pub mod imports;
pub mod middleware;
pub mod passwords;
pub mod routes;
pub mod state;
pub mod util;

use std::net::SocketAddr;

use sqlx::SqlitePool;
use tokio::net::TcpListener;

use crate::audit::Entry;
use crate::middleware::RequestCtx;
use crate::util::{now_ts, random_password};

/// Creates the owner account on first start. Returns the generated
/// temporary password (which must be changed at first sign-in), or None if
/// users already exist.
pub async fn ensure_owner(pool: &SqlitePool) -> Result<Option<String>, error::AppError> {
    let mut tx = pool.begin().await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;
    if count > 0 {
        return Ok(None);
    }
    let temporary = random_password();
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO users (username, display_name, password_hash, must_change_password, is_owner, created_at, updated_at)
         VALUES ('admin', 'Administrator', ?, 1, 1, ?, ?)",
    )
    .bind(crate::passwords::hash(&temporary).await?)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    audit::record(
        &mut tx,
        &RequestCtx::system(),
        None,
        Entry::new("create", "user", Some(id))
            .path("admin")
            .changes(serde_json::json!({ "username": "admin", "owner": true })),
    )
    .await?;
    tx.commit().await?;
    Ok(Some(temporary))
}

/// Startup data work after migrations: built-in device types for every
/// project (covers projects created before a release added new built-ins)
/// and the built-in device templates.
pub async fn prepare(pool: &SqlitePool) -> Result<(), error::AppError> {
    routes::device_types::seed_all(pool).await?;
    routes::templates::seed_builtins(pool).await
}

/// Sets a new temporary password for `username` and signs out its sessions.
pub async fn reset_password(pool: &SqlitePool, username: &str) -> Result<String, error::AppError> {
    let mut tx = pool.begin().await?;
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(&mut *tx)
        .await?;
    let id = id.ok_or(error::AppError::NotFound)?;
    let temporary = random_password();
    sqlx::query("UPDATE users SET password_hash = ?, must_change_password = 1, disabled_at = NULL, updated_at = ? WHERE id = ?")
        .bind(crate::passwords::hash(&temporary).await?)
        .bind(now_ts())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(&mut tx, &RequestCtx::system(), None, Entry::new("update", "user", Some(id)).path(username.to_string())
        .changes(serde_json::json!({ "password": [audit::REDACTED, audit::REDACTED], "via": "command line" })))
    .await?;
    tx.commit().await?;
    Ok(temporary)
}

/// Serves the API on `listener` until `shutdown` resolves.
pub async fn serve(
    listener: TcpListener,
    state: state::AppState,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let app = routes::router(state);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
}
