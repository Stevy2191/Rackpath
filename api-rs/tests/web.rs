//! Phase 7: the server delivers the web app (with its own security
//! policy and caching) next to the API, and floor plan images.

mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::{json, Value};

fn png(w: u32, h: u32) -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
    v.extend(w.to_be_bytes());
    v.extend(h.to_be_bytes());
    v.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
    v
}

#[tokio::test]
async fn serves_the_web_app() {
    let app = spawn().await;
    let web = app.dir.path().join("web");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(
        web.join("index.html"),
        "<!doctype html><title>Rackpath</title>",
    )
    .unwrap();
    std::fs::write(web.join("assets/app-abc123.js"), "console.log(1)").unwrap();
    let c = client();

    // App routes all answer with index.html and the app's policy.
    for path in ["/", "/projects/1/locations", "/login"] {
        let r = c.get(app.url(path)).send().await.unwrap();
        assert_eq!(r.status(), StatusCode::OK, "{path}");
        let csp = r.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            csp.contains("default-src 'self'") && csp.contains("script-src 'self'"),
            "{csp}"
        );
        assert_eq!(r.headers()["cache-control"], "no-store");
        assert!(r.text().await.unwrap().contains("<title>Rackpath"));
    }
    let r = c
        .get(app.url("/assets/app-abc123.js"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(r.headers()["cache-control"]
        .to_str()
        .unwrap()
        .contains("immutable"));
    let r = c.get(app.url("/assets/missing.js")).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);

    // Unknown API paths stay JSON 404s with the API's strict policy.
    let r = c.get(app.url("/api/nope")).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        r.headers()["content-security-policy"],
        "default-src 'none'; frame-ancestors 'none'"
    );
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["code"], "not_found");
    // No path tricks out of the web folder.
    let r = c.get(app.url("/../rackpath.db")).send().await.unwrap();
    assert!(!r.text().await.unwrap().contains("SQLite"));
}

#[tokio::test]
async fn floor_plan_images() {
    let app = spawn().await;
    let c = app.owner().await;
    let p = app.project(&c, "ACME").await;
    let (_, loc) = app
        .post(
            &c,
            &format!("/api/projects/{p}/locations"),
            json!({ "code": "HQ" }),
        )
        .await;
    let (_, l) = app.get(&c, &format!("/api/locations/{}", loc["id"])).await;
    let floor = l["floors"][0]["id"].as_i64().unwrap();
    let url = app.url(&format!("/api/floors/{floor}/plan-image"));

    let r = c
        .put(&url)
        .body(b"<svg onload='alert(1)'/>".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST, "SVG refused");
    let r = c.put(&url).body(png(2400, 1200)).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let f: Value = r.json().await.unwrap();
    assert_eq!(f["plan_width"], 2400);
    assert_eq!(f["plan_height"], 1200);
    assert_eq!(f["plan_image_type"], "image/png");
    assert!(
        f.get("plan_image").is_none(),
        "the stored file name stays private"
    );

    let r = c.get(&url).send().await.unwrap();
    assert_eq!(r.headers()["content-type"], "image/png");
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert_eq!(r.bytes().await.unwrap().len(), png(2400, 1200).len());
    let files = || {
        std::fs::read_dir(app.dir.path().join("uploads/floor-plans"))
            .unwrap()
            .count()
    };
    assert_eq!(files(), 1);

    // Replacing removes the old file; readers can view, not change.
    let r = c.put(&url).body(png(800, 600)).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(files(), 1);
    let (rid, reader) = app.user(&c, "reader").await;
    app.grant(&c, rid, "reader", "project", Some(p)).await;
    assert_eq!(
        reader.get(&url).send().await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        reader
            .put(&url)
            .body(png(10, 10))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let stranger = client();
    assert_eq!(
        stranger.get(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    let r = c.delete(&url).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    assert_eq!(files(), 0);
    assert_eq!(
        c.get(&url).send().await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
}
