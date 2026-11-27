//! End-to-end tests for phase 4: address spaces, prefixes, ranges,
//! addresses, next free, the grid, warnings, search and permissions.

mod common;

use common::*;
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};

async fn post_ok(app: &TestApp, c: &Client, path: &str, body: Value) -> Value {
    let (s, v) = app.post(c, path, body).await;
    assert_eq!(s, StatusCode::CREATED, "{path}: {v}");
    v
}

fn id(v: &Value) -> i64 {
    v["id"].as_i64().unwrap()
}

/// A project with a location, a rack, a switch with ports, and VLAN 10.
struct Site {
    project: i64,
    location: i64,
    switch: i64,
    ports: Vec<i64>,
    vlan10: i64,
    vlan20: i64,
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
    let sw = post_ok(
        app,
        c,
        &format!("/api/projects/{project}/devices"),
        json!({ "device_type": "switch", "placement": { "type": "rack", "rack_id": id(&rack), "u": 10 } }),
    )
    .await;
    let ports: Vec<i64> = post_ok(
        app,
        c,
        &format!("/api/devices/{}/ports/bulk", id(&sw)),
        json!({ "count": 4 }),
    )
    .await["ports"]
        .as_array()
        .unwrap()
        .iter()
        .map(id)
        .collect();
    let v10 = post_ok(
        app,
        c,
        &format!("/api/projects/{project}/vlans"),
        json!({ "vid": 10, "name": "Users" }),
    )
    .await;
    let v20 = post_ok(
        app,
        c,
        &format!("/api/projects/{project}/vlans"),
        json!({ "vid": 20, "name": "Voice" }),
    )
    .await;
    Site {
        project,
        location: id(&loc),
        switch: id(&sw),
        ports,
        vlan10: id(&v10),
        vlan20: id(&v20),
    }
}

#[tokio::test]
async fn prefixes_nest_and_validate() {
    let app = spawn().await;
    let c = app.owner().await;
    let s = site(&app, &c).await;
    let p = s.project;

    let (_, spaces) = app.get(&c, &format!("/api/projects/{p}/spaces")).await;
    assert_eq!(
        spaces["spaces"][0]["name"], "Default",
        "every project gets one"
    );

    let big = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "10.20.0.0/16", "role": "transit" }),
    )
    .await;
    let users = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "10.20.30.0/24", "role": "users", "vlan_id": s.vlan10, "gateway": "10.20.30.1",
                "dns_servers": "10.20.0.53, 10.20.0.54", "domain_name": "Office.Example.COM.", "location_id": s.location }),
    )
    .await;
    assert_eq!(users["domain_name"], "office.example.com");
    assert_eq!(users["warnings"], json!([]));
    let voice = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "10.20.31.0/24", "role": "voice" }),
    )
    .await;
    assert!(
        voice["warnings"][0].as_str().unwrap().contains("VLAN"),
        "{voice}"
    );
    post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "2001:DB8::/48" }),
    )
    .await;

    // Host bits, duplicates, bad gateways.
    let (st, e) = app
        .post(
            &c,
            &format!("/api/projects/{p}/prefixes"),
            json!({ "cidr": "10.20.30.7/24" }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(
        e["error"]
            .as_str()
            .unwrap()
            .contains("did you mean 10.20.30.0/24"),
        "{e}"
    );
    let (st, _) = app
        .post(
            &c,
            &format!("/api/projects/{p}/prefixes"),
            json!({ "cidr": "10.20.30.0/24" }),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    let (st, _) = app
        .post(
            &c,
            &format!("/api/projects/{p}/prefixes"),
            json!({ "cidr": "10.9.0.0/24", "gateway": "10.9.0.255" }),
        )
        .await;
    assert_eq!(
        st,
        StatusCode::BAD_REQUEST,
        "broadcast can't be the gateway"
    );

    // The same range in another space is fine.
    let lab = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/spaces"),
        json!({ "name": "Lab" }),
    )
    .await;
    post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "10.20.30.0/24", "space_id": id(&lab) }),
    )
    .await;

    // Tree: computed parents and depths, ordered.
    let (_, list) = app.get(&c, &format!("/api/projects/{p}/prefixes")).await;
    let rows = list["prefixes"].as_array().unwrap();
    let find = |cidr: &str, space: i64| {
        rows.iter()
            .find(|r| r["cidr"] == cidr && r["space_id"] == space)
            .unwrap()
            .clone()
    };
    let default_space = big["space_id"].as_i64().unwrap();
    assert_eq!(find("10.20.30.0/24", default_space)["parent_id"], id(&big));
    assert_eq!(find("10.20.30.0/24", default_space)["depth"], 1);
    assert_eq!(
        find("10.20.0.0/16", default_space)["parent_id"],
        Value::Null
    );
    assert_eq!(
        find("10.20.30.0/24", id(&lab))["parent_id"],
        Value::Null,
        "spaces don't mix"
    );
    assert_eq!(
        find("2001:db8::/48", default_space)["size"],
        "1208925819614629174706176"
    );

    let (_, detail) = app.get(&c, &format!("/api/prefixes/{}", id(&big))).await;
    let kids: Vec<&str> = detail["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["cidr"].as_str().unwrap())
        .collect();
    assert_eq!(kids, ["10.20.30.0/24", "10.20.31.0/24"]);
    let (_, detail) = app.get(&c, &format!("/api/prefixes/{}", id(&users))).await;
    assert_eq!(detail["parent"]["cidr"], "10.20.0.0/16");

    // A non-empty space can't be deleted; the Default space never.
    let (st, _) = app
        .delete(&c, &format!("/api/spaces/{}", id(&lab)), json!({}))
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    let (st, _) = app
        .delete(&c, &format!("/api/spaces/{default_space}"), json!({}))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // Searchable by prefix text.
    let (_, hits) = app.get(&c, "/api/search?q=10.20.31&kind=prefix").await;
    assert_eq!(hits[0]["path"], "10.20.31.0/24");
}

#[tokio::test]
async fn ranges_addresses_and_next_free() {
    let app = spawn().await;
    let c = app.owner().await;
    let s = site(&app, &c).await;
    let p = s.project;
    let net = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "192.168.10.0/24", "role": "users", "vlan_id": s.vlan10, "gateway": "192.168.10.1" }),
    )
    .await;
    let n = id(&net);

    // Ranges sit inside the prefix and don't overlap.
    let pool = post_ok(
        &app,
        &c,
        &format!("/api/prefixes/{n}/ranges"),
        json!({ "start": "192.168.10.100", "end": "192.168.10.199", "kind": "dhcp_pool" }),
    )
    .await;
    let statics = post_ok(
        &app,
        &c,
        &format!("/api/prefixes/{n}/ranges"),
        json!({ "start": "192.168.10.10", "end": "192.168.10.49", "kind": "static" }),
    )
    .await;
    let (st, _) = app
        .post(
            &c,
            &format!("/api/prefixes/{n}/ranges"),
            json!({ "start": "192.168.10.150", "end": "192.168.10.210", "kind": "reserved" }),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    let (st, _) = app
        .post(
            &c,
            &format!("/api/prefixes/{n}/ranges"),
            json!({ "start": "192.168.11.1", "end": "192.168.11.9" }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = app
        .post(
            &c,
            &format!("/api/prefixes/{n}/ranges"),
            json!({ "start": "192.168.10.250", "end": "192.168.10.255" }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "broadcast");

    // Next free skips the gateway and the pool.
    let (_, free) = app
        .get(&c, &format!("/api/prefixes/{n}/next-free?count=3"))
        .await;
    assert_eq!(
        free["addresses"],
        json!(["192.168.10.2", "192.168.10.3", "192.168.10.4"])
    );
    let (_, free) = app
        .get(
            &c,
            &format!("/api/prefixes/{n}/next-free?range_id={}", id(&statics)),
        )
        .await;
    assert_eq!(free["addresses"], json!(["192.168.10.10"]));

    // Allocate the next free one onto a port: the device comes with it.
    let a = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "prefix_id": n, "port_id": s.ports[0], "dns_name": "sw01.office.example.com", "dns_aliases": ["core"] }),
    )
    .await;
    assert_eq!(a["address"], "192.168.10.2");
    assert_eq!(a["device_id"], s.switch);
    assert_eq!(a["status"], "assigned");
    assert_eq!(a["prefix_len"], 24);
    assert_eq!(a["port_path"], "ACME/HQ/0/MDF/RK01/SW01/1");
    assert_eq!(a["dns_aliases"], json!(["core"]));
    let (_, free) = app.get(&c, &format!("/api/prefixes/{n}/next-free")).await;
    assert_eq!(free["addresses"], json!(["192.168.10.3"]));

    // Duplicates, network address, outside every prefix.
    let (st, _) = app
        .post(
            &c,
            &format!("/api/projects/{p}/addresses"),
            json!({ "address": "192.168.10.2" }),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    let (st, _) = app
        .post(
            &c,
            &format!("/api/projects/{p}/addresses"),
            json!({ "address": "192.168.10.0" }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let stray = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "address": "172.16.5.5" }),
    )
    .await;
    assert!(
        stray["warnings"][0]
            .as_str()
            .unwrap()
            .contains("isn't inside any"),
        "{stray}"
    );
    assert_eq!(
        stray["status"], "reserved",
        "unassigned addresses default to reserved"
    );

    // A static inside the DHCP pool warns; a reservation there doesn't.
    let st_in_pool = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "address": "192.168.10.120" }),
    )
    .await;
    assert!(
        st_in_pool["warnings"][0]
            .as_str()
            .unwrap()
            .contains("DHCP pool"),
        "{st_in_pool}"
    );
    let (st, _) = app
        .post(
            &c,
            &format!("/api/projects/{p}/addresses"),
            json!({ "address": "192.168.10.121", "dhcp_reservation": true }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "a reservation needs a MAC");
    let r1 = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "address": "192.168.10.121", "dhcp_reservation": true, "mac": "AA-BB-CC-00-11-22" }),
    )
    .await;
    assert_eq!(r1["warnings"], json!([]));
    let r2 = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "address": "192.168.10.122", "dhcp_reservation": true, "mac": "aa:bb:cc:00:11:22" }),
    )
    .await;
    assert!(
        r2["warnings"][0]
            .as_str()
            .unwrap()
            .contains("also has a reservation"),
        "{r2}"
    );

    // A new pool over a documented static warns.
    let (_, pool2) = app
        .post(
            &c,
            &format!("/api/prefixes/{n}/ranges"),
            json!({ "start": "192.168.10.2", "end": "192.168.10.5", "kind": "dhcp_pool" }),
        )
        .await;
    assert!(
        pool2["warnings"][0]
            .as_str()
            .unwrap()
            .contains("192.168.10.2"),
        "{pool2}"
    );

    // A public address (a router's WAN address) outside every prefix isn't
    // flagged; a private one is.
    post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "address": "108.204.170.224" }),
    )
    .await;

    // Port VLAN mismatch: the port carries VLAN 20 only.
    app.send(
        &c,
        Method::PUT,
        &format!("/api/ports/{}/vlans", s.ports[0]),
        json!({ "untagged": s.vlan20 }),
    )
    .await;

    let (_, w) = app
        .get(&c, &format!("/api/projects/{p}/ipam/warnings"))
        .await;
    let kinds: Vec<&str> = w["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["kind"].as_str().unwrap())
        .collect();
    for k in [
        "outside_prefix",
        "duplicate_mac",
        "static_in_pool",
        "port_vlan",
    ] {
        assert!(kinds.contains(&k), "{k} missing from {w}");
    }
    assert!(
        !w.to_string().contains("108.204.170.224"),
        "public addresses aren't outside the plan: {w}"
    );

    // Grid: offsets for the network, gateway, ranges and addresses.
    let (_, g) = app.get(&c, &format!("/api/prefixes/{n}/grid")).await;
    assert_eq!(g["size"], 256);
    assert_eq!(g["gateway"], 1);
    assert_eq!(g["broadcast"], 255);
    assert!(g["ranges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["from"] == 100 && r["to"] == 199 && r["kind"] == "dhcp_pool"));
    assert!(g["addresses"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["offset"] == 2 && a["dns_name"] == "sw01.office.example.com"));
    let v6 = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "2001:db8:1::/64" }),
    )
    .await;
    let (st, _) = app
        .get(&c, &format!("/api/prefixes/{}/grid", id(&v6)))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let a6 = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "prefix_id": id(&v6) }),
    )
    .await;
    assert_eq!(a6["address"], "2001:db8:1::1");

    // Search finds the address with where it's plugged in.
    let (_, hits) = app.get(&c, "/api/search?q=sw01.office").await;
    let hit = hits
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["kind"] == "address")
        .unwrap();
    assert_eq!(hit["path"], "192.168.10.2");
    assert_eq!(hit["detail"], "ACME/HQ/0/MDF/RK01/SW01/1");

    // Moving an address to another port of the device; clearing the device clears the port.
    let (st, moved) = app
        .patch(
            &c,
            &format!("/api/addresses/{}", id(&a)),
            json!({ "port_id": s.ports[1] }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{moved}");
    assert_eq!(moved["port_path"], "ACME/HQ/0/MDF/RK01/SW01/2");
    let (_, cleared) = app
        .patch(
            &c,
            &format!("/api/addresses/{}", id(&a)),
            json!({ "device_id": null }),
        )
        .await;
    assert_eq!(cleared["port_id"], Value::Null);
    assert_eq!(cleared["device_id"], Value::Null);

    // Deleting the device keeps its addresses, unassigned.
    app.patch(
        &c,
        &format!("/api/addresses/{}", id(&a)),
        json!({ "port_id": s.ports[2] }),
    )
    .await;
    let (st, _) = app
        .delete(&c, &format!("/api/devices/{}", s.switch), json!({}))
        .await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (st, kept) = app.get(&c, &format!("/api/addresses/{}", id(&a))).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(kept["device_id"], Value::Null);
    assert_eq!(kept["port_id"], Value::Null);
    assert_eq!(kept["prefix"]["cidr"], "192.168.10.0/24");

    // Changing a prefix so a range falls outside is refused; deleting it
    // removes its ranges and keeps the addresses.
    let (st, _) = app
        .patch(
            &c,
            &format!("/api/prefixes/{n}"),
            json!({ "cidr": "192.168.10.0/25" }),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    let (st, _) = app
        .delete(&c, &format!("/api/prefixes/{n}"), json!({}))
        .await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (st, _) = app
        .delete(&c, &format!("/api/ranges/{}", id(&pool)), json!({}))
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (_, list) = app
        .get(&c, &format!("/api/projects/{p}/addresses?q=192.168.10"))
        .await;
    assert_eq!(list["addresses"].as_array().unwrap().len(), 4);

    // The change history has it all.
    let (_, log) = app.get(&c, "/api/audit?resource_type=ip_address").await;
    assert!(log["entries"].as_array().unwrap().len() >= 6);
}

#[tokio::test]
async fn permissions_follow_location_and_device() {
    let app = spawn().await;
    let owner = app.owner().await;
    let s = site(&app, &owner).await;
    let p = s.project;
    let (tech_id, tech) = app.user(&owner, "tech").await;
    let (reader_id, reader) = app.user(&owner, "reader").await;
    app.grant(&owner, tech_id, "editor", "location", Some(s.location))
        .await;
    app.grant(&owner, reader_id, "reader", "project", Some(p))
        .await;

    // An editor on a location can document prefixes there, not project-wide.
    let (st, loc_prefix) = app
        .post(
            &tech,
            &format!("/api/projects/{p}/prefixes"),
            json!({ "cidr": "10.1.0.0/24", "location_id": s.location }),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{loc_prefix}");
    let (st, _) = app
        .post(
            &tech,
            &format!("/api/projects/{p}/prefixes"),
            json!({ "cidr": "10.2.0.0/24" }),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (st, _) = app
        .post(
            &tech,
            &format!("/api/prefixes/{}/ranges", id(&loc_prefix)),
            json!({ "start": "10.1.0.100", "end": "10.1.0.200" }),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let (st, _) = app
        .patch(
            &tech,
            &format!("/api/prefixes/{}", id(&loc_prefix)),
            json!({ "location_id": null }),
        )
        .await;
    assert_eq!(
        st,
        StatusCode::FORBIDDEN,
        "can't move it out of their reach"
    );

    // Addresses on their devices: yes; unassigned ones: project editors only.
    let (st, _) = app
        .post(
            &tech,
            &format!("/api/projects/{p}/addresses"),
            json!({ "address": "10.1.0.5", "device_id": s.switch }),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let (st, _) = app
        .post(
            &tech,
            &format!("/api/projects/{p}/addresses"),
            json!({ "address": "10.1.0.6" }),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Readers read.
    let (st, _) = app
        .get(&reader, &format!("/api/prefixes/{}/grid", id(&loc_prefix)))
        .await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = app
        .post(
            &reader,
            &format!("/api/projects/{p}/addresses"),
            json!({ "address": "10.1.0.7" }),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (_, stranger) = app.user(&owner, "stranger").await;
    let (st, _) = app
        .get(&stranger, &format!("/api/prefixes/{}", id(&loc_prefix)))
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (_, hits) = app.get(&stranger, "/api/search?q=10.1.0").await;
    assert_eq!(hits.as_array().unwrap().len(), 0);

    // A device from another project can't take an address here.
    let other = app.project(&owner, "OTHER").await;
    let od = post_ok(
        &app,
        &owner,
        &format!("/api/projects/{other}/devices"),
        json!({ "device_type": "server" }),
    )
    .await;
    let (st, _) = app
        .post(
            &owner,
            &format!("/api/projects/{p}/addresses"),
            json!({ "address": "10.1.0.8", "device_id": id(&od) }),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn upgrades_a_phase_3_database() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase3.db");
    let app = spawn_on(&fixture, "owner-password-1").await;
    let c = client();
    assert_eq!(
        app.login(&c, "admin", "owner-password-1").await.0,
        StatusCode::OK
    );
    let (_, projects) = app.get(&c, "/api/projects").await;
    let p = projects[0]["id"].as_i64().unwrap();
    let (_, spaces) = app.get(&c, &format!("/api/projects/{p}/spaces")).await;
    assert_eq!(
        spaces["spaces"][0]["name"], "Default",
        "existing projects get a Default space"
    );
    // Phase 3 data is intact.
    let (_, t) = app.get(&c, "/api/ports/1/trace").await;
    assert_eq!(t["state"], "complete", "{t}");
    let (_, vlans) = app.get(&c, &format!("/api/projects/{p}/vlans")).await;
    let v10 = vlans["vlans"][0]["id"].as_i64().unwrap();
    // And IPAM works on it.
    let net = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "192.168.1.0/24", "vlan_id": v10, "gateway": "192.168.1.1" }),
    )
    .await;
    let a = post_ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "prefix_id": id(&net), "port_id": 1 }),
    )
    .await;
    assert_eq!(a["address"], "192.168.1.2");
    assert_eq!(a["port_path"], "HOME/HOUSE/0/CLOSET/RK01/SW01/1");
    // Renaming the project keeps IPAM search entries.
    let (st, _) = app
        .patch(
            &c,
            &format!("/api/projects/{p}"),
            json!({ "code": "HOME2" }),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let (_, hits) = app.get(&c, "/api/search?q=192.168.1.2").await;
    let hit = hits
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["kind"] == "address")
        .unwrap();
    assert_eq!(hit["detail"], "HOME2/HOUSE/0/CLOSET/RK01/SW01/1");
}
