//! Device templates (design section 7): a library of device designs —
//! height, power figures and port groups on a faceplate grid — that
//! devices are made from.
//!
//! * **Built-ins** ship with Rackpath (project NULL) and can't be edited;
//!   duplicate one into a project to customise it.
//! * **Saving** replaces the whole template (`PUT`). Devices made from it
//!   are brought in line in the same transaction:
//!   - ports are matched by code; ports that still exist keep their cables,
//!     VLANs and addresses, and only their template attributes change;
//!   - ports that disappear are deleted (their cables with them);
//!   - a cable that no longer fits a changed port is removed;
//!   - a device that no longer fits its rack moves to Unplaced.
//! * `?dry_run=true` reports all of that without changing anything. When a
//!   save would remove ports or cables or unplace devices, it needs
//!   `"confirm_name"` equal to the template's name.
//!
//! Templates belong to the project library: editing them needs edit rights
//! on the whole project; reading is project-wide.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, SqliteConnection};

use super::places::{check_len, clean_text};
use super::ports::{cables_on, insert_port, resolve_values, PluggedCable, PortValues};
use super::power::{load_device_power, save_device_power, CurvePoint, PowerSpec};
use super::racks::rack_slots;
use super::{require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::cabling;
use crate::domain::cabling::{Role, Side};
use crate::domain::device_types::validate_key;
use crate::domain::media::{self, CableType, Connector, PortMedia};
use crate::domain::permissions::{Action, Chain};
use crate::domain::rack::{check_fit, height_to_half, Face as RackFace, Mount, Slot};
use crate::domain::templates::{self as tpl, grid_for, Face, Generated, Group, Numbering};
use crate::error::{AppError, AppResult};
use crate::hierarchy::{self, Subtree};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

// ---------------------------------------------------------------- shapes

#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(deny_unknown_fields)]
pub struct GroupIn {
    #[serde(default = "front")]
    pub face: String,
    pub grid_row: u16,
    pub grid_col: u16,
    pub rows: u16,
    pub cols: u16,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub numbering: Option<String>,
    #[serde(default)]
    pub start: Option<u32>,
    #[serde(default)]
    pub connector: Option<String>,
    #[serde(default)]
    pub medium: Option<String>,
    #[serde(default)]
    pub transceiver: Option<String>,
    #[serde(default)]
    pub fiber_mode: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub requires_permanent: Option<bool>,
    #[serde(default)]
    pub speed: Option<i64>,
    #[serde(default)]
    pub poe: Option<String>,
    #[serde(default)]
    pub outlet_group: Option<i64>,
    #[serde(default)]
    pub description: Option<String>,
}

fn front() -> String {
    "front".into()
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct OverrideIn {
    pub port_index: usize,
    pub code: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ElementIn {
    #[serde(default = "front")]
    pub face: String,
    pub kind: String,
    pub grid_row: u16,
    pub grid_col: u16,
    #[serde(default = "one")]
    pub rows: u16,
    #[serde(default = "one")]
    pub cols: u16,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub align: Option<String>,
    #[serde(default)]
    pub highlighted: bool,
    #[serde(default)]
    pub icon: Option<String>,
}

fn one() -> u16 {
    1
}

/// A whole template as sent and returned. Saving replaces everything.
#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(deny_unknown_fields)]
pub struct TemplateIn {
    pub name: String,
    pub device_type: String,
    #[serde(default)]
    pub manufacturer: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// U; 0 = zero-U; null = not rack-mounted.
    #[serde(default)]
    pub u_height: Option<f64>,
    #[serde(default)]
    pub depth: Option<String>,
    #[serde(default)]
    pub half_width: bool,
    #[serde(default)]
    pub power: Option<PowerSpec>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub port_groups: Vec<GroupIn>,
    #[serde(default)]
    pub port_overrides: Vec<OverrideIn>,
    #[serde(default)]
    pub elements: Vec<ElementIn>,
}

/// A validated template, ready to save or build devices from.
pub struct Prepared {
    pub t: TemplateIn,
    pub u_half: Option<i64>,
    pub groups: Vec<Group>,
    pub values: Vec<PortValues>,
    pub ports: Vec<Generated>,
    pub power: PowerSpec,
}

fn group_fields(g: &GroupIn) -> AppResult<super::ports::PortFields> {
    let mut v = json!({
        "connector": g.connector, "transceiver": g.transceiver, "fiber_mode": g.fiber_mode,
        "speed": g.speed, "poe": g.poe, "outlet_group": g.outlet_group,
    });
    for (k, val) in [
        ("medium", g.medium.as_ref().map(|x| json!(x))),
        ("role", g.role.as_ref().map(|x| json!(x))),
        ("requires_permanent", g.requires_permanent.map(|x| json!(x))),
        ("description", g.description.as_ref().map(|x| json!(x))),
        ("face", Some(json!(g.face))),
    ] {
        if let Some(val) = val {
            v[k] = val;
        }
    }
    // A group without a connector gets the type's default, as ports do.
    if g.connector.is_none() {
        if let Some(o) = v.as_object_mut() {
            o.remove("connector");
        }
    }
    serde_json::from_value(v).map_err(|e| AppError::bad(e.to_string()))
}

/// Validates a template. `project_id` None for built-ins.
pub async fn prepare(
    conn: &mut SqliteConnection,
    project_id: Option<i64>,
    mut t: TemplateIn,
) -> AppResult<Prepared> {
    t.name = t.name.trim().to_string();
    if t.name.is_empty() || t.name.chars().count() > 80 {
        return Err(AppError::bad("name must be 1 to 80 characters"));
    }
    t.device_type = validate_key(&t.device_type).map_err(AppError::bad)?;
    if let Some(p) = project_id {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT id FROM device_types WHERE project_id = ? AND key = ?")
                .bind(p)
                .bind(&t.device_type)
                .fetch_optional(&mut *conn)
                .await?;
        found.ok_or_else(|| AppError::bad("device_type isn't a device type of this project"))?;
    }
    t.manufacturer = clean_text(t.manufacturer.take());
    t.model = clean_text(t.model.take());
    t.notes = clean_text(t.notes.take());
    check_len("manufacturer", &t.manufacturer, 100)?;
    check_len("model", &t.model, 100)?;
    let u_half = match t.u_height {
        None => None,
        Some(0.0) => Some(0),
        Some(h) => Some(height_to_half(h).map_err(AppError::bad)?),
    };
    if t.depth
        .as_deref()
        .is_some_and(|d| d != "half" && d != "full")
    {
        return Err(AppError::bad("depth must be half or full"));
    }
    let mut power = t.power.clone().unwrap_or_default();
    power.validate()?;
    t.power = if power.is_empty() {
        None
    } else {
        Some(power.clone())
    };

    let grid = grid_for(u_half);
    let mut groups = Vec::with_capacity(t.port_groups.len());
    let mut values = Vec::with_capacity(t.port_groups.len());
    if t.port_groups.len() > 64 {
        return Err(AppError::bad("At most 64 port groups"));
    }
    for (i, g) in t.port_groups.iter_mut().enumerate() {
        let n = i + 1;
        let face = Face::parse(&g.face)
            .ok_or_else(|| AppError::bad(format!("Group {n}: face must be front or rear")))?;
        let numbering = match g.numbering.as_deref() {
            None => Numbering::ColumnMajor,
            Some(s) => Numbering::parse(s).ok_or_else(|| {
                AppError::bad(format!(
                    "Group {n}: numbering must be column_major or row_major"
                ))
            })?,
        };
        g.prefix = tpl::normalize_prefix(&g.prefix)
            .map_err(|e| AppError::bad(format!("Group {n}: {e}")))?;
        g.description = clean_text(g.description.take());
        let fields = group_fields(g)?;
        let v = resolve_values(conn, project_id.unwrap_or(0), fields, None, &t.device_type)
            .await
            .map_err(|e| match e {
                AppError::BadRequest(m) => AppError::bad(format!("Group {n}: {m}")),
                other => other,
            })?;
        groups.push(Group {
            face,
            grid_row: g.grid_row,
            grid_col: g.grid_col,
            rows: g.rows,
            cols: g.cols,
            prefix: g.prefix.clone(),
            numbering,
            start: g.start.unwrap_or(1),
        });
        values.push(v);
    }
    let overrides: Vec<(usize, String)> = t
        .port_overrides
        .iter()
        .map(|o| (o.port_index, o.code.clone()))
        .collect();
    let ports = tpl::generate(&groups, &overrides, grid).map_err(AppError::bad)?;
    for o in &mut t.port_overrides {
        o.code = o.code.trim().to_ascii_uppercase();
    }
    if t.elements.len() > 200 {
        return Err(AppError::bad("At most 200 faceplate elements"));
    }
    for (i, e) in t.elements.iter_mut().enumerate() {
        let n = i + 1;
        if Face::parse(&e.face).is_none() || !["text", "icon"].contains(&e.kind.as_str()) {
            return Err(AppError::bad(format!(
                "Element {n}: face must be front or rear, kind text or icon"
            )));
        }
        if e.rows == 0
            || e.cols == 0
            || e.grid_row + e.rows > grid.rows
            || e.grid_col + e.cols > grid.cols
        {
            return Err(AppError::bad(format!("Element {n} doesn't fit the face")));
        }
        e.text = clean_text(e.text.take());
        if e.text.as_ref().is_some_and(|t| t.chars().count() > 100) {
            return Err(AppError::bad(format!(
                "Element {n}: text is at most 100 characters"
            )));
        }
        if e.align
            .as_deref()
            .is_some_and(|a| !["left", "center", "right"].contains(&a))
        {
            return Err(AppError::bad(format!(
                "Element {n}: align must be left, center or right"
            )));
        }
        if e.icon.as_ref().is_some_and(|i| i.len() > 40) {
            return Err(AppError::bad(format!("Element {n}: icon name is too long")));
        }
    }
    Ok(Prepared {
        t,
        u_half,
        groups,
        values,
        ports,
        power,
    })
}

// ---------------------------------------------------------------- storage

#[derive(FromRow, Clone)]
pub struct TemplateRow {
    pub id: i64,
    pub project_id: Option<i64>,
    pub builtin_key: Option<String>,
    pub name: String,
    pub device_type_key: String,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub u_height_half: Option<i64>,
    pub depth: Option<String>,
    pub half_width: bool,
    pub input_voltage: Option<String>,
    pub capacity_va: Option<i64>,
    pub capacity_w: Option<i64>,
    pub typical_w: Option<i64>,
    pub max_w: Option<i64>,
    pub runtime_curve: Option<String>,
    pub ebm_runtime_curve: Option<String>,
    pub max_ebm_slots: Option<i64>,
    pub notes: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

macro_rules! template_columns {
    () => {
        "id, project_id, builtin_key, name, device_type_key, manufacturer, model, u_height_half, depth, half_width, \
         input_voltage, capacity_va, capacity_w, typical_w, max_w, runtime_curve, ebm_runtime_curve, max_ebm_slots, \
         notes, version, created_at, updated_at"
    };
}

impl TemplateRow {
    fn power(&self) -> PowerSpec {
        PowerSpec::from(super::power::PowerRow {
            input_voltage: self.input_voltage.clone(),
            capacity_va: self.capacity_va,
            capacity_w: self.capacity_w,
            typical_w: self.typical_w,
            max_w: self.max_w,
            runtime_curve: self.runtime_curve.clone(),
            ebm_runtime_curve: self.ebm_runtime_curve.clone(),
            max_ebm_slots: self.max_ebm_slots,
        })
    }
}

pub async fn load_row(conn: &mut SqliteConnection, id: i64) -> AppResult<TemplateRow> {
    sqlx::query_as::<_, TemplateRow>(concat!(
        "SELECT ",
        template_columns!(),
        " FROM device_templates WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

#[derive(FromRow)]
struct GroupRow {
    face: String,
    grid_row: i64,
    grid_col: i64,
    rows: i64,
    cols: i64,
    prefix: String,
    numbering: String,
    start_number: i64,
    medium: Option<String>,
    connector: Option<String>,
    transceiver: Option<String>,
    fiber_mode: Option<String>,
    role: Option<String>,
    requires_permanent: bool,
    speed: Option<i64>,
    poe: Option<String>,
    outlet_group: Option<i64>,
    description: Option<String>,
}

/// The stored template in its input shape (for editing and re-validating).
pub async fn load_input(conn: &mut SqliteConnection, row: &TemplateRow) -> AppResult<TemplateIn> {
    let groups = sqlx::query_as::<_, GroupRow>(
        "SELECT face, grid_row, grid_col, rows, cols, prefix, numbering, start_number, medium, connector, transceiver,
                fiber_mode, role, requires_permanent, speed, poe, outlet_group, description
         FROM template_port_groups WHERE template_id = ? ORDER BY position",
    )
    .bind(row.id)
    .fetch_all(&mut *conn)
    .await?;
    let overrides: Vec<(i64, String)> = sqlx::query_as(
        "SELECT port_index, code FROM template_port_overrides WHERE template_id = ? ORDER BY port_index",
    )
    .bind(row.id)
    .fetch_all(&mut *conn)
    .await?;
    #[allow(clippy::type_complexity)]
    let elements: Vec<(
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        Option<String>,
        Option<String>,
        bool,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT face, kind, grid_row, grid_col, rows, cols, text, align, highlighted, icon
             FROM template_elements WHERE template_id = ? ORDER BY position",
    )
    .bind(row.id)
    .fetch_all(&mut *conn)
    .await?;
    let power = row.power();
    Ok(TemplateIn {
        name: row.name.clone(),
        device_type: row.device_type_key.clone(),
        manufacturer: row.manufacturer.clone(),
        model: row.model.clone(),
        u_height: row.u_height_half.map(|h| h as f64 / 2.0),
        depth: row.depth.clone(),
        half_width: row.half_width,
        power: if power.is_empty() { None } else { Some(power) },
        notes: row.notes.clone(),
        port_groups: groups
            .into_iter()
            .map(|g| GroupIn {
                face: g.face,
                grid_row: g.grid_row as u16,
                grid_col: g.grid_col as u16,
                rows: g.rows as u16,
                cols: g.cols as u16,
                prefix: g.prefix,
                numbering: Some(g.numbering),
                start: Some(g.start_number as u32),
                connector: g.connector,
                medium: g.medium,
                transceiver: g.transceiver,
                fiber_mode: g.fiber_mode,
                role: g.role,
                requires_permanent: Some(g.requires_permanent),
                speed: g.speed,
                poe: g.poe,
                outlet_group: g.outlet_group,
                description: g.description,
            })
            .collect(),
        port_overrides: overrides
            .into_iter()
            .map(|(i, code)| OverrideIn {
                port_index: i as usize,
                code,
            })
            .collect(),
        elements: elements
            .into_iter()
            .map(
                |(face, kind, r, c, rows, cols, text, align, highlighted, icon)| ElementIn {
                    face,
                    kind,
                    grid_row: r as u16,
                    grid_col: c as u16,
                    rows: rows as u16,
                    cols: cols as u16,
                    text,
                    align,
                    highlighted,
                    icon,
                },
            )
            .collect(),
    })
}

/// Loads and validates a stored template.
pub async fn load_prepared(
    conn: &mut SqliteConnection,
    id: i64,
) -> AppResult<(TemplateRow, Prepared)> {
    let row = load_row(conn, id).await?;
    let input = load_input(conn, &row).await?;
    let p = prepare(conn, row.project_id, input).await?;
    Ok((row, p))
}

fn curve_json(c: &Option<Vec<CurvePoint>>) -> Option<String> {
    c.as_ref()
        .filter(|c| !c.is_empty())
        .map(|c| serde_json::to_string(c).unwrap_or_default())
}

/// Writes a template (new when `id` is None) and its groups, overrides
/// and elements. Returns its id.
async fn store(
    conn: &mut SqliteConnection,
    id: Option<i64>,
    project_id: Option<i64>,
    builtin_key: Option<&str>,
    p: &Prepared,
) -> AppResult<i64> {
    let now = now_ts();
    let t = &p.t;
    let id = match id {
        None => sqlx::query(
            "INSERT INTO device_templates (project_id, builtin_key, name, device_type_key, manufacturer, model, u_height_half,
             depth, half_width, input_voltage, capacity_va, capacity_w, typical_w, max_w, runtime_curve, ebm_runtime_curve,
             max_ebm_slots, notes, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(project_id)
        .bind(builtin_key)
        .bind(&t.name)
        .bind(&t.device_type)
        .bind(&t.manufacturer)
        .bind(&t.model)
        .bind(p.u_half)
        .bind(&t.depth)
        .bind(t.half_width)
        .bind(&p.power.input_voltage)
        .bind(p.power.capacity_va)
        .bind(p.power.capacity_w)
        .bind(p.power.typical_w)
        .bind(p.power.max_w)
        .bind(curve_json(&p.power.runtime_curve))
        .bind(curve_json(&p.power.ebm_runtime_curve))
        .bind(p.power.max_ebm_slots)
        .bind(&t.notes)
        .bind(&now)
        .bind(&now)
        .execute(&mut *conn)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.is_unique_violation() => {
                AppError::Conflict(format!("A template named {} already exists", t.name))
            }
            _ => e.into(),
        })?
        .last_insert_rowid(),
        Some(id) => {
            sqlx::query(
                "UPDATE device_templates SET name = ?, device_type_key = ?, manufacturer = ?, model = ?, u_height_half = ?,
                 depth = ?, half_width = ?, input_voltage = ?, capacity_va = ?, capacity_w = ?, typical_w = ?, max_w = ?,
                 runtime_curve = ?, ebm_runtime_curve = ?, max_ebm_slots = ?, notes = ?, version = version + 1,
                 updated_at = ? WHERE id = ?",
            )
            .bind(&t.name)
            .bind(&t.device_type)
            .bind(&t.manufacturer)
            .bind(&t.model)
            .bind(p.u_half)
            .bind(&t.depth)
            .bind(t.half_width)
            .bind(&p.power.input_voltage)
            .bind(p.power.capacity_va)
            .bind(p.power.capacity_w)
            .bind(p.power.typical_w)
            .bind(p.power.max_w)
            .bind(curve_json(&p.power.runtime_curve))
            .bind(curve_json(&p.power.ebm_runtime_curve))
            .bind(p.power.max_ebm_slots)
            .bind(&t.notes)
            .bind(&now)
            .bind(id)
            .execute(&mut *conn)
            .await
            .map_err(|e| match &e {
                sqlx::Error::Database(d) if d.is_unique_violation() => {
                    AppError::Conflict(format!("A template named {} already exists", t.name))
                }
                _ => e.into(),
            })?;
            for table in [
                "DELETE FROM template_port_groups WHERE template_id = ?",
                "DELETE FROM template_port_overrides WHERE template_id = ?",
                "DELETE FROM template_elements WHERE template_id = ?",
            ] {
                sqlx::query(table).bind(id).execute(&mut *conn).await?;
            }
            id
        }
    };
    for (i, g) in t.port_groups.iter().enumerate() {
        let grp = &p.groups[i];
        sqlx::query(
            "INSERT INTO template_port_groups (template_id, position, face, grid_row, grid_col, rows, cols, prefix, numbering,
             start_number, medium, connector, transceiver, fiber_mode, role, requires_permanent, speed, poe, outlet_group,
             description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(i as i64)
        .bind(grp.face.as_str())
        .bind(i64::from(grp.grid_row))
        .bind(i64::from(grp.grid_col))
        .bind(i64::from(grp.rows))
        .bind(i64::from(grp.cols))
        .bind(&grp.prefix)
        .bind(grp.numbering.as_str())
        .bind(i64::from(grp.start))
        .bind(&g.medium)
        .bind(&g.connector)
        .bind(&g.transceiver)
        .bind(&g.fiber_mode)
        .bind(&g.role)
        .bind(g.requires_permanent.unwrap_or(true))
        .bind(g.speed)
        .bind(&g.poe)
        .bind(g.outlet_group)
        .bind(&g.description)
        .execute(&mut *conn)
        .await?;
    }
    for o in &t.port_overrides {
        sqlx::query(
            "INSERT INTO template_port_overrides (template_id, port_index, code) VALUES (?, ?, ?)",
        )
        .bind(id)
        .bind(o.port_index as i64)
        .bind(&o.code)
        .execute(&mut *conn)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.is_primary_key_violation() || d.is_unique_violation() => {
                AppError::bad("Each port can only be renamed once, and to a name not used twice")
            }
            _ => e.into(),
        })?;
    }
    for (i, e) in t.elements.iter().enumerate() {
        sqlx::query(
            "INSERT INTO template_elements (template_id, position, face, kind, grid_row, grid_col, rows, cols, text, align,
             highlighted, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(i as i64)
        .bind(&e.face)
        .bind(&e.kind)
        .bind(i64::from(e.grid_row))
        .bind(i64::from(e.grid_col))
        .bind(i64::from(e.rows))
        .bind(i64::from(e.cols))
        .bind(&e.text)
        .bind(&e.align)
        .bind(e.highlighted)
        .bind(&e.icon)
        .execute(&mut *conn)
        .await?;
    }
    Ok(id)
}

trait PkViolation {
    fn is_primary_key_violation(&self) -> bool;
}

impl PkViolation for Box<dyn sqlx::error::DatabaseError> {
    fn is_primary_key_violation(&self) -> bool {
        self.code().as_deref() == Some("1555")
    }
}

async fn device_count(conn: &mut SqliteConnection, id: i64) -> AppResult<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE template_id = ?")
            .bind(id)
            .fetch_one(conn)
            .await?,
    )
}

fn to_json(row: &TemplateRow, p: &Prepared, devices: i64) -> Value {
    let mut v = serde_json::to_value(&p.t).unwrap_or_default();
    v["id"] = json!(row.id);
    v["project_id"] = json!(row.project_id);
    v["builtin"] = json!(row.builtin_key.is_some());
    v["builtin_key"] = json!(row.builtin_key);
    v["version"] = json!(row.version);
    v["created_at"] = json!(row.created_at);
    v["updated_at"] = json!(row.updated_at);
    v["device_count"] = json!(devices);
    let grid = grid_for(p.u_half);
    v["grid"] = json!({ "rows": grid.rows, "cols": grid.cols });
    v["ports"] = json!(p
        .ports
        .iter()
        .map(|g| json!({ "index": g.index, "code": g.code, "face": g.face.as_str(), "row": g.row, "col": g.col, "group": g.group }))
        .collect::<Vec<_>>());
    v
}

/// Read access: built-ins for anyone signed in; project templates for
/// readers of their project.
fn can_read(current: &CurrentUser, row: &TemplateRow) -> AppResult<()> {
    match row.project_id {
        None => Ok(()),
        Some(p) => require(current, Action::Read, &Chain::project(p)),
    }
}

fn can_edit(current: &CurrentUser, row: &TemplateRow) -> AppResult<i64> {
    match row.project_id {
        None => Err(AppError::bad(
            "Built-in templates can't be changed; duplicate it into your project first",
        )),
        Some(p) => {
            require(current, Action::Write, &Chain::project(p))?;
            Ok(p)
        }
    }
}

// ---------------------------------------------------------------- built-ins

/// Templates that ship with Rackpath. Seeded once each (by key); later
/// releases can add more, and changing one here never touches existing
/// projects' devices.
fn builtins() -> Vec<(&'static str, Value)> {
    let curve = |pts: &[(f64, f64)]| -> Value {
        json!(pts
            .iter()
            .map(|(w, m)| json!({ "load_w": w, "minutes": m }))
            .collect::<Vec<_>>())
    };
    let psu = |n: u16, col: u16| json!({ "face": "rear", "grid_row": 0, "grid_col": col, "rows": 1, "cols": n, "prefix": "PSU", "connector": "C14" });
    vec![
        (
            "switch-24",
            json!({
                "name": "Switch, 24 ports + 4 SFP+", "device_type": "switch", "u_height": 1,
                "power": { "typical_w": 30, "max_w": 60 },
                "port_groups": [
                    { "grid_row": 0, "grid_col": 0, "rows": 2, "cols": 12, "connector": "RJ45", "speed": 1000 },
                    { "grid_row": 0, "grid_col": 28, "rows": 2, "cols": 2, "prefix": "X", "connector": "SFP+" },
                    psu(1, 44),
                ],
            }),
        ),
        (
            "switch-48",
            json!({
                "name": "Switch, 48 ports + 4 SFP+", "device_type": "switch", "u_height": 1,
                "power": { "typical_w": 60, "max_w": 150 },
                "port_groups": [
                    { "grid_row": 0, "grid_col": 0, "rows": 2, "cols": 24, "connector": "RJ45", "speed": 1000 },
                    { "grid_row": 0, "grid_col": 26, "rows": 2, "cols": 2, "prefix": "X", "connector": "SFP+" },
                    psu(2, 44),
                ],
            }),
        ),
        (
            "patch-panel-24",
            json!({
                "name": "Patch panel, 24 ports", "device_type": "patch_panel", "u_height": 1, "depth": "half",
                "port_groups": [ { "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 24, "connector": "RJ45" } ],
            }),
        ),
        (
            "patch-panel-48",
            json!({
                "name": "Patch panel, 48 ports", "device_type": "patch_panel", "u_height": 1, "depth": "half",
                "port_groups": [ { "grid_row": 0, "grid_col": 0, "rows": 2, "cols": 24, "numbering": "row_major", "connector": "RJ45" } ],
            }),
        ),
        (
            "fibre-panel-24",
            json!({
                "name": "Fibre panel, 24 LC duplex", "device_type": "fibre_panel", "u_height": 1,
                "port_groups": [ { "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 24, "connector": "LC", "fiber_mode": "duplex" } ],
            }),
        ),
        (
            "server-1u",
            json!({
                "name": "Server, 1U", "device_type": "server", "u_height": 1, "depth": "full",
                "power": { "typical_w": 150, "max_w": 400 },
                "port_groups": [
                    { "face": "rear", "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 2, "prefix": "ETH", "connector": "RJ45", "speed": 1000 },
                    { "face": "rear", "grid_row": 1, "grid_col": 0, "rows": 1, "cols": 1, "prefix": "MGT", "connector": "RJ45", "speed": 1000 },
                    psu(2, 44),
                ],
            }),
        ),
        (
            "server-2u",
            json!({
                "name": "Server, 2U", "device_type": "server", "u_height": 2, "depth": "full",
                "power": { "typical_w": 250, "max_w": 750 },
                "port_groups": [
                    { "face": "rear", "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 4, "prefix": "ETH", "connector": "RJ45", "speed": 1000 },
                    { "face": "rear", "grid_row": 1, "grid_col": 0, "rows": 1, "cols": 2, "prefix": "X", "connector": "SFP+" },
                    { "face": "rear", "grid_row": 2, "grid_col": 0, "rows": 1, "cols": 1, "prefix": "MGT", "connector": "RJ45", "speed": 1000 },
                    psu(2, 44),
                ],
            }),
        ),
        (
            "firewall-1u",
            json!({
                "name": "Firewall, 8 ports", "device_type": "firewall", "u_height": 1,
                "power": { "typical_w": 40, "max_w": 100 },
                "port_groups": [
                    { "grid_row": 0, "grid_col": 0, "rows": 2, "cols": 4, "connector": "RJ45", "speed": 1000 },
                    psu(1, 44),
                ],
            }),
        ),
        (
            "ups-1500",
            json!({
                "name": "UPS, 1500 VA", "device_type": "ups", "u_height": 2, "depth": "full",
                "power": { "input_voltage": "120V", "capacity_va": 1500, "capacity_w": 1000, "typical_w": 20, "max_ebm_slots": 4,
                           "runtime_curve": curve(&[(100.0, 90.0), (250.0, 35.0), (500.0, 14.0), (750.0, 8.0), (1000.0, 5.0)]) },
                "port_groups": [
                    { "face": "rear", "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 6, "prefix": "OUT", "connector": "NEMA 5-15R", "outlet_group": 1 },
                    { "face": "rear", "grid_row": 0, "grid_col": 40, "rows": 1, "cols": 1, "prefix": "IN", "connector": "NEMA 5-15P" },
                    { "face": "rear", "grid_row": 2, "grid_col": 40, "rows": 1, "cols": 1, "prefix": "BAT", "connector": "Battery" },
                ],
            }),
        ),
        (
            "ups-3000",
            json!({
                "name": "UPS, 3000 VA", "device_type": "ups", "u_height": 2, "depth": "full",
                "power": { "input_voltage": "208V", "capacity_va": 3000, "capacity_w": 2700, "typical_w": 40, "max_ebm_slots": 4,
                           "runtime_curve": curve(&[(300.0, 60.0), (900.0, 17.0), (1800.0, 7.0), (2700.0, 4.0)]) },
                "port_groups": [
                    { "face": "rear", "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 8, "prefix": "OUT", "connector": "C13", "outlet_group": 1 },
                    { "face": "rear", "grid_row": 1, "grid_col": 0, "rows": 1, "cols": 2, "prefix": "OUT", "connector": "C19", "outlet_group": 2 },
                    { "face": "rear", "grid_row": 0, "grid_col": 40, "rows": 1, "cols": 1, "prefix": "IN", "connector": "NEMA L6-30P" },
                    { "face": "rear", "grid_row": 2, "grid_col": 40, "rows": 1, "cols": 1, "prefix": "BAT", "connector": "Battery" },
                ],
            }),
        ),
        (
            "ebm",
            json!({
                "name": "Extended battery module", "device_type": "battery_module", "u_height": 2, "depth": "full",
                "power": { "ebm_runtime_curve": curve(&[(100.0, 180.0), (250.0, 70.0), (500.0, 30.0), (750.0, 18.0), (1000.0, 12.0)]) },
                "port_groups": [ { "face": "rear", "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 1, "prefix": "BAT", "connector": "Battery" } ],
            }),
        ),
        (
            "pdu-horizontal-8",
            json!({
                "name": "PDU, horizontal, 8 × C13", "device_type": "pdu", "u_height": 1, "depth": "half",
                "power": { "typical_w": 5, "capacity_w": 1800 },
                "port_groups": [
                    { "face": "rear", "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 8, "connector": "C13", "outlet_group": 1 },
                    { "face": "rear", "grid_row": 1, "grid_col": 46, "rows": 1, "cols": 1, "prefix": "IN", "connector": "C20" },
                ],
            }),
        ),
        (
            "pdu-vertical-24",
            json!({
                "name": "PDU, vertical, 24 × C13", "device_type": "pdu", "u_height": 0,
                "power": { "typical_w": 5, "capacity_w": 5000 },
                "port_groups": [
                    { "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 1, "prefix": "IN", "connector": "NEMA L6-30P" },
                    { "grid_row": 2, "grid_col": 0, "rows": 8, "cols": 1, "connector": "C13", "outlet_group": 1 },
                    { "grid_row": 11, "grid_col": 0, "rows": 8, "cols": 1, "connector": "C13", "outlet_group": 2 },
                    { "grid_row": 20, "grid_col": 0, "rows": 8, "cols": 1, "connector": "C13", "outlet_group": 3 },
                ],
            }),
        ),
        (
            "wall-outlet-2",
            json!({
                "name": "Wall outlet, 2 ports", "device_type": "wall_outlet",
                "port_groups": [ { "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 2, "connector": "RJ45" } ],
            }),
        ),
        (
            "access-point",
            json!({
                "name": "Access point", "device_type": "access_point",
                "power": { "typical_w": 15, "max_w": 25 },
                "port_groups": [ { "grid_row": 0, "grid_col": 0, "rows": 1, "cols": 1, "prefix": "ETH", "connector": "RJ45", "speed": 2500, "poe": "at" } ],
            }),
        ),
    ]
}

/// Inserts any built-in template that isn't there yet.
pub async fn seed_builtins(pool: &sqlx::SqlitePool) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for (key, def) in builtins() {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT id FROM device_templates WHERE builtin_key = ?")
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?;
        if exists.is_some() {
            continue;
        }
        let input: TemplateIn = serde_json::from_value(def)
            .map_err(|e| AppError::internal(format!("built-in template {key}: {e}")))?;
        let p = prepare(&mut tx, None, input)
            .await
            .map_err(|e| AppError::internal(format!("built-in template {key}: {e:?}")))?;
        store(&mut tx, None, None, Some(key), &p).await?;
    }
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------- devices

/// Creates the ports of a new device from a template and copies its power
/// figures. Returns the number of ports made.
pub async fn instantiate(
    conn: &mut SqliteConnection,
    device_id: i64,
    p: &Prepared,
) -> AppResult<usize> {
    for g in &p.ports {
        let mut v = p.values[g.group].clone();
        v.sort_order = g.index as i64 + 1;
        insert_port(conn, device_id, &g.code, &v, true).await?;
    }
    if !p.power.is_empty() {
        save_device_power(conn, device_id, &p.power).await?;
    }
    Ok(p.ports.len())
}

/// What a template change did (or would do) to one device.
#[derive(Serialize, Default)]
pub struct DeviceImpact {
    device_id: i64,
    path: String,
    ports_added: Vec<String>,
    ports_removed: Vec<String>,
    ports_changed: Vec<String>,
    cables_removed: Vec<String>,
    unplaced: bool,
}

impl DeviceImpact {
    fn destructive(&self) -> bool {
        !self.ports_removed.is_empty() || !self.cables_removed.is_empty() || self.unplaced
    }
    fn any(&self) -> bool {
        self.destructive() || !self.ports_added.is_empty() || !self.ports_changed.is_empty()
    }
}

#[derive(FromRow)]
struct DeviceBits {
    id: i64,
    manufacturer: Option<String>,
    model: Option<String>,
    rack_id: Option<i64>,
    rack_pos_half: Option<i64>,
    u_height_half: Option<i64>,
    rack_face: Option<String>,
    rack_mount: Option<String>,
}

/// Brings one device in line with a changed template.
async fn sync_device(
    conn: &mut SqliteConnection,
    device_id: i64,
    old: &Prepared,
    new: &Prepared,
    new_version: i64,
) -> AppResult<DeviceImpact> {
    let path: String =
        sqlx::query_scalar("SELECT path FROM search_entries WHERE kind = 'device' AND ref_id = ?")
            .bind(device_id)
            .fetch_one(&mut *conn)
            .await?;
    let mut impact = DeviceImpact {
        device_id,
        path,
        ..Default::default()
    };
    let mut rows: HashMap<i64, super::ports::PortRow> =
        super::ports::template_ports(conn, device_id)
            .await?
            .into_iter()
            .map(|r| (r.id, r))
            .collect();
    let mut existing: Vec<(i64, String)> = rows.values().map(|r| (r.id, r.code.clone())).collect();
    existing.sort_unstable();
    let d = tpl::diff(&existing, &new.ports);
    let by_code: HashMap<&str, &Generated> =
        new.ports.iter().map(|g| (g.code.as_str(), g)).collect();

    for (id, code) in &d.removed {
        let conns: Vec<i64> =
            sqlx::query_scalar("SELECT connection_id FROM connection_ends WHERE port_id = ?")
                .bind(id)
                .fetch_all(&mut *conn)
                .await?;
        for c in conns {
            impact
                .cables_removed
                .push(cabling::describe(conn, c).await?);
        }
        sqlx::query("DELETE FROM ports WHERE id = ?")
            .bind(id)
            .execute(&mut *conn)
            .await?;
        hierarchy::reindex(conn, Subtree::Port(*id)).await?;
        impact.ports_removed.push(code.clone());
    }

    for (id, code) in &d.kept {
        let g = by_code[code.as_str()];
        let v = &new.values[g.group];
        let Some(port) = rows.remove(id) else {
            continue;
        };
        // A cage port keeps the optic it holds while the cage stays the same.
        let same_connector = port.connector.as_deref() == v.connector.map(Connector::name);
        let (transceiver, medium) =
            if same_connector && matches!(v.connector, Some(Connector::Cage(_))) {
                (port.transceiver.clone(), port.medium.clone())
            } else {
                (
                    v.transceiver.map(|t| t.name.to_string()),
                    v.medium.as_str().to_string(),
                )
            };
        let changed = port.face != v.face
            || port.role != v.role.as_str()
            || port.requires_permanent != v.requires_permanent
            || port.medium != medium
            || port.connector.as_deref() != v.connector.map(Connector::name)
            || port.transceiver != transceiver
            || port.fiber_mode != v.fiber_mode
            || port.outlet_group != v.outlet_group
            || port.sort_order != g.index as i64 + 1;
        if !changed {
            continue;
        }
        impact.ports_changed.push(code.clone());
        // Cables that no longer fit go.
        let mine = |side: Side| PortMedia {
            medium: media::Medium::parse(&medium).unwrap_or(media::Medium::Other),
            connector: v.connector,
            transceiver: transceiver.as_deref().and_then(media::Transceiver::parse),
            speed: port.speed.and_then(|s| u32::try_from(s).ok()),
            rear: v.role == Role::Passive && side == Side::Rear,
        };
        for PluggedCable {
            side,
            cable_type,
            length_m,
            far,
            far_side,
        } in cables_on(conn, *id).await?
        {
            let fits = !(v.role == Role::Active && side == Side::Rear)
                && media::check_cable(
                    &mine(side),
                    &far.media(far_side),
                    cable_type.as_deref().and_then(CableType::parse),
                    length_m,
                    None,
                )
                .is_ok();
            if !fits {
                let cid: i64 = sqlx::query_scalar(
                    "SELECT connection_id FROM connection_ends WHERE port_id = ? AND side = ?",
                )
                .bind(id)
                .bind(side.as_str())
                .fetch_one(&mut *conn)
                .await?;
                impact
                    .cables_removed
                    .push(cabling::describe(conn, cid).await?);
                sqlx::query("DELETE FROM connections WHERE id = ?")
                    .bind(cid)
                    .execute(&mut *conn)
                    .await?;
            }
        }
        sqlx::query(
            "UPDATE ports SET face = ?, role = ?, requires_permanent = ?, medium = ?, connector = ?, transceiver = ?,
             fiber_mode = ?, outlet_group = ?, sort_order = ?, updated_at = ? WHERE id = ?",
        )
        .bind(v.face)
        .bind(v.role.as_str())
        .bind(v.requires_permanent)
        .bind(&medium)
        .bind(v.connector.map(Connector::name))
        .bind(&transceiver)
        .bind(&v.fiber_mode)
        .bind(v.outlet_group)
        .bind(g.index as i64 + 1)
        .bind(now_ts())
        .bind(id)
        .execute(&mut *conn)
        .await?;
        hierarchy::reindex(conn, Subtree::Port(*id)).await?;
    }

    for code in &d.added {
        let g = by_code[code.as_str()];
        let mut v = new.values[g.group].clone();
        v.sort_order = g.index as i64 + 1;
        insert_port(conn, device_id, code, &v, true).await.map_err(|e| match e {
            AppError::Conflict(_) => AppError::Conflict(format!(
                "{} already has a port called {code} that wasn't made by the template; rename it first",
                impact.path
            )),
            other => other,
        })?;
        impact.ports_added.push(code.clone());
    }

    // Height, manufacturer, model: follow the template unless customised.
    let dev = sqlx::query_as::<_, DeviceBits>(
        "SELECT id, manufacturer, model, rack_id, rack_pos_half, u_height_half, rack_face, rack_mount FROM devices WHERE id = ?",
    )
    .bind(device_id)
    .fetch_one(&mut *conn)
    .await?;
    let follow = |dev_val: &Option<String>, old_val: &Option<String>, new_val: &Option<String>| {
        if dev_val == old_val {
            new_val.clone()
        } else {
            dev_val.clone()
        }
    };
    let manufacturer = follow(&dev.manufacturer, &old.t.manufacturer, &new.t.manufacturer);
    let model = follow(&dev.model, &old.t.model, &new.t.model);
    let height = match new.u_half {
        Some(h) if h > 0 && new.u_half != old.u_half => Some(h),
        _ => dev.u_height_half,
    };
    sqlx::query("UPDATE devices SET manufacturer = ?, model = ?, u_height_half = ?, template_version = ?, updated_at = ? WHERE id = ?")
        .bind(&manufacturer)
        .bind(&model)
        .bind(height)
        .bind(new_version)
        .bind(now_ts())
        .bind(dev.id)
        .execute(&mut *conn)
        .await?;
    if let (Some(rack), true) = (dev.rack_id, height != dev.u_height_half) {
        let height_u: i64 = sqlx::query_scalar("SELECT u_height FROM racks WHERE id = ?")
            .bind(rack)
            .fetch_one(&mut *conn)
            .await?;
        let slot = Slot {
            device_id: dev.id,
            pos_half: dev.rack_pos_half,
            height_half: height.unwrap_or(2),
            face: dev
                .rack_face
                .as_deref()
                .and_then(RackFace::parse)
                .unwrap_or(RackFace::Front),
            mount: dev
                .rack_mount
                .as_deref()
                .and_then(Mount::parse)
                .unwrap_or(Mount::FullWidth),
        };
        let others = rack_slots(conn, rack, Some(dev.id)).await?;
        if check_fit(&slot, &others, height_u).is_err() {
            let (_, cut) = hierarchy::unplace_device(conn, dev.id).await?;
            impact.cables_removed.extend(cut);
            impact.unplaced = true;
        }
    }
    // The device's own search entry changes with its path or text.
    if impact.unplaced || manufacturer != dev.manufacturer || model != dev.model {
        hierarchy::reindex_device_tree(conn, dev.id).await?;
    }

    // Power figures: each follows the template unless the device's differs.
    let current = load_device_power(conn, device_id)
        .await?
        .unwrap_or_default();
    let (o, n) = (&old.power, &new.power);
    macro_rules! pick {
        ($f:ident) => {
            if current.$f == o.$f {
                n.$f.clone()
            } else {
                current.$f.clone()
            }
        };
    }
    let merged = PowerSpec {
        input_voltage: pick!(input_voltage),
        capacity_va: pick!(capacity_va),
        capacity_w: pick!(capacity_w),
        typical_w: pick!(typical_w),
        max_w: pick!(max_w),
        runtime_curve: pick!(runtime_curve),
        ebm_runtime_curve: pick!(ebm_runtime_curve),
        max_ebm_slots: pick!(max_ebm_slots),
    };
    if merged != current {
        save_device_power(conn, device_id, &merged).await?;
    }
    Ok(impact)
}

// ---------------------------------------------------------------- routes

pub async fn list(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    #[derive(FromRow)]
    struct Row {
        id: i64,
        project_id: Option<i64>,
        builtin_key: Option<String>,
        name: String,
        device_type_key: String,
        manufacturer: Option<String>,
        model: Option<String>,
        u_height_half: Option<i64>,
        version: i64,
        devices: i64,
    }
    let rows = sqlx::query_as::<_, Row>(
        "SELECT t.id, t.project_id, t.builtin_key, t.name, t.device_type_key, t.manufacturer, t.model, t.u_height_half,
                t.version, (SELECT COUNT(*) FROM devices d WHERE d.template_id = t.id AND d.project_id = ?) AS devices
         FROM device_templates t WHERE t.project_id = ? OR t.project_id IS NULL
         ORDER BY t.project_id IS NULL, t.name",
    )
    .bind(project_id)
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "templates": rows.into_iter().map(|r| json!({
            "id": r.id, "project_id": r.project_id, "builtin": r.builtin_key.is_some(), "builtin_key": r.builtin_key,
            "name": r.name, "device_type": r.device_type_key, "manufacturer": r.manufacturer, "model": r.model,
            "u_height": r.u_height_half.map(|h| h as f64 / 2.0), "version": r.version, "device_count": r.devices,
        })).collect::<Vec<_>>(),
        "can_edit": current.principal.can(Action::Write, &Chain::project(project_id)),
    })))
}

pub async fn get_one(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let (row, p) = load_prepared(&mut conn, id).await?;
    can_read(&current, &row)?;
    let count = device_count(&mut conn, id).await?;
    Ok(Json(to_json(&row, &p, count)))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<TemplateIn>,
) -> AppResult<(StatusCode, Json<Value>)> {
    require(&current, Action::Write, &Chain::project(project_id))?;
    let mut tx = state.pool.begin().await?;
    let p = prepare(&mut tx, Some(project_id), body).await?;
    let id = store(&mut tx, None, Some(project_id), None, &p).await?;
    let row = load_row(&mut tx, id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "device_template", Some(id))
            .path(row.name.clone())
            .project(Some(project_id))
            .changes(json!({ "device_type": row.device_type_key, "ports": p.ports.len() })),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(to_json(&row, &p, 0))))
}

/// Checks a template and lists the ports it would make, without saving:
/// the designer's live preview. Errors (overlapping groups, duplicate
/// names, groups off the face) come back as they would on save.
pub async fn preview(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<TemplateIn>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let mut conn = state.pool.acquire().await?;
    let p = prepare(&mut conn, Some(project_id), body).await?;
    let grid = grid_for(p.u_half);
    Ok(Json(json!({
        "grid": { "rows": grid.rows, "cols": grid.cols },
        "ports": p.ports.iter()
            .map(|g| json!({ "index": g.index, "code": g.code, "face": g.face.as_str(), "row": g.row, "col": g.col, "group": g.group }))
            .collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct SaveQuery {
    #[serde(default)]
    dry_run: bool,
}

#[derive(Deserialize)]
pub struct SaveBody {
    #[serde(flatten)]
    template: TemplateIn,
    /// Required when the change removes ports or cables or unplaces devices.
    confirm_name: Option<String>,
}

pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    Query(q): Query<SaveQuery>,
    JsonBody(body): JsonBody<SaveBody>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let mut tx = state.pool.begin().await?;
    let (row, old) = load_prepared(&mut tx, id).await?;
    let project_id = can_edit(&current, &row)?;
    let new = prepare(&mut tx, Some(project_id), body.template).await?;
    store(&mut tx, Some(id), Some(project_id), None, &new).await?;
    let new_row = load_row(&mut tx, id).await?;

    // Devices made from it, oldest first.
    let devices: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM devices WHERE template_id = ? ORDER BY id")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let mut impacts = Vec::new();
    for d in devices {
        let i = sync_device(&mut tx, d, &old, &new, new_row.version).await?;
        if i.any() {
            impacts.push(i);
        }
    }
    let destructive = impacts.iter().any(DeviceImpact::destructive);
    let report = json!({
        "dry_run": q.dry_run,
        "needs_confirmation": destructive,
        "devices": impacts,
    });
    if q.dry_run {
        tx.rollback().await?;
        return Ok((StatusCode::OK, Json(report)));
    }
    if destructive && body.confirm_name.as_deref().map(str::trim) != Some(row.name.as_str()) {
        tx.rollback().await?;
        let mut r = report;
        r["error"] = json!(format!(
            "This change removes ports or cables, or unplaces devices. Check the list, then send \"confirm_name\": \"{}\"",
            row.name
        ));
        return Ok((StatusCode::CONFLICT, Json(r)));
    }
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "device_template", Some(id))
            .path(new_row.name.clone())
            .project(Some(project_id))
            .changes(json!({
                "version": [row.version, new_row.version],
                "ports": [old.ports.len(), new.ports.len()],
                "devices": report["devices"],
            })),
    )
    .await?;
    tx.commit().await?;
    let count = {
        let mut conn = state.pool.acquire().await?;
        device_count(&mut conn, id).await?
    };
    let mut v = to_json(&new_row, &new, count);
    v["devices_updated"] = report["devices"].clone();
    Ok((StatusCode::OK, Json(v)))
}

#[derive(Deserialize)]
pub struct DuplicateBody {
    project_id: i64,
    name: Option<String>,
}

/// Copies a template (built-in or from a project the user can read) into a
/// project the user can edit.
pub async fn duplicate(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<DuplicateBody>,
) -> AppResult<(StatusCode, Json<Value>)> {
    require(&current, Action::Write, &Chain::project(body.project_id))?;
    let mut tx = state.pool.begin().await?;
    let row = load_row(&mut tx, id).await?;
    can_read(&current, &row)?;
    let mut input = load_input(&mut tx, &row).await?;
    input.name = match body.name {
        Some(n) => n,
        None if row.project_id == Some(body.project_id) => format!("{} (copy)", row.name),
        None => row.name.clone(),
    };
    let p = prepare(&mut tx, Some(body.project_id), input).await?;
    let new_id = store(&mut tx, None, Some(body.project_id), None, &p).await?;
    let new_row = load_row(&mut tx, new_id).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "device_template", Some(new_id))
            .path(new_row.name.clone())
            .project(Some(body.project_id))
            .changes(json!({ "copied_from": row.name })),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(to_json(&new_row, &p, 0))))
}

/// Deletes a template. Devices made from it keep their ports and become
/// independent.
pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let row = load_row(&mut tx, id).await?;
    let project_id = can_edit(&current, &row)?;
    let count = device_count(&mut tx, id).await?;
    sqlx::query("UPDATE ports SET from_template = 0 WHERE device_id IN (SELECT id FROM devices WHERE template_id = ?)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM device_templates WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "device_template", Some(id))
            .path(row.name.clone())
            .project(Some(project_id))
            .changes(json!({ "devices_detached": count })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
