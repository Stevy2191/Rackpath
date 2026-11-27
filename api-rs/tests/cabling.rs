//! End-to-end tests for phase 3: ports, cables, side rules, media checks,
//! tracing, cable cuts on moves, VLANs, WLANs and permissions.

mod common;

use common::*;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

struct Site {
    project: i64,
    floor: i64,
    mdf: i64,
    office: i64,
    rack: i64,
}

async fn site(app: &TestApp, c: &Client) -> Site {
    let project = app.project(c, "ACME").await;
    let (_, loc) = app
        .post(
            c,
            &format!("/api/projects/{project}/locations"),
            json!({ "code": "HQ" }),
        )
        .await;
    let (_, floor) = app
        .post(
            c,
            &format!("/api/locations/{}/floors", loc["id"]),
            json!({ "code": "2", "level": 2 }),
        )
        .await;
    let floor = floor["id"].as_i64().unwrap();
    let (_, mdf) = app
        .post(
            c,
            &format!("/api/floors/{floor}/rooms"),
            json!({ "code": "MDF" }),
        )
        .await;
    let (_, office) = app
        .post(
            c,
            &format!("/api/floors/{floor}/rooms"),
            json!({ "code": "OFFICE" }),
        )
        .await;
    let mdf = mdf["id"].as_i64().unwrap();
    let (_, rack) = app
        .post(
            c,
            &format!("/api/rooms/{mdf}/racks"),
            json!({ "u_height": 42 }),
        )
        .await;
    Site {
        project,
        floor,
        mdf,
        office: office["id"].as_i64().unwrap(),
        rack: rack["id"].as_i64().unwrap(),
    }
}

async fn device(app: &TestApp, c: &Client, project: i64, body: Value) -> i64 {
    let (s, d) = app
        .post(c, &format!("/api/projects/{project}/devices"), body)
        .await;
    assert_eq!(s, StatusCode::CREATED, "{d}");
    d["id"].as_i64().unwrap()
}

/// Bulk-creates ports and returns their ids in order.
async fn ports(app: &TestApp, c: &Client, device: i64, body: Value) -> Vec<i64> {
    let (s, r) = app
        .post(c, &format!("/api/devices/{device}/ports/bulk"), body)
        .await;
    assert_eq!(s, StatusCode::CREATED, "{r}");
    r["ports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_i64().unwrap())
        .collect()
}

async fn cable(app: &TestApp, c: &Client, body: Value) -> (StatusCode, Value) {
    app.post(c, "/api/connections", body).await
}

fn patch(a: i64, b: i64) -> Value {
    json!({ "kind": "patch", "a": { "port_id": a }, "b": { "port_id": b } })
}

/// The office chain from the design: switch → panel ═ outlet → access point.
struct Office {
    s: Site,
    sw: i64,
    sw_ports: Vec<i64>,
    pp: i64,
    pp_ports: Vec<i64>,
    to_ports: Vec<i64>,
    ap: i64,
    ap_port: i64,
}

async fn office(app: &TestApp, c: &Client) -> Office {
    let s = site(app, c).await;
    let sw = device(
        app,
        c,
        s.project,
        json!({ "device_type": "switch", "placement": { "type": "rack", "rack_id": s.rack, "u": 40 } }),
    )
    .await;
    let pp = device(
        app,
        c,
        s.project,
        json!({ "device_type": "patch_panel", "placement": { "type": "rack", "rack_id": s.rack, "u": 41 } }),
    )
    .await;
    let to = device(
        app,
        c,
        s.project,
        json!({ "device_type": "wall_outlet", "placement": { "type": "room", "room_id": s.office } }),
    )
    .await;
    let ap = device(
        app,
        c,
        s.project,
        json!({ "device_type": "access_point", "placement": { "type": "room", "room_id": s.office } }),
    )
    .await;
    let sw_ports = ports(app, c, sw, json!({ "count": 24, "speed": 1000 })).await;
    let pp_ports = ports(app, c, pp, json!({ "count": 24 })).await;
    let to_ports = ports(app, c, to, json!({ "count": 2 })).await;
    let ap_port = ports(
        app,
        c,
        ap,
        json!({ "count": 1, "speed": 2500, "poe": "at" }),
    )
    .await[0];
    Office {
        s,
        sw,
        sw_ports,
        pp,
        pp_ports,
        to_ports,
        ap,
        ap_port,
    }
}

#[tokio::test]
async fn ports_have_codes_defaults_and_paths() {
    let app = spawn().await;
    let c = app.owner().await;
    let o = office(&app, &c).await;

    let (_, list) = app.get(&c, &format!("/api/devices/{}/ports", o.pp)).await;
    let first = &list["ports"][0];
    assert_eq!(first["code"], "01", "padded to the largest number");
    assert_eq!(first["role"], "passive", "patch-panel ports are passive");
    assert_eq!(first["connector"], "RJ45");
    assert_eq!(first["medium"], "copper");
    assert_eq!(first["path"], "ACME/HQ/2/MDF/RK01/PP01/01");
    assert_eq!(first["chain_state"], "unconnected");
    assert_eq!(list["ports"].as_array().unwrap().len(), 24);

    let (_, sw) = app.get(&c, &format!("/api/ports/{}", o.sw_ports[0])).await;
    assert_eq!(sw["role"], "active");
    assert_eq!(sw["speed"], 1000);

    // Codes are unique per device and at most 10 characters.
    let (s, _) = app
        .post(
            &c,
            &format!("/api/devices/{}/ports", o.sw),
            json!({ "code": "01" }),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (s, _) = app
        .post(
            &c,
            &format!("/api/devices/{}/ports", o.sw),
            json!({ "code": "ABCDEFGHIJK" }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Cage ports and transceivers.
    let (s, sfp) = app
        .post(
            &c,
            &format!("/api/devices/{}/ports", o.sw),
            json!({ "code": "X1", "connector": "sfp+", "interface_name": "Te1/0/1" }),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{sfp}");
    assert_eq!(sfp["connector"], "SFP+");
    assert_eq!(sfp["medium"], "other", "an empty cage");
    let x1 = sfp["id"].as_i64().unwrap();
    let (s, p) = app
        .patch(
            &c,
            &format!("/api/ports/{x1}"),
            json!({ "transceiver": "10GBASE-SR" }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{p}");
    assert_eq!(p["medium"], "fiber");
    assert_eq!(p["effective_speed"], 10000);
    // A 40G module doesn't fit, nor does a 10G module in a 1G SFP port.
    let (s, _) = app
        .patch(
            &c,
            &format!("/api/ports/{x1}"),
            json!({ "transceiver": "40GBASE-SR4" }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, e) = app
        .post(
            &c,
            &format!("/api/devices/{}/ports", o.sw),
            json!({ "code": "G1", "connector": "SFP", "transceiver": "10GBASE-LR" }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{e}");
    // RJ45 ports can't take a transceiver; unknown connectors are refused.
    let (s, _) = app
        .patch(
            &c,
            &format!("/api/ports/{}", o.sw_ports[0]),
            json!({ "transceiver": "10GBASE-SR" }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = app
        .post(
            &c,
            &format!("/api/devices/{}/ports", o.sw),
            json!({ "code": "Z", "connector": "XLR" }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Renaming the device renames its ports' paths.
    let (s, _) = app
        .patch(
            &c,
            &format!("/api/devices/{}", o.pp),
            json!({ "code": "PP-A" }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (_, p) = app.get(&c, &format!("/api/ports/{}", o.pp_ports[0])).await;
    assert_eq!(p["path"], "ACME/HQ/2/MDF/RK01/PP-A/01");

    // Ports are searchable when asked for, and don't crowd normal searches.
    let (_, hits) = app.get(&c, "/api/search?q=Te1").await;
    assert_eq!(hits.as_array().unwrap().len(), 0);
    let (_, hits) = app.get(&c, "/api/search?q=Te1&kind=port").await;
    assert_eq!(hits[0]["path"], "ACME/HQ/2/MDF/RK01/SW01/X1");
    let (_, hits) = app.get(&c, "/api/search?q=PP-A").await;
    assert_eq!(hits.as_array().unwrap().len(), 1, "{hits}");
}

#[tokio::test]
async fn cabling_follows_the_side_rules_and_traces() {
    let app = spawn().await;
    let c = app.owner().await;
    let o = office(&app, &c).await;
    let (sw1, pp1, to1, ap) = (o.sw_ports[0], o.pp_ports[0], o.to_ports[0], o.ap_port);

    // No keystone yet: a panel port can't be patched before its rear is cabled.
    let (s, e) = cable(&app, &c, patch(sw1, pp1)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(
        e["error"]
            .as_str()
            .unwrap()
            .contains("permanent cable first"),
        "{e}"
    );

    // Permanent cables join passive rears only.
    let (s, _) = cable(
        &app,
        &c,
        json!({ "kind": "permanent", "a": { "port_id": sw1 }, "b": { "port_id": pp1 } }),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, perm) = cable(
        &app,
        &c,
        json!({ "kind": "permanent", "a": { "port_id": pp1 }, "b": { "port_id": to1 },
                "cable_type": "cat6a", "length_m": 38.5, "label": "D-0101" }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{perm}");
    assert_eq!(perm["cable_type"], "Cat6a", "normalised");
    assert_eq!(perm["a"]["side"], "rear");
    assert_eq!(perm["warnings"], json!([]));

    let (s, p1) = cable(
        &app,
        &c,
        json!({ "kind": "patch", "a": { "port_id": sw1 }, "b": { "port_id": pp1 },
                "cable_type": "Cat6a", "length_m": 1, "color": "#1E90FF" }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{p1}");
    assert_eq!(p1["color"], "#1e90ff");

    // Half-way: incomplete everywhere on the chain.
    let (_, t) = app.get(&c, &format!("/api/ports/{sw1}/trace")).await;
    assert_eq!(t["state"], "incomplete");

    // One cable per port side.
    let (s, _) = cable(&app, &c, patch(o.sw_ports[1], pp1)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // Not to itself.
    let (s, _) = cable(&app, &c, patch(sw1, sw1)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, p2) = cable(
        &app,
        &c,
        json!({ "kind": "patch", "a": { "port_id": to1 }, "b": { "port_id": ap },
                "cable_type": "Cat6", "length_m": 3 }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{p2}");

    // Complete, from any port on it, in order, with lengths summed.
    for start in [ap, sw1, to1, pp1] {
        let (_, t) = app.get(&c, &format!("/api/ports/{start}/trace")).await;
        assert_eq!(t["state"], "complete", "from {start}: {t}");
        let ports: Vec<&str> = t["hops"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|h| h["type"] == "port")
            .map(|h| h["path"].as_str().unwrap())
            .collect();
        assert_eq!(ports.len(), 4);
        assert!(
            ports
                == [
                    "ACME/HQ/2/MDF/RK01/SW01/01",
                    "ACME/HQ/2/MDF/RK01/PP01/01",
                    "ACME/HQ/2/OFFICE/TO01/1",
                    "ACME/HQ/2/OFFICE/AP01/1"
                ]
                || ports
                    == [
                        "ACME/HQ/2/OFFICE/AP01/1",
                        "ACME/HQ/2/OFFICE/TO01/1",
                        "ACME/HQ/2/MDF/RK01/PP01/01",
                        "ACME/HQ/2/MDF/RK01/SW01/01"
                    ],
            "{ports:?}"
        );
        assert_eq!(t["total_length_m"], 42.5);
        assert_eq!(t["warnings"], json!([]), "1G over Cat6 is fine");
    }

    // The rack view shows every port with its cables and chain state.
    let (_, rp) = app.get(&c, &format!("/api/racks/{}/ports", o.s.rack)).await;
    let by_id = |id: i64| {
        rp["ports"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id)
            .cloned()
            .unwrap()
    };
    assert_eq!(rp["ports"].as_array().unwrap().len(), 48);
    assert_eq!(by_id(sw1)["chain_state"], "complete");
    assert_eq!(
        by_id(sw1)["front"]["far"]["path"],
        "ACME/HQ/2/MDF/RK01/PP01/01"
    );
    assert_eq!(by_id(pp1)["rear"]["kind"], "permanent");
    assert_eq!(by_id(pp1)["rear"]["far"]["path"], "ACME/HQ/2/OFFICE/TO01/1");
    assert_eq!(by_id(o.sw_ports[1])["chain_state"], "unconnected");

    // Chain colour paints the patch cords and leaves the permanent cable.
    let (s, r) = app
        .post(
            &c,
            &format!("/api/ports/{ap}/chain-color"),
            json!({ "color": "#ff8800" }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["connections"].as_array().unwrap().len(), 2);
    let (_, perm_now) = app
        .get(&c, &format!("/api/connections/{}", perm["id"]))
        .await;
    assert_eq!(perm_now["color"], Value::Null);
    let (_, p1_now) = app.get(&c, &format!("/api/connections/{}", p1["id"])).await;
    assert_eq!(p1_now["color"], "#ff8800");

    // A passive port with a permanent cable can't become active.
    let (s, _) = app
        .patch(
            &c,
            &format!("/api/ports/{pp1}"),
            json!({ "role": "active" }),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);

    // Unplug the access point: incomplete; and the change history has it.
    let (s, _) = app
        .delete(&c, &format!("/api/connections/{}", p2["id"]), json!({}))
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (_, t) = app.get(&c, &format!("/api/ports/{sw1}/trace")).await;
    assert_eq!(t["state"], "incomplete");
    let (_, t) = app.get(&c, &format!("/api/ports/{ap}/trace")).await;
    assert_eq!(t["state"], "unconnected");
    let (_, log) = app.get(&c, "/api/audit?resource_type=connection").await;
    let actions: Vec<&str> = log["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    assert!(
        actions.contains(&"connect") && actions.contains(&"disconnect"),
        "{log}"
    );
    let disconnect = log["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["action"] == "disconnect")
        .unwrap();
    assert_eq!(
        disconnect["resource_path"],
        "ACME/HQ/2/OFFICE/TO01/1 ↔ ACME/HQ/2/OFFICE/AP01/1"
    );

    // Deleting a port removes its cables, with no half-cables left behind.
    let (s, _) = app
        .delete(&c, &format!("/api/ports/{to1}"), json!({}))
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = app
        .get(&c, &format!("/api/connections/{}", perm["id"]))
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let dangling: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM connections c WHERE (SELECT COUNT(*) FROM connection_ends e WHERE e.connection_id = c.id) <> 2",
    )
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert_eq!(dangling, 0);
}

#[tokio::test]
async fn media_are_checked() {
    let app = spawn().await;
    let c = app.owner().await;
    let o = office(&app, &c).await;
    let fp = device(
        &app,
        &c,
        o.s.project,
        json!({ "device_type": "fibre_panel", "placement": { "type": "rack", "rack_id": o.s.rack, "u": 38 } }),
    )
    .await;
    let fibre = ports(&app, &c, fp, json!({ "count": 2 })).await;
    let (_, f) = app.get(&c, &format!("/api/ports/{}", fibre[0])).await;
    assert_eq!(f["connector"], "LC");
    assert_eq!(f["medium"], "fiber");
    let x = ports(
        &app,
        &c,
        o.sw,
        json!({ "prefix": "X", "count": 4, "connector": "SFP+" }),
    )
    .await;

    // A fibre panel's rear only takes fibre.
    let (s, e) = cable(
        &app,
        &c,
        json!({ "kind": "permanent", "a": { "port_id": fibre[0] }, "b": { "port_id": fibre[1] }, "cable_type": "Cat6" }),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{e}");
    // A copper panel's rear can't be joined to a fibre panel's rear.
    let (s, _) = cable(
        &app,
        &c,
        json!({ "kind": "permanent", "a": { "port_id": fibre[0] }, "b": { "port_id": o.pp_ports[5] } }),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = cable(
        &app,
        &c,
        json!({ "kind": "permanent", "a": { "port_id": fibre[0] }, "b": { "port_id": fibre[1] }, "cable_type": "OS2" }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);

    // RJ45 to LC: impossible.
    let (s, e) = cable(&app, &c, patch(o.sw_ports[2], fibre[0])).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(
        e["error"].as_str().unwrap().contains("media converter"),
        "{e}"
    );
    // An empty SFP+ cage to an LC port: needs a module first.
    let (s, _) = cable(&app, &c, patch(x[0], fibre[0])).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Multimode optic + single-mode cable: allowed, with a warning.
    app.patch(
        &c,
        &format!("/api/ports/{}", x[0]),
        json!({ "transceiver": "10GBASE-SR" }),
    )
    .await;
    let (s, r) = cable(
        &app,
        &c,
        json!({ "kind": "patch", "a": { "port_id": x[0] }, "b": { "port_id": fibre[0] }, "cable_type": "OS2" }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{r}");
    assert!(
        r["warnings"][0].as_str().unwrap().contains("single-mode"),
        "{r}"
    );
    // Fixing the cable type clears it.
    let (s, r) = app
        .patch(
            &c,
            &format!("/api/connections/{}", r["id"]),
            json!({ "cable_type": "OM4" }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(r["warnings"], json!([]));
    // Swapping the optic for a copper one would no longer fit the cable.
    let (s, e) = app
        .patch(
            &c,
            &format!("/api/ports/{}", x[0]),
            json!({ "transceiver": "10GBASE-T" }),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "{e}");

    // DAC between two empty cages; not into a port holding an optic.
    let (s, r) = cable(
        &app,
        &c,
        json!({ "kind": "patch", "a": { "port_id": x[1] }, "b": { "port_id": x[2] }, "cable_type": "DAC SFP+" }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{r}");
    app.patch(
        &c,
        &format!("/api/ports/{}", x[3]),
        json!({ "transceiver": "10GBASE-LR" }),
    )
    .await;
    let (s, _) = app
        .patch(
            &c,
            &format!("/api/ports/{}", x[1]),
            json!({ "transceiver": "10GBASE-LR" }),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "the DAC has its own modules");

    // Cat5e at 10G: warned.
    let ten = ports(
        &app,
        &c,
        o.sw,
        json!({ "prefix": "T", "count": 2, "speed": 10000 }),
    )
    .await;
    let (s, r) = cable(
        &app,
        &c,
        json!({ "kind": "patch", "a": { "port_id": ten[0] }, "b": { "port_id": ten[1] }, "cable_type": "Cat5e" }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    assert!(r["warnings"][0].as_str().unwrap().contains("10G"), "{r}");
    // Unknown cable types are refused.
    let (s, _) = cable(
        &app,
        &c,
        json!({ "kind": "patch", "a": { "port_id": o.sw_ports[5] }, "b": { "port_id": o.sw_ports[6] }, "cable_type": "Cat9" }),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // Power cabling waits for phase 5.
    let (s, _) = cable(
        &app,
        &c,
        json!({ "kind": "power", "a": { "port_id": o.sw_ports[5] }, "b": { "port_id": o.sw_ports[6] } }),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn moving_devices_cuts_cables_only_when_leaving_the_floor() {
    let app = spawn().await;
    let c = app.owner().await;
    let o = office(&app, &c).await;
    let (s, _) = cable(
        &app,
        &c,
        json!({ "kind": "permanent", "a": { "port_id": o.pp_ports[0] }, "b": { "port_id": o.to_ports[0] } }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, _) = cable(&app, &c, patch(o.to_ports[0], o.ap_port)).await;
    assert_eq!(s, StatusCode::CREATED);

    // Within the floor: the AP moves to the MDF and keeps its cable.
    let (s, r) = app
        .patch(
            &c,
            &format!("/api/devices/{}", o.ap),
            json!({ "placement": { "type": "room", "room_id": o.s.mdf } }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let (_, t) = app
        .get(&c, &format!("/api/ports/{}/trace", o.ap_port))
        .await;
    assert_eq!(t["state"], "incomplete");
    assert_eq!(t["hops"].as_array().unwrap().len(), 5);

    // To another floor: cut, and recorded.
    let (_, loc) = app.get(&c, &format!("/api/floors/{}", o.s.floor)).await;
    let (_, f3) = app
        .post(
            &c,
            &format!("/api/locations/{}/floors", loc["location_id"]),
            json!({ "code": "3", "level": 3 }),
        )
        .await;
    let (_, f3) = app.get(&c, &format!("/api/floors/{}", f3["id"])).await;
    let room3 = f3["rooms"][0]["id"].as_i64().unwrap();
    let (s, _) = app
        .patch(
            &c,
            &format!("/api/devices/{}", o.ap),
            json!({ "placement": { "type": "room", "room_id": room3 } }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (_, t) = app
        .get(&c, &format!("/api/ports/{}/trace", o.ap_port))
        .await;
    assert_eq!(t["state"], "unconnected");
    let (_, log) = app.get(&c, "/api/audit?resource_type=device").await;
    let mv = log["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["action"] == "move" && e["changes"]["cables_removed"].is_array())
        .expect("move recorded with the cable removed");
    assert_eq!(
        mv["changes"]["cables_removed"][0],
        "ACME/HQ/2/OFFICE/TO01/1 ↔ ACME/HQ/2/MDF/AP01/1"
    );

    // Unplacing cuts too, and unplaced devices can't be cabled.
    let (s, _) = cable(&app, &c, patch(o.sw_ports[0], o.sw_ports[1])).await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, _) = app
        .patch(
            &c,
            &format!("/api/devices/{}", o.sw),
            json!({ "placement": { "type": "unplaced" } }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (_, list) = app.get(&c, &format!("/api/devices/{}/ports", o.sw)).await;
    assert_eq!(list["ports"][0]["front"], Value::Null);
    let (s, e) = cable(&app, &c, patch(o.sw_ports[0], o.sw_ports[1])).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(e["error"].as_str().unwrap().contains("Unplaced"), "{e}");

    // A rack moving to another floor takes its internal cables along and
    // cuts the ones leaving it.
    let (s, _) = cable(&app, &c, patch(o.pp_ports[0], o.pp_ports[2])).await;
    assert_eq!(
        s,
        StatusCode::BAD_REQUEST,
        "panel fronts need permanent cables"
    );
    let (s, r) = app
        .patch(
            &c,
            &format!("/api/racks/{}", o.s.rack),
            json!({ "room_id": room3 }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let (_, t) = app
        .get(&c, &format!("/api/ports/{}/trace", o.to_ports[0]))
        .await;
    assert_eq!(t["state"], "unconnected", "panel-to-outlet cable cut");

    // Deleting the rack and unplacing its devices cuts their cables.
    // Cables may cross floors.
    let (s, r) = cable(
        &app,
        &c,
        json!({ "kind": "permanent", "a": { "port_id": o.pp_ports[1] }, "b": { "port_id": o.to_ports[1] } }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{r}");
    let (s, r) = app
        .delete(
            &c,
            &format!("/api/racks/{}", o.s.rack),
            json!({ "confirm_code": "RK01", "devices": "unplace" }),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT, "{r}");
    let (_, t) = app
        .get(&c, &format!("/api/ports/{}/trace", o.to_ports[1]))
        .await;
    assert_eq!(t["state"], "unconnected");
    let (_, log) = app.get(&c, "/api/audit?resource_type=device").await;
    assert!(log["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["changes"]["cables_removed"][0]
            .as_str()
            .is_some_and(|x| x.contains("TO01/2"))));
}

#[tokio::test]
async fn either_end_can_edit_a_cable() {
    let app = spawn().await;
    let owner = app.owner().await;
    let o = office(&app, &owner).await;
    let (tech_id, tech) = app.user(&owner, "tech").await;
    let (reader_id, reader) = app.user(&owner, "reader").await;
    let (s, _) = app
        .grant(&owner, tech_id, "editor", "rack", Some(o.s.rack))
        .await;
    assert_eq!(s, StatusCode::CREATED);
    app.grant(&owner, reader_id, "reader", "project", Some(o.s.project))
        .await;

    // The tech can cable the rack's panel to the office outlet (one end is theirs).
    let (s, perm) = cable(
        &app,
        &tech,
        json!({ "kind": "permanent", "a": { "port_id": o.pp_ports[0] }, "b": { "port_id": o.to_ports[0] } }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{perm}");
    // ... but not two office ports.
    let (s, _) = cable(
        &app,
        &tech,
        json!({ "kind": "permanent", "a": { "port_id": o.to_ports[1] }, "b": { "port_id": o.pp_ports[1] } }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "the panel end is theirs");
    let (s, _) = cable(&app, &tech, patch(o.to_ports[0], o.ap_port)).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // Nor edit the office devices' ports.
    let (s, _) = app
        .patch(
            &tech,
            &format!("/api/ports/{}", o.ap_port),
            json!({ "description": "x" }),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // Readers see everything and change nothing.
    let (s, t) = app
        .get(&reader, &format!("/api/ports/{}/trace", o.to_ports[0]))
        .await;
    assert_eq!(s, StatusCode::OK, "{t}");
    let (s, _) = app
        .delete(
            &reader,
            &format!("/api/connections/{}", perm["id"]),
            json!({}),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = app
        .post(
            &reader,
            &format!("/api/projects/{}/vlans", o.s.project),
            json!({ "vid": 10, "name": "Users" }),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // An unrelated user can't even see it.
    let (_, stranger) = app.user(&owner, "stranger").await;
    let (s, _) = app
        .get(&stranger, &format!("/api/connections/{}", perm["id"]))
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = app
        .get(&stranger, &format!("/api/ports/{}/trace", o.ap_port))
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // The tech can remove the cable they can reach.
    let (s, _) = app
        .delete(
            &tech,
            &format!("/api/connections/{}", perm["id"]),
            json!({}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn vlans_and_wlans() {
    let app = spawn().await;
    let c = app.owner().await;
    let o = office(&app, &c).await;
    let p = o.s.project;
    let mut ids = Vec::new();
    for (vid, name) in [(10, "Users"), (20, "Voice"), (30, "Cameras")] {
        let (s, v) = app
            .post(
                &c,
                &format!("/api/projects/{p}/vlans"),
                json!({ "vid": vid, "name": name }),
            )
            .await;
        assert_eq!(s, StatusCode::CREATED, "{v}");
        ids.push(v["id"].as_i64().unwrap());
    }
    let (s, _) = app
        .post(
            &c,
            &format!("/api/projects/{p}/vlans"),
            json!({ "vid": 10, "name": "Again" }),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (s, _) = app
        .post(
            &c,
            &format!("/api/projects/{p}/vlans"),
            json!({ "vid": 4095, "name": "Bad" }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let port = o.sw_ports[3];
    let (s, r) = app
        .send(
            &c,
            reqwest::Method::PUT,
            &format!("/api/ports/{port}/vlans"),
            json!({ "untagged": ids[0], "tagged": [ids[1], ids[2]] }),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["vlans"].as_array().unwrap().len(), 3);
    assert_eq!(r["vlans"][0]["mode"], "untagged");
    let (s, _) = app
        .send(
            &c,
            reqwest::Method::PUT,
            &format!("/api/ports/{port}/vlans"),
            json!({ "untagged": ids[0], "tagged": [ids[0]] }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // A VLAN from another project is refused.
    let other = app.project(&c, "OTHER").await;
    let (_, ov) = app
        .post(
            &c,
            &format!("/api/projects/{other}/vlans"),
            json!({ "vid": 99, "name": "Elsewhere" }),
        )
        .await;
    let (s, _) = app
        .send(
            &c,
            reqwest::Method::PUT,
            &format!("/api/ports/{port}/vlans"),
            json!({ "tagged": [ov["id"]] }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (_, list) = app.get(&c, &format!("/api/projects/{p}/vlans")).await;
    assert_eq!(list["vlans"][0]["port_count"], 1);
    let (s, _) = app
        .delete(&c, &format!("/api/vlans/{}", ids[2]), json!({}))
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (_, pt) = app.get(&c, &format!("/api/ports/{port}")).await;
    assert_eq!(pt["vlans"].as_array().unwrap().len(), 2);

    // WLANs: never a passphrase.
    let (s, _) = app
        .post(
            &c,
            &format!("/api/projects/{p}/wlans"),
            json!({ "ssid": "Staff", "passphrase": "hunter22" }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, w) = app
        .post(
            &c,
            &format!("/api/projects/{p}/wlans"),
            json!({ "ssid": "Staff", "security": "wpa3", "vlan_id": ids[0] }),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{w}");
    // Only wireless ports join a WLAN; a wireless port has no connector.
    let (s, _) = app
        .patch(
            &c,
            &format!("/api/ports/{}", o.ap_port),
            json!({ "wlan_id": w["id"] }),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, radio) = app
        .post(
            &c,
            &format!("/api/devices/{}/ports", o.ap),
            json!({ "code": "R1", "medium": "wireless", "wlan_id": w["id"] }),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{radio}");
    assert_eq!(radio["connector"], Value::Null);
    let (s, e) = cable(
        &app,
        &c,
        patch(radio["id"].as_i64().unwrap(), o.sw_ports[0]),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{e}");
    let (_, wl) = app.get(&c, &format!("/api/projects/{p}/wlans")).await;
    assert_eq!(wl["wlans"][0]["port_count"], 1);
    assert!(wl["wlans"][0].get("passphrase").is_none());
}

#[tokio::test]
async fn upgrades_a_phase_2_database() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase2.db");
    let app = spawn_on(&fixture, "owner-password-1").await;
    let c = client();
    assert_eq!(
        app.login(&c, "admin", "owner-password-1").await.0,
        StatusCode::OK
    );
    let (_, projects) = app.get(&c, "/api/projects").await;
    let p = projects[0]["id"].as_i64().unwrap();
    let (_, devices) = app.get(&c, &format!("/api/projects/{p}/devices")).await;
    let devices = devices["devices"].as_array().unwrap().clone();
    assert_eq!(devices.len(), 3);
    let id_of = |code: &str| {
        devices.iter().find(|d| d["code"] == code).unwrap()["id"]
            .as_i64()
            .unwrap()
    };
    assert_eq!(
        devices.iter().find(|d| d["code"] == "SW01").unwrap()["path"],
        "HOME/HOUSE/0/CLOSET/RK01/SW01",
        "paths survive the view change"
    );
    let (_, hits) = app.get(&c, "/api/search?q=SW01").await;
    assert_eq!(hits.as_array().unwrap().len(), 1);

    // Existing devices take ports and cables.
    let sw = ports(&app, &c, id_of("SW01"), json!({ "count": 8 })).await;
    let pp = ports(&app, &c, id_of("PP01"), json!({ "count": 8 })).await;
    let ap = ports(&app, &c, id_of("AP01"), json!({ "count": 1 })).await;
    let (s, _) = cable(
        &app,
        &c,
        json!({ "kind": "permanent", "a": { "port_id": pp[0] }, "b": { "port_id": pp[1] } }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(
        cable(&app, &c, patch(sw[0], pp[0])).await.0,
        StatusCode::CREATED
    );
    assert_eq!(
        cable(&app, &c, patch(pp[1], ap[0])).await.0,
        StatusCode::CREATED
    );
    let (_, t) = app.get(&c, &format!("/api/ports/{}/trace", ap[0])).await;
    assert_eq!(t["state"], "complete", "{t}");
}
