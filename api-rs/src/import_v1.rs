//! `rackpath import-v1 --from mysql://…`: brings a v1 (Node + MariaDB)
//! database across, best effort, into a fresh v2 database (design
//! section 17).
//!
//! Everything except users, integrations and the activity log goes through
//! the v2 API itself (the router, called in-process as the owner), so every
//! imported record passes the same checks, gets the same search entries and
//! is written to the change history like anything typed in by hand. Records
//! the API refuses are reported and skipped; the rest carries on.

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::body::Body;
use axum::http::{header, Method, Request};
use axum::Router;
use serde_json::{json, Value};
use sqlx::{MySqlPool, Row, SqlitePool};
use tower::ServiceExt;

use crate::audit::{self, Entry};
use crate::auth::{create_session, COOKIE_NAME};
use crate::domain::media::{Connector, CONNECTORS};
use crate::middleware::RequestCtx;
use crate::util::now_ts;

// ---------------------------------------------------------------- report

#[derive(Default, Debug)]
pub struct Report {
    pub counts: BTreeMap<&'static str, usize>,
    pub skipped: Vec<String>,
}

impl Report {
    fn add(&mut self, what: &'static str) {
        *self.counts.entry(what).or_default() += 1;
    }
    fn skip(&mut self, what: impl Into<String>) {
        self.skipped.push(what.into());
    }
}

// ---------------------------------------------------------------- the v2 API

#[derive(Debug)]
struct ApiErr {
    status: u16,
    message: String,
}

impl std::fmt::Display for ApiErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.status)
    }
}

struct Api {
    router: Router,
    cookie: String,
}

impl Api {
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, ApiErr> {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::COOKIE, &self.cookie);
        let body = match body {
            Some(b) => {
                req = req.header(header::CONTENT_TYPE, "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let resp = self
            .router
            .clone()
            .oneshot(req.body(body).expect("request"))
            .await
            .expect("router is infallible");
        let status = resp.status().as_u16();
        let bytes = axum::body::to_bytes(resp.into_body(), 64 << 20)
            .await
            .unwrap_or_default();
        let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            Ok(v)
        } else {
            Err(ApiErr {
                status,
                message: v["error"].as_str().unwrap_or("request failed").to_string(),
            })
        }
    }
    async fn get(&self, path: &str) -> Result<Value, ApiErr> {
        self.call(Method::GET, path, None).await
    }
    async fn post(&self, path: &str, body: Value) -> Result<Value, ApiErr> {
        self.call(Method::POST, path, Some(body)).await
    }
    async fn patch(&self, path: &str, body: Value) -> Result<Value, ApiErr> {
        self.call(Method::PATCH, path, Some(body)).await
    }
    async fn put(&self, path: &str, body: Value) -> Result<Value, ApiErr> {
        self.call(Method::PUT, path, Some(body)).await
    }

    /// Creates something with a code; when the code is taken, tries
    /// CODE-2, CODE-3… (and keeps within 16 characters).
    async fn create_coded(&self, path: &str, mut body: Value, base: &str) -> Result<Value, ApiErr> {
        let mut last = None;
        for n in 1..=20 {
            let code = if n == 1 {
                base.to_string()
            } else {
                let suffix = format!("-{n}");
                format!("{}{suffix}", &base[..base.len().min(16 - suffix.len())])
            };
            body["code"] = json!(code);
            match self.post(path, body.clone()).await {
                Ok(v) => return Ok(v),
                Err(e) if e.status == 400 || e.status == 409 => {
                    let taken = e.message.contains("already")
                        || e.message.contains("in use")
                        || e.message.contains("exists");
                    if !taken {
                        return Err(e);
                    }
                    last = Some(e);
                }
                Err(e) => return Err(e),
            }
        }
        Err(last.expect("tried"))
    }
}

fn id(v: &Value) -> i64 {
    v["id"].as_i64().unwrap_or_default()
}

// ---------------------------------------------------------------- reading v1

fn s(v: &Value, k: &str) -> Option<String> {
    match &v[k] {
        Value::String(x) if !x.trim().is_empty() => Some(x.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}
fn n(v: &Value, k: &str) -> Option<i64> {
    match &v[k] {
        Value::Number(x) => x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)),
        Value::String(x) => x.trim().parse().ok(),
        _ => None,
    }
}
fn f(v: &Value, k: &str) -> Option<f64> {
    match &v[k] {
        Value::Number(x) => x.as_f64(),
        Value::String(x) => x.trim().parse().ok(),
        _ => None,
    }
}
fn b(v: &Value, k: &str) -> bool {
    n(v, k).is_some_and(|x| x != 0)
}
/// A JSON column (stored as text in v1).
fn j(v: &Value, k: &str) -> Value {
    match &v[k] {
        Value::String(x) => serde_json::from_str(x).unwrap_or(Value::Null),
        other => other.clone(),
    }
}

/// Every v1 table the importer reads, as JSON rows. The column lists are
/// literal: they exist in v1's schema from migration 0064 on.
async fn read_v1(db: &MySqlPool) -> Result<HashMap<&'static str, Vec<Value>>, sqlx::Error> {
    // One literal query per table (sqlx takes only literal SQL).
    macro_rules! table {
        ($out:ident, $name:literal, $sql:literal) => {{
            let rows = sqlx::query($sql).fetch_all(db).await?;
            let mut list = Vec::with_capacity(rows.len());
            for r in rows {
                let text: String = r.try_get(0)?;
                list.push(serde_json::from_str(&text).unwrap_or(Value::Null));
            }
            $out.insert($name, list);
        }};
    }
    let mut out = HashMap::new();
    table!(out, "users", "SELECT JSON_OBJECT('id', id, 'username', username, 'password_hash', password_hash, 'must_change_password', must_change_password, 'created_at', created_at) FROM users ORDER BY id");
    table!(out, "projects", "SELECT JSON_OBJECT('id', id, 'name', name, 'description', description, 'address', address, 'site_contact_name', site_contact_name, 'site_contact_phone', site_contact_phone, 'site_contact_email', site_contact_email, 'primary_isp_name', primary_isp_name, 'primary_isp_circuit_id', primary_isp_circuit_id, 'primary_isp_contact', primary_isp_contact, 'secondary_isp_name', secondary_isp_name, 'secondary_isp_circuit_id', secondary_isp_circuit_id, 'secondary_isp_contact', secondary_isp_contact, 'wan_ip', wan_ip, 'wan_subnet', wan_subnet, 'wan_gateway', wan_gateway, 'dns_servers', dns_servers, 'lan_ip', lan_ip, 'lan_subnet', lan_subnet, 'lan_gateway', lan_gateway, 'address_street', address_street, 'address_city', address_city, 'address_state', address_state, 'address_zip', address_zip) FROM projects ORDER BY id");
    table!(out, "locations", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'name', name, 'building_number', building_number, 'notes', notes) FROM locations ORDER BY id");
    table!(out, "rooms", "SELECT JSON_OBJECT('id', id, 'location_id', location_id, 'name', name, 'floor', floor, 'room_number', room_number, 'notes', notes, 'contact_name', contact_name, 'contact_phone', contact_phone, 'contact_email', contact_email) FROM rooms ORDER BY id");
    table!(out, "racks", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'name', name, 'location', location, 'u_height', u_height, 'rack_type', rack_type, 'rack_width', rack_width, 'notes', notes, 'location_id', location_id, 'room_id', room_id) FROM racks ORDER BY id");
    table!(out, "devices", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'hostname', hostname, 'ip', ip, 'mac', mac, 'type', type, 'make', make, 'model', model, 'serial_number', serial_number, 'purchase_date', purchase_date, 'warranty_expiry', warranty_expiry, 'notes', notes, 'location', location, 'icon_color', icon_color, 'text_color', text_color, 'status', status, 'location_id', location_id, 'room_id', room_id) FROM devices ORDER BY id");
    table!(out, "rack_slots", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'rack_id', rack_id, 'device_id', device_id, 'item_type', item_type, 'item_label', item_label, 'vendor', vendor, 'custom_type', custom_type, 'u_position', u_position, 'position_offset', position_offset, 'u_size', u_size, 'mounted_face', mounted_face, 'half_depth', half_depth, 'half_width', half_width, 'half_position', half_position, 'ip_address', ip_address, 'slot_notes', slot_notes, 'outlet_groups', outlet_groups, 'input_voltage', input_voltage, 'input_plug_type', input_plug_type, 'capacity_va', capacity_va, 'capacity_w', capacity_w, 'device_type', device_type, 'ups_va_rating', ups_va_rating, 'ups_watt_rating', ups_watt_rating, 'runtime_curve', runtime_curve, 'ups_max_ebm_slots', ups_max_ebm_slots, 'ebm_connected_ups_id', ebm_connected_ups_id, 'ebm_runtime_curve', ebm_runtime_curve, 'power_source_slot_id', power_source_slot_id, 'power_source_outlet', power_source_outlet, 'psu2_source_slot_id', psu2_source_slot_id, 'psu2_source_outlet', psu2_source_outlet, 'mount_side', mount_side, 'asset_tag', asset_tag, 'serial_number', serial_number) FROM rack_slots ORDER BY id");
    table!(out, "ports", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'device_id', device_id, 'port_name', port_name, 'port_number', port_number, 'cable_type', cable_type, 'connected_port_id', connected_port_id, 'speed', speed) FROM ports ORDER BY id");
    table!(out, "project_vlans", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'vlan_id', vlan_id, 'name', name, 'description', description, 'subnet', subnet, 'color', color) FROM project_vlans ORDER BY id");
    table!(out, "device_tags", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'name', name, 'color', color) FROM device_tags ORDER BY id");
    table!(out, "device_tag_assignments", "SELECT JSON_OBJECT('device_id', device_id, 'tag_id', tag_id) FROM device_tag_assignments ORDER BY id");
    table!(out, "camera_tag_assignments", "SELECT JSON_OBJECT('camera_id', camera_id, 'tag_id', tag_id) FROM camera_tag_assignments ORDER BY id");
    table!(out, "project_cameras", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'name', name, 'model', model, 'mac', mac, 'ip_address', ip_address, 'resolution', resolution, 'location_notes', location_notes) FROM project_cameras ORDER BY id");
    table!(out, "project_access_devices", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'name', name, 'device_type', device_type, 'model', model, 'mac', mac, 'ip_address', ip_address, 'firmware_version', firmware_version, 'door_name', door_name, 'location', location, 'floor', floor) FROM project_access_devices ORDER BY id");
    table!(out, "rack_custom_devices", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'name', name, 'vendor', vendor, 'type', type, 'u_size', u_size, 'outlet_count', outlet_count, 'outlet_type', outlet_type, 'input_voltage', input_voltage) FROM rack_custom_devices ORDER BY id");
    table!(out, "user_catalog_entries", "SELECT JSON_OBJECT('id', id, 'name', name, 'render_type', render_type, 'u_size', u_size, 'half_width', half_width, 'half_depth', half_depth, 'outlet_groups', outlet_groups, 'input_voltage', input_voltage, 'capacity_va', capacity_va, 'capacity_w', capacity_w, 'runtime_curve', runtime_curve, 'ebm_runtime_curve', ebm_runtime_curve) FROM user_catalog_entries ORDER BY id");
    table!(out, "topologies", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'name', name, 'description', description) FROM topologies ORDER BY id");
    table!(out, "topology_nodes", "SELECT JSON_OBJECT('id', id, 'topology_id', topology_id, 'device_id', device_id, 'label', label, 'x', x, 'y', y, 'width', width, 'height', height) FROM topology_nodes ORDER BY id");
    table!(out, "topology_edges", "SELECT JSON_OBJECT('id', id, 'topology_id', topology_id, 'source_node_id', source_node_id, 'target_node_id', target_node_id, 'source_element_type', source_element_type, 'target_element_type', target_element_type, 'label', label) FROM topology_edges ORDER BY id");
    table!(out, "topology_labels", "SELECT JSON_OBJECT('topology_id', topology_id, 'text', text, 'x', x, 'y', y) FROM topology_labels ORDER BY id");
    table!(out, "topology_zones", "SELECT JSON_OBJECT('topology_id', topology_id, 'name', name, 'x', x, 'y', y, 'width', width, 'height', height) FROM topology_zones ORDER BY id");
    table!(out, "topology_shapes", "SELECT JSON_OBJECT('topology_id', topology_id, 'label', label, 'x', x, 'y', y, 'width', width, 'height', height) FROM topology_shapes ORDER BY id");
    table!(out, "topology_node_interfaces", "SELECT JSON_OBJECT('device_id', device_id, 'name', name, 'ip', ip, 'speed', speed) FROM topology_node_interfaces ORDER BY id");
    table!(out, "project_integrations", "SELECT JSON_OBJECT('id', id, 'project_id', project_id, 'name', name, 'platform', platform, 'base_url', base_url, 'username', username, 'password', password, 'api_key', api_key, 'verify_ssl', verify_ssl, 'sync_interval_minutes', sync_interval_minutes, 'config', config) FROM project_integrations ORDER BY id");
    table!(out, "project_activity_log", "SELECT JSON_OBJECT('project_id', project_id, 'user_id', user_id, 'action', action, 'details', details, 'created_at', created_at) FROM project_activity_log ORDER BY id");
    Ok(out)
}

// ---------------------------------------------------------------- mapping helpers

/// A v2 code from free text: letters, digits, '.', '_' and '-', upper case,
/// starting with a letter or digit, at most 16 characters.
pub fn code_from(text: &str, fallback: &str) -> String {
    let mut c: String = text
        .trim()
        .to_ascii_uppercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    while c.contains("--") {
        c = c.replace("--", "-");
    }
    let c = c.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
    let c: String = c.chars().take(16).collect();
    let c = c
        .trim_end_matches(|ch: char| !ch.is_ascii_alphanumeric())
        .to_string();
    if c.is_empty() {
        fallback.to_string()
    } else {
        c
    }
}

/// "Ground", "GF", "G", "0" or nothing: the ground floor (v2's floor 0).
pub fn is_ground(floor: &str) -> bool {
    matches!(
        floor.trim().to_ascii_lowercase().as_str(),
        "" | "0" | "g" | "gf" | "ground" | "ground floor"
    )
}

/// v1's free-text device type → a v2 built-in type key.
pub fn device_type_key(v1: &str) -> &'static str {
    let t = v1.trim().to_ascii_lowercase().replace(['-', ' '], "_");
    match t.as_str() {
        "switch" | "core_switch" | "access_switch" | "network_switch" => "switch",
        "router" | "gateway" => "router",
        "firewall" | "fw" => "firewall",
        "server" | "hypervisor" | "host" | "vm_host" => "server",
        "nas" | "storage" | "san" => "nas",
        "ups" => "ups",
        "pdu" | "vertical_pdu" => "pdu",
        "ebm" | "battery" | "battery_module" => "battery_module",
        "patch_panel" | "patchpanel" => "patch_panel",
        "fibre_panel" | "fiber_panel" => "fibre_panel",
        "kvm" => "kvm",
        "modem" | "ont" => "modem",
        "ap" | "access_point" | "wap" | "wifi" => "access_point",
        "camera" | "cctv" => "camera",
        "printer" => "printer",
        "phone" | "voip" | "ip_phone" => "phone",
        "desktop" | "workstation" | "pc" | "computer" => "desktop",
        "laptop" => "laptop",
        "screen" | "display" | "tv" | "monitor" => "screen",
        "iot" | "sensor" => "iot",
        "shelf" | "tray" => "tray",
        "cable_manager" => "cable_manager",
        "blank" | "blanking_panel" => "blanking_panel",
        _ => "misc",
    }
}

/// v1 cable type names that have an exact v2 equivalent.
pub fn cable_type(v1: &str) -> Option<&'static str> {
    match v1.trim().to_ascii_lowercase().as_str() {
        "cat5" => Some("Cat5"),
        "cat5e" => Some("Cat5e"),
        "cat6" => Some("Cat6"),
        "cat6a" => Some("Cat6a"),
        "cat7" => Some("Cat7"),
        "other" => Some("Other"),
        _ => None, // "Fiber" and "DAC" don't say which kind
    }
}

/// "1G", "10 Gbps", "100M", "2500" → Mb/s.
pub fn speed_mbps(v1: &str) -> Option<i64> {
    let t = v1.trim().to_ascii_lowercase().replace([' ', '/'], "");
    let digits: String = t
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let num: f64 = digits.parse().ok()?;
    let rest = &t[digits.len()..];
    let mbps = if rest.starts_with('g') {
        num * 1000.0
    } else if rest.starts_with('k') {
        num / 1000.0
    } else {
        num
    };
    (mbps >= 1.0).then_some(mbps.round() as i64)
}

/// "255.255.255.0", "/24" or "24" → prefix length.
pub fn prefix_len(mask: &str) -> Option<u32> {
    let m = mask.trim().trim_start_matches('/');
    if let Ok(len) = m.parse::<u32>() {
        return (len <= 32).then_some(len);
    }
    let octets: Vec<u8> = m
        .split('.')
        .map(|o| o.parse().ok())
        .collect::<Option<_>>()?;
    if octets.len() != 4 {
        return None;
    }
    let v = u32::from_be_bytes([octets[0], octets[1], octets[2], octets[3]]);
    (v.leading_ones() + v.trailing_zeros() == 32).then_some(v.leading_ones())
}

/// The plug that goes into an outlet of `outlet` (C13 → C14, NEMA 5-15R →
/// NEMA 5-15P…). Unknown outlets are treated as C13.
pub fn outlet_and_plug(outlet: Option<&str>) -> (&'static str, &'static str) {
    let o = outlet.and_then(Connector::parse);
    let family = match o {
        Some(Connector::Power(p)) => Some(p.family),
        _ => None,
    };
    let find = |want_outlet: bool| {
        CONNECTORS.iter().find(|(_, c)| matches!(c, Connector::Power(p) if Some(p.family) == family && p.outlet == want_outlet)).map(|(n, _)| *n)
    };
    match (find(true), find(false)) {
        (Some(a), Some(b)) => (a, b),
        _ => ("C13", "C14"),
    }
}

fn curve(v: &Value) -> Option<Value> {
    let pts: Vec<Value> = v
        .as_array()?
        .iter()
        .filter_map(|p| {
            let load = p["load_watts"].as_f64().or_else(|| p["load_w"].as_f64())?;
            let min = p["runtime_minutes"]
                .as_f64()
                .or_else(|| p["minutes"].as_f64())?;
            Some(json!({ "load_w": load, "minutes": min }))
        })
        .collect();
    (!pts.is_empty()).then(|| json!(pts))
}

/// The suggestion in "… did you mean 10.0.0.0/24?".
fn suggestion(message: &str) -> Option<String> {
    let start = message.find("did you mean ")? + "did you mean ".len();
    Some(message[start..].trim_end_matches('?').trim().to_string())
}

fn joined(parts: &[Option<String>]) -> Option<String> {
    let v: Vec<&str> = parts.iter().flatten().map(String::as_str).collect();
    (!v.is_empty()).then(|| v.join(", "))
}

// ---------------------------------------------------------------- the import

struct Ctx<'a> {
    api: Api,
    pool: &'a SqlitePool,
    from: &'a MySqlPool,
    secrets: crate::domain::crypto::SecretBox,
    /// v1's RACKPATH_JWT_SECRET, which keyed integration secrets before
    /// v1's migration 0065.
    legacy_key: Option<&'a str>,
    owner: (i64, String),
    report: Report,
    /// v1 id → v2 id, per kind.
    projects: HashMap<i64, i64>,
    locations: HashMap<i64, i64>,
    rooms: HashMap<i64, i64>,
    racks: HashMap<i64, i64>,
    devices: HashMap<i64, i64>,
    slot_devices: HashMap<i64, i64>,
    cameras: HashMap<i64, i64>,
    ports: HashMap<i64, i64>,
    vlans: HashMap<(i64, i64), i64>,
    users: HashMap<i64, (i64, String)>,
    /// Default room of each v2 location's floor 0.
    default_rooms: HashMap<i64, i64>,
    /// Per v2 project: the "IMPORTED" location's default room.
    imported_room: HashMap<i64, i64>,
    /// v2 devices created by the import (marked v1_import at the end).
    created_devices: Vec<i64>,
}

impl Ctx<'_> {
    async fn default_room(&mut self, location: i64) -> Option<i64> {
        if let Some(r) = self.default_rooms.get(&location) {
            return Some(*r);
        }
        let loc = self
            .api
            .get(&format!("/api/locations/{location}"))
            .await
            .ok()?;
        let floor = loc["floors"]
            .as_array()?
            .iter()
            .find(|f| f["code"] == "0")
            .or_else(|| loc["floors"].as_array()?.first())?;
        let fl = self
            .api
            .get(&format!("/api/floors/{}", id(floor)))
            .await
            .ok()?;
        let room = fl["rooms"]
            .as_array()?
            .iter()
            .find(|r| r["is_default"] == true)?;
        self.default_rooms.insert(location, id(room));
        Some(id(room))
    }

    /// A room for things v1 didn't place anywhere more specific.
    async fn fallback_room(&mut self, project: i64) -> Option<i64> {
        if let Some(r) = self.imported_room.get(&project) {
            return Some(*r);
        }
        let loc = self
            .api
            .create_coded(
                &format!("/api/projects/{project}/locations"),
                json!({ "name": "Imported from v1 without a location" }),
                "IMPORTED",
            )
            .await
            .ok()?;
        self.report.add("locations");
        let room = self.default_room(id(&loc)).await?;
        self.imported_room.insert(project, room);
        Some(room)
    }

    async fn prefix(&mut self, project: i64, cidr: &str, extra: Value) -> Option<i64> {
        let mut body = extra;
        body["cidr"] = json!(cidr);
        let path = format!("/api/projects/{project}/prefixes");
        match self.api.post(&path, body.clone()).await {
            Ok(p) => {
                self.report.add("prefixes");
                Some(id(&p))
            }
            Err(e) => {
                if let Some(fixed) = suggestion(&e.message) {
                    body["cidr"] = json!(fixed);
                    if let Ok(p) = self.api.post(&path, body).await {
                        self.report.add("prefixes");
                        return Some(id(&p));
                    }
                }
                self.report.skip(format!("Prefix {cidr}: {e}"));
                None
            }
        }
    }

    async fn address(
        &mut self,
        project: i64,
        address: &str,
        device: Option<i64>,
        port: Option<i64>,
        description: Option<&str>,
    ) {
        let a = address.trim();
        let a = a.split('/').next().unwrap_or(a);
        if a.parse::<std::net::IpAddr>().is_err() {
            if !a.is_empty() {
                self.report.skip(format!("Address {a}: not an IP address"));
            }
            return;
        }
        let body = json!({ "address": a, "device_id": device, "port_id": port, "description": description });
        match self
            .api
            .post(&format!("/api/projects/{project}/addresses"), body)
            .await
        {
            Ok(_) => self.report.add("ip addresses"),
            Err(e) => self.report.skip(format!("Address {a}: {e}")),
        }
    }
}

/// Runs the import into `pool` (a migrated v2 database with an owner and
/// no projects yet).
///
/// `legacy_key` is v1's `RACKPATH_JWT_SECRET`: v1 releases before its
/// migration 0065 kept integration secrets in MariaDB's AES_ENCRYPT keyed by
/// it. Without it those secrets are left out (and listed), to be entered
/// again.
pub async fn run(
    pool: &SqlitePool,
    state: crate::state::AppState,
    from: &MySqlPool,
    legacy_key: Option<&str>,
) -> Result<Report, String> {
    let projects: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if projects > 0 {
        return Err("This Rackpath already has projects. Import v1 into a fresh database (a new RACKPATH_DATA_DIR).".into());
    }
    {
        let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
        if crate::auth::account_requires_2fa(&mut conn)
            .await
            .map_err(|e| e.to_string())?
        {
            return Err("Two-factor sign-in is required for everyone; turn that off for the import, then on again.".into());
        }
    }
    // The import works as a temporary account admin, so the history names
    // it, and the owner's own sign-in steps (a first password change, 2FA)
    // don't stand in the way. The account is removed at the end.
    let owner: (i64, String) = {
        let now = now_ts();
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO users (username, display_name, password_hash, must_change_password, is_owner, created_at, updated_at)
             VALUES ('v1-import', 'Import from v1', '!', 0, 0, ?, ?) RETURNING id",
        )
        .bind(&now)
        .bind(&now)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Couldn't create the import account (is a user called v1-import left from an earlier run?): {e}"))?;
        sqlx::query("INSERT INTO role_grants (user_id, role, scope_type, scope_id, project_id, created_at) VALUES (?, 'admin', 'account', NULL, NULL, ?)")
            .bind(id)
            .bind(&now)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        (id, "v1-import".to_string())
    };
    let result = import_as(pool, state, from, legacy_key, owner.clone()).await;
    let _ = sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(owner.0)
        .execute(pool)
        .await;
    result
}

async fn import_as(
    pool: &SqlitePool,
    state: crate::state::AppState,
    from: &MySqlPool,
    legacy_key: Option<&str>,
    owner: (i64, String),
) -> Result<Report, String> {
    // 0064 is the last migration of the last published v1; 0065 to 0068
    // only widened and dropped columns, which the importer doesn't read.
    let applied: Option<String> =
        sqlx::query_scalar("SELECT name FROM schema_migrations WHERE name LIKE '0064%' LIMIT 1")
            .fetch_optional(from)
            .await
            .unwrap_or(None);
    if applied.is_none() {
        return Err("The v1 database is older than the last v1 release (migration 0064 isn't applied). Start the latest v1 once so it migrates, then import.".into());
    }
    let v1 = read_v1(from)
        .await
        .map_err(|e| format!("Reading v1: {e}"))?;
    let ctx_sys = RequestCtx::system();
    let token = {
        let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
        create_session(&mut conn, owner.0, true, &ctx_sys)
            .await
            .map_err(|e| e.to_string())?
    };
    let secrets = state.secrets.clone();
    let api = Api {
        router: crate::routes::router(state),
        cookie: format!("{COOKIE_NAME}={token}"),
    };
    let mut c = Ctx {
        api,
        pool,
        from,
        secrets,
        legacy_key,
        owner,
        report: Report::default(),
        projects: HashMap::new(),
        locations: HashMap::new(),
        rooms: HashMap::new(),
        racks: HashMap::new(),
        devices: HashMap::new(),
        slot_devices: HashMap::new(),
        cameras: HashMap::new(),
        ports: HashMap::new(),
        vlans: HashMap::new(),
        users: HashMap::new(),
        default_rooms: HashMap::new(),
        imported_room: HashMap::new(),
        created_devices: Vec::new(),
    };
    let rows = |k: &str| v1.get(k).cloned().unwrap_or_default();

    users(&mut c, &rows("users")).await?;
    let first_project = projects_and_sites(&mut c, &rows("projects"), &rows("locations")).await;
    vlans(&mut c, &rows("project_vlans")).await;
    rooms(&mut c, &rows("rooms")).await;
    racks(&mut c, &rows("racks")).await;
    devices(&mut c, &rows("devices"), &rows("rack_slots")).await;
    power(&mut c, &rows("rack_slots")).await;
    ports(&mut c, &rows("ports"), &rows("topology_node_interfaces")).await;
    cameras_and_access(
        &mut c,
        &rows("project_cameras"),
        &rows("project_access_devices"),
    )
    .await;
    tags(
        &mut c,
        &rows("device_tags"),
        &rows("device_tag_assignments"),
        &rows("camera_tag_assignments"),
    )
    .await;
    templates(
        &mut c,
        &rows("rack_custom_devices"),
        &rows("user_catalog_entries"),
        first_project,
    )
    .await;
    topologies(&mut c, &v1).await;
    integrations(&mut c, &rows("project_integrations")).await?;
    activity(&mut c, &rows("project_activity_log")).await?;

    // Mark what came from v1, and close the import's session.
    for d in &c.created_devices {
        let _ = sqlx::query(
            "UPDATE devices SET source = 'v1_import' WHERE id = ? AND source = 'manual'",
        )
        .bind(d)
        .execute(pool)
        .await;
    }
    let _ = sqlx::query("UPDATE prefixes SET source = 'v1_import' WHERE source = 'manual'")
        .execute(pool)
        .await;
    let _ = sqlx::query("UPDATE ip_addresses SET source = 'v1_import' WHERE source = 'manual'")
        .execute(pool)
        .await;
    Ok(c.report)
}

async fn users(c: &mut Ctx<'_>, rows: &[Value]) -> Result<(), String> {
    let mut tx = c.pool.begin().await.map_err(|e| e.to_string())?;
    for u in rows {
        let (Some(v1id), Some(name)) = (n(u, "id"), s(u, "username")) else {
            continue;
        };
        let existing: Option<i64> =
            sqlx::query_scalar("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
                .bind(&name)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        if let Some(id) = existing {
            c.users.insert(v1id, (id, name));
            continue;
        }
        let now = now_ts();
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO users (username, password_hash, must_change_password, is_owner, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, ?) RETURNING id",
        )
        .bind(&name)
        .bind(s(u, "password_hash").unwrap_or_default())
        .bind(b(u, "must_change_password"))
        .bind(&now)
        .bind(&now)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("User {name}: {e}"))?;
        // Everyone in v1 could do everything: they become account admins.
        sqlx::query("INSERT INTO role_grants (user_id, role, scope_type, scope_id, project_id, created_by, created_at) VALUES (?, 'admin', 'account', NULL, NULL, ?, ?)")
            .bind(id)
            .bind(c.owner.0)
            .bind(&now)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        audit::record(
            &mut tx,
            &RequestCtx::system(),
            Some((c.owner.0, c.owner.1.as_str())),
            Entry::new("import", "user", Some(id))
                .path(name.clone())
                .changes(json!({ "from": "v1", "role": "account admin" })),
        )
        .await
        .map_err(|e| e.to_string())?;
        c.users.insert(v1id, (id, name));
        c.report.add("users");
    }
    tx.commit().await.map_err(|e| e.to_string())
}

/// Projects, their locations, and the site details v1 kept on the project.
async fn projects_and_sites(
    c: &mut Ctx<'_>,
    projects: &[Value],
    locations: &[Value],
) -> Option<i64> {
    let mut first = None;
    for p in projects {
        let Some(v1id) = n(p, "id") else { continue };
        let name = s(p, "name").unwrap_or_else(|| format!("Project {v1id}"));
        let base = code_from(&name, &format!("P{v1id}"));
        let made = match c
            .api
            .create_coded(
                "/api/projects",
                json!({ "name": name, "description": s(p, "description") }),
                &base,
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                c.report.skip(format!("Project {name}: {e}"));
                continue;
            }
        };
        let pid = id(&made);
        first.get_or_insert(pid);
        c.projects.insert(v1id, pid);
        c.report.add("projects");

        let mut first_loc = None;
        for l in locations
            .iter()
            .filter(|l| n(l, "project_id") == Some(v1id))
        {
            let lname = s(l, "name").unwrap_or_else(|| "Location".into());
            let lcode = s(l, "building_number")
                .map(|bn| code_from(&bn, ""))
                .filter(|x| !x.is_empty())
                .unwrap_or_else(|| code_from(&lname, "LOC"));
            match c
                .api
                .create_coded(
                    &format!("/api/projects/{pid}/locations"),
                    json!({ "name": lname, "notes": s(l, "notes") }),
                    &lcode,
                )
                .await
            {
                Ok(v) => {
                    c.locations.insert(n(l, "id").unwrap_or_default(), id(&v));
                    first_loc.get_or_insert(id(&v));
                    c.report.add("locations");
                }
                Err(e) => c.report.skip(format!("Location {lname}: {e}")),
            }
        }
        // Site details move to the first location (one is made if needed).
        let site = json!({
            "address_street": s(p, "address_street").or_else(|| s(p, "address")),
            "address_city": s(p, "address_city"), "address_state": s(p, "address_state"), "address_postcode": s(p, "address_zip"),
            "contact_name": s(p, "site_contact_name"), "contact_phone": s(p, "site_contact_phone"), "contact_email": s(p, "site_contact_email"),
            "isp_primary_name": s(p, "primary_isp_name"), "isp_primary_circuit": s(p, "primary_isp_circuit_id"), "isp_primary_contact": s(p, "primary_isp_contact"),
            "isp_secondary_name": s(p, "secondary_isp_name"), "isp_secondary_circuit": s(p, "secondary_isp_circuit_id"), "isp_secondary_contact": s(p, "secondary_isp_contact"),
        });
        let has_site = site
            .as_object()
            .is_some_and(|o| o.values().any(|v| !v.is_null()));
        if has_site {
            let loc = match first_loc {
                Some(l) => Some(l),
                None => match c
                    .api
                    .create_coded(
                        &format!("/api/projects/{pid}/locations"),
                        json!({ "name": name }),
                        "SITE",
                    )
                    .await
                {
                    Ok(v) => {
                        c.report.add("locations");
                        Some(id(&v))
                    }
                    Err(e) => {
                        c.report.skip(format!("Site of {name}: {e}"));
                        None
                    }
                },
            };
            if let Some(l) = loc {
                let body = Value::Object(
                    site.as_object()
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|(_, v)| !v.is_null())
                        .collect(),
                );
                if let Err(e) = c.api.patch(&format!("/api/locations/{l}"), body).await {
                    c.report.skip(format!("Site details of {name}: {e}"));
                }
            }
        }
        // LAN and WAN become prefixes (with gateway) and the WAN address.
        for (role, ip, mask, gw) in [
            ("users", "lan_ip", "lan_subnet", "lan_gateway"),
            ("wan", "wan_ip", "wan_subnet", "wan_gateway"),
        ] {
            let (Some(addr), Some(len)) = (s(p, ip), s(p, mask).and_then(|m| prefix_len(&m)))
            else {
                continue;
            };
            let extra = json!({ "role": role, "gateway": s(p, gw), "dns_servers": s(p, "dns_servers"), "description": if role == "wan" { "WAN (from v1)" } else { "LAN (from v1)" } });
            if c.prefix(pid, &format!("{addr}/{len}"), extra)
                .await
                .is_some()
                && role == "wan"
            {
                c.address(pid, &addr, None, None, Some("WAN address")).await;
            }
        }
    }
    first
}

async fn vlans(c: &mut Ctx<'_>, rows: &[Value]) {
    for v in rows {
        let (Some(p), Some(vid)) = (
            n(v, "project_id").and_then(|p| c.projects.get(&p).copied()),
            n(v, "vlan_id"),
        ) else {
            continue;
        };
        let name = s(v, "name").unwrap_or_else(|| format!("VLAN {vid}"));
        match c.api.post(&format!("/api/projects/{p}/vlans"), json!({ "vid": vid, "name": name, "description": s(v, "description"), "color": s(v, "color") })).await {
            Ok(x) => {
                c.vlans.insert((p, vid), id(&x));
                c.report.add("vlans");
                if let Some(subnet) = s(v, "subnet") {
                    c.prefix(p, &subnet, json!({ "vlan_id": id(&x), "role": "users", "description": name })).await;
                }
            }
            Err(e) => c.report.skip(format!("VLAN {vid}: {e}")),
        }
    }
}

/// v1 rooms carry a free-text floor: one v2 floor per distinct value.
async fn rooms(c: &mut Ctx<'_>, rows: &[Value]) {
    let mut floors: HashMap<(i64, String), i64> = HashMap::new();
    for r in rows {
        let Some(loc) = n(r, "location_id").and_then(|l| c.locations.get(&l).copied()) else {
            continue;
        };
        let floor_text = s(r, "floor").unwrap_or_default();
        let fcode = if is_ground(&floor_text) {
            "0".to_string()
        } else {
            code_from(&floor_text, "0")
        };
        let floor = match floors.get(&(loc, fcode.clone())) {
            Some(f) => *f,
            None => {
                let here = c.api.get(&format!("/api/locations/{loc}")).await.ok();
                let list = here
                    .as_ref()
                    .and_then(|l| l["floors"].as_array().cloned())
                    .unwrap_or_default();
                let existing = list
                    .iter()
                    .find(|f| f["code"].as_str() == Some(fcode.as_str()))
                    .map(id);
                let f = match existing {
                    Some(f) => f,
                    None => {
                        // Levels are unique: a named floor takes the next free one.
                        let levels: HashSet<i64> =
                            list.iter().filter_map(|f| f["level"].as_i64()).collect();
                        let level = match floor_text.trim().parse::<i64>() {
                            Ok(l) if !levels.contains(&l) => l,
                            _ => (1..).find(|l| !levels.contains(l)).unwrap_or(1),
                        };
                        match c
                            .api
                            .post(
                                &format!("/api/locations/{loc}/floors"),
                                json!({ "code": fcode, "name": floor_text, "level": level }),
                            )
                            .await
                        {
                            Ok(v) => {
                                c.report.add("floors");
                                id(&v)
                            }
                            Err(e) => {
                                c.report.skip(format!("Floor {floor_text}: {e}"));
                                continue;
                            }
                        }
                    }
                };
                floors.insert((loc, fcode), f);
                f
            }
        };
        let name = s(r, "name");
        let base = s(r, "room_number")
            .map(|x| code_from(&x, ""))
            .filter(|x| !x.is_empty())
            .unwrap_or_else(|| code_from(name.as_deref().unwrap_or(""), "ROOM"));
        let body = json!({ "name": name, "notes": s(r, "notes"), "contact_name": s(r, "contact_name"), "contact_phone": s(r, "contact_phone"), "contact_email": s(r, "contact_email") });
        match c
            .api
            .create_coded(&format!("/api/floors/{floor}/rooms"), body, &base)
            .await
        {
            Ok(v) => {
                c.rooms.insert(n(r, "id").unwrap_or_default(), id(&v));
                c.report.add("rooms");
            }
            Err(e) => c.report.skip(format!("Room {base}: {e}")),
        }
    }
}

async fn racks(c: &mut Ctx<'_>, rows: &[Value]) {
    for r in rows {
        let Some(p) = n(r, "project_id").and_then(|p| c.projects.get(&p).copied()) else {
            continue;
        };
        let room = match n(r, "room_id").and_then(|x| c.rooms.get(&x).copied()) {
            Some(room) => Some(room),
            None => match n(r, "location_id").and_then(|l| c.locations.get(&l).copied()) {
                Some(l) => c.default_room(l).await,
                None => c.fallback_room(p).await,
            },
        };
        let Some(room) = room else { continue };
        let name = s(r, "name");
        let rack_type = match s(r, "rack_type").unwrap_or_default().as_str() {
            "wall-mount" => "wall_mount",
            "open-frame" | "2-post" => "open_frame",
            _ => "enclosed",
        };
        let width = match s(r, "rack_width").unwrap_or_default().trim_end_matches('"') {
            "10" => "10in",
            "23" => "23in",
            _ => "19in",
        };
        let notes = joined(&[
            s(r, "notes"),
            s(r, "location").map(|l| format!("v1 location: {l}")),
        ]);
        let body = json!({ "name": name, "u_height": n(r, "u_height").unwrap_or(42).clamp(1, 60), "rack_type": rack_type, "width": width, "notes": notes });
        match c
            .api
            .create_coded(
                &format!("/api/rooms/{room}/racks"),
                body,
                &code_from(name.as_deref().unwrap_or(""), "RK01"),
            )
            .await
        {
            Ok(v) => {
                c.racks.insert(n(r, "id").unwrap_or_default(), id(&v));
                c.report.add("racks");
            }
            Err(e) => c
                .report
                .skip(format!("Rack {}: {e}", name.unwrap_or_default())),
        }
    }
}

/// The type of a rack slot that has no inventory device behind it.
fn slot_type(slot: &Value) -> Option<&'static str> {
    match s(slot, "item_type")
        .unwrap_or_else(|| "device".into())
        .as_str()
    {
        "blank" => Some("blanking_panel"),
        "cable-manager" => Some("cable_manager"),
        "patch-panel" => Some("patch_panel"),
        "vertical-pdu" => Some("pdu"),
        _ => Some(device_type_key(
            &s(slot, "device_type")
                .or_else(|| s(slot, "custom_type"))
                .unwrap_or_default(),
        )),
    }
}

fn rack_placement(slot: &Value, rack: i64) -> Value {
    let vertical = s(slot, "item_type").as_deref() == Some("vertical-pdu");
    let mount = if vertical {
        if s(slot, "mount_side").as_deref() == Some("right") {
            "zero_u_right"
        } else {
            "zero_u_left"
        }
    } else if b(slot, "half_width") {
        if s(slot, "half_position").as_deref() == Some("right") {
            "half_right"
        } else {
            "half_left"
        }
    } else {
        "full_width"
    };
    let face = match s(slot, "mounted_face").as_deref() {
        Some("rear") => "rear",
        Some("both") => "both",
        _ => "front",
    };
    let u = n(slot, "u_position").map(|u| {
        u as f64
            + if f(slot, "position_offset").unwrap_or(0.0) >= 0.5 {
                0.5
            } else {
                0.0
            }
    });
    json!({ "type": "rack", "rack_id": rack, "u": if vertical { None } else { u }, "face": face, "mount": mount })
}

async fn devices(c: &mut Ctx<'_>, devices: &[Value], slots: &[Value]) {
    let by_device: HashMap<i64, &Value> = slots
        .iter()
        .filter_map(|sl| Some((n(sl, "device_id")?, sl)))
        .collect();
    // Inventory devices (with their rack slot, if any).
    for d in devices {
        let (Some(v1id), Some(p)) = (
            n(d, "id"),
            n(d, "project_id").and_then(|p| c.projects.get(&p).copied()),
        ) else {
            continue;
        };
        let slot = by_device.get(&v1id).copied();
        let key = device_type_key(&s(d, "type").unwrap_or_default());
        let key = match slot.and_then(slot_type) {
            Some("patch_panel") => "patch_panel",
            Some("pdu") if key == "misc" => "pdu",
            _ => key,
        };
        let placement = match slot.and_then(|sl| Some((sl, c.racks.get(&n(sl, "rack_id")?)?))) {
            Some((sl, rack)) => rack_placement(sl, *rack),
            None => match n(d, "room_id").and_then(|r| c.rooms.get(&r).copied()) {
                Some(room) => json!({ "type": "room", "room_id": room }),
                None => match n(d, "location_id").and_then(|l| c.locations.get(&l).copied()) {
                    Some(l) => match c.default_room(l).await {
                        Some(room) => json!({ "type": "room", "room_id": room }),
                        None => json!({ "type": "unplaced" }),
                    },
                    None => json!({ "type": "unplaced" }),
                },
            },
        };
        let notes = joined(&[
            s(d, "notes"),
            slot.and_then(|sl| s(sl, "slot_notes")),
            s(d, "location").map(|l| format!("v1 location: {l}")),
        ]);
        let status = match s(d, "status")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "planned" => "planned",
            "spare" => "spare",
            "faulty" | "broken" => "faulty",
            "retired" | "decommissioned" => "retired",
            _ => "active",
        };
        let body = json!({
            "device_type": key, "name": s(d, "hostname"), "hostname": s(d, "hostname"), "mac": s(d, "mac"),
            "manufacturer": s(d, "make").or_else(|| slot.and_then(|sl| s(sl, "vendor"))), "model": s(d, "model"),
            "serial_number": s(d, "serial_number").or_else(|| slot.and_then(|sl| s(sl, "serial_number"))),
            "asset_tag": slot.and_then(|sl| s(sl, "asset_tag")),
            "purchase_date": s(d, "purchase_date"), "warranty_expiry": s(d, "warranty_expiry"), "status": status,
            "u_height": slot.and_then(|sl| n(sl, "u_size")).filter(|_| placement["type"] == "rack"),
            "icon_color": s(d, "icon_color"), "text_color": s(d, "text_color"),
            "placement": placement, "notes": notes,
        });
        if let Some(v2) = create_device(
            c,
            p,
            body,
            &format!(
                "device {}",
                s(d, "hostname").unwrap_or_else(|| v1id.to_string())
            ),
        )
        .await
        {
            c.devices.insert(v1id, v2);
            if let Some(sl) = slot {
                c.slot_devices.insert(n(sl, "id").unwrap_or_default(), v2);
            }
            for ip in [s(d, "ip"), slot.and_then(|sl| s(sl, "ip_address"))]
                .into_iter()
                .flatten()
                .collect::<HashSet<_>>()
            {
                c.address(p, &ip, Some(v2), None, None).await;
            }
        }
    }
    // Rack slots with no inventory device: a device of the slot's type.
    for sl in slots.iter().filter(|sl| n(sl, "device_id").is_none()) {
        let (Some(p), Some(rack)) = (
            n(sl, "project_id").and_then(|p| c.projects.get(&p).copied()),
            n(sl, "rack_id").and_then(|r| c.racks.get(&r).copied()),
        ) else {
            continue;
        };
        let key = slot_type(sl).unwrap_or("misc");
        let body = json!({
            "device_type": key, "name": s(sl, "item_label"), "manufacturer": s(sl, "vendor"),
            "serial_number": s(sl, "serial_number"), "asset_tag": s(sl, "asset_tag"),
            "u_height": n(sl, "u_size"), "placement": rack_placement(sl, rack), "notes": s(sl, "slot_notes"),
        });
        if let Some(v2) = create_device(
            c,
            p,
            body,
            &format!(
                "rack item {}",
                s(sl, "item_label").unwrap_or_else(|| key.into())
            ),
        )
        .await
        {
            c.slot_devices.insert(n(sl, "id").unwrap_or_default(), v2);
            if let Some(ip) = s(sl, "ip_address") {
                c.address(p, &ip, Some(v2), None, None).await;
            }
        }
    }
}

/// Creates a device; if its rack position is refused (overlap, off the
/// rack), it's created Unplaced with the reason in its notes.
async fn create_device(c: &mut Ctx<'_>, project: i64, mut body: Value, what: &str) -> Option<i64> {
    let path = format!("/api/projects/{project}/devices");
    // v1 kept dates and values v2 is stricter about; drop what it refuses.
    for attempt in 0..3 {
        match c.api.post(&path, body.clone()).await {
            Ok(v) => {
                c.report.add("devices");
                c.created_devices.push(id(&v));
                return Some(id(&v));
            }
            Err(e)
                if attempt < 2
                    && body["placement"]["type"] == "rack"
                    && (e.message.contains("U")
                        || e.message.contains("rack")
                        || e.message.contains("taken")
                        || e.message.contains("space")) =>
            {
                let note = format!("Imported from v1 Unplaced: {}", e.message);
                body["notes"] = json!(joined(&[
                    body["notes"].as_str().map(String::from),
                    Some(note)
                ]));
                body["placement"] = json!({ "type": "unplaced" });
                body["u_height"] = Value::Null;
            }
            Err(e)
                if attempt < 2
                    && (e.message.contains("mac")
                        || e.message.contains("MAC")
                        || e.message.contains("date")
                        || e.message.contains("colour")
                        || e.message.contains("color")) =>
            {
                for k in [
                    "mac",
                    "purchase_date",
                    "warranty_expiry",
                    "icon_color",
                    "text_color",
                ] {
                    body[k] = Value::Null;
                }
            }
            Err(e) => {
                c.report.skip(format!("{what}: {e}"));
                return None;
            }
        }
    }
    None
}

/// Power figures, outlets on PDUs and UPSes, inlets, power cords and
/// battery modules, from v1's rack slot power columns.
async fn power(c: &mut Ctx<'_>, slots: &[Value]) {
    let by_id: HashMap<i64, &Value> = slots
        .iter()
        .filter_map(|sl| Some((n(sl, "id")?, sl)))
        .collect();
    // Figures.
    for sl in slots {
        let Some(dev) = n(sl, "id").and_then(|i| c.slot_devices.get(&i).copied()) else {
            continue;
        };
        let spec = json!({
            "input_voltage": s(sl, "input_voltage"),
            "capacity_va": n(sl, "ups_va_rating").or_else(|| n(sl, "capacity_va")),
            "capacity_w": n(sl, "ups_watt_rating").or_else(|| n(sl, "capacity_w")),
            "runtime_curve": curve(&j(sl, "runtime_curve")),
            "ebm_runtime_curve": curve(&j(sl, "ebm_runtime_curve")),
            "max_ebm_slots": n(sl, "ups_max_ebm_slots"),
        });
        if spec
            .as_object()
            .is_some_and(|o| o.values().any(|v| !v.is_null()))
        {
            match c.api.put(&format!("/api/devices/{dev}/power"), spec).await {
                Ok(_) => c.report.add("power figures"),
                Err(e) => c.report.skip(format!(
                    "Power figures of slot {}: {e}",
                    n(sl, "id").unwrap_or_default()
                )),
            }
        }
    }
    // Outlets, made on demand for the sources that feed something.
    let mut outlets: HashMap<i64, Vec<(i64, &'static str)>> = HashMap::new();
    for sl in slots {
        let Some(dev) = n(sl, "id").and_then(|i| c.slot_devices.get(&i).copied()) else {
            continue;
        };
        let groups = j(sl, "outlet_groups");
        let Some(groups) = groups.as_array().filter(|g| !g.is_empty()) else {
            continue;
        };
        let mut list = Vec::new();
        let mut number = 0;
        for (gi, g) in groups.iter().enumerate() {
            let (outlet, _) = outlet_and_plug(g["type"].as_str());
            for _ in 0..g["count"].as_i64().unwrap_or(0).clamp(0, 96) {
                number += 1;
                match c.api.post(&format!("/api/devices/{dev}/ports"), json!({ "code": format!("O{number}"), "connector": outlet, "outlet_group": gi + 1 })).await {
                    Ok(p) => {
                        list.push((id(&p), outlet));
                        c.report.add("power outlets");
                    }
                    Err(e) => c.report.skip(format!("Outlet O{number}: {e}")),
                }
            }
        }
        outlets.insert(dev, list);
    }
    // Cords: each consumer gets a plug per feed it had in v1.
    for sl in slots {
        let Some(dev) = n(sl, "id").and_then(|i| c.slot_devices.get(&i).copied()) else {
            continue;
        };
        for (psu, src, outlet_no) in [
            ("PSU1", "power_source_slot_id", "power_source_outlet"),
            ("PSU2", "psu2_source_slot_id", "psu2_source_outlet"),
        ] {
            let Some(source) = n(sl, src).and_then(|x| c.slot_devices.get(&x).copied()) else {
                continue;
            };
            let Some(list) = outlets.get(&source) else {
                c.report.skip(format!(
                    "Power cord {psu}: its source has no outlets recorded"
                ));
                continue;
            };
            let idx = n(sl, outlet_no).unwrap_or(1).max(1) as usize - 1;
            let Some((outlet_port, outlet_kind)) = list.get(idx).copied() else {
                c.report.skip(format!(
                    "Power cord {psu}: outlet {} doesn't exist",
                    idx + 1
                ));
                continue;
            };
            let (_, plug) = outlet_and_plug(Some(outlet_kind));
            let inlet = match c
                .api
                .post(
                    &format!("/api/devices/{dev}/ports"),
                    json!({ "code": psu, "connector": plug }),
                )
                .await
            {
                Ok(p) => id(&p),
                Err(e) => {
                    c.report.skip(format!("Inlet {psu}: {e}"));
                    continue;
                }
            };
            match c.api.post("/api/connections", json!({ "kind": "power", "a": { "port_id": outlet_port }, "b": { "port_id": inlet }, "cable_type": "Power cord" })).await {
                Ok(_) => c.report.add("power cords"),
                Err(e) => c.report.skip(format!("Power cord {psu}: {e}")),
            }
        }
        // A battery module joins its UPS with a battery cable.
        if let Some(ups) = n(sl, "ebm_connected_ups_id")
            .and_then(|x| by_id.get(&x))
            .and_then(|u| n(u, "id"))
            .and_then(|x| c.slot_devices.get(&x).copied())
        {
            let a = c
                .api
                .post(
                    &format!("/api/devices/{ups}/ports"),
                    json!({ "code": format!("BAT{}", dev % 1000), "connector": "Battery" }),
                )
                .await;
            let b2 = c
                .api
                .post(
                    &format!("/api/devices/{dev}/ports"),
                    json!({ "code": "BAT", "connector": "Battery" }),
                )
                .await;
            match (a, b2) {
                (Ok(a), Ok(b2)) => match c.api.post("/api/connections", json!({ "kind": "power", "a": { "port_id": id(&a) }, "b": { "port_id": id(&b2) }, "cable_type": "Battery cable" })).await {
                    Ok(_) => c.report.add("battery cables"),
                    Err(e) => c.report.skip(format!("Battery cable: {e}")),
                },
                (Err(e), _) | (_, Err(e)) => c.report.skip(format!("Battery ports: {e}")),
            }
        }
    }
}

/// Ports (and v1 diagram interfaces) and the cables between them.
async fn ports(c: &mut Ctx<'_>, rows: &[Value], interfaces: &[Value]) {
    let mut used: HashMap<i64, HashSet<String>> = HashMap::new();
    let mut project_of_device: HashMap<i64, i64> = HashMap::new();
    for r in rows {
        let (Some(v1id), Some(dev)) = (
            n(r, "id"),
            n(r, "device_id").and_then(|d| c.devices.get(&d).copied()),
        ) else {
            continue;
        };
        if let Some(p) = n(r, "project_id").and_then(|p| c.projects.get(&p).copied()) {
            project_of_device.insert(dev, p);
        }
        let name = s(r, "port_name");
        let base = n(r, "port_number")
            .map(|x| x.to_string())
            .unwrap_or_else(|| {
                code_from(name.as_deref().unwrap_or(""), "P")
                    .chars()
                    .take(10)
                    .collect()
            });
        let taken = used.entry(dev).or_default();
        let mut code = base.clone();
        let mut i = 2;
        while taken.contains(&code) {
            code = format!("{}-{i}", &base[..base.len().min(7)]);
            i += 1;
        }
        taken.insert(code.clone());
        let body = json!({ "code": code, "interface_name": name, "speed": s(r, "speed").and_then(|x| speed_mbps(&x)), "requires_permanent": false });
        match c.api.post(&format!("/api/devices/{dev}/ports"), body).await {
            Ok(p) => {
                c.ports.insert(v1id, id(&p));
                c.report.add("ports");
            }
            Err(e) => c.report.skip(format!("Port {code}: {e}")),
        }
    }
    // Cables, once per pair.
    let mut done: HashSet<(i64, i64)> = HashSet::new();
    for r in rows {
        let (Some(a), Some(bp)) = (n(r, "id"), n(r, "connected_port_id")) else {
            continue;
        };
        let pair = (a.min(bp), a.max(bp));
        if !done.insert(pair) {
            continue;
        }
        let (Some(pa), Some(pb)) = (c.ports.get(&a).copied(), c.ports.get(&bp).copied()) else {
            continue;
        };
        let body = json!({ "kind": "patch", "a": { "port_id": pa, "side": "front" }, "b": { "port_id": pb, "side": "front" }, "cable_type": s(r, "cable_type").and_then(|t| cable_type(&t)) });
        match c.api.post("/api/connections", body).await {
            Ok(_) => c.report.add("cables"),
            Err(e) => c
                .report
                .skip(format!("Cable between v1 ports {a} and {bp}: {e}")),
        }
    }
    // Diagram interfaces: a port per name not already there, and its IP.
    for i in interfaces {
        let (Some(dev), Some(name)) = (
            n(i, "device_id").and_then(|d| c.devices.get(&d).copied()),
            s(i, "name"),
        ) else {
            continue;
        };
        let code: String = code_from(&name, "IF").chars().take(10).collect();
        let taken = used.entry(dev).or_default();
        if taken.contains(&code) {
            continue;
        }
        taken.insert(code.clone());
        if let Ok(p) = c.api.post(&format!("/api/devices/{dev}/ports"), json!({ "code": code, "interface_name": name, "speed": s(i, "speed").and_then(|x| speed_mbps(&x)) })).await {
            c.report.add("ports");
            if let (Some(ip), Some(proj)) = (s(i, "ip"), project_of_device.get(&dev).copied().or_else(|| p["project_id"].as_i64())) {
                c.address(proj, &ip, Some(dev), Some(id(&p)), None).await;
            } else if let Some(ip) = s(i, "ip") {
                if let Ok(d) = c.api.get(&format!("/api/devices/{dev}")).await {
                    if let Some(proj) = d["project_id"].as_i64() {
                        c.address(proj, &ip, Some(dev), Some(id(&p)), None).await;
                    }
                }
            }
        }
    }
}

async fn cameras_and_access(c: &mut Ctx<'_>, cameras: &[Value], access: &[Value]) {
    for cam in cameras {
        let Some(p) = n(cam, "project_id").and_then(|p| c.projects.get(&p).copied()) else {
            continue;
        };
        let notes = joined(&[
            s(cam, "location_notes"),
            s(cam, "resolution").map(|r| format!("Resolution {r}")),
        ]);
        let body = json!({ "device_type": "camera", "name": s(cam, "name"), "model": s(cam, "model"), "mac": s(cam, "mac"), "placement": { "type": "unplaced" }, "notes": notes });
        if let Some(v2) = create_device(
            c,
            p,
            body,
            &format!("camera {}", s(cam, "name").unwrap_or_default()),
        )
        .await
        {
            c.cameras.insert(n(cam, "id").unwrap_or_default(), v2);
            if let Some(ip) = s(cam, "ip_address") {
                c.address(p, &ip, Some(v2), None, None).await;
            }
        }
    }
    for a in access {
        let Some(p) = n(a, "project_id").and_then(|p| c.projects.get(&p).copied()) else {
            continue;
        };
        let key = if s(a, "device_type")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .contains("reader")
        {
            "door_reader"
        } else {
            "access_control_panel"
        };
        let notes = joined(&[
            s(a, "door_name").map(|d| format!("Door: {d}")),
            s(a, "location"),
            s(a, "floor").map(|f| format!("Floor {f}")),
        ]);
        let body = json!({ "device_type": key, "name": s(a, "name"), "model": s(a, "model"), "mac": s(a, "mac"), "firmware": s(a, "firmware_version"), "placement": { "type": "unplaced" }, "notes": notes });
        if let Some(v2) = create_device(
            c,
            p,
            body,
            &format!("access device {}", s(a, "name").unwrap_or_default()),
        )
        .await
        {
            if let Some(ip) = s(a, "ip_address") {
                c.address(p, &ip, Some(v2), None, None).await;
            }
        }
    }
}

async fn tags(c: &mut Ctx<'_>, tags: &[Value], assigned: &[Value], camera_assigned: &[Value]) {
    let mut tag_ids: HashMap<i64, i64> = HashMap::new();
    for t in tags {
        let (Some(p), Some(name)) = (
            n(t, "project_id").and_then(|p| c.projects.get(&p).copied()),
            s(t, "name"),
        ) else {
            continue;
        };
        match c
            .api
            .post(
                &format!("/api/projects/{p}/tags"),
                json!({ "name": name, "color": s(t, "color") }),
            )
            .await
        {
            Ok(v) => {
                tag_ids.insert(n(t, "id").unwrap_or_default(), id(&v));
                c.report.add("tags");
            }
            Err(e) => c.report.skip(format!("Tag {name}: {e}")),
        }
    }
    let mut per_device: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    for a in assigned {
        if let (Some(d), Some(t)) = (
            n(a, "device_id").and_then(|d| c.devices.get(&d).copied()),
            n(a, "tag_id").and_then(|t| tag_ids.get(&t).copied()),
        ) {
            per_device.entry(d).or_default().push(t);
        }
    }
    for a in camera_assigned {
        if let (Some(d), Some(t)) = (
            n(a, "camera_id").and_then(|d| c.cameras.get(&d).copied()),
            n(a, "tag_id").and_then(|t| tag_ids.get(&t).copied()),
        ) {
            per_device.entry(d).or_default().push(t);
        }
    }
    for (d, list) in per_device {
        if let Err(e) = c
            .api
            .put(
                &format!("/api/devices/{d}/tags"),
                json!({ "tag_ids": list }),
            )
            .await
        {
            c.report.skip(format!("Tags of device {d}: {e}"));
        }
    }
}

/// v1's custom rack devices and catalogue entries become templates (height,
/// power figures and outlets).
async fn templates(
    c: &mut Ctx<'_>,
    custom: &[Value],
    catalog: &[Value],
    first_project: Option<i64>,
) {
    let mut make = Vec::new();
    for t in custom {
        if let Some(p) = n(t, "project_id").and_then(|p| c.projects.get(&p).copied()) {
            let groups = match n(t, "outlet_count").filter(|x| *x > 0) {
                Some(count) => json!([{ "type": s(t, "outlet_type"), "count": count }]),
                None => Value::Null,
            };
            make.push((
                p,
                s(t, "name"),
                device_type_key(&s(t, "type").unwrap_or_default()),
                s(t, "vendor"),
                n(t, "u_size"),
                groups,
                json!({ "input_voltage": s(t, "input_voltage") }),
                false,
            ));
        }
    }
    // The catalogue was per user in v1; it lands in the first project.
    if let Some(p) = first_project {
        for t in catalog {
            let spec = json!({
                "input_voltage": s(t, "input_voltage"), "capacity_va": n(t, "capacity_va"), "capacity_w": n(t, "capacity_w"),
                "runtime_curve": curve(&j(t, "runtime_curve")), "ebm_runtime_curve": curve(&j(t, "ebm_runtime_curve")),
            });
            make.push((
                p,
                s(t, "name"),
                device_type_key(&s(t, "render_type").unwrap_or_default()),
                None,
                n(t, "u_size"),
                j(t, "outlet_groups"),
                spec,
                b(t, "half_width"),
            ));
        }
    }
    for (p, name, key, vendor, u, groups, spec, half) in make {
        let name = name.unwrap_or_else(|| "Imported template".into());
        let key = if key == "misc" && groups.as_array().is_some_and(|g| !g.is_empty()) {
            "pdu"
        } else {
            key
        };
        // Outlets in rows of up to 24 on the front.
        let mut port_groups = Vec::new();
        let mut row = 0;
        for g in groups.as_array().cloned().unwrap_or_default() {
            let (outlet, _) = outlet_and_plug(g["type"].as_str());
            let mut left = g["count"].as_i64().unwrap_or(0).clamp(0, 96);
            while left > 0 && row < 2 * u.unwrap_or(1).max(1) {
                let cols = left.min(24);
                port_groups.push(json!({ "grid_row": row, "grid_col": 0, "rows": 1, "cols": cols, "prefix": "O", "connector": outlet, "outlet_group": port_groups.len() + 1 }));
                left -= cols;
                row += 1;
            }
        }
        let body = json!({
            "name": name, "device_type": key, "manufacturer": vendor, "u_height": u.map(|x| x as f64), "half_width": half,
            "power": spec, "port_groups": port_groups, "port_overrides": [], "elements": [],
        });
        match c
            .api
            .post(&format!("/api/projects/{p}/templates"), body.clone())
            .await
        {
            Ok(_) => c.report.add("templates"),
            Err(e) => {
                // Without outlets, if those were the problem.
                let mut plain = body;
                plain["port_groups"] = json!([]);
                match c
                    .api
                    .post(&format!("/api/projects/{p}/templates"), plain)
                    .await
                {
                    Ok(_) => c.report.add("templates"),
                    Err(_) => c.report.skip(format!("Template {name}: {e}")),
                }
            }
        }
    }
}

async fn topologies(c: &mut Ctx<'_>, v1: &HashMap<&'static str, Vec<Value>>) {
    let get = |k: &str| v1.get(k).cloned().unwrap_or_default();
    let (nodes, edges, labels, zones, shapes) = (
        get("topology_nodes"),
        get("topology_edges"),
        get("topology_labels"),
        get("topology_zones"),
        get("topology_shapes"),
    );
    for t in get("topologies") {
        let (Some(tid), Some(p)) = (
            n(&t, "id"),
            n(&t, "project_id").and_then(|p| c.projects.get(&p).copied()),
        ) else {
            continue;
        };
        let of = |rows: &[Value]| {
            rows.iter()
                .filter(|r| n(r, "topology_id") == Some(tid))
                .cloned()
                .collect::<Vec<_>>()
        };
        let ns: Vec<Value> = of(&nodes)
            .iter()
            .map(|nd| {
                json!({
                    "key": format!("n{}", n(nd, "id").unwrap_or_default()),
                    "device_id": n(nd, "device_id").and_then(|d| c.devices.get(&d).copied()),
                    "label": s(nd, "label").map(|l| l.chars().take(200).collect::<String>()),
                    "x": f(nd, "x").unwrap_or(0.0), "y": f(nd, "y").unwrap_or(0.0),
                    "width": f(nd, "width"), "height": f(nd, "height"),
                })
            })
            .collect();
        let keys: HashSet<String> = ns
            .iter()
            .filter_map(|x| x["key"].as_str().map(String::from))
            .collect();
        let es: Vec<Value> = of(&edges)
            .iter()
            .filter(|e| {
                s(e, "source_element_type").is_none_or(|x| x == "node")
                    && s(e, "target_element_type").is_none_or(|x| x == "node")
            })
            .filter_map(|e| {
                let (a, b2) = (
                    format!("n{}", n(e, "source_node_id")?),
                    format!("n{}", n(e, "target_node_id")?),
                );
                (keys.contains(&a) && keys.contains(&b2))
                    .then(|| json!({ "source": a, "target": b2, "label": s(e, "label") }))
            })
            .collect();
        let mut items: Vec<Value> = Vec::new();
        for l in of(&labels) {
            items.push(json!({ "kind": "label", "x": f(&l, "x").unwrap_or(0.0), "y": f(&l, "y").unwrap_or(0.0), "text": s(&l, "text") }));
        }
        for z in of(&zones) {
            items.push(json!({ "kind": "zone", "x": f(&z, "x").unwrap_or(0.0), "y": f(&z, "y").unwrap_or(0.0), "width": f(&z, "width"), "height": f(&z, "height"), "text": s(&z, "name") }));
        }
        for sh in of(&shapes) {
            items.push(json!({ "kind": "shape", "x": f(&sh, "x").unwrap_or(0.0), "y": f(&sh, "y").unwrap_or(0.0), "width": f(&sh, "width"), "height": f(&sh, "height"), "text": s(&sh, "label") }));
        }
        let name = s(&t, "name").unwrap_or_else(|| "Diagram".into());
        let body = json!({ "name": name, "description": s(&t, "description"), "nodes": ns, "edges": es, "items": items });
        match c
            .api
            .post(&format!("/api/projects/{p}/topologies"), body)
            .await
        {
            Ok(_) => c.report.add("diagrams"),
            Err(e) => c.report.skip(format!("Diagram {name}: {e}")),
        }
    }
}

/// Integrations start with automatic sync off. Secrets v1 encrypted itself
/// (from its migration 0065 on) use v2's format and key and are kept as
/// they are; older ones, in MariaDB's AES_ENCRYPT, are decrypted with v1's
/// JWT secret and encrypted again. A secret that can't be read is left out
/// and listed.
/// A stored v1 integration secret in v2's form.
async fn carry_secret(c: &Ctx<'_>, stored: &str) -> Result<String, String> {
    if stored.starts_with("v1:") {
        return c
            .secrets
            .decrypt(stored)
            .map(|_| stored.to_string())
            .map_err(|_| "it can't be read with this RACKPATH_ENCRYPTION_KEY; use v1's".into());
    }
    let Some(key) = c.legacy_key else {
        return Err(
            "it's in v1's older format: set RACKPATH_V1_JWT_SECRET to v1's RACKPATH_JWT_SECRET"
                .into(),
        );
    };
    let plain: Option<String> =
        sqlx::query_scalar("SELECT CAST(AES_DECRYPT(FROM_BASE64(?), ?) AS CHAR)")
            .bind(stored)
            .bind(key)
            .fetch_one(c.from)
            .await
            .map_err(|e| e.to_string())?;
    match plain {
        Some(p) if !p.is_empty() => Ok(c.secrets.encrypt(&p)),
        _ => Err("it can't be read with that RACKPATH_V1_JWT_SECRET".into()),
    }
}

async fn integrations(c: &mut Ctx<'_>, rows: &[Value]) -> Result<(), String> {
    let mut tx = c.pool.begin().await.map_err(|e| e.to_string())?;
    for i in rows {
        let Some(p) = n(i, "project_id").and_then(|p| c.projects.get(&p).copied()) else {
            continue;
        };
        let kind = match s(i, "platform").unwrap_or_default().as_str() {
            "unifi" => "unifi",
            "unifi-protect" => "unifi_protect",
            "unifi-access" => "unifi_access",
            "zabbix" => "zabbix",
            other => {
                c.report.skip(format!(
                    "Integration {}: platform {other} isn't supported in v2",
                    s(i, "name").unwrap_or_default()
                ));
                continue;
            }
        };
        let name = s(i, "name").unwrap_or_else(|| kind.into());
        let (secret, auth) = match (s(i, "api_key"), s(i, "password")) {
            (Some(k), _) => (Some(k), if kind == "zabbix" { "token" } else { "api_key" }),
            (None, Some(pw)) => (Some(pw), "password"),
            _ => (None, if kind == "zabbix" { "token" } else { "api_key" }),
        };
        let site = j(i, "config")["site"]
            .as_str()
            .filter(|x| {
                x.chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
                    && !x.is_empty()
            })
            .map(String::from);
        let options = if kind.starts_with("unifi") {
            json!({ "site": site })
        } else {
            json!({})
        };
        let options = Value::Object(
            options
                .as_object()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|(_, v)| !v.is_null())
                .collect(),
        );
        let secret = match secret {
            Some(stored) => match carry_secret(c, &stored).await {
                Ok(v) => Some(v),
                Err(why) => {
                    c.report.skip(format!(
                        "Integration {name}: its secret wasn't brought across ({why}); enter it again"
                    ));
                    None
                }
            },
            None => None,
        };
        let now = now_ts();
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO integrations (project_id, kind, name, base_url, username, secret_enc, auth_kind, verify_tls, options,
             auto_sync, sync_interval_minutes, hold_threshold_pct, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 50, ?, ?) RETURNING id",
        )
        .bind(p)
        .bind(kind)
        .bind(&name)
        .bind(s(i, "base_url"))
        .bind(if auth == "password" { s(i, "username") } else { None })
        .bind(secret)
        .bind(auth)
        .bind(n(i, "verify_ssl").is_none_or(|v| v != 0))
        .bind(options.to_string())
        .bind(n(i, "sync_interval_minutes").unwrap_or(60).max(5))
        .bind(&now)
        .bind(&now)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("Integration {name}: {e}"))?;
        audit::record(
            &mut tx,
            &RequestCtx::system(),
            Some((c.owner.0, c.owner.1.as_str())),
            Entry::new("import", "integration", Some(id))
                .path(name)
                .project(Some(p))
                .changes(json!({ "from": "v1", "kind": kind, "auto_sync": false })),
        )
        .await
        .map_err(|e| e.to_string())?;
        c.report.add("integrations");
    }
    tx.commit().await.map_err(|e| e.to_string())
}

/// v1's activity log is kept as history entries, at their original times.
async fn activity(c: &mut Ctx<'_>, rows: &[Value]) -> Result<(), String> {
    let mut tx = c.pool.begin().await.map_err(|e| e.to_string())?;
    for a in rows {
        let at = s(a, "created_at")
            .map(|t| format!("{}Z", t.replace(' ', "T")))
            .unwrap_or_else(now_ts);
        let user = n(a, "user_id").and_then(|u| c.users.get(&u).cloned());
        sqlx::query(
            "INSERT INTO audit_log (at, user_id, username, project_id, action, resource_type, changes, request_id)
             VALUES (?, ?, ?, ?, 'import', 'v1_activity', ?, 'v1-import')",
        )
        .bind(at)
        .bind(user.as_ref().map(|u| u.0))
        .bind(user.as_ref().map(|u| u.1.clone()))
        .bind(n(a, "project_id").and_then(|p| c.projects.get(&p).copied()))
        .bind(json!({ "v1_action": s(a, "action"), "details": s(a, "details") }).to_string())
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        c.report.add("history entries");
    }
    tx.commit().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_from_free_text() {
        assert_eq!(code_from("Main Office (HQ)", "X"), "MAIN-OFFICE-HQ");
        assert_eq!(code_from("  rack #1 ", "X"), "RACK-1");
        assert_eq!(code_from("Ünïcode only ✓", "X"), "N-CODE-ONLY");
        assert_eq!(code_from("!!!", "LOC"), "LOC");
        assert!(is_ground("Ground floor") && is_ground("") && !is_ground("1"));
        assert_eq!(code_from("a very long location name indeed", "X").len(), 16);
        assert!(!code_from("abcdefghijklmno-pq", "X").ends_with('-'));
    }

    #[test]
    fn device_types_and_cables() {
        assert_eq!(device_type_key("Access Point"), "access_point");
        assert_eq!(device_type_key("Core-Switch"), "switch");
        assert_eq!(device_type_key("toaster"), "misc");
        assert_eq!(cable_type("cat6A"), Some("Cat6a"));
        assert_eq!(cable_type("Fiber"), None);
    }

    #[test]
    fn speeds_masks_and_plugs() {
        assert_eq!(speed_mbps("1G"), Some(1000));
        assert_eq!(speed_mbps("10 Gbps"), Some(10_000));
        assert_eq!(speed_mbps("100M"), Some(100));
        assert_eq!(speed_mbps("fast"), None);
        assert_eq!(prefix_len("255.255.255.0"), Some(24));
        assert_eq!(prefix_len("/26"), Some(26));
        assert_eq!(prefix_len("255.0.255.0"), None);
        assert_eq!(outlet_and_plug(Some("IEC C13")), ("C13", "C14"));
        assert_eq!(outlet_and_plug(Some("C19")), ("C19", "C20"));
        assert_eq!(
            outlet_and_plug(Some("NEMA 5-15R")),
            ("NEMA 5-15R", "NEMA 5-15P")
        );
        assert_eq!(outlet_and_plug(Some("weird")), ("C13", "C14"));
        assert_eq!(
            suggestion("10.0.0.7/24 has host bits set; did you mean 10.0.0.0/24?").as_deref(),
            Some("10.0.0.0/24")
        );
    }

    #[test]
    fn runtime_curves_convert() {
        let v1 = json!([{ "load_watts": 500, "runtime_minutes": 12 }, { "load_watts": 1000, "runtime_minutes": 5 }]);
        assert_eq!(
            curve(&v1),
            Some(
                json!([{ "load_w": 500.0, "minutes": 12.0 }, { "load_w": 1000.0, "minutes": 5.0 }])
            )
        );
        assert_eq!(curve(&json!([])), None);
    }
}
