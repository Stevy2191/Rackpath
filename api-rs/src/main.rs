//! `rackpath` command line.
//!
//!   rackpath [serve]                 run the server
//!   rackpath reset-password <user>   set a new temporary password
//!   rackpath backup <file>           consistent copy of the database
//!   rackpath version

use std::process::ExitCode;
use std::time::Duration;

use rackpath::config::Config;
use rackpath::state::AppState;
use rackpath::{audit, db};

fn usage() -> ExitCode {
    eprintln!("usage: rackpath [serve | reset-password <username> | backup <file> | import-v1 --from mysql://user:pass@host/db [--dry-run] | version]");
    ExitCode::from(2)
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("serve");
    if matches!(command, "version" | "--version" | "-V") {
        println!("rackpath {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("RACKPATH_LOG")
                .unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Configuration error: {e}");
            return ExitCode::from(78); // EX_CONFIG
        }
    };
    let pool = match db::connect(&config.database_path).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "Could not open the database at {}: {e}",
                config.database_path.display()
            );
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = db::migrate(&pool).await {
        eprintln!("Database migration failed: {e}");
        return ExitCode::FAILURE;
    }

    match (command, args.get(1)) {
        ("serve", None) => serve(config, pool).await,
        ("reset-password", Some(username)) => match rackpath::reset_password(&pool, username).await
        {
            Ok(password) => {
                println!("New temporary password for {username}: {password}");
                println!("It must be changed at the next sign-in. All of {username}'s sessions were signed out.");
                ExitCode::SUCCESS
            }
            Err(rackpath::error::AppError::NotFound) => {
                eprintln!("No user named {username}");
                ExitCode::FAILURE
            }
            Err(e) => {
                eprintln!("Could not reset the password: {e}");
                ExitCode::FAILURE
            }
        },
        ("backup", Some(dest)) => match db::backup(&pool, std::path::Path::new(dest)).await {
            Ok(()) => {
                println!("Backup written to {dest}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("Backup failed: {e}");
                ExitCode::FAILURE
            }
        },
        ("import-v1", Some(flag)) if flag == "--from" => match args.get(2) {
            Some(url) => import_v1(config, pool, url, args.iter().any(|a| a == "--dry-run")).await,
            None => usage(),
        },
        _ => usage(),
    }
}

/// Imports a v1 database. With --dry-run the import runs against a copy of
/// the database, which is then thrown away.
async fn import_v1(config: Config, pool: sqlx::SqlitePool, url: &str, dry_run: bool) -> ExitCode {
    if let Err(e) = rackpath::prepare(&pool).await {
        eprintln!("Startup data preparation failed: {e}");
        return ExitCode::FAILURE;
    }
    match rackpath::ensure_owner(&pool).await {
        Ok(Some(password)) => {
            eprintln!("Created the owner account: admin / {password} (change it at first sign-in)")
        }
        Ok(None) => {}
        Err(e) => {
            eprintln!("Could not create the owner account: {e}");
            return ExitCode::FAILURE;
        }
    }
    let from = match sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(2)
        .connect(url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Could not connect to the v1 database: {e}");
            return ExitCode::FAILURE;
        }
    };
    let (pool, copy) = if dry_run {
        let copy = config
            .data_dir
            .join(format!("import-v1-dry-run-{}.db", std::process::id()));
        if let Err(e) = db::backup(&pool, &copy).await {
            eprintln!("Could not copy the database for a dry run: {e}");
            return ExitCode::FAILURE;
        }
        match db::connect(&copy).await {
            Ok(p) => (p, Some(copy)),
            Err(e) => {
                eprintln!("Could not open the copy: {e}");
                return ExitCode::FAILURE;
            }
        }
    } else {
        (pool, None)
    };
    let state = rackpath::state::AppState::new(pool.clone(), config);
    // v1's JWT secret, for integration secrets from v1 releases before its
    // migration 0065. An environment variable, so it isn't in `ps` output.
    let legacy_key = std::env::var("RACKPATH_V1_JWT_SECRET")
        .ok()
        .filter(|k| !k.is_empty());
    let result = rackpath::import_v1::run(&pool, state, &from, legacy_key.as_deref()).await;
    pool.close().await;
    if let Some(copy) = &copy {
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", copy.display()));
        }
    }
    match result {
        Ok(report) => {
            println!(
                "{}",
                if dry_run {
                    "Dry run: nothing was saved. It would import:"
                } else {
                    "Imported from v1:"
                }
            );
            for (what, count) in &report.counts {
                println!("  {count:>6}  {what}");
            }
            if !report.skipped.is_empty() {
                println!("Not imported ({}):", report.skipped.len());
                for s in &report.skipped {
                    println!("  - {s}");
                }
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Import failed: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: Config, pool: sqlx::SqlitePool) -> ExitCode {
    if let Err(e) = rackpath::prepare(&pool).await {
        eprintln!("Startup data preparation failed: {e}");
        return ExitCode::FAILURE;
    }
    match rackpath::ensure_owner(&pool).await {
        Ok(Some(password)) => {
            eprintln!("================================================================");
            eprintln!(" Rackpath first start: created the owner account.");
            eprintln!("   username: admin");
            eprintln!("   password: {password}");
            eprintln!(" You must change this password when you first sign in.");
            eprintln!(" Lost it? Run: rackpath reset-password admin");
            eprintln!("================================================================");
        }
        Ok(None) => {}
        Err(e) => {
            eprintln!("Could not create the owner account: {e}");
            return ExitCode::FAILURE;
        }
    }

    // Audit retention and expired-session cleanup, hourly.
    let maintenance_pool = pool.clone();
    let retention = config.audit_retention_days;
    let data_dir = config.data_dir.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            if let Ok(mut conn) = maintenance_pool.acquire().await {
                if let Err(e) = audit::apply_retention(&mut conn, retention).await {
                    tracing::warn!(error = %e, "audit retention failed");
                }
                let cutoff = rackpath::util::ts_in(-rackpath::auth::IDLE_TIMEOUT);
                let _ =
                    sqlx::query("DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?")
                        .bind(rackpath::util::now_ts())
                        .bind(cutoff)
                        .execute(&mut *conn)
                        .await;
                if let Err(e) =
                    rackpath::routes::floor_plans::sweep(&maintenance_pool, &data_dir).await
                {
                    tracing::warn!(error = %e, "floor plan clean-up failed");
                }
            }
        }
    });

    let listener = match tokio::net::TcpListener::bind(config.bind).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Could not listen on {}: {e}", config.bind);
            return ExitCode::FAILURE;
        }
    };
    tracing::info!(address = %config.bind, "Rackpath listening");
    let state = AppState::new(pool, config);
    // Scheduled syncs of UniFi and Zabbix integrations, checked every minute.
    rackpath::routes::integrations::start_auto_sync(state.clone());
    // Scheduled ping sweeps and SNMP polls (only where an admin set them up).
    rackpath::discovery::start_schedule(state.clone());
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    match rackpath::serve(listener, state, shutdown).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Server error: {e}");
            ExitCode::FAILURE
        }
    }
}
