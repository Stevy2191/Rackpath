//! Merges a [`Snapshot`] into the documentation (ownership rules in
//! `imports/mod.rs`). Runs inside the caller's transaction; the caller
//! decides whether to commit, roll back (dry run / held), and audits.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use sqlx::{FromRow, SqliteConnection};

use super::{Snapshot, SrcDevice, SrcNetwork, SrcWlan};
use crate::domain::ip::{parse_addr, parse_cidr, Addr, Cidr};
use crate::domain::naming::{code_from_name, is_auto_code, next_free_code, unique_variant};
use crate::error::AppResult;
use crate::hierarchy::{self, Subtree};
use crate::routes::ipam::check_dns_name;
use crate::util::now_ts;

pub struct Target {
    pub integration_id: i64,
    pub project_id: i64,
    pub space_id: i64,
    /// Whether the snapshot shows every address this source knows about
    /// (false for a DHCP-only XML upload on a DNS-pushing integration), so
    /// unseen owned addresses can be marked missing.
    pub full_addresses: bool,
    /// Delete owned records once they're missing at the source, instead of
    /// only marking them (an option per integration).
    pub remove_missing: bool,
}

#[derive(Serialize, Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub created: usize,
    pub updated: usize,
    pub missing: usize,
    pub restored: usize,
    /// Deleted because they're gone from the source (remove_missing).
    pub removed: usize,
}

#[derive(Serialize, Default, Debug)]
pub struct Report {
    pub counts: BTreeMap<&'static str, Counts>,
    pub vlans_created: usize,
    pub leases: Option<usize>,
    /// Records this integration owned before the run.
    pub owned_before: usize,
    pub warnings: Vec<String>,
    /// Records removed that were already marked missing before this run
    /// (the newly missing ones are counted in `newly_missing`).
    pub removed_earlier: usize,
    /// What changed, for the change history (capped).
    pub changes: Vec<String>,
}

impl Report {
    fn c(&mut self, kind: &'static str) -> &mut Counts {
        self.counts.entry(kind).or_default()
    }
    fn note(&mut self, s: String) {
        if self.changes.len() < 500 {
            self.changes.push(s);
        }
    }
    fn warn(&mut self, s: String) {
        if self.warnings.len() < 500 {
            self.warnings.push(s);
        }
    }
    /// Updated + restored records, for the hold rule.
    pub fn changed(&self) -> usize {
        self.counts.values().map(|c| c.updated + c.restored).sum()
    }
    /// Records that leave the documentation or get marked: newly missing
    /// ones, plus earlier-missing ones this run deletes. For the hold rule.
    pub fn newly_missing(&self) -> usize {
        self.counts.values().map(|c| c.missing).sum::<usize>() + self.removed_earlier
    }
}

/// Splits a DHCP pool around exclusions: Rackpath ranges don't overlap, and
/// Windows exclusions sit inside the scope's range.
pub fn subtract(pool: (Addr, Addr), exclusions: &[(Addr, Addr)]) -> Vec<(Addr, Addr)> {
    let mut parts = vec![pool];
    for &(xs, xe) in exclusions {
        let mut next = Vec::new();
        for (s, e) in parts {
            if xe < s || xs > e || xs.v6 != s.v6 {
                next.push((s, e));
                continue;
            }
            if xs > s {
                next.push((
                    s,
                    Addr {
                        value: xs.value - 1,
                        v6: s.v6,
                    },
                ));
            }
            if xe < e {
                next.push((
                    Addr {
                        value: xe.value + 1,
                        v6: s.v6,
                    },
                    e,
                ));
            }
        }
        parts = next;
    }
    parts
}

pub async fn owned_count(conn: &mut SqliteConnection, integration_id: i64) -> AppResult<usize> {
    let n: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM devices WHERE source_integration_id = ?1)
              + (SELECT COUNT(*) FROM prefixes WHERE source_integration_id = ?1)
              + (SELECT COUNT(*) FROM ip_ranges WHERE source_integration_id = ?1)
              + (SELECT COUNT(*) FROM ip_addresses WHERE source_integration_id = ?1)
              + (SELECT COUNT(*) FROM wlans WHERE source_integration_id = ?1)",
    )
    .bind(integration_id)
    .fetch_one(conn)
    .await?;
    Ok(n as usize)
}

pub async fn apply(conn: &mut SqliteConnection, t: &Target, snap: &Snapshot) -> AppResult<Report> {
    let mut r = Report {
        owned_before: owned_count(conn, t.integration_id).await?,
        ..Default::default()
    };
    let now = now_ts();
    let mut seen_addresses: HashSet<String> = HashSet::new();

    if snap.covers.devices {
        devices(conn, t, &snap.devices, &now, &mut r, &mut seen_addresses).await?;
    }
    if snap.covers.networks {
        networks(conn, t, &snap.networks, &now, &mut r).await?;
    }
    if snap.covers.wlans {
        wlans(conn, t, &snap.wlans, &now, &mut r).await?;
    }
    if snap.covers.reservations {
        for res in &snap.reservations {
            let Ok(a) = parse_addr(&res.ip) else {
                r.warn(format!("Reservation {} isn't an IP address", res.ip));
                continue;
            };
            let name = res.name.as_deref().and_then(|n| check_dns_name(n).ok());
            let description = res.description.clone().or(if name.is_none() {
                res.name.clone()
            } else {
                None
            });
            // Pools are applied above, so a fixed IP can be placed now.
            let in_pool = !res.static_outside_pools || {
                let found: Option<i64> = sqlx::query_scalar(
                    "SELECT r.id FROM ip_ranges r JOIN prefixes p ON p.id = r.prefix_id
                     WHERE r.kind = 'dhcp_pool' AND p.space_id = ? AND p.family = ?
                     AND ? BETWEEN r.start_bin AND r.end_bin LIMIT 1",
                )
                .bind(t.space_id)
                .bind(a.family().number())
                .bind(a.bin())
                .fetch_optional(&mut *conn)
                .await?;
                found.is_some()
            };
            let facts = AddressFacts {
                mac: res.mac.clone(),
                reservation: in_pool,
                dns_name: name,
                aliases: None,
                description,
                device_id: None,
                not_reservation: !in_pool,
            };
            upsert_address(conn, t, a, facts, &now, &mut r).await?;
            seen_addresses.insert(a.to_string());
        }
    }
    if snap.covers.dns {
        dns(conn, t, snap, &now, &mut r, &mut seen_addresses).await?;
    }
    if t.full_addresses {
        mark_missing(conn, "address", t, &seen_addresses, &now, &mut r).await?;
    }
    if let Some(leases) = &snap.leases {
        sqlx::query("DELETE FROM dhcp_lease_snapshots WHERE integration_id = ?")
            .bind(t.integration_id)
            .execute(&mut *conn)
            .await?;
        let mut n = 0;
        for l in leases.iter().take(100_000) {
            let Ok(a) = parse_addr(&l.ip) else { continue };
            sqlx::query(
                "INSERT INTO dhcp_lease_snapshots (integration_id, space_id, address, family, addr_bin, mac, hostname,
                 expires_at, state, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(t.integration_id)
            .bind(t.space_id)
            .bind(a.to_string())
            .bind(a.family().number())
            .bind(a.bin())
            .bind(&l.mac)
            .bind(&l.hostname)
            .bind(&l.expires_at)
            .bind(&l.state)
            .bind(&now)
            .execute(&mut *conn)
            .await?;
            n += 1;
        }
        r.leases = Some(n);
    }
    if t.remove_missing {
        remove_missing(conn, t, &now, &mut r).await?;
    }
    Ok(r)
}

/// Deletes the records this integration owns that are missing at the
/// source. A device with documented cables or devices on it is kept (still
/// marked missing), since deleting it would lose work done by hand.
async fn remove_missing(
    conn: &mut SqliteConnection,
    t: &Target,
    now: &str,
    r: &mut Report,
) -> AppResult<()> {
    let devices: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, code, missing_from_source_at FROM devices
         WHERE source_integration_id = ? AND missing_from_source_at IS NOT NULL",
    )
    .bind(t.integration_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, code, since) in devices {
        let cables = crate::cabling::count_for_device(&mut *conn, id).await?;
        let contents: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE parent_device_id = ?")
                .bind(id)
                .fetch_one(&mut *conn)
                .await?;
        if cables > 0 || contents > 0 {
            r.warn(format!(
                "device {code} is gone from the source but kept: it has documented cables or devices on it; delete it by hand"
            ));
            continue;
        }
        sqlx::query("DELETE FROM devices WHERE id = ?")
            .bind(id)
            .execute(&mut *conn)
            .await?;
        hierarchy::drop_subtree(&mut *conn, Subtree::Device(id)).await?;
        removed(
            r,
            "device",
            &since,
            now,
            format!("removed device {code} (gone from the source)"),
        );
    }
    let wlans: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, ssid, missing_from_source_at FROM wlans
         WHERE source_integration_id = ? AND missing_from_source_at IS NOT NULL",
    )
    .bind(t.integration_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, ssid, since) in wlans {
        sqlx::query("DELETE FROM wlans WHERE id = ?")
            .bind(id)
            .execute(&mut *conn)
            .await?;
        removed(
            r,
            "wlan",
            &since,
            now,
            format!("removed Wi-Fi network {ssid} (gone from the source)"),
        );
    }
    let ranges: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, start_text || '-' || end_text, missing_from_source_at FROM ip_ranges
         WHERE source_integration_id = ? AND missing_from_source_at IS NOT NULL",
    )
    .bind(t.integration_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, label, since) in ranges {
        sqlx::query("DELETE FROM ip_ranges WHERE id = ?")
            .bind(id)
            .execute(&mut *conn)
            .await?;
        removed(
            r,
            "range",
            &since,
            now,
            format!("removed range {label} (gone from the source)"),
        );
    }
    let addresses: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, address, missing_from_source_at FROM ip_addresses
         WHERE source_integration_id = ? AND missing_from_source_at IS NOT NULL",
    )
    .bind(t.integration_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, address, since) in addresses {
        sqlx::query("DELETE FROM ip_addresses WHERE id = ?")
            .bind(id)
            .execute(&mut *conn)
            .await?;
        hierarchy::reindex(&mut *conn, Subtree::Address(id)).await?;
        removed(
            r,
            "address",
            &since,
            now,
            format!("removed address {address} (gone from the source)"),
        );
    }
    // Prefixes last: their ranges go with them; documented addresses stay.
    let prefixes: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, cidr, missing_from_source_at FROM prefixes
         WHERE source_integration_id = ? AND missing_from_source_at IS NOT NULL",
    )
    .bind(t.integration_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, cidr, since) in prefixes {
        sqlx::query("DELETE FROM prefixes WHERE id = ?")
            .bind(id)
            .execute(&mut *conn)
            .await?;
        hierarchy::reindex(&mut *conn, Subtree::Prefix(id)).await?;
        removed(
            r,
            "prefix",
            &since,
            now,
            format!("removed prefix {cidr} (gone from the source)"),
        );
    }
    Ok(())
}

fn removed(r: &mut Report, kind: &'static str, since: &str, now: &str, note: String) {
    r.c(kind).removed += 1;
    if since != now {
        r.removed_earlier += 1;
    }
    r.note(note);
}

// ---------------------------------------------------------------- devices

#[derive(FromRow)]
struct OwnedDevice {
    id: i64,
    external_id: Option<String>,
    missing_from_source_at: Option<String>,
    hostname: Option<String>,
    mac: Option<String>,
    manufacturer: Option<String>,
    model: Option<String>,
    serial_number: Option<String>,
    firmware: Option<String>,
    external_url: Option<String>,
    code: String,
}

async fn devices(
    conn: &mut SqliteConnection,
    t: &Target,
    list: &[SrcDevice],
    now: &str,
    r: &mut Report,
    seen_addresses: &mut HashSet<String>,
) -> AppResult<()> {
    let owned: Vec<OwnedDevice> = sqlx::query_as(
        "SELECT id, external_id, missing_from_source_at, hostname, mac, manufacturer, model, serial_number, firmware,
                external_url, code FROM devices WHERE source_integration_id = ?",
    )
    .bind(t.integration_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut by_ext: HashMap<String, OwnedDevice> = owned
        .into_iter()
        .filter_map(|d| Some((d.external_id.clone()?, d)))
        .collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut types: HashMap<String, (i64, String)> = HashMap::new();

    for d in list {
        if !seen.insert(d.external_id.clone()) {
            continue;
        }
        let device_id = if let Some(o) = by_ext.remove(&d.external_id) {
            let differs = o.hostname != d.hostname
                || o.mac != d.mac
                || o.manufacturer != d.manufacturer
                || o.model != d.model
                || o.serial_number != d.serial
                || o.firmware != d.firmware
                || o.external_url != d.external_url;
            if differs {
                set_device_facts(conn, o.id, d, now).await?;
                r.c("device").updated += 1;
                r.note(format!("updated device {}", o.code));
            }
            if o.missing_from_source_at.is_some() {
                sqlx::query("UPDATE devices SET missing_from_source_at = NULL WHERE id = ?")
                    .bind(o.id)
                    .execute(&mut *conn)
                    .await?;
                r.c("device").restored += 1;
                r.note(format!("device {} is back at the source", o.code));
            }
            // A device still on an automatic code (AP01) takes one from its
            // source name; a code people chose is never changed.
            let renamed = rename_from_name(conn, o.id, &o.code, d.name.as_deref(), now).await?;
            if let Some(new) = &renamed {
                if !differs {
                    r.c("device").updated += 1;
                }
                r.note(format!("renamed device {} to {new}", o.code));
            }
            if differs || renamed.is_some() {
                hierarchy::reindex_device_tree(conn, o.id).await?;
            }
            o.id
        } else {
            // Adopt a hand-made device with the same MAC rather than duplicate it.
            let adopt: Vec<(i64, String)> = match &d.mac {
                Some(m) => sqlx::query_as(
                    "SELECT id, code FROM devices WHERE project_id = ? AND mac = ? AND source_integration_id IS NULL",
                )
                .bind(t.project_id)
                .bind(m)
                .fetch_all(&mut *conn)
                .await?,
                None => vec![],
            };
            if let [(id, code)] = adopt.as_slice() {
                sqlx::query("UPDATE devices SET source_integration_id = ?, external_id = ?, source = 'integration' WHERE id = ?")
                    .bind(t.integration_id)
                    .bind(&d.external_id)
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
                set_device_facts(conn, *id, d, now).await?;
                hierarchy::reindex_device_tree(conn, *id).await?;
                r.c("device").updated += 1;
                r.note(format!("linked device {code} to the source by its MAC"));
                *id
            } else {
                let (type_id, prefix) = match types.get(&d.type_key) {
                    Some(v) => v.clone(),
                    None => {
                        let found: Option<(i64, String)> = sqlx::query_as(
                            "SELECT id, prefix FROM device_types WHERE project_id = ? AND key IN (?, 'misc')
                             ORDER BY key = ? DESC LIMIT 1",
                        )
                        .bind(t.project_id)
                        .bind(&d.type_key)
                        .bind(&d.type_key)
                        .fetch_optional(&mut *conn)
                        .await?;
                        let Some(v) = found else {
                            r.warn(format!("No device type {} in the project", d.type_key));
                            continue;
                        };
                        types.insert(d.type_key.clone(), v.clone());
                        v
                    }
                };
                let taken: Vec<String> =
                    sqlx::query_scalar("SELECT code FROM devices WHERE parent_key = ?")
                        .bind(format!("u:{}", t.project_id))
                        .fetch_all(&mut *conn)
                        .await?;
                // A code from the source's name ("Living Room AP" becomes
                // LIVING-ROOM-AP), else the type's next code (AP01).
                let code = match d.name.as_deref().and_then(code_from_name) {
                    Some(c) => unique_variant(&c, &taken),
                    None => next_free_code(&prefix, &taken),
                };
                let id = sqlx::query(
                    "INSERT INTO devices (project_id, device_type_id, code, name, hostname, mac, manufacturer, model,
                     serial_number, firmware, external_url, source, external_id, source_integration_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'integration', ?, ?, ?, ?)",
                )
                .bind(t.project_id)
                .bind(type_id)
                .bind(&code)
                .bind(&d.name)
                .bind(&d.hostname)
                .bind(&d.mac)
                .bind(&d.manufacturer)
                .bind(&d.model)
                .bind(&d.serial)
                .bind(&d.firmware)
                .bind(&d.external_url)
                .bind(&d.external_id)
                .bind(t.integration_id)
                .bind(now)
                .bind(now)
                .execute(&mut *conn)
                .await?
                .last_insert_rowid();
                hierarchy::reindex(conn, Subtree::Device(id)).await?;
                r.c("device").created += 1;
                r.note(format!(
                    "added device {code} ({})",
                    d.name.as_deref().unwrap_or(&d.external_id)
                ));
                id
            }
        };
        for ip in &d.ips {
            let Ok(a) = parse_addr(ip) else {
                r.warn(format!("{}: {ip} isn't an IP address", d.external_id));
                continue;
            };
            let facts = AddressFacts {
                device_id: Some(device_id),
                ..Default::default()
            };
            upsert_address(conn, t, a, facts, now, r).await?;
            seen_addresses.insert(a.to_string());
        }
    }
    // Owned devices not seen this time.
    for (_, o) in by_ext {
        if o.missing_from_source_at.is_none() {
            sqlx::query("UPDATE devices SET missing_from_source_at = ? WHERE id = ?")
                .bind(now)
                .bind(o.id)
                .execute(&mut *conn)
                .await?;
            r.c("device").missing += 1;
            r.note(format!("device {} is no longer at the source", o.code));
        }
    }
    Ok(())
}

/// Gives a device on an automatic code (its type's prefix and digits) a
/// code made from `name`, unique among its siblings. Returns the new code.
async fn rename_from_name(
    conn: &mut SqliteConnection,
    id: i64,
    code: &str,
    name: Option<&str>,
    now: &str,
) -> AppResult<Option<String>> {
    let Some(wanted) = name.and_then(code_from_name) else {
        return Ok(None);
    };
    let (parent_key, prefix): (String, String) = sqlx::query_as(
        "SELECT d.parent_key, t.prefix FROM devices d JOIN device_types t ON t.id = d.device_type_id WHERE d.id = ?",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    if !is_auto_code(code, &prefix) {
        return Ok(None);
    }
    let taken: Vec<String> = hierarchy::sibling_codes(conn, &parent_key)
        .await?
        .into_iter()
        .filter(|c| !c.eq_ignore_ascii_case(code))
        .collect();
    let new = unique_variant(&wanted, &taken);
    if new.eq_ignore_ascii_case(code) {
        return Ok(None);
    }
    sqlx::query("UPDATE devices SET code = ?, updated_at = ? WHERE id = ?")
        .bind(&new)
        .bind(now)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(Some(new))
}

async fn set_device_facts(
    conn: &mut SqliteConnection,
    id: i64,
    d: &SrcDevice,
    now: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE devices SET hostname = ?, mac = ?, manufacturer = ?, model = ?, serial_number = ?, firmware = ?,
         external_url = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&d.hostname)
    .bind(&d.mac)
    .bind(&d.manufacturer)
    .bind(&d.model)
    .bind(&d.serial)
    .bind(&d.firmware)
    .bind(&d.external_url)
    .bind(now)
    .bind(id)
    .execute(conn)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------- Wi-Fi

#[derive(FromRow)]
struct OwnedWlan {
    id: i64,
    external_id: Option<String>,
    missing_from_source_at: Option<String>,
    ssid: String,
    security: String,
    hidden: bool,
    vlan_id: Option<i64>,
}

/// Wi-Fi networks: matched by (integration, external id), else a WLAN
/// people typed in with the same SSID is adopted. The import owns the SSID,
/// security, hidden flag and VLAN; description and notes stay people's.
/// A VLAN the project doesn't have yet is left unset (networks create
/// VLANs, Wi-Fi only points at them).
async fn wlans(
    conn: &mut SqliteConnection,
    t: &Target,
    list: &[SrcWlan],
    now: &str,
    r: &mut Report,
) -> AppResult<()> {
    let mut seen: HashSet<i64> = HashSet::new();
    for w in list {
        let vlan_id: Option<i64> = match w.vlan {
            Some(vid) => {
                sqlx::query_scalar("SELECT id FROM vlans WHERE project_id = ? AND vid = ?")
                    .bind(t.project_id)
                    .bind(vid)
                    .fetch_optional(&mut *conn)
                    .await?
            }
            None => None,
        };
        let existing: Option<OwnedWlan> = match sqlx::query_as::<_, OwnedWlan>(
            "SELECT id, external_id, missing_from_source_at, ssid, security, hidden, vlan_id FROM wlans
             WHERE source_integration_id = ? AND external_id = ?",
        )
        .bind(t.integration_id)
        .bind(&w.external_id)
        .fetch_optional(&mut *conn)
        .await?
        {
            Some(x) => Some(x),
            None => {
                sqlx::query_as::<_, OwnedWlan>(
                    "SELECT id, external_id, missing_from_source_at, ssid, security, hidden, vlan_id FROM wlans
                     WHERE project_id = ? AND ssid = ? AND source_integration_id IS NULL
                     ORDER BY id LIMIT 1",
                )
                .bind(t.project_id)
                .bind(&w.ssid)
                .fetch_optional(&mut *conn)
                .await?
            }
        };
        match existing {
            None => {
                let id = sqlx::query(
                    "INSERT INTO wlans (project_id, ssid, security, hidden, vlan_id, source_integration_id, external_id,
                     created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(t.project_id)
                .bind(&w.ssid)
                .bind(&w.security)
                .bind(w.hidden)
                .bind(vlan_id)
                .bind(t.integration_id)
                .bind(&w.external_id)
                .bind(now)
                .bind(now)
                .execute(&mut *conn)
                .await?
                .last_insert_rowid();
                seen.insert(id);
                r.c("wlan").created += 1;
                r.note(format!("added Wi-Fi network {}", w.ssid));
            }
            Some(old) => {
                seen.insert(old.id);
                let changed = old.ssid != w.ssid
                    || old.security != w.security
                    || old.hidden != w.hidden
                    || old.vlan_id != vlan_id
                    || old.external_id.as_deref() != Some(w.external_id.as_str());
                if changed || old.missing_from_source_at.is_some() {
                    sqlx::query(
                        "UPDATE wlans SET ssid = ?, security = ?, hidden = ?, vlan_id = ?, source_integration_id = ?,
                         external_id = ?, missing_from_source_at = NULL, updated_at = ? WHERE id = ?",
                    )
                    .bind(&w.ssid)
                    .bind(&w.security)
                    .bind(w.hidden)
                    .bind(vlan_id)
                    .bind(t.integration_id)
                    .bind(&w.external_id)
                    .bind(now)
                    .bind(old.id)
                    .execute(&mut *conn)
                    .await?;
                    if old.missing_from_source_at.is_some() {
                        r.c("wlan").restored += 1;
                        r.note(format!("Wi-Fi network {} is back at the source", w.ssid));
                    } else {
                        r.c("wlan").updated += 1;
                        r.note(format!("updated Wi-Fi network {}", w.ssid));
                    }
                }
            }
        }
    }
    let owned: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT id, ssid, missing_from_source_at FROM wlans WHERE source_integration_id = ?",
    )
    .bind(t.integration_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, ssid, missing) in owned {
        if seen.contains(&id) || missing.is_some() {
            continue;
        }
        sqlx::query("UPDATE wlans SET missing_from_source_at = ? WHERE id = ?")
            .bind(now)
            .bind(id)
            .execute(&mut *conn)
            .await?;
        r.c("wlan").missing += 1;
        r.note(format!("Wi-Fi network {ssid} is no longer at the source"));
    }
    Ok(())
}

// ---------------------------------------------------------------- networks

#[derive(FromRow)]
struct OwnedPrefix {
    id: i64,
    external_id: Option<String>,
    missing_from_source_at: Option<String>,
    cidr: String,
    description: Option<String>,
    gateway: Option<String>,
    dns_servers: Option<String>,
    domain_name: Option<String>,
    vlan_id: Option<i64>,
}

async fn networks(
    conn: &mut SqliteConnection,
    t: &Target,
    list: &[SrcNetwork],
    now: &str,
    r: &mut Report,
) -> AppResult<()> {
    let owned: Vec<OwnedPrefix> = sqlx::query_as(
        "SELECT id, external_id, missing_from_source_at, cidr, description, gateway, dns_servers, domain_name, vlan_id
         FROM prefixes WHERE source_integration_id = ?",
    )
    .bind(t.integration_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut by_ext: HashMap<String, OwnedPrefix> = owned
        .into_iter()
        .filter_map(|p| Some((p.external_id.clone()?, p)))
        .collect();
    let mut seen_ranges: HashSet<String> = HashSet::new();

    for n in list {
        // The VLAN: created if the project doesn't have it (people own its name).
        let vlan_id = match n.vlan {
            None => None,
            Some(vid) => {
                let found: Option<i64> =
                    sqlx::query_scalar("SELECT id FROM vlans WHERE project_id = ? AND vid = ?")
                        .bind(t.project_id)
                        .bind(vid)
                        .fetch_optional(&mut *conn)
                        .await?;
                match found {
                    Some(id) => Some(id),
                    None => {
                        let id = sqlx::query(
                            "INSERT INTO vlans (project_id, vid, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                        )
                        .bind(t.project_id)
                        .bind(vid)
                        .bind(n.name.clone().unwrap_or_else(|| format!("VLAN {vid}")))
                        .bind(now)
                        .bind(now)
                        .execute(&mut *conn)
                        .await?
                        .last_insert_rowid();
                        r.vlans_created += 1;
                        r.note(format!("added VLAN {vid}"));
                        Some(id)
                    }
                }
            }
        };
        let Some(cidr_text) = &n.cidr else { continue };
        let cidr = match parse_cidr(cidr_text) {
            Ok(c) => c,
            Err(e) => {
                r.warn(format!("{}: {e}", n.external_id));
                continue;
            }
        };
        let gateway = n
            .gateway
            .as_deref()
            .and_then(|g| parse_addr(g).ok())
            .filter(|g| cidr.contains(*g) && !cidr.is_network_or_broadcast(*g))
            .map(|g| g.to_string());
        let dns: Vec<String> = n
            .dns_servers
            .iter()
            .filter_map(|d| parse_addr(d).ok().map(|a| a.to_string()))
            .collect();
        let dns_servers = (!dns.is_empty()).then(|| dns.join(", "));
        let domain = n.domain.as_deref().and_then(|d| check_dns_name(d).ok());
        let description = n.name.clone();

        let prefix_id = if let Some(o) = by_ext.remove(&n.external_id) {
            let differs = o.cidr != cidr.to_string()
                || o.description != description
                || o.gateway != gateway
                || o.dns_servers != dns_servers
                || o.domain_name != domain;
            if differs {
                let moved = sqlx::query(
                    "UPDATE prefixes SET cidr = ?, family = ?, prefix_len = ?, net_start = ?, net_end = ?, description = ?,
                     gateway = ?, dns_servers = ?, domain_name = ?, updated_at = ? WHERE id = ?",
                )
                .bind(cidr.to_string())
                .bind(cidr.family().number())
                .bind(i64::from(cidr.len))
                .bind(cidr.start().bin())
                .bind(cidr.end().bin())
                .bind(&description)
                .bind(&gateway)
                .bind(&dns_servers)
                .bind(&domain)
                .bind(now)
                .bind(o.id)
                .execute(&mut *conn)
                .await;
                match moved {
                    Ok(_) => {
                        r.c("prefix").updated += 1;
                        r.note(format!("updated prefix {cidr}"));
                    }
                    Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                        r.warn(format!(
                            "{} would become {cidr}, which is already documented",
                            o.cidr
                        ));
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            if o.vlan_id.is_none() && vlan_id.is_some() {
                sqlx::query("UPDATE prefixes SET vlan_id = ? WHERE id = ?")
                    .bind(vlan_id)
                    .bind(o.id)
                    .execute(&mut *conn)
                    .await?;
            }
            if o.missing_from_source_at.is_some() {
                sqlx::query("UPDATE prefixes SET missing_from_source_at = NULL WHERE id = ?")
                    .bind(o.id)
                    .execute(&mut *conn)
                    .await?;
                r.c("prefix").restored += 1;
            }
            hierarchy::reindex(conn, Subtree::Prefix(o.id)).await?;
            o.id
        } else {
            let existing: Option<(i64, Option<i64>)> = sqlx::query_as(
                "SELECT id, source_integration_id FROM prefixes WHERE space_id = ? AND cidr = ?",
            )
            .bind(t.space_id)
            .bind(cidr.to_string())
            .fetch_optional(&mut *conn)
            .await?;
            match existing {
                Some((id, Some(other))) if other != t.integration_id => {
                    r.warn(format!(
                        "{cidr} is already imported by another integration; left alone"
                    ));
                    let _ = id;
                    continue;
                }
                Some((id, _)) => {
                    // Adopt: the import's facts fill in; people's fields stay.
                    sqlx::query(
                        "UPDATE prefixes SET source_integration_id = ?, external_id = ?, source = 'integration',
                         description = COALESCE(description, ?), gateway = COALESCE(?, gateway),
                         dns_servers = COALESCE(?, dns_servers), domain_name = COALESCE(?, domain_name),
                         vlan_id = COALESCE(vlan_id, ?), updated_at = ? WHERE id = ?",
                    )
                    .bind(t.integration_id)
                    .bind(&n.external_id)
                    .bind(&description)
                    .bind(&gateway)
                    .bind(&dns_servers)
                    .bind(&domain)
                    .bind(vlan_id)
                    .bind(now)
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
                    hierarchy::reindex(conn, Subtree::Prefix(id)).await?;
                    r.c("prefix").updated += 1;
                    r.note(format!("linked prefix {cidr} to the source"));
                    id
                }
                None => {
                    let id = sqlx::query(
                        "INSERT INTO prefixes (project_id, space_id, cidr, family, prefix_len, net_start, net_end, vlan_id,
                         role, status, gateway, dns_servers, domain_name, description, source, external_id,
                         source_integration_id, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'other', 'active', ?, ?, ?, ?, 'integration', ?, ?, ?, ?)",
                    )
                    .bind(t.project_id)
                    .bind(t.space_id)
                    .bind(cidr.to_string())
                    .bind(cidr.family().number())
                    .bind(i64::from(cidr.len))
                    .bind(cidr.start().bin())
                    .bind(cidr.end().bin())
                    .bind(vlan_id)
                    .bind(&gateway)
                    .bind(&dns_servers)
                    .bind(&domain)
                    .bind(&description)
                    .bind(&n.external_id)
                    .bind(t.integration_id)
                    .bind(now)
                    .bind(now)
                    .execute(&mut *conn)
                    .await?
                    .last_insert_rowid();
                    hierarchy::reindex(conn, Subtree::Prefix(id)).await?;
                    r.c("prefix").created += 1;
                    r.note(format!("added prefix {cidr}"));
                    id
                }
            }
        };

        // Ranges: exclusions as reserved, the pool split around them.
        let parse = |(a, b): &(String, String)| -> Option<(Addr, Addr)> {
            let (a, b) = (parse_addr(a).ok()?, parse_addr(b).ok()?);
            (a <= b && cidr.contains(a) && cidr.contains(b)).then_some((a, b))
        };
        let exclusions: Vec<(Addr, Addr)> = n.exclusions.iter().filter_map(parse).collect();
        let mut wanted: Vec<(String, &'static str, Addr, Addr)> = Vec::new();
        for (s, e) in &exclusions {
            wanted.push((format!("{}:excl:{s}", n.external_id), "reserved", *s, *e));
        }
        for p in &n.pools {
            let Some(pool) = parse(p) else {
                r.warn(format!(
                    "{cidr}: DHCP range {}-{} is outside the prefix",
                    p.0, p.1
                ));
                continue;
            };
            for (s, e) in subtract(pool, &exclusions) {
                wanted.push((format!("{}:pool:{s}", n.external_id), "dhcp_pool", s, e));
            }
        }
        // Owned ranges of this network that the source no longer has and
        // that overlap a new one were moved at the source: replace them.
        let net_prefix = format!("{}:", n.external_id);
        #[allow(clippy::type_complexity)]
        let old: Vec<(i64, String, Vec<u8>, Vec<u8>, String)> = sqlx::query_as(
            "SELECT id, external_id, start_bin, end_bin, start_text || '-' || end_text FROM ip_ranges
             WHERE source_integration_id = ? AND substr(external_id, 1, ?) = ?",
        )
        .bind(t.integration_id)
        .bind(net_prefix.len() as i64)
        .bind(&net_prefix)
        .fetch_all(&mut *conn)
        .await?;
        for (id, ext, sb, eb, label) in old {
            if wanted.iter().any(|w| w.0 == ext) {
                continue;
            }
            let (Some(os), Some(oe)) = (Addr::from_bin(&sb), Addr::from_bin(&eb)) else {
                continue;
            };
            if wanted.iter().any(|(_, _, s, e)| os <= *e && *s <= oe) {
                sqlx::query("DELETE FROM ip_ranges WHERE id = ?")
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
                r.note(format!("replaced range {label}"));
            }
        }
        for (ext, kind, s, e) in wanted {
            seen_ranges.insert(ext.clone());
            upsert_range(conn, t, prefix_id, &cidr, &ext, kind, s, e, now, r).await?;
        }
    }
    for (_, o) in by_ext {
        if o.missing_from_source_at.is_none() {
            sqlx::query("UPDATE prefixes SET missing_from_source_at = ? WHERE id = ?")
                .bind(now)
                .bind(o.id)
                .execute(&mut *conn)
                .await?;
            r.c("prefix").missing += 1;
            r.note(format!("prefix {} is no longer at the source", o.cidr));
        }
    }
    mark_missing(conn, "range", t, &seen_ranges, now, r).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn upsert_range(
    conn: &mut SqliteConnection,
    t: &Target,
    prefix_id: i64,
    cidr: &Cidr,
    ext: &str,
    kind: &str,
    s: Addr,
    e: Addr,
    now: &str,
    r: &mut Report,
) -> AppResult<()> {
    let existing: Option<(i64, i64, String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, prefix_id, start_text, end_text, missing_from_source_at FROM ip_ranges
         WHERE source_integration_id = ? AND external_id = ?",
    )
    .bind(t.integration_id)
    .bind(ext)
    .fetch_optional(&mut *conn)
    .await?;
    let self_id = existing.as_ref().map(|x| x.0).unwrap_or(-1);
    let clash: Option<(String, String)> = sqlx::query_as(
                "SELECT start_text, end_text FROM ip_ranges WHERE prefix_id = ? AND id <> ? AND start_bin <= ? AND end_bin >= ?",
    )
    .bind(prefix_id)
    .bind(self_id)
    .bind(e.bin())
    .bind(s.bin())
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((a, b)) = clash {
        r.warn(format!(
            "{cidr}: range {s}-{e} overlaps the documented range {a}-{b}; left out"
        ));
        return Ok(());
    }
    match existing {
        Some((id, pid, st, en, missing)) => {
            if pid != prefix_id || st != s.to_string() || en != e.to_string() {
                sqlx::query(
                    "UPDATE ip_ranges SET prefix_id = ?, start_text = ?, end_text = ?, start_bin = ?, end_bin = ?, kind = ?,
                     updated_at = ? WHERE id = ?",
                )
                .bind(prefix_id)
                .bind(s.to_string())
                .bind(e.to_string())
                .bind(s.bin())
                .bind(e.bin())
                .bind(kind)
                .bind(now)
                .bind(id)
                .execute(&mut *conn)
                .await?;
                r.c("range").updated += 1;
                r.note(format!("updated range {s}-{e}"));
            }
            if missing.is_some() {
                sqlx::query("UPDATE ip_ranges SET missing_from_source_at = NULL WHERE id = ?")
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
                r.c("range").restored += 1;
            }
        }
        None => {
            sqlx::query(
                "INSERT INTO ip_ranges (prefix_id, start_text, end_text, start_bin, end_bin, kind, source, external_id,
                 source_integration_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'integration', ?, ?, ?, ?)",
            )
            .bind(prefix_id)
            .bind(s.to_string())
            .bind(e.to_string())
            .bind(s.bin())
            .bind(e.bin())
            .bind(kind)
            .bind(ext)
            .bind(t.integration_id)
            .bind(now)
            .bind(now)
            .execute(&mut *conn)
            .await?;
            r.c("range").created += 1;
            r.note(format!(
                "added {} {s}-{e}",
                if kind == "dhcp_pool" {
                    "DHCP pool"
                } else {
                    "reserved range"
                }
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- addresses

/// The facts one part of a source states about an address. None = this
/// part says nothing about it.
#[derive(Default, Clone)]
struct AddressFacts {
    mac: Option<String>,
    reservation: bool,
    dns_name: Option<String>,
    aliases: Option<Vec<String>>,
    description: Option<String>,
    device_id: Option<i64>,
    /// The source says this is not a DHCP reservation (a fixed IP outside
    /// every pool): clears a reservation flag this import set before.
    not_reservation: bool,
}

#[derive(FromRow)]
struct AddressRow {
    id: i64,
    source_integration_id: Option<i64>,
    missing_from_source_at: Option<String>,
    mac: Option<String>,
    dhcp_reservation: bool,
    dns_name: Option<String>,
    dns_aliases: Option<String>,
    description: Option<String>,
    device_id: Option<i64>,
}

fn ext_of(a: Addr) -> String {
    format!("addr:{a}")
}

async fn upsert_address(
    conn: &mut SqliteConnection,
    t: &Target,
    a: Addr,
    f: AddressFacts,
    now: &str,
    r: &mut Report,
) -> AppResult<()> {
    let row: Option<AddressRow> = sqlx::query_as(
        "SELECT id, source_integration_id, missing_from_source_at, mac, dhcp_reservation, dns_name, dns_aliases,
                description, device_id FROM ip_addresses WHERE space_id = ? AND addr_bin = ?",
    )
    .bind(t.space_id)
    .bind(a.bin())
    .fetch_optional(&mut *conn)
    .await?;
    // A reservation's MAC links it to the one device with that MAC.
    let auto_device = match (&f.mac, f.device_id) {
        (Some(m), None) => {
            let ids: Vec<i64> = sqlx::query_scalar(
                "SELECT id FROM devices WHERE project_id = ? AND mac = ? LIMIT 2",
            )
            .bind(t.project_id)
            .bind(m)
            .fetch_all(&mut *conn)
            .await?;
            (ids.len() == 1).then(|| ids[0])
        }
        _ => f.device_id,
    };
    match row {
        None => {
            let id = sqlx::query(
                "INSERT INTO ip_addresses (project_id, space_id, address, family, addr_bin, prefix_len, device_id, role,
                 status, mac, dns_name, dns_aliases, dhcp_reservation, description, source, external_id,
                 source_integration_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, (SELECT prefix_len FROM prefixes WHERE space_id = ? AND family = ? AND net_start <= ?
                         AND net_end >= ? ORDER BY prefix_len DESC LIMIT 1),
                         ?, 'primary', ?, ?, ?, ?, ?, ?, 'integration', ?, ?, ?, ?)",
            )
            .bind(t.project_id)
            .bind(t.space_id)
            .bind(a.to_string())
            .bind(a.family().number())
            .bind(a.bin())
            .bind(t.space_id)
            .bind(a.family().number())
            .bind(a.bin())
            .bind(a.bin())
            .bind(auto_device)
            .bind("assigned")
            .bind(&f.mac)
            .bind(&f.dns_name)
            .bind(f.aliases.as_ref().filter(|v| !v.is_empty()).map(|v| serde_json::to_string(v).unwrap_or_default()))
            .bind(f.reservation)
            .bind(&f.description)
            .bind(ext_of(a))
            .bind(t.integration_id)
            .bind(now)
            .bind(now)
            .execute(&mut *conn)
            .await?
            .last_insert_rowid();
            hierarchy::reindex(conn, Subtree::Address(id)).await?;
            r.c("address").created += 1;
            r.note(format!("added address {a}"));
        }
        Some(row) => {
            let ours = row.source_integration_id == Some(t.integration_id);
            if row.source_integration_id.is_some() && !ours {
                // Another integration owns it: only fill gaps.
                if row.dns_name.is_none() && f.dns_name.is_some() {
                    sqlx::query(
                        "UPDATE ip_addresses SET dns_name = ?, updated_at = ? WHERE id = ?",
                    )
                    .bind(&f.dns_name)
                    .bind(now)
                    .bind(row.id)
                    .execute(&mut *conn)
                    .await?;
                    hierarchy::reindex(conn, Subtree::Address(row.id)).await?;
                }
                return Ok(());
            }
            // Owned facts are set; a hand-made address adopted here only has
            // its gaps filled.
            let pick = |new: &Option<String>, old: &Option<String>| -> Option<String> {
                match new {
                    Some(v) if ours || old.is_none() => Some(v.clone()),
                    _ => old.clone(),
                }
            };
            let mac = pick(&f.mac, &row.mac);
            let dns_name = pick(&f.dns_name, &row.dns_name);
            let description = pick(&f.description, &row.description);
            let aliases = match &f.aliases {
                Some(v) if ours || row.dns_aliases.is_none() => {
                    (!v.is_empty()).then(|| serde_json::to_string(v).unwrap_or_default())
                }
                _ => row.dns_aliases.clone(),
            };
            // Another part of the source (a device's IP) saying nothing about
            // a reservation leaves it; a static fixed IP clears our own flag.
            let reservation = if f.not_reservation && ours {
                false
            } else {
                row.dhcp_reservation || f.reservation
            };
            let device_id = row.device_id.or(auto_device);
            let differs = mac != row.mac
                || dns_name != row.dns_name
                || description != row.description
                || aliases != row.dns_aliases
                || reservation != row.dhcp_reservation
                || device_id != row.device_id
                || !ours;
            if differs {
                sqlx::query(
                    "UPDATE ip_addresses SET mac = ?, dns_name = ?, dns_aliases = ?, description = ?, dhcp_reservation = ?,
                     device_id = ?, source = 'integration', source_integration_id = ?, external_id = ?, updated_at = ?
                     WHERE id = ?",
                )
                .bind(&mac)
                .bind(&dns_name)
                .bind(&aliases)
                .bind(&description)
                .bind(reservation)
                .bind(device_id)
                .bind(t.integration_id)
                .bind(ext_of(a))
                .bind(now)
                .bind(row.id)
                .execute(&mut *conn)
                .await?;
                hierarchy::reindex(conn, Subtree::Address(row.id)).await?;
                r.c("address").updated += 1;
                r.note(format!(
                    "{} address {a}",
                    if ours { "updated" } else { "linked" }
                ));
            }
            if row.missing_from_source_at.is_some() {
                sqlx::query("UPDATE ip_addresses SET missing_from_source_at = NULL WHERE id = ?")
                    .bind(row.id)
                    .execute(&mut *conn)
                    .await?;
                r.c("address").restored += 1;
            }
        }
    }
    Ok(())
}

async fn dns(
    conn: &mut SqliteConnection,
    t: &Target,
    snap: &Snapshot,
    now: &str,
    r: &mut Report,
    seen: &mut HashSet<String>,
) -> AppResult<()> {
    // Names per address, in the order the source gave them.
    let mut names: BTreeMap<Addr, Vec<String>> = BTreeMap::new();
    let mut ptr: HashMap<Addr, String> = HashMap::new();
    for rec in &snap.dns {
        let (Ok(a), Ok(name)) = (parse_addr(&rec.ip), check_dns_name(&rec.name)) else {
            continue;
        };
        if rec.kind == "PTR" {
            ptr.insert(a, name);
        } else {
            let list = names.entry(a).or_default();
            if !list.contains(&name) {
                list.push(name);
            }
        }
    }
    for (a, p) in &ptr {
        match names.get(a) {
            Some(list) if !list.contains(p) => {
                r.warn(format!(
                    "{a}: the PTR record says {p}, the A record says {}",
                    list[0]
                ));
            }
            Some(_) => {}
            None => {
                names.insert(*a, vec![p.clone()]);
            }
        }
    }
    for (a, list) in names {
        let facts = AddressFacts {
            dns_name: list.first().cloned(),
            aliases: Some(list[1..].to_vec()),
            ..Default::default()
        };
        upsert_address(conn, t, a, facts, now, r).await?;
        seen.insert(a.to_string());
    }
    Ok(())
}

/// Marks owned ranges or addresses not seen in this run as missing.
async fn mark_missing(
    conn: &mut SqliteConnection,
    kind: &'static str,
    t: &Target,
    seen: &HashSet<String>,
    now: &str,
    r: &mut Report,
) -> AppResult<()> {
    let rows: Vec<(i64, String, Option<String>, String)> = match kind {
        "range" => sqlx::query_as(
            "SELECT id, COALESCE(external_id, ''), missing_from_source_at, start_text || '-' || end_text
             FROM ip_ranges WHERE source_integration_id = ?",
        )
        .bind(t.integration_id)
        .fetch_all(&mut *conn)
        .await?,
        _ => sqlx::query_as(
            "SELECT id, address, missing_from_source_at, address FROM ip_addresses WHERE source_integration_id = ?",
        )
        .bind(t.integration_id)
        .fetch_all(&mut *conn)
        .await?,
    };
    for (id, key, missing, label) in rows {
        if seen.contains(&key) || missing.is_some() {
            continue;
        }
        let sql = if kind == "range" {
            "UPDATE ip_ranges SET missing_from_source_at = ? WHERE id = ?"
        } else {
            "UPDATE ip_addresses SET missing_from_source_at = ? WHERE id = ?"
        };
        sqlx::query(sql)
            .bind(now)
            .bind(id)
            .execute(&mut *conn)
            .await?;
        r.c(kind).missing += 1;
        r.note(format!("{kind} {label} is no longer at the source"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(s: &str) -> Addr {
        parse_addr(s).unwrap()
    }

    #[test]
    fn pools_are_split_around_exclusions() {
        let pool = (a("10.0.0.50"), a("10.0.0.200"));
        let out: Vec<(String, String)> = subtract(
            pool,
            &[
                (a("10.0.0.50"), a("10.0.0.59")),
                (a("10.0.0.100"), a("10.0.0.109")),
            ],
        )
        .iter()
        .map(|(s, e)| (s.to_string(), e.to_string()))
        .collect();
        assert_eq!(
            out,
            vec![
                ("10.0.0.60".into(), "10.0.0.99".into()),
                ("10.0.0.110".into(), "10.0.0.200".into())
            ]
        );
        assert!(subtract(pool, &[(a("10.0.0.1"), a("10.0.0.254"))]).is_empty());
        assert_eq!(subtract(pool, &[(a("10.0.1.1"), a("10.0.1.9"))]).len(), 1);
    }
}
