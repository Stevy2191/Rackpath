//! Configuration from environment variables, validated once at startup.
//! A missing or malformed required value stops the process with a clear
//! message rather than running in an insecure state.

use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    /// Directory holding the database file and uploads.
    pub data_dir: PathBuf,
    /// Path to the SQLite database file.
    pub database_path: PathBuf,
    /// Address the HTTP server listens on.
    pub bind: SocketAddr,
    /// 32-byte key for credentials stored at rest (RACKPATH_ENCRYPTION_KEY).
    pub encryption_key: [u8; 32],
    /// Mark the session cookie Secure (set when served over HTTPS).
    pub cookie_secure: bool,
    /// Public base URL, used for invitation links and QR codes.
    pub public_url: Option<String>,
    /// Take the client address from the last X-Forwarded-For entry, the one
    /// the proxy added (only when Rackpath sits behind a reverse proxy you
    /// control, and only it can reach Rackpath).
    pub trust_proxy: bool,
    /// Days of audit history to keep; None keeps everything.
    pub audit_retention_days: Option<u32>,
    /// The built web app (index.html and assets/). Missing: API only.
    pub web_dir: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("RACKPATH_ENCRYPTION_KEY must be set to 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32")]
    EncryptionKey,
    #[error("RACKPATH_BIND is not a valid address (expected e.g. 0.0.0.0:8080): {0}")]
    Bind(String),
    #[error("{name} must be 'true' or 'false', got '{value}'")]
    Bool { name: &'static str, value: String },
    #[error("RACKPATH_PUBLIC_URL must start with http:// or https://")]
    PublicUrl,
    #[error("RACKPATH_AUDIT_RETENTION_DAYS must be a positive whole number")]
    Retention,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn env_bool(name: &'static str, default: bool) -> Result<bool, ConfigError> {
    match env(name) {
        None => Ok(default),
        Some(v) => match v.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Ok(true),
            "false" | "0" | "no" => Ok(false),
            _ => Err(ConfigError::Bool { name, value: v }),
        },
    }
}

pub fn parse_key(hex_key: &str) -> Result<[u8; 32], ConfigError> {
    if hex_key.len() != 64 {
        return Err(ConfigError::EncryptionKey);
    }
    let bytes = hex::decode(hex_key).map_err(|_| ConfigError::EncryptionKey)?;
    bytes.try_into().map_err(|_| ConfigError::EncryptionKey)
}

impl Config {
    pub fn from_env() -> Result<Config, ConfigError> {
        let data_dir = PathBuf::from(env("RACKPATH_DATA_DIR").unwrap_or_else(|| "./data".into()));
        let database_path = env("RACKPATH_DATABASE")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("rackpath.db"));
        let bind_text = env("RACKPATH_BIND").unwrap_or_else(|| "0.0.0.0:8080".into());
        let bind = bind_text
            .parse()
            .map_err(|_| ConfigError::Bind(bind_text))?;
        let encryption_key =
            parse_key(&env("RACKPATH_ENCRYPTION_KEY").ok_or(ConfigError::EncryptionKey)?)?;
        let public_url = env("RACKPATH_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_string());
        if let Some(url) = &public_url {
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(ConfigError::PublicUrl);
            }
        }
        let audit_retention_days = match env("RACKPATH_AUDIT_RETENTION_DAYS") {
            None => None,
            Some(v) => Some(
                v.parse::<u32>()
                    .ok()
                    .filter(|d| *d > 0)
                    .ok_or(ConfigError::Retention)?,
            ),
        };
        Ok(Config {
            data_dir,
            database_path,
            bind,
            encryption_key,
            web_dir: PathBuf::from(env("RACKPATH_WEB_DIR").unwrap_or_else(|| "./web".into())),
            cookie_secure: env_bool("RACKPATH_COOKIE_SECURE", false)?,
            public_url,
            trust_proxy: env_bool("RACKPATH_TRUST_PROXY", false)?,
            audit_retention_days,
        })
    }
}
