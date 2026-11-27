//! Global search over codes, names, full paths, hostnames, MAC addresses,
//! serial numbers and asset tags, limited to projects the user can read.

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, QueryBuilder, Sqlite};

use crate::auth::CurrentUser;
use crate::domain::permissions::ProjectFilter;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    project_id: Option<i64>,
    kind: Option<String>,
    limit: Option<i64>,
}

#[derive(FromRow, Serialize)]
pub struct Hit {
    kind: String,
    id: i64,
    project_id: i64,
    path: String,
    /// For an IP address: the port or device it's assigned to.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

/// Turns free text into a safe FTS5 query: every word must match, as a
/// prefix. Characters outside the index's token alphabet are dropped, so
/// user input can't use FTS5 syntax.
pub fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split(|c: char| c.is_whitespace() || c == '/')
        .map(|t| {
            t.chars()
                .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
                .collect::<String>()
        })
        .filter(|t| !t.is_empty())
        .take(8)
        .map(|t| format!("\"{t}\"*"))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

pub async fn search(
    State(state): State<AppState>,
    current: CurrentUser,
    Query(q): Query<SearchQuery>,
) -> AppResult<Json<Vec<Hit>>> {
    let Some(fts) = fts_query(&q.q) else {
        return Ok(Json(vec![]));
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let mut b: QueryBuilder<Sqlite> = QueryBuilder::new(
        "SELECT e.kind, e.ref_id AS id, e.project_id, e.path,
                CASE e.kind WHEN 'address' THEN (
                    SELECT COALESCE(ps.path, ds.path) FROM ip_addresses a
                    LEFT JOIN search_entries ps ON ps.kind = 'port' AND ps.ref_id = a.port_id
                    LEFT JOIN search_entries ds ON ds.kind = 'device' AND ds.ref_id = a.device_id
                    WHERE a.id = e.ref_id) END AS detail
         FROM search_fts f JOIN search_entries e ON e.id = f.rowid
         WHERE search_fts MATCH ",
    );
    b.push_bind(fts);
    match current.principal.readable_projects() {
        ProjectFilter::All => {}
        ProjectFilter::Only(ids) => {
            if ids.is_empty() {
                return Ok(Json(vec![]));
            }
            b.push(" AND e.project_id IN (");
            let mut sep = b.separated(", ");
            for id in ids {
                sep.push_bind(id);
            }
            sep.push_unseparated(")");
        }
    }
    if let Some(p) = q.project_id {
        b.push(" AND e.project_id = ").push_bind(p);
    }
    match q.kind {
        Some(kind) => {
            if ![
                "location", "floor", "room", "rack", "device", "port", "prefix", "address",
            ]
            .contains(&kind.as_str())
            {
                return Err(AppError::bad(
                    "kind must be location, floor, room, rack, device, port, prefix or address",
                ));
            }
            b.push(" AND e.kind = ").push_bind(kind);
        }
        // Ports are many and share their device's path; they're only
        // searched when asked for.
        None => {
            b.push(" AND e.kind <> 'port'");
        }
    }
    b.push(" ORDER BY f.rank LIMIT ").push_bind(limit);
    Ok(Json(b.build_query_as().fetch_all(&state.pool).await?))
}

#[cfg(test)]
mod tests {
    use super::fts_query;

    #[test]
    fn builds_safe_prefix_queries() {
        assert_eq!(fts_query("core sw").as_deref(), Some("\"core\"* \"sw\"*"));
        assert_eq!(
            fts_query("HQ/2/MDF").as_deref(),
            Some("\"HQ\"* \"2\"* \"MDF\"*")
        );
        assert_eq!(fts_query("aa:bb:cc").as_deref(), Some("\"aa:bb:cc\"*"));
        assert_eq!(
            fts_query("x\" OR y*").as_deref(),
            Some("\"x\"* \"OR\"* \"y\"*")
        );
        assert_eq!(fts_query("  ()  "), None);
    }
}
