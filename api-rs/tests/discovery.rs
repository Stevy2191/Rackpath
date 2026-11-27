//! End-to-end tests for network discovery: ping sweeps, SNMP sources, the
//! review list, safety limits and permissions. The network is a fake.

mod common;

use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};

use common::*;
use rackpath::discovery::net::{BoxFut, Network, SnmpAuth, SnmpTables, SnmpTarget};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

#[derive(Default)]
struct FakeNetwork {
    up: Vec<Ipv4Addr>,
    tables: SnmpTables,
    /// What each sweep was asked to ping, and the last SNMP login.
    swept: Mutex<Vec<usize>>,
    last_auth: Mutex<Option<String>>,
}

impl Network for FakeNetwork {
    fn sweep(&self, targets: Vec<Ipv4Addr>) -> BoxFut<'_, Result<Vec<Ipv4Addr>, String>> {
        self.swept.lock().unwrap().push(targets.len());
        let up = self
            .up
            .iter()
            .filter(|ip| targets.contains(ip))
            .copied()
            .collect();
        Box::pin(async move { Ok(up) })
    }
    fn reverse_dns(&self, ip: IpAddr) -> BoxFut<'_, Option<String>> {
        let last = match ip {
            IpAddr::V4(v) => v.octets()[3],
            IpAddr::V6(_) => 0,
        };
        Box::pin(async move { Some(format!("host-{last}.lan")) })
    }
    fn snmp(&self, target: SnmpTarget) -> BoxFut<'_, Result<SnmpTables, String>> {
        let seen = match &target.auth {
            SnmpAuth::V2c { community } => format!("v2c:{community}"),
            SnmpAuth::V3 {
                username,
                auth_password,
                privacy,
                ..
            } => format!(
                "v3:{username}:{auth_password}:{}",
                privacy.as_ref().map(|p| p.1.as_str()).unwrap_or("-")
            ),
        };
        *self.last_auth.lock().unwrap() = Some(seen);
        let t = self.tables.clone();
        Box::pin(async move { Ok(t) })
    }
}

fn ip(s: &str) -> Ipv4Addr {
    s.parse().unwrap()
}

async fn post_ok(app: &TestApp, c: &Client, path: &str, body: Value) -> Value {
    let (s, v) = app.post(c, path, body).await;
    assert_eq!(s, StatusCode::CREATED, "{path}: {v}");
    v
}

/// Waits for a run to finish and returns it.
async fn finished(app: &TestApp, c: &Client, run: i64) -> Value {
    for _ in 0..100 {
        let (s, r) = app.get(c, &format!("/api/discovery-runs/{run}")).await;
        assert_eq!(s, StatusCode::OK, "{r}");
        if r["status"] != "running" {
            return r;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("run {run} didn't finish");
}

async fn scan(app: &TestApp, c: &Client, prefix: i64) -> Value {
    let (s, v) = app
        .post(c, &format!("/api/prefixes/{prefix}/scan"), json!({}))
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{v}");
    finished(app, c, v["run_id"].as_i64().unwrap()).await
}

async fn hosts(app: &TestApp, c: &Client, project: i64, state: &str) -> Vec<Value> {
    let (s, v) = app
        .get(
            c,
            &format!("/api/projects/{project}/discovered?state={state}"),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v["hosts"].as_array().unwrap().clone()
}

#[tokio::test]
async fn ping_sweeps_list_new_hosts_for_review() {
    let net = Arc::new(FakeNetwork {
        up: vec![
            ip("192.168.50.10"),
            ip("192.168.50.20"),
            ip("192.168.50.30"),
        ],
        ..Default::default()
    });
    let app = spawn_with_network(net.clone()).await;
    let c = app.owner().await;
    let p = app.project(&c, "ACME").await;
    let prefix = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "192.168.50.0/24" }),
    )
    .await;
    let prefix = prefix["id"].as_i64().unwrap();
    post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "address": "192.168.50.10" }),
    )
    .await;

    // Off until an admin turns it on.
    let (_, d) = app
        .get(&c, &format!("/api/prefixes/{prefix}/discovery"))
        .await;
    assert_eq!(d["scan_enabled"], false);
    assert_eq!(d["scannable"], true);
    let (s, _) = app
        .post(&c, &format!("/api/prefixes/{prefix}/scan"), json!({}))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(net.swept.lock().unwrap().is_empty(), "nothing was pinged");

    // Schedules run at most hourly.
    let path = format!("/api/prefixes/{prefix}/discovery");
    let (s, _) = app
        .patch(
            &c,
            &path,
            json!({ "scan_enabled": true, "scan_interval_minutes": 30 }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, d) = app
        .patch(
            &c,
            &path,
            json!({ "scan_enabled": true, "scan_interval_minutes": 1440 }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{d}");
    assert_eq!(d["scan_interval_minutes"], 1440);

    let run = scan(&app, &c, prefix).await;
    assert_eq!(run["status"], "success", "{run}");
    assert_eq!(run["probed"], 254);
    assert_eq!(run["found"], 3);
    assert_eq!(run["new_hosts"], 2);

    // The documented address only gets "last seen".
    let seen: Option<String> =
        sqlx::query_scalar("SELECT last_seen_at FROM ip_addresses WHERE address = '192.168.50.10'")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert!(seen.is_some());
    let documented: i64 = sqlx::query_scalar("SELECT count(*) FROM ip_addresses")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(documented, 1, "nothing is documented automatically");

    let found = hosts(&app, &c, p, "new").await;
    assert_eq!(found.len(), 2);
    assert_eq!(found[0]["address"], "192.168.50.20");
    assert_eq!(found[0]["dns_name"], "host-20.lan");
    assert_eq!(found[0]["prefix"], "192.168.50.0/24");
    assert_eq!(found[0]["seen_by_ping"], true);

    // Document one, ignore the other.
    let id20 = found[0]["id"].as_i64().unwrap();
    let id30 = found[1]["id"].as_i64().unwrap();
    let a = post_ok(
        &app,
        &c,
        &format!("/api/discovered/{id20}/document"),
        json!({ "description": "Printer" }),
    )
    .await;
    assert_eq!(a["address"], "192.168.50.20");
    assert_eq!(a["dns_name"], "host-20.lan");
    assert_eq!(a["description"], "Printer");
    let (s, _) = app
        .post(
            &c,
            &format!("/api/discovered/{id30}/ignore"),
            json!({ "ignored": true }),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert!(hosts(&app, &c, p, "new").await.is_empty());
    assert_eq!(hosts(&app, &c, p, "ignored").await.len(), 1);

    // A second scan finds nothing new, and the ignored host stays ignored.
    let run = scan(&app, &c, prefix).await;
    assert_eq!(run["new_hosts"], 0, "{run}");
    assert!(hosts(&app, &c, p, "new").await.is_empty());

    // Every scan is in the audit log.
    let (_, log) = app
        .get(&c, "/api/audit?action=sync&resource_type=prefix")
        .await;
    assert!(
        log.to_string().matches("192.168.50.0/24").count() >= 2,
        "{log}"
    );

    // Free addresses leave out what was found.
    let (_, free) = app.get(&c, &format!("/api/prefixes/{prefix}/free")).await;
    assert_eq!(free["free"], 251, "{free}");
}

#[tokio::test]
async fn sweeps_are_limited_to_small_private_ipv4_prefixes() {
    let app = spawn_with_network(Arc::new(FakeNetwork::default())).await;
    let c = app.owner().await;
    let p = app.project(&c, "ACME").await;
    for cidr in ["10.0.0.0/16", "203.0.113.0/24", "fd00::/64"] {
        let v = post_ok(
            &app,
            &c,
            &format!("/api/projects/{p}/prefixes"),
            json!({ "cidr": cidr }),
        )
        .await;
        let id = v["id"].as_i64().unwrap();
        let (_, d) = app.get(&c, &format!("/api/prefixes/{id}/discovery")).await;
        assert_eq!(d["scannable"], false, "{cidr}");
        assert!(d["not_scannable_reason"].is_string());
        let (s, _) = app
            .patch(
                &c,
                &format!("/api/prefixes/{id}/discovery"),
                json!({ "scan_enabled": true }),
            )
            .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{cidr}");
    }
}

#[tokio::test]
async fn only_admins_scan_and_editors_review() {
    let net = Arc::new(FakeNetwork {
        up: vec![ip("10.9.0.5")],
        ..Default::default()
    });
    let app = spawn_with_network(net).await;
    let c = app.owner().await;
    let p = app.project(&c, "ACME").await;
    let prefix = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "10.9.0.0/28" }),
    )
    .await;
    let prefix = prefix["id"].as_i64().unwrap();
    let (editor_id, editor) = app.user(&c, "eddie").await;
    let (reader_id, reader) = app.user(&c, "rita").await;
    app.grant(&c, editor_id, "editor", "project", Some(p)).await;
    app.grant(&c, reader_id, "reader", "project", Some(p)).await;

    let path = format!("/api/prefixes/{prefix}/discovery");
    let (s, _) = app
        .patch(&editor, &path, json!({ "scan_enabled": true }))
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    app.patch(&c, &path, json!({ "scan_enabled": true })).await;
    let (s, _) = app
        .post(&editor, &format!("/api/prefixes/{prefix}/scan"), json!({}))
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    scan(&app, &c, prefix).await;

    let found = hosts(&app, &reader, p, "new").await;
    assert_eq!(found.len(), 1);
    let id = found[0]["id"].as_i64().unwrap();
    let (s, _) = app
        .post(
            &reader,
            &format!("/api/discovered/{id}/ignore"),
            json!({ "ignored": true }),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = app
        .post(
            &editor,
            &format!("/api/discovered/{id}/ignore"),
            json!({ "ignored": true }),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = app
        .get(&reader, &format!("/api/projects/{p}/snmp-sources"))
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = app
        .post(
            &editor,
            &format!("/api/projects/{p}/snmp-sources"),
            json!({ "name": "r1", "host": "10.9.0.1", "version": "2c", "community": "x" }),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn snmp_sources_keep_credentials_secret_and_feed_the_review_list() {
    let net = Arc::new(FakeNetwork {
        tables: SnmpTables {
            sys_name: Some("core-sw".into()),
            arp: vec![
                ("192.168.60.40".parse().unwrap(), "00:11:22:33:44:55".into()),
                ("192.168.60.41".parse().unwrap(), "00:11:22:33:44:66".into()),
                // Outside every documented prefix: not kept.
                ("172.20.1.1".parse().unwrap(), "00:11:22:33:44:77".into()),
            ],
            fdb: vec![
                ("00:11:22:33:44:55".into(), "Gi1/0/4".into()),
                ("00:aa:bb:cc:dd:ee".into(), "Gi1/0/9".into()),
            ],
        },
        ..Default::default()
    });
    let app = spawn_with_network(net.clone()).await;
    let c = app.owner().await;
    let p = app.project(&c, "ACME").await;
    post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "192.168.60.0/24" }),
    )
    .await;
    // A documented address whose MAC the switch sees on a port.
    post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "address": "192.168.60.9", "mac": "00-AA-BB-CC-DD-EE" }),
    )
    .await;
    let list = format!("/api/projects/{p}/snmp-sources");

    // Safety and validation.
    for (body, why) in [
        (
            json!({ "name": "x", "host": "8.8.8.8", "version": "2c", "community": "c" }),
            "public host",
        ),
        (
            json!({ "name": "x", "host": "sw.example.com", "version": "2c", "community": "c" }),
            "host name",
        ),
        (
            json!({ "name": "x", "host": "10.0.0.1", "version": "2c" }),
            "no community",
        ),
        (
            json!({ "name": "x", "host": "10.0.0.1", "version": "3", "v3_username": "u" }),
            "no password",
        ),
        (
            json!({ "name": "x", "host": "10.0.0.1", "version": "3", "v3_username": "u", "v3_auth_password": "short" }),
            "short password",
        ),
        (
            json!({ "name": "x", "host": "10.0.0.1", "version": "3", "v3_username": "u", "v3_auth_password": "longenough", "v3_auth_protocol": "md5" }),
            "md5",
        ),
        (
            json!({ "name": "x", "host": "10.0.0.1", "version": "1", "community": "c" }),
            "v1",
        ),
        (
            json!({ "name": "x", "host": "10.0.0.1", "version": "2c", "community": "c", "poll_interval_minutes": 10 }),
            "too often",
        ),
    ] {
        let (s, v) = app.post(&c, &list, body).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{why}: {v}");
    }

    // v3 with privacy: the recommended set-up.
    let v3 = post_ok(
        &app,
        &c,
        &list,
        json!({
            "name": "core", "host": "192.168.60.1", "version": "3", "v3_username": "rackpath",
            "v3_auth_password": "auth-secret-1", "v3_priv_password": "priv-secret-1",
        }),
    )
    .await;
    assert_eq!(v3["security"], "v3_auth_priv");
    assert_eq!(v3["v3_auth_protocol"], "sha256");
    assert_eq!(v3["v3_priv_protocol"], "aes128");
    assert_eq!(v3["has_auth_password"], true);
    assert!(v3["warnings"].as_array().unwrap().is_empty(), "{v3}");
    // v2c works, with a warning.
    let v2 = post_ok(&app, &c, &list, json!({ "name": "old", "host": "192.168.60.2", "version": "2c", "community": "community-secret" })).await;
    assert_eq!(v2["security"], "v2c");
    assert_eq!(v2["warnings"].as_array().unwrap().len(), 1);

    // Secrets never come back, aren't stored in plain text, and aren't audited.
    let (_, all) = app.get(&c, &list).await;
    let (_, log) = app.get(&c, "/api/audit?resource_type=snmp_source").await;
    let stored: Vec<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT community_enc, v3_auth_enc FROM snmp_sources")
            .fetch_all(&app.pool)
            .await
            .unwrap();
    for secret in ["auth-secret-1", "priv-secret-1", "community-secret"] {
        assert!(!all.to_string().contains(secret));
        assert!(!log.to_string().contains(secret));
        assert!(!format!("{stored:?}").contains(secret));
    }

    // Editing other fields keeps the credentials.
    let id = v3["id"].as_i64().unwrap();
    let (s, v) = app
        .patch(
            &c,
            &format!("/api/snmp-sources/{id}"),
            json!({ "poll_interval_minutes": 60 }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["has_priv_password"], true);

    // Test reads without saving.
    let (_, t) = app
        .post(&c, &format!("/api/snmp-sources/{id}/test"), json!({}))
        .await;
    assert_eq!(t["ok"], true, "{t}");
    assert_eq!(t["sys_name"], "core-sw");
    assert_eq!(t["arp_entries"], 3);
    assert_eq!(
        net.last_auth.lock().unwrap().as_deref(),
        Some("v3:rackpath:auth-secret-1:priv-secret-1")
    );
    assert!(hosts(&app, &c, p, "all").await.is_empty());

    // A poll fills the review list.
    let (s, v) = app
        .post(&c, &format!("/api/snmp-sources/{id}/poll"), json!({}))
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{v}");
    let run = finished(&app, &c, v["run_id"].as_i64().unwrap()).await;
    assert_eq!(run["status"], "success", "{run}");
    assert_eq!(run["new_hosts"], 2);
    let found = hosts(&app, &c, p, "new").await;
    assert_eq!(found.len(), 2, "{found:?}");
    assert_eq!(found[0]["address"], "192.168.60.40");
    assert_eq!(found[0]["mac"], "00:11:22:33:44:55");
    assert_eq!(found[0]["switch_port"], "core-sw Gi1/0/4");
    assert_eq!(found[0]["seen_by_snmp"], true);
    let port: Option<String> = sqlx::query_scalar(
        "SELECT last_seen_port FROM ip_addresses WHERE address = '192.168.60.9'",
    )
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert_eq!(port.as_deref(), Some("core-sw Gi1/0/9"));
    let (_, src) = app.get(&c, &list).await;
    let core = src["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "core")
        .unwrap()
        .clone();
    assert_eq!(core["last_status"], "success");

    // Deleting a source is audited.
    let (s, _) = app
        .delete(&c, &format!("/api/snmp-sources/{id}"), json!({}))
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
}
