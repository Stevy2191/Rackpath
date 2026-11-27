//! The PDF report of a project, location, floor, room, rack or device
//! (design section 16): a cover, the contents, the naming scheme, one
//! section per place with its details, rack elevations front and rear,
//! every device with its ports, cables and traced paths, each location's
//! address plan, and the VLANs and WLANs in use. Every section carries a
//! QR code linking to its page (`/r/{type}/{id}`).

use serde_json::Value;
use sqlx::{FromRow, SqliteConnection};

use super::pdf::{Doc, MUTED};
use crate::cabling;
use crate::domain::permissions::ScopeType;
use crate::error::{AppError, AppResult};
use crate::hierarchy;
use crate::routes::{devices, ports};

/// The most devices one report covers; bigger ones are refused.
pub const MAX_DEVICES: i64 = 1500;

pub struct Scope {
    pub kind: ScopeType,
    pub id: i64,
}

fn kind_name(k: ScopeType) -> &'static str {
    match k {
        ScopeType::Project => "project",
        ScopeType::Location => "location",
        ScopeType::Floor => "floor",
        ScopeType::Room => "room",
        ScopeType::Rack => "rack",
        ScopeType::Device => "device",
        ScopeType::Account => "account",
    }
}

#[derive(FromRow)]
struct LocationRow {
    id: i64,
    code: String,
    name: Option<String>,
    address_street: Option<String>,
    address_city: Option<String>,
    address_state: Option<String>,
    address_postcode: Option<String>,
    address_country: Option<String>,
    contact_name: Option<String>,
    contact_phone: Option<String>,
    contact_email: Option<String>,
    isp_primary_name: Option<String>,
    isp_primary_circuit: Option<String>,
    isp_secondary_name: Option<String>,
    isp_secondary_circuit: Option<String>,
    notes: Option<String>,
}

fn join(parts: &[&Option<String>], sep: &str) -> String {
    parts
        .iter()
        .filter_map(|p| p.as_deref())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(sep)
}

fn s(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(x) => x.clone(),
        Value::Number(n) => match n.as_f64() {
            // 14.0 → "14", 1.5 → "1.5"
            Some(f) if f.fract() == 0.0 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        _ => String::new(),
    }
}

fn short(path: &str, n: usize) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    parts[parts.len().saturating_sub(n)..].join(" ")
}

pub struct Report {
    pub pdf: Vec<u8>,
    pub filename: String,
    pub path: String,
    pub project_id: i64,
}

struct Builder<'a> {
    conn: &'a mut SqliteConnection,
    doc: Doc,
    base: String,
    traces_left: usize,
    device_ids: Vec<i64>,
}

impl Builder<'_> {
    fn link(&self, kind: &str, id: i64) -> String {
        format!("{}/r/{kind}/{id}", self.base)
    }

    async fn device(&mut self, level: u8, d: &Value) -> AppResult<()> {
        let id = d["id"].as_i64().unwrap_or_default();
        self.device_ids.push(id);
        let title = format!("{} {}", s(d, "code"), s(d, "name"))
            .trim()
            .to_string();
        let path = s(d, "path");
        let qr = self.link("device", id);
        self.doc
            .heading(level, &title, Some(&path.replace('/', " / ")), Some(&qr));
        let p = &d["placement"];
        let position = match p["type"].as_str() {
            Some("rack") => match p["mount"].as_str() {
                Some(m) if m.starts_with("zero") => "Zero-U".to_string(),
                _ => format!(
                    "U{} ({}){}",
                    s(p, "u"),
                    s(p, "face"),
                    if d["u_height"].is_number() {
                        format!(", {}U", s(d, "u_height"))
                    } else {
                        String::new()
                    }
                ),
            },
            Some("room") => "Floor-standing".into(),
            Some("unplaced") => "Unplaced".into(),
            _ => String::new(),
        };
        let tags = d["tags"]
            .as_array()
            .map(|t| {
                t.iter()
                    .map(|x| s(x, "name"))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        self.doc.key_values(&[
            (
                "Type",
                d["device_type"]["label"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            ),
            ("Status", s(d, "status")),
            (
                "Model",
                [s(d, "manufacturer"), s(d, "model")]
                    .iter()
                    .filter(|x| !x.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            ("Position", position),
            ("Serial", s(d, "serial_number")),
            ("Asset tag", s(d, "asset_tag")),
            ("Hostname", s(d, "hostname")),
            ("MAC", s(d, "mac")),
            ("Tags", tags),
            ("Notes", s(d, "notes")),
        ]);
        let list = ports::device_ports(self.conn, id).await?;
        if list.is_empty() {
            return Ok(());
        }
        let mut rows = Vec::with_capacity(list.len());
        for p in &list {
            let cable = |c: &Option<ports::CableOnPort>| match c {
                Some(c) => {
                    let detail = [c.cable_type.clone(), c.length_m.map(|l| format!("{l} m"))]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!(
                        "{}{}",
                        short(&c.far.path, 2),
                        if detail.is_empty() {
                            String::new()
                        } else {
                            format!(" ({detail})")
                        }
                    )
                }
                None => String::new(),
            };
            // The traced path from each active end of a chain.
            let mut traced = String::new();
            if p.chain_state != "unconnected" && p.port.role == "active" && self.traces_left > 0 {
                self.traces_left -= 1;
                let g = cabling::component(self.conn, p.port.id).await?;
                let t = crate::domain::cabling::trace(&g, p.port.id);
                let v = ports::trace_json(self.conn, &t).await?;
                let hops: Vec<String> = v["hops"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|h| h["type"] == "port")
                    .map(|h| short(h["path"].as_str().unwrap_or_default(), 2))
                    .collect();
                if hops.len() > 2 {
                    traced = format!(
                        "{} ({})",
                        hops.join(" → "),
                        v["state"].as_str().unwrap_or_default()
                    );
                }
            }
            let media = [
                p.port.transceiver.clone().or(p.port.connector.clone()),
                p.effective_speed.map(|s| {
                    if s >= 1000 {
                        format!("{}G", s / 1000)
                    } else {
                        format!("{s}M")
                    }
                }),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            let vlans = p
                .vlans
                .iter()
                .map(|v| format!("{}{}", v.vid, if v.mode == "tagged" { "t" } else { "" }))
                .collect::<Vec<_>>()
                .join(" ");
            rows.push(vec![
                p.port.code.clone(),
                p.port.interface_name.clone().unwrap_or_default(),
                media,
                cable(&p.front),
                if p.port.role == "passive" {
                    cable(&p.rear)
                } else {
                    String::new()
                },
                vlans,
                traced,
            ]);
        }
        self.doc.table(
            &[
                ("Port", 0.7, true),
                ("Interface", 1.0, false),
                ("Media", 1.0, false),
                ("Front / cable", 2.0, false),
                ("Rear", 1.6, false),
                ("VLANs", 0.8, false),
                ("Traced path", 2.6, false),
            ],
            &rows,
        );
        Ok(())
    }

    async fn location(&mut self, l: &LocationRow, scope: &Scope) -> AppResult<()> {
        let path = hierarchy::get(self.conn, ScopeType::Location, l.id)
            .await?
            .path;
        let qr = self.link("location", l.id);
        self.doc.heading(
            1,
            format!("{} {}", l.code, l.name.clone().unwrap_or_default()).trim(),
            Some(&path),
            Some(&qr),
        );
        self.doc.key_values(&[
            (
                "Address",
                join(
                    &[
                        &l.address_street,
                        &l.address_city,
                        &l.address_state,
                        &l.address_postcode,
                        &l.address_country,
                    ],
                    ", ",
                ),
            ),
            (
                "Contact",
                join(&[&l.contact_name, &l.contact_phone, &l.contact_email], ", "),
            ),
            (
                "Primary ISP",
                join(&[&l.isp_primary_name, &l.isp_primary_circuit], ", "),
            ),
            (
                "Secondary ISP",
                join(&[&l.isp_secondary_name, &l.isp_secondary_circuit], ", "),
            ),
            ("Notes", l.notes.clone().unwrap_or_default()),
        ]);
        let floors: Vec<(i64, String, Option<String>, i64)> = sqlx::query_as(
            "SELECT id, code, name, level FROM floors WHERE location_id = ? ORDER BY level, code",
        )
        .bind(l.id)
        .fetch_all(&mut *self.conn)
        .await?;
        for (fid, fcode, fname, level) in floors {
            if scope.kind == ScopeType::Floor && scope.id != fid {
                continue;
            }
            let rooms: Vec<(i64, String, Option<String>, bool)> = sqlx::query_as("SELECT id, code, name, is_default FROM rooms WHERE floor_id = ? ORDER BY is_default DESC, code")
                .bind(fid)
                .fetch_all(&mut *self.conn)
                .await?;
            let in_scope = |r: i64| {
                !matches!(scope.kind, ScopeType::Room | ScopeType::Rack)
                    || r == scope.id
                    || scope.kind == ScopeType::Rack
            };
            let qr = self.link("floor", fid);
            self.doc.heading(
                2,
                format!("Floor {fcode} {}", fname.unwrap_or_default()).trim(),
                Some(&format!("Level {level}")),
                Some(&qr),
            );
            for (rid, rcode, rname, _) in rooms.into_iter().filter(|r| in_scope(r.0)) {
                let racks: Vec<(i64, String, Option<String>, i64, String)> = sqlx::query_as("SELECT id, code, name, u_height, numbering FROM racks WHERE room_id = ? ORDER BY code")
                    .bind(rid)
                    .fetch_all(&mut *self.conn)
                    .await?;
                let racks: Vec<_> = racks
                    .into_iter()
                    .filter(|k| scope.kind != ScopeType::Rack || k.0 == scope.id)
                    .collect();
                let standing = if scope.kind == ScopeType::Rack {
                    vec![]
                } else {
                    devices::room_devices(self.conn, rid).await?
                };
                if racks.is_empty() && standing.is_empty() && scope.kind != ScopeType::Room {
                    continue;
                }
                let qr = self.link("room", rid);
                self.doc.heading(
                    3,
                    format!("Room {rcode} {}", rname.unwrap_or_default()).trim(),
                    None,
                    Some(&qr),
                );
                for (kid, kcode, kname, u, numbering) in racks {
                    let list = devices::rack_devices(self.conn, kid).await?;
                    let qr = self.link("rack", kid);
                    self.doc.heading(
                        3,
                        format!("Rack {kcode} {}", kname.unwrap_or_default()).trim(),
                        Some(&format!("{u}U")),
                        Some(&qr),
                    );
                    let items: Vec<(f64, f64, String, String)> = list
                        .iter()
                        .filter(|d| {
                            d["placement"]["u"].is_number()
                                && !d["placement"]["mount"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .starts_with("zero")
                        })
                        .map(|d| {
                            (
                                d["placement"]["u"].as_f64().unwrap_or(1.0),
                                d["u_height"].as_f64().unwrap_or(1.0),
                                s(&d["placement"], "face"),
                                format!("{} {}", s(d, "code"), s(d, "name")),
                            )
                        })
                        .collect();
                    self.doc.elevation(u, numbering == "top_down", &items);
                    let rows: Vec<Vec<String>> = list
                        .iter()
                        .map(|d| {
                            vec![
                                s(d, "code"),
                                s(d, "name"),
                                d["device_type"]["label"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .into(),
                                [s(d, "manufacturer"), s(d, "model")]
                                    .join(" ")
                                    .trim()
                                    .into(),
                                match d["placement"]["u"].as_f64() {
                                    Some(u) if u.fract() == 0.0 => format!("U{}", u as i64),
                                    Some(u) => format!("U{u}"),
                                    None => "zero-U".into(),
                                },
                            ]
                        })
                        .collect();
                    if !rows.is_empty() {
                        self.doc.table(
                            &[
                                ("Code", 1.0, true),
                                ("Name", 1.6, false),
                                ("Type", 1.2, false),
                                ("Model", 1.6, false),
                                ("Position", 0.8, false),
                            ],
                            &rows,
                        );
                    }
                    for d in &list {
                        self.device(4, d).await?;
                    }
                }
                for d in &standing {
                    self.device(4, d).await?;
                }
            }
        }
        // The location's address plan.
        if matches!(scope.kind, ScopeType::Project | ScopeType::Location) {
            self.address_plan(Some(l.id)).await?;
        }
        Ok(())
    }

    async fn address_plan(&mut self, location: Option<i64>) -> AppResult<()> {
        #[allow(clippy::type_complexity)]
        let prefixes: Vec<(i64, String, String, Option<String>, Option<String>, Option<i64>)> = match location {
            Some(l) => sqlx::query_as("SELECT p.id, p.cidr, p.role, p.description, p.gateway, v.vid FROM prefixes p LEFT JOIN vlans v ON v.id = p.vlan_id WHERE p.location_id = ? ORDER BY p.family, p.net_start, p.prefix_len").bind(l).fetch_all(&mut *self.conn).await?,
            None => return Ok(()),
        };
        if prefixes.is_empty() {
            return Ok(());
        }
        self.doc.heading(2, "Address plan", None, None);
        for (pid, cidr, role, description, gateway, vid) in prefixes {
            let qr = self.link("prefix", pid);
            self.doc.heading(
                4,
                &cidr,
                Some(
                    &[
                        Some(role),
                        description,
                        vid.map(|v| format!("VLAN {v}")),
                        gateway.map(|g| format!("gateway {g}")),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · "),
                ),
                Some(&qr),
            );
            let ranges: Vec<(String, String, String, Option<String>)> = sqlx::query_as("SELECT start_text, end_text, kind, description FROM ip_ranges WHERE prefix_id = ? ORDER BY start_bin")
                .bind(pid)
                .fetch_all(&mut *self.conn)
                .await?;
            if !ranges.is_empty() {
                let rows: Vec<Vec<String>> = ranges
                    .into_iter()
                    .map(|(a, b, k, d)| {
                        vec![
                            format!("{a} – {b}"),
                            k.replace('_', " "),
                            d.unwrap_or_default(),
                        ]
                    })
                    .collect();
                self.doc.table(
                    &[
                        ("Range", 2.0, true),
                        ("Kind", 1.0, false),
                        ("Description", 2.0, false),
                    ],
                    &rows,
                );
            }
            #[allow(clippy::type_complexity)]
            let addrs: Vec<(String, Option<String>, String, Option<String>)> = sqlx::query_as(
                "SELECT a.address, a.dns_name, a.status, s.path FROM ip_addresses a JOIN prefixes p ON p.id = ?
                 LEFT JOIN search_entries s ON s.kind = 'device' AND s.ref_id = a.device_id
                 WHERE a.space_id = p.space_id AND a.family = p.family AND a.addr_bin BETWEEN p.net_start AND p.net_end
                 ORDER BY a.addr_bin LIMIT 2000",
            )
            .bind(pid)
            .fetch_all(&mut *self.conn)
            .await?;
            if !addrs.is_empty() {
                let rows: Vec<Vec<String>> = addrs
                    .into_iter()
                    .map(|(a, dns, st, dev)| {
                        vec![
                            a,
                            dns.unwrap_or_default(),
                            dev.map(|d| short(&d, 2)).unwrap_or_default(),
                            st,
                        ]
                    })
                    .collect();
                self.doc.table(
                    &[
                        ("Address", 1.2, true),
                        ("DNS name", 2.0, false),
                        ("Device", 1.6, false),
                        ("Status", 0.8, false),
                    ],
                    &rows,
                );
            }
        }
        Ok(())
    }
}

/// Builds the report. `base` is the address QR codes point at.
pub async fn build(
    conn: &mut SqliteConnection,
    scope: Scope,
    base: &str,
    exported_by: &str,
    now: &str,
) -> AppResult<Report> {
    let placed = hierarchy::get_any(conn, scope.kind, scope.id).await?;
    let (project_code, project_name): (String, String) =
        sqlx::query_as("SELECT code, name FROM projects WHERE id = ?")
            .bind(placed.project_id)
            .fetch_one(&mut *conn)
            .await?;
    let count: i64 = match scope.kind {
        ScopeType::Project => {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM search_entries WHERE kind = 'device' AND project_id = ?",
            )
            .bind(scope.id)
            .fetch_one(&mut *conn)
            .await?
        }
        ScopeType::Location => {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM search_entries WHERE kind = 'device' AND location_id = ?",
            )
            .bind(scope.id)
            .fetch_one(&mut *conn)
            .await?
        }
        ScopeType::Floor => {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM search_entries WHERE kind = 'device' AND floor_id = ?",
            )
            .bind(scope.id)
            .fetch_one(&mut *conn)
            .await?
        }
        ScopeType::Room => {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM search_entries WHERE kind = 'device' AND room_id = ?",
            )
            .bind(scope.id)
            .fetch_one(&mut *conn)
            .await?
        }
        ScopeType::Rack => {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM search_entries WHERE kind = 'device' AND rack_id = ?",
            )
            .bind(scope.id)
            .fetch_one(&mut *conn)
            .await?
        }
        _ => 1,
    };
    if count > MAX_DEVICES {
        return Err(AppError::bad(format!(
            "That's {count} devices; a report covers at most {MAX_DEVICES}. Export a location, floor or rack instead."
        )));
    }
    let mut b = Builder {
        conn,
        doc: Doc::new(),
        base: base.trim_end_matches('/').to_string(),
        traces_left: 3000,
        device_ids: vec![],
    };

    // The naming scheme: what the code prefixes mean.
    let types: Vec<(String, String)> = sqlx::query_as(
        "SELECT label, prefix FROM device_types WHERE project_id = ? ORDER BY label",
    )
    .bind(placed.project_id)
    .fetch_all(&mut *b.conn)
    .await?;
    b.doc.heading(
        1,
        "Naming scheme",
        Some(
            "Codes read like an address: PROJECT / LOCATION / FLOOR / ROOM / RACK / DEVICE / PORT",
        ),
        None,
    );
    b.doc.table(
        &[("Device type", 3.0, false), ("Code prefix", 1.0, true)],
        &types
            .into_iter()
            .map(|(l, p)| vec![l, p])
            .collect::<Vec<_>>(),
    );

    if scope.kind == ScopeType::Device {
        let d = devices::load_device(b.conn, scope.id).await?.to_json();
        b.device(1, &d).await?;
    } else {
        let location_id: Option<i64> = match scope.kind {
            ScopeType::Project => None,
            ScopeType::Location => Some(scope.id),
            ScopeType::Floor => {
                sqlx::query_scalar("SELECT location_id FROM floors WHERE id = ?")
                    .bind(scope.id)
                    .fetch_optional(&mut *b.conn)
                    .await?
            }
            _ => sqlx::query_scalar(
                "SELECT location_id FROM search_entries WHERE kind = ? AND ref_id = ?",
            )
            .bind(kind_name(scope.kind))
            .bind(scope.id)
            .fetch_optional(&mut *b.conn)
            .await?
            .flatten(),
        };
        let locations: Vec<LocationRow> = sqlx::query_as(
            "SELECT id, code, name, address_street, address_city, address_state, address_postcode, address_country,
                    contact_name, contact_phone, contact_email, isp_primary_name, isp_primary_circuit,
                    isp_secondary_name, isp_secondary_circuit, notes
             FROM locations WHERE project_id = ? ORDER BY code",
        )
        .bind(placed.project_id)
        .fetch_all(&mut *b.conn)
        .await?;
        for l in locations
            .iter()
            .filter(|l| location_id.is_none_or(|x| x == l.id))
        {
            b.location(l, &scope).await?;
        }
    }

    // Networks used by the devices in the report.
    if !b.device_ids.is_empty() {
        let mut q = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT v.vid, v.name, COALESCE(v.description, ''), COUNT(DISTINCT pv.port_id) FROM port_vlans pv JOIN vlans v ON v.id = pv.vlan_id
             JOIN ports o ON o.id = pv.port_id WHERE o.device_id IN (",
        );
        let mut sep = q.separated(", ");
        for id in &b.device_ids {
            sep.push_bind(*id);
        }
        q.push(") GROUP BY v.id ORDER BY v.vid");
        let vlans: Vec<(i64, String, String, i64)> =
            q.build_query_as().fetch_all(&mut *b.conn).await?;
        let mut q = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT DISTINCT w.ssid, w.security, COALESCE(CAST(v.vid AS TEXT), '') FROM ports o JOIN wlans w ON w.id = o.wlan_id
             LEFT JOIN vlans v ON v.id = w.vlan_id WHERE o.device_id IN (",
        );
        let mut sep = q.separated(", ");
        for id in &b.device_ids {
            sep.push_bind(*id);
        }
        q.push(") ORDER BY w.ssid");
        let wlans: Vec<(String, String, String)> =
            q.build_query_as().fetch_all(&mut *b.conn).await?;
        if !vlans.is_empty() || !wlans.is_empty() {
            b.doc.heading(1, "Networks in use", None, None);
            if !vlans.is_empty() {
                b.doc.table(
                    &[
                        ("VLAN", 0.6, true),
                        ("Name", 1.6, false),
                        ("Description", 2.4, false),
                        ("Ports", 0.6, false),
                    ],
                    &vlans
                        .into_iter()
                        .map(|(v, n, d, c)| vec![v.to_string(), n, d, c.to_string()])
                        .collect::<Vec<_>>(),
                );
            }
            if !wlans.is_empty() {
                b.doc.table(
                    &[
                        ("Wi-Fi network", 2.0, false),
                        ("Security", 1.4, false),
                        ("VLAN", 0.6, true),
                    ],
                    &wlans
                        .into_iter()
                        .map(|(s, sec, v)| vec![s, sec.replace('_', "/"), v])
                        .collect::<Vec<_>>(),
                );
            }
        }
    } else {
        b.doc.para("No devices in this part.", 9.0, MUTED);
    }

    let kind = kind_name(scope.kind);
    let url = format!("{}/r/{kind}/{}", b.base, scope.id);
    let title = format!(
        "{} {}",
        placed.path.replace('/', " / "),
        if scope.kind == ScopeType::Project {
            project_name.clone()
        } else {
            String::new()
        }
    )
    .trim()
    .to_string();
    let pdf = b
        .doc
        .finish(
            &title,
            &[
                ("Project", format!("{project_code} · {project_name}")),
                ("Covers", format!("{kind} {}", placed.path)),
                ("Devices", count.to_string()),
                ("Exported", now.to_string()),
                ("Exported by", exported_by.to_string()),
            ],
            &format!("Rackpath · {}", placed.path),
            Some(&url),
        )
        .map_err(AppError::internal)?;
    Ok(Report {
        pdf,
        filename: format!("rackpath-{}.pdf", placed.path.replace('/', "-")),
        path: placed.path,
        project_id: placed.project_id,
    })
}
