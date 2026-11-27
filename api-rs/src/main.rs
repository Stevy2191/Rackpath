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
    eprintln!("usage: rackpath [serve | reset-password <username> | backup <file> | version]");
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
        _ => usage(),
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
