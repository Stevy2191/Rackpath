//! Account-wide settings and ownership transfer.

use axum::extract::State;
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{require_account_admin, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::{account_requires_2fa, load_user, CurrentUser};
use crate::domain::password;
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

pub async fn get_settings(
    State(state): State<AppState>,
    current: CurrentUser,
) -> AppResult<Json<Value>> {
    require_account_admin(&current)?;
    let mut conn = state.pool.acquire().await?;
    Ok(Json(
        json!({ "require_2fa": account_requires_2fa(&mut conn).await? }),
    ))
}

#[derive(Deserialize)]
pub struct Settings {
    require_2fa: Option<bool>,
}

pub async fn update_settings(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<Settings>,
) -> AppResult<Json<Value>> {
    require_account_admin(&current)?;
    let mut tx = state.pool.begin().await?;
    let before = account_requires_2fa(&mut tx).await?;
    if let Some(require) = body.require_2fa {
        if require && !current.user.totp_enabled {
            return Err(AppError::bad(
                "Turn on two-factor login for your own account first",
            ));
        }
        sqlx::query(
            "INSERT INTO account_settings (key, value) VALUES ('require_2fa', ?)
                     ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .bind(if require { "true" } else { "false" })
        .execute(&mut *tx)
        .await?;
        if require != before {
            audit::record(
                &mut tx,
                &ctx,
                Some((current.user.id, &current.user.username)),
                Entry::new("update", "account_settings", None)
                    .changes(json!({ "require_2fa": [before, require] })),
            )
            .await?;
        }
    }
    let after = account_requires_2fa(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "require_2fa": after })))
}

#[derive(Deserialize)]
pub struct Transfer {
    user_id: i64,
    password: String,
}

/// The owner hands ownership to another active user (and keeps an account
/// admin grant so they don't lose access).
pub async fn transfer_ownership(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<Transfer>,
) -> AppResult<StatusCode> {
    if !current.user.is_owner {
        return Err(AppError::forbidden("Only the owner can transfer ownership"));
    }
    if !password::verify(&body.password, &current.user.password_hash).ok {
        return Err(AppError::forbidden("Password is incorrect"));
    }
    if body.user_id == current.user.id {
        return Err(AppError::bad("You already own this account"));
    }
    let mut tx = state.pool.begin().await?;
    let target = load_user(&mut tx, body.user_id)
        .await?
        .filter(|u| u.disabled_at.is_none())
        .ok_or(AppError::NotFound)?;
    let now = now_ts();
    sqlx::query("UPDATE users SET is_owner = 0, updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(current.user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE users SET is_owner = 1, updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(target.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO role_grants (user_id, role, scope_type, scope_id, project_id, created_by, created_at)
         VALUES (?, 'admin', 'account', NULL, NULL, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(current.user.id)
    .bind(current.user.id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some((current.user.id, &current.user.username)),
        Entry::new("update", "account", None)
            .changes(json!({ "owner": [current.user.username, target.username] })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
