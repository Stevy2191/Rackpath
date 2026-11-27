//! Ports (design section 6): what a device's sockets are, what is plugged
//! into them, and the chain each one is part of.
//!
//! A port's `connector` is its jack or cage (RJ45, LC, SFP+…). A cage port
//! can hold a `transceiver` (10GBASE-SR…), which decides what it takes.
//! `medium` follows from those and is only chosen where it's ambiguous (an
//! RJ45 console port).

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, QueryBuilder, Sqlite, SqliteConnection};

use super::devices::normalize_mac;
use super::places::{check_len, merge_text};
use super::{apply_nullable, require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::cabling;
use crate::domain::cabling::{default_port, ChainState, Role, Side, Step};
use crate::domain::media::{
    self, transceiver_fits, CableType, Connector, Medium, PortMedia, Transceiver,
};
use crate::domain::naming::normalize_code;
use crate::domain::permissions::{Action, ScopeType};
use crate::error::{AppError, AppResult};
use crate::hierarchy::{self, Subtree};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

// ---------------------------------------------------------------- reading

#[derive(FromRow, Deserialize, Serialize, Clone, Debug)]
pub struct PortRow {
    pub id: i64,
    pub device_id: i64,
    pub code: String,
    pub face: String,
    pub role: String,
    #[serde(deserialize_with = "int_bool")]
    pub requires_permanent: bool,
    pub medium: String,
    pub connector: Option<String>,
    pub transceiver: Option<String>,
    pub fiber_mode: Option<String>,
    pub sort_order: i64,
    pub interface_name: Option<String>,
    pub speed: Option<i64>,
    pub poe: Option<String>,
    pub description: Option<String>,
    pub mac: Option<String>,
    pub wlan_id: Option<i64>,
    pub outlet_group: Option<i64>,
    #[serde(deserialize_with = "int_bool")]
    pub from_template: bool,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub path: String,
    #[serde(skip_serializing)]
    pub project_id: i64,
    #[serde(skip_serializing)]
    pub room_id: Option<i64>,
}

macro_rules! port_select {
    () => {
        "SELECT o.id, o.device_id, o.code, o.face, o.role, o.requires_permanent, o.medium, o.connector, o.transceiver, \
         o.fiber_mode, o.sort_order, o.interface_name, o.speed, o.poe, o.description, o.mac, o.wlan_id, o.outlet_group, o.from_template, o.notes, \
         o.created_at, o.updated_at, s.path, s.project_id, s.room_id \
         FROM ports o JOIN search_entries s ON s.kind = 'port' AND s.ref_id = o.id "
    };
}

/// The same columns as one JSON object per row, for listings: SQLite
/// builds the whole list as a single JSON value, which is far cheaper than
/// decoding thousands of rows one at a time.
macro_rules! port_json_list {
    ($order:literal) => {
        concat!(
            "SELECT json_group_array(json_object('id', o.id, 'device_id', o.device_id, 'code', o.code, 'face', o.face, \
             'role', o.role, 'requires_permanent', o.requires_permanent, 'medium', o.medium, 'connector', o.connector, \
             'transceiver', o.transceiver, 'fiber_mode', o.fiber_mode, 'sort_order', o.sort_order, \
             'interface_name', o.interface_name, 'speed', o.speed, 'poe', o.poe, 'description', o.description, \
             'mac', o.mac, 'wlan_id', o.wlan_id, 'outlet_group', o.outlet_group, 'from_template', o.from_template, 'notes', o.notes, 'created_at', o.created_at, \
             'updated_at', o.updated_at, 'path', s.path, 'project_id', s.project_id, 'room_id', s.room_id) \
             ORDER BY ",
            $order,
            ") FROM ports o JOIN search_entries s ON s.kind = 'port' AND s.ref_id = o.id "
        )
    };
}

fn int_bool<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum B {
        Bool(bool),
        Int(i64),
    }
    Ok(match B::deserialize(d)? {
        B::Bool(b) => b,
        B::Int(i) => i != 0,
    })
}

/// Decodes a `json_group_array(...)` result.
pub fn from_json_list<T: serde::de::DeserializeOwned>(s: Option<String>) -> AppResult<Vec<T>> {
    match s {
        None => Ok(vec![]),
        Some(s) => {
            serde_json::from_str(&s).map_err(|e| AppError::internal(format!("bad JSON list: {e}")))
        }
    }
}

impl PortRow {
    pub fn role(&self) -> Role {
        Role::parse(&self.role).unwrap_or(Role::Active)
    }

    /// The port as a cable on `side` sees it.
    pub fn media(&self, side: Side) -> PortMedia {
        PortMedia {
            medium: Medium::parse(&self.medium).unwrap_or(Medium::Other),
            connector: self.connector.as_deref().and_then(Connector::parse),
            transceiver: self.transceiver.as_deref().and_then(Transceiver::parse),
            speed: self.speed.and_then(|s| u32::try_from(s).ok()),
            rear: self.role() == Role::Passive && side == Side::Rear,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "device_id": self.device_id, "code": self.code, "path": self.path,
            "face": self.face, "role": self.role, "requires_permanent": self.requires_permanent,
            "medium": self.medium, "connector": self.connector, "transceiver": self.transceiver,
            "fiber_mode": self.fiber_mode, "sort_order": self.sort_order, "interface_name": self.interface_name,
            "speed": self.speed, "effective_speed": self.media(Side::Front).speed(), "poe": self.poe,
            "description": self.description, "mac": self.mac, "wlan_id": self.wlan_id, "outlet_group": self.outlet_group, "from_template": self.from_template, "notes": self.notes,
            "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }

    fn audit_view(&self) -> Value {
        let mut v = self.to_json();
        if let Some(o) = v.as_object_mut() {
            for k in ["created_at", "updated_at", "effective_speed"] {
                o.remove(k);
            }
        }
        v
    }
}

/// A device's template-made ports, in one query.
pub async fn template_ports(
    conn: &mut SqliteConnection,
    device_id: i64,
) -> AppResult<Vec<PortRow>> {
    Ok(sqlx::query_as::<_, PortRow>(concat!(
        port_select!(),
        "WHERE o.device_id = ? AND o.from_template = 1 ORDER BY o.id"
    ))
    .bind(device_id)
    .fetch_all(conn)
    .await?)
}

pub async fn load_port(conn: &mut SqliteConnection, id: i64) -> AppResult<PortRow> {
    sqlx::query_as::<_, PortRow>(concat!(port_select!(), "WHERE o.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

fn push_ids(q: &mut QueryBuilder<Sqlite>, ids: &[i64]) {
    let mut sep = q.separated(", ");
    for id in ids {
        sep.push_bind(*id);
    }
    sep.push_unseparated(")");
}

/// The far end of a cable, as listed with a port.
#[derive(Deserialize, Serialize)]
pub struct FarEnd {
    pub port_id: i64,
    pub side: String,
    pub path: String,
    pub device_id: i64,
}

/// A cable on a port side, as listed with the port.
#[derive(Deserialize, Serialize)]
pub struct CableOnPort {
    #[serde(skip_serializing)]
    port_id: i64,
    #[serde(skip_serializing)]
    side: String,
    pub connection_id: i64,
    pub kind: String,
    pub cable_type: Option<String>,
    pub length_m: Option<f64>,
    pub color: Option<String>,
    pub label: Option<String>,
    pub far: FarEnd,
}

#[derive(Serialize)]
pub struct VlanOnPort {
    pub id: i64,
    pub vid: i64,
    pub name: String,
    pub mode: String,
}

/// A port with its cables, VLANs and chain state. Serialized directly
/// (no intermediate JSON tree), so big rack listings stay light.
#[derive(Serialize)]
pub struct ListedPort {
    #[serde(flatten)]
    pub port: PortRow,
    pub effective_speed: Option<u32>,
    pub front: Option<CableOnPort>,
    pub rear: Option<CableOnPort>,
    pub vlans: Vec<VlanOnPort>,
    pub chain_state: &'static str,
}

/// Ports with their cables, VLANs and chain states.
pub async fn with_details(
    conn: &mut SqliteConnection,
    rows: Vec<PortRow>,
) -> AppResult<Vec<ListedPort>> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
    let mut cables: HashMap<(i64, String), CableOnPort> = HashMap::new();
    for chunk in ids.chunks(5000) {
        let mut q = QueryBuilder::new(
            "SELECT json_group_array(json_object('port_id', e.port_id, 'side', e.side, 'connection_id', c.id,
                    'kind', c.kind, 'cable_type', c.cable_type, 'length_m', c.length_m, 'color', c.color,
                    'label', c.label, 'far', json_object('port_id', f.port_id, 'side', f.side, 'path', s.path,
                    'device_id', s.device_id)))
             FROM connection_ends e
             JOIN connections c ON c.id = e.connection_id
             JOIN connection_ends f ON f.connection_id = e.connection_id AND f.endpoint <> e.endpoint
             JOIN search_entries s ON s.kind = 'port' AND s.ref_id = f.port_id
             WHERE e.port_id IN (",
        );
        push_ids(&mut q, chunk);
        let found: Vec<CableOnPort> =
            from_json_list(q.build_query_scalar().fetch_one(&mut *conn).await?)?;
        for c in found {
            cables.insert((c.port_id, c.side.clone()), c);
        }
    }
    let mut vlans: HashMap<i64, Vec<VlanOnPort>> = HashMap::new();
    for chunk in ids.chunks(5000) {
        let mut q = QueryBuilder::new(
            "SELECT pv.port_id, v.id, v.vid, v.name, pv.mode FROM port_vlans pv JOIN vlans v ON v.id = pv.vlan_id
             WHERE pv.port_id IN (",
        );
        push_ids(&mut q, chunk);
        q.push(" ORDER BY v.vid");
        let found: Vec<(i64, i64, i64, String, String)> =
            q.build_query_as().fetch_all(&mut *conn).await?;
        for (port, id, vid, name, mode) in found {
            vlans.entry(port).or_default().push(VlanOnPort {
                id,
                vid,
                name,
                mode,
            });
        }
    }
    let g = cabling::components(conn, &ids).await?;
    let states = crate::domain::cabling::states_for(&g, &ids);
    Ok(rows
        .into_iter()
        .map(|r| {
            let id = r.id;
            ListedPort {
                effective_speed: r.media(Side::Front).speed(),
                front: cables.remove(&(id, "front".to_string())),
                rear: cables.remove(&(id, "rear".to_string())),
                vlans: vlans.remove(&id).unwrap_or_default(),
                chain_state: states
                    .get(&id)
                    .copied()
                    .unwrap_or(ChainState::Unconnected)
                    .as_str(),
                port: r,
            }
        })
        .collect())
}

#[derive(Serialize)]
pub struct PortList {
    ports: Vec<ListedPort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_edit: Option<bool>,
}

pub async fn list_for_device(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(device_id): Path<i64>,
) -> AppResult<Json<PortList>> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Device, device_id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let rows: Vec<PortRow> = from_json_list(
        sqlx::query_scalar(concat!(
            port_json_list!("o.sort_order, o.code"),
            "WHERE o.device_id = ?"
        ))
        .bind(device_id)
        .fetch_one(&mut *conn)
        .await?,
    )?;
    let ports = with_details(&mut conn, rows).await?;
    Ok(Json(PortList {
        ports,
        can_edit: Some(current.principal.can(Action::Write, &placed.chain)),
    }))
}

/// Every port in a rack (including devices on its trays), for the rack
/// patching view.
pub async fn list_for_rack(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(rack_id): Path<i64>,
) -> AppResult<Json<PortList>> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Rack, rack_id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let rows: Vec<PortRow> = from_json_list(
        sqlx::query_scalar(concat!(
            port_json_list!("o.device_id, o.sort_order, o.code"),
            "WHERE s.rack_id = ?"
        ))
        .bind(rack_id)
        .fetch_one(&mut *conn)
        .await?,
    )?;
    let ports = with_details(&mut conn, rows).await?;
    Ok(Json(PortList {
        ports,
        can_edit: None,
    }))
}

pub async fn get_one(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let port = load_port(&mut conn, id).await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Device, port.device_id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let listed = with_details(&mut conn, vec![port]).await?;
    let mut v = serde_json::to_value(&listed[0]).map_err(|e| AppError::internal(e.to_string()))?;
    v["can_edit"] = json!(current.principal.can(Action::Write, &placed.chain));
    Ok(Json(v))
}

// ---------------------------------------------------------------- writing

#[derive(Deserialize, Default, Clone)]
pub struct PortFields {
    code: Option<String>,
    face: Option<String>,
    role: Option<String>,
    requires_permanent: Option<bool>,
    medium: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    connector: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::nullable")]
    transceiver: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::nullable")]
    fiber_mode: Option<Option<String>>,
    sort_order: Option<i64>,
    interface_name: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    speed: Option<Option<i64>>,
    #[serde(default, deserialize_with = "super::nullable")]
    poe: Option<Option<String>>,
    description: Option<String>,
    #[serde(default, deserialize_with = "super::nullable")]
    mac: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::nullable")]
    wlan_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "super::nullable")]
    outlet_group: Option<Option<i64>>,
    notes: Option<String>,
}

/// Final values for a port row.
#[derive(Debug, Clone)]
pub struct PortValues {
    pub face: &'static str,
    pub role: Role,
    pub requires_permanent: bool,
    pub medium: Medium,
    pub connector: Option<Connector>,
    pub transceiver: Option<Transceiver>,
    pub fiber_mode: Option<String>,
    pub sort_order: i64,
    pub interface_name: Option<String>,
    pub speed: Option<i64>,
    pub poe: Option<String>,
    pub description: Option<String>,
    pub mac: Option<String>,
    pub wlan_id: Option<i64>,
    pub outlet_group: Option<i64>,
    pub notes: Option<String>,
}

fn port_code(code: &str) -> AppResult<String> {
    let c = normalize_code(code).map_err(AppError::bad)?;
    if c.len() > 10 {
        return Err(AppError::bad("Port codes are at most 10 characters"));
    }
    Ok(c)
}

fn parse_connector(s: &str) -> AppResult<Connector> {
    Connector::parse(s).ok_or_else(|| {
        let names: Vec<&str> = media::CONNECTORS.iter().map(|(n, _)| *n).collect();
        AppError::bad(format!("connector must be one of {}", names.join(", ")))
    })
}

fn parse_transceiver(s: &str) -> AppResult<Transceiver> {
    Transceiver::parse(s).ok_or_else(|| {
        let names: Vec<&str> = media::TRANSCEIVERS.iter().map(|t| t.name).collect();
        AppError::bad(format!("transceiver must be one of {}", names.join(", ")))
    })
}

/// Works out a port's values from the request, the old row (on update) and
/// the defaults for the device type.
pub(crate) async fn resolve_values(
    conn: &mut SqliteConnection,
    project_id: i64,
    f: PortFields,
    old: Option<&PortRow>,
    type_key: &str,
) -> AppResult<PortValues> {
    let (default_role, default_connector) = default_port(type_key);
    let face = match f.face.as_deref().or(old.map(|o| o.face.as_str())) {
        None | Some("front") => "front",
        Some("rear") => "rear",
        Some(_) => return Err(AppError::bad("face must be front or rear")),
    };
    let role = match &f.role {
        Some(r) => Role::parse(r).ok_or_else(|| AppError::bad("role must be active or passive"))?,
        None => old.map(PortRow::role).unwrap_or(default_role),
    };
    let requires_permanent = f
        .requires_permanent
        .or(old.map(|o| o.requires_permanent))
        .unwrap_or(true);

    // Connector, transceiver and medium.
    let old_connector = old.and_then(|o| o.connector.as_deref().and_then(Connector::parse));
    let connector = match &f.connector {
        Some(Some(c)) => Some(parse_connector(c)?),
        Some(None) => None,
        None if old.is_some() => old_connector,
        None if f.medium.as_deref() == Some("wireless") => None,
        None => Some(Connector::parse(default_connector).unwrap_or(Connector::Rj45)),
    };
    let transceiver = match (&f.transceiver, connector) {
        (Some(Some(t)), Some(Connector::Cage(cage))) => {
            let t = parse_transceiver(t)?;
            transceiver_fits(cage, &t).map_err(AppError::bad)?;
            Some(t)
        }
        (Some(Some(_)), _) => {
            return Err(AppError::bad("Only SFP and QSFP ports take a transceiver"))
        }
        (Some(None), _) => None,
        // Kept from before only while the port is still a fitting cage.
        (None, Some(Connector::Cage(cage))) => old
            .and_then(|o| o.transceiver.as_deref())
            .and_then(Transceiver::parse)
            .filter(|t| transceiver_fits(cage, t).is_ok()),
        (None, _) => None,
    };
    let requested = match &f.medium {
        Some(m) => Some(Medium::parse(m).ok_or_else(|| {
            AppError::bad("medium must be copper, fiber, wireless, console, coax or other")
        })?),
        None => None,
    };

    let medium = match connector {
        Some(Connector::Cage(_)) => {
            let m = transceiver.map(|t| t.medium()).unwrap_or(Medium::Other);
            if requested.is_some_and(|r| r != m) {
                return Err(AppError::bad(
                    "A cage port's medium follows its transceiver",
                ));
            }
            m
        }
        Some(c) => match requested {
            Some(r) if c.media().contains(&r) => r,
            Some(r) => {
                return Err(AppError::bad(format!(
                    "A {} port can't be {}",
                    c.name(),
                    r.as_str()
                )))
            }
            None => old
                .and_then(|o| Medium::parse(&o.medium))
                .filter(|m| c.media().contains(m))
                .unwrap_or(c.media()[0]),
        },
        None => requested
            .or(old.and_then(|o| Medium::parse(&o.medium)))
            .unwrap_or(Medium::Other),
    };
    if medium == Medium::Wireless && connector.is_some() {
        return Err(AppError::bad(
            "A wireless port has no connector (set connector to null)",
        ));
    }
    let fiber_mode = match &f.fiber_mode {
        Some(Some(m)) => {
            if medium != Medium::Fiber {
                return Err(AppError::bad("fiber_mode is for fibre ports only"));
            }
            if m != "simplex" && m != "duplex" {
                return Err(AppError::bad("fiber_mode must be simplex or duplex"));
            }
            Some(m.clone())
        }
        Some(None) => None,
        None => old
            .and_then(|o| o.fiber_mode.clone())
            .filter(|_| medium == Medium::Fiber),
    };

    let speed = apply_nullable(f.speed, old.and_then(|o| o.speed));
    if speed.is_some_and(|s| !(1..=1_600_000).contains(&s)) {
        return Err(AppError::bad("speed is in Mb/s, e.g. 1000 or 10000"));
    }
    let poe = apply_nullable(f.poe, old.and_then(|o| o.poe.clone()));
    if poe
        .as_deref()
        .is_some_and(|p| !["af", "at", "bt", "passive"].contains(&p))
    {
        return Err(AppError::bad("poe must be af, at, bt or passive"));
    }
    let mac = match f.mac {
        None => old.and_then(|o| o.mac.clone()),
        Some(None) => None,
        Some(Some(m)) if m.trim().is_empty() => None,
        Some(Some(m)) => Some(normalize_mac(&m)?),
    };
    let wlan_id = match f.wlan_id {
        Some(Some(w)) => {
            if medium != Medium::Wireless {
                return Err(AppError::bad("Only wireless ports join a WLAN"));
            }
            let found: Option<i64> =
                sqlx::query_scalar("SELECT id FROM wlans WHERE id = ? AND project_id = ?")
                    .bind(w)
                    .bind(project_id)
                    .fetch_optional(&mut *conn)
                    .await?;
            Some(found.ok_or_else(|| AppError::bad("WLAN not found in this project"))?)
        }
        Some(None) => None,
        None => old
            .and_then(|o| o.wlan_id)
            .filter(|_| medium == Medium::Wireless),
    };
    if medium == Medium::Power && role == Role::Passive {
        return Err(AppError::bad("Power outlets and inlets are active ports"));
    }
    let outlet_group = apply_nullable(f.outlet_group, old.and_then(|o| o.outlet_group))
        .filter(|_| medium == Medium::Power || f.outlet_group.is_some());
    if let Some(g) = outlet_group {
        if medium != Medium::Power {
            return Err(AppError::bad("outlet_group is for power ports only"));
        }
        if !(1..=99).contains(&g) {
            return Err(AppError::bad("outlet_group runs from 1 to 99"));
        }
    }
    let interface_name = merge_text(f.interface_name, old.and_then(|o| o.interface_name.clone()));
    check_len("interface_name", &interface_name, 64)?;
    let description = merge_text(f.description, old.and_then(|o| o.description.clone()));
    check_len("description", &description, 255)?;
    Ok(PortValues {
        face,
        role,
        requires_permanent,
        medium,
        connector,
        transceiver,
        fiber_mode,
        sort_order: f.sort_order.or(old.map(|o| o.sort_order)).unwrap_or(0),
        interface_name,
        speed,
        poe,
        description,
        mac,
        wlan_id,
        outlet_group,
        notes: merge_text(f.notes, old.and_then(|o| o.notes.clone())),
    })
}

/// The device a port is being added to, checked for edit rights.
async fn device_for_ports(
    conn: &mut SqliteConnection,
    current: &CurrentUser,
    device_id: i64,
) -> AppResult<(i64, String, String)> {
    let placed = hierarchy::get(conn, ScopeType::Device, device_id).await?;
    require(current, Action::Write, &placed.chain)?;
    let type_key: String = sqlx::query_scalar(
        "SELECT dt.key FROM devices d JOIN device_types dt ON dt.id = d.device_type_id WHERE d.id = ?",
    )
    .bind(device_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok((placed.project_id, type_key, placed.path))
}

pub(crate) async fn insert_port(
    conn: &mut SqliteConnection,
    device_id: i64,
    code: &str,
    v: &PortValues,
    from_template: bool,
) -> AppResult<i64> {
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO ports (device_id, code, face, role, requires_permanent, medium, connector, transceiver, fiber_mode,
         sort_order, interface_name, speed, poe, description, mac, wlan_id, outlet_group, from_template, notes,
         created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(device_id)
    .bind(code)
    .bind(v.face)
    .bind(v.role.as_str())
    .bind(v.requires_permanent)
    .bind(v.medium.as_str())
    .bind(v.connector.map(Connector::name))
    .bind(v.transceiver.map(|t| t.name))
    .bind(&v.fiber_mode)
    .bind(v.sort_order)
    .bind(&v.interface_name)
    .bind(v.speed)
    .bind(&v.poe)
    .bind(&v.description)
        .bind(&v.mac)
    .bind(v.wlan_id)
    .bind(v.outlet_group)
    .bind(from_template)
    .bind(&v.notes)
    .bind(&now)
    .bind(&now)
    .execute(&mut *conn)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(d) if d.is_unique_violation() => {
            AppError::Conflict(format!("Port {code} already exists on this device"))
        }
        _ => e.into(),
    })?
    .last_insert_rowid();
    hierarchy::reindex(conn, Subtree::Port(id)).await?;
    Ok(id)
}

async fn next_sort_order(conn: &mut SqliteConnection, device_id: i64) -> AppResult<i64> {
    Ok(
        sqlx::query_scalar(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ports WHERE device_id = ?",
        )
        .bind(device_id)
        .fetch_one(conn)
        .await?,
    )
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(device_id): Path<i64>,
    JsonBody(body): JsonBody<PortFields>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let mut tx = state.pool.begin().await?;
    let v = create_in(&mut tx, &ctx, &current, device_id, body).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(v)))
}

/// The work of `create`, inside the caller's transaction (also used by
/// the CSV importer).
pub async fn create_in(
    tx: &mut SqliteConnection,
    ctx: &RequestCtx,
    current: &CurrentUser,
    device_id: i64,
    mut body: PortFields,
) -> AppResult<Value> {
    let (project_id, type_key, _) = device_for_ports(&mut *tx, current, device_id).await?;
    let code = port_code(
        body.code
            .as_deref()
            .ok_or_else(|| AppError::bad("code is required"))?,
    )?;
    if body.sort_order.is_none() {
        body.sort_order = Some(next_sort_order(&mut *tx, device_id).await?);
    }
    let values = resolve_values(&mut *tx, project_id, body, None, &type_key).await?;
    let id = insert_port(&mut *tx, device_id, &code, &values, false).await?;
    let port = load_port(&mut *tx, id).await?;
    audit::record(
        &mut *tx,
        ctx,
        Some(current.actor_ref()),
        Entry::new("create", "port", Some(id))
            .path(port.path.clone())
            .project(Some(project_id))
            .changes(port.audit_view()),
    )
    .await?;
    Ok(port.to_json())
}

#[derive(Deserialize)]
pub struct BulkPorts {
    /// Text before the number, e.g. "" → 01, 02…; "G" → G01…
    #[serde(default)]
    prefix: String,
    #[serde(default = "one")]
    start: i64,
    count: i64,
    /// Digits to pad numbers to; default: enough for the largest number.
    width: Option<usize>,
    #[serde(flatten)]
    fields: PortFields,
}

fn one() -> i64 {
    1
}

/// Creates numbered ports in one go (e.g. 48 switch ports or 24 panel ports).
pub async fn create_bulk(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(device_id): Path<i64>,
    JsonBody(body): JsonBody<BulkPorts>,
) -> AppResult<(StatusCode, Json<Value>)> {
    if !(1..=512).contains(&body.count) {
        return Err(AppError::bad("count must be between 1 and 512"));
    }
    if !(0..=99_999).contains(&body.start) {
        return Err(AppError::bad("start must be between 0 and 99999"));
    }
    if body.fields.code.is_some() {
        return Err(AppError::bad("Use prefix, start and count instead of code"));
    }
    let last = body.start + body.count - 1;
    let width = body.width.unwrap_or_else(|| last.to_string().len()).min(10);
    let codes: Vec<String> = (body.start..=last)
        .map(|n| port_code(&format!("{}{:0width$}", body.prefix, n, width = width)))
        .collect::<AppResult<_>>()?;

    let mut tx = state.pool.begin().await?;
    let (project_id, type_key, path) = device_for_ports(&mut tx, &current, device_id).await?;
    let values = resolve_values(&mut tx, project_id, body.fields.clone(), None, &type_key).await?;
    let mut order = match body.fields.sort_order {
        Some(o) => o,
        None => next_sort_order(&mut tx, device_id).await?,
    };
    let mut ids = Vec::with_capacity(codes.len());
    for code in &codes {
        // Names and MACs are per port, so they aren't copied.
        let mut v = values.clone();
        v.sort_order = order;
        v.interface_name = None;
        v.mac = None;
        ids.push(insert_port(&mut tx, device_id, code, &v, false).await?);
        order += 1;
    }
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "port", None)
            .path(path)
            .project(Some(project_id))
            .changes(json!({
                "ports": codes, "connector": values.connector.map(Connector::name),
                "role": values.role.as_str(), "medium": values.medium.as_str(),
            })),
    )
    .await?;
    let rows = sqlx::query_as::<_, PortRow>(concat!(
        port_select!(),
        "WHERE o.device_id = ? ORDER BY o.sort_order, o.code"
    ))
    .bind(device_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let created: HashSet<i64> = ids.into_iter().collect();
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ports": rows.iter().filter(|r| created.contains(&r.id)).map(PortRow::to_json).collect::<Vec<_>>(),
        })),
    ))
}

/// A cable on a port, with the port at its far end.
pub struct PluggedCable {
    pub side: Side,
    pub cable_type: Option<String>,
    pub length_m: Option<f64>,
    pub far: PortRow,
    pub far_side: Side,
}

#[derive(FromRow)]
struct PluggedRow {
    side: String,
    cable_type: Option<String>,
    length_m: Option<f64>,
    far_port: i64,
    far_side: String,
}

pub async fn cables_on(conn: &mut SqliteConnection, port_id: i64) -> AppResult<Vec<PluggedCable>> {
    let rows = sqlx::query_as::<_, PluggedRow>(
        "SELECT e.side, c.cable_type, c.length_m, f.port_id AS far_port, f.side AS far_side FROM connection_ends e
         JOIN connections c ON c.id = e.connection_id
         JOIN connection_ends f ON f.connection_id = e.connection_id AND f.endpoint <> e.endpoint
         WHERE e.port_id = ?",
    )
    .bind(port_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(PluggedCable {
            side: Side::parse(&r.side).unwrap_or(Side::Front),
            cable_type: r.cable_type,
            length_m: r.length_m,
            far: load_port(conn, r.far_port).await?,
            far_side: Side::parse(&r.far_side).unwrap_or(Side::Front),
        });
    }
    Ok(out)
}

pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<PortFields>,
) -> AppResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let old = load_port(&mut tx, id).await?;
    let (project_id, type_key, _) = device_for_ports(&mut tx, &current, old.device_id).await?;
    let code = match &body.code {
        Some(c) => port_code(c)?,
        None => old.code.clone(),
    };
    if old.from_template && code != old.code {
        return Err(AppError::bad(
            "This port comes from the device's template; rename it in the template",
        ));
    }
    let values = resolve_values(&mut tx, project_id, body, Some(&old), &type_key).await?;

    // The cables already plugged in must still fit.
    let cables = cables_on(&mut tx, id).await?;
    if values.role == Role::Active && cables.iter().any(|c| c.side == Side::Rear) {
        return Err(AppError::Conflict(
            "This port has a permanent cable on its rear side; remove it before making the port active"
                .into(),
        ));
    }
    let mut warnings = Vec::new();
    for PluggedCable {
        side,
        cable_type,
        length_m: length,
        far,
        far_side,
    } in &cables
    {
        let mine = PortMedia {
            medium: values.medium,
            connector: values.connector,
            transceiver: values.transceiver,
            speed: values.speed.and_then(|s| u32::try_from(s).ok()),
            rear: values.role == Role::Passive && *side == Side::Rear,
        };
        let theirs = far.media(*far_side);
        let speed = match (mine.speed(), theirs.speed()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        match media::check_cable(
            &mine,
            &theirs,
            cable_type.as_deref().and_then(CableType::parse),
            *length,
            speed,
        ) {
            Ok(v) => warnings.extend(v.warnings),
            Err(e) => {
                return Err(AppError::Conflict(format!(
                    "That doesn't fit the cable on the {} side ({e}); disconnect it first",
                    side.as_str()
                )))
            }
        }
    }

    sqlx::query(
        "UPDATE ports SET code = ?, face = ?, role = ?, requires_permanent = ?, medium = ?, connector = ?, transceiver = ?,
         fiber_mode = ?, sort_order = ?, interface_name = ?, speed = ?, poe = ?, description = ?, mac = ?, wlan_id = ?,
         outlet_group = ?, notes = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&code)
    .bind(values.face)
    .bind(values.role.as_str())
    .bind(values.requires_permanent)
    .bind(values.medium.as_str())
    .bind(values.connector.map(Connector::name))
    .bind(values.transceiver.map(|t| t.name))
    .bind(&values.fiber_mode)
    .bind(values.sort_order)
    .bind(&values.interface_name)
    .bind(values.speed)
    .bind(&values.poe)
    .bind(&values.description)
    .bind(&values.mac)
        .bind(values.wlan_id)
    .bind(values.outlet_group)
    .bind(&values.notes)
    .bind(now_ts())
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(d) if d.is_unique_violation() => {
            AppError::Conflict(format!("Port {code} already exists on this device"))
        }
        _ => e.into(),
    })?;
    hierarchy::reindex(&mut tx, Subtree::Port(id)).await?;
    let new = load_port(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "port", Some(id))
            .path(new.path.clone())
            .project(Some(project_id))
            .changes(audit::diff(&old.audit_view(), &new.audit_view(), &[])),
    )
    .await?;
    tx.commit().await?;
    let mut v = new.to_json();
    v["warnings"] = json!(warnings);
    Ok(Json(v))
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let port = load_port(&mut tx, id).await?;
    device_for_ports(&mut tx, &current, port.device_id).await?;
    let cut: Vec<i64> =
        sqlx::query_scalar("SELECT connection_id FROM connection_ends WHERE port_id = ?")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let mut removed = Vec::new();
    for c in cut {
        removed.push(cabling::describe(&mut tx, c).await?);
    }
    sqlx::query("DELETE FROM ports WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    hierarchy::reindex(&mut tx, Subtree::Port(id)).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "port", Some(id))
            .path(port.path.clone())
            .project(Some(port.project_id))
            .changes(json!({ "cables_removed": removed })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- tracing

#[derive(FromRow)]
struct CableDetail {
    id: i64,
    kind: String,
    cable_type: Option<String>,
    length_m: Option<f64>,
    color: Option<String>,
    label: Option<String>,
}

/// The whole chain through a port, in order, with its state and warnings
/// about cables or ends that probably don't work together.
pub async fn trace(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let port = load_port(&mut conn, id).await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Device, port.device_id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let g = cabling::component(&mut conn, id).await?;
    let t = crate::domain::cabling::trace(&g, id);
    Ok(Json(trace_json(&mut conn, &t).await?))
}

pub async fn trace_json(
    conn: &mut SqliteConnection,
    t: &crate::domain::cabling::Trace,
) -> AppResult<Value> {
    let port_ids: Vec<i64> = t.ports().collect();
    let cable_ids: Vec<i64> = t.connections().map(|c| c.0).collect();
    let mut q = QueryBuilder::new(concat!(port_select!(), "WHERE o.id IN ("));
    push_ids(&mut q, &port_ids);
    let ports: HashMap<i64, PortRow> = q
        .build_query_as::<PortRow>()
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .map(|p| (p.id, p))
        .collect();
    let mut cables: HashMap<i64, CableDetail> = HashMap::new();
    if !cable_ids.is_empty() {
        let mut q = QueryBuilder::new(
            "SELECT id, kind, cable_type, length_m, color, label FROM connections WHERE id IN (",
        );
        push_ids(&mut q, &cable_ids);
        cables = q
            .build_query_as::<CableDetail>()
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .map(|c| (c.id, c))
            .collect();
    }

    // Expected link speed: the slower of the active ends that are known.
    let (a, b) = t.ends;
    let end_speeds: Vec<u32> = [a, b]
        .iter()
        .filter_map(|p| ports.get(p))
        .filter(|p| p.role() == Role::Active)
        .filter_map(|p| p.media(Side::Front).speed())
        .collect();
    let link_speed = end_speeds.iter().min().copied();

    let mut warnings: Vec<String> = Vec::new();
    let mut hops = Vec::with_capacity(t.steps.len());
    let mut total_length = 0.0;
    let mut lengths_known = true;
    for (i, step) in t.steps.iter().enumerate() {
        match step {
            Step::Port {
                port_id,
                enter,
                exit,
            } => {
                let p = ports.get(port_id);
                hops.push(json!({
                    "type": "port", "id": port_id, "path": p.map(|p| p.path.clone()),
                    "device_id": p.map(|p| p.device_id), "role": p.map(|p| p.role.clone()),
                    "connector": p.and_then(|p| p.connector.clone()),
                    "transceiver": p.and_then(|p| p.transceiver.clone()),
                    "enter": enter.map(Side::as_str), "exit": exit.map(Side::as_str),
                }));
            }
            Step::Cable { connection_id, .. } => {
                let c = cables.get(connection_id);
                match c.and_then(|c| c.length_m) {
                    Some(l) => total_length += l,
                    None => lengths_known = false,
                }
                hops.push(json!({
                    "type": "cable", "id": connection_id, "kind": c.map(|c| c.kind.clone()),
                    "cable_type": c.and_then(|c| c.cable_type.clone()), "length_m": c.and_then(|c| c.length_m),
                    "color": c.and_then(|c| c.color.clone()), "label": c.and_then(|c| c.label.clone()),
                }));
                // The ports either side of this cable and the sides used.
                let before = match t.steps.get(i.wrapping_sub(1)) {
                    Some(Step::Port { port_id, exit, .. }) => {
                        Some((*port_id, exit.unwrap_or(Side::Front)))
                    }
                    _ => None,
                };
                let after = match t.steps.get(i + 1) {
                    Some(Step::Port { port_id, enter, .. }) => {
                        Some((*port_id, enter.unwrap_or(Side::Front)))
                    }
                    _ => None,
                };
                if let (Some((pa, sa)), Some((pb, sb)), Some(c)) = (before, after, c) {
                    if let (Some(x), Some(y)) = (ports.get(&pa), ports.get(&pb)) {
                        let cable = c.cable_type.as_deref().and_then(CableType::parse);
                        if let Ok(v) = media::check_cable(
                            &x.media(sa),
                            &y.media(sb),
                            cable,
                            c.length_m,
                            link_speed,
                        ) {
                            warnings.extend(v.warnings);
                        }
                    }
                }
            }
        }
    }
    // The two ends of a complete chain must work together.
    if t.state == ChainState::Complete && a != b {
        if let (Some(x), Some(y)) = (ports.get(&a), ports.get(&b)) {
            match media::check_cable(
                &x.media(Side::Front),
                &y.media(Side::Front),
                None,
                None,
                None,
            ) {
                Ok(v) => warnings.extend(v.warnings),
                Err(e) => warnings.push(format!("The two ends don't match: {e}")),
            }
        }
    }
    let mut seen = HashSet::new();
    warnings.retain(|w| seen.insert(w.clone()));
    Ok(json!({
        "state": t.state.as_str(),
        "truncated": t.truncated,
        "ends": [a, b],
        "total_length_m": if lengths_known && !cable_ids.is_empty() { Some(total_length) } else { None },
        "hops": hops,
        "warnings": warnings,
    }))
}

// ---------------------------------------------------------------- colour

#[derive(Deserialize)]
pub struct ChainColor {
    color: Option<String>,
}

pub fn check_color(color: Option<String>) -> AppResult<Option<String>> {
    match color.map(|c| c.trim().to_ascii_lowercase()) {
        None => Ok(None),
        Some(c) if c.is_empty() => Ok(None),
        Some(c)
            if c.len() == 7
                && c.starts_with('#')
                && c[1..].chars().all(|x| x.is_ascii_hexdigit()) =>
        {
            Ok(Some(c))
        }
        Some(_) => Err(AppError::bad("color must look like #1e90ff")),
    }
}

/// Sets the colour of every patch cable in the chain through a port.
/// Permanent cabling keeps its own colour.
pub async fn chain_color(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<ChainColor>,
) -> AppResult<Json<Value>> {
    let color = check_color(body.color)?;
    let mut tx = state.pool.begin().await?;
    let port = load_port(&mut tx, id).await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Device, port.device_id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let g = cabling::component(&mut tx, id).await?;
    let t = crate::domain::cabling::trace(&g, id);
    let patches: Vec<i64> = t
        .connections()
        .filter(|(_, k)| *k == crate::domain::cabling::Kind::Patch)
        .map(|(c, _)| c)
        .collect();
    for c in &patches {
        super::connections::require_edit(&mut tx, &current, *c).await?;
    }
    for c in &patches {
        sqlx::query("UPDATE connections SET color = ?, updated_at = ? WHERE id = ?")
            .bind(&color)
            .bind(now_ts())
            .bind(c)
            .execute(&mut *tx)
            .await?;
    }
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "port", Some(id))
            .path(port.path.clone())
            .project(Some(port.project_id))
            .changes(json!({ "chain_color": color, "connections": patches })),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "color": color, "connections": patches })))
}

// ---------------------------------------------------------------- VLANs

#[derive(Deserialize)]
pub struct PortVlans {
    untagged: Option<i64>,
    #[serde(default)]
    tagged: Vec<i64>,
}

/// Replaces a port's VLANs (ids of the project's VLANs).
pub async fn set_vlans(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<PortVlans>,
) -> AppResult<Json<Value>> {
    let mut tagged = body.tagged.clone();
    tagged.sort_unstable();
    tagged.dedup();
    if tagged.len() > 4094 {
        return Err(AppError::bad("Too many VLANs"));
    }
    if body.untagged.is_some_and(|u| tagged.contains(&u)) {
        return Err(AppError::bad(
            "A VLAN can't be both untagged and tagged on the same port",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let port = load_port(&mut tx, id).await?;
    device_for_ports(&mut tx, &current, port.device_id).await?;
    let wanted: Vec<i64> = body
        .untagged
        .into_iter()
        .chain(tagged.iter().copied())
        .collect();
    let mut vids: HashMap<i64, i64> = HashMap::new();
    for chunk in wanted.chunks(5000) {
        let mut q = QueryBuilder::new("SELECT id, vid FROM vlans WHERE project_id = ");
        q.push_bind(port.project_id).push(" AND id IN (");
        push_ids(&mut q, chunk);
        let found: Vec<(i64, i64)> = q.build_query_as().fetch_all(&mut *tx).await?;
        vids.extend(found);
    }
    if vids.len() != wanted.len() {
        return Err(AppError::bad("VLAN not found in this project"));
    }
    let before: Vec<(i64, String)> = sqlx::query_as(
        "SELECT v.vid, pv.mode FROM port_vlans pv JOIN vlans v ON v.id = pv.vlan_id WHERE pv.port_id = ? ORDER BY v.vid",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM port_vlans WHERE port_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for (vlan, mode) in body
        .untagged
        .map(|u| (u, "untagged"))
        .into_iter()
        .chain(tagged.iter().map(|t| (*t, "tagged")))
    {
        sqlx::query("INSERT INTO port_vlans (port_id, vlan_id, mode) VALUES (?, ?, ?)")
            .bind(id)
            .bind(vlan)
            .bind(mode)
            .execute(&mut *tx)
            .await?;
    }
    let untagged_vid = body.untagged.and_then(|u| vids.get(&u).copied());
    let mut tagged_vids: Vec<i64> = tagged.iter().filter_map(|t| vids.get(t).copied()).collect();
    tagged_vids.sort_unstable();
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "port", Some(id))
            .path(port.path.clone())
            .project(Some(port.project_id))
            .changes(json!({
                "vlans_before": before.iter().map(|(v, m)| format!("{v}{}", if m == "tagged" { "t" } else { "u" })).collect::<Vec<_>>(),
                "untagged": untagged_vid, "tagged": tagged_vids,
            })),
    )
    .await?;
    let listed = with_details(&mut tx, vec![port]).await?;
    tx.commit().await?;
    Ok(Json(json!({ "vlans": listed[0].vlans })))
}
