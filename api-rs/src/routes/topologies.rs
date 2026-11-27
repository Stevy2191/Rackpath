//! Logical topology diagrams (design section 9). A diagram is saved as a
//! whole (`PUT`), the way a drawing editor works. Nodes can stand for
//! documented devices, and an edge can be backed by a real cable: then the
//! diagram shows the cable's ends and its chain state.
//!
//! `expected_version` guards against two people overwriting each other.
//! Diagrams need edit rights on the project to change, and read rights to view.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, SqliteConnection};

use super::{require, JsonBody};
use crate::audit::{self, Entry};
use crate::auth::CurrentUser;
use crate::domain::permissions::{Action, Chain};
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::now_ts;

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct NodeIn {
    key: String,
    #[serde(default)]
    device_id: Option<i64>,
    #[serde(default)]
    label: Option<String>,
    x: f64,
    y: f64,
    #[serde(default)]
    width: Option<f64>,
    #[serde(default)]
    height: Option<f64>,
    #[serde(default)]
    style: Option<Value>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct EdgeIn {
    source: String,
    target: String,
    #[serde(default)]
    connection_id: Option<i64>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    style: Option<Value>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct ItemIn {
    kind: String,
    x: f64,
    y: f64,
    #[serde(default)]
    width: Option<f64>,
    #[serde(default)]
    height: Option<f64>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    style: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagramIn {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    viewport: Option<Value>,
    #[serde(default)]
    nodes: Vec<NodeIn>,
    #[serde(default)]
    edges: Vec<EdgeIn>,
    #[serde(default)]
    items: Vec<ItemIn>,
    /// The version this save is based on; a newer one on the server is a 409.
    #[serde(default)]
    expected_version: Option<i64>,
}

#[derive(FromRow)]
struct Row {
    id: i64,
    project_id: i64,
    name: String,
    description: Option<String>,
    viewport: Option<String>,
    version: i64,
    created_at: String,
    updated_at: String,
}

async fn load(conn: &mut SqliteConnection, id: i64) -> AppResult<Row> {
    sqlx::query_as::<_, Row>(
        "SELECT id, project_id, name, description, viewport, version, created_at, updated_at FROM topologies WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

fn small_json(v: &Option<Value>, what: &str) -> AppResult<Option<String>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(v) if v.is_object() => {
            let s = v.to_string();
            if s.len() > 4096 {
                return Err(AppError::bad(format!("{what} is too large")));
            }
            Ok(Some(s))
        }
        Some(_) => Err(AppError::bad(format!("{what} must be an object"))),
    }
}

fn finite(vals: &[Option<f64>]) -> AppResult<()> {
    if vals
        .iter()
        .flatten()
        .any(|v| !v.is_finite() || v.abs() > 1e7)
    {
        return Err(AppError::bad("Positions and sizes must be finite numbers"));
    }
    Ok(())
}

/// Validates and writes a diagram's contents (replacing what was there).
async fn store(
    conn: &mut SqliteConnection,
    project_id: i64,
    topology_id: i64,
    d: &DiagramIn,
) -> AppResult<()> {
    if d.nodes.len() > 5000 || d.edges.len() > 10000 || d.items.len() > 2000 {
        return Err(AppError::bad("The diagram is too large"));
    }
    for table in [
        "DELETE FROM topology_edges WHERE topology_id = ?",
        "DELETE FROM topology_nodes WHERE topology_id = ?",
        "DELETE FROM topology_items WHERE topology_id = ?",
    ] {
        sqlx::query(table)
            .bind(topology_id)
            .execute(&mut *conn)
            .await?;
    }
    let mut ids: HashMap<&str, (i64, Option<i64>)> = HashMap::new();
    for n in &d.nodes {
        let key = n.key.trim();
        if key.is_empty() || key.len() > 64 {
            return Err(AppError::bad(
                "Every node needs a key of 1 to 64 characters",
            ));
        }
        finite(&[Some(n.x), Some(n.y), n.width, n.height])?;
        if let Some(dev) = n.device_id {
            let p: Option<i64> = sqlx::query_scalar("SELECT project_id FROM devices WHERE id = ?")
                .bind(dev)
                .fetch_optional(&mut *conn)
                .await?;
            if p != Some(project_id) {
                return Err(AppError::bad(format!(
                    "Node {key}: device not found in this project"
                )));
            }
        }
        if n.label.as_ref().is_some_and(|l| l.chars().count() > 200) {
            return Err(AppError::bad(format!("Node {key}: label is too long")));
        }
        let id = sqlx::query(
            "INSERT INTO topology_nodes (topology_id, key, device_id, label, x, y, width, height, style) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(topology_id)
        .bind(key)
        .bind(n.device_id)
        .bind(&n.label)
        .bind(n.x)
        .bind(n.y)
        .bind(n.width)
        .bind(n.height)
        .bind(small_json(&n.style, "style")?)
        .execute(&mut *conn)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(x) if x.is_unique_violation() => AppError::bad(format!("Two nodes have the key {key}")),
            _ => e.into(),
        })?
        .last_insert_rowid();
        ids.insert(key, (id, n.device_id));
    }
    for e in &d.edges {
        let (Some(&(s, sd)), Some(&(t, td))) = (ids.get(e.source.trim()), ids.get(e.target.trim()))
        else {
            return Err(AppError::bad(format!(
                "Edge {} → {}: unknown node",
                e.source, e.target
            )));
        };
        if let Some(c) = e.connection_id {
            // The cable must join the two nodes' devices (in either direction).
            let ends: Vec<(i64, i64)> = sqlx::query_as(
                "SELECT c.project_id, o.device_id FROM connections c JOIN connection_ends x ON x.connection_id = c.id
                 JOIN ports o ON o.id = x.port_id WHERE c.id = ? ORDER BY x.endpoint",
            )
            .bind(c)
            .fetch_all(&mut *conn)
            .await?;
            if ends.len() != 2 || ends[0].0 != project_id {
                return Err(AppError::bad("Edge: cable not found in this project"));
            }
            let (a, b) = (ends[0].1, ends[1].1);
            let matches = |x: Option<i64>, y: Option<i64>| {
                x.is_none_or(|x| x == a) && y.is_none_or(|y| y == b)
            };
            if !(matches(sd, td) || matches(td, sd)) {
                return Err(AppError::bad(
                    "Edge: that cable doesn't join the devices of these two nodes",
                ));
            }
        }
        sqlx::query(
            "INSERT INTO topology_edges (topology_id, source_node, target_node, connection_id, label, style) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(topology_id)
        .bind(s)
        .bind(t)
        .bind(e.connection_id)
        .bind(&e.label)
        .bind(small_json(&e.style, "style")?)
        .execute(&mut *conn)
        .await?;
    }
    for i in &d.items {
        if !["zone", "label", "shape"].contains(&i.kind.as_str()) {
            return Err(AppError::bad("Item kind must be zone, label or shape"));
        }
        finite(&[Some(i.x), Some(i.y), i.width, i.height])?;
        if i.text.as_ref().is_some_and(|t| t.chars().count() > 2000) {
            return Err(AppError::bad("Item text is too long"));
        }
        sqlx::query(
            "INSERT INTO topology_items (topology_id, kind, x, y, width, height, text, style) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(topology_id)
        .bind(&i.kind)
        .bind(i.x)
        .bind(i.y)
        .bind(i.width)
        .bind(i.height)
        .bind(&i.text)
        .bind(small_json(&i.style, "style")?)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

async fn full(conn: &mut SqliteConnection, row: &Row) -> AppResult<Value> {
    #[derive(FromRow)]
    struct N {
        id: i64,
        key: String,
        device_id: Option<i64>,
        label: Option<String>,
        x: f64,
        y: f64,
        width: Option<f64>,
        height: Option<f64>,
        style: Option<String>,
        code: Option<String>,
        path: Option<String>,
        type_key: Option<String>,
    }
    let nodes = sqlx::query_as::<_, N>(
        "SELECT n.id, n.key, n.device_id, n.label, n.x, n.y, n.width, n.height, n.style, d.code, s.path, dt.key AS type_key
         FROM topology_nodes n LEFT JOIN devices d ON d.id = n.device_id
         LEFT JOIN device_types dt ON dt.id = d.device_type_id
         LEFT JOIN search_entries s ON s.kind = 'device' AND s.ref_id = n.device_id
         WHERE n.topology_id = ? ORDER BY n.id",
    )
    .bind(row.id)
    .fetch_all(&mut *conn)
    .await?;
    let keys: HashMap<i64, String> = nodes.iter().map(|n| (n.id, n.key.clone())).collect();
    #[allow(clippy::type_complexity)]
    let edges: Vec<(i64, i64, Option<i64>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT source_node, target_node, connection_id, label, style FROM topology_edges WHERE topology_id = ? ORDER BY id",
    )
    .bind(row.id)
    .fetch_all(&mut *conn)
    .await?;
    let mut edges_out = Vec::with_capacity(edges.len());
    for (s, t, c, label, style) in edges {
        let cable = match c {
            None => Value::Null,
            Some(cid) => {
                let ports: Vec<(i64, String)> = sqlx::query_as(
                    "SELECT x.port_id, sp.path FROM connection_ends x JOIN search_entries sp ON sp.kind = 'port' AND sp.ref_id = x.port_id
                     WHERE x.connection_id = ? ORDER BY x.endpoint",
                )
                .bind(cid)
                .fetch_all(&mut *conn)
                .await?;
                let state = match ports.first() {
                    Some((p, _)) => {
                        let g = crate::cabling::component(conn, *p).await?;
                        crate::domain::cabling::trace(&g, *p).state.as_str()
                    }
                    None => "unconnected",
                };
                json!({ "id": cid, "ends": ports.iter().map(|(_, p)| p).collect::<Vec<_>>(), "chain_state": state })
            }
        };
        edges_out.push(json!({
            "source": keys.get(&s), "target": keys.get(&t), "connection_id": c, "label": label,
            "style": style.and_then(|s| serde_json::from_str::<Value>(&s).ok()), "cable": cable,
        }));
    }
    #[allow(clippy::type_complexity)]
    let items: Vec<(String, f64, f64, Option<f64>, Option<f64>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT kind, x, y, width, height, text, style FROM topology_items WHERE topology_id = ? ORDER BY id",
    )
    .bind(row.id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(json!({
        "id": row.id, "project_id": row.project_id, "name": row.name, "description": row.description,
        "viewport": row.viewport.as_deref().and_then(|v| serde_json::from_str::<Value>(v).ok()),
        "version": row.version, "created_at": row.created_at, "updated_at": row.updated_at,
        "nodes": nodes.iter().map(|n| json!({
            "key": n.key, "device_id": n.device_id, "label": n.label, "x": n.x, "y": n.y, "width": n.width, "height": n.height,
            "style": n.style.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok()),
            "device": n.device_id.map(|_| json!({ "code": n.code, "path": n.path, "type": n.type_key })),
        })).collect::<Vec<_>>(),
        "edges": edges_out,
        "items": items.into_iter().map(|(kind, x, y, w, h, text, style)| json!({
            "kind": kind, "x": x, "y": y, "width": w, "height": h, "text": text,
            "style": style.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
        })).collect::<Vec<_>>(),
    }))
}

fn check_name(n: &str) -> AppResult<String> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > 80 {
        return Err(AppError::bad("name must be 1 to 80 characters"));
    }
    Ok(n.to_string())
}

pub async fn list(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Value>> {
    require(&current, Action::Read, &Chain::project(project_id))?;
    let rows: Vec<(i64, String, Option<String>, i64, String, i64)> = sqlx::query_as(
        "SELECT t.id, t.name, t.description, t.version, t.updated_at,
                (SELECT COUNT(*) FROM topology_nodes n WHERE n.topology_id = t.id)
         FROM topologies t WHERE t.project_id = ? ORDER BY t.name",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "topologies": rows.into_iter().map(|(id, name, description, version, updated_at, nodes)| json!({
            "id": id, "name": name, "description": description, "version": version, "updated_at": updated_at, "node_count": nodes,
        })).collect::<Vec<_>>(),
        "can_edit": current.principal.can(Action::Write, &Chain::project(project_id)),
    })))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(project_id): Path<i64>,
    JsonBody(body): JsonBody<DiagramIn>,
) -> AppResult<(StatusCode, Json<Value>)> {
    require(&current, Action::Write, &Chain::project(project_id))?;
    let name = check_name(&body.name)?;
    let mut tx = state.pool.begin().await?;
    let now = now_ts();
    let id = sqlx::query(
        "INSERT INTO topologies (project_id, name, description, viewport, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(&name)
    .bind(&body.description)
    .bind(small_json(&body.viewport, "viewport")?)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(x) if x.is_unique_violation() => AppError::Conflict(format!("A diagram named {name} already exists")),
        _ => e.into(),
    })?
    .last_insert_rowid();
    store(&mut tx, project_id, id, &body).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("create", "topology", Some(id))
            .path(name)
            .project(Some(project_id))
            .changes(json!({ "nodes": body.nodes.len(), "edges": body.edges.len() })),
    )
    .await?;
    let row = load(&mut tx, id).await?;
    let v = full(&mut tx, &row).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(v)))
}

pub async fn get_one(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let row = load(&mut conn, id).await?;
    require(&current, Action::Read, &Chain::project(row.project_id))?;
    Ok(Json(full(&mut conn, &row).await?))
}

pub async fn save(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
    JsonBody(body): JsonBody<DiagramIn>,
) -> AppResult<Json<Value>> {
    let name = check_name(&body.name)?;
    let mut tx = state.pool.begin().await?;
    let old = load(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(old.project_id))?;
    if body.expected_version.is_some_and(|v| v != old.version) {
        return Err(AppError::Conflict(format!(
            "Someone saved this diagram since you opened it (version {}); reload it first",
            old.version
        )));
    }
    sqlx::query("UPDATE topologies SET name = ?, description = ?, viewport = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(&body.description)
        .bind(small_json(&body.viewport, "viewport")?)
        .bind(now_ts())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(x) if x.is_unique_violation() => AppError::Conflict(format!("A diagram named {name} already exists")),
            _ => e.into(),
        })?;
    store(&mut tx, old.project_id, id, &body).await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("update", "topology", Some(id))
            .path(name)
            .project(Some(old.project_id))
            .changes(json!({ "version": old.version + 1, "nodes": body.nodes.len(), "edges": body.edges.len() })),
    )
    .await?;
    let row = load(&mut tx, id).await?;
    let v = full(&mut tx, &row).await?;
    tx.commit().await?;
    Ok(Json(v))
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestCtx>,
    current: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let row = load(&mut tx, id).await?;
    require(&current, Action::Write, &Chain::project(row.project_id))?;
    sqlx::query("DELETE FROM topologies WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        &ctx,
        Some(current.actor_ref()),
        Entry::new("delete", "topology", Some(id))
            .path(row.name.clone())
            .project(Some(row.project_id)),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
