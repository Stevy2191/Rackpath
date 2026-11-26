//! SQLite connection pool and migrations.

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn connect(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(sqlx::Error::Io)?;
        }
    }
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    // Refuse to run without foreign key enforcement: the schema relies on it.
    let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await?;
    if fk != 1 {
        return Err(sqlx::Error::Configuration(
            "SQLite foreign keys could not be enabled".into(),
        ));
    }
    Ok(pool)
}

pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    MIGRATOR.run(pool).await
}

/// Consistent online copy of the database (safe while the server runs).
pub async fn backup(pool: &SqlitePool, dest: &Path) -> Result<(), sqlx::Error> {
    if dest.exists() {
        return Err(sqlx::Error::Configuration(
            format!("{} already exists", dest.display()).into(),
        ));
    }
    sqlx::query("VACUUM INTO ?")
        .bind(dest.to_string_lossy().to_string())
        .execute(pool)
        .await?;
    Ok(())
}
