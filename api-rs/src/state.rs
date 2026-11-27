//! Shared application state.

use std::ops::Deref;
use std::sync::Arc;

use sqlx::SqlitePool;

use crate::auth::ratelimit::RateLimiter;
use crate::config::Config;
use crate::discovery::net::{Network, RealNetwork};
use crate::domain::crypto::SecretBox;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub pool: SqlitePool,
    pub config: Config,
    pub secrets: SecretBox,
    pub limiter: RateLimiter,
    /// What discovery sends on the network (a fake one in tests).
    pub network: Arc<dyn Network>,
    /// Discovery runs one sweep or SNMP poll at a time.
    pub discovery_lock: Arc<tokio::sync::Mutex<()>>,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Config) -> AppState {
        AppState::with_network(pool, config, Arc::new(RealNetwork))
    }

    pub fn with_network(pool: SqlitePool, config: Config, network: Arc<dyn Network>) -> AppState {
        let secrets = SecretBox::new(&config.encryption_key);
        AppState(Arc::new(Inner {
            pool,
            config,
            secrets,
            limiter: RateLimiter::default(),
            network,
            discovery_lock: Arc::new(tokio::sync::Mutex::new(())),
        }))
    }
}

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}
