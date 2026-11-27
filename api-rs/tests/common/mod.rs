//! Shared test harness: starts a real server on a temporary database.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;

use rackpath::config::Config;
use rackpath::state::AppState;
use rackpath::{db, ensure_owner};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tempfile::TempDir;

pub struct TestApp {
    pub base: String,
    pub pool: SqlitePool,
    pub owner_password: String,
    pub dir: TempDir,
}

pub async fn spawn() -> TestApp {
    spawn_with_network(std::sync::Arc::new(rackpath::discovery::net::RealNetwork)).await
}

/// Starts a server whose discovery talks to `network` (a fake, in tests).
pub async fn spawn_with_network(
    network: std::sync::Arc<dyn rackpath::discovery::net::Network>,
) -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        data_dir: dir.path().to_path_buf(),
        database_path: dir.path().join("rackpath.db"),
        bind: "127.0.0.1:0".parse().unwrap(),
        encryption_key: [7u8; 32],
        cookie_secure: false,
        public_url: Some("http://rackpath.test".into()),
        trust_proxy: false,
        audit_retention_days: None,
        web_dir: dir.path().join("web"),
    };
    let pool = db::connect(&config.database_path).await.unwrap();
    db::migrate(&pool).await.unwrap();
    rackpath::prepare(&pool).await.unwrap();
    let owner_password = ensure_owner(&pool)
        .await
        .unwrap()
        .expect("owner created on first start");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let state = AppState::with_network(pool.clone(), config, network);
    tokio::spawn(rackpath::serve(listener, state, std::future::pending()));
    TestApp {
        base: format!("http://{addr}"),
        pool,
        owner_password,
        dir,
    }
}

/// Starts a server on a copy of an existing database file (for upgrade
/// tests). `owner_password` is whatever that database's owner uses.
pub async fn spawn_on(db_file: &std::path::Path, owner_password: &str) -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("rackpath.db");
    std::fs::copy(db_file, &db_path).unwrap();
    let config = Config {
        data_dir: dir.path().to_path_buf(),
        database_path: db_path.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        encryption_key: [7u8; 32],
        cookie_secure: false,
        public_url: Some("http://rackpath.test".into()),
        trust_proxy: false,
        audit_retention_days: None,
        web_dir: dir.path().join("web"),
    };
    let pool = db::connect(&db_path).await.unwrap();
    db::migrate(&pool).await.unwrap();
    rackpath::prepare(&pool).await.unwrap();
    assert_eq!(
        ensure_owner(&pool).await.unwrap(),
        None,
        "existing database keeps its owner"
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let state = AppState::new(pool.clone(), config);
    tokio::spawn(rackpath::serve(listener, state, std::future::pending()));
    TestApp {
        base: format!("http://{addr}"),
        pool,
        owner_password: owner_password.to_string(),
        dir,
    }
}

pub fn client() -> Client {
    Client::builder().cookie_store(true).build().unwrap()
}

impl TestApp {
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }
    pub async fn get(&self, c: &Client, path: &str) -> (StatusCode, Value) {
        let r = c.get(self.url(path)).send().await.unwrap();
        let status = r.status();
        (status, r.json().await.unwrap_or(Value::Null))
    }
    pub async fn send(
        &self,
        c: &Client,
        method: reqwest::Method,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let r = c
            .request(method, self.url(path))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = r.status();
        (status, r.json().await.unwrap_or(Value::Null))
    }
    pub async fn post(&self, c: &Client, path: &str, body: Value) -> (StatusCode, Value) {
        self.send(c, reqwest::Method::POST, path, body).await
    }
    pub async fn patch(&self, c: &Client, path: &str, body: Value) -> (StatusCode, Value) {
        self.send(c, reqwest::Method::PATCH, path, body).await
    }
    pub async fn delete(&self, c: &Client, path: &str, body: Value) -> (StatusCode, Value) {
        self.send(c, reqwest::Method::DELETE, path, body).await
    }
    pub async fn login(&self, c: &Client, username: &str, password: &str) -> (StatusCode, Value) {
        self.post(
            c,
            "/api/auth/login",
            json!({ "username": username, "password": password }),
        )
        .await
    }

    /// Signs in as the owner and replaces the temporary password.
    pub async fn owner(&self) -> Client {
        let c = client();
        assert_eq!(
            self.login(&c, "admin", &self.owner_password).await.0,
            StatusCode::OK
        );
        let (s, _) = self
            .post(&c, "/api/auth/change-password", json!({ "current_password": self.owner_password, "new_password": "owner-password-1" }))
            .await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        c
    }

    /// Creates a user (as `admin_client`) and returns a signed-in client for them.
    pub async fn user(&self, admin_client: &Client, username: &str) -> (i64, Client) {
        let (s, body) = self
            .post(admin_client, "/api/users", json!({ "username": username }))
            .await;
        assert_eq!(s, StatusCode::CREATED, "{body}");
        let id = body["user"]["id"].as_i64().unwrap();
        let temp = body["temporary_password"].as_str().unwrap().to_string();
        let c = client();
        assert_eq!(self.login(&c, username, &temp).await.0, StatusCode::OK);
        let new_password = format!("{username}-password-1");
        let (s, _) = self
            .post(
                &c,
                "/api/auth/change-password",
                json!({ "current_password": temp, "new_password": new_password }),
            )
            .await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        (id, c)
    }

    pub async fn project(&self, c: &Client, code: &str) -> i64 {
        let (s, body) = self
            .post(
                c,
                "/api/projects",
                json!({ "code": code, "name": format!("Project {code}") }),
            )
            .await;
        assert_eq!(s, StatusCode::CREATED, "{body}");
        body["id"].as_i64().unwrap()
    }

    pub async fn grant(
        &self,
        c: &Client,
        user_id: i64,
        role: &str,
        scope_type: &str,
        scope_id: Option<i64>,
    ) -> (StatusCode, Value) {
        self.post(
            c,
            &format!("/api/users/{user_id}/grants"),
            json!({ "role": role, "scope_type": scope_type, "scope_id": scope_id }),
        )
        .await
    }

    pub fn db_path(&self) -> PathBuf {
        self.dir.path().join("rackpath.db")
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
