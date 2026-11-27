//! Moving racks, floors and locations (POST /api/moves): dry runs report
//! exactly what a move does; moves between projects carry or unlink what
//! belongs to the old project.

mod common;

use common::*;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

async fn ok(app: &TestApp, c: &Client, path: &str, body: Value) -> Value {
    let (s, v) = app.post(c, path, body).await;
    assert!(s.is_success(), "{path}: {s} {v}");
    v
}
fn id(v: &Value) -> i64 {
    v["id"].as_i64().unwrap()
}
async fn mv(app: &TestApp, c: &Client, body: Value) -> (StatusCode, Value) {
    app.post(c, "/api/moves", body).await
}

#[tokio::test]
async fn racks_floors_and_locations_move_with_dry_runs() {
    let app = spawn().await;
    let c = app.owner().await;
    let a = app.project(&c, "A").await;
    let b = app.project(&c, "B").await;

    // A: HQ with floors 1 and 2, a rack on each, a switch in each, cabled.
    let hq = id(&ok(
        &app,
        &c,
        &format!("/api/projects/{a}/locations"),
        json!({ "code": "HQ" }),
    )
    .await);
    let f1 = id(&ok(
        &app,
        &c,
        &format!("/api/locations/{hq}/floors"),
        json!({ "code": "1", "level": 1 }),
    )
    .await);
    let f2 = id(&ok(
        &app,
        &c,
        &format!("/api/locations/{hq}/floors"),
        json!({ "code": "2", "level": 2 }),
    )
    .await);
    let r1 = id(&ok(
        &app,
        &c,
        &format!("/api/floors/{f1}/rooms"),
        json!({ "code": "R1" }),
    )
    .await);
    let r2 = id(&ok(
        &app,
        &c,
        &format!("/api/floors/{f2}/rooms"),
        json!({ "code": "R2" }),
    )
    .await);
    let r1b = id(&ok(
        &app,
        &c,
        &format!("/api/floors/{f1}/rooms"),
        json!({ "code": "R1B" }),
    )
    .await);
    let k1 = id(&ok(
        &app,
        &c,
        &format!("/api/rooms/{r1}/racks"),
        json!({ "code": "RK01" }),
    )
    .await);
    let k2 = id(&ok(
        &app,
        &c,
        &format!("/api/rooms/{r2}/racks"),
        json!({ "code": "RK01" }),
    )
    .await);
    let tpl = id(&ok(
        &app,
        &c,
        &format!("/api/projects/{a}/templates"),
        json!({ "name": "Edge 4", "device_type": "switch", "u_height": 1,
        "port_groups": [{ "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 4 }] }),
    )
    .await);
    let sw1 = id(&ok(&app, &c, &format!("/api/projects/{a}/devices"), json!({ "template_id": tpl, "code": "SW1", "placement": { "type": "rack", "rack_id": k1, "u": 10 } })).await);
    let sw2 = id(&ok(&app, &c, &format!("/api/projects/{a}/devices"), json!({ "device_type": "switch", "code": "SW2", "placement": { "type": "rack", "rack_id": k2, "u": 10 } })).await);
    let p1 = id(&ok(
        &app,
        &c,
        &format!("/api/devices/{sw2}/ports"),
        json!({ "code": "1" }),
    )
    .await);
    let (_, ports) = app.get(&c, &format!("/api/devices/{sw1}/ports")).await;
    let sw1p1 = id(&ports["ports"][0]);
    ok(
        &app,
        &c,
        "/api/connections",
        json!({ "a": { "port_id": sw1p1 }, "b": { "port_id": p1 }, "cable_type": "Cat6" }),
    )
    .await;

    // A rack moving to another floor: the dry run shows the cut cable and
    // changes nothing; then the move.
    let (s, dry) = mv(&app, &c, json!({ "resource": { "type": "rack", "id": k1 }, "target": { "room_id": r2 }, "dry_run": true })).await;
    assert_eq!(s, StatusCode::OK, "{dry}");
    assert_eq!(dry["report"]["cables_cut"].as_array().unwrap().len(), 1);
    assert_eq!(
        dry["report"]["code_clash"],
        json!({ "code": "RK01", "suggested": "RK01-2" })
    );
    assert_eq!(
        (dry["from"].as_str(), dry["to"].as_str()),
        (Some("A/HQ/1/R1/RK01"), Some("A/HQ/2/R2/RK01-2"))
    );
    let (_, still) = app.get(&c, &format!("/api/ports/{sw1p1}")).await;
    assert!(still["front"].is_object(), "a dry run changes nothing");
    let (s, e) = mv(
        &app,
        &c,
        json!({ "resource": { "type": "rack", "id": k1 }, "target": { "room_id": r2 } }),
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT, "the clash needs a code: {e}");
    // Within the same floor, cables stay.
    let (s, same) = mv(
        &app,
        &c,
        json!({ "resource": { "type": "rack", "id": k1 }, "target": { "room_id": r1b } }),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{same}");
    assert_eq!(same["report"]["cables_cut"], json!([]));

    // A floor to another location: code clash with suggestion, level kept
    // free, cables to the other floor cut.
    let branch = id(&ok(
        &app,
        &c,
        &format!("/api/projects/{a}/locations"),
        json!({ "code": "BR" }),
    )
    .await);
    ok(
        &app,
        &c,
        &format!("/api/locations/{branch}/floors"),
        json!({ "code": "1", "level": 1 }),
    )
    .await;
    let (_, dry) = mv(&app, &c, json!({ "resource": { "type": "floor", "id": f1 }, "target": { "location_id": branch }, "dry_run": true })).await;
    assert_eq!(dry["report"]["code_clash"]["suggested"], "1-2");
    assert_eq!(dry["to"], "A/BR/1-2");
    let (s, _) = mv(
        &app,
        &c,
        json!({ "resource": { "type": "floor", "id": f1 }, "target": { "location_id": branch } }),
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (s, moved) = mv(&app, &c, json!({ "resource": { "type": "floor", "id": f1 }, "target": { "location_id": branch }, "code": "1-2" })).await;
    assert_eq!(s, StatusCode::OK, "{moved}");
    assert_eq!(moved["report"]["cables_cut"].as_array().unwrap().len(), 1);
    let (_, f) = app.get(&c, &format!("/api/floors/{f1}")).await;
    assert_eq!(
        (f["code"].as_str(), f["level"].as_i64()),
        (Some("1-2"), Some(2))
    );
    let (_, dev) = app.get(&c, &format!("/api/devices/{sw1}")).await;
    assert_eq!(dev["path"], "A/BR/1-2/R1B/RK01/SW1");

    // Things that belong to project A: a VLAN on a port (B has the same
    // VLAN), a tag, an address, a diagram box, a responsible user who can
    // only see A.
    let v10 = id(&ok(
        &app,
        &c,
        &format!("/api/projects/{a}/vlans"),
        json!({ "vid": 10, "name": "Users" }),
    )
    .await);
    ok(
        &app,
        &c,
        &format!("/api/projects/{b}/vlans"),
        json!({ "vid": 10, "name": "Users" }),
    )
    .await;
    let v20 = id(&ok(
        &app,
        &c,
        &format!("/api/projects/{a}/vlans"),
        json!({ "vid": 20, "name": "Cams" }),
    )
    .await);
    let (s, _) = app
        .send(
            &c,
            reqwest::Method::PUT,
            &format!("/api/ports/{sw1p1}/vlans"),
            json!({ "untagged": v10, "tagged": [v20] }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let tag = id(&ok(
        &app,
        &c,
        &format!("/api/projects/{a}/tags"),
        json!({ "name": "core" }),
    )
    .await);
    app.send(
        &c,
        reqwest::Method::PUT,
        &format!("/api/devices/{sw1}/tags"),
        json!({ "tag_ids": [tag] }),
    )
    .await;
    ok(
        &app,
        &c,
        &format!("/api/projects/{a}/prefixes"),
        json!({ "cidr": "10.0.0.0/24" }),
    )
    .await;
    ok(
        &app,
        &c,
        &format!("/api/projects/{a}/addresses"),
        json!({ "address": "10.0.0.5", "device_id": sw1 }),
    )
    .await;
    ok(
        &app,
        &c,
        &format!("/api/projects/{a}/topologies"),
        json!({ "name": "Net", "nodes": [{ "key": "a", "device_id": sw1, "x": 0, "y": 0 }] }),
    )
    .await;
    let (_, ed) = app
        .post(&c, "/api/users", json!({ "username": "ed" }))
        .await;
    let ed_id = ed["user"]["id"].as_i64().unwrap();
    app.post(
        &c,
        &format!("/api/users/{ed_id}/grants"),
        json!({ "role": "editor", "scope_type": "project", "scope_id": a }),
    )
    .await;
    let (s, _) = app
        .patch(
            &c,
            &format!("/api/racks/{k1}"),
            json!({ "responsible_user_id": ed_id }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);

    // Someone who can only edit A can't move it into B (which they can't
    // even see: 404, not 403).
    let edc = client();
    let tmp = ed["temporary_password"].as_str().unwrap();
    app.login(&edc, "ed", tmp).await;
    app.post(
        &edc,
        "/api/auth/change-password",
        json!({ "current_password": tmp, "new_password": "ed-password-1" }),
    )
    .await;
    let (s, _) = mv(&app, &edc, json!({ "resource": { "type": "location", "id": branch }, "target": { "project_id": b }, "dry_run": true })).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Location BR to project B: the dry run lists what happens.
    let (s, dry) = mv(&app, &c, json!({ "resource": { "type": "location", "id": branch }, "target": { "project_id": b }, "dry_run": true })).await;
    assert_eq!(s, StatusCode::OK, "{dry}");
    let r = &dry["report"];
    assert_eq!(
        r["vlans"],
        json!([{ "vid": 10, "name": "Users", "action": "reused" }, { "vid": 20, "name": "Cams", "action": "copied" }])
    );
    assert_eq!(r["templates_copied"], json!(["Edge 4"]));
    assert_eq!(r["tags_copied"], json!(["core"]));
    assert_eq!(
        (
            r["addresses_unlinked"].as_i64(),
            r["diagram_boxes_unlinked"].as_i64()
        ),
        (Some(1), Some(1))
    );
    assert_eq!(r["responsible_cleared"], json!(["ed"]));
    assert_eq!(dry["project_changed"], true);
    let (_, d) = app.get(&c, &format!("/api/devices/{sw1}")).await;
    assert_eq!(d["project_id"], a, "dry run");

    let (s, done) = mv(
        &app,
        &c,
        json!({ "resource": { "type": "location", "id": branch }, "target": { "project_id": b } }),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{done}");
    let (_, d) = app.get(&c, &format!("/api/devices/{sw1}")).await;
    assert_eq!(
        (d["project_id"].as_i64(), d["path"].as_str()),
        (Some(b), Some("B/BR/1-2/R1B/RK01/SW1"))
    );
    assert_eq!(d["tags"][0]["name"], "core");
    let (_, tpls) = app.get(&c, &format!("/api/projects/{b}/templates")).await;
    let copy = tpls["templates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Edge 4")
        .unwrap();
    assert_eq!(d["template_id"], copy["id"]);
    let (_, port) = app.get(&c, &format!("/api/ports/{sw1p1}")).await;
    let (_, bvlans) = app.get(&c, &format!("/api/projects/{b}/vlans")).await;
    let b_ids: Vec<i64> = bvlans["vlans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_i64().unwrap())
        .collect();
    assert!(port["vlans"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| b_ids.contains(&v["id"].as_i64().unwrap())));
    let (_, addrs) = app.get(&c, &format!("/api/projects/{a}/addresses")).await;
    assert_eq!(addrs["addresses"][0]["device_id"], Value::Null);
    let (_, rack) = app.get(&c, &format!("/api/racks/{k1}")).await;
    assert_eq!(rack["responsible_user_id"], Value::Null);
    let (_, found) = app
        .get(&c, &format!("/api/search?q=SW1&project_id={b}"))
        .await;
    assert_eq!(found[0]["path"], "B/BR/1-2/R1B/RK01/SW1");
    let (_, hist) = app
        .get(
            &c,
            &format!("/api/audit?resource_type=location&action=move&project_id={b}"),
        )
        .await;
    assert_eq!(
        hist["entries"][0]["changes"]["path"],
        json!(["A/BR", "B/BR"])
    );
    // The template copy still drives the device: an edit reaches it.
    let (_, full) = app.get(&c, &format!("/api/templates/{}", copy["id"])).await;
    assert_eq!(full["device_count"], 1);
}
