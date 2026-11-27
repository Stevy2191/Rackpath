//! Password hashing off the async runtime, with bounded concurrency.
//!
//! argon2id deliberately uses about 19 MB and tens of milliseconds per hash.
//! Running it on the async worker threads would stall other requests, and
//! unbounded concurrency would let a burst of login attempts claim gigabytes
//! of memory. So every hash runs on the blocking pool, at most two at a time.

use tokio::sync::Semaphore;

use crate::domain::password::{self, Verified};
use crate::error::{AppError, AppResult};

static HASHING: Semaphore = Semaphore::const_new(2);

async fn run<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    let _permit = HASHING.acquire().await.map_err(AppError::internal)?;
    tokio::task::spawn_blocking(work)
        .await
        .map_err(AppError::internal)
}

pub async fn hash(plain: &str) -> AppResult<String> {
    let plain = plain.to_owned();
    run(move || password::hash(&plain)).await
}

pub async fn verify(plain: &str, stored: &str) -> Verified {
    let (plain, stored) = (plain.to_owned(), stored.to_owned());
    run(move || password::verify(&plain, &stored))
        .await
        .unwrap_or(Verified {
            ok: false,
            needs_rehash: false,
        })
}

/// Same cost as a real check, for unknown usernames.
pub async fn verify_dummy(plain: &str) {
    let plain = plain.to_owned();
    let _ = run(move || password::verify_dummy(&plain)).await;
}
