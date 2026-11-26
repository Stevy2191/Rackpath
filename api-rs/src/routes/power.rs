//! Power (design section 8): each device's power figures, and the rack power
//! summary computed from the power cords (outlet → inlet `power`
//! connections) and the UPS ↔ battery module links.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, SqliteConnection};

use super::{require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::media::{Connector, PlugFamily};
use crate::domain::permissions::{Action, ScopeType};
use crate::domain::power::{self, Feed, Graph};
use crate::error::{AppError, AppResult};
use crate::hierarchy;
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct CurvePoint {
    pub load_w: f64,
    pub minutes: f64,
}

/// Power figures of a device or template. All optional.
#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct PowerSpec {
    #[serde(default)]
    pub input_voltage: Option<String>,
    #[serde(default)]
    pub capacity_va: Option<i64>,
    #[serde(default)]
    pub capacity_w: Option<i64>,
    /// Typical draw in watts, used for load figures.
    #[serde(default)]
    pub typical_w: Option<i64>,
    /// Nameplate maximum, used when the typical draw isn't recorded.
    #[serde(default)]
    pub max_w: Option<i64>,
    /// UPS: minutes of runtime at a given load.
    #[serde(default)]
    pub runtime_curve: Option<Vec<CurvePoint>>,
    /// Battery module: minutes it adds at a given load.
    #[serde(default)]
    pub ebm_runtime_curve: Option<Vec<CurvePoint>>,
    #[serde(default)]
    pub max_ebm_slots: Option<i64>,
}

fn curve_text(c: &Option<Vec<CurvePoint>>) -> Option<String> {
    c.as_ref()
        .filter(|c| !c.is_empty())
        .map(|c| serde_json::to_string(c).unwrap_or_default())
}

fn curve_from(s: Option<String>) -> Option<Vec<CurvePoint>> {
    s.and_then(|s| serde_json::from_str(&s).ok())
}

pub fn points(c: &Option<Vec<CurvePoint>>) -> Vec<(f64, f64)> {
    c.as_ref()
        .map(|c| c.iter().map(|p| (p.load_w, p.minutes)).collect())
        .unwrap_or_default()
}

impl PowerSpec {
    pub fn validate(&mut self) -> AppResult<()> {
        self.input_voltage = self
            .input_voltage
            .take()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        if self.input_voltage.as_ref().is_some_and(|v| v.len() > 40) {
            return Err(AppError::bad("input_voltage is at most 40 characters"));
        }
        for (name, v, max) in [
            ("capacity_va", self.capacity_va, 10_000_000),
            ("capacity_w", self.capacity_w, 10_000_000),
            ("typical_w", self.typical_w, 10_000_000),
            ("max_w", self.max_w, 10_000_000),
            ("max_ebm_slots", self.max_ebm_slots, 100),
        ] {
            if v.is_some_and(|v| v < 0 || v > max) {
                return Err(AppError::bad(format!("{name} must be between 0 and {max}")));
            }
        }
        for (name, c) in [
            ("runtime_curve", &self.runtime_curve),
            ("ebm_runtime_curve", &self.ebm_runtime_curve),
        ] {
            if let Some(c) = c {
                if c.len() > 50 {
                    return Err(AppError::bad(format!("{name} has at most 50 points")));
                }
                if c.iter().any(|p| {
                    !p.load_w.is_finite()
                        || !p.minutes.is_finite()
                        || p.load_w < 0.0
                        || p.minutes < 0.0
                }) {
                    return Err(AppError::bad(format!(
                        "{name} points need a load_w and minutes of zero or more"
                    )));
                }
            }
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        *self == PowerSpec::default()
            || (self.input_voltage.is_none()
                && self.capacity_va.is_none()
                && self.capacity_w.is_none()
                && self.typical_w.is_none()
                && self.max_w.is_none()
                && self.runtime_curve.as_ref().is_none_or(Vec::is_empty)
                && self.ebm_runtime_curve.as_ref().is_none_or(Vec::is_empty)
                && self.max_ebm_slots.is_none())
    }

    /// The draw used in load sums.
    pub fn draw_w(&self) -> Option<f64> {
        self.typical_w.or(self.max_w).map(|w| w as f64)
    }
}

#[derive(FromRow)]
pub struct PowerRow {
    pub input_voltage: Option<String>,
    pub capacity_va: Option<i64>,
    pub capacity_w: Option<i64>,
    pub typical_w: Option<i64>,
    pub max_w: Option<i64>,
    pub runtime_curve: Option<String>,
    pub ebm_runtime_curve: Option<String>,
    pub max_ebm_slots: Option<i64>,
}

impl From<PowerRow> for PowerSpec {
    fn from(r: PowerRow) -> Self {
        PowerSpec {
            input_voltage: r.input_voltage,
            capacity_va: r.capacity_va,
            capacity_w: r.capacity_w,
            typical_w: r.typical_w,
            max_w: r.max_w,
            runtime_curve: curve_from(r.runtime_curve),
            ebm_runtime_curve: curve_from(r.ebm_runtime_curve),
            max_ebm_slots: r.max_ebm_slots,
        }
    }
}

pub async fn load_device_power(
    conn: &mut SqliteConnection,
    device_id: i64,
) -> AppResult<Option<PowerSpec>> {
    Ok(sqlx::query_as::<_, PowerRow>(
        "SELECT input_voltage, capacity_va, capacity_w, typical_w, max_w, runtime_curve, ebm_runtime_curve, max_ebm_slots
         FROM device_power WHERE device_id = ?",
    )
    .bind(device_id)
    .fetch_optional(conn)
    .await?
    .map(PowerSpec::from))
}

/// Replaces a device's power figures (removes the row when all are empty).
pub async fn save_device_power(
    conn: &mut SqliteConnection,
    device_id: i64,
    p: &PowerSpec,
) -> AppResult<()> {
    if p.is_empty() {
        sqlx::query("DELETE FROM device_power WHERE device_id = ?")
            .bind(device_id)
            .execute(conn)
            .await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO device_power (device_id, input_voltage, capacity_va, capacity_w, typical_w, max_w, runtime_curve,
         ebm_runtime_curve, max_ebm_slots, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET input_voltage = excluded.input_voltage, capacity_va = excluded.capacity_va,
         capacity_w = excluded.capacity_w, typical_w = excluded.typical_w, max_w = excluded.max_w,
         runtime_curve = excluded.runtime_curve, ebm_runtime_curve = excluded.ebm_runtime_curve,
         max_ebm_slots = excluded.max_ebm_slots, updated_at = excluded.updated_at",
    )
    .bind(device_id)
    .bind(&p.input_voltage)
    .bind(p.capacity_va)
    .bind(p.capacity_w)
    .bind(p.typical_w)
    .bind(p.max_w)
    .bind(curve_text(&p.runtime_curve))
    .bind(curve_text(&p.ebm_runtime_curve))
    .bind(p.max_ebm_slots)
    .bind(now_ts())
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn put_device_power(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(mut body): JsonBody<PowerSpec>,
) -> AppResult<Json<PowerSpec>> {
    body.validate()?;
    let mut tx = state.pool.begin().await?;
    let placed = hierarchy::get(&mut tx, ScopeType::Device, id).await?;
    require(&current, Action::Write, &placed.chain)?;
    let old = load_device_power(&mut tx, id).await?.unwrap_or_default();
    save_device_power(&mut tx, id, &body).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "device", Some(id))
            .path(placed.path.clone())
            .project(Some(placed.project_id))
            .changes(json!({ "power": audit::diff(&json!(old), &json!(body), &[]) })),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(body))
}

// ---------------------------------------------------------------- summary

/// Everything the power maths needs about a project.
struct ProjectPower {
    specs: HashMap<i64, PowerSpec>,
    graph: Graph,
    /// UPS device -> battery module devices.
    batteries: HashMap<i64, Vec<i64>>,
    /// device -> (outlets by group, connected outlets, inlets, connected inlets)
    ports: HashMap<i64, PortCounts>,
}

#[derive(Default, Clone)]
struct PortCounts {
    outlets: usize,
    outlets_used: usize,
    by_group: HashMap<i64, (usize, usize)>,
    inlets: usize,
    inlets_used: usize,
}

async fn load_project(conn: &mut SqliteConnection, project_id: i64) -> AppResult<ProjectPower> {
    #[derive(FromRow)]
    struct Row {
        device_id: i64,
        #[sqlx(flatten)]
        power: PowerRow,
    }
    let rows = sqlx::query_as::<_, Row>(
        "SELECT p.device_id, p.input_voltage, p.capacity_va, p.capacity_w, p.typical_w, p.max_w, p.runtime_curve,
                p.ebm_runtime_curve, p.max_ebm_slots
         FROM device_power p JOIN devices d ON d.id = p.device_id WHERE d.project_id = ?",
    )
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    let specs: HashMap<i64, PowerSpec> = rows
        .into_iter()
        .map(|r| (r.device_id, PowerSpec::from(r.power)))
        .collect();

    // Power ports with whether something is plugged in.
    let ports: Vec<(i64, Option<String>, Option<i64>, bool)> = sqlx::query_as(
        "SELECT o.device_id, o.connector, o.outlet_group,
                EXISTS (SELECT 1 FROM connection_ends e WHERE e.port_id = o.id)
         FROM ports o JOIN devices d ON d.id = o.device_id
         WHERE d.project_id = ? AND o.medium = 'power'",
    )
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut counts: HashMap<i64, PortCounts> = HashMap::new();
    for (device, connector, group, used) in ports {
        let Some(Connector::Power(plug)) = connector.as_deref().and_then(Connector::parse) else {
            continue;
        };
        if matches!(plug.family, PlugFamily::Battery | PlugFamily::Dc) {
            continue;
        }
        let c = counts.entry(device).or_default();
        if plug.outlet {
            c.outlets += 1;
            c.outlets_used += usize::from(used);
            let g = c.by_group.entry(group.unwrap_or(0)).or_default();
            g.0 += 1;
            g.1 += usize::from(used);
        } else {
            c.inlets += 1;
            c.inlets_used += usize::from(used);
        }
    }

    // Power cords: which end is the outlet.
    #[derive(FromRow)]
    struct Cord {
        id: i64,
        da: i64,
        ca: Option<String>,
        db: i64,
        cb: Option<String>,
    }
    let cords = sqlx::query_as::<_, Cord>(
        "SELECT c.id, pa.device_id AS da, pa.connector AS ca, pb.device_id AS db, pb.connector AS cb FROM connections c
         JOIN connection_ends ea ON ea.connection_id = c.id AND ea.endpoint = 'a'
         JOIN connection_ends eb ON eb.connection_id = c.id AND eb.endpoint = 'b'
         JOIN ports pa ON pa.id = ea.port_id
         JOIN ports pb ON pb.id = eb.port_id
         WHERE c.project_id = ? AND c.kind = 'power'",
    )
    .bind(project_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut graph = Graph::default();
    let mut batteries: HashMap<i64, Vec<i64>> = HashMap::new();
    for Cord {
        id: cid,
        da,
        ca,
        db,
        cb,
    } in cords
    {
        let pa = ca.as_deref().and_then(Connector::parse);
        let pb = cb.as_deref().and_then(Connector::parse);
        match (pa, pb) {
            (Some(Connector::Power(x)), Some(Connector::Power(y))) => {
                if x.family == PlugFamily::Battery {
                    // The UPS is the end with a runtime curve.
                    let ups_a = specs.get(&da).is_some_and(|s| s.runtime_curve.is_some());
                    let (ups, ebm) = if ups_a { (da, db) } else { (db, da) };
                    batteries.entry(ups).or_default().push(ebm);
                } else if x.family != PlugFamily::Dc && x.outlet != y.outlet {
                    let (source, load) = if x.outlet { (da, db) } else { (db, da) };
                    graph.feeds.push(Feed {
                        connection_id: cid,
                        source_device: source,
                        load_device: load,
                    });
                }
            }
            _ => continue,
        }
    }
    let mut devices: HashSet<i64> = specs.keys().copied().collect();
    devices.extend(counts.keys().copied());
    for d in devices {
        graph
            .draw
            .insert(d, specs.get(&d).and_then(PowerSpec::draw_w));
    }
    Ok(ProjectPower {
        specs,
        graph,
        batteries,
        ports: counts,
    })
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn pct(load: f64, capacity: Option<i64>) -> Option<f64> {
    capacity
        .filter(|c| *c > 0)
        .map(|c| round1(load * 100.0 / c as f64))
}

/// One device's power picture.
fn device_entry(pp: &ProjectPower, loads: &power::Loads, id: i64, code: &str, path: &str) -> Value {
    let spec = pp.specs.get(&id).cloned().unwrap_or_default();
    let load = loads.by_device.get(&id).copied().unwrap_or_default();
    let counts = pp.ports.get(&id).cloned().unwrap_or_default();
    let ebms = pp.batteries.get(&id).cloned().unwrap_or_default();
    let ebm_curves: Vec<Vec<(f64, f64)>> = ebms
        .iter()
        .filter_map(|e| pp.specs.get(e))
        .map(|s| points(&s.ebm_runtime_curve))
        .collect();
    let curve = points(&spec.runtime_curve);
    let mut warnings = Vec::new();
    if let Some(p) = pct(load.output_w, spec.capacity_w) {
        if p > 100.0 {
            warnings.push(format!(
                "Overloaded: {p}% of its {} W",
                spec.capacity_w.unwrap_or(0)
            ));
        } else if p > 80.0 {
            warnings.push(format!("Above 80% of capacity ({p}%)"));
        }
    }
    if let Some(p) = pct(load.failover_w, spec.capacity_w) {
        if p > 100.0 && load.failover_w > load.output_w {
            warnings.push(format!(
                "Can't carry its redundant loads alone: {p}% if the other feed fails"
            ));
        }
    }
    if counts.inlets > 0 && counts.inlets_used == 0 {
        warnings.push("No power cord on any inlet".into());
    } else if counts.inlets > 1 && counts.inlets_used == 1 {
        warnings.push("Only one of its power inlets is connected".into());
    }
    if let Some(max) = spec.max_ebm_slots {
        if ebms.len() as i64 > max {
            warnings.push(format!(
                "{} battery modules connected; it supports {max}",
                ebms.len()
            ));
        }
    }
    if loads.unknown_draw.contains(&id) {
        warnings.push("Its power draw isn't recorded".into());
    }
    let mut groups: Vec<(i64, (usize, usize))> = counts.by_group.into_iter().collect();
    groups.sort_unstable();
    json!({
        "device_id": id, "code": code, "path": path, "power": spec,
        "draw_w": spec.draw_w(),
        "demand_w": round1(load.demand_w),
        "output_w": round1(load.output_w),
        "failover_w": round1(load.failover_w),
        "load_pct": pct(load.output_w, spec.capacity_w),
        "failover_pct": pct(load.failover_w, spec.capacity_w),
        "runtime_min": power::runtime(&curve, &ebm_curves, load.output_w).map(round1),
        "failover_runtime_min": power::runtime(&curve, &ebm_curves, load.failover_w).map(round1),
        "battery_modules": ebms,
        "outlets": { "total": counts.outlets, "used": counts.outlets_used,
                     "groups": groups.iter().map(|(g, (t, u))| json!({ "group": if *g == 0 { None } else { Some(*g) }, "total": t, "used": u })).collect::<Vec<_>>() },
        "inlets": { "total": counts.inlets, "used": counts.inlets_used },
        "warnings": warnings,
    })
}

/// Power picture of a rack: every device in it (including on trays) with
/// its draw, the load on its outlets, failover load, UPS runtime, outlet
/// use and warnings, plus rack totals. Feeds from other racks count.
pub async fn rack_power(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(rack_id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Rack, rack_id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let devices: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT s.ref_id, d.code, s.path FROM search_entries s JOIN devices d ON d.id = s.ref_id
         WHERE s.kind = 'device' AND s.rack_id = ? ORDER BY s.path",
    )
    .bind(rack_id)
    .fetch_all(&mut *conn)
    .await?;
    let pp = load_project(&mut conn, placed.project_id).await?;
    let loads = power::loads(&pp.graph);
    let entries: Vec<Value> = devices
        .iter()
        .filter(|(id, _, _)| pp.specs.contains_key(id) || pp.ports.contains_key(id))
        .map(|(id, code, path)| device_entry(&pp, &loads, *id, code, path))
        .collect();

    // UPS totals, as v1 showed them: total, and what's left if the largest
    // unit fails (N+1).
    let ups: Vec<&PowerSpec> = devices
        .iter()
        .filter_map(|(id, _, _)| pp.specs.get(id))
        .filter(|s| s.runtime_curve.is_some())
        .collect();
    let total_va: i64 = ups.iter().filter_map(|s| s.capacity_va).sum();
    let total_w: i64 = ups.iter().filter_map(|s| s.capacity_w).sum();
    let largest = ups.iter().max_by_key(|s| s.capacity_va.unwrap_or(0));
    let draw: f64 = devices
        .iter()
        .filter_map(|(id, _, _)| pp.specs.get(id).and_then(PowerSpec::draw_w))
        .sum();
    Ok(Json(json!({
        "rack_id": rack_id,
        "devices": entries,
        "totals": {
            "draw_w": round1(draw),
            "ups_count": ups.len(),
            "ups_capacity_va": total_va,
            "ups_capacity_w": total_w,
            "ups_redundant_va": largest.map(|l| total_va - l.capacity_va.unwrap_or(0)),
            "ups_redundant_w": largest.map(|l| total_w - l.capacity_w.unwrap_or(0)),
        },
        "loop_detected": loads.loop_detected,
    })))
}

/// The power picture of one device.
pub async fn device_power(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let placed = hierarchy::get(&mut conn, ScopeType::Device, id).await?;
    require(&current, Action::Read, &placed.chain)?;
    let code: String = sqlx::query_scalar("SELECT code FROM devices WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
    let pp = load_project(&mut conn, placed.project_id).await?;
    let loads = power::loads(&pp.graph);
    Ok(Json(device_entry(&pp, &loads, id, &code, &placed.path)))
}
