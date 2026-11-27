//! Exports (design section 16): PDF reports, a rack's bill of materials,
//! CSV tables, and the short links QR codes point at.

use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::require;
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::permissions::{Action, Chain, ScopeType};
use crate::error::{AppError, AppResult};
use crate::export::pdf::Doc;
use crate::export::report::{self, Scope};
use crate::hierarchy;
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

// ---------------------------------------------------------------- limits

/// At most 3 PDF exports a minute per person.
static RECENT: LazyLock<Mutex<HashMap<i64, Vec<Instant>>>> = LazyLock::new(Default::default);

fn limit(user: i64) -> AppResult<()> {
    let now = Instant::now();
    let mut map = RECENT.lock().expect("export limiter");
    let list = map.entry(user).or_default();
    list.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
    if list.len() >= 3 {
        let wait = 60 - now.duration_since(list[0]).as_secs();
        return Err(AppError::TooManyRequests {
            retry_after_secs: wait.max(1),
        });
    }
    list.push(now);
    Ok(())
}

/// Where QR codes point: RACKPATH_PUBLIC_URL, or the address the request
/// came to.
fn base_url(state: &AppState, headers: &HeaderMap) -> String {
    if let Some(u) = &state.config.public_url {
        return u.clone();
    }
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    let scheme = if state.config.cookie_secure {
        "https"
    } else {
        "http"
    };
    format!("{scheme}://{host}")
}

fn file(body: Vec<u8>, mime: &'static str, filename: &str) -> Response {
    let safe: String = filename
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    let mut r = body.into_response();
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{safe}\"")) {
        r.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }
    r
}

fn scope_type(kind: &str) -> AppResult<ScopeType> {
    Ok(match kind {
        "project" => ScopeType::Project,
        "location" => ScopeType::Location,
        "floor" => ScopeType::Floor,
        "room" => ScopeType::Room,
        "rack" => ScopeType::Rack,
        "device" => ScopeType::Device,
        _ => {
            return Err(AppError::bad(
                "type must be project, location, floor, room, rack or device",
            ))
        }
    })
}

// ---------------------------------------------------------------- reports

#[derive(Deserialize)]
pub struct ReportQuery {
    #[serde(rename = "type")]
    kind: String,
    id: i64,
}

pub async fn report_pdf(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    headers: HeaderMap,
    Query(q): Query<ReportQuery>,
) -> AppResult<Response> {
    let kind = scope_type(&q.kind)?;
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get_any(&mut conn, kind, q.id).await?;
    require(&current, Action::Read, &placed.chain)?;
    limit(current.user.id)?;
    let now = now_ts();
    let by = current
        .user
        .display_name
        .clone()
        .unwrap_or_else(|| current.user.username.clone());
    let r = report::build(
        &mut conn,
        Scope { kind, id: q.id },
        &base_url(&state, &headers),
        &by,
        &now[..16].replace('T', " "),
    )
    .await?;
    audit::record(
        &mut conn,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("export", &q.kind, Some(q.id))
            .path(r.path.clone())
            .project(Some(r.project_id))
            .changes(json!({ "format": "pdf", "bytes": r.pdf.len() })),
    )
    .await?;
    Ok(file(r.pdf, "application/pdf", &r.filename))
}

// ---------------------------------------------------------------- BOM

#[derive(Deserialize)]
pub struct FormatQuery {
    format: Option<String>,
}

/// A rack's bill of materials: devices grouped by type and model, cords
/// grouped by kind, type, length and colour.
async fn bom(conn: &mut sqlx::SqliteConnection, rack: i64) -> AppResult<Value> {
    let devices = super::devices::rack_devices(conn, rack).await?;
    // (type, manufacturer, model) → (position, code, position text)
    type Group = Vec<(f64, String, String)>;
    let mut groups: BTreeMap<(String, String, String), Group> = BTreeMap::new();
    for d in &devices {
        let key = (
            d["device_type"]["label"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            d["manufacturer"].as_str().unwrap_or_default().to_string(),
            d["model"].as_str().unwrap_or_default().to_string(),
        );
        let p = &d["placement"];
        let pos = match (p["u"].as_f64(), d["u_height"].as_f64()) {
            (Some(u), Some(h)) if h > 1.0 => format!("U{u}–U{}", (u + h).ceil() - 1.0),
            (Some(u), _) => format!("U{u}"),
            _ => "zero-U".into(),
        };
        groups.entry(key).or_default().push((
            p["u"].as_f64().unwrap_or(f64::MAX),
            d["code"].as_str().unwrap_or_default().to_string(),
            pos,
        ));
    }
    #[allow(clippy::type_complexity)]
    let cords: Vec<(String, Option<String>, Option<f64>, Option<String>, i64)> = sqlx::query_as(
        "SELECT c.kind, c.cable_type, c.length_m, c.color, COUNT(*) FROM connections c
         WHERE c.id IN (SELECT e.connection_id FROM connection_ends e JOIN ports o ON o.id = e.port_id
                        JOIN search_entries s ON s.kind = 'device' AND s.ref_id = o.device_id WHERE s.rack_id = ?)
           AND c.kind IN ('patch', 'power')
         GROUP BY c.kind, c.cable_type, c.length_m, c.color ORDER BY c.kind, c.cable_type, c.length_m",
    )
    .bind(rack)
    .fetch_all(&mut *conn)
    .await?;
    Ok(json!({
        "devices": groups.into_iter().map(|((t, m, model), mut items)| {
            items.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
            json!({
                "type": t, "manufacturer": m, "model": model, "quantity": items.len(),
                "codes": items.iter().map(|i| i.1.clone()).collect::<Vec<_>>(),
                "positions": items.iter().map(|i| i.2.clone()).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
        "cords": cords.into_iter().map(|(k, t, l, c, n)| json!({
            "kind": k, "cable_type": t, "length_m": l, "color": c, "quantity": n,
        })).collect::<Vec<_>>(),
    }))
}

fn csv_bytes(header: &[&str], rows: Vec<Vec<String>>) -> AppResult<Vec<u8>> {
    let mut w = csv::Writer::from_writer(Vec::new());
    w.write_record(header)
        .map_err(|e| AppError::internal(e.to_string()))?;
    for r in rows {
        // Cells that a spreadsheet would run as a formula are prefixed.
        let r: Vec<String> = r
            .into_iter()
            .map(|c| {
                if c.starts_with(['=', '+', '-', '@']) {
                    format!("'{c}")
                } else {
                    c
                }
            })
            .collect();
        w.write_record(&r)
            .map_err(|e| AppError::internal(e.to_string()))?;
    }
    w.into_inner()
        .map_err(|e| AppError::internal(e.to_string()))
}

pub async fn rack_bom(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(rack): Path<i64>,
    Query(q): Query<FormatQuery>,
) -> AppResult<Response> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Rack, rack).await?;
    require(&current, Action::Read, &placed.chain)?;
    let b = bom(&mut conn, rack).await?;
    let format = q.format.as_deref().unwrap_or("json");
    let s = |v: &Value| match v {
        Value::String(x) => x.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    let device_rows: Vec<Vec<String>> = b["devices"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|d| {
            vec![
                s(&d["quantity"]),
                s(&d["type"]),
                s(&d["manufacturer"]),
                s(&d["model"]),
                d["codes"]
                    .as_array()
                    .map(|c| c.iter().map(s).collect::<Vec<_>>().join(" "))
                    .unwrap_or_default(),
                d["positions"]
                    .as_array()
                    .map(|c| c.iter().map(s).collect::<Vec<_>>().join(" "))
                    .unwrap_or_default(),
            ]
        })
        .collect();
    let cord_rows: Vec<Vec<String>> = b["cords"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            vec![
                s(&c["quantity"]),
                s(&c["kind"]),
                s(&c["cable_type"]),
                c["length_m"]
                    .as_f64()
                    .map(|l| format!("{l} m"))
                    .unwrap_or_default(),
                s(&c["color"]),
            ]
        })
        .collect();
    let name = format!("rackpath-bom-{}", placed.path.replace('/', "-"));
    let response = match format {
        "json" => return Ok(Json(b).into_response()),
        "csv" => {
            let mut rows: Vec<Vec<String>> = device_rows
                .into_iter()
                .map(|mut r| {
                    r.insert(0, "device".into());
                    r
                })
                .collect();
            rows.extend(cord_rows.into_iter().map(|r| {
                vec![
                    "cord".into(),
                    r[0].clone(),
                    r[1].clone(),
                    r[2].clone(),
                    r[3].clone(),
                    r[4].clone(),
                    String::new(),
                ]
            }));
            file(
                csv_bytes(
                    &[
                        "item",
                        "quantity",
                        "type_or_kind",
                        "manufacturer_or_cable",
                        "model_or_length",
                        "codes_or_colour",
                        "positions",
                    ],
                    rows,
                )?,
                "text/csv; charset=utf-8",
                &format!("{name}.csv"),
            )
        }
        "pdf" => {
            limit(current.user.id)?;
            let mut doc = Doc::new();
            doc.heading(
                1,
                &format!("Bill of materials: {}", placed.path.replace('/', " / ")),
                None,
                None,
            );
            doc.heading(2, "Devices", None, None);
            doc.table(
                &[
                    ("Qty", 0.5, false),
                    ("Type", 1.2, false),
                    ("Manufacturer", 1.2, false),
                    ("Model", 1.4, false),
                    ("Codes", 1.6, true),
                    ("Positions", 1.6, false),
                ],
                &device_rows,
            );
            doc.heading(2, "Cords", None, None);
            doc.table(
                &[
                    ("Qty", 0.5, false),
                    ("Kind", 1.0, false),
                    ("Type", 1.2, false),
                    ("Length", 1.0, false),
                    ("Colour", 1.0, true),
                ],
                &cord_rows,
            );
            let pdf = doc
                .finish(
                    &format!("Bill of materials, {}", placed.path),
                    &[
                        ("Rack", placed.path.clone()),
                        ("Exported", now_ts()[..16].replace('T', " ")),
                    ],
                    &format!("Rackpath · BOM · {}", placed.path),
                    None,
                )
                .map_err(AppError::internal)?;
            file(pdf, "application/pdf", &format!("{name}.pdf"))
        }
        _ => return Err(AppError::bad("format must be json, csv or pdf")),
    };
    audit::record(
        &mut conn,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("export", "rack", Some(rack))
            .path(placed.path.clone())
            .project(Some(placed.project_id))
            .changes(json!({ "bom": format })),
    )
    .await?;
    Ok(response)
}

// ---------------------------------------------------------------- CSV tables

pub async fn table_csv(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path((project, table)): Path<(i64, String)>,
) -> AppResult<Response> {
    require(&current, Action::Read, &Chain::project(project))?;
    let mut conn = state.pool.acquire().await?;
    let table = table.trim_end_matches(".csv").to_string();
    let (header, rows): (&[&str], Vec<Vec<String>>) = match table.as_str() {
        "devices" => {
            #[allow(clippy::type_complexity)]
            let r: Vec<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT d.code, s.path, t.label, d.status, d.name, d.manufacturer, d.model, d.serial_number, d.asset_tag, d.hostname, d.mac
                 FROM devices d JOIN device_types t ON t.id = d.device_type_id JOIN search_entries s ON s.kind = 'device' AND s.ref_id = d.id
                 WHERE d.project_id = ? ORDER BY s.path",
            )
            .bind(project)
            .fetch_all(&mut *conn)
            .await?;
            (
                &[
                    "code",
                    "path",
                    "type",
                    "status",
                    "name",
                    "manufacturer",
                    "model",
                    "serial_number",
                    "asset_tag",
                    "hostname",
                    "mac",
                ],
                r.into_iter()
                    .map(|x| {
                        vec![
                            x.0,
                            x.1,
                            x.2,
                            x.3,
                            x.4.unwrap_or_default(),
                            x.5.unwrap_or_default(),
                            x.6.unwrap_or_default(),
                            x.7.unwrap_or_default(),
                            x.8.unwrap_or_default(),
                            x.9.unwrap_or_default(),
                            x.10.unwrap_or_default(),
                        ]
                    })
                    .collect(),
            )
        }
        "connections" => {
            #[allow(clippy::type_complexity)]
            let r: Vec<(String, String, String, String, String, Option<String>, Option<f64>, Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT sa.path, ea.side, sb.path, eb.side, c.kind, c.cable_type, c.length_m, c.color, c.label
                 FROM connections c
                 JOIN connection_ends ea ON ea.connection_id = c.id AND ea.endpoint = 'a'
                 JOIN connection_ends eb ON eb.connection_id = c.id AND eb.endpoint = 'b'
                 JOIN search_entries sa ON sa.kind = 'port' AND sa.ref_id = ea.port_id
                 JOIN search_entries sb ON sb.kind = 'port' AND sb.ref_id = eb.port_id
                 WHERE c.project_id = ? ORDER BY sa.path",
            )
            .bind(project)
            .fetch_all(&mut *conn)
            .await?;
            (
                &[
                    "a",
                    "a_side",
                    "b",
                    "b_side",
                    "kind",
                    "cable_type",
                    "length_m",
                    "color",
                    "label",
                ],
                r.into_iter()
                    .map(|x| {
                        vec![
                            x.0,
                            x.1,
                            x.2,
                            x.3,
                            x.4,
                            x.5.unwrap_or_default(),
                            x.6.map(|l| l.to_string()).unwrap_or_default(),
                            x.7.unwrap_or_default(),
                            x.8.unwrap_or_default(),
                        ]
                    })
                    .collect(),
            )
        }
        "prefixes" => {
            #[allow(clippy::type_complexity)]
            let r: Vec<(String, String, String, Option<i64>, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT p.cidr, p.role, p.status, v.vid, p.gateway, p.description, l.code
                 FROM prefixes p LEFT JOIN vlans v ON v.id = p.vlan_id LEFT JOIN locations l ON l.id = p.location_id
                 WHERE p.project_id = ? ORDER BY p.space_id, p.family, p.net_start, p.prefix_len",
            )
            .bind(project)
            .fetch_all(&mut *conn)
            .await?;
            (
                &[
                    "cidr",
                    "role",
                    "status",
                    "vlan",
                    "gateway",
                    "description",
                    "location",
                ],
                r.into_iter()
                    .map(|x| {
                        vec![
                            x.0,
                            x.1,
                            x.2,
                            x.3.map(|v| v.to_string()).unwrap_or_default(),
                            x.4.unwrap_or_default(),
                            x.5.unwrap_or_default(),
                            x.6.unwrap_or_default(),
                        ]
                    })
                    .collect(),
            )
        }
        "addresses" => {
            #[allow(clippy::type_complexity)]
            let r: Vec<(String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, bool)> = sqlx::query_as(
                "SELECT a.address, a.role, a.status, a.dns_name, a.mac, sd.path, sp.path, a.dhcp_reservation
                 FROM ip_addresses a
                 LEFT JOIN search_entries sd ON sd.kind = 'device' AND sd.ref_id = a.device_id
                 LEFT JOIN search_entries sp ON sp.kind = 'port' AND sp.ref_id = a.port_id
                 WHERE a.project_id = ? ORDER BY a.space_id, a.family, a.addr_bin",
            )
            .bind(project)
            .fetch_all(&mut *conn)
            .await?;
            (
                &[
                    "address",
                    "role",
                    "status",
                    "dns_name",
                    "mac",
                    "device",
                    "port",
                    "dhcp_reservation",
                ],
                r.into_iter()
                    .map(|x| {
                        vec![
                            x.0,
                            x.1,
                            x.2,
                            x.3.unwrap_or_default(),
                            x.4.unwrap_or_default(),
                            x.5.unwrap_or_default(),
                            x.6.unwrap_or_default(),
                            x.7.to_string(),
                        ]
                    })
                    .collect(),
            )
        }
        _ => {
            return Err(AppError::bad(
                "table must be devices, connections, prefixes or addresses",
            ))
        }
    };
    let code: String = sqlx::query_scalar("SELECT code FROM projects WHERE id = ?")
        .bind(project)
        .fetch_one(&mut *conn)
        .await?;
    let count = rows.len();
    let bytes = csv_bytes(header, rows)?;
    audit::record(
        &mut conn,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("export", "project", Some(project))
            .project(Some(project))
            .changes(json!({ "csv": table, "rows": count })),
    )
    .await?;
    Ok(file(
        bytes,
        "text/csv; charset=utf-8",
        &format!("rackpath-{code}-{table}.csv"),
    ))
}

// ---------------------------------------------------------------- short links

/// Where `/r/{type}/{id}` goes. Something the user can't see is a 404, so
/// a link doesn't reveal that it exists.
pub async fn resolve(
    State(state): State<AppState>,
    current: CurrentUser,
    Path((kind, id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let (project, path) = match kind.as_str() {
        "prefix" | "address" => {
            let row: Option<i64> = if kind == "prefix" {
                sqlx::query_scalar("SELECT project_id FROM prefixes WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&mut *conn)
                    .await?
            } else {
                sqlx::query_scalar("SELECT project_id FROM ip_addresses WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&mut *conn)
                    .await?
            };
            let p = row.ok_or(AppError::NotFound)?;
            require(&current, Action::Read, &Chain::project(p))?;
            (
                p,
                if kind == "prefix" {
                    format!("ipam/prefixes/{id}")
                } else {
                    format!("ipam/addresses/{id}")
                },
            )
        }
        "port" => {
            let device: Option<i64> =
                sqlx::query_scalar("SELECT device_id FROM ports WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&mut *conn)
                    .await?;
            let placed = hierarchy::get(
                &mut conn,
                ScopeType::Device,
                device.ok_or(AppError::NotFound)?,
            )
            .await?;
            require(&current, Action::Read, &placed.chain)?;
            (placed.project_id, format!("ports/{id}"))
        }
        k => {
            let scope = scope_type(k).map_err(|_| AppError::NotFound)?;
            let placed = hierarchy::get_any(&mut conn, scope, id).await?;
            require(&current, Action::Read, &placed.chain)?;
            let page = match k {
                "project" => String::new(),
                "location" => format!("/locations/{id}"),
                other => format!("/{other}s/{id}"),
            };
            return Ok(Json(
                json!({ "project_id": placed.project_id, "url": format!("/p/{}{page}", placed.project_id), "path": placed.path }),
            ));
        }
    };
    Ok(Json(
        json!({ "project_id": project, "url": format!("/p/{project}/{path}") }),
    ))
}
