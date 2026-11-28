//! Contract and end-to-end tests for phase 6: UniFi and Zabbix against mock
//! servers that answer like the real APIs, the Windows DHCP/DNS push and
//! XML upload, the ownership rules, missing records and held imports.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode as AxStatus};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use common::*;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

fn id(v: &Value) -> i64 {
    v["id"].as_i64().unwrap()
}

async fn post_ok(app: &TestApp, c: &Client, path: &str, body: Value) -> Value {
    let (s, v) = app.post(c, path, body).await;
    assert!(s.is_success(), "{path}: {s} {v}");
    v
}

// ---------------------------------------------------------------- mocks

#[derive(Clone)]
struct Mock {
    data: Arc<Mutex<Value>>,
}

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

fn unifi_data() -> Value {
    json!({
        "devices": [
            { "_id": "d1", "mac": "f0:9f:c2:00:00:01", "ip": "192.168.1.1", "name": "Gateway", "type": "udm", "model": "UDMPRO", "serial": "S1", "version": "4.0.6" },
            { "_id": "d2", "mac": "f0:9f:c2:00:00:02", "ip": "192.168.1.2", "name": "Switch", "type": "usw", "model": "US8P60", "serial": "S2", "version": "7.0" },
        ],
        "networks": [
            { "_id": "n1", "name": "LAN", "purpose": "corporate", "ip_subnet": "192.168.1.1/24", "dhcpd_enabled": true,
              "dhcpd_start": "192.168.1.100", "dhcpd_stop": "192.168.1.199", "dhcpd_dns_enabled": true, "dhcpd_dns_1": "192.168.1.1",
              "domain_name": "home.lan" },
            { "_id": "n2", "name": "IoT", "purpose": "corporate", "vlan_enabled": true, "vlan": 30, "ip_subnet": "10.0.30.1/24",
              "dhcpd_enabled": true, "dhcpd_start": "10.0.30.50", "dhcpd_stop": "10.0.30.150" },
            { "_id": "w", "purpose": "wan", "name": "Internet" },
        ],
        "users": [
            { "mac": "aa:bb:cc:00:00:10", "name": "NAS", "use_fixedip": true, "fixed_ip": "192.168.1.10" },
            { "mac": "aa:bb:cc:00:00:11", "hostname": "phone", "use_fixedip": false },
        ],
        "clients": [ { "mac": "aa:bb:cc:00:00:11", "ip": "192.168.1.150", "hostname": "phone" } ],
    })
}

async fn unifi_mock(data: Value) -> (String, Mock) {
    let mock = Mock {
        data: Arc::new(Mutex::new(data)),
    };
    async fn list(State(m): State<Mock>, headers: HeaderMap, key: &str) -> Response {
        let authed = headers.get("x-api-key").and_then(|v| v.to_str().ok()) == Some("good-key")
            || headers
                .get("cookie")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|c| c.contains("TOKEN=t1"));
        if !authed {
            return (
                AxStatus::UNAUTHORIZED,
                Json(json!({ "meta": { "rc": "error" } })),
            )
                .into_response();
        }
        let d = m.data.lock().unwrap()[key].clone();
        Json(json!({ "meta": { "rc": "ok" }, "data": d })).into_response()
    }
    let router = Router::new()
        .route(
            "/proxy/network/api/s/default/stat/device",
            get(|s: State<Mock>, h: HeaderMap| list(s, h, "devices")),
        )
        .route(
            "/proxy/network/api/s/default/rest/networkconf",
            get(|s: State<Mock>, h: HeaderMap| list(s, h, "networks")),
        )
        .route(
            "/proxy/network/api/s/default/rest/wlanconf",
            get(|s: State<Mock>, h: HeaderMap| list(s, h, "wlans")),
        )
        .route(
            "/proxy/network/api/s/default/rest/user",
            get(|s: State<Mock>, h: HeaderMap| list(s, h, "users")),
        )
        .route(
            "/proxy/network/api/s/default/stat/sta",
            get(|s: State<Mock>, h: HeaderMap| list(s, h, "clients")),
        )
        .route(
            "/api/auth/login",
            post(|Json(b): Json<Value>| async move {
                if b["username"] == "ro" && b["password"] == "pw" {
                    (
                        [("set-cookie", "TOKEN=t1; Path=/; HttpOnly")],
                        Json(json!({})),
                    )
                        .into_response()
                } else {
                    (AxStatus::UNAUTHORIZED, Json(json!({}))).into_response()
                }
            }),
        )
        .with_state(mock.clone());
    (serve(router).await, mock)
}

async fn zabbix_mock() -> String {
    let router = Router::new().route(
        "/zabbix/api_jsonrpc.php",
        post(|headers: HeaderMap, body: axum::body::Bytes| async move {
            // Real Zabbix expects Content-Type: application/json-rpc.
            assert_eq!(headers.get("content-type").and_then(|v| v.to_str().ok()), Some("application/json-rpc"));
            let req: Value = serde_json::from_slice(&body).unwrap();
            let method = req["method"].as_str().unwrap_or("");
            let bearer = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
            let result = match method {
                "user.login" if req["params"]["username"] == "api" && req["params"]["password"] == "pw" => json!("sess1"),
                "user.login" => return Json(json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32602, "message": "Invalid params.", "data": "Incorrect user name or password." } })),
                "user.logout" => json!(true),
                "host.get" if bearer == "Bearer tok1" || bearer == "Bearer sess1" => json!([
                    { "hostid": "10501", "host": "core-sw-1", "name": "Core switch 1",
                      "interfaces": [ { "ip": "10.0.0.2", "main": "1" } ], "hostgroups": [ { "name": "Switches" } ],
                      "inventory": { "vendor": "Cisco", "model": "C9300-48P", "serialno_a": "FOC1", "macaddress_a": "00:11:22:33:44:55" } },
                    { "hostid": "10502", "host": "app01", "interfaces": [ { "ip": "10.0.1.20", "main": "1" } ],
                      "hostgroups": [ { "name": "Linux servers" } ], "inventory": [] },
                ]),
                _ => return Json(json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32602, "message": "Not authorised.", "data": "Not authorised." } })),
            };
            Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
        }),
    );
    format!("{}/zabbix", serve(router).await)
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn unifi_network_with_dhcp() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "HOME").await;
    let (url, mock) = unifi_mock(unifi_data()).await;

    // A NAS documented by hand before the integration existed.
    let nas = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/devices"),
        json!({ "device_type": "nas", "mac": "AA:BB:CC:00:00:10" }),
    )
    .await;
    // A hand-made switch with the same MAC as the UniFi switch is adopted.
    let mine = post_ok(&app, &c, &format!("/api/projects/{p}/devices"), json!({ "device_type": "switch", "code": "CORE", "mac": "f0:9f:c2:00:00:02", "notes": "mine" })).await;

    let (s, e) = app
        .post(&c, &format!("/api/projects/{p}/integrations"), json!({ "kind": "unifi", "name": "Home UDM", "base_url": "https://unifi.ui.com", "secret": "x" }))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "cloud URLs are refused: {e}");
    let i = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "unifi", "name": "Home UDM", "base_url": url, "auth_kind": "api_key", "secret": "good-key",
                "options": { "lease_snapshot": true } }),
    )
    .await;
    assert_eq!(i["has_secret"], true);
    assert!(
        i.get("secret").is_none() && !i.to_string().contains("good-key"),
        "secrets never come back"
    );
    let iid = id(&i);

    let (_, t) = app
        .post(&c, &format!("/api/integrations/{iid}/test"), json!({}))
        .await;
    assert_eq!(t["ok"], true, "{t}");
    assert_eq!(t["devices"], 2);

    // A dry run changes nothing.
    let (_, dry) = app
        .post(
            &c,
            &format!("/api/integrations/{iid}/sync?dry_run=true"),
            json!({}),
        )
        .await;
    assert_eq!(dry["dry_run"], true);
    assert_eq!(dry["counts"]["prefix"]["created"], 2, "{dry}");
    let (_, pre) = app.get(&c, &format!("/api/projects/{p}/prefixes")).await;
    assert_eq!(pre["prefixes"].as_array().unwrap().len(), 0);

    let (s, r) = app
        .post(&c, &format!("/api/integrations/{iid}/sync"), json!({}))
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["counts"]["device"]["created"], 1, "{r}");
    assert_eq!(
        r["counts"]["device"]["updated"], 1,
        "the hand-made switch was adopted"
    );
    assert_eq!(r["vlans_created"], 1);
    assert_eq!(r["leases"], 1);

    // Devices: the gateway lands in Unplaced; the adopted switch keeps its
    // code and notes but gains the source's facts.
    let (_, devs) = app
        .get(&c, &format!("/api/projects/{p}/devices?unplaced=true"))
        .await;
    let gw = devs["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["mac"] == "f0:9f:c2:00:00:01")
        .unwrap()
        .clone();
    assert_eq!(gw["device_type"]["key"], "router");
    assert_eq!(gw["model"], "UDMPRO");
    assert_eq!(gw["source"], "integration");
    let (_, sw) = app.get(&c, &format!("/api/devices/{}", id(&mine))).await;
    assert_eq!(sw["code"], "CORE");
    assert_eq!(sw["notes"], "mine");
    assert_eq!(sw["serial_number"], "S2");

    // IPAM: prefixes, VLAN, DHCP pool, gateway, DNS; reservation linked to
    // the NAS by MAC; device IPs linked to their devices.
    let (_, prefixes) = app.get(&c, &format!("/api/projects/{p}/prefixes")).await;
    let lan = prefixes["prefixes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["cidr"] == "192.168.1.0/24")
        .unwrap()
        .clone();
    assert_eq!(lan["gateway"], "192.168.1.1");
    assert_eq!(lan["dns_servers"], "192.168.1.1");
    assert_eq!(lan["domain_name"], "home.lan");
    assert_eq!(lan["source"], "integration");
    let iot = prefixes["prefixes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["cidr"] == "10.0.30.0/24")
        .unwrap()
        .clone();
    assert!(iot["vlan_id"].is_number());
    let (_, detail) = app.get(&c, &format!("/api/prefixes/{}", id(&lan))).await;
    assert_eq!(detail["ranges"][0]["kind"], "dhcp_pool");
    assert_eq!(detail["ranges"][0]["start_text"], "192.168.1.100");
    let (_, addrs) = app.get(&c, &format!("/api/projects/{p}/addresses")).await;
    let find = |a: &str| {
        addrs["addresses"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["address"] == a)
            .cloned()
            .unwrap()
    };
    let res = find("192.168.1.10");
    // A UniFi fixed IP outside the pool (.100-.199): a static address.
    assert_eq!(
        (res["dhcp_reservation"].clone(), res["kind"].as_str()),
        (json!(false), Some("static"))
    );
    assert!(
        res.get("status").is_none(),
        "no status: documented means in use"
    );
    assert_eq!(
        res["device_id"],
        id(&nas),
        "linked to the one device with that MAC"
    );
    assert_eq!(res["dns_name"], "nas");
    assert_eq!(find("192.168.1.2")["device_id"], id(&mine));

    // People's edits survive the next sync; the source's facts update.
    app.patch(
        &c,
        &format!("/api/addresses/{}", id(&res)),
        json!({ "notes": "backup target", "role": "secondary" }),
    )
    .await;
    app.patch(
        &c,
        &format!("/api/devices/{}", id(&gw)),
        json!({ "code": "GW", "name": "My gateway" }),
    )
    .await;
    mock.data.lock().unwrap()["devices"][0]["version"] = json!("4.1.0");
    let (_, r2) = app
        .post(&c, &format!("/api/integrations/{iid}/sync"), json!({}))
        .await;
    assert_eq!(r2["counts"]["device"]["updated"], 1, "{r2}");
    let (_, gw2) = app.get(&c, &format!("/api/devices/{}", id(&gw))).await;
    assert_eq!(gw2["code"], "GW");
    assert_eq!(gw2["name"], "My gateway");
    assert_eq!(gw2["firmware"], "4.1.0");
    let (_, res2) = app.get(&c, &format!("/api/addresses/{}", id(&res))).await;
    assert_eq!(res2["notes"], "backup target");
    assert_eq!(res2["role"], "secondary");

    // A device gone at the source is marked, not deleted.
    mock.data.lock().unwrap()["devices"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    let (_, r3) = app
        .post(&c, &format!("/api/integrations/{iid}/sync"), json!({}))
        .await;
    assert_eq!(r3["counts"]["device"]["missing"], 1, "{r3}");
    let (st, _) = app.get(&c, &format!("/api/devices/{}", id(&gw))).await;
    assert_eq!(st, StatusCode::OK);
    let (_, w) = app
        .get(&c, &format!("/api/projects/{p}/ipam/warnings"))
        .await;
    assert!(w.to_string().contains("missing_from_source"), "{w}");

    // Username/password works too; wrong credentials fail with a clear message.
    let pw = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "unifi", "name": "Password login", "base_url": url, "auth_kind": "password", "username": "ro", "secret": "pw" }),
    )
    .await;
    let (_, t) = app
        .post(
            &c,
            &format!("/api/integrations/{}/test", id(&pw)),
            json!({}),
        )
        .await;
    assert_eq!(t["ok"], true, "{t}");
    app.patch(
        &c,
        &format!("/api/integrations/{}", id(&pw)),
        json!({ "secret": "wrong" }),
    )
    .await;
    let (_, t) = app
        .post(
            &c,
            &format!("/api/integrations/{}/test", id(&pw)),
            json!({}),
        )
        .await;
    assert_eq!(t["ok"], false);
    assert!(t["message"].as_str().unwrap().contains("Sign-in"), "{t}");

    // The history has one grouped sync entry per run.
    let (_, log) = app.get(&c, "/api/audit?resource_type=integration").await;
    let syncs = log["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["action"] == "sync")
        .count();
    assert_eq!(syncs, 3);
    let (_, runs) = app.get(&c, &format!("/api/integrations/{iid}/runs")).await;
    assert_eq!(runs["runs"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn big_changes_are_held_for_approval() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "HOME").await;
    let mut data = unifi_data();
    // Twelve devices so the source is big enough to be guarded.
    data["devices"] = json!((1..=12)
        .map(|i| json!({ "_id": format!("d{i}"), "mac": format!("f0:9f:c2:00:01:{i:02x}"), "name": format!("AP {i}"), "type": "uap" }))
        .collect::<Vec<_>>());
    let (url, mock) = unifi_mock(data).await;
    let i = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "unifi", "name": "Site", "base_url": url, "secret": "good-key", "options": { "import_dhcp": false } }),
    )
    .await;
    let iid = id(&i);
    let (_, r) = app
        .post(&c, &format!("/api/integrations/{iid}/sync"), json!({}))
        .await;
    assert_eq!(r["counts"]["device"]["created"], 12, "{r}");

    // The source suddenly reports almost nothing: held.
    mock.data.lock().unwrap()["devices"] = json!([]);
    let (_, held) = app
        .post(&c, &format!("/api/integrations/{iid}/sync"), json!({}))
        .await;
    assert_eq!(held["held"], true, "{held}");
    let (_, devs) = app
        .get(&c, &format!("/api/projects/{p}/devices?unplaced=true"))
        .await;
    let missing = devs["devices"].as_array().unwrap().len();
    assert_eq!(missing, 12);
    let (_, list) = app
        .get(&c, &format!("/api/projects/{p}/integrations"))
        .await;
    assert_eq!(list["integrations"][0]["last_status"], "held");
    let run = list["integrations"][0]["held_run_id"].as_i64().unwrap();

    // Rejecting drops it; a new held import can then be approved.
    let (s, _) = app
        .post(
            &c,
            &format!("/api/integrations/{iid}/runs/{run}/reject"),
            json!({}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = app
        .post(
            &c,
            &format!("/api/integrations/{iid}/runs/{run}/approve"),
            json!({}),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (_, held2) = app
        .post(&c, &format!("/api/integrations/{iid}/sync"), json!({}))
        .await;
    let run2 = held2["run_id"].as_i64().unwrap();
    let (s, approved) = app
        .post(
            &c,
            &format!("/api/integrations/{iid}/runs/{run2}/approve"),
            json!({}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{approved}");
    assert_eq!(approved["counts"]["device"]["missing"], 12);
    let (_, runs) = app.get(&c, &format!("/api/integrations/{iid}/runs")).await;
    let statuses: Vec<&str> = runs["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["success", "approved", "rejected", "success"]);
}

#[tokio::test]
async fn zabbix_hosts() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "ACME").await;
    let url = zabbix_mock().await;
    let i = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "zabbix", "name": "Zabbix", "base_url": url, "auth_kind": "token", "secret": "tok1" }),
    )
    .await;
    let (_, r) = app
        .post(&c, &format!("/api/integrations/{}/sync", id(&i)), json!({}))
        .await;
    assert_eq!(r["counts"]["device"]["created"], 2, "{r}");
    let (_, devs) = app.get(&c, &format!("/api/projects/{p}/devices")).await;
    let sw = devs["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["hostname"] == "core-sw-1")
        .unwrap()
        .clone();
    assert_eq!(sw["device_type"]["key"], "switch");
    assert_eq!(sw["manufacturer"], "Cisco");
    // The code comes from the host's name in Zabbix.
    assert_eq!(sw["code"], "CORE-SWITCH-1");
    let (_, d) = app.get(&c, &format!("/api/devices/{}", id(&sw))).await;
    assert!(
        d["external_url"]
            .as_str()
            .unwrap()
            .ends_with("/zabbix/zabbix.php?action=host.edit&hostid=10501"),
        "{d}"
    );
    let (_, a) = app
        .get(&c, &format!("/api/projects/{p}/addresses?q=10.0.0.2"))
        .await;
    assert_eq!(a["addresses"][0]["device_id"], id(&sw));
    assert_eq!(a["addresses"][0]["warnings"], Value::Null);

    // Password login.
    let pw = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "zabbix", "name": "Zabbix pw", "base_url": url, "auth_kind": "password", "username": "api", "secret": "pw" }),
    )
    .await;
    let (_, t) = app
        .post(
            &c,
            &format!("/api/integrations/{}/test", id(&pw)),
            json!({}),
        )
        .await;
    assert_eq!(t["ok"], true, "{t}");
    // A wrong token: the Zabbix error is shown.
    app.patch(
        &c,
        &format!("/api/integrations/{}", id(&i)),
        json!({ "secret": "nope" }),
    )
    .await;
    let (s, e) = app
        .post(&c, &format!("/api/integrations/{}/sync", id(&i)), json!({}))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(
        e["error"].as_str().unwrap().contains("Not authorised"),
        "{e}"
    );
    let (_, one) = app.get(&c, &format!("/api/integrations/{}", id(&i))).await;
    assert_eq!(one["last_status"], "failed");
}

fn gzip(v: &Value) -> Vec<u8> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(v.to_string().as_bytes()).unwrap();
    enc.finish().unwrap()
}

fn push_doc() -> Value {
    json!({
        "version": 1, "server": "dc01.corp.example.com",
        "server_options": { "6": ["10.20.0.53"], "15": ["corp.example.com"] },
        "scopes_v4": [{
            "scope_id": "10.20.30.0", "subnet_mask": "255.255.255.0", "name": "Office", "start_range": "10.20.30.50",
            "end_range": "10.20.30.200", "options": { "3": ["10.20.30.1"] },
            "exclusions": [ { "start": "10.20.30.50", "end": "10.20.30.59" } ],
            "reservations": [ { "ip": "10.20.30.60", "client_id": "aa-bb-cc-00-11-22", "name": "printer1.corp.example.com", "description": "2nd floor" } ]
        }],
        "dns": [
            { "zone": "corp.example.com", "name": "printer1", "type": "A", "data": "10.20.30.60" },
            { "zone": "corp.example.com", "name": "files", "type": "A", "data": "10.20.30.5" },
            { "zone": "corp.example.com", "name": "nas", "type": "A", "data": "10.20.30.5" },
            { "zone": "30.20.10.in-addr.arpa", "name": "5", "type": "PTR", "data": "storage.corp.example.com." }
        ],
        "leases": [ { "ip": "10.20.30.101", "client_id": "11-22-33-44-55-66", "hostname": "laptop7" } ]
    })
}

#[tokio::test]
async fn windows_push_and_upload() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "CORP").await;
    let i = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "windows_dhcp", "name": "DC01", "options": { "lease_snapshot": true } }),
    )
    .await;
    let token = i["token"].as_str().unwrap().to_string();
    let iid = id(&i);
    let (_, again) = app.get(&c, &format!("/api/integrations/{iid}")).await;
    assert!(again.get("token").is_none(), "the token is shown once");

    let raw = client();
    let send = |tok: String, body: Vec<u8>| {
        let raw = raw.clone();
        let url = app.url("/api/imports/windows-dhcp");
        async move {
            let r = raw
                .post(url)
                .header("authorization", format!("Bearer {tok}"))
                .header("content-type", "application/json")
                .header("content-encoding", "gzip")
                .body(body)
                .send()
                .await
                .unwrap();
            let s = r.status();
            (s, r.json::<Value>().await.unwrap_or(Value::Null))
        }
    };
    let (s, _) = send("wrong".into(), gzip(&push_doc())).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, r) = send(token.clone(), gzip(&push_doc())).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["counts"]["prefix"]["created"], 1);
    assert_eq!(r["leases"], 1);
    assert!(
        r["warnings"].to_string().contains("PTR"),
        "PTR disagreeing with A: {r}"
    );
    // One push a minute.
    let (s, _) = send(token.clone(), gzip(&push_doc())).await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);

    let (_, prefixes) = app.get(&c, &format!("/api/projects/{p}/prefixes")).await;
    let office = prefixes["prefixes"][0].clone();
    assert_eq!(office["cidr"], "10.20.30.0/24");
    assert_eq!(office["gateway"], "10.20.30.1");
    assert_eq!(office["dns_servers"], "10.20.0.53");
    assert_eq!(office["domain_name"], "corp.example.com");
    // Usage counts documented addresses and DHCP leases, not the whole
    // pool (141 addresses here): a pool is room for clients, not usage.
    let docs = office["address_count"].as_u64().unwrap();
    assert_eq!(office["dhcp_pool_size"], 141);
    assert_eq!(office["lease_count"], 1);
    assert_eq!(office["in_use"], docs + 1);
    assert_eq!(
        office["utilization"].as_f64().unwrap(),
        ((docs + 1) * 1000 / 254) as f64 / 10.0
    );
    // A leased address that is also documented counts once.
    sqlx::query(
        "INSERT INTO dhcp_lease_snapshots (integration_id, space_id, address, family, addr_bin, captured_at)
         SELECT ?, space_id, address, family, addr_bin, '2026-01-01T00:00:00Z' FROM ip_addresses WHERE address = '10.20.30.60'",
    )
    .bind(iid)
    .execute(&app.pool)
    .await
    .unwrap();
    let (_, prefixes) = app.get(&c, &format!("/api/projects/{p}/prefixes")).await;
    let office = prefixes["prefixes"][0].clone();
    assert_eq!(
        (office["lease_count"].clone(), office["in_use"].clone()),
        (json!(2), json!(docs + 1))
    );
    let (_, one) = app.get(&c, &format!("/api/prefixes/{}", id(&office))).await;
    assert_eq!(
        (one["in_use"].clone(), one["utilization"].clone()),
        (office["in_use"].clone(), office["utilization"].clone())
    );
    sqlx::query("DELETE FROM dhcp_lease_snapshots WHERE address = '10.20.30.60'")
        .execute(&app.pool)
        .await
        .unwrap();
    let (_, d) = app.get(&c, &format!("/api/prefixes/{}", id(&office))).await;
    let ranges: Vec<(String, String, String)> = d["ranges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["kind"].as_str().unwrap().into(),
                r["start_text"].as_str().unwrap().into(),
                r["end_text"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        ranges,
        vec![
            (
                "reserved".into(),
                "10.20.30.50".into(),
                "10.20.30.59".into()
            ),
            (
                "dhcp_pool".into(),
                "10.20.30.60".into(),
                "10.20.30.200".into()
            ),
        ],
        "the pool is split around the exclusion"
    );
    // The lease layer shows on the grid, apart from documented addresses.
    let (_, grid) = app
        .get(&c, &format!("/api/prefixes/{}/grid", id(&office)))
        .await;
    assert_eq!(grid["leases"][0]["offset"], 101, "{grid}");
    assert_eq!(grid["leases"][0]["hostname"], "laptop7");
    let (_, a) = app.get(&c, &format!("/api/projects/{p}/addresses")).await;
    let find = |ip: &str| {
        a["addresses"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["address"] == ip)
            .cloned()
            .unwrap()
    };
    let printer = find("10.20.30.60");
    assert_eq!(printer["dhcp_reservation"], true);
    assert_eq!(printer["mac"], "aa:bb:cc:00:11:22");
    assert_eq!(printer["dns_name"], "printer1.corp.example.com");
    assert_eq!(printer["description"], "2nd floor");
    let files = find("10.20.30.5");
    assert_eq!(files["dns_name"], "files.corp.example.com");
    assert_eq!(files["dns_aliases"], json!(["nas.corp.example.com"]));
    // Reserved addresses inside the pool don't raise the static-in-pool warning.
    let (_, w) = app
        .get(&c, &format!("/api/projects/{p}/ipam/warnings"))
        .await;
    assert!(!w.to_string().contains("static_in_pool"), "{w}");
    // Search finds it by name.
    let (_, hits) = app.get(&c, "/api/search?q=printer1").await;
    assert_eq!(hits[0]["path"], "10.20.30.60");

    // The XML export can be uploaded too (DHCP only: DNS-only addresses stay).
    let xml = r#"<?xml version="1.0" encoding="utf-8"?><DHCPServer><IPv4><Scopes><Scope><ScopeId>10.20.30.0</ScopeId><Name>Office</Name>
        <SubnetMask>255.255.255.0</SubnetMask><StartRange>10.20.30.50</StartRange><EndRange>10.20.30.220</EndRange>
        <OptionValues><OptionValue><OptionId>3</OptionId><Value>10.20.30.1</Value></OptionValue></OptionValues>
        <ExclusionRanges><IPRange><StartRange>10.20.30.50</StartRange><EndRange>10.20.30.59</EndRange></IPRange></ExclusionRanges>
        <Reservations><Reservation><Name>printer1.corp.example.com</Name><IPAddress>10.20.30.60</IPAddress><ClientId>aa-bb-cc-00-11-22</ClientId><Description>2nd floor</Description></Reservation></Reservations>
        </Scope></Scopes></IPv4></DHCPServer>"#;
    let r = raw
        .post(app.url(&format!("/api/integrations/{iid}/upload")))
        .header("content-type", "application/xml")
        .body(xml)
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.status(),
        StatusCode::UNAUTHORIZED,
        "uploads need a signed-in admin"
    );
    let r = c
        .post(app.url(&format!("/api/integrations/{iid}/upload")))
        .header("content-type", "application/xml")
        .body(xml)
        .send()
        .await
        .unwrap();
    let status = r.status();
    let body: Value = r.json().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["counts"]["range"]["updated"], 1,
        "the pool grew to .220: {body}"
    );
    let (_, files_now) = app.get(&c, &format!("/api/addresses/{}", id(&files))).await;
    assert_eq!(files_now["missing_from_source_at"], Value::Null);

    // Rotating the token invalidates the old one.
    let (_, rot) = app
        .post(
            &c,
            &format!("/api/integrations/{iid}/rotate-token"),
            json!({}),
        )
        .await;
    assert_ne!(rot["token"], json!(token));
    sqlx::query("UPDATE sync_runs SET started_at = '2000-01-01T00:00:00.000Z'")
        .execute(&app.pool)
        .await
        .unwrap();
    let (s, _) = send(token, gzip(&push_doc())).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn only_admins_manage_integrations() {
    let app = spawn().await;
    let owner = app.owner().await;
    let p = app.project(&owner, "ACME").await;
    let (ed_id, editor) = app.user(&owner, "editor").await;
    app.grant(&owner, ed_id, "editor", "project", Some(p)).await;
    let (s, _) = app
        .post(
            &editor,
            &format!("/api/projects/{p}/integrations"),
            json!({ "kind": "windows_dhcp", "name": "X" }),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let i = post_ok(&app, &owner, &format!("/api/projects/{p}/integrations"), json!({ "kind": "zabbix", "name": "Z", "base_url": "https://zbx.example.com", "secret": "s3cret" })).await;
    let (s, list) = app
        .get(&editor, &format!("/api/projects/{p}/integrations"))
        .await;
    assert_eq!(s, StatusCode::OK);
    assert!(!list.to_string().contains("s3cret"));
    assert_eq!(list["can_manage"], false);
    let (s, _) = app
        .post(
            &editor,
            &format!("/api/integrations/{}/sync", id(&i)),
            json!({}),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // The secret is encrypted at rest.
    let stored: String = sqlx::query_scalar("SELECT secret_enc FROM integrations WHERE id = ?")
        .bind(id(&i))
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert!(stored.starts_with("v1:") && !stored.contains("s3cret"));
}

async fn wlans_of(app: &TestApp, c: &Client, p: i64) -> Vec<Value> {
    let (_, v) = app.get(c, &format!("/api/projects/{p}/wlans")).await;
    v["wlans"].as_array().unwrap().clone()
}

#[tokio::test]
async fn unifi_wifi_networks() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "WIFI").await;
    let mut data = unifi_data();
    data["wlans"] = json!([
        { "_id": "w1", "name": "Home", "security": "wpapsk", "networkconf_id": "n1", "x_passphrase": "hunter2" },
        { "_id": "w2", "name": "Things", "security": "wpapsk", "wpa3_support": true, "wpa3_transition": true,
          "networkconf_id": "n2", "hide_ssid": true },
    ]);
    let (url, mock) = unifi_mock(data).await;
    // A Wi-Fi network typed in by hand before the integration: adopted,
    // keeping its description.
    post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/wlans"),
        json!({ "ssid": "Home", "security": "open", "description": "mine" }),
    )
    .await;
    let i = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "unifi", "name": "UDM", "base_url": url, "auth_kind": "api_key", "secret": "good-key" }),
    )
    .await;
    let iid = id(&i);
    let (s, r) = app
        .post(&c, &format!("/api/integrations/{iid}/sync"), json!({}))
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(
        (
            r["counts"]["wlan"]["created"].clone(),
            r["counts"]["wlan"]["updated"].clone()
        ),
        (json!(1), json!(1)),
        "{r}"
    );

    let list = wlans_of(&app, &c, p).await;
    assert!(
        !format!("{list:?}").contains("hunter2"),
        "never the passphrase"
    );
    let find =
        |list: &[Value], ssid: &str| list.iter().find(|w| w["ssid"] == ssid).unwrap().clone();
    let home = find(&list, "Home");
    assert_eq!(
        (
            home["security"].as_str(),
            home["description"].as_str(),
            home["source_integration_id"].as_i64()
        ),
        (Some("wpa2"), Some("mine"), Some(iid))
    );
    assert_eq!(home["vlan_id"], Value::Null, "the untagged LAN");
    let things = find(&list, "Things");
    let (_, vlans) = app.get(&c, &format!("/api/projects/{p}/vlans")).await;
    let v30 = vlans["vlans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["vid"] == 30)
        .unwrap()["id"]
        .clone();
    assert_eq!(
        (
            things["security"].as_str(),
            things["hidden"].as_bool(),
            things["vlan_id"].clone()
        ),
        (Some("wpa2_wpa3"), Some(true), v30)
    );

    // Unchanged: nothing to do. Gone at the source: marked missing, kept.
    let (_, r) = app
        .post(&c, &format!("/api/integrations/{iid}/sync"), json!({}))
        .await;
    assert!(
        r["counts"]["wlan"].is_null() || r["counts"]["wlan"]["updated"] == 0,
        "{r}"
    );
    mock.data.lock().unwrap()["wlans"]
        .as_array_mut()
        .unwrap()
        .remove(1);
    let (_, r) = app
        .post(&c, &format!("/api/integrations/{iid}/sync"), json!({}))
        .await;
    assert_eq!(r["counts"]["wlan"]["missing"], 1, "{r}");
    let things = find(&wlans_of(&app, &c, p).await, "Things");
    assert!(things["missing_from_source_at"].is_string(), "{things}");
}

#[tokio::test]
async fn imported_devices_are_coded_from_their_names() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "NAMES").await;
    let mut data = unifi_data();
    data["devices"] = json!([
        { "_id": "d1", "mac": "f0:9f:c2:00:00:01", "name": "Gateway", "type": "udm" },
        { "_id": "d2", "mac": "f0:9f:c2:00:00:02", "ip": "192.168.1.20", "name": "Living Room AP", "type": "uap" },
        { "_id": "d3", "mac": "f0:9f:c2:00:00:03", "name": "Living Room AP", "type": "uap" },
        { "_id": "d4", "mac": "f0:9f:c2:00:00:04", "name": "📡", "type": "uap" },
    ]);
    let (url, mock) = unifi_mock(data).await;
    let i = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "unifi", "name": "UDM", "base_url": url, "auth_kind": "api_key", "secret": "good-key" }),
    )
    .await;
    let iid = id(&i);
    let sync_path = format!("/api/integrations/{iid}/sync");
    let sync = || app.post(&c, &sync_path, json!({}));
    let (s, r) = sync().await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let code_of = |devs: &Value, mac: &str| {
        devs["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["mac"] == mac)
            .unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let (_, devs) = app
        .get(&c, &format!("/api/projects/{p}/devices?unplaced=true"))
        .await;
    // From the name; a second device with the same name gets -2; a name with
    // nothing usable falls back to the type's code.
    assert_eq!(code_of(&devs, "f0:9f:c2:00:00:01"), "GATEWAY");
    assert_eq!(code_of(&devs, "f0:9f:c2:00:00:02"), "LIVING-ROOM-AP");
    assert_eq!(code_of(&devs, "f0:9f:c2:00:00:03"), "LIVING-ROOM-AP-2");
    let fallback = code_of(&devs, "f0:9f:c2:00:00:04");
    assert!(
        fallback.starts_with("AP") && fallback[2..].chars().all(|c| c.is_ascii_digit()),
        "{fallback}"
    );

    // The device's name shows beside its code: on its address and in search.
    let (_, addrs) = app.get(&c, &format!("/api/projects/{p}/addresses")).await;
    let a = addrs["addresses"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["address"] == "192.168.1.20")
        .unwrap()
        .clone();
    assert_eq!(
        (a["device_name"].as_str(), a["device_path"].as_str()),
        (
            Some("Living Room AP"),
            Some("NAMES/UNPLACED/LIVING-ROOM-AP")
        ),
        "{a}"
    );
    let (_, hits) = app.get(&c, "/api/search?q=living").await;
    let hit = hits
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["kind"] == "device")
        .unwrap()
        .clone();
    assert_eq!(hit["name"], "Living Room AP", "{hits}");

    // A device imported before this (still on an automatic code) takes its
    // name's code on the next sync; a code people chose stays.
    sqlx::query("UPDATE devices SET code = 'RT01' WHERE mac = 'f0:9f:c2:00:00:01'")
        .execute(&app.pool)
        .await
        .unwrap();
    let gw = devs["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["mac"] == "f0:9f:c2:00:00:01")
        .unwrap()
        .clone();
    let ap = devs["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["mac"] == "f0:9f:c2:00:00:02")
        .unwrap()
        .clone();
    app.patch(
        &c,
        &format!("/api/devices/{}", id(&ap)),
        json!({ "code": "LR-AP" }),
    )
    .await;
    mock.data.lock().unwrap()["devices"][1]["name"] = json!("Den AP");
    let (_, r) = sync().await;
    assert!(
        r["changes"]
            .to_string()
            .contains("renamed device RT01 to GATEWAY"),
        "{r}"
    );
    let (_, g) = app.get(&c, &format!("/api/devices/{}", id(&gw))).await;
    assert_eq!(g["code"], "GATEWAY");
    assert!(g["path"].as_str().unwrap().ends_with("GATEWAY"), "{g}");
    let (_, a) = app.get(&c, &format!("/api/devices/{}", id(&ap))).await;
    assert_eq!(a["code"], "LR-AP", "a chosen code is never changed");
}

#[tokio::test]
async fn unifi_fixed_ips_are_static_or_reservations_by_pool() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "KINDS").await;
    let mut data = unifi_data();
    data["users"] = json!([
        { "mac": "aa:bb:cc:00:00:10", "name": "prox-a", "use_fixedip": true, "fixed_ip": "192.168.1.10" },
        { "mac": "aa:bb:cc:00:00:12", "name": "printer", "use_fixedip": true, "fixed_ip": "192.168.1.120" },
    ]);
    let (url, mock) = unifi_mock(data).await;
    let i = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "unifi", "name": "UDM", "base_url": url, "auth_kind": "api_key", "secret": "good-key" }),
    )
    .await;
    let iid = id(&i);
    let sync_path = format!("/api/integrations/{iid}/sync");
    let (s, r) = app.post(&c, &sync_path, json!({})).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let kinds = |list: &Value| -> Vec<(String, String)> {
        list["addresses"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| {
                (
                    a["address"].as_str().unwrap().to_string(),
                    a["kind"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    };
    let (_, all) = app.get(&c, &format!("/api/projects/{p}/addresses")).await;
    let all = kinds(&all);
    let kind_of = |ip: &str| all.iter().find(|(a, _)| a == ip).unwrap().1.clone();
    // Outside the pool: static. Inside it, pinned to a MAC: a reservation.
    // The gateway's own address (from its device record) is static too.
    assert_eq!(kind_of("192.168.1.10"), "static");
    assert_eq!(kind_of("192.168.1.120"), "dhcp_reservation");
    assert_eq!(kind_of("192.168.1.1"), "static");

    // The list filters by kind.
    let (_, only) = app
        .get(
            &c,
            &format!("/api/projects/{p}/addresses?kind=dhcp_reservation"),
        )
        .await;
    assert_eq!(
        kinds(&only),
        [("192.168.1.120".to_string(), "dhcp_reservation".to_string())]
    );
    let (s, _) = app
        .get(&c, &format!("/api/projects/{p}/addresses?kind=reserved"))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Only "assigned" is accepted as a status now.
    let (s, e) = app
        .post(
            &c,
            &format!("/api/projects/{p}/addresses"),
            json!({ "address": "192.168.1.50", "status": "reserved" }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{e}");

    // Removed in UniFi: marked missing at the source, kept.
    mock.data.lock().unwrap()["users"]
        .as_array_mut()
        .unwrap()
        .remove(1);
    let (_, r) = app.post(&c, &sync_path, json!({})).await;
    assert_eq!(r["counts"]["address"]["missing"], 1, "{r}");
    let (_, all) = app.get(&c, &format!("/api/projects/{p}/addresses")).await;
    let printer = all["addresses"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["address"] == "192.168.1.120")
        .unwrap()
        .clone();
    assert!(printer["missing_from_source_at"].is_string(), "{printer}");
}

#[tokio::test]
async fn records_gone_from_the_source_can_be_removed() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "GONE").await;
    let mut data = unifi_data();
    data["wlans"] = json!([
        { "_id": "w1", "name": "Home", "security": "wpapsk", "networkconf_id": "n1" },
        { "_id": "w2", "name": "Old", "security": "wpapsk", "networkconf_id": "n1" },
    ]);
    let (url, mock) = unifi_mock(data).await;
    let i = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "unifi", "name": "UDM", "base_url": url, "auth_kind": "api_key", "secret": "good-key" }),
    )
    .await;
    let iid = id(&i);
    let sync = format!("/api/integrations/{iid}/sync");
    let (s, r) = app.post(&c, &sync, json!({})).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    // A cable documented by hand on the gateway.
    let gw: i64 = sqlx::query_scalar("SELECT id FROM devices WHERE name = 'Gateway'")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    let loc = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/locations"),
        json!({ "code": "HQ" }),
    )
    .await;
    let (_, l) = app.get(&c, &format!("/api/locations/{}", id(&loc))).await;
    let floor = l["floors"][0]["id"].as_i64().unwrap();
    let room = post_ok(
        &app,
        &c,
        &format!("/api/floors/{floor}/rooms"),
        json!({ "code": "MDF" }),
    )
    .await;
    let rack = post_ok(
        &app,
        &c,
        &format!("/api/rooms/{}/racks", id(&room)),
        json!({ "u_height": 42 }),
    )
    .await;
    let (s, v) = app
        .patch(
            &c,
            &format!("/api/devices/{gw}"),
            json!({ "placement": { "type": "rack", "rack_id": id(&rack), "u": 10 } }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let (s, ports) = app
        .post(
            &c,
            &format!("/api/devices/{gw}/ports/bulk"),
            json!({ "count": 2, "connector": "rj45" }),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{ports}");
    let (a, b) = (
        ports["ports"][0]["id"].as_i64().unwrap(),
        ports["ports"][1]["id"].as_i64().unwrap(),
    );
    let (s, v) = app
        .post(
            &c,
            "/api/connections",
            json!({ "kind": "patch", "a": { "port_id": a }, "b": { "port_id": b } }),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    let count = |sql: &'static str| {
        let pool = app.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sql)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    assert_eq!(
        count("SELECT COUNT(*) FROM devices WHERE name = 'Switch'").await,
        1
    );

    // Off (the default): gone from the source is only marked.
    {
        let mut d = mock.data.lock().unwrap();
        d["devices"].as_array_mut().unwrap().remove(1);
        d["wlans"].as_array_mut().unwrap().remove(1);
        d["users"].as_array_mut().unwrap().remove(0);
    }
    let (_, r) = app.post(&c, &sync, json!({})).await;
    assert_eq!(r["counts"]["device"]["missing"], 1, "{r}");
    assert_eq!(count("SELECT COUNT(*) FROM devices WHERE name = 'Switch' AND missing_from_source_at IS NOT NULL").await, 1);
    assert_eq!(
        count("SELECT COUNT(*) FROM wlans WHERE ssid = 'Old'").await,
        1
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM ip_addresses WHERE address = '192.168.1.10'").await,
        1
    );

    // On: what was already missing is removed at the next sync. A dry run
    // shows it first and changes nothing.
    let (s, v) = app
        .patch(
            &c,
            &format!("/api/integrations/{iid}"),
            json!({ "options": { "remove_missing": true } }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["options"]["remove_missing"], true);
    let (_, r) = app
        .post(&c, &format!("{sync}?dry_run=true"), json!({}))
        .await;
    assert_eq!(r["counts"]["device"]["removed"], 1, "{r}");
    assert_eq!(
        count("SELECT COUNT(*) FROM devices WHERE name = 'Switch'").await,
        1
    );
    let (_, r) = app.post(&c, &sync, json!({})).await;
    assert_eq!(r["counts"]["device"]["removed"], 1, "{r}");
    assert_eq!(r["counts"]["wlan"]["removed"], 1, "{r}");
    assert_eq!(
        r["counts"]["address"]["removed"], 2,
        "the NAS and the switch's address: {r}"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM devices WHERE name = 'Switch'").await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM wlans WHERE ssid = 'Old'").await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM ip_addresses WHERE address = '192.168.1.10'").await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM devices WHERE name = 'Gateway'").await,
        1,
        "the rest stays"
    );

    // In the change history, in the sync entry.
    let (_, log) = app.get(&c, "/api/audit?action=sync").await;
    assert!(log.to_string().contains("removed device"), "{log}");

    // A device with documented cables is kept, marked, with a warning.
    mock.data.lock().unwrap()["devices"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    let (_, r) = app.post(&c, &sync, json!({})).await;
    assert_eq!(r["counts"]["device"]["missing"], 1, "{r}");
    assert!(
        r["counts"]["device"]["removed"].as_u64().unwrap_or(0) == 0,
        "{r}"
    );
    assert!(r["warnings"].to_string().contains("kept"), "{r}");
    assert_eq!(
        count("SELECT COUNT(*) FROM devices WHERE name = 'Gateway'").await,
        1
    );
    assert_eq!(count("SELECT COUNT(*) FROM connections").await, 1);

    // Something removed at the source later goes in the same sync.
    mock.data.lock().unwrap()["networks"]
        .as_array_mut()
        .unwrap()
        .remove(1);
    let (_, r) = app.post(&c, &sync, json!({})).await;
    assert_eq!(r["counts"]["prefix"]["removed"], 1, "{r}");
    assert_eq!(
        count("SELECT COUNT(*) FROM prefixes WHERE cidr = '10.0.30.0/24'").await,
        0
    );
}
