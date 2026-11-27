//! End-to-end tests for phase 2: locations, floors, rooms, racks, device
//! types, devices, naming, scoped permissions and search.

mod common;

use common::*;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

/// A project with location HQ, floor 2, rooms MDF and OFFICE, rack RK01 in
/// MDF. Returns ids.
struct Site {
    project: i64,
    location: i64,
    floor: i64,
    mdf: i64,
    office: i64,
    rack: i64,
}

async fn site(app: &TestApp, c: &Client) -> Site {
    let project = app.project(c, "ACME").await;
    let (s, loc) = app
        .post(
            c,
            &format!("/api/projects/{project}/locations"),
            json!({ "code": "hq", "name": "Headquarters" }),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{loc}");
    let location = loc["id"].as_i64().unwrap();
    let (s, floor) = app
        .post(
            c,
            &format!("/api/locations/{location}/floors"),
            json!({ "code": "2", "level": 2 }),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{floor}");
    let floor = floor["id"].as_i64().unwrap();
    let (_, mdf) = app
        .post(
            c,
            &format!("/api/floors/{floor}/rooms"),
            json!({ "code": "MDF", "name": "Main distribution frame" }),
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
    let (s, rack) = app
        .post(
            c,
            &format!("/api/rooms/{mdf}/racks"),
            json!({ "u_height": 42 }),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{rack}");
    assert_eq!(rack["code"], "RK01", "rack codes are generated");
    Site {
        project,
        location,
        floor,
        mdf,
        office: office["id"].as_i64().unwrap(),
        rack: rack["id"].as_i64().unwrap(),
    }
}

async fn device(app: &TestApp, c: &Client, project: i64, body: Value) -> (StatusCode, Value) {
    app.post(c, &format!("/api/projects/{project}/devices"), body)
        .await
}

fn in_rack(rack: i64, u: f64) -> Value {
    json!({ "type": "rack", "rack_id": rack, "u": u })
}

#[tokio::test]
async fn hierarchy_paths_defaults_and_renames() {
    let app = spawn().await;
    let owner = app.owner().await;
    let s = site(&app, &owner).await;

    // A new location gets floor 0 with a DEFAULT room.
    let (_, loc) = app
        .get(&owner, &format!("/api/locations/{}", s.location))
        .await;
    assert_eq!(loc["path"], "ACME/HQ");
    let floors = loc["floors"].as_array().unwrap();
    assert_eq!(
        floors
            .iter()
            .map(|f| f["code"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["0", "2"]
    );
    let floor0 = floors[0]["id"].as_i64().unwrap();
    let (_, f0) = app.get(&owner, &format!("/api/floors/{floor0}")).await;
    assert_eq!(f0["rooms"][0]["code"], "DEFAULT");
    assert_eq!(f0["rooms"][0]["is_default"], true);

    // Codes are generated from the type prefix; paths read like an address.
    let (st, sw) = device(&app, &owner, s.project, json!({ "device_type": "switch", "placement": in_rack(s.rack, 10.0), "hostname": "core-sw-1.acme.lan" })).await;
    assert_eq!(st, StatusCode::CREATED, "{sw}");
    assert_eq!(sw["code"], "SW01");
    assert_eq!(sw["path"], "ACME/HQ/2/MDF/RK01/SW01");
    assert_eq!(
        sw["placement"],
        json!({ "type": "rack", "rack_id": s.rack, "u": 10.0, "face": "front", "mount": "full_width" })
    );
    assert_eq!(sw["u_height"], 1.0);
    let (_, ap) = device(&app, &owner, s.project, json!({ "device_type": "access_point", "placement": { "type": "room", "room_id": s.office, "x": 100, "y": 50 } })).await;
    assert_eq!(ap["path"], "ACME/HQ/2/OFFICE/AP01");
    let (_, spare) = device(
        &app,
        &owner,
        s.project,
        json!({ "device_type": "switch", "status": "spare" }),
    )
    .await;
    assert_eq!(
        spare["path"], "ACME/UNPLACED/SW01",
        "unplaced has its own namespace"
    );

    // Renaming a container renames every path below it.
    app.patch(
        &owner,
        &format!("/api/locations/{}", s.location),
        json!({ "code": "VIE-1" }),
    )
    .await;
    let (_, sw_after) = app.get(&owner, &format!("/api/devices/{}", sw["id"])).await;
    assert_eq!(sw_after["path"], "ACME/VIE-1/2/MDF/RK01/SW01");
    app.patch(
        &owner,
        &format!("/api/projects/{}", s.project),
        json!({ "code": "GLOBEX" }),
    )
    .await;
    let (_, sw_after) = app.get(&owner, &format!("/api/devices/{}", sw["id"])).await;
    assert_eq!(sw_after["path"], "GLOBEX/VIE-1/2/MDF/RK01/SW01");
    let (_, spare_after) = app
        .get(&owner, &format!("/api/devices/{}", spare["id"]))
        .await;
    assert_eq!(spare_after["path"], "GLOBEX/UNPLACED/SW01");

    // Floors keep at least one; DEFAULT rooms are permanent.
    let (_, f0) = app.get(&owner, &format!("/api/floors/{floor0}")).await;
    let default_room = f0["rooms"][0]["id"].as_i64().unwrap();
    assert_eq!(
        app.delete(
            &owner,
            &format!("/api/rooms/{default_room}"),
            json!({ "confirm_code": "DEFAULT" })
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        app.patch(
            &owner,
            &format!("/api/rooms/{default_room}"),
            json!({ "code": "LOBBY" })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.post(
            &owner,
            &format!("/api/floors/{}/rooms", s.floor),
            json!({ "code": "default" })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, l2) = app
        .post(
            &owner,
            &format!("/api/projects/{}/locations", s.project),
            json!({ "code": "BRANCH" }),
        )
        .await;
    let (_, l2) = app
        .get(&owner, &format!("/api/locations/{}", l2["id"]))
        .await;
    let only_floor = l2["floors"][0]["id"].as_i64().unwrap();
    assert_eq!(
        app.delete(
            &owner,
            &format!("/api/floors/{only_floor}"),
            json!({ "confirm_code": "0" })
        )
        .await
        .0,
        StatusCode::CONFLICT
    );

    // Listing locations includes counts.
    let (_, list) = app
        .get(&owner, &format!("/api/projects/{}/locations", s.project))
        .await;
    let hq = list
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["code"] == "VIE-1")
        .unwrap();
    assert_eq!(
        hq["counts"],
        json!({ "floors": 2, "rooms": 4, "racks": 1, "devices": 2 })
    );

    // Places for pickers: every container with its path, in path order.
    let (st, places) = app
        .get(&owner, &format!("/api/projects/{}/places", s.project))
        .await;
    assert_eq!(st, StatusCode::OK, "{places}");
    let places = places.as_array().unwrap();
    assert!(places
        .iter()
        .any(|p| p["kind"] == "rack" && p["id"] == s.rack));
    assert!(places.iter().all(|p| p["kind"] != "device"));
    let paths: Vec<&str> = places.iter().map(|p| p["path"].as_str().unwrap()).collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted);
}

#[tokio::test]
async fn naming_rules_and_shared_room_namespace() {
    let app = spawn().await;
    let owner = app.owner().await;
    let s = site(&app, &owner).await;
    let p = s.project;

    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "switch", "code": "sw 1" })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "switch", "code": "-SW" })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, d) = device(
        &app,
        &owner,
        p,
        json!({ "device_type": "switch", "code": "core-1", "placement": in_rack(s.rack, 1.0) }),
    )
    .await;
    assert_eq!(d["code"], "CORE-1", "codes are uppercased");
    let (st, body) = device(
        &app,
        &owner,
        p,
        json!({ "device_type": "switch", "code": "CORE-1", "placement": in_rack(s.rack, 2.0) }),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert!(
        body["error"].as_str().unwrap().contains("CORE-1-2"),
        "suggests a free code: {body}"
    );

    // Another rack is another namespace.
    let (_, rk2) = app
        .post(&owner, &format!("/api/rooms/{}/racks", s.mdf), json!({}))
        .await;
    assert_eq!(rk2["code"], "RK02");
    let (st, _) = device(&app, &owner, p, json!({ "device_type": "switch", "code": "CORE-1", "placement": in_rack(rk2["id"].as_i64().unwrap(), 1.0) })).await;
    assert_eq!(st, StatusCode::CREATED);

    // Racks and floor devices share the room's namespace, both ways.
    let (_, d) = device(&app, &owner, p, json!({ "device_type": "wall_outlet", "code": "RK03", "placement": { "type": "room", "room_id": s.mdf } })).await;
    assert_eq!(d["code"], "RK03");
    assert_eq!(
        app.post(
            &owner,
            &format!("/api/rooms/{}/racks", s.mdf),
            json!({ "code": "RK03" })
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, auto) = app
        .post(&owner, &format!("/api/rooms/{}/racks", s.mdf), json!({}))
        .await;
    assert_eq!(
        auto["code"], "RK04",
        "generated codes skip codes used by devices"
    );
    assert_eq!(device(&app, &owner, p, json!({ "device_type": "wall_outlet", "code": "RK01", "placement": { "type": "room", "room_id": s.mdf } })).await.0, StatusCode::CONFLICT);

    // next-code previews what create would generate.
    let (_, types) = app
        .get(&owner, &format!("/api/projects/{p}/device-types"))
        .await;
    let to = types
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["key"] == "wall_outlet")
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let (_, next) = app
        .get(
            &owner,
            &format!(
                "/api/projects/{p}/next-code?device_type_id={to}&room_id={}",
                s.mdf
            ),
        )
        .await;
    assert_eq!(next["code"], "TO01");
    let (_, next) = app
        .get(
            &owner,
            &format!("/api/projects/{p}/next-code?kind=rack&room_id={}", s.mdf),
        )
        .await;
    assert_eq!(next["code"], "RK05");
}

#[tokio::test]
async fn rack_fit_and_placement_rules() {
    let app = spawn().await;
    let owner = app.owner().await;
    let s = site(&app, &owner).await;
    let p = s.project;
    let (st, sw) = device(
        &app,
        &owner,
        p,
        json!({ "device_type": "switch", "placement": in_rack(s.rack, 10.0), "u_height": 2 }),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);

    let (st, body) = device(
        &app,
        &owner,
        p,
        json!({ "device_type": "server", "placement": in_rack(s.rack, 11.0) }),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert!(body["error"].as_str().unwrap().contains("SW01"), "{body}");
    let rear = json!({ "type": "rack", "rack_id": s.rack, "u": 11, "face": "rear" });
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "patch_panel", "placement": rear })
        )
        .await
        .0,
        StatusCode::CREATED,
        "rear of the same unit"
    );
    let deep = json!({ "type": "rack", "rack_id": s.rack, "u": 10, "face": "both" });
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "server", "placement": deep })
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let left = json!({ "type": "rack", "rack_id": s.rack, "u": 20, "mount": "half_left" });
    let right = json!({ "type": "rack", "rack_id": s.rack, "u": 20, "mount": "half_right" });
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "router", "placement": left.clone() })
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "router", "placement": right })
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "router", "placement": left })
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "server", "placement": in_rack(s.rack, 42.0), "u_height": 2 })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST,
        "past the top"
    );
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "server", "placement": in_rack(s.rack, 5.25) })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "server", "placement": { "type": "rack", "rack_id": s.rack } })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST,
        "u required"
    );
    let pdu = json!({ "type": "rack", "rack_id": s.rack, "mount": "zero_u_left", "face": "rear" });
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "pdu", "placement": pdu })
        )
        .await
        .0,
        StatusCode::CREATED,
        "zero-U needs no slot"
    );

    // Types go where they belong.
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "switch", "placement": { "type": "room", "room_id": s.office } })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "access_point", "placement": in_rack(s.rack, 30.0) })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "media_converter", "placement": in_rack(s.rack, 30.0) })
        )
        .await
        .0,
        StatusCode::CREATED
    );

    // Trays hold freestanding gear.
    let (_, tray) = device(
        &app,
        &owner,
        p,
        json!({ "device_type": "tray", "placement": in_rack(s.rack, 35.0) }),
    )
    .await;
    let tray_id = tray["id"].as_i64().unwrap();
    let on_tray = json!({ "type": "tray", "tray_id": tray_id });
    let (st, mc) = device(
        &app,
        &owner,
        p,
        json!({ "device_type": "media_converter", "placement": on_tray.clone() }),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);
    assert_eq!(mc["path"], "ACME/HQ/2/MDF/RK01/TR01/MC01");
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "switch", "placement": on_tray.clone() })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        device(
            &app,
            &owner,
            p,
            json!({ "device_type": "tray", "placement": on_tray })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST,
        "no trays on trays"
    );
    let sw_id = sw["id"].as_i64().unwrap();
    assert_eq!(device(&app, &owner, p, json!({ "device_type": "media_converter", "placement": { "type": "tray", "tray_id": sw_id } })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        app.patch(
            &owner,
            &format!("/api/devices/{tray_id}"),
            json!({ "placement": { "type": "unplaced" } })
        )
        .await
        .0,
        StatusCode::CONFLICT,
        "tray still holds a device"
    );
    assert_eq!(
        app.delete(&owner, &format!("/api/devices/{tray_id}"), json!({}))
            .await
            .0,
        StatusCode::CONFLICT
    );

    // The rack view lists everything; moving the rack moves its contents.
    let (_, rack) = app.get(&owner, &format!("/api/racks/{}", s.rack)).await;
    assert_eq!(rack["devices"].as_array().unwrap().len(), 8);
    assert_eq!(
        app.patch(
            &owner,
            &format!("/api/racks/{}", s.rack),
            json!({ "u_height": 20 })
        )
        .await
        .0,
        StatusCode::CONFLICT,
        "devices above U20"
    );
    assert_eq!(
        app.patch(
            &owner,
            &format!("/api/racks/{}", s.rack),
            json!({ "room_id": s.office })
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, mc) = app.get(&owner, &format!("/api/devices/{}", mc["id"])).await;
    assert_eq!(mc["path"], "ACME/HQ/2/OFFICE/RK01/TR01/MC01");

    // Moving a device within the rack re-checks the fit (and ignores itself).
    assert_eq!(
        app.patch(
            &owner,
            &format!("/api/devices/{sw_id}"),
            json!({ "placement": in_rack(s.rack, 10.5) })
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        app.patch(
            &owner,
            &format!("/api/devices/{sw_id}"),
            json!({ "placement": in_rack(s.rack, 34.5) })
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn scoped_permissions_on_rooms_racks_and_devices() {
    let app = spawn().await;
    let owner = app.owner().await;
    let s = site(&app, &owner).await;
    let p = s.project;
    let (_, sw) = device(
        &app,
        &owner,
        p,
        json!({ "device_type": "switch", "placement": in_rack(s.rack, 10.0) }),
    )
    .await;
    let (_, ap) = device(&app, &owner, p, json!({ "device_type": "access_point", "placement": { "type": "room", "room_id": s.office } })).await;
    let (tech_id, tech) = app.user(&owner, "tech").await;
    let (rack_id, racker) = app.user(&owner, "racker").await;
    assert_eq!(
        app.grant(&owner, tech_id, "editor", "room", Some(s.mdf))
            .await
            .0,
        StatusCode::CREATED
    );
    assert_eq!(
        app.grant(&owner, rack_id, "editor", "rack", Some(s.rack))
            .await
            .0,
        StatusCode::CREATED
    );
    assert_eq!(
        app.grant(&owner, tech_id, "reader", "room", Some(s.mdf))
            .await
            .0,
        StatusCode::BAD_REQUEST,
        "readers are project-wide"
    );

    // Room editor: everything in the room (including its racks), nothing else; reads the whole project.
    assert_eq!(
        app.patch(
            &tech,
            &format!("/api/devices/{}", sw["id"]),
            json!({ "hostname": "sw1" })
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        app.patch(
            &tech,
            &format!("/api/devices/{}", ap["id"]),
            json!({ "hostname": "ap1" })
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.get(&tech, &format!("/api/devices/{}", ap["id"]))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(device(&app, &tech, p, json!({ "device_type": "wall_outlet", "placement": { "type": "room", "room_id": s.mdf } })).await.0, StatusCode::CREATED);
    assert_eq!(device(&app, &tech, p, json!({ "device_type": "wall_outlet", "placement": { "type": "room", "room_id": s.office } })).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        device(&app, &tech, p, json!({ "device_type": "switch" }))
            .await
            .0,
        StatusCode::FORBIDDEN,
        "unplaced needs project rights"
    );
    let to_office = json!({ "placement": { "type": "room", "room_id": s.office } });
    let (_, outlet) = device(
        &app,
        &tech,
        p,
        json!({ "device_type": "wall_outlet", "placement": { "type": "room", "room_id": s.mdf } }),
    )
    .await;
    assert_eq!(
        app.patch(
            &tech,
            &format!("/api/devices/{}", outlet["id"]),
            to_office.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
        "can't move out of scope"
    );
    assert_eq!(
        app.patch(
            &tech,
            &format!("/api/rooms/{}", s.mdf),
            json!({ "name": "MDF A" })
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        app.patch(
            &tech,
            &format!("/api/floors/{}", s.floor),
            json!({ "name": "Second" })
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, ctx) = app.get(&tech, &format!("/api/rooms/{}", s.mdf)).await;
    assert_eq!(ctx["can_edit"], true);
    let (_, ctx) = app.get(&tech, &format!("/api/rooms/{}", s.office)).await;
    assert_eq!(ctx["can_edit"], false);

    // Rack editor: only the rack.
    assert_eq!(
        app.patch(
            &racker,
            &format!("/api/devices/{}", sw["id"]),
            json!({ "notes": "x" })
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        app.patch(
            &racker,
            &format!("/api/rooms/{}", s.mdf),
            json!({ "name": "y" })
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        device(
            &app,
            &racker,
            p,
            json!({ "device_type": "server", "placement": in_rack(s.rack, 20.0) })
        )
        .await
        .0,
        StatusCode::CREATED
    );

    // Device-level grant.
    let (dev_user_id, dev_user) = app.user(&owner, "devuser").await;
    assert_eq!(
        app.grant(&owner, dev_user_id, "editor", "device", ap["id"].as_i64())
            .await
            .0,
        StatusCode::CREATED
    );
    assert_eq!(
        app.patch(
            &dev_user,
            &format!("/api/devices/{}", ap["id"]),
            json!({ "notes": "mine" })
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        app.patch(
            &dev_user,
            &format!("/api/devices/{}", sw["id"]),
            json!({ "notes": "not mine" })
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    // Other projects stay invisible.
    let other = app.project(&owner, "OTHER").await;
    assert_eq!(
        app.get(&tech, &format!("/api/projects/{other}/locations"))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        device(&app, &tech, other, json!({ "device_type": "switch" }))
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    // Grants disappear with what they point at.
    let (_, rk2) = app
        .post(&owner, &format!("/api/rooms/{}/racks", s.office), json!({}))
        .await;
    app.grant(&owner, rack_id, "editor", "rack", rk2["id"].as_i64())
        .await;
    app.delete(
        &owner,
        &format!("/api/racks/{}", rk2["id"]),
        json!({ "confirm_code": rk2["code"] }),
    )
    .await;
    let left: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM role_grants WHERE scope_type = 'rack' AND scope_id = ?",
    )
    .bind(rk2["id"].as_i64())
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn deleting_containers_unplaces_or_deletes_devices() {
    let app = spawn().await;
    let owner = app.owner().await;
    let s = site(&app, &owner).await;
    let p = s.project;
    let (_, sw) = device(
        &app,
        &owner,
        p,
        json!({ "device_type": "switch", "placement": in_rack(s.rack, 1.0) }),
    )
    .await;
    let (_, _spare) = device(&app, &owner, p, json!({ "device_type": "switch" })).await; // UNPLACED/SW01 already taken
    let (_, ap) = device(
        &app,
        &owner,
        p,
        json!({ "device_type": "access_point", "placement": { "type": "room", "room_id": s.mdf } }),
    )
    .await;

    assert_eq!(
        app.delete(
            &owner,
            &format!("/api/rooms/{}", s.mdf),
            json!({ "confirm_code": "WRONG" })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (st, body) = app
        .delete(
            &owner,
            &format!("/api/rooms/{}", s.mdf),
            json!({ "confirm_code": "mdf" }),
        )
        .await;
    assert_eq!(
        st,
        StatusCode::CONFLICT,
        "must choose what happens to devices"
    );
    assert!(
        body["error"].as_str().unwrap().contains("2 device"),
        "{body}"
    );
    assert_eq!(
        app.delete(
            &owner,
            &format!("/api/rooms/{}", s.mdf),
            json!({ "confirm_code": "mdf", "devices": "unplace" })
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );

    let (_, sw) = app.get(&owner, &format!("/api/devices/{}", sw["id"])).await;
    assert_eq!(
        sw["path"], "ACME/UNPLACED/SW01-2",
        "renamed to avoid the existing unplaced SW01"
    );
    assert_eq!(sw["placement"]["type"], "unplaced");
    let (_, ap) = app.get(&owner, &format!("/api/devices/{}", ap["id"])).await;
    assert_eq!(ap["path"], "ACME/UNPLACED/AP01");
    assert_eq!(
        app.get(&owner, &format!("/api/racks/{}", s.rack)).await.0,
        StatusCode::NOT_FOUND,
        "rack went with the room"
    );
    let (_, moves) = app.get(&owner, "/api/audit?action=move").await;
    assert_eq!(moves["entries"].as_array().unwrap().len(), 2);

    // Delete mode removes devices too.
    let (_, rk) = app
        .post(&owner, &format!("/api/rooms/{}/racks", s.office), json!({}))
        .await;
    let (_, d) = device(
        &app,
        &owner,
        p,
        json!({ "device_type": "server", "placement": in_rack(rk["id"].as_i64().unwrap(), 1.0) }),
    )
    .await;
    assert_eq!(
        app.delete(
            &owner,
            &format!("/api/floors/{}", s.floor),
            json!({ "confirm_code": "2", "devices": "delete" })
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.get(&owner, &format!("/api/devices/{}", d["id"]))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let leftover: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM search_entries WHERE floor_id = ?")
            .bind(s.floor)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(leftover, 0, "search index cleaned");
    let (_, unplaced) = app
        .get(&owner, &format!("/api/projects/{p}/devices?unplaced=true"))
        .await;
    assert_eq!(unplaced["devices"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn search_finds_paths_names_and_identifiers_within_access() {
    let app = spawn().await;
    let owner = app.owner().await;
    let s = site(&app, &owner).await;
    let p = s.project;
    device(&app, &owner, p, json!({ "device_type": "switch", "placement": in_rack(s.rack, 1.0), "hostname": "core-sw-1.acme.lan",
        "mac": "AA-BB-CC-00-11-22", "serial_number": "FOC1234X", "name": "Core switch" })).await;
    device(&app, &owner, p, json!({ "device_type": "access_point", "placement": { "type": "room", "room_id": s.office }, "name": "Lobby AP" })).await;
    let other = app.project(&owner, "OTHER").await;
    device(
        &app,
        &owner,
        other,
        json!({ "device_type": "switch", "hostname": "core-sw-9.other.lan" }),
    )
    .await;

    let hit = |v: &Value| {
        v.as_array()
            .unwrap()
            .iter()
            .map(|h| h["path"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    let (_, r) = app.get(&owner, "/api/search?q=core-sw").await;
    let paths = hit(&r);
    assert!(
        paths.contains(&"ACME/HQ/2/MDF/RK01/SW01".to_string())
            && paths.contains(&"OTHER/UNPLACED/SW01".to_string()),
        "{paths:?}"
    );
    assert_eq!(
        hit(&app.get(&owner, "/api/search?q=aa:bb:cc").await.1),
        vec!["ACME/HQ/2/MDF/RK01/SW01"],
        "MAC prefix"
    );
    assert_eq!(
        hit(&app.get(&owner, "/api/search?q=foc1234").await.1),
        vec!["ACME/HQ/2/MDF/RK01/SW01"],
        "serial"
    );
    assert_eq!(
        hit(&app.get(&owner, "/api/search?q=lobby").await.1),
        vec!["ACME/HQ/2/OFFICE/AP01"],
        "name"
    );
    let (_, by_path) = app.get(&owner, "/api/search?q=HQ/2/MDF&kind=device").await;
    assert_eq!(hit(&by_path), vec!["ACME/HQ/2/MDF/RK01/SW01"]);
    let (_, rooms) = app.get(&owner, "/api/search?q=office&kind=room").await;
    assert_eq!(hit(&rooms), vec!["ACME/HQ/2/OFFICE"]);
    assert_eq!(
        app.get(&owner, "/api/search?q=x&kind=bogus").await.0,
        StatusCode::BAD_REQUEST
    );
    for odd in ["\"", "*", "core OR", "NEAR(a b)", "a:b:", "))((", "%"] {
        assert_eq!(
            app.get(&owner, &format!("/api/search?q={}", urlencode(odd)))
                .await
                .0,
            StatusCode::OK,
            "{odd}"
        );
    }

    // A user who can read only ACME doesn't find OTHER's devices.
    let (uid, user) = app.user(&owner, "viewer").await;
    app.grant(&owner, uid, "reader", "project", Some(p)).await;
    let paths = hit(&app.get(&user, "/api/search?q=core-sw").await.1);
    assert_eq!(paths, vec!["ACME/HQ/2/MDF/RK01/SW01"]);

    // The device list filters by place, type and text.
    let (_, list) = app
        .get(
            &owner,
            &format!("/api/projects/{p}/devices?room_id={}", s.mdf),
        )
        .await;
    assert_eq!(
        list["devices"].as_array().unwrap().len(),
        1,
        "rack devices count toward their room"
    );
    let (_, list) = app
        .get(&owner, &format!("/api/projects/{p}/devices?q=lobby"))
        .await;
    assert_eq!(list["devices"][0]["code"], "AP01");
    let (_, list) = app
        .get(
            &owner,
            &format!("/api/projects/{p}/devices?device_type=switch"),
        )
        .await;
    assert_eq!(
        list["devices"][0]["mac"], "aa:bb:cc:00:11:22",
        "MAC normalised"
    );
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[tokio::test]
async fn device_types_and_device_fields() {
    let app = spawn().await;
    let owner = app.owner().await;
    let p = app.project(&owner, "ACME").await;
    let (_, types) = app
        .get(&owner, &format!("/api/projects/{p}/device-types"))
        .await;
    assert_eq!(types.as_array().unwrap().len(), 29, "built-ins seeded");
    let (eid, editor) = app.user(&owner, "ed").await;
    app.grant(&owner, eid, "editor", "project", Some(p)).await;

    let custom = json!({ "key": "thin_client", "label": "Thin client", "prefix": "tc", "placement": "floor" });
    assert_eq!(
        app.post(
            &editor,
            &format!("/api/projects/{p}/device-types"),
            custom.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
        "admins manage types"
    );
    let (st, tc) = app
        .post(&owner, &format!("/api/projects/{p}/device-types"), custom)
        .await;
    assert_eq!(st, StatusCode::CREATED);
    assert_eq!(tc["prefix"], "TC");
    assert_eq!(
        app.post(
            &owner,
            &format!("/api/projects/{p}/device-types"),
            json!({ "key": "other_tc", "label": "x", "prefix": "TC" })
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, d1) = device(&app, &editor, p, json!({ "device_type": "thin_client" })).await;
    assert_eq!(d1["code"], "TC01");
    app.patch(
        &owner,
        &format!("/api/device-types/{}", tc["id"]),
        json!({ "prefix": "THIN" }),
    )
    .await;
    let (_, d2) = device(&app, &editor, p, json!({ "device_type": "thin_client" })).await;
    assert_eq!(
        (d2["code"].as_str(), d1["code"].as_str()),
        (Some("THIN01"), Some("TC01")),
        "prefix changes only affect new devices"
    );
    let (_, after) = app.get(&owner, &format!("/api/devices/{}", d1["id"])).await;
    assert_eq!(after["code"], "TC01");
    assert_eq!(
        app.delete(
            &owner,
            &format!("/api/device-types/{}", tc["id"]),
            json!({})
        )
        .await
        .0,
        StatusCode::CONFLICT,
        "in use"
    );
    let builtin = types.as_array().unwrap()[0]["id"].as_i64().unwrap();
    assert_eq!(
        app.delete(&owner, &format!("/api/device-types/{builtin}"), json!({}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );

    // Field validation and nullable updates.
    let base = json!({ "device_type": "server" });
    for (field, bad) in [
        ("mac", "zz:zz"),
        ("warranty_expiry", "next year"),
        ("status", "broken"),
        ("depth", "medium"),
    ] {
        let mut b = base.clone();
        b[field] = json!(bad);
        assert_eq!(
            device(&app, &owner, p, b).await.0,
            StatusCode::BAD_REQUEST,
            "{field}"
        );
    }
    let (oid, _) = (app.pool.clone(), ());
    let owner_id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE is_owner = 1")
        .fetch_one(&oid)
        .await
        .unwrap();
    let (st, srv) = device(&app, &owner, p, json!({ "device_type": "server", "warranty_expiry": "2027-06-30", "responsible_user_id": owner_id })).await;
    assert_eq!(st, StatusCode::CREATED);
    let (_, cleared) = app
        .patch(
            &owner,
            &format!("/api/devices/{}", srv["id"]),
            json!({ "responsible_user_id": null, "warranty_expiry": null }),
        )
        .await;
    assert_eq!(
        (
            cleared["responsible_user_id"].clone(),
            cleared["warranty_expiry"].clone()
        ),
        (Value::Null, Value::Null)
    );
    let (_, kept) = app
        .patch(
            &owner,
            &format!("/api/devices/{}", srv["id"]),
            json!({ "notes": "x" }),
        )
        .await;
    assert_eq!(kept["status"], "active", "omitted fields are unchanged");
    let (_, history) = app
        .get(
            &owner,
            &format!("/api/audit?resource_type=device&resource_id={}", srv["id"]),
        )
        .await;
    let entries = history["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(
        entries[1]["changes"]["warranty_expiry"],
        json!(["2027-06-30", null])
    );
}

#[tokio::test]
async fn upgrades_a_phase_1_database() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase1.db");
    let app = spawn_on(&fixture, "owner-password-1").await;
    let owner = client();
    assert_eq!(
        app.login(&owner, "admin", "owner-password-1").await.0,
        StatusCode::OK
    );
    let (_, projects) = app.get(&owner, "/api/projects").await;
    let p = projects[0]["id"].as_i64().unwrap();
    assert_eq!(projects[0]["code"], "HOME");
    let (_, types) = app
        .get(&owner, &format!("/api/projects/{p}/device-types"))
        .await;
    assert_eq!(
        types.as_array().unwrap().len(),
        29,
        "built-ins seeded for an existing project"
    );

    // alice's phase 1 grant still works on the new endpoints.
    let alice = client();
    assert_eq!(
        app.login(&alice, "alice", "alice-password-1").await.0,
        StatusCode::OK
    );
    let (_, needs_change) = app
        .get(&alice, &format!("/api/projects/{p}/locations"))
        .await;
    assert_eq!(
        needs_change["code"], "password_change_required",
        "admin-created users still change their password first"
    );
    let changed = app
        .post(
            &alice,
            "/api/auth/change-password",
            json!({ "current_password": "alice-password-1", "new_password": "alice-password-2" }),
        )
        .await;
    assert_eq!(changed.0, StatusCode::NO_CONTENT);
    let (st, loc) = app
        .post(
            &alice,
            &format!("/api/projects/{p}/locations"),
            json!({ "code": "HOUSE" }),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{loc}");
    let (st, d) = device(
        &app,
        &alice,
        p,
        json!({ "device_type": "switch", "code": "usw-24" }),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);
    assert_eq!(d["path"], "HOME/UNPLACED/USW-24");
}

#[tokio::test]
async fn locations_can_be_grouped_by_site() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "CAMPUS").await;
    let loc = |code: &str, site: Option<&str>| {
        let mut body = json!({ "code": code });
        if let Some(s) = site {
            body["site"] = json!(s);
        }
        body
    };
    let path = format!("/api/projects/{p}/locations");
    let (st, annex) = app
        .post(&c, &path, loc("ANNEX", Some("  Main campus ")))
        .await;
    assert_eq!(st, StatusCode::CREATED, "{annex}");
    assert_eq!(annex["site"], "Main campus");
    let (_, ch) = app.post(&c, &path, loc("CTHSE", Some("Main campus"))).await;
    let (_, barn) = app.post(&c, &path, loc("BARN", None)).await;
    let (_, depot) = app.post(&c, &path, loc("DEPOT", Some("Annex yard"))).await;
    assert_eq!(barn["site"], Value::Null);

    // Listed by site, then code; buildings without a site last.
    let (_, list) = app.get(&c, &path).await;
    let order: Vec<_> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["site"].as_str().unwrap_or("-").to_string(),
                l["code"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        order,
        [
            ("Annex yard", "DEPOT"),
            ("Main campus", "ANNEX"),
            ("Main campus", "CTHSE"),
            ("-", "BARN")
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );

    // The site doesn't change paths.
    assert_eq!(ch["path"], "CAMPUS/CTHSE");

    // Changing and clearing it; other fields stay; the change is in the history.
    let id = depot["id"].as_i64().unwrap();
    let (st, moved) = app
        .patch(
            &c,
            &format!("/api/locations/{id}"),
            json!({ "site": "Main campus" }),
        )
        .await;
    assert_eq!(
        (st, moved["site"].as_str()),
        (StatusCode::OK, Some("Main campus"))
    );
    let (_, cleared) = app
        .patch(&c, &format!("/api/locations/{id}"), json!({ "site": "" }))
        .await;
    assert_eq!(cleared["site"], Value::Null);
    let (_, kept) = app
        .patch(
            &c,
            &format!("/api/locations/{id}"),
            json!({ "name": "Depot" }),
        )
        .await;
    assert_eq!(
        (kept["site"].clone(), kept["name"].as_str()),
        (Value::Null, Some("Depot"))
    );
    let (_, log) = app
        .get(
            &c,
            &format!("/api/audit?resource_type=location&resource_id={id}"),
        )
        .await;
    assert!(
        log["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["changes"]["site"].is_array()),
        "{log}"
    );

    // At most 100 characters.
    let (st, err) = app
        .post(&c, &path, loc("LONG", Some(&"x".repeat(101))))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{err}");
}

#[tokio::test]
async fn phone_numbers_are_stored_formatted() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "PHONE").await;
    let path = format!("/api/projects/{p}/locations");
    let (_, loc) = app
        .post(
            &c,
            &path,
            json!({ "code": "hq", "contact_phone": "979.203.4748" }),
        )
        .await;
    assert_eq!(loc["contact_phone"], "(979) 203-4748");
    let id = loc["id"].as_i64().unwrap();
    let (_, kept) = app
        .patch(
            &c,
            &format!("/api/locations/{id}"),
            json!({ "contact_phone": "+44 20 7946 0958" }),
        )
        .await;
    assert_eq!(kept["contact_phone"], "+44 20 7946 0958");

    // Migration 0009 formats saved numbers by the same rule as the API.
    let samples = [
        "9792034748",
        "979-203-4748",
        "(979)203-4748",
        " 1 979 203 4748 ",
        "+1 (979) 203-4748",
        "+9792034748",
        "+44 20 7946 0958",
        "979-203-4748 x12",
        "203-4748",
        "29792034748",
        "call the desk",
    ];
    for (i, s) in samples.iter().enumerate() {
        sqlx::query("INSERT INTO locations (project_id, code, contact_phone, created_at, updated_at) VALUES (?, ?, ?, '', '')")
            .bind(p)
            .bind(format!("S{i}"))
            .bind(s)
            .execute(&app.pool)
            .await
            .unwrap();
    }
    sqlx::raw_sql(include_str!("../migrations/0009_phone_format.sql"))
        .execute(&app.pool)
        .await
        .unwrap();
    for (i, s) in samples.iter().enumerate() {
        let stored: String = sqlx::query_scalar(
            "SELECT contact_phone FROM locations WHERE project_id = ? AND code = ?",
        )
        .bind(p)
        .bind(format!("S{i}"))
        .fetch_one(&app.pool)
        .await
        .unwrap();
        let expected = rackpath::domain::phone::format(s);
        // The migration keeps untouched values as they were (untrimmed).
        let expected = if expected.starts_with('(') {
            expected
        } else {
            s.to_string()
        };
        assert_eq!(stored, expected, "{s:?}");
    }
}
