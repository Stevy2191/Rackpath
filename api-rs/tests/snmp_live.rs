//! Reads a real SNMP agent with the real client. Skipped unless
//! RACKPATH_TEST_SNMP=host:port names an agent (net-snmp's snmpd) set up
//! with:
//!
//! ```text
//! rocommunity testcomm 127.0.0.1
//! createUser rpuser SHA-256 "authpass123" AES "privpass123"
//! rouser rpuser priv
//! ```

use std::net::SocketAddr;

use rackpath::discovery::net::{Network, RealNetwork, SnmpAuth, SnmpTarget};

fn agent() -> Option<SocketAddr> {
    std::env::var("RACKPATH_TEST_SNMP").ok()?.parse().ok()
}

fn target(addr: SocketAddr, auth: SnmpAuth) -> SnmpTarget {
    SnmpTarget {
        ip: addr.ip(),
        port: addr.port(),
        auth,
        read_arp: true,
        read_mac_table: true,
    }
}

fn v3(auth_password: &str) -> SnmpAuth {
    SnmpAuth::V3 {
        username: "rpuser".into(),
        auth_protocol: "sha256".into(),
        auth_password: auth_password.into(),
        privacy: Some(("aes128".into(), "privpass123".into())),
    }
}

#[tokio::test]
async fn reads_a_real_agent() {
    let Some(addr) = agent() else {
        eprintln!("RACKPATH_TEST_SNMP not set; skipped");
        return;
    };
    let net = RealNetwork;
    let v2 = net
        .snmp(target(
            addr,
            SnmpAuth::V2c {
                community: "testcomm".into(),
            },
        ))
        .await
        .expect("v2c poll");
    assert!(v2.sys_name.is_some());
    let v3_tables = net
        .snmp(target(addr, v3("authpass123")))
        .await
        .expect("v3 authPriv poll");
    assert_eq!(v3_tables.sys_name, v2.sys_name);
    assert_eq!(v3_tables.arp, v2.arp, "same ARP table over v2c and v3");
    eprintln!(
        "sysName {:?}, {} ARP entries, {} MAC entries",
        v2.sys_name,
        v2.arp.len(),
        v2.fdb.len()
    );

    let wrong = net.snmp(target(addr, v3("wrong-password"))).await;
    assert!(wrong.is_err(), "a wrong password is refused");
    let wrong = net
        .snmp(target(
            addr,
            SnmpAuth::V2c {
                community: "nope".into(),
            },
        ))
        .await;
    assert!(wrong.is_err(), "a wrong community gets no answer");
}

/// Sweeps loopback with the real pinger. Skipped unless RACKPATH_TEST_PING
/// is set (needs unprivileged ICMP: net.ipv4.ping_group_range).
#[tokio::test]
async fn pings_for_real() {
    if std::env::var("RACKPATH_TEST_PING").is_err() {
        eprintln!("RACKPATH_TEST_PING not set; skipped");
        return;
    }
    let up = RealNetwork
        .sweep(vec![
            "127.0.0.1".parse().unwrap(),
            "127.0.0.2".parse().unwrap(),
            "192.0.2.77".parse().unwrap(),
        ])
        .await
        .expect("sweep");
    assert_eq!(
        up,
        vec![
            "127.0.0.1".parse::<std::net::Ipv4Addr>().unwrap(),
            "127.0.0.2".parse().unwrap()
        ]
    );
}
