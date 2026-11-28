//! Network discovery: ping sweeps of prefixes and SNMP polls of routers
//! and switches, by hand or on a schedule.
//!
//! What a run finds is recorded in two ways, never as new documentation:
//! documented addresses get "last seen" facts, and anything else goes to
//! the review list (`discovered_hosts`) for someone to document or ignore.
//! Each run writes one audit entry, in the same transaction as its results.

pub mod net;

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, Entry};
use crate::domain::discovery::{access_ports, check_sweep, sweep_targets};
use crate::domain::ip::{parse_cidr, Addr, Cidr};
use crate::error::{AppError, AppResult};
use crate::middleware::RequestCtx;
use crate::state::AppState;
use crate::util::{now_ts, parse_ts, ts_in};
use net::{SnmpAuth, SnmpTarget};

/// Hosts waiting for review are forgotten after this long unseen.
const FORGET_AFTER_DAYS: i64 = 30;
/// Reverse DNS lookups per run, at most.
const MAX_DNS_LOOKUPS: usize = 256;

/// Who started a run.
pub struct Starter {
    pub ctx: RequestCtx,
    pub actor: Option<(i64, String)>,
    pub trigger: &'static str,
}

impl Starter {
    pub fn schedule() -> Starter {
        Starter {
            ctx: RequestCtx {
                request_id: "discovery-schedule".into(),
                ip: None,
                user_agent: Some("rackpath discovery schedule".into()),
            },
            actor: None,
            trigger: "schedule",
        }
    }
}

/// One live address seen by a run.
#[derive(Debug, Clone)]
pub struct Finding {
    pub addr: Addr,
    pub mac: Option<String>,
    pub dns_name: Option<String>,
    pub port: Option<String>,
    pub by_ping: bool,
    pub by_snmp: bool,
}

#[derive(sqlx::FromRow)]
pub struct PrefixTarget {
    pub id: i64,
    pub project_id: i64,
    pub space_id: i64,
    pub cidr: String,
    pub scan_enabled: bool,
}

pub async fn load_prefix_target(conn: &mut SqliteConnection, id: i64) -> AppResult<PrefixTarget> {
    sqlx::query_as::<_, PrefixTarget>(
        "SELECT id, project_id, space_id, cidr, scan_enabled FROM prefixes WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

#[derive(sqlx::FromRow, Clone)]
pub struct SnmpSource {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub version: String,
    pub community_enc: Option<String>,
    pub v3_username: Option<String>,
    pub v3_auth_protocol: Option<String>,
    pub v3_auth_enc: Option<String>,
    pub v3_priv_protocol: Option<String>,
    pub v3_priv_enc: Option<String>,
    pub space_id: Option<i64>,
    pub read_arp: bool,
    pub read_mac_table: bool,
    pub enabled: bool,
    pub poll_interval_minutes: Option<i64>,
    pub last_poll_at: Option<String>,
    pub last_status: Option<String>,
    pub last_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[macro_export]
macro_rules! snmp_source_columns {
    () => {
        "id, project_id, name, host, port, version, community_enc, v3_username, v3_auth_protocol, v3_auth_enc, \
         v3_priv_protocol, v3_priv_enc, space_id, read_arp, read_mac_table, enabled, poll_interval_minutes, \
         last_poll_at, last_status, last_message, created_at, updated_at"
    };
}

pub async fn load_snmp_source(conn: &mut SqliteConnection, id: i64) -> AppResult<SnmpSource> {
    sqlx::query_as::<_, SnmpSource>(concat!(
        "SELECT ",
        snmp_source_columns!(),
        " FROM snmp_sources WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

/// The decrypted target for a source. Secrets stay in memory for one poll.
pub fn snmp_target(state: &AppState, s: &SnmpSource) -> Result<SnmpTarget, String> {
    let ip = crate::domain::discovery::check_snmp_host(&s.host)?;
    let open = |v: &Option<String>| -> Result<Option<String>, String> {
        v.as_deref()
            .map(|e| state.secrets.decrypt(e))
            .transpose()
            .map_err(|_| "A stored credential can't be read (was RACKPATH_ENCRYPTION_KEY changed?); enter it again".to_string())
    };
    let auth = if s.version == "2c" {
        SnmpAuth::V2c {
            community: open(&s.community_enc)?.ok_or("No community string is set")?,
        }
    } else {
        let privacy = match (&s.v3_priv_protocol, open(&s.v3_priv_enc)?) {
            (Some(p), Some(pw)) => Some((p.clone(), pw)),
            _ => None,
        };
        SnmpAuth::V3 {
            username: s.v3_username.clone().ok_or("No SNMPv3 user is set")?,
            auth_protocol: s
                .v3_auth_protocol
                .clone()
                .unwrap_or_else(|| "sha256".into()),
            auth_password: open(&s.v3_auth_enc)?.ok_or("No authentication password is set")?,
            privacy,
        }
    };
    Ok(SnmpTarget {
        ip,
        port: s.port.clamp(1, 65535) as u16,
        auth,
        read_arp: s.read_arp,
        read_mac_table: s.read_mac_table,
    })
}

pub async fn default_space(conn: &mut SqliteConnection, project_id: i64) -> AppResult<i64> {
    sqlx::query_scalar("SELECT id FROM address_spaces WHERE project_id = ? AND is_default = 1")
        .bind(project_id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| AppError::internal("project has no default address space"))
}

/// Opens a run row and returns its id.
pub async fn open_run(
    state: &AppState,
    project_id: i64,
    prefix_id: Option<i64>,
    snmp_source_id: Option<i64>,
    trigger: &str,
) -> AppResult<i64> {
    Ok(sqlx::query(
        "INSERT INTO discovery_runs (project_id, prefix_id, snmp_source_id, trigger, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)",
    )
    .bind(project_id)
    .bind(prefix_id)
    .bind(snmp_source_id)
    .bind(trigger)
    .bind(now_ts())
    .execute(&state.pool)
    .await?
    .last_insert_rowid())
}

async fn fail_run(state: &AppState, run_id: i64, message: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE discovery_runs SET status = 'failed', finished_at = ?, message = ? WHERE id = ?",
    )
    .bind(now_ts())
    .bind(message)
    .bind(run_id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// Runs left "running" by a restart can't finish; marks them failed.
pub async fn close_interrupted_runs(pool: &sqlx::SqlitePool) -> AppResult<()> {
    sqlx::query(
        "UPDATE discovery_runs SET status = 'failed', finished_at = ?, message = 'Rackpath restarted during the run'
         WHERE status = 'running'",
    )
    .bind(now_ts())
    .execute(pool)
    .await?;
    Ok(())
}

/// Adds reverse DNS names to findings that are not documented yet.
async fn add_dns_names(state: &AppState, findings: &mut [Finding], documented: &[Vec<u8>]) {
    let mut looked = 0;
    for f in findings.iter_mut() {
        if f.dns_name.is_some() || documented.contains(&f.addr.bin()) {
            continue;
        }
        if looked >= MAX_DNS_LOOKUPS {
            break;
        }
        looked += 1;
        f.dns_name = state.network.reverse_dns(f.addr.ip()).await;
    }
}

async fn documented_in(
    conn: &mut SqliteConnection,
    space_id: i64,
    findings: &[Finding],
) -> AppResult<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    for f in findings {
        let hit: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM ip_addresses WHERE space_id = ? AND addr_bin = ?")
                .bind(space_id)
                .bind(f.addr.bin())
                .fetch_optional(&mut *conn)
                .await?;
        if hit.is_some() {
            out.push(f.addr.bin());
        }
    }
    Ok(out)
}

pub struct Outcome {
    pub found: i64,
    pub new_hosts: i64,
}

/// Saves what a run found, its audit entry and its result, in one
/// transaction. `ports` (MAC → port) also updates documented addresses and
/// review entries by MAC.
#[allow(clippy::too_many_arguments)]
async fn record(
    state: &AppState,
    who: &Starter,
    run_id: i64,
    project_id: i64,
    space_id: i64,
    probed: i64,
    findings: &[Finding],
    ports: &HashMap<String, String>,
    resource: (&str, i64, String),
) -> AppResult<Outcome> {
    let now = now_ts();
    let mut tx = state.pool.begin().await?;
    let mut new_hosts = 0;
    for f in findings {
        let updated = sqlx::query(
            "UPDATE ip_addresses SET last_seen_at = ?, last_seen_mac = COALESCE(?, last_seen_mac),
             last_seen_port = COALESCE(?, last_seen_port) WHERE space_id = ? AND addr_bin = ?",
        )
        .bind(&now)
        .bind(&f.mac)
        .bind(&f.port)
        .bind(space_id)
        .bind(f.addr.bin())
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if updated > 0 {
            continue;
        }
        let existed: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM discovered_hosts WHERE space_id = ? AND addr_bin = ?",
        )
        .bind(space_id)
        .bind(f.addr.bin())
        .fetch_optional(&mut *tx)
        .await?;
        if existed.is_none() {
            new_hosts += 1;
        }
        sqlx::query(
            "INSERT INTO discovered_hosts (project_id, space_id, address, family, addr_bin, mac, dns_name, switch_port,
             seen_by_ping, seen_by_snmp, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (space_id, addr_bin) DO UPDATE SET
               mac = COALESCE(excluded.mac, mac), dns_name = COALESCE(excluded.dns_name, dns_name),
               switch_port = COALESCE(excluded.switch_port, switch_port),
               seen_by_ping = max(seen_by_ping, excluded.seen_by_ping),
               seen_by_snmp = max(seen_by_snmp, excluded.seen_by_snmp),
               last_seen_at = excluded.last_seen_at",
        )
        .bind(project_id)
        .bind(space_id)
        .bind(f.addr.to_string())
        .bind(f.addr.family().number())
        .bind(f.addr.bin())
        .bind(&f.mac)
        .bind(&f.dns_name)
        .bind(&f.port)
        .bind(f.by_ping)
        .bind(f.by_snmp)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    // Switch ports for MACs whose address came from elsewhere.
    for (mac, port) in ports {
        sqlx::query(
            "UPDATE ip_addresses SET last_seen_port = ? WHERE space_id = ? AND (mac = ?3 OR last_seen_mac = ?3)",
        )
        .bind(port)
        .bind(space_id)
        .bind(mac)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE discovered_hosts SET switch_port = ? WHERE space_id = ? AND mac = ?")
            .bind(port)
            .bind(space_id)
            .bind(mac)
            .execute(&mut *tx)
            .await?;
    }
    let forgotten = sqlx::query(
        "DELETE FROM discovered_hosts WHERE project_id = ? AND state = 'new' AND last_seen_at < ?",
    )
    .bind(project_id)
    .bind(ts_in(time::Duration::days(-FORGET_AFTER_DAYS)))
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let found = findings.len() as i64;
    sqlx::query(
        "UPDATE discovery_runs SET status = 'success', finished_at = ?, probed = ?, found = ?, new_hosts = ? WHERE id = ?",
    )
    .bind(&now)
    .bind(probed)
    .bind(found)
    .bind(new_hosts)
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    let (rtype, rid, path) = resource;
    audit::record(
        &mut tx,
        &who.ctx,
        who.actor.as_ref().map(|(i, n)| (*i, n.as_str())),
        Entry::new("sync", rtype, Some(rid))
            .path(path)
            .project(Some(project_id))
            .changes(json!({
                "trigger": who.trigger, "run_id": run_id, "probed": probed, "found": found,
                "new_hosts": new_hosts, "ports": ports.len(), "forgotten": forgotten,
            })),
    )
    .await?;
    tx.commit().await?;
    Ok(Outcome { found, new_hosts })
}

// ---------------------------------------------------------------- ping sweeps

/// Sweeps a prefix. The caller holds the discovery lock and opened the run.
pub async fn sweep_prefix(state: &AppState, p: &PrefixTarget, run_id: i64, who: &Starter) {
    let result = sweep_inner(state, p, run_id, who).await;
    let message = match &result {
        Ok(_) => None,
        Err(e) => Some(e.clone()),
    };
    if let Some(m) = &message {
        if let Err(e) = fail_run(state, run_id, m).await {
            tracing::warn!(error = %e, "couldn't record a failed scan");
        }
    }
    if let Err(e) = sqlx::query("UPDATE prefixes SET last_scan_at = ? WHERE id = ?")
        .bind(now_ts())
        .bind(p.id)
        .execute(&state.pool)
        .await
    {
        tracing::warn!(error = %e, "couldn't record the scan time");
    }
}

async fn sweep_inner(
    state: &AppState,
    p: &PrefixTarget,
    run_id: i64,
    who: &Starter,
) -> Result<Outcome, String> {
    let c: Cidr = parse_cidr(&p.cidr)?;
    check_sweep(&c)?;
    let targets = sweep_targets(&c);
    let probed = targets.len() as i64;
    let up = state.network.sweep(targets).await?;
    let mut findings: Vec<Finding> = up
        .into_iter()
        .map(|ip| Finding {
            addr: Addr::from_ip(IpAddr::V4(ip)),
            mac: None,
            dns_name: None,
            port: None,
            by_ping: true,
            by_snmp: false,
        })
        .filter(|f| c.contains(f.addr))
        .collect();
    let documented = {
        let mut conn = state.pool.acquire().await.map_err(|e| e.to_string())?;
        documented_in(&mut conn, p.space_id, &findings)
            .await
            .map_err(|e| e.to_string())?
    };
    add_dns_names(state, &mut findings, &documented).await;
    record(
        state,
        who,
        run_id,
        p.project_id,
        p.space_id,
        probed,
        &findings,
        &HashMap::new(),
        ("prefix", p.id, p.cidr.clone()),
    )
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- SNMP polls

/// Polls an SNMP source. The caller holds the discovery lock and opened the run.
pub async fn poll_source(state: &AppState, s: &SnmpSource, run_id: i64, who: &Starter) {
    let result = poll_inner(state, s, run_id, who).await;
    let (status, message) = match &result {
        Ok(o) => (
            "success",
            format!("{} addresses seen, {} new", o.found, o.new_hosts),
        ),
        Err(e) => ("failed", e.clone()),
    };
    if result.is_err() {
        if let Err(e) = fail_run(state, run_id, &message).await {
            tracing::warn!(error = %e, "couldn't record a failed poll");
        }
    }
    if let Err(e) = sqlx::query(
        "UPDATE snmp_sources SET last_poll_at = ?, last_status = ?, last_message = ? WHERE id = ?",
    )
    .bind(now_ts())
    .bind(status)
    .bind(&message)
    .bind(s.id)
    .execute(&state.pool)
    .await
    {
        tracing::warn!(error = %e, "couldn't record the poll result");
    }
}

async fn poll_inner(
    state: &AppState,
    s: &SnmpSource,
    run_id: i64,
    who: &Starter,
) -> Result<Outcome, String> {
    let target = snmp_target(state, s)?;
    let tables = state.network.snmp(target).await?;
    let mut conn = state.pool.acquire().await.map_err(|e| e.to_string())?;
    let space_id = match s.space_id {
        Some(id) => id,
        None => default_space(&mut conn, s.project_id)
            .await
            .map_err(|e| e.to_string())?,
    };
    // Only addresses inside a documented prefix of the space are kept.
    let cidrs: Vec<String> = sqlx::query_scalar("SELECT cidr FROM prefixes WHERE space_id = ?")
        .bind(space_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let prefixes: Vec<Cidr> = cidrs.iter().filter_map(|c| parse_cidr(c).ok()).collect();
    let ports = access_ports(&tables.fdb);
    let switch = tables.sys_name.clone().unwrap_or_else(|| s.name.clone());
    let ports: HashMap<String, String> = ports
        .into_iter()
        .map(|(mac, port)| (mac, format!("{switch} {port}")))
        .collect();
    let mut findings: Vec<Finding> = tables
        .arp
        .iter()
        .map(|(ip, mac)| Finding {
            addr: Addr::from_ip(*ip),
            mac: Some(mac.clone()),
            dns_name: None,
            port: ports.get(mac).cloned(),
            by_ping: false,
            by_snmp: true,
        })
        .filter(|f| prefixes.iter().any(|c| c.contains(f.addr)) && !f.addr.is_public())
        .collect();
    let documented = documented_in(&mut conn, space_id, &findings)
        .await
        .map_err(|e| e.to_string())?;
    drop(conn);
    add_dns_names(state, &mut findings, &documented).await;
    record(
        state,
        who,
        run_id,
        s.project_id,
        space_id,
        (tables.arp.len() + tables.fdb.len()) as i64,
        &findings,
        &ports,
        ("snmp_source", s.id, s.name.clone()),
    )
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- schedule

/// Runs due scheduled sweeps and polls every minute.
pub fn start_schedule(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            if let Err(e) = run_due(&state).await {
                tracing::warn!(error = %e, "discovery schedule check failed");
            }
        }
    });
}

fn due(last: Option<&str>, interval: Option<i64>) -> bool {
    let Some(minutes) = interval else {
        return false;
    };
    match last.and_then(parse_ts) {
        None => true,
        Some(t) => time::OffsetDateTime::now_utc() - t >= time::Duration::minutes(minutes),
    }
}

pub async fn run_due(state: &AppState) -> AppResult<usize> {
    let prefixes: Vec<(i64, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT id, last_scan_at, scan_interval_minutes FROM prefixes
         WHERE scan_enabled = 1 AND scan_interval_minutes IS NOT NULL",
    )
    .fetch_all(&state.pool)
    .await?;
    let sources: Vec<(i64, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT id, last_poll_at, poll_interval_minutes FROM snmp_sources
         WHERE enabled = 1 AND poll_interval_minutes IS NOT NULL",
    )
    .fetch_all(&state.pool)
    .await?;
    let mut ran = 0;
    let who = Starter::schedule();
    for (id, last, every) in prefixes {
        if !due(last.as_deref(), every) {
            continue;
        }
        let _guard = state.discovery_lock.lock().await;
        let p = load_prefix_target(&mut *state.pool.acquire().await?, id).await?;
        if !p.scan_enabled {
            continue;
        }
        let run = open_run(state, p.project_id, Some(p.id), None, "schedule").await?;
        sweep_prefix(state, &p, run, &who).await;
        ran += 1;
    }
    for (id, last, every) in sources {
        if !due(last.as_deref(), every) {
            continue;
        }
        let _guard = state.discovery_lock.lock().await;
        let s = load_snmp_source(&mut *state.pool.acquire().await?, id).await?;
        if !s.enabled {
            continue;
        }
        let run = open_run(state, s.project_id, None, Some(s.id), "schedule").await?;
        poll_source(state, &s, run, &who).await;
        ran += 1;
    }
    Ok(ran)
}

#[cfg(test)]
mod tests {
    use super::due;
    use crate::util::ts_in;

    #[test]
    fn schedules_fall_due() {
        assert!(!due(None, None), "no schedule: never");
        assert!(due(None, Some(60)), "never ran: now");
        let recent = ts_in(time::Duration::minutes(-30));
        assert!(!due(Some(&recent), Some(60)));
        let old = ts_in(time::Duration::minutes(-61));
        assert!(due(Some(&old), Some(60)));
    }
}
