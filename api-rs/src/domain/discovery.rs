//! Safety rules for network discovery, and the pure parts of reading SNMP
//! tables. Discovery is opt-in, and these rules bound what it may touch:
//!
//! * ping sweeps only cover private IPv4 prefixes no larger than a /22
//!   (1,024 addresses), never IPv6 (a /64 can't be swept);
//! * SNMP is only sent to private addresses, given as IP addresses;
//! * schedules run at most hourly;
//! * probes are paced: a fixed number in flight, each with a short timeout.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use super::ip::{Addr, Cidr, Family};

/// Largest sweep: a /22.
pub const MIN_SWEEP_PREFIX_LEN: u8 = 22;
/// Echo requests in flight at once during a sweep.
pub const SWEEP_CONCURRENCY: usize = 32;
/// How long to wait for each echo reply.
pub const PING_TIMEOUT_MS: u64 = 1000;
/// Shortest and longest schedule, in minutes.
pub const MIN_INTERVAL_MINUTES: i64 = 60;
pub const MAX_INTERVAL_MINUTES: i64 = 10080;
/// A switch port carrying more MACs than this is treated as an uplink, not
/// where a device is plugged in.
pub const MAX_MACS_ON_ACCESS_PORT: usize = 16;

/// Private IPv4: RFC 1918 and the shared CGNAT block 100.64.0.0/10.
pub fn is_private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_private() || (a == 100 && (64..128).contains(&b))
}

/// Private IPv6: unique local addresses (fc00::/7).
pub fn is_private_v6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

/// Whether a prefix may be swept with ping. The message says why not.
pub fn check_sweep(c: &Cidr) -> Result<(), String> {
    if c.family() == Family::V6 {
        return Err("Only IPv4 prefixes can be scanned (an IPv6 subnet is far too large to sweep); add SNMP devices to find IPv6 hosts".into());
    }
    if c.len < MIN_SWEEP_PREFIX_LEN {
        return Err(format!(
            "Only prefixes of /{MIN_SWEEP_PREFIX_LEN} or smaller (up to 1,024 addresses) can be scanned; scan the smaller prefixes inside it"
        ));
    }
    let start = v4(c.start());
    let end = v4(c.end());
    if !is_private_v4(start) || !is_private_v4(end) {
        return Err(
            "Only private address ranges (10/8, 172.16/12, 192.168/16, 100.64/10) can be scanned"
                .into(),
        );
    }
    Ok(())
}

/// The addresses a sweep of `c` pings: the usable ones (not the network or
/// broadcast address of a /30 or larger).
pub fn sweep_targets(c: &Cidr) -> Vec<Ipv4Addr> {
    if check_sweep(c).is_err() {
        return Vec::new();
    }
    let (first, last) = c.usable();
    (first.value..=last.value)
        .map(|v| Ipv4Addr::from((v & 0xffff_ffff) as u32))
        .collect()
}

fn v4(a: Addr) -> Ipv4Addr {
    Ipv4Addr::from((a.value & 0xffff_ffff) as u32)
}

/// Checks an SNMP device address: an IP address (not a name, so DNS can't
/// redirect polling elsewhere) in a private range.
pub fn check_snmp_host(host: &str) -> Result<IpAddr, String> {
    let ip: IpAddr = host
        .trim()
        .parse()
        .map_err(|_| "Enter the device's IP address (not a host name)".to_string())?;
    let ok = match ip {
        IpAddr::V4(v) => is_private_v4(v),
        IpAddr::V6(v) => is_private_v6(v),
    };
    if !ok {
        return Err("SNMP is only sent to private addresses (10/8, 172.16/12, 192.168/16, 100.64/10 or fc00::/7)".into());
    }
    Ok(ip)
}

/// Checks a schedule: None (by hand only) or between hourly and weekly.
pub fn check_interval(minutes: Option<i64>) -> Result<Option<i64>, String> {
    match minutes {
        None => Ok(None),
        Some(m) if (MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&m) => Ok(Some(m)),
        Some(_) => Err(
            "The schedule must be between every hour (60) and every week (10080 minutes)".into(),
        ),
    }
}

// ---------------------------------------------------------------- SNMP tables

/// The IP address in an ARP table row index, given the OID components
/// after the column.
///
/// * ipNetToMediaPhysAddress (1.3.6.1.2.1.4.22.1.2): `ifIndex.a.b.c.d`
/// * ipNetToPhysicalPhysAddress (1.3.6.1.2.1.4.35.1.4):
///   `ifIndex.type.length.bytes…`, type 1 = IPv4, 2 = IPv6
pub fn arp_index_ip(legacy: bool, index: &[u64]) -> Option<IpAddr> {
    let byte = |v: &u64| u8::try_from(*v).ok();
    if legacy {
        if index.len() != 5 {
            return None;
        }
        let b: Vec<u8> = index[1..].iter().map(byte).collect::<Option<_>>()?;
        return Some(IpAddr::V4(Ipv4Addr::new(b[0], b[1], b[2], b[3])));
    }
    let (kind, len, rest) = (index.get(1)?, *index.get(2)? as usize, index.get(3..)?);
    if rest.len() != len {
        return None;
    }
    let b: Vec<u8> = rest.iter().map(byte).collect::<Option<_>>()?;
    match (kind, len) {
        (1, 4) => Some(IpAddr::V4(Ipv4Addr::new(b[0], b[1], b[2], b[3]))),
        (2, 16) => {
            let a: [u8; 16] = b.try_into().ok()?;
            Some(IpAddr::V6(Ipv6Addr::from(a)))
        }
        _ => None,
    }
}

/// The MAC at the end of a forwarding table row index:
/// dot1dTpFdbPort is `m1…m6`, dot1qTpFdbPort is `fdbId.m1…m6`.
pub fn fdb_index_mac(index: &[u64]) -> Option<String> {
    if index.len() < 6 {
        return None;
    }
    let b: Vec<u8> = index[index.len() - 6..]
        .iter()
        .map(|v| u8::try_from(*v).ok())
        .collect::<Option<_>>()?;
    mac_from_bytes(&b)
}

/// A MAC address from its 6 bytes, as aa:bb:cc:dd:ee:ff. None for anything
/// else, and for the all-zero and broadcast addresses.
pub fn mac_from_bytes(b: &[u8]) -> Option<String> {
    if b.len() != 6 || b.iter().all(|x| *x == 0) || b.iter().all(|x| *x == 0xff) {
        return None;
    }
    Some(
        b.iter()
            .map(|x| format!("{x:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// Which port each MAC is plugged into. A MAC is usually learned on
/// several ports of a switch (its own port and the uplinks it crosses), so
/// the port carrying the fewest MACs wins, and ports carrying more than
/// [`MAX_MACS_ON_ACCESS_PORT`] count as uplinks and are never the answer.
pub fn access_ports(fdb: &[(String, String)]) -> HashMap<String, String> {
    let mut per_port: HashMap<&str, usize> = HashMap::new();
    for (_, port) in fdb {
        *per_port.entry(port.as_str()).or_default() += 1;
    }
    let mut best: HashMap<String, (usize, String)> = HashMap::new();
    for (mac, port) in fdb {
        let n = per_port[port.as_str()];
        if n > MAX_MACS_ON_ACCESS_PORT {
            continue;
        }
        match best.get(mac) {
            Some((m, p)) if *m < n || (*m == n && p <= port) => {}
            _ => {
                best.insert(mac.clone(), (n, port.clone()));
            }
        }
    }
    best.into_iter().map(|(m, (_, p))| (m, p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ip::parse_cidr;

    fn cidr(s: &str) -> Cidr {
        parse_cidr(s).unwrap()
    }

    #[test]
    fn only_small_private_ipv4_prefixes_are_swept() {
        assert!(check_sweep(&cidr("192.168.1.0/24")).is_ok());
        assert!(check_sweep(&cidr("10.20.0.0/22")).is_ok());
        assert!(check_sweep(&cidr("172.16.5.0/28")).is_ok());
        assert!(check_sweep(&cidr("100.64.1.0/24")).is_ok());
        assert!(check_sweep(&cidr("10.0.0.5/32")).is_ok());
        // Too large.
        assert!(check_sweep(&cidr("10.0.0.0/21")).is_err());
        assert!(check_sweep(&cidr("10.0.0.0/8")).is_err());
        // Public, or partly outside private space.
        assert!(check_sweep(&cidr("8.8.8.0/24")).is_err());
        assert!(check_sweep(&cidr("172.32.0.0/24")).is_err());
        assert!(check_sweep(&cidr("127.0.0.0/24")).is_err());
        assert!(check_sweep(&cidr("169.254.1.0/24")).is_err());
        assert!(check_sweep(&cidr("224.0.0.0/24")).is_err());
        // Never IPv6.
        assert!(check_sweep(&cidr("fd00::/120")).is_err());
    }

    #[test]
    fn sweep_targets_skip_network_and_broadcast() {
        let t = sweep_targets(&cidr("192.168.1.0/30"));
        assert_eq!(
            t,
            vec![Ipv4Addr::new(192, 168, 1, 1), Ipv4Addr::new(192, 168, 1, 2)]
        );
        assert_eq!(sweep_targets(&cidr("192.168.1.0/24")).len(), 254);
        assert_eq!(sweep_targets(&cidr("10.0.0.0/22")).len(), 1022);
        assert_eq!(sweep_targets(&cidr("10.0.0.0/31")).len(), 2);
        assert_eq!(
            sweep_targets(&cidr("10.0.0.9/32")),
            vec![Ipv4Addr::new(10, 0, 0, 9)]
        );
        assert!(sweep_targets(&cidr("10.0.0.0/16")).is_empty());
        assert!(sweep_targets(&cidr("8.8.8.0/24")).is_empty());
    }

    #[test]
    fn snmp_hosts_must_be_private_addresses() {
        assert!(check_snmp_host("192.168.1.1").is_ok());
        assert!(check_snmp_host(" 10.1.80.1 ").is_ok());
        assert!(check_snmp_host("fd12:3456::1").is_ok());
        assert!(check_snmp_host("8.8.8.8").is_err());
        assert!(check_snmp_host("127.0.0.1").is_err());
        assert!(check_snmp_host("169.254.0.1").is_err());
        assert!(check_snmp_host("2001:4860::8888").is_err());
        assert!(check_snmp_host("::1").is_err());
        assert!(check_snmp_host("switch.example.com").is_err());
        assert!(check_snmp_host("").is_err());
    }

    #[test]
    fn schedules_are_hourly_at_most() {
        assert_eq!(check_interval(None), Ok(None));
        assert_eq!(check_interval(Some(60)), Ok(Some(60)));
        assert_eq!(check_interval(Some(10080)), Ok(Some(10080)));
        assert!(check_interval(Some(59)).is_err());
        assert!(check_interval(Some(5)).is_err());
        assert!(check_interval(Some(0)).is_err());
        assert!(check_interval(Some(-1)).is_err());
        assert!(check_interval(Some(10081)).is_err());
    }

    #[test]
    fn arp_indexes() {
        assert_eq!(
            arp_index_ip(true, &[3, 192, 168, 1, 20]),
            Some("192.168.1.20".parse().unwrap())
        );
        assert_eq!(arp_index_ip(true, &[3, 192, 168, 1]), None);
        assert_eq!(arp_index_ip(true, &[3, 192, 168, 1, 300]), None);
        assert_eq!(
            arp_index_ip(false, &[7, 1, 4, 10, 0, 0, 9]),
            Some("10.0.0.9".parse().unwrap())
        );
        let mut v6 = vec![7, 2, 16, 0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
        assert_eq!(arp_index_ip(false, &v6), Some("fd00::1".parse().unwrap()));
        v6.pop();
        assert_eq!(arp_index_ip(false, &v6), None);
        assert_eq!(arp_index_ip(false, &[7, 3, 4, 10, 0, 0, 9]), None);
    }

    #[test]
    fn fdb_indexes_and_macs() {
        assert_eq!(
            fdb_index_mac(&[0x1c, 0x6a, 0x7a, 0x01, 0xff]).as_deref(),
            None,
            "five bytes is not a MAC"
        );
        assert_eq!(
            fdb_index_mac(&[0x00, 0x1c, 0x6a, 0x7a, 0x01, 0xff]).as_deref(),
            Some("00:1c:6a:7a:01:ff")
        );
        // dot1q rows start with the FDB id.
        assert_eq!(
            fdb_index_mac(&[10, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]).as_deref(),
            Some("aa:bb:cc:dd:ee:0f")
        );
        assert_eq!(mac_from_bytes(&[0; 6]), None);
        assert_eq!(mac_from_bytes(&[0xff; 6]), None);
        assert_eq!(mac_from_bytes(&[1, 2, 3]), None);
    }

    #[test]
    fn devices_are_placed_on_access_ports_not_uplinks() {
        let mut fdb: Vec<(String, String)> = Vec::new();
        // 20 MACs behind the uplink, including the camera.
        for i in 0..20 {
            fdb.push((format!("00:00:00:00:00:{i:02x}"), "Gi1/0/48".into()));
        }
        fdb.push(("00:00:00:00:00:05".into(), "Gi1/0/5".into()));
        fdb.push(("00:00:00:00:00:06".into(), "Gi1/0/6".into()));
        fdb.push(("00:00:00:00:00:06".into(), "Gi1/0/7".into()));
        fdb.push(("00:00:00:00:00:07".into(), "Gi1/0/7".into()));
        let p = access_ports(&fdb);
        assert_eq!(
            p.get("00:00:00:00:00:05").map(String::as_str),
            Some("Gi1/0/5")
        );
        // Seen on two access ports: the one with fewer MACs.
        assert_eq!(
            p.get("00:00:00:00:00:06").map(String::as_str),
            Some("Gi1/0/6")
        );
        assert_eq!(
            p.get("00:00:00:00:00:07").map(String::as_str),
            Some("Gi1/0/7")
        );
        // Only seen on the uplink: no port.
        assert_eq!(p.get("00:00:00:00:00:01"), None);
    }
}
