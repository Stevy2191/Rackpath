//! Integrations and imports (design section 15).
//!
//! Every source (Windows DHCP/DNS, UniFi, Zabbix) is turned into one
//! [`Snapshot`]: what the source says exists right now. [`apply`] then
//! merges a snapshot into the documentation following the ownership rules:
//!
//! * an import owns only the facts it brought in; people own everything
//!   else (placement, notes, links, roles), and a sync never overwrites them;
//! * records are matched by (integration, external id), so re-imports update
//!   instead of duplicating; a manual record with the same MAC, CIDR or
//!   address is adopted rather than duplicated;
//! * a record that disappears at the source is marked
//!   `missing_from_source_at`, never deleted;
//! * an import that would change more than the integration's threshold of
//!   the records it owns is held for an admin to approve.

pub mod apply;
pub mod http;
pub mod unifi;
pub mod windows;
pub mod zabbix;

use serde::{Deserialize, Serialize};

/// A device as a source describes it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SrcDevice {
    pub external_id: String,
    pub name: Option<String>,
    pub hostname: Option<String>,
    /// A Rackpath device type key (falls back to `misc`).
    pub type_key: String,
    pub mac: Option<String>,
    pub ips: Vec<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub firmware: Option<String>,
    pub external_url: Option<String>,
}

/// A Wi-Fi network (UniFi WLAN). Never its passphrase.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SrcWlan {
    pub external_id: String,
    pub ssid: String,
    /// One of Rackpath's WLAN security values (open, owe, wpa2, wpa3,
    /// wpa2_wpa3, enterprise).
    pub security: String,
    pub hidden: bool,
    /// The VLAN ID its clients land on; None for the untagged network.
    pub vlan: Option<i64>,
    pub enabled: bool,
}

/// A subnet (DHCP scope, UniFi network) with its ranges.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SrcNetwork {
    pub external_id: String,
    pub name: Option<String>,
    pub vlan: Option<i64>,
    pub cidr: Option<String>,
    pub gateway: Option<String>,
    pub dns_servers: Vec<String>,
    pub domain: Option<String>,
    /// DHCP pools (start, end).
    pub pools: Vec<(String, String)>,
    /// Exclusions: addresses DHCP never hands out (start, end).
    pub exclusions: Vec<(String, String)>,
}

/// A DHCP reservation (fixed IP for a MAC).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SrcReservation {
    pub ip: String,
    pub mac: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
}

/// A static DNS record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SrcDns {
    /// Fully qualified, lowercase, no trailing dot.
    pub name: String,
    pub ip: String,
    /// "A"/"AAAA" (name → address) or "PTR" (address → name).
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SrcLease {
    pub ip: String,
    pub mac: Option<String>,
    pub hostname: Option<String>,
    pub expires_at: Option<String>,
    pub state: Option<String>,
}

/// Everything one import run found.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub devices: Vec<SrcDevice>,
    pub networks: Vec<SrcNetwork>,
    pub reservations: Vec<SrcReservation>,
    pub dns: Vec<SrcDns>,
    #[serde(default)]
    pub wlans: Vec<SrcWlan>,
    /// None: leases weren't collected this time (leave the old snapshot).
    pub leases: Option<Vec<SrcLease>>,
    /// Which kinds of record this source provides at all. Records of other
    /// kinds owned by the integration are never marked missing.
    pub covers: Covers,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Covers {
    pub devices: bool,
    pub networks: bool,
    pub reservations: bool,
    pub dns: bool,
    #[serde(default)]
    pub wlans: bool,
}

/// Whether an import changes too much at once to apply without an admin.
/// Small sources (under 10 owned records) are never held, so a first import
/// and small homes work without ceremony.
pub fn should_hold(
    owned_before: usize,
    changed: usize,
    newly_missing: usize,
    threshold_pct: i64,
) -> bool {
    if owned_before < 10 {
        return false;
    }
    let affected = (changed + newly_missing) as u128 * 100;
    affected > owned_before as u128 * threshold_pct.clamp(1, 100) as u128
}

/// Normalises a MAC from any usual notation, or None if it isn't one.
pub fn mac(input: &str) -> Option<String> {
    let hex: String = input.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let separators_ok = input
        .chars()
        .all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '-' | '.'));
    if hex.len() != 12 || !separators_ok {
        return None;
    }
    let hex = hex.to_ascii_lowercase();
    // Zero MACs are placeholders, not addresses.
    if hex == "000000000000" {
        return None;
    }
    Some(
        (0..6)
            .map(|i| &hex[i * 2..i * 2 + 2])
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// Trims, drops empties, and limits length (sources can send anything).
pub fn text(s: Option<&str>, max: usize) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(max).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hold_rule() {
        assert!(!should_hold(0, 0, 0, 50), "first import");
        assert!(!should_hold(5, 5, 0, 50), "small sources are never held");
        assert!(!should_hold(100, 10, 5, 50));
        assert!(!should_hold(100, 30, 20, 50), "exactly half is allowed");
        assert!(should_hold(100, 30, 21, 50));
        assert!(
            should_hold(100, 0, 60, 50),
            "a broken script that sends nothing"
        );
        assert!(should_hold(100, 11, 0, 10));
    }

    #[test]
    fn macs() {
        assert_eq!(
            mac("AA-BB-CC-DD-EE-FF").as_deref(),
            Some("aa:bb:cc:dd:ee:ff")
        );
        assert_eq!(mac("aabb.ccdd.eeff").as_deref(), Some("aa:bb:cc:dd:ee:ff"));
        assert_eq!(mac("00:00:00:00:00:00"), None);
        assert_eq!(mac("not a mac"), None);
        assert_eq!(
            mac("aa-bb-cc-dd-ee-ff-00-11"),
            None,
            "DHCPv6 DUIDs aren't MACs"
        );
    }

    #[test]
    fn text_cleanup() {
        assert_eq!(text(Some("  x "), 10).as_deref(), Some("x"));
        assert_eq!(text(Some("   "), 10), None);
        assert_eq!(text(Some("abcdef"), 3).as_deref(), Some("abc"));
    }
}
