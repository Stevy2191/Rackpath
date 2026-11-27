//! End-to-end tests for phase 6 beyond integrations: CSV import, tags,
//! topology diagrams, the lease layer, and upgrading a phase 5 database.

mod common;

use common::*;
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};

fn id(v: &Value) -> i64 {
    v["id"].as_i64().unwrap()
}

async fn post_ok(app: &TestApp, c: &Client, path: &str, body: Value) -> Value {
    let (s, v) = app.post(c, path, body).await;
    assert!(s.is_success(), "{path}: {s} {v}");
    v
}

async fn csv(
    app: &TestApp,
    c: &Client,
    project: i64,
    kind: &str,
    dry: bool,
    body: &str,
) -> (StatusCode, Value) {
    let r = c
        .post(app.url(&format!(
            "/api/projects/{project}/import/csv?kind={kind}&dry_run={dry}"
        )))
        .header("content-type", "text/csv")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    let s = r.status();
    (s, r.json().await.unwrap_or(Value::Null))
}

/// ACME with location HQ (floor 0), room MDF and rack RK01.
async fn site(app: &TestApp, c: &Client) -> i64 {
    let p = app.project(c, "ACME").await;
    let loc = post_ok(
        app,
        c,
        &format!("/api/projects/{p}/locations"),
        json!({ "code": "HQ" }),
    )
    .await;
    let (_, l) = app.get(c, &format!("/api/locations/{}", id(&loc))).await;
    let floor = l["floors"][0]["id"].as_i64().unwrap();
    let room = post_ok(
        app,
        c,
        &format!("/api/floors/{floor}/rooms"),
        json!({ "code": "MDF" }),
    )
    .await;
    post_ok(
        app,
        c,
        &format!("/api/rooms/{}/racks", id(&room)),
        json!({ "u_height": 42 }),
    )
    .await;
    p
}

#[tokio::test]
async fn csv_import_all_or_nothing() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = site(&app, &c).await;

    // Unknown columns are refused up front.
    let (s, e) = csv(
        &app,
        &c,
        p,
        "devices",
        false,
        "device_type,colour\nswitch,red\n",
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(
        e["error"]
            .as_str()
            .unwrap()
            .contains("Unknown column colour"),
        "{e}"
    );

    let devices = "Device_Type,code,rack,u,template,serial_number\n\
                   switch,SW01,HQ/0/MDF/RK01,40,switch-24,ABC1\n\
                   patch_panel,PP01,ACME/HQ/0/MDF/RK01,41,patch-panel-24,\n\
                   server,SRV01,HQ/0/MDF/RK01,40,,\n\
                   printer,PR01,,,,\n";
    // Row 4 overlaps SW01: nothing is saved, and the row is named.
    let (s, r) = csv(&app, &c, p, "devices", false, devices).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(r["applied"], false);
    assert_eq!(r["errors"][0]["row"], 4, "{r}");
    let (_, list) = app.get(&c, &format!("/api/projects/{p}/devices")).await;
    assert_eq!(list["devices"].as_array().unwrap().len(), 0);

    let fixed = devices.replace("SRV01,HQ/0/MDF/RK01,40", "SRV01,HQ/0/MDF/RK01,30");
    let (_, dry) = csv(&app, &c, p, "devices", true, &fixed).await;
    assert_eq!(dry["errors"], json!([]), "{dry}");
    assert_eq!(dry["applied"], false);
    let (_, r) = csv(&app, &c, p, "devices", false, &fixed).await;
    assert_eq!(r["applied"], true, "{r}");
    assert_eq!(r["created"][0], "ACME/HQ/0/MDF/RK01/SW01");
    assert_eq!(r["created"][3], "ACME/UNPLACED/PR01");
    let (_, list) = app.get(&c, &format!("/api/projects/{p}/devices")).await;
    let sw = list["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["code"] == "SW01")
        .unwrap()
        .clone();
    assert_eq!(sw["source"], "csv_import");
    assert!(sw["template_id"].is_number());
    let (_, ports) = app
        .get(&c, &format!("/api/devices/{}/ports", id(&sw)))
        .await;
    assert_eq!(
        ports["ports"].as_array().unwrap().len(),
        29,
        "ports came from the template"
    );

    // Ports, connections and IPAM by path.
    let (_, r) = csv(
        &app,
        &c,
        p,
        "ports",
        false,
        "device,code,connector\nUNPLACED/PR01,ETH1,RJ45\n",
    )
    .await;
    assert_eq!(r["applied"], true, "{r}");
    let (_, r) = csv(&app, &c, p, "connections", false,
        "a,b,kind,cable_type\nHQ/0/MDF/RK01/PP01/1,HQ/0/MDF/RK01/PP01/2,permanent,Cat6a\nHQ/0/MDF/RK01/SW01/1,HQ/0/MDF/RK01/PP01/1,patch,Cat6a\n").await;
    assert_eq!(r["applied"], true, "{r}");
    post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/vlans"),
        json!({ "vid": 10, "name": "Users" }),
    )
    .await;
    let (_, r) = csv(&app, &c, p, "prefixes", false,
        "cidr,vlan,role,gateway,location\n10.1.0.0/24,10,users,10.1.0.1,HQ\n10.2.0.0/24,,servers,,\n").await;
    assert_eq!(r["applied"], true, "{r}");
    let (_, r) = csv(
        &app,
        &c,
        p,
        "ranges",
        false,
        "prefix,start,end,kind\n10.1.0.0/24,10.1.0.100,10.1.0.199,dhcp_pool\n",
    )
    .await;
    assert_eq!(r["applied"], true, "{r}");
    let (_, r) = csv(&app, &c, p, "addresses", false,
        "address,port,dns_name,dns_aliases,dhcp_reservation,mac\n10.1.0.2,HQ/0/MDF/RK01/SW01/1,sw01.acme.lan,core;core-sw,no,\n10.1.0.120,,printer.acme.lan,,yes,aa:bb:cc:00:00:01\n").await;
    assert_eq!(r["applied"], true, "{r}");
    let (_, a) = app
        .get(&c, &format!("/api/projects/{p}/addresses?q=10.1.0.2"))
        .await;
    assert_eq!(a["addresses"][0]["dns_aliases"], json!(["core", "core-sw"]));
    assert_eq!(a["addresses"][0]["device_id"], id(&sw));
    let (_, r) = csv(
        &app,
        &c,
        p,
        "addresses",
        false,
        "address,device\n10.9.9.9,NOWHERE/X\n",
    )
    .await;
    assert!(
        r["errors"][0]["message"]
            .as_str()
            .unwrap()
            .contains("No device at NOWHERE/X"),
        "{r}"
    );

    // A reader can't import.
    let (rid, reader) = app.user(&c, "reader").await;
    app.grant(&c, rid, "reader", "project", Some(p)).await;
    let (_, r) = csv(&app, &reader, p, "prefixes", false, "cidr\n10.3.0.0/24\n").await;
    assert_eq!(r["applied"], false);
    assert!(
        r["errors"][0]["message"]
            .as_str()
            .unwrap()
            .contains("permission"),
        "{r}"
    );

    // One grouped entry in the history per applied file.
    let (_, log) = app.get(&c, "/api/audit?resource_type=csv").await;
    assert_eq!(log["entries"].as_array().unwrap().len(), 6);
}

#[tokio::test]
async fn tags_and_diagrams() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = site(&app, &c).await;
    let a = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/devices"),
        json!({ "device_type": "router", "code": "RT01" }),
    )
    .await;
    let b = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/devices"),
        json!({ "device_type": "firewall", "code": "FW01" }),
    )
    .await;
    let other = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/devices"),
        json!({ "device_type": "server", "code": "SRV9" }),
    )
    .await;

    // Tags.
    let core = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/tags"),
        json!({ "name": "Core", "color": "#FF0000" }),
    )
    .await;
    let (s, _) = app
        .post(
            &c,
            &format!("/api/projects/{p}/tags"),
            json!({ "name": "core" }),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "names are case-insensitive");
    let (s, _) = app
        .send(
            &c,
            Method::PUT,
            &format!("/api/devices/{}/tags", id(&a)),
            json!({ "tag_ids": [id(&core)] }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (_, d) = app.get(&c, &format!("/api/devices/{}", id(&a))).await;
    assert_eq!(d["tags"][0]["name"], "Core");
    assert_eq!(d["tags"][0]["color"], "#ff0000");
    let (_, list) = app
        .get(&c, &format!("/api/projects/{p}/devices?tag=core"))
        .await;
    assert_eq!(list["devices"].as_array().unwrap().len(), 1);
    let (_, tags) = app.get(&c, &format!("/api/projects/{p}/tags")).await;
    assert_eq!(tags["tags"][0]["device_count"], 1);

    // A diagram; an edge backed by the cable between the two devices.
    let pa = post_ok(
        &app,
        &c,
        &format!("/api/devices/{}/ports", id(&a)),
        json!({ "code": "1" }),
    )
    .await;
    let pb = post_ok(
        &app,
        &c,
        &format!("/api/devices/{}/ports", id(&b)),
        json!({ "code": "1" }),
    )
    .await;
    // Devices must be placed to be cabled.
    let (_, rooms) = app.get(&c, &format!("/api/projects/{p}/locations")).await;
    let _ = rooms;
    let (_, racks) = app.get(&c, "/api/search?q=RK01&kind=rack").await;
    let rack = racks[0]["id"].as_i64().unwrap();
    for (d, u) in [(&a, 10), (&b, 12)] {
        app.patch(
            &c,
            &format!("/api/devices/{}", id(d)),
            json!({ "placement": { "type": "rack", "rack_id": rack, "u": u } }),
        )
        .await;
    }
    let cable = post_ok(
        &app,
        &c,
        "/api/connections",
        json!({ "a": { "port_id": id(&pa) }, "b": { "port_id": id(&pb) } }),
    )
    .await;
    let diagram = json!({
        "name": "Edge", "viewport": { "zoom": 1 },
        "nodes": [
            { "key": "rt", "device_id": id(&a), "x": 0, "y": 0 },
            { "key": "fw", "device_id": id(&b), "x": 200, "y": 0, "style": { "color": "#333" } },
            { "key": "cloud", "label": "Internet", "x": -200, "y": 0 },
        ],
        "edges": [
            { "source": "rt", "target": "fw", "connection_id": id(&cable), "label": "inside" },
            { "source": "cloud", "target": "rt" },
        ],
        "items": [ { "kind": "zone", "x": -50, "y": -50, "width": 400, "height": 200, "text": "DMZ" } ],
    });
    let t = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/topologies"),
        diagram.clone(),
    )
    .await;
    assert_eq!(t["nodes"][0]["device"]["code"], "RT01");
    assert_eq!(t["edges"][0]["cable"]["chain_state"], "complete");
    assert_eq!(
        t["edges"][0]["cable"]["ends"][0],
        "ACME/HQ/0/MDF/RK01/RT01/1"
    );
    assert_eq!(t["version"], 1);

    // Wrong cable for the nodes, unknown node keys, another project's device.
    let mut bad = diagram.clone();
    bad["name"] = json!("Bad");
    bad["nodes"][1]["device_id"] = json!(id(&other));
    let (s, e) = app
        .post(&c, &format!("/api/projects/{p}/topologies"), bad)
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{e}");
    let mut bad = diagram.clone();
    bad["name"] = json!("Bad");
    bad["edges"][1]["source"] = json!("nope");
    let (s, _) = app
        .post(&c, &format!("/api/projects/{p}/topologies"), bad)
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Saving replaces the whole diagram; a stale version is refused.
    let mut v2 = diagram.clone();
    v2["edges"] = json!([]);
    v2["expected_version"] = json!(1);
    let (s, t2) = app
        .send(
            &c,
            Method::PUT,
            &format!("/api/topologies/{}", id(&t)),
            v2.clone(),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{t2}");
    assert_eq!(t2["edges"], json!([]));
    assert_eq!(t2["version"], 2);
    let (s, _) = app
        .send(&c, Method::PUT, &format!("/api/topologies/{}", id(&t)), v2)
        .await;
    assert_eq!(s, StatusCode::CONFLICT);

    // Deleting a device keeps its node, unlinked.
    app.delete(&c, &format!("/api/devices/{}", id(&a)), json!({}))
        .await;
    let (_, t3) = app.get(&c, &format!("/api/topologies/{}", id(&t))).await;
    assert_eq!(t3["nodes"][0]["device_id"], Value::Null);
    let (_, list) = app.get(&c, &format!("/api/projects/{p}/topologies")).await;
    assert_eq!(list["topologies"][0]["node_count"], 3);
}

#[tokio::test]
async fn upgrades_a_phase_5_database() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase5.db");
    let app = spawn_on(&fixture, "owner-password-1").await;
    let c = client();
    assert_eq!(
        app.login(&c, "admin", "owner-password-1").await.0,
        StatusCode::OK
    );
    let (_, projects) = app.get(&c, "/api/projects").await;
    let p = projects[0]["id"].as_i64().unwrap();
    // Earlier data intact.
    let (_, t) = app.get(&c, "/api/ports/1/trace").await;
    assert_eq!(t["state"], "complete");
    let (_, power) = app.get(&c, "/api/devices/4/power").await;
    assert_eq!(power["power"]["capacity_va"], 1500, "{power}");
    let (_, d) = app.get(&c, "/api/devices/1").await;
    assert_eq!(d["tags"], json!([]));
    assert_eq!(d["source_integration_id"], Value::Null);
    // Phase 6 features work on it.
    let i = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/integrations"),
        json!({ "kind": "windows_dhcp", "name": "DC" }),
    )
    .await;
    assert!(i["token"].is_string());
    let (_, r) = csv(&app, &c, p, "prefixes", false, "cidr\n10.50.0.0/24\n").await;
    assert_eq!(r["applied"], true, "{r}");
}
