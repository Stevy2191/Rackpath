//! Exports: PDF reports, a rack's bill of materials, CSV tables and the
//! short links QR codes point at.

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
async fn raw(c: &Client, url: String) -> (StatusCode, String, String, Vec<u8>) {
    let r = c.get(url).send().await.unwrap();
    let st = r.status();
    let ct = r
        .headers()
        .get("content-type")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let cd = r
        .headers()
        .get("content-disposition")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    (st, ct, cd, r.bytes().await.unwrap().to_vec())
}

#[tokio::test]
async fn reports_boms_csv_and_short_links() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "ACME").await;
    let hq = id(&ok(
        &app,
        &c,
        &format!("/api/projects/{p}/locations"),
        json!({ "code": "HQ", "address_city": "Springfield" }),
    )
    .await);
    let fl = id(&ok(
        &app,
        &c,
        &format!("/api/locations/{hq}/floors"),
        json!({ "code": "1", "level": 1 }),
    )
    .await);
    let room = id(&ok(
        &app,
        &c,
        &format!("/api/floors/{fl}/rooms"),
        json!({ "code": "MDF" }),
    )
    .await);
    let rack = id(&ok(
        &app,
        &c,
        &format!("/api/rooms/{room}/racks"),
        json!({ "code": "RK01", "u_height": 24 }),
    )
    .await);
    let dev = |code: &str, u: f64, model: &str| json!({ "device_type": "switch", "code": code, "name": if code == "SW03" { "=cmd()" } else { "core" }, "model": model, "manufacturer": "Acme", "placement": { "type": "rack", "rack_id": rack, "u": u } });
    let sw1 = id(&ok(
        &app,
        &c,
        &format!("/api/projects/{p}/devices"),
        dev("SW01", 10.0, "X48"),
    )
    .await);
    let sw2 = id(&ok(
        &app,
        &c,
        &format!("/api/projects/{p}/devices"),
        dev("SW02", 12.0, "X48"),
    )
    .await);
    ok(
        &app,
        &c,
        &format!("/api/projects/{p}/devices"),
        dev("SW03", 14.0, "X24"),
    )
    .await;
    let a = id(&ok(
        &app,
        &c,
        &format!("/api/devices/{sw1}/ports"),
        json!({ "code": "1" }),
    )
    .await);
    let b = id(&ok(
        &app,
        &c,
        &format!("/api/devices/{sw2}/ports"),
        json!({ "code": "1" }),
    )
    .await);
    ok(&app, &c, "/api/connections", json!({ "a": { "port_id": a }, "b": { "port_id": b }, "cable_type": "Cat6", "length_m": 1.0, "color": "#ff0000" })).await;
    ok(
        &app,
        &c,
        &format!("/api/projects/{p}/prefixes"),
        json!({ "cidr": "10.1.0.0/24", "location_id": hq }),
    )
    .await;
    ok(
        &app,
        &c,
        &format!("/api/projects/{p}/addresses"),
        json!({ "address": "10.1.0.10", "device_id": sw1 }),
    )
    .await;

    // Reports: a PDF with a sensible file name, for each kind of place.
    for (kind, rid) in [("location", hq), ("rack", rack), ("device", sw1)] {
        let (st, ct, cd, pdf) = raw(
            &c,
            app.url(&format!("/api/export/report?type={kind}&id={rid}")),
        )
        .await;
        assert_eq!(
            st,
            StatusCode::OK,
            "{kind}: {}",
            String::from_utf8_lossy(&pdf)
        );
        assert_eq!(ct, "application/pdf");
        assert!(
            pdf.starts_with(b"%PDF-") && pdf.len() > 8_000,
            "{kind}: {} bytes",
            pdf.len()
        );
        assert!(
            cd.contains("rackpath-ACME-HQ") && cd.ends_with(".pdf\""),
            "{cd}"
        );
    }
    // Three a minute per person.
    let (st, _, _, _) = raw(
        &c,
        app.url(&format!("/api/export/report?type=project&id={p}")),
    )
    .await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS);
    let (_, hist) = app
        .get(&c, &format!("/api/audit?action=export&project_id={p}"))
        .await;
    assert_eq!(hist["entries"].as_array().unwrap().len(), 3);

    // The bill of materials groups devices by model and cords by kind.
    let (_, bom) = app.get(&c, &format!("/api/racks/{rack}/bom")).await;
    let x48 = bom["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["model"] == "X48")
        .unwrap();
    assert_eq!(
        (x48["quantity"].as_i64(), x48["codes"].clone()),
        (Some(2), json!(["SW01", "SW02"]))
    );
    assert_eq!(
        bom["cords"],
        json!([{ "kind": "patch", "cable_type": "Cat6", "length_m": 1.0, "color": "#ff0000", "quantity": 1 }])
    );
    let (st, ct, _, csv) = raw(&c, app.url(&format!("/api/racks/{rack}/bom?format=csv"))).await;
    assert_eq!(
        (st, ct.as_str()),
        (StatusCode::OK, "text/csv; charset=utf-8")
    );
    let csv = String::from_utf8(csv).unwrap();
    assert!(csv.starts_with("item,quantity,"));
    assert!(
        csv.contains("device,2,Switch,Acme,X48,SW01 SW02,U10 U12"),
        "{csv}"
    );
    assert!(csv.contains("cord,1,patch,Cat6,1 m,#ff0000"), "{csv}");

    // CSV tables; a cell that a spreadsheet would run is defused.
    let (st, _, cd, devices) = raw(&c, app.url(&format!("/api/projects/{p}/export/devices"))).await;
    assert_eq!(st, StatusCode::OK);
    assert!(cd.contains("rackpath-ACME-devices.csv"));
    let devices = String::from_utf8(devices).unwrap();
    assert!(
        devices.contains("SW01,ACME/HQ/1/MDF/RK01/SW01,Switch,active,core,Acme,X48"),
        "{devices}"
    );
    assert!(devices.contains("'=cmd()"), "{devices}");
    let (_, _, _, conns) = raw(
        &c,
        app.url(&format!("/api/projects/{p}/export/connections")),
    )
    .await;
    assert!(String::from_utf8(conns).unwrap().contains(
        "ACME/HQ/1/MDF/RK01/SW01/1,front,ACME/HQ/1/MDF/RK01/SW02/1,front,patch,Cat6,1,#ff0000"
    ));
    let (_, _, _, addrs) = raw(&c, app.url(&format!("/api/projects/{p}/export/addresses"))).await;
    assert!(String::from_utf8(addrs)
        .unwrap()
        .contains("10.1.0.10,primary,assigned,,,ACME/HQ/1/MDF/RK01/SW01"));
    let (st, _) = app
        .get(&c, &format!("/api/projects/{p}/export/users"))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // Short links: where a QR code goes, and 404 for what you can't see.
    let (_, r) = app.get(&c, &format!("/api/resolve/rack/{rack}")).await;
    assert_eq!(r["url"], format!("/p/{p}/racks/{rack}"));
    let (_, r) = app.get(&c, &format!("/api/resolve/location/{hq}")).await;
    assert_eq!(r["url"], format!("/p/{p}/locations/{hq}"));
    let (_, r) = app.get(&c, &format!("/api/resolve/port/{a}")).await;
    assert_eq!(r["url"], format!("/p/{p}/ports/{a}"));
    let other = app.project(&c, "OTHER").await;
    let (_, u) = app
        .post(&c, "/api/users", json!({ "username": "olly" }))
        .await;
    app.post(
        &c,
        &format!("/api/users/{}/grants", u["user"]["id"]),
        json!({ "role": "reader", "scope_type": "project", "scope_id": other }),
    )
    .await;
    let oc = client();
    let tmp = u["temporary_password"].as_str().unwrap();
    app.login(&oc, "olly", tmp).await;
    app.post(
        &oc,
        "/api/auth/change-password",
        json!({ "current_password": tmp, "new_password": "olly-password-1" }),
    )
    .await;
    for path in [
        format!("/api/resolve/rack/{rack}"),
        "/api/resolve/rack/999999".to_string(),
        format!("/api/export/report?type=rack&id={rack}"),
        format!("/api/racks/{rack}/bom"),
    ] {
        let (st, _) = app.get(&oc, &path).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "{path}");
    }
}
