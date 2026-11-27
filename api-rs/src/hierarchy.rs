//! The physical hierarchy as the database sees it: permission chains for
//! every kind of item, full paths, and keeping the search index in step.
//!
//! Paths are computed by the `v_entities` view and cached in
//! `search_entries`, which every write refreshes inside its own transaction
//! (for the whole subtree when a code changes, since paths below it change).

use sqlx::{FromRow, SqliteConnection};

use crate::domain::permissions::{Chain, ScopeType};
use crate::error::{AppError, AppResult};

/// Where an item sits: the chain used for permission checks and its path.
#[derive(Clone, Debug)]
pub struct Placed {
    pub project_id: i64,
    pub chain: Chain,
    pub path: String,
}

#[derive(FromRow)]
struct Ids {
    project_id: i64,
    location_id: Option<i64>,
    floor_id: Option<i64>,
    room_id: Option<i64>,
    rack_id: Option<i64>,
    tray_id: Option<i64>,
}

fn chain_from(ids: &Ids) -> Chain {
    let mut chain = Chain::project(ids.project_id);
    for (kind, id) in [
        (ScopeType::Location, ids.location_id),
        (ScopeType::Floor, ids.floor_id),
        (ScopeType::Room, ids.room_id),
        (ScopeType::Rack, ids.rack_id),
        (ScopeType::Device, ids.tray_id),
    ] {
        if let Some(id) = id {
            chain = chain.child(kind, id);
        }
    }
    chain
}

async fn path_of(conn: &mut SqliteConnection, kind: &str, id: i64) -> AppResult<String> {
    let path: Option<String> =
        sqlx::query_scalar("SELECT path FROM search_entries WHERE kind = ? AND ref_id = ?")
            .bind(kind)
            .bind(id)
            .fetch_optional(conn)
            .await?;
    path.ok_or_else(|| AppError::internal(format!("search entry missing for {kind} {id}")))
}

async fn ids(conn: &mut SqliteConnection, kind: ScopeType, id: i64) -> AppResult<Option<Ids>> {
    let sql = match kind {
        ScopeType::Location => {
            "SELECT project_id, id AS location_id, NULL AS floor_id, NULL AS room_id, NULL AS rack_id, NULL AS tray_id
             FROM locations WHERE id = ?"
        }
        ScopeType::Floor => {
            "SELECT l.project_id, l.id AS location_id, f.id AS floor_id, NULL AS room_id, NULL AS rack_id, NULL AS tray_id
             FROM floors f JOIN locations l ON l.id = f.location_id WHERE f.id = ?"
        }
        ScopeType::Room => {
            "SELECT l.project_id, l.id AS location_id, f.id AS floor_id, r.id AS room_id, NULL AS rack_id, NULL AS tray_id
             FROM rooms r JOIN floors f ON f.id = r.floor_id JOIN locations l ON l.id = f.location_id WHERE r.id = ?"
        }
        ScopeType::Rack => {
            "SELECT l.project_id, l.id AS location_id, f.id AS floor_id, r.id AS room_id, k.id AS rack_id, NULL AS tray_id
             FROM racks k JOIN rooms r ON r.id = k.room_id JOIN floors f ON f.id = r.floor_id
             JOIN locations l ON l.id = f.location_id WHERE k.id = ?"
        }
        // The device itself is added by the caller; tray_id is the shelf it sits on.
        ScopeType::Device => {
            "SELECT d.project_id, l.id AS location_id, f.id AS floor_id, r.id AS room_id, k.id AS rack_id, t.id AS tray_id
             FROM devices d
             LEFT JOIN devices t ON t.id = d.parent_device_id
             LEFT JOIN racks k ON k.id = COALESCE(d.rack_id, t.rack_id)
             LEFT JOIN rooms r ON r.id = COALESCE(d.room_id, k.room_id)
             LEFT JOIN floors f ON f.id = r.floor_id
             LEFT JOIN locations l ON l.id = f.location_id
             WHERE d.id = ?"
        }
        ScopeType::Account | ScopeType::Project => return Err(AppError::internal("not a placeable kind")),
    };
    Ok(sqlx::query_as::<_, Ids>(sql)
        .bind(id)
        .fetch_optional(conn)
        .await?)
}

fn kind_name(kind: ScopeType) -> &'static str {
    kind.as_str()
}

/// Looks up any placeable item. None if it doesn't exist.
pub async fn find(
    conn: &mut SqliteConnection,
    kind: ScopeType,
    id: i64,
) -> AppResult<Option<Placed>> {
    let Some(ids) = ids(conn, kind, id).await? else {
        return Ok(None);
    };
    let mut chain = chain_from(&ids);
    if kind == ScopeType::Device {
        chain = chain.child(ScopeType::Device, id);
    }
    let path = path_of(conn, kind_name(kind), id).await?;
    Ok(Some(Placed {
        project_id: ids.project_id,
        chain,
        path,
    }))
}

/// Like `get`, but also for a whole project (whose path is its code).
pub async fn get_any(conn: &mut SqliteConnection, kind: ScopeType, id: i64) -> AppResult<Placed> {
    if kind == ScopeType::Project {
        let code: String = sqlx::query_scalar("SELECT code FROM projects WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await?
            .ok_or(AppError::NotFound)?;
        return Ok(Placed {
            project_id: id,
            chain: Chain::project(id),
            path: code,
        });
    }
    get(conn, kind, id).await
}

/// Like `find`, but a missing item is a 404.
pub async fn get(conn: &mut SqliteConnection, kind: ScopeType, id: i64) -> AppResult<Placed> {
    find(conn, kind, id).await?.ok_or(AppError::NotFound)
}

/// Which part of the search index to rebuild.
#[derive(Clone, Copy, Debug)]
pub enum Subtree {
    Project(i64),
    Location(i64),
    Floor(i64),
    Room(i64),
    Rack(i64),
    /// One device's own entry and its ports (devices on a tray are
    /// refreshed separately).
    Device(i64),
    /// One port.
    Port(i64),
    /// One IP prefix (search only; prefixes aren't in the hierarchy).
    Prefix(i64),
    /// One IP address (search only).
    Address(i64),
}

macro_rules! reindex_sql {
    ($col:literal) => {
        (
            concat!("DELETE FROM search_entries WHERE ", $col, " = ?"),
            concat!(
                "INSERT INTO search_entries (kind, ref_id, project_id, location_id, floor_id, room_id, rack_id, device_id, path, text) ",
                "SELECT kind, ref_id, project_id, location_id, floor_id, room_id, rack_id, device_id, path, text ",
                "FROM v_entities WHERE ",
                $col,
                " = ?"
            ),
        )
    };
}

/// Recomputes paths and search text for everything in `subtree`.
pub async fn reindex(conn: &mut SqliteConnection, subtree: Subtree) -> AppResult<()> {
    let ((delete, insert), id) = match subtree {
        // IPAM entries have no place in the hierarchy (their paths don't
        // contain project or location codes), so a project rename leaves them.
        Subtree::Project(id) => (
            (
                "DELETE FROM search_entries WHERE project_id = ? AND kind NOT IN ('prefix', 'address')",
                "INSERT INTO search_entries (kind, ref_id, project_id, location_id, floor_id, room_id, rack_id, device_id, path, text)
                 SELECT kind, ref_id, project_id, location_id, floor_id, room_id, rack_id, device_id, path, text
                 FROM v_entities WHERE project_id = ?",
            ),
            id,
        ),
        Subtree::Prefix(id) => (
            (
                "DELETE FROM search_entries WHERE kind = 'prefix' AND ref_id = ?",
                "INSERT INTO search_entries (kind, ref_id, project_id, path, text)
                 SELECT 'prefix', id, project_id, cidr, concat_ws(' ', cidr, description, role, domain_name, gateway)
                 FROM prefixes WHERE id = ?",
            ),
            id,
        ),
        Subtree::Address(id) => (
            (
                "DELETE FROM search_entries WHERE kind = 'address' AND ref_id = ?",
                "INSERT INTO search_entries (kind, ref_id, project_id, path, text)
                 SELECT 'address', id, project_id, address,
                        concat_ws(' ', address, dns_name, mac, description,
                                  (SELECT group_concat(value, ' ') FROM json_each(dns_aliases)))
                 FROM ip_addresses WHERE id = ?",
            ),
            id,
        ),
        Subtree::Port(id) => (
            (
                "DELETE FROM search_entries WHERE kind = 'port' AND ref_id = ?",
                "INSERT INTO search_entries (kind, ref_id, project_id, location_id, floor_id, room_id, rack_id, device_id, path, text)
                 SELECT kind, ref_id, project_id, location_id, floor_id, room_id, rack_id, device_id, path, text
                 FROM v_entities WHERE kind = 'port' AND ref_id = ?",
            ),
            id,
        ),
        Subtree::Location(id) => (reindex_sql!("location_id"), id),
        Subtree::Floor(id) => (reindex_sql!("floor_id"), id),
        Subtree::Room(id) => (reindex_sql!("room_id"), id),
        Subtree::Rack(id) => (reindex_sql!("rack_id"), id),
        Subtree::Device(id) => (reindex_sql!("device_id"), id),
    };
    sqlx::query(delete).bind(id).execute(&mut *conn).await?;
    sqlx::query(insert).bind(id).execute(&mut *conn).await?;
    Ok(())
}

/// Refreshes a device and, if it's a tray, the devices sitting on it.
pub async fn reindex_device_tree(conn: &mut SqliteConnection, device_id: i64) -> AppResult<()> {
    reindex(conn, Subtree::Device(device_id)).await?;
    let children: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM devices WHERE parent_device_id = ?")
            .bind(device_id)
            .fetch_all(&mut *conn)
            .await?;
    for child in children {
        reindex(conn, Subtree::Device(child)).await?;
    }
    Ok(())
}

/// Removes index entries for an item that was deleted (and everything that
/// was deleted with it, which shares the same ancestor column).
pub async fn drop_subtree(conn: &mut SqliteConnection, subtree: Subtree) -> AppResult<()> {
    // Reindexing a deleted subtree deletes its entries and inserts nothing.
    reindex(conn, subtree).await
}

/// Device ids anywhere below a container, from the index.
pub async fn devices_in(conn: &mut SqliteConnection, subtree: Subtree) -> AppResult<Vec<i64>> {
    let sql = match subtree {
        Subtree::Project(_) => {
            "SELECT ref_id FROM search_entries WHERE kind = 'device' AND project_id = ?"
        }
        Subtree::Location(_) => {
            "SELECT ref_id FROM search_entries WHERE kind = 'device' AND location_id = ?"
        }
        Subtree::Floor(_) => {
            "SELECT ref_id FROM search_entries WHERE kind = 'device' AND floor_id = ?"
        }
        Subtree::Room(_) => {
            "SELECT ref_id FROM search_entries WHERE kind = 'device' AND room_id = ?"
        }
        Subtree::Rack(_) => {
            "SELECT ref_id FROM search_entries WHERE kind = 'device' AND rack_id = ?"
        }
        Subtree::Device(_) => "SELECT id FROM devices WHERE parent_device_id = ?",
        Subtree::Port(_) | Subtree::Prefix(_) | Subtree::Address(_) => return Ok(vec![]),
    };
    let id = match subtree {
        Subtree::Project(i)
        | Subtree::Location(i)
        | Subtree::Floor(i)
        | Subtree::Room(i)
        | Subtree::Rack(i)
        | Subtree::Device(i)
        | Subtree::Port(i)
        | Subtree::Prefix(i)
        | Subtree::Address(i) => i,
    };
    Ok(sqlx::query_scalar(sql).bind(id).fetch_all(conn).await?)
}

/// Codes already used by siblings in a room: floor devices and racks share
/// the room's namespace.
pub async fn room_codes(conn: &mut SqliteConnection, room_id: i64) -> AppResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT code FROM devices WHERE room_id = ? UNION ALL SELECT code FROM racks WHERE room_id = ?",
    )
    .bind(room_id)
    .bind(room_id)
    .fetch_all(conn)
    .await?)
}

/// Codes already used under a device parent key (`r:`, `k:`, `d:` or `u:`).
pub async fn sibling_codes(
    conn: &mut SqliteConnection,
    parent_key: &str,
) -> AppResult<Vec<String>> {
    if let Some(room) = parent_key
        .strip_prefix("r:")
        .and_then(|r| r.parse::<i64>().ok())
    {
        return room_codes(conn, room).await;
    }
    Ok(
        sqlx::query_scalar("SELECT code FROM devices WHERE parent_key = ?")
            .bind(parent_key)
            .fetch_all(conn)
            .await?,
    )
}

/// A device moved to the Unplaced list: its id, path before, new code and
/// the cables that were removed (an unplaced device isn't cabled).
#[derive(Debug)]
pub struct Unplaced {
    pub id: i64,
    pub before: String,
    pub code: String,
    pub cut: Vec<String>,
}

/// Moves a device to the project's Unplaced list, renaming it if its code
/// is already taken there, and removes its cables. Returns the (possibly
/// new) code and the cables removed.
pub async fn unplace_device(
    conn: &mut SqliteConnection,
    device_id: i64,
) -> AppResult<(String, Vec<String>)> {
    let cut = crate::cabling::cut(conn, &[device_id], false).await?;
    let (project_id, code): (i64, String) =
        sqlx::query_as("SELECT project_id, code FROM devices WHERE id = ?")
            .bind(device_id)
            .fetch_one(&mut *conn)
            .await?;
    let taken: Vec<String> =
        sqlx::query_scalar("SELECT code FROM devices WHERE parent_key = ? AND id <> ?")
            .bind(format!("u:{project_id}"))
            .bind(device_id)
            .fetch_all(&mut *conn)
            .await?;
    let new_code = crate::domain::naming::unique_variant(&code, &taken);
    sqlx::query(
        "UPDATE devices SET room_id = NULL, rack_id = NULL, parent_device_id = NULL, rack_pos_half = NULL,
         rack_face = NULL, rack_mount = NULL, plan_x = NULL, plan_y = NULL, plan_rotation = NULL, code = ?,
         updated_at = ? WHERE id = ?",
    )
    .bind(&new_code)
    .bind(crate::util::now_ts())
    .bind(device_id)
    .execute(&mut *conn)
    .await?;
    Ok((new_code, cut))
}

/// What to do with devices inside a container that is being deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentsMode {
    /// Move them to the Unplaced list (their cables are removed).
    Unplace,
    /// Delete them too.
    Delete,
}

/// Empties a container before it's deleted. Fails with 409 when it holds
/// devices and no mode was chosen. Returns the number of devices and each
/// device moved to Unplaced, for the audit log.
pub async fn clear_contents(
    conn: &mut SqliteConnection,
    subtree: Subtree,
    mode: Option<ContentsMode>,
) -> AppResult<(usize, Vec<Unplaced>)> {
    let devices = devices_in(conn, subtree).await?;
    if devices.is_empty() {
        return Ok((0, vec![]));
    }
    match mode {
        None => Err(AppError::Conflict(format!(
            "This contains {} device(s). Choose \"devices\": \"unplace\" to keep them in the Unplaced list, or \"delete\" to delete them too.",
            devices.len()
        ))),
        Some(ContentsMode::Delete) => {
            let mut q = sqlx::QueryBuilder::<sqlx::Sqlite>::new("DELETE FROM devices WHERE id IN (");
            let mut sep = q.separated(", ");
            for id in &devices {
                sep.push_bind(*id);
            }
            sep.push_unseparated(")");
            q.build().execute(&mut *conn).await?;
            for id in &devices {
                reindex(conn, Subtree::Device(*id)).await?;
            }
            Ok((devices.len(), vec![]))
        }
        Some(ContentsMode::Unplace) => {
            let mut moved = Vec::with_capacity(devices.len());
            for id in &devices {
                let before = path_of(conn, "device", *id).await.unwrap_or_default();
                let (code, cut) = unplace_device(conn, *id).await?;
                moved.push(Unplaced {
                    id: *id,
                    before,
                    code,
                    cut,
                });
            }
            for u in &moved {
                reindex(conn, Subtree::Device(u.id)).await?;
            }
            Ok((devices.len(), moved))
        }
    }
}
