//! The v1 importer against a real MariaDB with v1's schema and a small v1
//! site (tests/fixtures). Runs when RACKPATH_TEST_MYSQL_URL points at a
//! MariaDB/MySQL server where the user may create databases (CI starts one);
//! otherwise it's skipped.

mod common;

use common::*;
use rackpath::config::Config;
use rackpath::state::AppState;
use reqwest::StatusCode;
use serde_json::Value;
use sqlx::mysql::MySqlPoolOptions;

async fn v1_database() -> Option<sqlx::MySqlPool> {
    let url = std::env::var("RACKPATH_TEST_MYSQL_URL").ok()?;
    let admin = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("MySQL reachable");
    let name = format!("rackpath_v1_{}", std::process::id());
    // The database name is made here from the process id: safe to splice.
    let setup =
        format!("DROP DATABASE IF EXISTS {name}; CREATE DATABASE {name} CHARACTER SET utf8mb4");
    sqlx::raw_sql(sqlx::AssertSqlSafe(setup))
        .execute(&admin)
        .await
        .unwrap();
    let base = url.rsplit_once('/').map(|(b, _)| b).unwrap_or(&url);
    let db = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&format!("{base}/{name}"))
        .await
        .unwrap();
    for file in [
        "tests/fixtures/v1_schema.sql",
        "tests/fixtures/v1_sample.sql",
    ] {
        let sql = std::fs::read_to_string(file).unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&db)
            .await
            .unwrap();
    }
    Some(db)
}

fn config(app: &TestApp) -> Config {
    Config {
        data_dir: app.dir.path().to_path_buf(),
        database_path: app.dir.path().join("rackpath.db"),
        bind: "127.0.0.1:0".parse().unwrap(),
        encryption_key: [7u8; 32],
        cookie_secure: false,
        public_url: None,
        trust_proxy: false,
        audit_retention_days: None,
        web_dir: app.dir.path().join("web"),
    }
}

#[tokio::test]
async fn imports_a_v1_site() {
    let Some(v1) = v1_database().await else {
        eprintln!("RACKPATH_TEST_MYSQL_URL not set: skipping the v1 import test");
        return;
    };
    let app = spawn().await;
    let state = AppState::new(app.pool.clone(), config(&app));
    let report = rackpath::import_v1::run(&app.pool, state.clone(), &v1)
        .await
        .unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(report.counts["projects"], 1);
    assert_eq!(report.counts["devices"], 10);

    // A second run is refused: the import is for a fresh Rackpath.
    let again = rackpath::import_v1::run(&app.pool, state, &v1).await;
    assert!(again.unwrap_err().contains("already has projects"));

    let c = app.owner().await;
    let (_, projects) = app.get(&c, "/api/projects").await;
    let p = &projects[0];
    assert_eq!(
        (p["code"].as_str(), p["name"].as_str()),
        (Some("ACME-HEAD-OFFICE"), Some("Acme Head Office"))
    );
    let pid = p["id"].as_i64().unwrap();

    // Places: building number as the code, site details on it, both floors.
    let (_, locs) = app.get(&c, &format!("/api/projects/{pid}/locations")).await;
    let b1 = locs
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["code"] == "B1")
        .expect("B1");
    assert_eq!(b1["address_city"], "Springfield");
    assert_eq!(b1["isp_primary_circuit"], "CIR-9");
    assert!(
        locs.as_array()
            .unwrap()
            .iter()
            .any(|l| l["code"] == "IMPORTED"),
        "the rack with no location"
    );
    let (_, places) = app.get(&c, &format!("/api/projects/{pid}/places")).await;
    let paths: Vec<&str> = places
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["path"].as_str().unwrap())
        .collect();
    for want in [
        "ACME-HEAD-OFFICE/B1/1/SR-101/RACK-A",
        "ACME-HEAD-OFFICE/B1/0/RECEPTION",
        "ACME-HEAD-OFFICE/B1/0/DEFAULT/RACK-B",
    ] {
        assert!(paths.contains(&want), "{want} in {paths:?}");
    }

    // Devices: rack positions, the slot that overlapped went to Unplaced,
    // the rack-only items became devices, the camera came across.
    let (_, list) = app
        .get(&c, &format!("/api/projects/{pid}/devices?limit=100"))
        .await;
    let devices = list["devices"].as_array().unwrap();
    let by_name = |n: &str| {
        devices
            .iter()
            .find(|d| d["name"] == n)
            .unwrap_or_else(|| panic!("{n}"))
    };
    let sw = by_name("core-sw-1");
    assert_eq!(sw["placement"]["u"], 40.0);
    assert_eq!(sw["source"], "v1_import");
    assert_eq!(sw["asset_tag"], "AT-1");
    assert_eq!(by_name("srv-1")["placement"]["face"], "both");
    let clash = by_name("clash");
    assert_eq!(clash["placement"]["type"], "unplaced");
    assert!(clash["notes"]
        .as_str()
        .unwrap()
        .contains("Imported from v1 Unplaced"));
    assert_eq!(by_name("PDU left")["placement"]["mount"], "zero_u_left");
    assert_eq!(by_name("Blank")["device_type"]["key"], "blanking_panel");
    assert_eq!(by_name("printer-1")["placement"]["type"], "room");
    assert_eq!(by_name("Lobby cam")["device_type"]["key"], "camera");
    assert_eq!(by_name("Front reader")["device_type"]["key"], "door_reader");
    let tagged: Vec<&str> = devices
        .iter()
        .filter(|d| d["tags"].as_array().is_some_and(|t| !t.is_empty()))
        .map(|d| d["name"].as_str().unwrap())
        .collect();
    assert_eq!(tagged.len(), 3, "{tagged:?}");

    // Cables, with the v1 cable type where v2 has an exact match.
    let swid = sw["id"].as_i64().unwrap();
    let (_, ports) = app.get(&c, &format!("/api/devices/{swid}/ports")).await;
    let p1 = ports["ports"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["code"] == "1")
        .unwrap();
    assert_eq!(p1["interface_name"], "Gi0/1");
    assert_eq!(p1["front"]["cable_type"], "Cat6");
    assert!(p1["front"]["far"]["path"].as_str().unwrap().ends_with("/1"));

    // Power: the UPS's figures and runtime curve, and the server's cord.
    let ups = by_name("UPS 1500");
    let (_, up) = app
        .get(&c, &format!("/api/devices/{}/power", ups["id"]))
        .await;
    assert_eq!(up["power"]["capacity_w"], 1000);
    assert_eq!(up["power"]["runtime_curve"][0]["minutes"], 20.0);
    assert_eq!(
        up["outlets"],
        serde_json::json!({ "total": 4, "used": 1, "groups": [{ "group": 1, "total": 4, "used": 1 }] })
    );

    // IPAM: LAN and WAN from the project, the VLAN's subnet corrected to
    // its network, addresses on devices.
    let (_, prefixes) = app.get(&c, &format!("/api/projects/{pid}/prefixes")).await;
    let cidrs: Vec<&str> = prefixes["prefixes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["cidr"].as_str().unwrap())
        .collect();
    for want in ["192.168.10.0/24", "203.0.113.8/29", "192.168.20.0/24"] {
        assert!(cidrs.contains(&want), "{want} in {cidrs:?}");
    }
    let (_, addrs) = app
        .get(
            &c,
            &format!("/api/projects/{pid}/addresses?device_id={swid}"),
        )
        .await;
    assert_eq!(addrs["addresses"][0]["address"], "192.168.10.2");

    // The v1 user signs in with their old password and is an account admin.
    let jane = client();
    let (st, me) = app.login(&jane, "jane", "old-v1-password").await;
    assert_eq!(st, StatusCode::OK, "{me}");
    let (_, me) = app.get(&jane, "/api/auth/me").await;
    assert_eq!(me["is_account_admin"], true);

    // The integration's secret decrypts (same key and format), sync is off.
    let (_, ints) = app
        .get(&c, &format!("/api/projects/{pid}/integrations"))
        .await;
    let i = &ints["integrations"][0];
    assert_eq!(
        (
            i["kind"].as_str(),
            i["has_secret"].as_bool(),
            i["auto_sync"].as_bool()
        ),
        (Some("unifi"), Some(true), Some(false))
    );
    assert_eq!(i["options"]["site"], "default");
    let iid = i["id"].as_i64().unwrap();
    let secret: String = sqlx::query_scalar("SELECT secret_enc FROM integrations WHERE id = ?")
        .bind(iid)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    let box_ = rackpath::domain::crypto::SecretBox::new(&[7u8; 32]);
    assert_eq!(box_.decrypt(&secret).unwrap(), "unifi-api-key-123");

    // Diagram, templates, history; the temporary import account is gone.
    let (_, topo) = app
        .get(&c, &format!("/api/projects/{pid}/topologies"))
        .await;
    let tid = topo["topologies"][0]["id"].as_i64().unwrap();
    let (_, d) = app.get(&c, &format!("/api/topologies/{tid}")).await;
    assert_eq!(
        (
            d["nodes"].as_array().unwrap().len(),
            d["edges"].as_array().unwrap().len(),
            d["items"].as_array().unwrap().len()
        ),
        (2, 1, 2)
    );
    let (_, tpl) = app.get(&c, &format!("/api/projects/{pid}/templates")).await;
    let custom = tpl["templates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Custom PDU 8")
        .unwrap();
    let (_, full) = app
        .get(&c, &format!("/api/templates/{}", custom["id"]))
        .await;
    assert_eq!(full["ports"].as_array().unwrap().len(), 8);
    let (_, hist) = app.get(&c, "/api/audit?resource_type=v1_activity").await;
    let e: &Value = &hist["entries"][0];
    assert_eq!(
        (e["at"].as_str(), e["username"].as_str()),
        (Some("2024-02-03T10:11:12Z"), Some("jane"))
    );
    let (_, users) = app.get(&c, "/api/users").await;
    assert!(!users
        .as_array()
        .unwrap()
        .iter()
        .any(|u| u["user"]["username"] == "v1-import"));
    let (_, created) = app
        .get(
            &c,
            &format!("/api/audit?resource_type=device&project_id={pid}"),
        )
        .await;
    assert_eq!(created["entries"][0]["username"], "v1-import");
}
