//! End-to-end tests for phase 5: device templates (built-ins, duplicates,
//! devices made from them, safe edits with dry run) and power (cords,
//! loads, failover, runtime, outlet use).

mod common;

use common::*;
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};

fn id(v: &Value) -> i64 {
    v["id"].as_i64().unwrap()
}

async fn post_ok(app: &TestApp, c: &Client, path: &str, body: Value) -> Value {
    let (s, v) = app.post(c, path, body).await;
    assert_eq!(s, StatusCode::CREATED, "{path}: {v}");
    v
}

struct Site {
    project: i64,
    rack: i64,
    room: i64,
}

async fn site(app: &TestApp, c: &Client) -> Site {
    let project = app.project(c, "ACME").await;
    let loc = post_ok(
        app,
        c,
        &format!("/api/projects/{project}/locations"),
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
    let rack = post_ok(
        app,
        c,
        &format!("/api/rooms/{}/racks", id(&room)),
        json!({ "u_height": 42 }),
    )
    .await;
    Site {
        project,
        rack: id(&rack),
        room: id(&room),
    }
}

async fn builtin(app: &TestApp, c: &Client, project: i64, key: &str) -> i64 {
    let (_, list) = app
        .get(c, &format!("/api/projects/{project}/templates"))
        .await;
    list["templates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["builtin_key"] == key)
        .unwrap_or_else(|| panic!("no built-in {key}"))["id"]
        .as_i64()
        .unwrap()
}

async fn from_template(app: &TestApp, c: &Client, s: &Site, template: i64, u: f64) -> Value {
    post_ok(
        app,
        c,
        &format!("/api/projects/{}/devices", s.project),
        json!({ "template_id": template, "placement": { "type": "rack", "rack_id": s.rack, "u": u } }),
    )
    .await
}

/// Port codes of a device -> port id.
async fn ports_of(
    app: &TestApp,
    c: &Client,
    device: i64,
) -> std::collections::HashMap<String, i64> {
    let (_, l) = app.get(c, &format!("/api/devices/{device}/ports")).await;
    l["ports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["code"].as_str().unwrap().to_string(), id(p)))
        .collect()
}

#[tokio::test]
async fn built_in_templates_make_devices() {
    let app = spawn().await;
    let c = app.owner().await;
    let s = site(&app, &c).await;
    let (_, list) = app
        .get(&c, &format!("/api/projects/{}/templates", s.project))
        .await;
    assert!(list["templates"].as_array().unwrap().len() >= 15, "{list}");

    let sw = builtin(&app, &c, s.project, "switch-48").await;
    let (_, t) = app.get(&c, &format!("/api/templates/{sw}")).await;
    let codes: Vec<&str> = t["ports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes.len(), 54);
    assert_eq!(&codes[..2], ["1", "2"]);
    assert_eq!(t["ports"][1]["row"], 1, "2 sits below 1");
    assert!(codes.contains(&"X4") && codes.contains(&"PSU2"));
    assert_eq!(t["builtin"], true);

    // A device from it gets its ports, height and power figures.
    let d = from_template(&app, &c, &s, sw, 20.0).await;
    assert_eq!(d["device_type"]["key"], "switch");
    assert_eq!(d["template_id"], sw);
    assert_eq!(d["code"], "SW01");
    let (_, ports) = app.get(&c, &format!("/api/devices/{}/ports", id(&d))).await;
    let ports = ports["ports"].as_array().unwrap();
    assert_eq!(ports.len(), 54);
    let psu = ports.iter().find(|p| p["code"] == "PSU1").unwrap();
    assert_eq!(psu["medium"], "power");
    assert_eq!(psu["connector"], "C14");
    assert_eq!(psu["from_template"], true);
    let (_, dev) = app.get(&c, &format!("/api/devices/{}", id(&d))).await;
    assert_eq!(dev["power"]["typical_w"], 60);

    // A vertical PDU is zero-U and mounts on the side.
    let pdu = builtin(&app, &c, s.project, "pdu-vertical-24").await;
    let v = post_ok(
        &app,
        &c,
        &format!("/api/projects/{}/devices", s.project),
        json!({ "template_id": pdu, "placement": { "type": "rack", "rack_id": s.rack } }),
    )
    .await;
    assert_eq!(v["placement"]["mount"], "zero_u_left");
    assert_eq!(ports_of(&app, &c, id(&v)).await.len(), 25);

    // Built-ins can't be edited, only duplicated.
    let (st, _) = app
        .send(&c, Method::PUT, &format!("/api/templates/{sw}"), t.clone())
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let copy = post_ok(
        &app,
        &c,
        &format!("/api/templates/{sw}/duplicate"),
        json!({ "project_id": s.project }),
    )
    .await;
    assert_eq!(copy["builtin"], false);
    assert_eq!(copy["name"], "Switch, 48 ports + 4 SFP+");

    // The type comes from the template.
    let (st, _) = app
        .post(
            &c,
            &format!("/api/projects/{}/devices", s.project),
            json!({ "template_id": sw, "device_type": "server", "placement": { "type": "unplaced" } }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // Template ports can't be renamed on the device.
    let one = ports_of(&app, &c, id(&d)).await["1"];
    let (st, _) = app
        .patch(&c, &format!("/api/ports/{one}"), json!({ "code": "GI1" }))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = app
        .patch(
            &c,
            &format!("/api/ports/{one}"),
            json!({ "description": "uplink" }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn template_edits_keep_cables_and_need_confirmation() {
    let app = spawn().await;
    let c = app.owner().await;
    let s = site(&app, &c).await;
    let p = s.project;
    let panel = json!({
        "name": "Panel 24", "device_type": "patch_panel", "u_height": 1, "manufacturer": "Acme",
        "port_groups": [ { "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 24, "connector": "RJ45" } ],
    });
    let t = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/templates"),
        panel.clone(),
    )
    .await;
    let tid = id(&t);
    assert_eq!(t["ports"].as_array().unwrap().len(), 24);
    // Bad layouts are refused.
    let (st, e) = app
        .post(
            &c,
            &format!("/api/projects/{p}/templates"),
            json!({ "name": "Bad", "device_type": "patch_panel", "u_height": 1,
                    "port_groups": [ { "grid_row": 0, "grid_col": 0, "rows": 3, "cols": 2 } ] }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{e}");
    let (st, _) = app
        .post(
            &c,
            &format!("/api/projects/{p}/templates"),
            json!({ "name": "Bad", "device_type": "patch_panel", "u_height": 1,
                    "port_groups": [ { "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 2, "connector": "XLR" } ] }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    let a = from_template(&app, &c, &s, tid, 10.0).await;
    let b = from_template(&app, &c, &s, tid, 11.0).await;
    let blocker = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/devices"),
        json!({ "device_type": "server", "placement": { "type": "rack", "rack_id": s.rack, "u": 13 } }),
    )
    .await;
    // Customise B's manufacturer; cable A's ports 1 and 24 to B's.
    app.patch(
        &c,
        &format!("/api/devices/{}", id(&b)),
        json!({ "manufacturer": "Other" }),
    )
    .await;
    let (pa, pb) = (
        ports_of(&app, &c, id(&a)).await,
        ports_of(&app, &c, id(&b)).await,
    );
    for code in ["1", "24"] {
        post_ok(
            &app,
            &c,
            "/api/connections",
            json!({ "kind": "permanent", "a": { "port_id": pa[code] }, "b": { "port_id": pb[code] } }),
        )
        .await;
    }

    // Shrink to 16 ports, add 2 fibre ports, new manufacturer.
    let mut smaller = panel.clone();
    smaller["manufacturer"] = json!("Acme Corp");
    smaller["port_groups"] = json!([
        { "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 16, "connector": "RJ45" },
        { "grid_row": 0, "grid_col": 20, "rows": 1, "cols": 2, "prefix": "F", "connector": "LC" },
    ]);
    let (st, dry) = app
        .send(
            &c,
            Method::PUT,
            &format!("/api/templates/{tid}?dry_run=true"),
            smaller.clone(),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{dry}");
    assert_eq!(dry["needs_confirmation"], true);
    let da = dry["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["device_id"] == id(&a))
        .unwrap();
    assert_eq!(da["ports_removed"].as_array().unwrap().len(), 8);
    assert_eq!(da["ports_added"], json!(["F1", "F2"]));
    assert_eq!(da["cables_removed"].as_array().unwrap().len(), 1, "{da}");
    assert!(da["cables_removed"][0]
        .as_str()
        .unwrap()
        .contains("PP01/24"));
    // Nothing changed yet.
    assert_eq!(ports_of(&app, &c, id(&a)).await.len(), 24);
    let (_, tnow) = app.get(&c, &format!("/api/templates/{tid}")).await;
    assert_eq!(tnow["version"], 1);

    // Applying needs the name.
    let (st, r) = app
        .send(
            &c,
            Method::PUT,
            &format!("/api/templates/{tid}"),
            smaller.clone(),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT, "{r}");
    smaller["confirm_name"] = json!("Panel 24");
    let (st, r) = app
        .send(
            &c,
            Method::PUT,
            &format!("/api/templates/{tid}"),
            smaller.clone(),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{r}");
    assert_eq!(r["version"], 2);
    let after = ports_of(&app, &c, id(&a)).await;
    assert_eq!(after.len(), 18);
    assert_eq!(after["1"], pa["1"], "kept ports keep their id");
    let (_, t1) = app
        .get(&c, &format!("/api/ports/{}/trace", after["1"]))
        .await;
    assert_eq!(t1["hops"].as_array().unwrap().len(), 3, "and their cable");
    let (_, dev_a) = app.get(&c, &format!("/api/devices/{}", id(&a))).await;
    let (_, dev_b) = app.get(&c, &format!("/api/devices/{}", id(&b))).await;
    assert_eq!(dev_a["manufacturer"], "Acme Corp");
    assert_eq!(dev_b["manufacturer"], "Other", "customised values stay");
    assert_eq!(dev_a["template_version"], 2);

    // Growing to 2U: A (U10) would overlap B (U11), so A moves to Unplaced;
    // B then has room (the server is at U13).
    smaller["u_height"] = json!(2);
    let (_, dry) = app
        .send(
            &c,
            Method::PUT,
            &format!("/api/templates/{tid}?dry_run=true"),
            smaller.clone(),
        )
        .await;
    let unplaced: Vec<i64> = dry["devices"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["unplaced"] == true)
        .map(|d| d["device_id"].as_i64().unwrap())
        .collect();
    assert_eq!(unplaced.len(), 1, "{dry}");
    let (st, _) = app
        .send(
            &c,
            Method::PUT,
            &format!("/api/templates/{tid}"),
            smaller.clone(),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let (_, moved) = app.get(&c, &format!("/api/devices/{}", unplaced[0])).await;
    assert_eq!(moved["placement"]["type"], "unplaced");
    let _ = blocker;

    // Deleting the template leaves the devices and their ports.
    let (st, _) = app
        .delete(&c, &format!("/api/templates/{tid}"), json!({}))
        .await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (_, dev_a) = app.get(&c, &format!("/api/devices/{}", id(&a))).await;
    assert_eq!(dev_a["template_id"], Value::Null);
    let one = ports_of(&app, &c, id(&a)).await["1"];
    let (st, _) = app
        .patch(&c, &format!("/api/ports/{one}"), json!({ "code": "A1" }))
        .await;
    assert_eq!(st, StatusCode::OK, "independent ports can be renamed");

    // The change history records the template edits.
    let (_, log) = app
        .get(&c, "/api/audit?resource_type=device_template")
        .await;
    assert!(log["entries"].as_array().unwrap().len() >= 4);
    let _ = s.room;
}

#[tokio::test]
async fn power_loads_failover_and_runtime() {
    let app = spawn().await;
    let c = app.owner().await;
    let s = site(&app, &c).await;
    let ups_t = builtin(&app, &c, s.project, "ups-1500").await;
    let pdu_t = builtin(&app, &c, s.project, "pdu-horizontal-8").await;
    let srv_t = builtin(&app, &c, s.project, "server-1u").await;
    let ebm_t = builtin(&app, &c, s.project, "ebm").await;
    let ups_a = from_template(&app, &c, &s, ups_t, 1.0).await;
    let ups_b = from_template(&app, &c, &s, ups_t, 3.0).await;
    let ebm = from_template(&app, &c, &s, ebm_t, 5.0).await;
    let pdu_a = from_template(&app, &c, &s, pdu_t, 10.0).await;
    let pdu_b = from_template(&app, &c, &s, pdu_t, 11.0).await;
    let srv1 = from_template(&app, &c, &s, srv_t, 20.0).await;
    let srv2 = from_template(&app, &c, &s, srv_t, 21.0).await;
    let (ua, ub, eb) = (
        ports_of(&app, &c, id(&ups_a)).await,
        ports_of(&app, &c, id(&ups_b)).await,
        ports_of(&app, &c, id(&ebm)).await,
    );
    let (pa, pb) = (
        ports_of(&app, &c, id(&pdu_a)).await,
        ports_of(&app, &c, id(&pdu_b)).await,
    );
    let (s1, s2) = (
        ports_of(&app, &c, id(&srv1)).await,
        ports_of(&app, &c, id(&srv2)).await,
    );
    let cord = |a: i64, b: i64| json!({ "kind": "power", "a": { "port_id": a }, "b": { "port_id": b }, "cable_type": "Power cord" });

    // UPS outlet (NEMA 5-15R) to PDU inlet (C20): allowed, with a warning.
    let r = post_ok(&app, &c, "/api/connections", cord(ua["OUT1"], pa["IN1"])).await;
    assert_eq!(r["warnings"].as_array().unwrap().len(), 1, "{r}");
    post_ok(&app, &c, "/api/connections", cord(ub["OUT1"], pb["IN1"])).await;
    post_ok(&app, &c, "/api/connections", cord(pa["1"], s1["PSU1"])).await;
    post_ok(&app, &c, "/api/connections", cord(pb["1"], s1["PSU2"])).await;
    post_ok(&app, &c, "/api/connections", cord(pa["2"], s2["PSU1"])).await;
    post_ok(
        &app,
        &c,
        "/api/connections",
        json!({ "kind": "power", "a": { "port_id": ua["BAT1"] }, "b": { "port_id": eb["BAT1"] }, "cable_type": "Battery cable" }),
    )
    .await;

    // Wrong combinations.
    let (st, _) = app
        .post(&c, "/api/connections", cord(pa["3"], pb["3"]))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "two outlets");
    let (st, _) = app
        .post(
            &c,
            "/api/connections",
            json!({ "kind": "patch", "a": { "port_id": pa["4"] }, "b": { "port_id": s2["PSU2"] } }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "power needs kind power");
    let (st, _) = app
        .post(&c, "/api/connections", cord(s1["ETH1"], s2["ETH1"]))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "network ports aren't power");
    let (st, _) = app
        .post(&c, "/api/connections", cord(ub["BAT1"], s2["PSU2"]))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "battery only to battery");

    // Servers draw 150 W typical, PDUs 5 W, UPSes 20 W.
    let (st, rp) = app.get(&c, &format!("/api/racks/{}/power", s.rack)).await;
    assert_eq!(st, StatusCode::OK, "{rp}");
    let dev = |d: &Value| {
        rp["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["device_id"] == id(d))
            .cloned()
            .unwrap()
    };
    assert_eq!(
        dev(&pdu_a)["output_w"],
        225.0,
        "75 (half of srv1) + 150 (srv2)"
    );
    assert_eq!(dev(&pdu_b)["output_w"], 75.0);
    assert_eq!(dev(&ups_a)["output_w"], 230.0);
    assert_eq!(dev(&pdu_a)["failover_w"], 300.0);
    assert_eq!(dev(&ups_a)["failover_w"], 305.0);
    assert_eq!(dev(&ups_a)["load_pct"], 23.0);
    // 42.3 min from the UPS curve at 230 W, plus 84.7 from the battery module.
    assert_eq!(dev(&ups_a)["runtime_min"], 127.0);
    assert_eq!(dev(&ups_a)["battery_modules"], json!([id(&ebm)]));
    assert_eq!(
        dev(&ups_b)["runtime_min"],
        90.0,
        "80 W is below the first point of the curve"
    );
    assert_eq!(dev(&ups_a)["outlets"]["total"], 6);
    assert_eq!(dev(&ups_a)["outlets"]["used"], 1);
    assert_eq!(dev(&pdu_a)["outlets"]["used"], 2);
    let w2 = dev(&srv2)["warnings"].to_string();
    assert!(w2.contains("Only one of its power inlets"), "{w2}");
    assert_eq!(rp["totals"]["ups_count"], 2);
    assert_eq!(rp["totals"]["ups_capacity_va"], 3000);
    assert_eq!(rp["totals"]["ups_redundant_va"], 1500);

    // Recording a bigger draw changes the loads.
    let (st, _) = app
        .send(
            &c,
            Method::PUT,
            &format!("/api/devices/{}/power", id(&srv2)),
            json!({ "typical_w": 950, "max_w": 1200 }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let (_, one) = app
        .get(&c, &format!("/api/devices/{}/power", id(&pdu_a)))
        .await;
    assert_eq!(one["output_w"], 1025.0);
    let (_, ups) = app
        .get(&c, &format!("/api/devices/{}/power", id(&ups_a)))
        .await;
    assert!(ups["warnings"].to_string().contains("Overloaded"), "{ups}");
    let (st, _) = app
        .send(
            &c,
            Method::PUT,
            &format!("/api/devices/{}/power", id(&srv2)),
            json!({ "typical_w": -1 }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn upgrades_a_phase_4_database() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase4.db");
    let app = spawn_on(&fixture, "owner-password-1").await;
    let c = client();
    assert_eq!(
        app.login(&c, "admin", "owner-password-1").await.0,
        StatusCode::OK
    );
    let (_, projects) = app.get(&c, "/api/projects").await;
    let p = projects[0]["id"].as_i64().unwrap();
    // Older data intact.
    let (_, a) = app.get(&c, "/api/addresses/1").await;
    assert_eq!(a["port_path"], "HOME/HOUSE/0/CLOSET/RK01/SW01/1");
    let (_, t) = app.get(&c, "/api/ports/1/trace").await;
    assert_eq!(t["state"], "complete");
    let (_, port) = app.get(&c, "/api/ports/1").await;
    assert_eq!(port["from_template"], false);
    // Built-ins appear and can be used in the existing project.
    let (_, list) = app.get(&c, &format!("/api/projects/{p}/templates")).await;
    let ups = list["templates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["builtin_key"] == "ups-1500")
        .unwrap()["id"]
        .clone();
    let d = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/devices"),
        json!({ "template_id": ups, "placement": { "type": "rack", "rack_id": 1, "u": 1 } }),
    )
    .await;
    let (_, power) = app.get(&c, &format!("/api/devices/{}/power", id(&d))).await;
    assert_eq!(power["power"]["capacity_va"], 1500);
}
