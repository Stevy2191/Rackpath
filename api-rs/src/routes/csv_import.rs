//! CSV import (design section 15): devices, ports, connections, prefixes,
//! ranges and addresses, one kind per file.
//!
//! `POST /api/projects/{id}/import/csv?kind=devices&dry_run=true` with the
//! file as the body. Every row goes through the same checks, permissions
//! and change history as the API, inside one transaction (a savepoint per
//! row). If any row fails, nothing is saved and every problem is listed by
//! row number; `dry_run` checks the whole file without saving.
//!
//! Places, devices and ports are referenced by path within the project:
//! `HQ/2/MDF` (room), `HQ/2/MDF/RK01` (rack), `HQ/2/MDF/RK01/SW01`
//! (device), `HQ/2/MDF/RK01/SW01/24` (port), or `UNPLACED/SW01`. The
//! project code in front is optional. Column names are case-insensitive;
//! unknown columns are refused so typos don't silently drop data.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::{Connection, SqliteConnection};

use super::require;
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::permissions::{Action, Chain};
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::state::AppState;

const MAX_ROWS: usize = 20_000;

fn columns(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "devices" => &[
            "device_type",
            "template",
            "code",
            "name",
            "room",
            "rack",
            "u",
            "face",
            "mount",
            "u_height",
            "manufacturer",
            "model",
            "serial_number",
            "asset_tag",
            "hostname",
            "mac",
            "status",
            "purchase_date",
            "warranty_expiry",
            "notes",
        ],
        "ports" => &[
            "device",
            "code",
            "connector",
            "transceiver",
            "medium",
            "role",
            "face",
            "speed",
            "poe",
            "interface_name",
            "description",
            "outlet_group",
            "notes",
        ],
        "connections" => &[
            "a",
            "b",
            "a_side",
            "b_side",
            "kind",
            "cable_type",
            "length_m",
            "color",
            "label",
            "notes",
        ],
        "prefixes" => &[
            "cidr",
            "space",
            "vlan",
            "location",
            "role",
            "status",
            "gateway",
            "dns_servers",
            "domain_name",
            "description",
            "notes",
        ],
        "ranges" => &["prefix", "space", "start", "end", "kind", "description"],
        "addresses" => &[
            "address",
            "space",
            "device",
            "port",
            "prefix_len",
            "role",
            "status",
            "mac",
            "dns_name",
            "dns_aliases",
            "dhcp_reservation",
            "description",
            "notes",
        ],
        _ => return None,
    })
}

pub const KINDS: [&str; 6] = [
    "devices",
    "ports",
    "connections",
    "prefixes",
    "ranges",
    "addresses",
];

/// The columns each kind of CSV file takes, for the import page and its
/// downloadable header row.
pub async fn columns_list(_current: CurrentUser) -> Json<Value> {
    Json(columns_json())
}

fn columns_json() -> Value {
    Value::Object(
        KINDS
            .iter()
            .map(|k| ((*k).to_string(), json!(columns(k).unwrap_or(&[]))))
            .collect(),
    )
}

#[derive(Deserialize)]
pub struct CsvQuery {
    kind: String,
    #[serde(default)]
    dry_run: bool,
}

fn message(e: AppError) -> String {
    match e {
        AppError::BadRequest(m) | AppError::Conflict(m) | AppError::Forbidden(m) => m,
        AppError::NotFound => "not found".into(),
        other => {
            tracing::error!(error = %other, "CSV import row failed");
            "internal error".into()
        }
    }
}

struct Resolver {
    project_id: i64,
    project_code: String,
}

impl Resolver {
    /// Path within the project -> id, via the search index.
    async fn path(&self, conn: &mut SqliteConnection, kind: &str, path: &str) -> AppResult<i64> {
        let p = path.trim().trim_matches('/').to_ascii_uppercase();
        let prefix = format!("{}/", self.project_code);
        let full = if p.starts_with(&prefix) {
            p.clone()
        } else {
            format!("{prefix}{p}")
        };
        let id: Option<i64> = sqlx::query_scalar(
            "SELECT ref_id FROM search_entries WHERE kind = ? AND project_id = ? AND path = ?",
        )
        .bind(kind)
        .bind(self.project_id)
        .bind(&full)
        .fetch_optional(conn)
        .await?;
        id.ok_or_else(|| AppError::bad(format!("No {kind} at {path}")))
    }

    async fn space(
        &self,
        conn: &mut SqliteConnection,
        name: Option<&String>,
    ) -> AppResult<Option<i64>> {
        match name {
            None => Ok(None),
            Some(n) => {
                let id: Option<i64> =
                    sqlx::query_scalar("SELECT id FROM address_spaces WHERE project_id = ? AND name = ? COLLATE NOCASE")
                        .bind(self.project_id)
                        .bind(n)
                        .fetch_optional(conn)
                        .await?;
                id.map(Some)
                    .ok_or_else(|| AppError::bad(format!("No address space {n}")))
            }
        }
    }
}

fn num(row: &HashMap<String, String>, col: &str) -> AppResult<Option<f64>> {
    row.get(col)
        .map(|v| {
            v.parse::<f64>()
                .map_err(|_| AppError::bad(format!("{col} must be a number")))
        })
        .transpose()
}

fn int(row: &HashMap<String, String>, col: &str) -> AppResult<Option<i64>> {
    row.get(col)
        .map(|v| {
            v.parse::<i64>()
                .map_err(|_| AppError::bad(format!("{col} must be a whole number")))
        })
        .transpose()
}

fn boolean(row: &HashMap<String, String>, col: &str) -> AppResult<Option<bool>> {
    row.get(col)
        .map(|v| match v.to_ascii_lowercase().as_str() {
            "true" | "yes" | "y" | "1" => Ok(true),
            "false" | "no" | "n" | "0" => Ok(false),
            _ => Err(AppError::bad(format!("{col} must be true or false"))),
        })
        .transpose()
}

/// Copies plain text columns into a JSON body.
fn copy(row: &HashMap<String, String>, body: &mut Map<String, Value>, cols: &[&str]) {
    for c in cols {
        if let Some(v) = row.get(*c) {
            body.insert((*c).to_string(), json!(v));
        }
    }
}

/// Records that a row came from a CSV file.
async fn mark_csv(conn: &mut SqliteConnection, table: &str, v: &Value) -> AppResult<()> {
    let id = v["id"].as_i64().unwrap_or(-1);
    let sql = match table {
        "devices" => "UPDATE devices SET source = 'csv_import' WHERE id = ?",
        "prefixes" => "UPDATE prefixes SET source = 'csv_import' WHERE id = ?",
        "ip_ranges" => "UPDATE ip_ranges SET source = 'csv_import' WHERE id = ?",
        _ => "UPDATE ip_addresses SET source = 'csv_import' WHERE id = ?",
    };
    sqlx::query(sql).bind(id).execute(conn).await?;
    Ok(())
}

async fn import_row(
    conn: &mut SqliteConnection,
    ctx: &RequestCtx,
    current: &CurrentUser,
    r: &Resolver,
    kind: &str,
    row: &HashMap<String, String>,
) -> AppResult<String> {
    let mut b = Map::new();
    match kind {
        "devices" => {
            copy(
                row,
                &mut b,
                &[
                    "device_type",
                    "code",
                    "name",
                    "manufacturer",
                    "model",
                    "serial_number",
                    "asset_tag",
                    "hostname",
                    "mac",
                    "status",
                    "purchase_date",
                    "warranty_expiry",
                    "notes",
                ],
            );
            if let Some(h) = num(row, "u_height")? {
                b.insert("u_height".into(), json!(h));
            }
            if let Some(t) = row.get("template") {
                let id: Option<i64> = sqlx::query_scalar(
                    "SELECT id FROM device_templates WHERE (project_id = ? AND name = ? COLLATE NOCASE) OR builtin_key = ?
                     ORDER BY project_id IS NULL LIMIT 1",
                )
                .bind(r.project_id)
                .bind(t)
                .bind(t)
                .fetch_optional(&mut *conn)
                .await?;
                b.insert(
                    "template_id".into(),
                    json!(id.ok_or_else(|| AppError::bad(format!("No template {t}")))?),
                );
            }
            let placement = match (row.get("rack"), row.get("room")) {
                (Some(rack), _) => {
                    let id = r.path(conn, "rack", rack).await?;
                    json!({ "type": "rack", "rack_id": id, "u": num(row, "u")?, "face": row.get("face"), "mount": row.get("mount") })
                }
                (None, Some(room)) => {
                    json!({ "type": "room", "room_id": r.path(conn, "room", room).await? })
                }
                (None, None) => json!({ "type": "unplaced" }),
            };
            b.insert("placement".into(), placement);
            let body = serde_json::from_value(Value::Object(b))
                .map_err(|e| AppError::bad(e.to_string()))?;
            let v = super::devices::create_in(conn, ctx, current, r.project_id, body).await?;
            mark_csv(conn, "devices", &v).await?;
            Ok(v["path"].as_str().unwrap_or_default().to_string())
        }
        "ports" => {
            let device = r
                .path(
                    conn,
                    "device",
                    row.get("device")
                        .ok_or_else(|| AppError::bad("device is required"))?,
                )
                .await?;
            copy(
                row,
                &mut b,
                &[
                    "code",
                    "connector",
                    "transceiver",
                    "medium",
                    "role",
                    "face",
                    "poe",
                    "interface_name",
                    "description",
                    "notes",
                ],
            );
            for c in ["speed", "outlet_group"] {
                if let Some(v) = int(row, c)? {
                    b.insert(c.into(), json!(v));
                }
            }
            let body = serde_json::from_value(Value::Object(b))
                .map_err(|e| AppError::bad(e.to_string()))?;
            let v = super::ports::create_in(conn, ctx, current, device, body).await?;
            Ok(v["path"].as_str().unwrap_or_default().to_string())
        }
        "connections" => {
            let a = r
                .path(
                    conn,
                    "port",
                    row.get("a").ok_or_else(|| AppError::bad("a is required"))?,
                )
                .await?;
            let bb = r
                .path(
                    conn,
                    "port",
                    row.get("b").ok_or_else(|| AppError::bad("b is required"))?,
                )
                .await?;
            b.insert(
                "a".into(),
                json!({ "port_id": a, "side": row.get("a_side") }),
            );
            b.insert(
                "b".into(),
                json!({ "port_id": bb, "side": row.get("b_side") }),
            );
            copy(
                row,
                &mut b,
                &["kind", "cable_type", "color", "label", "notes"],
            );
            if let Some(l) = num(row, "length_m")? {
                b.insert("length_m".into(), json!(l));
            }
            let body = serde_json::from_value(Value::Object(b))
                .map_err(|e| AppError::bad(e.to_string()))?;
            let v = super::connections::create_in(conn, ctx, current, body).await?;
            Ok(format!(
                "{} ↔ {}",
                v["a"]["path"].as_str().unwrap_or(""),
                v["b"]["path"].as_str().unwrap_or("")
            ))
        }
        "prefixes" => {
            copy(
                row,
                &mut b,
                &[
                    "cidr",
                    "role",
                    "status",
                    "gateway",
                    "dns_servers",
                    "domain_name",
                    "description",
                    "notes",
                ],
            );
            if let Some(s) = r.space(conn, row.get("space")).await? {
                b.insert("space_id".into(), json!(s));
            }
            if let Some(vid) = int(row, "vlan")? {
                let id: Option<i64> =
                    sqlx::query_scalar("SELECT id FROM vlans WHERE project_id = ? AND vid = ?")
                        .bind(r.project_id)
                        .bind(vid)
                        .fetch_optional(&mut *conn)
                        .await?;
                b.insert(
                    "vlan_id".into(),
                    json!(id.ok_or_else(|| AppError::bad(format!("No VLAN {vid}")))?),
                );
            }
            if let Some(l) = row.get("location") {
                b.insert(
                    "location_id".into(),
                    json!(r.path(conn, "location", l).await?),
                );
            }
            let body = serde_json::from_value(Value::Object(b))
                .map_err(|e| AppError::bad(e.to_string()))?;
            let v = super::ipam::create_prefix_in(conn, ctx, current, r.project_id, body).await?;
            mark_csv(conn, "prefixes", &v).await?;
            Ok(v["cidr"].as_str().unwrap_or_default().to_string())
        }
        "ranges" => {
            let cidr = row
                .get("prefix")
                .ok_or_else(|| AppError::bad("prefix is required"))?;
            let space = match r.space(conn, row.get("space")).await? {
                Some(s) => s,
                None => {
                    sqlx::query_scalar(
                        "SELECT id FROM address_spaces WHERE project_id = ? AND is_default = 1",
                    )
                    .bind(r.project_id)
                    .fetch_one(&mut *conn)
                    .await?
                }
            };
            let cidr_norm = crate::domain::ip::parse_cidr(cidr)
                .map_err(AppError::bad)?
                .to_string();
            let pid: Option<i64> =
                sqlx::query_scalar("SELECT id FROM prefixes WHERE space_id = ? AND cidr = ?")
                    .bind(space)
                    .bind(&cidr_norm)
                    .fetch_optional(&mut *conn)
                    .await?;
            let pid = pid.ok_or_else(|| AppError::bad(format!("No prefix {cidr_norm}")))?;
            copy(row, &mut b, &["start", "end", "kind", "description"]);
            let body = serde_json::from_value(Value::Object(b))
                .map_err(|e| AppError::bad(e.to_string()))?;
            let v = super::ipam::create_range_in(conn, ctx, current, pid, body).await?;
            mark_csv(conn, "ip_ranges", &v).await?;
            Ok(format!(
                "{}-{}",
                v["start_text"].as_str().unwrap_or(""),
                v["end_text"].as_str().unwrap_or("")
            ))
        }
        "addresses" => {
            copy(
                row,
                &mut b,
                &[
                    "address",
                    "role",
                    "status",
                    "mac",
                    "dns_name",
                    "description",
                    "notes",
                ],
            );
            if let Some(s) = r.space(conn, row.get("space")).await? {
                b.insert("space_id".into(), json!(s));
            }
            if let Some(p) = row.get("port") {
                b.insert("port_id".into(), json!(r.path(conn, "port", p).await?));
            } else if let Some(d) = row.get("device") {
                b.insert("device_id".into(), json!(r.path(conn, "device", d).await?));
            }
            if let Some(l) = int(row, "prefix_len")? {
                b.insert("prefix_len".into(), json!(l));
            }
            if let Some(v) = boolean(row, "dhcp_reservation")? {
                b.insert("dhcp_reservation".into(), json!(v));
            }
            if let Some(a) = row.get("dns_aliases") {
                let list: Vec<&str> = a.split([';', ',', ' ']).filter(|x| !x.is_empty()).collect();
                b.insert("dns_aliases".into(), json!(list));
            }
            let body = serde_json::from_value(Value::Object(b))
                .map_err(|e| AppError::bad(e.to_string()))?;
            let v = super::ipam::create_address_in(conn, ctx, current, r.project_id, body).await?;
            mark_csv(conn, "ip_addresses", &v).await?;
            Ok(v["address"].as_str().unwrap_or_default().to_string())
        }
        _ => Err(AppError::bad("Unknown kind")),
    }
}

pub async fn import(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    Query(q): Query<CsvQuery>,
    body: Bytes,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let allowed = columns(&q.kind).ok_or_else(|| {
        AppError::bad("kind must be devices, ports, connections, prefixes, ranges or addresses")
    })?;
    let text = std::str::from_utf8(body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&body))
        .map_err(|_| AppError::bad("The file must be UTF-8 text"))?;
    let mut reader = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .flexible(false)
        .from_reader(text.as_bytes());
    let headers: Vec<String> = reader
        .headers()
        .map_err(|e| AppError::bad(format!("Can't read the header row: {e}")))?
        .iter()
        .map(|h| h.to_ascii_lowercase())
        .collect();
    for h in &headers {
        if !allowed.contains(&h.as_str()) {
            return Err(AppError::bad(format!(
                "Unknown column {h}; {} files take: {}",
                q.kind,
                allowed.join(", ")
            )));
        }
    }
    let mut rows = Vec::new();
    for (i, rec) in reader.records().enumerate() {
        let rec = rec.map_err(|e| AppError::bad(format!("Row {}: {e}", i + 2)))?;
        if rows.len() >= MAX_ROWS {
            return Err(AppError::bad(format!("At most {MAX_ROWS} rows per file")));
        }
        let row: HashMap<String, String> = headers
            .iter()
            .zip(rec.iter())
            .filter(|(_, v)| !v.is_empty())
            .map(|(h, v)| (h.clone(), v.to_string()))
            .collect();
        if !row.is_empty() {
            rows.push((i + 2, row));
        }
    }

    let mut tx = state.pool.begin().await?;
    let project_code: String = sqlx::query_scalar("SELECT code FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?;
    let resolver = Resolver {
        project_id,
        project_code,
    };
    let mut errors = Vec::new();
    let mut done = Vec::new();
    for (line, row) in &rows {
        let mut sp = Connection::begin(&mut *tx).await?;
        match import_row(&mut sp, &ctx, &current, &resolver, &q.kind, row).await {
            Ok(what) => {
                sp.commit().await?;
                done.push(what);
            }
            Err(e) => {
                sp.rollback().await?;
                errors.push(json!({ "row": line, "message": message(e) }));
                if errors.len() >= 200 {
                    break;
                }
            }
        }
    }
    let applied = errors.is_empty() && !q.dry_run && !rows.is_empty();
    if applied {
        audit::record(
            &mut tx,
            &ctx,
            Some(current.actor_ref()),
            Entry::new("import", "csv", None)
                .path(format!("{} file", q.kind))
                .project(Some(project_id))
                .changes(json!({ "kind": q.kind, "rows": rows.len() })),
        )
        .await?;
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok(Json(json!({
        "kind": q.kind, "rows": rows.len(), "dry_run": q.dry_run, "applied": applied,
        "ok": done.len(), "errors": errors,
        "created": done.iter().take(1000).collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod column_tests {
    use super::*;

    #[test]
    fn every_kind_lists_its_columns() {
        let v = columns_json();
        for k in KINDS {
            assert!(!v[k].as_array().unwrap().is_empty(), "{k}");
        }
        assert!(v["connections"]
            .as_array()
            .unwrap()
            .contains(&json!("cable_type")));
        assert_eq!(v.as_object().unwrap().len(), KINDS.len());
    }
}
