//! Moving things (design section 14): `POST /api/moves` with
//! `{resource, target, dry_run}`.
//!
//! | What | Where to |
//! |---|---|
//! | device | a rack position, a room, a tray or Unplaced (`target.placement`) |
//! | rack | another room (`target.room_id`) |
//! | floor | another location, also in another project (`target.location_id`) |
//! | location | another project (`target.project_id`) |
//!
//! Everything runs in one transaction; a dry run does the whole move and
//! rolls it back, so the report is exactly what would happen: cables cut,
//! a code clash with a suggested free code, and for moves between projects
//! the networks, templates, types and tags carried across and the links
//! that can't follow.

use std::collections::HashMap;

use axum::extract::State;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{QueryBuilder, Sqlite, SqliteConnection};

use super::{require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::naming::{normalize_code, unique_variant};
use crate::domain::permissions::{Action, Chain, ScopeType};
use crate::error::{AppError, AppResult};
use crate::hierarchy::{self, Subtree};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

#[derive(Deserialize)]
pub struct Resource {
    #[serde(rename = "type")]
    kind: String,
    id: i64,
}

#[derive(Deserialize)]
pub struct MoveBody {
    resource: Resource,
    target: Value,
    /// A new code, e.g. the suggestion from a dry run's clash.
    code: Option<String>,
    /// Between projects: `reuse` an identical VLAN/WLAN in the target (same
    /// number, name and notes) or copy it (the default), `copy` always
    /// where the number is free, or `clear` the assignments.
    networks: Option<String>,
    #[serde(default)]
    dry_run: bool,
}

/// What a move did (or would do).
#[derive(Default)]
struct Report {
    cables_cut: Vec<String>,
    clash: Option<(String, String)>,
    vlans: Vec<Value>,
    wlans: Vec<Value>,
    templates_copied: Vec<String>,
    types_copied: Vec<String>,
    tags_copied: Vec<String>,
    addresses_unlinked: i64,
    diagram_boxes_unlinked: i64,
    integration_links_cleared: i64,
    responsible_cleared: Vec<String>,
}

impl Report {
    fn json(&self) -> Value {
        json!({
            "cables_cut": self.cables_cut,
            "code_clash": self.clash.as_ref().map(|(code, suggested)| json!({ "code": code, "suggested": suggested })),
            "vlans": self.vlans, "wlans": self.wlans,
            "templates_copied": self.templates_copied, "types_copied": self.types_copied, "tags_copied": self.tags_copied,
            "addresses_unlinked": self.addresses_unlinked, "diagram_boxes_unlinked": self.diagram_boxes_unlinked,
            "integration_links_cleared": self.integration_links_cleared,
            "responsible_cleared": self.responsible_cleared,
        })
    }
}

/// "… is already used in that room; try RK02" → RK02.
fn suggested(message: &str) -> Option<String> {
    let i = message.rfind("try ")?;
    Some(
        message[i + 4..]
            .trim()
            .trim_end_matches(['.', ')'])
            .to_string(),
    )
}

fn is_clash(e: &AppError) -> Option<String> {
    match e {
        AppError::BadRequest(m) | AppError::Conflict(m)
            if m.contains("already used") || m.contains("already in use") =>
        {
            Some(m.clone())
        }
        _ => None,
    }
}

pub async fn move_resource(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    JsonBody(body): JsonBody<MoveBody>,
) -> AppResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let mut report = Report::default();
    let kind = body.resource.kind.as_str();
    let scope = match kind {
        "device" => ScopeType::Device,
        "rack" => ScopeType::Rack,
        "floor" => ScopeType::Floor,
        "location" => ScopeType::Location,
        _ => {
            return Err(AppError::bad(
                "resource.type must be device, rack, floor or location",
            ))
        }
    };
    let before = hierarchy::get(&mut tx, scope, body.resource.id).await?;
    require(&current, Action::Write, &before.chain)?;

    let mut code = body.code.clone();
    // A clash in a dry run is reported with a suggestion, and the rest of
    // the move is tried with that suggestion so the report stays complete.
    for attempt in 0..2 {
        let result = match kind {
            "device" | "rack" => {
                move_device_or_rack(
                    &mut tx,
                    &ctx,
                    &current,
                    kind,
                    body.resource.id,
                    &body.target,
                    code.as_deref(),
                    &mut report,
                )
                .await
            }
            "floor" => {
                move_floor(
                    &mut tx,
                    &current,
                    body.resource.id,
                    &body.target,
                    code.as_deref(),
                    body.networks.as_deref(),
                    &mut report,
                )
                .await
            }
            _ => {
                move_location(
                    &mut tx,
                    &current,
                    body.resource.id,
                    &body.target,
                    code.as_deref(),
                    body.networks.as_deref(),
                    &mut report,
                )
                .await
            }
        };
        match result {
            Ok(()) => break,
            Err(e) => match (is_clash(&e), body.dry_run && attempt == 0) {
                (Some(m), true) => {
                    let s = suggested(&m).unwrap_or_default();
                    report.clash = Some((
                        code.clone().unwrap_or_else(|| {
                            before
                                .path
                                .rsplit('/')
                                .next()
                                .unwrap_or_default()
                                .to_string()
                        }),
                        s.clone(),
                    ));
                    if s.is_empty() {
                        return Err(e);
                    }
                    code = Some(s);
                }
                _ => return Err(e),
            },
        }
    }
    let after = hierarchy::get(&mut tx, scope, body.resource.id).await?;
    let out = json!({
        "dry_run": body.dry_run,
        "resource": { "type": kind, "id": body.resource.id },
        "from": before.path, "to": after.path,
        "project_id": after.project_id,
        "project_changed": before.project_id != after.project_id,
        "report": report.json(),
    });
    if body.dry_run {
        tx.rollback().await?;
        return Ok(Json(out));
    }
    // Devices and racks wrote their own move entry; floors and locations
    // get one here, with everything the move touched.
    if matches!(kind, "floor" | "location") {
        audit::record(
            &mut tx,
            &ctx,
            Some(current.actor_ref()),
            Entry::new("move", kind, Some(body.resource.id))
                .path(after.path.clone())
                .project(Some(after.project_id))
                .changes(json!({ "path": [before.path, after.path], "report": out["report"] })),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(out))
}

/// Devices and racks reuse their own update, which checks the target,
/// cuts cables leaving the floor and records the move.
#[allow(clippy::too_many_arguments)]
async fn move_device_or_rack(
    tx: &mut SqliteConnection,
    ctx: &RequestCtx,
    current: &CurrentUser,
    kind: &str,
    id: i64,
    target: &Value,
    code: Option<&str>,
    report: &mut Report,
) -> AppResult<()> {
    let mut body = json!({});
    if let Some(c) = code {
        body["code"] = json!(c);
    }
    if kind == "device" {
        body["placement"] = target
            .get("placement")
            .cloned()
            .ok_or_else(|| AppError::bad("target.placement is required"))?;
        let fields = serde_json::from_value(body).map_err(|e| AppError::bad(e.to_string()))?;
        super::devices::update_in(tx, ctx, current, id, fields).await?;
    } else {
        body["room_id"] = target
            .get("room_id")
            .cloned()
            .ok_or_else(|| AppError::bad("target.room_id is required"))?;
        let fields = serde_json::from_value(body).map_err(|e| AppError::bad(e.to_string()))?;
        super::racks::update_rack_in(tx, ctx, current, id, fields).await?;
    }
    // The cables the update removed are in the entry it just wrote.
    let changes: Option<String> =
        sqlx::query_scalar("SELECT changes FROM audit_log ORDER BY id DESC LIMIT 1")
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    if let Some(cut) = changes
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .and_then(|v| v["cables_removed"].as_array().cloned())
    {
        report.cables_cut = cut
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect();
    }
    Ok(())
}

/// Devices under a floor or location (including those on trays there).
async fn devices_under(tx: &mut SqliteConnection, subtree: Subtree) -> AppResult<Vec<i64>> {
    Ok(match subtree {
        Subtree::Floor(id) => {
            sqlx::query_scalar(
                "SELECT ref_id FROM search_entries WHERE kind = 'device' AND floor_id = ?",
            )
            .bind(id)
            .fetch_all(&mut *tx)
            .await?
        }
        Subtree::Location(id) => {
            sqlx::query_scalar(
                "SELECT ref_id FROM search_entries WHERE kind = 'device' AND location_id = ?",
            )
            .bind(id)
            .fetch_all(&mut *tx)
            .await?
        }
        _ => vec![],
    })
}

async fn move_floor(
    tx: &mut SqliteConnection,
    current: &CurrentUser,
    id: i64,
    target: &Value,
    code: Option<&str>,
    networks: Option<&str>,
    report: &mut Report,
) -> AppResult<()> {
    let to = target["location_id"]
        .as_i64()
        .ok_or_else(|| AppError::bad("target.location_id is required"))?;
    let dest = hierarchy::get(tx, ScopeType::Location, to).await?;
    require(current, Action::Write, &dest.chain)?;
    let (old_loc, old_code, level): (i64, String, i64) =
        sqlx::query_as("SELECT location_id, code, level FROM floors WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if old_loc == to {
        return Err(AppError::bad("The floor is already in that location"));
    }
    let code = normalize_code(code.unwrap_or(&old_code)).map_err(AppError::bad)?;
    let taken: Vec<(String, i64)> =
        sqlx::query_as("SELECT code, level FROM floors WHERE location_id = ?")
            .bind(to)
            .fetch_all(&mut *tx)
            .await?;
    let codes: Vec<String> = taken.iter().map(|t| t.0.clone()).collect();
    if codes.iter().any(|c| c.eq_ignore_ascii_case(&code)) {
        return Err(AppError::Conflict(format!(
            "Floor {code} is already used in that location; try {}",
            unique_variant(&code, &codes)
        )));
    }
    // Levels are unique too: the floor keeps its level if it's free.
    let level = if taken.iter().any(|t| t.1 == level) {
        (level + 1..)
            .find(|l| !taken.iter().any(|t| t.1 == *l))
            .unwrap_or(level)
    } else {
        level
    };
    let from_project = hierarchy::get(tx, ScopeType::Floor, id).await?.project_id;
    let devices = devices_under(tx, Subtree::Floor(id)).await?;
    report.cables_cut = crate::cabling::cut(tx, &devices, true).await?;
    sqlx::query(
        "UPDATE floors SET location_id = ?, code = ?, level = ?, updated_at = ? WHERE id = ?",
    )
    .bind(to)
    .bind(&code)
    .bind(level)
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if dest.project_id != from_project {
        across_projects(
            tx,
            &devices,
            Subtree::Floor(id),
            from_project,
            dest.project_id,
            networks,
            report,
        )
        .await?;
    }
    hierarchy::reindex(tx, Subtree::Floor(id)).await?;
    Ok(())
}

async fn move_location(
    tx: &mut SqliteConnection,
    current: &CurrentUser,
    id: i64,
    target: &Value,
    code: Option<&str>,
    networks: Option<&str>,
    report: &mut Report,
) -> AppResult<()> {
    let to = target["project_id"]
        .as_i64()
        .ok_or_else(|| AppError::bad("target.project_id is required"))?;
    require(current, Action::Write, &Chain::project(to))?;
    let (from, old_code): (i64, String) =
        sqlx::query_as("SELECT project_id, code FROM locations WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if from == to {
        return Err(AppError::bad("The location is already in that project"));
    }
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM projects WHERE id = ?")
        .bind(to)
        .fetch_optional(&mut *tx)
        .await?;
    exists.ok_or(AppError::NotFound)?;
    let code = normalize_code(code.unwrap_or(&old_code)).map_err(AppError::bad)?;
    let codes: Vec<String> = sqlx::query_scalar("SELECT code FROM locations WHERE project_id = ?")
        .bind(to)
        .fetch_all(&mut *tx)
        .await?;
    if codes.iter().any(|c| c.eq_ignore_ascii_case(&code)) {
        return Err(AppError::Conflict(format!(
            "Location {code} is already used in that project; try {}",
            unique_variant(&code, &codes)
        )));
    }
    let devices = devices_under(tx, Subtree::Location(id)).await?;
    // A whole location moves: only cables to other locations are cut.
    report.cables_cut = crate::cabling::cut(tx, &devices, true).await?;
    sqlx::query("UPDATE locations SET project_id = ?, code = ?, updated_at = ? WHERE id = ?")
        .bind(to)
        .bind(&code)
        .bind(now_ts())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // The old project's IP plan no longer points at it.
    sqlx::query("UPDATE prefixes SET location_id = NULL WHERE location_id = ? AND project_id = ?")
        .bind(id)
        .bind(from)
        .execute(&mut *tx)
        .await?;
    across_projects(
        tx,
        &devices,
        Subtree::Location(id),
        from,
        to,
        networks,
        report,
    )
    .await?;
    hierarchy::reindex(tx, Subtree::Location(id)).await?;
    Ok(())
}

fn push_ids(q: &mut QueryBuilder<Sqlite>, ids: &[i64]) {
    let mut sep = q.separated(", ");
    for id in ids {
        sep.push_bind(*id);
    }
    q.push(")");
}

/// Everything a move between projects has to re-point: the devices'
/// project, their types, templates and tags (copied when the target
/// lacks them), VLANs and WLANs on their ports, cables among them, and the
/// links that can't follow (IP addresses, diagram boxes, integrations,
/// responsible people who can't see the target).
#[allow(clippy::too_many_arguments)]
async fn across_projects(
    tx: &mut SqliteConnection,
    devices: &[i64],
    subtree: Subtree,
    from: i64,
    to: i64,
    networks: Option<&str>,
    report: &mut Report,
) -> AppResult<()> {
    let mode = networks.unwrap_or("reuse");
    if !matches!(mode, "reuse" | "copy" | "clear") {
        return Err(AppError::bad("networks must be reuse, copy or clear"));
    }
    let now = now_ts();
    // Grants inside the moved part now belong to the target project.
    if let Subtree::Location(l) = subtree {
        sqlx::query("UPDATE role_grants SET project_id = ? WHERE project_id = ? AND scope_type = 'location' AND scope_id = ?").bind(to).bind(from).bind(l).execute(&mut *tx).await?;
    }
    for (scope, sql) in [
        ("floor", "SELECT ref_id FROM search_entries WHERE kind = 'floor' AND (floor_id = ? OR location_id = ?)"),
        ("room", "SELECT ref_id FROM search_entries WHERE kind = 'room' AND (floor_id = ? OR location_id = ?)"),
        ("rack", "SELECT ref_id FROM search_entries WHERE kind = 'rack' AND (floor_id = ? OR location_id = ?)"),
    ] {
        let (f, l) = match subtree {
            Subtree::Floor(x) => (x, -1),
            Subtree::Location(x) => (-1, x),
            _ => (-1, -1),
        };
        let ids: Vec<i64> = sqlx::query_scalar(sql).bind(f).bind(l).fetch_all(&mut *tx).await?;
        for i in ids {
            sqlx::query("UPDATE role_grants SET project_id = ? WHERE project_id = ? AND scope_type = ? AND scope_id = ?").bind(to).bind(from).bind(scope).bind(i).execute(&mut *tx).await?;
        }
    }
    if devices.is_empty() {
        return clear_responsible(tx, subtree, to, report).await;
    }
    let mut q = QueryBuilder::<Sqlite>::new("UPDATE role_grants SET project_id = ");
    q.push_bind(to)
        .push(" WHERE scope_type = 'device' AND scope_id IN (");
    push_ids(&mut q, devices);
    q.build().execute(&mut *tx).await?;

    // Device types: the target's type with the same key, or a copy.
    let mut q = QueryBuilder::<Sqlite>::new("SELECT DISTINCT t.id, t.key, t.label, t.prefix, t.placement, t.icon FROM devices d JOIN device_types t ON t.id = d.device_type_id WHERE d.id IN (");
    push_ids(&mut q, devices);
    #[allow(clippy::type_complexity)]
    let types: Vec<(i64, String, String, String, String, Option<String>)> =
        q.build_query_as().fetch_all(&mut *tx).await?;
    for (old, key, label, prefix, placement, icon) in types {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT id FROM device_types WHERE project_id = ? AND key = ?")
                .bind(to)
                .bind(&key)
                .fetch_optional(&mut *tx)
                .await?;
        let new = match found {
            Some(n) => n,
            None => {
                let prefixes: Vec<String> =
                    sqlx::query_scalar("SELECT prefix FROM device_types WHERE project_id = ?")
                        .bind(to)
                        .fetch_all(&mut *tx)
                        .await?;
                let prefix = unique_variant(&prefix, &prefixes);
                report.types_copied.push(label.clone());
                sqlx::query_scalar("INSERT INTO device_types (project_id, key, label, prefix, placement, icon, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id")
                    .bind(to).bind(&key).bind(&label).bind(&prefix).bind(&placement).bind(&icon).bind(&now).bind(&now)
                    .fetch_one(&mut *tx).await?
            }
        };
        let mut q = QueryBuilder::<Sqlite>::new("UPDATE devices SET device_type_id = ");
        q.push_bind(new)
            .push(" WHERE device_type_id = ")
            .push_bind(old)
            .push(" AND id IN (");
        push_ids(&mut q, devices);
        q.build().execute(&mut *tx).await?;
    }

    // Templates of the old project are copied (built-ins are shared).
    let mut q = QueryBuilder::<Sqlite>::new("SELECT DISTINCT t.id, t.name FROM devices d JOIN device_templates t ON t.id = d.template_id WHERE t.project_id IS NOT NULL AND d.id IN (");
    push_ids(&mut q, devices);
    let templates: Vec<(i64, String)> = q.build_query_as().fetch_all(&mut *tx).await?;
    for (old, name) in templates {
        let same: Option<i64> =
            sqlx::query_scalar("SELECT id FROM device_templates WHERE project_id = ? AND name = ?")
                .bind(to)
                .bind(&name)
                .fetch_optional(&mut *tx)
                .await?;
        let new = match same {
            Some(n) => n,
            None => {
                report.templates_copied.push(name.clone());
                super::templates::copy_to_project(tx, old, to, &name).await?
            }
        };
        // The copy starts its own version history.
        let version: i64 = sqlx::query_scalar("SELECT version FROM device_templates WHERE id = ?")
            .bind(new)
            .fetch_one(&mut *tx)
            .await?;
        let mut q = QueryBuilder::<Sqlite>::new("UPDATE devices SET template_version = ");
        q.push_bind(version).push(", template_id = ");
        q.push_bind(new)
            .push(" WHERE template_id = ")
            .push_bind(old)
            .push(" AND id IN (");
        push_ids(&mut q, devices);
        q.build().execute(&mut *tx).await?;
    }

    // Tags by name, copied when missing.
    let mut q = QueryBuilder::<Sqlite>::new("SELECT DISTINCT t.id, t.name, t.color FROM device_tags x JOIN tags t ON t.id = x.tag_id WHERE x.device_id IN (");
    push_ids(&mut q, devices);
    let tags: Vec<(i64, String, Option<String>)> = q.build_query_as().fetch_all(&mut *tx).await?;
    for (old, name, color) in tags {
        let same: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM tags WHERE project_id = ? AND name = ? COLLATE NOCASE",
        )
        .bind(to)
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await?;
        let new = match same {
            Some(n) => n,
            None => {
                report.tags_copied.push(name.clone());
                sqlx::query_scalar("INSERT INTO tags (project_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(to).bind(&name).bind(&color).bind(&now).bind(&now).fetch_one(&mut *tx).await?
            }
        };
        let mut q = QueryBuilder::<Sqlite>::new("UPDATE device_tags SET tag_id = ");
        q.push_bind(new)
            .push(" WHERE tag_id = ")
            .push_bind(old)
            .push(" AND device_id IN (");
        push_ids(&mut q, devices);
        q.build().execute(&mut *tx).await?;
    }

    // VLANs on the moved ports.
    let mut q = QueryBuilder::<Sqlite>::new("SELECT DISTINCT v.id, v.vid, v.name, v.description, v.color, v.notes FROM port_vlans pv JOIN ports o ON o.id = pv.port_id JOIN vlans v ON v.id = pv.vlan_id WHERE o.device_id IN (");
    push_ids(&mut q, devices);
    #[allow(clippy::type_complexity)]
    let vlans: Vec<(
        i64,
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = q.build_query_as().fetch_all(&mut *tx).await?;
    let mut vlan_map: HashMap<i64, i64> = HashMap::new();
    for (old, vid, name, description, color, notes) in vlans {
        let there: Option<(i64, String, Option<String>)> =
            sqlx::query_as("SELECT id, name, notes FROM vlans WHERE project_id = ? AND vid = ?")
                .bind(to)
                .bind(vid)
                .fetch_optional(&mut *tx)
                .await?;
        let (action, new) = match (mode, there) {
            ("clear", _) => ("cleared", None),
            ("reuse", Some((id, n, nt))) if n == name && nt == notes => ("reused", Some(id)),
            (_, Some(_)) => ("cleared (the number is used differently there)", None),
            (_, None) => {
                let id: i64 = sqlx::query_scalar("INSERT INTO vlans (project_id, vid, name, description, color, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
                    .bind(to).bind(vid).bind(&name).bind(&description).bind(&color).bind(&notes).bind(&now).bind(&now)
                    .fetch_one(&mut *tx).await?;
                ("copied", Some(id))
            }
        };
        report
            .vlans
            .push(json!({ "vid": vid, "name": name, "action": action }));
        let mut q = QueryBuilder::<Sqlite>::new("");
        match new {
            Some(n) => {
                vlan_map.insert(old, n);
                q.push("UPDATE port_vlans SET vlan_id = ")
                    .push_bind(n)
                    .push(" WHERE 1 = 1");
            }
            None => {
                q.push("DELETE FROM port_vlans WHERE 1 = 1");
            }
        }
        q.push(" AND vlan_id = ")
            .push_bind(old)
            .push(" AND port_id IN (SELECT id FROM ports WHERE device_id IN (");
        push_ids(&mut q, devices);
        q.push(")");
        q.build().execute(&mut *tx).await?;
    }

    // WLANs on the moved radios, matched by SSID.
    let mut q = QueryBuilder::<Sqlite>::new("SELECT DISTINCT w.id, w.ssid, w.description, w.security, w.hidden, w.vlan_id, w.notes FROM ports o JOIN wlans w ON w.id = o.wlan_id WHERE o.device_id IN (");
    push_ids(&mut q, devices);
    #[allow(clippy::type_complexity)]
    let wlans: Vec<(
        i64,
        String,
        Option<String>,
        String,
        bool,
        Option<i64>,
        Option<String>,
    )> = q.build_query_as().fetch_all(&mut *tx).await?;
    for (old, ssid, description, security, hidden, vlan, notes) in wlans {
        let there: Option<(i64, String, Option<String>)> = sqlx::query_as(
            "SELECT id, security, notes FROM wlans WHERE project_id = ? AND ssid = ?",
        )
        .bind(to)
        .bind(&ssid)
        .fetch_optional(&mut *tx)
        .await?;
        let (action, new) = match (mode, there) {
            ("clear", _) => ("cleared", None),
            ("reuse", Some((id, sec, nt))) if sec == security && nt == notes => {
                ("reused", Some(id))
            }
            (_, Some(_)) => ("cleared (the SSID is used differently there)", None),
            (_, None) => {
                let id: i64 = sqlx::query_scalar("INSERT INTO wlans (project_id, ssid, description, security, hidden, vlan_id, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
                    .bind(to).bind(&ssid).bind(&description).bind(&security).bind(hidden).bind(vlan.and_then(|v| vlan_map.get(&v).copied())).bind(&notes).bind(&now).bind(&now)
                    .fetch_one(&mut *tx).await?;
                ("copied", Some(id))
            }
        };
        report.wlans.push(json!({ "ssid": ssid, "action": action }));
        let mut q = QueryBuilder::<Sqlite>::new("UPDATE ports SET wlan_id = ");
        q.push_bind(new)
            .push(" WHERE wlan_id = ")
            .push_bind(old)
            .push(" AND device_id IN (");
        push_ids(&mut q, devices);
        q.build().execute(&mut *tx).await?;
    }

    // Cables left among the moved devices move with them.
    let mut q = QueryBuilder::<Sqlite>::new("UPDATE connections SET project_id = ");
    q.push_bind(to).push(" WHERE id IN (SELECT e.connection_id FROM connection_ends e JOIN ports o ON o.id = e.port_id WHERE o.device_id IN (");
    push_ids(&mut q, devices);
    q.push(")");
    q.build().execute(&mut *tx).await?;

    // IP plans are per project: the old project's addresses stay there,
    // no longer linked to the devices.
    let mut q = QueryBuilder::<Sqlite>::new(
        "UPDATE ip_addresses SET device_id = NULL, port_id = NULL WHERE project_id = ",
    );
    q.push_bind(from).push(" AND device_id IN (");
    push_ids(&mut q, devices);
    report.addresses_unlinked = q.build().execute(&mut *tx).await?.rows_affected() as i64;

    // Diagrams in the old project keep the box, as a label.
    let mut q = QueryBuilder::<Sqlite>::new(
        "UPDATE topology_nodes SET label = COALESCE(label, (SELECT code FROM devices WHERE id = topology_nodes.device_id)), device_id = NULL WHERE device_id IN (",
    );
    push_ids(&mut q, devices);
    report.diagram_boxes_unlinked = q.build().execute(&mut *tx).await?.rows_affected() as i64;

    // Integrations belong to the old project.
    let mut q = QueryBuilder::<Sqlite>::new(
        "UPDATE devices SET source_integration_id = NULL, external_id = NULL, project_id = ",
    );
    q.push_bind(to).push(" WHERE id IN (");
    push_ids(&mut q, devices);
    q.build().execute(&mut *tx).await?;
    let mut q = QueryBuilder::<Sqlite>::new(
        "SELECT COUNT(*) FROM devices WHERE source = 'integration' AND id IN (",
    );
    push_ids(&mut q, devices);
    report.integration_links_cleared = q.build_query_scalar().fetch_one(&mut *tx).await?;
    let mut q = QueryBuilder::<Sqlite>::new(
        "UPDATE devices SET source = 'manual' WHERE source = 'integration' AND id IN (",
    );
    push_ids(&mut q, devices);
    q.build().execute(&mut *tx).await?;
    clear_responsible(tx, subtree, to, report).await
}

/// Responsible people who can't read the target project are cleared.
async fn clear_responsible(
    tx: &mut SqliteConnection,
    subtree: Subtree,
    to: i64,
    report: &mut Report,
) -> AppResult<()> {
    let (f, l) = match subtree {
        Subtree::Floor(x) => (x, -1),
        Subtree::Location(x) => (-1, x),
        _ => return Ok(()),
    };
    // Users who can read the target: the owner, account-wide grants, or
    // any grant in the project (reading is project-wide).
    let readers: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM users WHERE is_owner = 1
         UNION SELECT user_id FROM role_grants WHERE scope_type = 'account' OR project_id = ?",
    )
    .bind(to)
    .fetch_all(&mut *tx)
    .await?;
    let mut cleared: Vec<i64> = Vec::new();
    if l > 0 {
        let who: Option<i64> =
            sqlx::query_scalar("SELECT responsible_user_id FROM locations WHERE id = ?")
                .bind(l)
                .fetch_optional(&mut *tx)
                .await?
                .flatten();
        if let Some(u) = who.filter(|u| !readers.contains(u)) {
            sqlx::query("UPDATE locations SET responsible_user_id = NULL WHERE id = ?")
                .bind(l)
                .execute(&mut *tx)
                .await?;
            cleared.push(u);
        }
    }
    for (find, clear) in [
        ("SELECT r.id, r.responsible_user_id FROM rooms r JOIN search_entries s ON s.kind = 'room' AND s.ref_id = r.id WHERE (s.floor_id = ? OR s.location_id = ?) AND r.responsible_user_id IS NOT NULL", "UPDATE rooms SET responsible_user_id = NULL WHERE id = ?"),
        ("SELECT k.id, k.responsible_user_id FROM racks k JOIN search_entries s ON s.kind = 'rack' AND s.ref_id = k.id WHERE (s.floor_id = ? OR s.location_id = ?) AND k.responsible_user_id IS NOT NULL", "UPDATE racks SET responsible_user_id = NULL WHERE id = ?"),
        ("SELECT d.id, d.responsible_user_id FROM devices d JOIN search_entries s ON s.kind = 'device' AND s.ref_id = d.id WHERE (s.floor_id = ? OR s.location_id = ?) AND d.responsible_user_id IS NOT NULL", "UPDATE devices SET responsible_user_id = NULL WHERE id = ?"),
    ] {
        let rows: Vec<(i64, i64)> = sqlx::query_as(find).bind(f).bind(l).fetch_all(&mut *tx).await?;
        for (id, u) in rows {
            if !readers.contains(&u) {
                sqlx::query(clear).bind(id).execute(&mut *tx).await?;
                cleared.push(u);
            }
        }
    }
    cleared.sort_unstable();
    cleared.dedup();
    for u in cleared {
        let name: Option<String> = sqlx::query_scalar("SELECT username FROM users WHERE id = ?")
            .bind(u)
            .fetch_optional(&mut *tx)
            .await?;
        report.responsible_cleared.extend(name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggestions_come_from_the_message() {
        assert_eq!(
            suggested("RK01 is already used in that room; try RK02").as_deref(),
            Some("RK02")
        );
        assert_eq!(
            suggested("Location HQ is already used in that project; try HQ-2").as_deref(),
            Some("HQ-2")
        );
        assert!(is_clash(&AppError::Conflict(
            "Floor 2 is already used in that location; try 2-2".into()
        ))
        .is_some());
        assert!(is_clash(&AppError::bad("Code must be at most 16 characters")).is_none());
    }
}
