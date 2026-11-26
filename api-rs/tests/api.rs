//! End-to-end tests for phase 1 (security core): each test starts a real
//! server on a temporary SQLite database and talks to it over HTTP.

mod common;

use common::*;
use rackpath::domain::totp;
use rackpath::{db, ensure_owner};
use reqwest::StatusCode;
use serde_json::json;

// ---------------------------------------------------------------------------

#[tokio::test]
async fn first_start_creates_owner_that_must_change_password() {
    let app = spawn().await;
    assert_eq!(
        ensure_owner(&app.pool).await.unwrap(),
        None,
        "only on first start"
    );

    let c = client();
    let (s, body) = app.login(&c, "admin", &app.owner_password).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["user"]["must_change_password"], true);
    assert_eq!(body["user"]["is_owner"], true);

    let (s, body) = app.get(&c, "/api/projects").await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "password_change_required");
    assert_eq!(
        app.get(&c, "/api/auth/me").await.0,
        StatusCode::OK,
        "me stays reachable"
    );

    let weak = app
        .post(
            &c,
            "/api/auth/change-password",
            json!({ "current_password": app.owner_password, "new_password": "short" }),
        )
        .await;
    assert_eq!(weak.0, StatusCode::BAD_REQUEST);
    let wrong = app
        .post(
            &c,
            "/api/auth/change-password",
            json!({ "current_password": "nope", "new_password": "a-long-enough-pw" }),
        )
        .await;
    assert_eq!(wrong.0, StatusCode::FORBIDDEN);

    let other = client();
    assert_eq!(
        app.login(&other, "admin", &app.owner_password).await.0,
        StatusCode::OK
    );
    let ok = app
        .post(
            &c,
            "/api/auth/change-password",
            json!({ "current_password": app.owner_password, "new_password": "a-long-enough-pw" }),
        )
        .await;
    assert_eq!(ok.0, StatusCode::NO_CONTENT);
    assert_eq!(app.get(&c, "/api/projects").await.0, StatusCode::OK);
    assert_eq!(
        app.get(&other, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED,
        "other sessions signed out"
    );
    assert_eq!(
        app.login(&client(), "admin", &app.owner_password).await.0,
        StatusCode::UNAUTHORIZED,
        "old password gone"
    );
}

#[tokio::test]
async fn failed_logins_are_generic_audited_and_rate_limited() {
    let app = spawn().await;
    let c = client();
    let (s, body) = app.login(&c, "admin", "wrong-password").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "invalid_credentials");
    let (s, body2) = app.login(&c, "nobody", "wrong-password").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(
        body, body2,
        "unknown user looks the same as a wrong password"
    );

    for _ in 0..9 {
        app.login(&c, "admin", "wrong-password").await;
    }
    let r = c
        .post(app.url("/api/auth/login"))
        .json(&json!({ "username": "admin", "password": app.owner_password }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "even the right password is refused while locked"
    );
    assert!(r.headers().get("retry-after").is_some());

    let failed: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'login_failed'")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(failed, 11);
}

#[tokio::test]
async fn sessions_cookie_flags_logout_revoke_and_expiry() {
    let app = spawn().await;
    let a = app.owner().await;
    let b = client();
    let r = b
        .post(app.url("/api/auth/login"))
        .json(&json!({ "username": "admin", "password": "owner-password-1" }))
        .send()
        .await
        .unwrap();
    let cookie = r
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        cookie.contains("HttpOnly")
            && cookie.contains("SameSite=Strict")
            && cookie.contains("Path=/")
    );
    assert!(
        !cookie.contains("Secure"),
        "not over plain HTTP unless configured"
    );

    let (s, sessions) = app.get(&a, "/api/sessions").await;
    assert_eq!(s, StatusCode::OK);
    let sessions = sessions.as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions.iter().filter(|s| s["current"] == true).count(), 1);
    let other_id = sessions.iter().find(|s| s["current"] == false).unwrap()["id"]
        .as_i64()
        .unwrap();
    assert_eq!(
        app.delete(&a, &format!("/api/sessions/{other_id}"), json!({}))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.get(&b, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED
    );

    assert_eq!(
        app.post(&a, "/api/auth/logout", json!({})).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.get(&a, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED
    );

    // Idle and absolute expiry.
    let c = client();
    app.login(&c, "admin", "owner-password-1").await;
    sqlx::query("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z'")
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        app.get(&c, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED,
        "idle timeout"
    );
    let d = client();
    app.login(&d, "admin", "owner-password-1").await;
    sqlx::query("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'")
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        app.get(&d, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED,
        "absolute timeout"
    );
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0, "expired sessions are deleted when used");
}

#[tokio::test]
async fn two_factor_enrol_sign_in_recovery_and_disable() {
    let app = spawn().await;
    let c = app.owner().await;
    assert_eq!(
        app.post(&c, "/api/auth/totp/setup", json!({ "password": "wrong" }))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (s, setup) = app
        .post(
            &c,
            "/api/auth/totp/setup",
            json!({ "password": "owner-password-1" }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert!(setup["otpauth_url"]
        .as_str()
        .unwrap()
        .starts_with("otpauth://totp/Rackpath:admin?"));
    let secret = data_encoding::BASE32_NOPAD
        .decode(setup["secret"].as_str().unwrap().as_bytes())
        .unwrap();

    assert_eq!(
        app.post(&c, "/api/auth/totp/enable", json!({ "code": "000000" }))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (s, enabled) = app
        .post(
            &c,
            "/api/auth/totp/enable",
            json!({ "code": totp::code_at(&secret, now()) }),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let recovery: Vec<String> = enabled["recovery_codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(recovery.len(), 10);
    let stored: String =
        sqlx::query_scalar("SELECT totp_secret FROM users WHERE username = 'admin'")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert!(stored.starts_with("v1:"), "secret encrypted at rest");
    assert_eq!(
        app.get(&c, "/api/projects").await.0,
        StatusCode::OK,
        "enrolling session stays signed in"
    );

    // A new sign-in needs the second factor before anything else.
    let d = client();
    let (s, body) = app.login(&d, "admin", "owner-password-1").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["mfa_required"], true);
    let (s, body) = app.get(&d, "/api/projects").await;
    assert_eq!(
        (s, body["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("mfa_required"))
    );
    let (_, pending_me) = app.get(&d, "/api/auth/me").await;
    assert_eq!(
        pending_me,
        json!({ "user": { "username": "admin" }, "mfa_pending": true }),
        "nothing else leaks before the code"
    );
    assert_eq!(
        app.post(&d, "/api/auth/mfa", json!({ "code": "123456" }))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    // The enrolment used the current step; the next step's code is accepted once.
    let next = totp::code_at(&secret, now() + 30);
    assert_eq!(
        app.post(&d, "/api/auth/mfa", json!({ "code": next }))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(app.get(&d, "/api/projects").await.0, StatusCode::OK);
    let e = client();
    app.login(&e, "admin", "owner-password-1").await;
    assert_eq!(
        app.post(&e, "/api/auth/mfa", json!({ "code": next }))
            .await
            .0,
        StatusCode::UNAUTHORIZED,
        "codes can't be replayed"
    );

    // Recovery codes work once each.
    assert_eq!(
        app.post(
            &e,
            "/api/auth/mfa",
            json!({ "recovery_code": recovery[0].to_lowercase() })
        )
        .await
        .0,
        StatusCode::OK
    );
    let f = client();
    app.login(&f, "admin", "owner-password-1").await;
    assert_eq!(
        app.post(&f, "/api/auth/mfa", json!({ "recovery_code": recovery[0] }))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, me) = app.get(&e, "/api/auth/me").await;
    assert_eq!(me["unused_recovery_codes"], 9);

    // Disabling needs the password and a second factor.
    assert_eq!(
        app.post(
            &e,
            "/api/auth/totp/disable",
            json!({ "password": "owner-password-1" })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (s, _) = app
        .post(
            &e,
            "/api/auth/totp/disable",
            json!({ "password": "owner-password-1", "recovery_code": recovery[1] }),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, body) = app.login(&client(), "admin", "owner-password-1").await;
    assert_eq!(
        (s, body["mfa_required"].as_bool()),
        (StatusCode::OK, Some(false))
    );
}

#[tokio::test]
async fn two_factor_codes_are_rate_limited() {
    let app = spawn().await;
    let c = app.owner().await;
    let (_, setup) = app
        .post(
            &c,
            "/api/auth/totp/setup",
            json!({ "password": "owner-password-1" }),
        )
        .await;
    let secret = data_encoding::BASE32_NOPAD
        .decode(setup["secret"].as_str().unwrap().as_bytes())
        .unwrap();
    app.post(
        &c,
        "/api/auth/totp/enable",
        json!({ "code": totp::code_at(&secret, now()) }),
    )
    .await;
    let d = client();
    app.login(&d, "admin", "owner-password-1").await;
    for _ in 0..10 {
        assert_eq!(
            app.post(&d, "/api/auth/mfa", json!({ "code": "000000" }))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    let right = totp::code_at(&secret, now() + 30);
    assert_eq!(
        app.post(&d, "/api/auth/mfa", json!({ "code": right }))
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn account_can_require_two_factor() {
    let app = spawn().await;
    let owner = app.owner().await;
    let (_, alice) = app.user(&owner, "alice").await;
    let (s, _) = app
        .patch(
            &owner,
            "/api/account/settings",
            json!({ "require_2fa": true }),
        )
        .await;
    assert_eq!(
        s,
        StatusCode::BAD_REQUEST,
        "admin must have 2FA before requiring it"
    );

    let (_, setup) = app
        .post(
            &owner,
            "/api/auth/totp/setup",
            json!({ "password": "owner-password-1" }),
        )
        .await;
    let secret = data_encoding::BASE32_NOPAD
        .decode(setup["secret"].as_str().unwrap().as_bytes())
        .unwrap();
    app.post(
        &owner,
        "/api/auth/totp/enable",
        json!({ "code": totp::code_at(&secret, now()) }),
    )
    .await;
    let (s, body) = app
        .patch(
            &owner,
            "/api/account/settings",
            json!({ "require_2fa": true }),
        )
        .await;
    assert_eq!(
        (s, body["require_2fa"].as_bool()),
        (StatusCode::OK, Some(true))
    );

    let (s, body) = app.get(&alice, "/api/projects").await;
    assert_eq!(
        (s, body["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("two_factor_setup_required"))
    );
    assert_eq!(
        app.post(
            &alice,
            "/api/auth/totp/setup",
            json!({ "password": "alice-password-1" })
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn permissions_are_enforced_end_to_end() {
    let app = spawn().await;
    let owner = app.owner().await;
    let p1 = app.project(&owner, "acme").await;
    let p2 = app.project(&owner, "GLOBEX").await;
    let (alice_id, alice) = app.user(&owner, "alice").await; // editor on P1
    let (bob_id, bob) = app.user(&owner, "bob").await; // admin on P1
    let (carol_id, carol) = app.user(&owner, "carol").await; // no grants yet

    assert_eq!(
        app.grant(&owner, alice_id, "editor", "project", Some(p1))
            .await
            .0,
        StatusCode::CREATED
    );
    assert_eq!(
        app.grant(&owner, bob_id, "admin", "project", Some(p1))
            .await
            .0,
        StatusCode::CREATED
    );

    // Visibility follows grants; other projects look like they don't exist.
    let (_, list) = app.get(&alice, "/api/projects").await;
    assert_eq!(
        list.as_array()
            .unwrap()
            .iter()
            .map(|p| p["code"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["ACME"]
    );
    assert_eq!(
        app.get(&alice, &format!("/api/projects/{p1}")).await.0,
        StatusCode::OK
    );
    assert_eq!(
        app.get(&alice, &format!("/api/projects/{p2}")).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(app.get(&carol, "/api/projects").await.1, json!([]));

    // Editors can't manage the project; admins can.
    assert_eq!(
        app.patch(
            &alice,
            &format!("/api/projects/{p1}"),
            json!({ "name": "x" })
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.patch(
            &alice,
            &format!("/api/projects/{p2}"),
            json!({ "name": "x" })
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.patch(
            &bob,
            &format!("/api/projects/{p1}"),
            json!({ "name": "Acme Corp" })
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        app.post(
            &bob,
            "/api/projects",
            json!({ "code": "NEW", "name": "New" })
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
        "account admins only"
    );

    // Granting is limited to the granter's own scope.
    assert_eq!(
        app.grant(&bob, carol_id, "reader", "project", Some(p1))
            .await
            .0,
        StatusCode::CREATED
    );
    assert_eq!(
        app.grant(&bob, carol_id, "editor", "project", Some(p2))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.grant(&bob, carol_id, "admin", "account", None).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.grant(&alice, carol_id, "editor", "project", Some(p1))
            .await
            .0,
        StatusCode::FORBIDDEN,
        "editors can't grant"
    );
    assert_eq!(
        app.grant(&owner, carol_id, "reader", "room", Some(5))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.grant(&owner, carol_id, "superuser", "project", Some(p1))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.grant(&owner, carol_id, "reader", "project", Some(9999))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.get(&carol, &format!("/api/projects/{p1}")).await.0,
        StatusCode::OK,
        "new grant applies immediately"
    );

    // User administration.
    assert_eq!(app.get(&alice, "/api/users").await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        app.get(&bob, "/api/users").await.0,
        StatusCode::OK,
        "admins can list users to grant them access"
    );
    assert_eq!(
        app.post(&bob, "/api/users", json!({ "username": "dave" }))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (_, alice_grants) = app
        .get(&owner, &format!("/api/users/{alice_id}/grants"))
        .await;
    let grant_id = alice_grants[0]["id"].as_i64().unwrap();
    assert_eq!(
        app.delete(
            &bob,
            &format!("/api/users/{alice_id}/grants/{grant_id}"),
            json!({})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.get(&alice, &format!("/api/projects/{p1}")).await.0,
        StatusCode::NOT_FOUND,
        "revocation applies immediately"
    );

    // Change history visibility follows read access.
    let (s, audit) = app.get(&carol, "/api/audit").await;
    assert_eq!(s, StatusCode::OK);
    let entries = audit["entries"].as_array().unwrap();
    assert!(!entries.is_empty());
    assert!(
        entries.iter().all(|e| e["project_id"] == json!(p1)),
        "only P1 entries: {entries:?}"
    );
    let (_, audit_p2) = app
        .get(&carol, &format!("/api/audit?project_id={p2}"))
        .await;
    assert_eq!(audit_p2["entries"], json!([]));
    assert_eq!(
        app.get(&alice, "/api/audit").await.0,
        StatusCode::FORBIDDEN,
        "no grants left"
    );
    let (_, all) = app.get(&owner, "/api/audit?action=grant").await;
    assert_eq!(all["entries"].as_array().unwrap().len(), 3);

    // Deleting a project needs its code and removes grants inside it.
    assert_eq!(
        app.delete(
            &owner,
            &format!("/api/projects/{p1}"),
            json!({ "confirm_code": "WRONG" })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.delete(
            &owner,
            &format!("/api/projects/{p1}"),
            json!({ "confirm_code": "acme" })
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM role_grants WHERE project_id = ?")
        .bind(p1)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn invitations_create_accept_revoke_and_recheck_inviter() {
    let app = spawn().await;
    let owner = app.owner().await;
    let p1 = app.project(&owner, "ACME").await;
    let p2 = app.project(&owner, "GLOBEX").await;
    let (bob_id, bob) = app.user(&owner, "bob").await;
    app.grant(&owner, bob_id, "admin", "project", Some(p1))
        .await;

    let bad = app
        .post(
            &bob,
            "/api/invitations",
            json!({ "grants": [{ "role": "editor", "scope_type": "project", "scope_id": p2 }] }),
        )
        .await;
    assert_eq!(
        bad.0,
        StatusCode::FORBIDDEN,
        "can't invite into another project"
    );
    let (s, inv) = app
        .post(&bob, "/api/invitations", json!({ "email": "eve@example.com", "grants": [{ "role": "editor", "scope_type": "project", "scope_id": p1 }] }))
        .await;
    assert_eq!(s, StatusCode::CREATED);
    let token = inv["token"].as_str().unwrap().to_string();
    assert_eq!(inv["url"], format!("http://rackpath.test/invite/{token}"));

    let anon = client();
    let (s, preview) = app
        .get(&anon, &format!("/api/invitations/accept/{token}"))
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(preview["invited_by"], "bob");
    let weak = app
        .post(
            &anon,
            &format!("/api/invitations/accept/{token}"),
            json!({ "username": "eve", "password": "short" }),
        )
        .await;
    assert_eq!(weak.0, StatusCode::BAD_REQUEST);
    let (s, body) = app
        .post(
            &anon,
            &format!("/api/invitations/accept/{token}"),
            json!({ "username": "eve", "password": "eve-password-1" }),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{body}");
    assert_eq!(body["user"]["email"], "eve@example.com");
    let (_, me) = app.get(&anon, "/api/auth/me").await;
    assert_eq!(me["grants"][0]["role"], "editor");
    assert_eq!(
        app.get(&anon, &format!("/api/projects/{p1}")).await.0,
        StatusCode::OK,
        "signed in with the granted access"
    );
    let again = app
        .post(
            &client(),
            &format!("/api/invitations/accept/{token}"),
            json!({ "username": "eve2", "password": "eve-password-1" }),
        )
        .await;
    assert_eq!(again.0, StatusCode::NOT_FOUND, "single use");

    // Reissue replaces the link; revoke kills it.
    let (_, inv2) = app
        .post(
            &bob,
            "/api/invitations",
            json!({ "grants": [{ "role": "reader", "scope_type": "project", "scope_id": p1 }] }),
        )
        .await;
    let id2 = inv2["id"].as_i64().unwrap();
    let (_, re) = app
        .post(&bob, &format!("/api/invitations/{id2}/reissue"), json!({}))
        .await;
    assert_eq!(
        app.get(
            &anon,
            &format!(
                "/api/invitations/accept/{}",
                inv2["token"].as_str().unwrap()
            )
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.get(
            &anon,
            &format!("/api/invitations/accept/{}", re["token"].as_str().unwrap())
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        app.delete(&bob, &format!("/api/invitations/{id2}"), json!({}))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.get(
            &anon,
            &format!("/api/invitations/accept/{}", re["token"].as_str().unwrap())
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // If the inviter loses the right to grant, the invitation stops working.
    let (_, inv3) = app
        .post(
            &bob,
            "/api/invitations",
            json!({ "grants": [{ "role": "editor", "scope_type": "project", "scope_id": p1 }] }),
        )
        .await;
    let (_, bob_grants) = app
        .get(&owner, &format!("/api/users/{bob_id}/grants"))
        .await;
    app.delete(
        &owner,
        &format!("/api/users/{bob_id}/grants/{}", bob_grants[0]["id"]),
        json!({}),
    )
    .await;
    let late = app
        .post(
            &client(),
            &format!(
                "/api/invitations/accept/{}",
                inv3["token"].as_str().unwrap()
            ),
            json!({ "username": "frank", "password": "frank-password-1" }),
        )
        .await;
    assert_eq!(late.0, StatusCode::FORBIDDEN);
    let frank: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username = 'frank'")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(frank, 0, "nothing created");
}

#[tokio::test]
async fn owner_is_protected_and_ownership_can_be_transferred() {
    let app = spawn().await;
    let owner = app.owner().await;
    let (alice_id, alice) = app.user(&owner, "alice").await;
    app.grant(&owner, alice_id, "admin", "account", None).await;
    let owner_id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE is_owner = 1")
        .fetch_one(&app.pool)
        .await
        .unwrap();

    assert_eq!(
        app.patch(
            &alice,
            &format!("/api/users/{owner_id}"),
            json!({ "disabled": true })
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.delete(&alice, &format!("/api/users/{owner_id}"), json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.post(
            &alice,
            &format!("/api/users/{owner_id}/reset-password"),
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.post(
            &alice,
            &format!("/api/users/{owner_id}/reset-2fa"),
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, owner_sessions) = app.get(&owner, "/api/sessions").await;
    let owner_session = owner_sessions[0]["id"].as_i64().unwrap();
    assert_eq!(
        app.delete(&alice, &format!("/api/sessions/{owner_session}"), json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN,
        "an admin can't sign the owner out"
    );
    assert_eq!(
        app.post(
            &alice,
            "/api/account/transfer-ownership",
            json!({ "user_id": alice_id, "password": "alice-password-1" })
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    // An account admin can disable and reset ordinary users.
    let (carol_id, carol) = app.user(&owner, "carol").await;
    let (s, body) = app
        .post(
            &alice,
            &format!("/api/users/{carol_id}/reset-password"),
            json!({}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["temporary_password"].as_str().unwrap().len(), 20);
    assert_eq!(
        app.get(&carol, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED,
        "reset signs the user out"
    );
    assert_eq!(
        app.patch(
            &alice,
            &format!("/api/users/{carol_id}"),
            json!({ "disabled": true })
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        app.login(
            &client(),
            "carol",
            body["temporary_password"].as_str().unwrap()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED,
        "disabled"
    );

    let (s, _) = app
        .post(
            &owner,
            "/api/account/transfer-ownership",
            json!({ "user_id": alice_id, "password": "owner-password-1" }),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (_, me) = app.get(&alice, "/api/auth/me").await;
    assert_eq!(me["user"]["is_owner"], true);
    let (_, me) = app.get(&owner, "/api/auth/me").await;
    assert_eq!(
        (
            me["user"]["is_owner"].as_bool(),
            me["is_account_admin"].as_bool()
        ),
        (Some(false), Some(true)),
        "old owner keeps admin"
    );
}

#[tokio::test]
async fn audit_log_is_append_only_and_survives_user_deletion() {
    let app = spawn().await;
    let owner = app.owner().await;
    let (carol_id, _) = app.user(&owner, "carol").await;
    let update = sqlx::query("UPDATE audit_log SET action = 'delete'")
        .execute(&app.pool)
        .await;
    assert!(update.is_err(), "edits are refused by the database");

    assert_eq!(
        app.delete(&owner, &format!("/api/users/{carol_id}"), json!({}))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let rows: Vec<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT user_id, username FROM audit_log WHERE username = 'carol'")
            .fetch_all(&app.pool)
            .await
            .unwrap();
    assert!(!rows.is_empty());
    assert!(
        rows.iter()
            .all(|(id, name)| id.is_none() && name.as_deref() == Some("carol")),
        "history kept, readable"
    );
}

#[tokio::test]
async fn cross_site_requests_are_refused() {
    let app = spawn().await;
    let c = client();
    let evil = c
        .post(app.url("/api/auth/login"))
        .header("origin", "http://evil.test")
        .json(&json!({ "username": "admin", "password": app.owner_password }))
        .send()
        .await
        .unwrap();
    assert_eq!(evil.status(), StatusCode::FORBIDDEN);
    let fetch_site = c
        .post(app.url("/api/auth/login"))
        .header("sec-fetch-site", "cross-site")
        .json(&json!({ "username": "admin", "password": app.owner_password }))
        .send()
        .await
        .unwrap();
    assert_eq!(fetch_site.status(), StatusCode::FORBIDDEN);
    let same = c
        .post(app.url("/api/auth/login"))
        .header("origin", app.base.clone())
        .json(&json!({ "username": "admin", "password": app.owner_password }))
        .send()
        .await
        .unwrap();
    assert_eq!(same.status(), StatusCode::OK);
    let public = c
        .post(app.url("/api/auth/logout"))
        .header("origin", "http://rackpath.test")
        .send()
        .await
        .unwrap();
    assert_eq!(
        public.status(),
        StatusCode::NO_CONTENT,
        "the configured public URL is accepted"
    );
}

#[tokio::test]
async fn responses_carry_security_headers_and_json_errors() {
    let app = spawn().await;
    let r = client().get(app.url("/api/health")).send().await.unwrap();
    for h in [
        "content-security-policy",
        "x-content-type-options",
        "x-frame-options",
        "referrer-policy",
        "x-request-id",
    ] {
        assert!(r.headers().get(h).is_some(), "missing {h}");
    }
    let (s, body) = app.get(&client(), "/api/nope").await;
    assert_eq!(
        (s, body["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("not_found"))
    );
    let (s, body) = app.get(&client(), "/api/projects").await;
    assert_eq!(
        (s, body["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("unauthorized"))
    );
    let bad = client()
        .post(app.url("/api/auth/login"))
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    let big = client()
        .post(app.url("/api/auth/login"))
        .header("content-type", "application/json")
        .body(vec![b' '; 2 * 1024 * 1024])
        .send()
        .await
        .unwrap();
    assert_eq!(big.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn backup_and_command_line_password_reset() {
    let app = spawn().await;
    let owner = app.owner().await;
    let dest = app.dir.path().join("backup.db");
    db::backup(&app.pool, &dest).await.unwrap();
    assert!(dest.exists());
    assert!(
        db::backup(&app.pool, &dest).await.is_err(),
        "never overwrites"
    );
    let copy = db::connect(&dest).await.unwrap();
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&copy)
        .await
        .unwrap();
    assert_eq!(users, 1);

    let temporary = rackpath::reset_password(&app.pool, "admin").await.unwrap();
    assert_eq!(
        app.get(&owner, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED,
        "sessions signed out"
    );
    let (s, body) = app.login(&client(), "admin", &temporary).await;
    assert_eq!(
        (s, body["user"]["must_change_password"].as_bool()),
        (StatusCode::OK, Some(true))
    );
    assert!(app.db_path().exists());
}
