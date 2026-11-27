//! Shared application state.

use std::ops::Deref;
use std::sync::Arc;

use sqlx::SqlitePool;

use crate::auth::ratelimit::RateLimiter;
use crate::config::Config;
use crate::domain::crypto::SecretBox;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub pool: SqlitePool,
    pub config: Config,
    pub secrets: SecretBox,
    pub limiter: RateLimiter,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Config) -> AppState {
        let secrets = SecretBox::new(&config.encryption_key);
        AppState(Arc::new(Inner {
            pool,
            config,
            secrets,
            limiter: RateLimiter::default(),
        }))
    }
}

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}
