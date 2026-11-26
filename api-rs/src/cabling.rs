//! Cabling as the database sees it: loading chains into the pure graph in
//! `domain::cabling`, and cutting cables when devices move away.

use std::collections::{HashSet, VecDeque};

use sqlx::{QueryBuilder, Sqlite, SqliteConnection};

use crate::domain::cabling::{Graph, Kind, Role, Side, MAX_HOPS};
use crate::error::AppResult;

fn role(s: &str) -> Role {
    Role::parse(s).unwrap_or(Role::Active)
}
fn side(s: &str) -> Side {
    Side::parse(s).unwrap_or(Side::Front)
}
fn kind(s: &str) -> Kind {
    Kind::parse(s).unwrap_or(Kind::Patch)
}

/// Loads the chain(s) through one port: breadth-first over cables, bounded
/// so bad data can't make it run away.
pub async fn component(conn: &mut SqliteConnection, port_id: i64) -> AppResult<Graph> {
    let mut g = Graph::default();
    let start: Option<String> = sqlx::query_scalar("SELECT role FROM ports WHERE id = ?")
        .bind(port_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(start) = start else {
        return Ok(g);
    };
    g.add_port(port_id, role(&start));
    let mut seen = HashSet::from([port_id]);
    let mut queue = VecDeque::from([port_id]);
    while let Some(port) = queue.pop_front() {
        if seen.len() > 4 * MAX_HOPS {
            break;
        }
        let rows: Vec<(String, i64, String, i64, String, String)> = sqlx::query_as(
            "SELECT e.side, c.id, c.kind, f.port_id, f.side, p.role
             FROM connection_ends e
             JOIN connections c ON c.id = e.connection_id
             JOIN connection_ends f ON f.connection_id = e.connection_id AND f.endpoint <> e.endpoint
             JOIN ports p ON p.id = f.port_id
             WHERE e.port_id = ?",
        )
        .bind(port)
        .fetch_all(&mut *conn)
        .await?;
        for (my_side, cid, k, far, far_side, far_role) in rows {
            g.add_port(far, role(&far_role));
            g.add_cable(
                cid,
                kind(&k),
                (port, side(&my_side)),
                (far, side(&far_side)),
            );
            if seen.insert(far) {
                queue.push_back(far);
            }
        }
    }
    Ok(g)
}

/// The chains through many ports at once, for listings: a breadth-first
/// walk in batches, so it costs what those chains hold, not the project.
pub async fn components(conn: &mut SqliteConnection, ports: &[i64]) -> AppResult<Graph> {
    let mut g = Graph::default();
    let mut seen: HashSet<i64> = HashSet::new();
    let mut frontier: Vec<i64> = ports.iter().copied().filter(|p| seen.insert(*p)).collect();
    // Each round follows one more cable; chains are at most MAX_HOPS long.
    for _ in 0..=MAX_HOPS {
        if frontier.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for chunk in frontier.chunks(5000) {
            // One JSON value per query instead of one decoded row per port.
            let mut q: QueryBuilder<Sqlite> = QueryBuilder::new(
                "SELECT json_group_array(json_array(id, role)) FROM ports WHERE id IN (",
            );
            {
                let mut sep = q.separated(", ");
                for id in chunk {
                    sep.push_bind(*id);
                }
            }
            q.push(")");
            let roles: Vec<(i64, String)> = crate::routes::ports::from_json_list(
                q.build_query_scalar().fetch_one(&mut *conn).await?,
            )?;
            for (id, r) in roles {
                g.add_port(id, role(&r));
            }
            let mut q: QueryBuilder<Sqlite> = QueryBuilder::new(
                                "SELECT json_group_array(json_array(e.port_id, e.side, c.id, c.kind, f.port_id, f.side))
                 FROM connection_ends e
                 JOIN connections c ON c.id = e.connection_id
                 JOIN connection_ends f ON f.connection_id = e.connection_id AND f.endpoint <> e.endpoint
                 WHERE e.port_id IN (",
            );
            {
                let mut sep = q.separated(", ");
                for id in chunk {
                    sep.push_bind(*id);
                }
            }
            q.push(")");
            let rows: Vec<(i64, String, i64, String, i64, String)> =
                crate::routes::ports::from_json_list(
                    q.build_query_scalar().fetch_one(&mut *conn).await?,
                )?;
            for (port, my_side, cid, k, far, far_side) in rows {
                g.add_cable(
                    cid,
                    kind(&k),
                    (port, side(&my_side)),
                    (far, side(&far_side)),
                );
                if seen.insert(far) {
                    next.push(far);
                }
            }
        }
        frontier = next;
    }
    Ok(g)
}

/// "ACME/HQ/2/MDF/RK01/SW01/1 ↔ ACME/HQ/2/MDF/RK01/PP01/1"
pub async fn describe(conn: &mut SqliteConnection, connection_id: i64) -> AppResult<String> {
    let paths: Vec<String> = sqlx::query_scalar(
        "SELECT s.path FROM connection_ends e JOIN search_entries s ON s.kind = 'port' AND s.ref_id = e.port_id
         WHERE e.connection_id = ? ORDER BY e.endpoint",
    )
    .bind(connection_id)
    .fetch_all(conn)
    .await?;
    Ok(paths.join(" ↔ "))
}

/// Removes the cables of `devices`. With `keep_internal`, cables between
/// two of these devices stay (they move together). Returns a description
/// of each cable removed, for the change history.
pub async fn cut(
    conn: &mut SqliteConnection,
    devices: &[i64],
    keep_internal: bool,
) -> AppResult<Vec<String>> {
    if devices.is_empty() {
        return Ok(vec![]);
    }
    let mut q: QueryBuilder<Sqlite> = QueryBuilder::new(
        "SELECT c.id, (SELECT COUNT(*) FROM connection_ends x JOIN ports y ON y.id = x.port_id
                       WHERE x.connection_id = c.id AND y.device_id IN (",
    );
    {
        let mut sep = q.separated(", ");
        for id in devices {
            sep.push_bind(*id);
        }
    }
    q.push(
        ")) AS inside FROM connections c WHERE c.id IN (SELECT e.connection_id FROM connection_ends e
         JOIN ports o ON o.id = e.port_id WHERE o.device_id IN (",
    );
    {
        let mut sep = q.separated(", ");
        for id in devices {
            sep.push_bind(*id);
        }
    }
    q.push(")) ORDER BY c.id");
    let rows: Vec<(i64, i64)> = q.build_query_as().fetch_all(&mut *conn).await?;
    let mut cut = Vec::new();
    for (cid, inside) in rows {
        if keep_internal && inside >= 2 {
            continue;
        }
        cut.push(describe(conn, cid).await?);
        sqlx::query("DELETE FROM connections WHERE id = ?")
            .bind(cid)
            .execute(&mut *conn)
            .await?;
    }
    Ok(cut)
}

/// Number of cables on a device's ports (they're removed with it).
pub async fn count_for_device(conn: &mut SqliteConnection, device_id: i64) -> AppResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(DISTINCT e.connection_id) FROM connection_ends e JOIN ports o ON o.id = e.port_id
         WHERE o.device_id = ?",
    )
    .bind(device_id)
    .fetch_one(conn)
    .await?)
}
