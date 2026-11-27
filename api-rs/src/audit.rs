//! The change history (design section 11). Entries are written inside the
//! same transaction as the change, so a rolled-back change leaves no entry.

use serde_json::{Map, Value};
use sqlx::SqliteConnection;

use crate::error::AppResult;
use crate::middleware::RequestCtx;
use crate::util::now_ts;

pub const REDACTED: &str = "•••";

pub struct Entry<'a> {
    pub action: &'a str,
    pub resource_type: &'a str,
    pub resource_id: Option<i64>,
    pub resource_path: Option<String>,
    pub project_id: Option<i64>,
    pub changes: Option<Value>,
}

impl<'a> Entry<'a> {
    pub fn new(action: &'a str, resource_type: &'a str, resource_id: Option<i64>) -> Entry<'a> {
        Entry {
            action,
            resource_type,
            resource_id,
            resource_path: None,
            project_id: None,
            changes: None,
        }
    }
    pub fn path(mut self, path: impl Into<String>) -> Self {
        self.resource_path = Some(path.into());
        self
    }
    pub fn project(mut self, project_id: Option<i64>) -> Self {
        self.project_id = project_id;
        self
    }
    pub fn changes(mut self, changes: Value) -> Self {
        self.changes = Some(changes);
        self
    }
}

/// Records one entry. `actor` is (user id, username); None for the system.
pub async fn record(
    conn: &mut SqliteConnection,
    ctx: &RequestCtx,
    actor: Option<(i64, &str)>,
    entry: Entry<'_>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO audit_log (at, user_id, username, project_id, action, resource_type, resource_id,
                                resource_path, changes, request_id, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(now_ts())
    .bind(actor.map(|a| a.0))
    .bind(actor.map(|a| a.1))
    .bind(entry.project_id)
    .bind(entry.action)
    .bind(entry.resource_type)
    .bind(entry.resource_id)
    .bind(entry.resource_path)
    .bind(entry.changes.map(|c| c.to_string()))
    .bind(&ctx.request_id)
    .bind(&ctx.ip)
    .bind(&ctx.user_agent)
    .execute(conn)
    .await?;
    Ok(())
}

/// `{"field": [old, new]}` for every field whose value changed. Fields named
/// in `secret_fields` are recorded as changed without their values.
pub fn diff(old: &Value, new: &Value, secret_fields: &[&str]) -> Value {
    let mut out = Map::new();
    let (Some(old), Some(new)) = (old.as_object(), new.as_object()) else {
        return Value::Object(out);
    };
    for (key, new_value) in new {
        let old_value = old.get(key).unwrap_or(&Value::Null);
        if old_value != new_value {
            let pair = if secret_fields.contains(&key.as_str()) {
                Value::Array(vec![Value::from(REDACTED), Value::from(REDACTED)])
            } else {
                Value::Array(vec![old_value.clone(), new_value.clone()])
            };
            out.insert(key.clone(), pair);
        }
    }
    Value::Object(out)
}

/// Deletes entries older than the retention window, if one is configured.
pub async fn apply_retention(conn: &mut SqliteConnection, days: Option<u32>) -> AppResult<u64> {
    let Some(days) = days else { return Ok(0) };
    let cutoff = crate::util::ts_in(-time::Duration::days(i64::from(days)));
    let result = sqlx::query("DELETE FROM audit_log WHERE at < ?")
        .bind(cutoff)
        .execute(conn)
        .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn diff_lists_changes_and_redacts_secrets() {
        let old = json!({"name": "A", "email": "a@x", "password": "old"});
        let new = json!({"name": "B", "email": "a@x", "password": "new"});
        let d = diff(&old, &new, &["password"]);
        assert_eq!(
            d,
            json!({"name": ["A", "B"], "password": [REDACTED, REDACTED]})
        );
    }
}
