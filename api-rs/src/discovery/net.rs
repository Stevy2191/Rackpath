//! What discovery sends on the network: ICMP echo requests, reverse DNS
//! lookups and read-only SNMP GET/GETBULK requests. Behind a trait so tests
//! can stand in a fake network.
//!
//! Safety: callers check targets against `domain::discovery` first; this
//! layer paces sweeps (a fixed number of probes in flight, one echo request
//! per address, a short timeout) and bounds SNMP walks (rows and time).
//! There is no SNMP SET anywhere in Rackpath.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use snmp2::v3::{Auth, AuthProtocol, Cipher, Security};
use snmp2::{AsyncSession, Oid, Value};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::domain::discovery::{
    arp_index_ip, fdb_index_mac, mac_from_bytes, PING_TIMEOUT_MS, SWEEP_CONCURRENCY,
};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How to log in to an SNMP device. Secrets only live here in memory,
/// decrypted for the length of one poll.
#[derive(Clone)]
pub enum SnmpAuth {
    V2c {
        community: String,
    },
    V3 {
        username: String,
        auth_protocol: String,
        auth_password: String,
        /// None: authNoPriv (authenticated, not encrypted).
        privacy: Option<(String, String)>,
    },
}

#[derive(Clone)]
pub struct SnmpTarget {
    pub ip: IpAddr,
    pub port: u16,
    pub auth: SnmpAuth,
    pub read_arp: bool,
    pub read_mac_table: bool,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct SnmpTables {
    pub sys_name: Option<String>,
    /// (IP address, MAC) from the ARP / neighbour table.
    pub arp: Vec<(IpAddr, String)>,
    /// (MAC, port name) from the bridge forwarding table.
    pub fdb: Vec<(String, String)>,
}

pub trait Network: Send + Sync {
    /// Pings each address once and returns the ones that answered.
    fn sweep(&self, targets: Vec<Ipv4Addr>) -> BoxFut<'_, Result<Vec<Ipv4Addr>, String>>;
    /// The PTR name of an address, if any.
    fn reverse_dns(&self, ip: IpAddr) -> BoxFut<'_, Option<String>>;
    /// Reads sysName and, as asked, the ARP and MAC address tables.
    fn snmp(&self, target: SnmpTarget) -> BoxFut<'_, Result<SnmpTables, String>>;
}

/// The real network.
pub struct RealNetwork;

impl Network for RealNetwork {
    fn sweep(&self, targets: Vec<Ipv4Addr>) -> BoxFut<'_, Result<Vec<Ipv4Addr>, String>> {
        Box::pin(sweep(targets))
    }
    fn reverse_dns(&self, ip: IpAddr) -> BoxFut<'_, Option<String>> {
        Box::pin(async move {
            let lookup = tokio::task::spawn_blocking(move || dns_lookup::lookup_addr(&ip).ok());
            match tokio::time::timeout(Duration::from_secs(2), lookup).await {
                Ok(Ok(Some(name))) if name != ip.to_string() => {
                    Some(name.trim_end_matches('.').chars().take(253).collect())
                }
                _ => None,
            }
        })
    }
    fn snmp(&self, target: SnmpTarget) -> BoxFut<'_, Result<SnmpTables, String>> {
        Box::pin(async move {
            // The whole poll, however large the tables, is bounded.
            match tokio::time::timeout(Duration::from_secs(120), poll(&target)).await {
                Ok(r) => r,
                Err(_) => Err("The device took over two minutes to answer; stopped".into()),
            }
        })
    }
}

async fn sweep(targets: Vec<Ipv4Addr>) -> Result<Vec<Ipv4Addr>, String> {
    use surge_ping::{Client, Config, PingIdentifier, PingSequence, ICMP};
    let client = Client::new(&Config::builder().kind(ICMP::V4).build()).map_err(|e| {
        format!(
            "Can't send ping ({e}). Rackpath uses unprivileged ICMP sockets: allow them with the \
             sysctl net.ipv4.ping_group_range=\"0 2147483647\" (docker-compose.yml sets it)"
        )
    })?;
    let gate = Arc::new(Semaphore::new(SWEEP_CONCURRENCY));
    let ident = PingIdentifier(rand::random());
    let mut tasks = JoinSet::new();
    for ip in targets {
        let client = client.clone();
        let gate = gate.clone();
        tasks.spawn(async move {
            let _permit = gate.acquire_owned().await.ok()?;
            let mut pinger = client.pinger(IpAddr::V4(ip), ident).await;
            pinger.timeout(Duration::from_millis(PING_TIMEOUT_MS));
            pinger
                .ping(PingSequence(0), &[0u8; 16])
                .await
                .is_ok()
                .then_some(ip)
        });
    }
    let mut up = Vec::new();
    while let Some(r) = tasks.join_next().await {
        if let Ok(Some(ip)) = r {
            up.push(ip);
        }
    }
    up.sort();
    Ok(up)
}

// ---------------------------------------------------------------- SNMP

const SYS_NAME: &[u64] = &[1, 3, 6, 1, 2, 1, 1, 5, 0];
const IP_NET_TO_PHYSICAL_PHYS: &[u64] = &[1, 3, 6, 1, 2, 1, 4, 35, 1, 4];
const IP_NET_TO_MEDIA_PHYS: &[u64] = &[1, 3, 6, 1, 2, 1, 4, 22, 1, 2];
const DOT1Q_TP_FDB_PORT: &[u64] = &[1, 3, 6, 1, 2, 1, 17, 7, 1, 2, 2, 1, 2];
const DOT1D_TP_FDB_PORT: &[u64] = &[1, 3, 6, 1, 2, 1, 17, 4, 3, 1, 2];
const DOT1D_BASE_PORT_IFINDEX: &[u64] = &[1, 3, 6, 1, 2, 1, 17, 1, 4, 1, 2];
const IF_NAME: &[u64] = &[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1];

/// Each request waits this long for its reply.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// A walk stops after this many rows.
const MAX_ROWS: usize = 50_000;

/// A row value, copied out of the response.
enum Cell {
    Bytes(Vec<u8>),
    Int(i64),
    Other,
}

async fn session(t: &SnmpTarget) -> Result<AsyncSession, String> {
    let addr = SocketAddr::new(t.ip, t.port);
    let req_id: i32 = rand::random::<i32>().abs();
    let mut s = match &t.auth {
        SnmpAuth::V2c { community } => AsyncSession::new_v2c(addr, community.as_bytes(), req_id)
            .await
            .map_err(|e| format!("Can't open a socket: {e}"))?,
        SnmpAuth::V3 {
            username,
            auth_protocol,
            auth_password,
            privacy,
        } => {
            let proto = match auth_protocol.as_str() {
                "sha1" => AuthProtocol::Sha1,
                "sha256" => AuthProtocol::Sha256,
                "sha384" => AuthProtocol::Sha384,
                "sha512" => AuthProtocol::Sha512,
                other => return Err(format!("Unsupported authentication protocol {other}")),
            };
            let auth = match privacy {
                None => Auth::AuthNoPriv,
                Some((cipher, password)) => Auth::AuthPriv {
                    cipher: match cipher.as_str() {
                        "aes128" => Cipher::Aes128,
                        "aes192" => Cipher::Aes192,
                        "aes256" => Cipher::Aes256,
                        other => return Err(format!("Unsupported privacy protocol {other}")),
                    },
                    privacy_password: password.as_bytes().to_vec(),
                },
            };
            let sec = Security::new(username.as_bytes(), auth_password.as_bytes())
                .with_auth_protocol(proto)
                .with_auth(auth);
            AsyncSession::new_v3(addr, req_id, sec)
                .await
                .map_err(|e| format!("Can't open a socket: {e}"))?
        }
    };
    if matches!(t.auth, SnmpAuth::V3 { .. }) {
        match tokio::time::timeout(REQUEST_TIMEOUT, s.init()).await {
            Err(_) => return Err(no_answer()),
            Ok(Err(e)) => return Err(snmp_error(&e)),
            Ok(Ok(())) => {}
        }
    }
    Ok(s)
}

fn no_answer() -> String {
    "No answer. Check the address, that SNMP is on, the credentials, and that the device accepts SNMP from Rackpath's address".into()
}

fn snmp_error(e: &snmp2::Error) -> String {
    match e {
        snmp2::Error::AuthFailure(_) => {
            "The device refused the SNMPv3 user, passwords or protocols".into()
        }
        snmp2::Error::CommunityMismatch => "The device answered with another community".into(),
        other => format!("SNMP error: {other:?}"),
    }
}

async fn poll(t: &SnmpTarget) -> Result<SnmpTables, String> {
    let mut s = session(t).await?;
    let sys_oid = Oid::from(SYS_NAME).map_err(|_| "bad OID")?;
    let sys_name = match tokio::time::timeout(REQUEST_TIMEOUT, s.get(&sys_oid)).await {
        Err(_) => return Err(no_answer()),
        Ok(Err(e)) => return Err(snmp_error(&e)),
        Ok(Ok(mut pdu)) => pdu.varbinds.next().and_then(|(_, v)| match v {
            Value::OctetString(b) => {
                let n = String::from_utf8_lossy(b).trim().to_string();
                (!n.is_empty()).then(|| n.chars().take(100).collect())
            }
            _ => None,
        }),
    };
    let mut out = SnmpTables {
        sys_name,
        ..Default::default()
    };
    if t.read_arp {
        for (legacy, base) in [
            (false, IP_NET_TO_PHYSICAL_PHYS),
            (true, IP_NET_TO_MEDIA_PHYS),
        ] {
            for (index, cell) in walk(&mut s, base).await? {
                let (Some(ip), Cell::Bytes(b)) = (arp_index_ip(legacy, &index), cell) else {
                    continue;
                };
                if let Some(mac) = mac_from_bytes(&b) {
                    if !out.arp.iter().any(|(i, _)| *i == ip) {
                        out.arp.push((ip, mac));
                    }
                }
            }
        }
    }
    if t.read_mac_table {
        let mut rows = walk(&mut s, DOT1Q_TP_FDB_PORT).await?;
        if rows.is_empty() {
            rows = walk(&mut s, DOT1D_TP_FDB_PORT).await?;
        }
        if !rows.is_empty() {
            let base_ports = walk(&mut s, DOT1D_BASE_PORT_IFINDEX).await?;
            let names = walk(&mut s, IF_NAME).await?;
            let if_index = |port: i64| {
                base_ports.iter().find_map(|(i, c)| match c {
                    Cell::Int(n) if i.first() == Some(&(port as u64)) => Some(*n),
                    _ => None,
                })
            };
            let if_name = |ix: i64| {
                names.iter().find_map(|(i, c)| match c {
                    Cell::Bytes(b) if i.first() == Some(&(ix as u64)) => Some(
                        String::from_utf8_lossy(b)
                            .trim()
                            .chars()
                            .take(60)
                            .collect::<String>(),
                    ),
                    _ => None,
                })
            };
            for (index, cell) in rows {
                let (Some(mac), Cell::Int(port)) = (fdb_index_mac(&index), cell) else {
                    continue;
                };
                // Port 0: learned on the switch itself (CPU), not a port.
                if port <= 0 {
                    continue;
                }
                let name = if_index(port)
                    .and_then(if_name)
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| format!("port {port}"));
                out.fdb.push((mac, name));
            }
        }
    }
    Ok(out)
}

/// Reads every row under `base` with GETBULK. Returns each row's index (the
/// OID components after `base`) and value. A device that doesn't have the
/// table gives no rows.
async fn walk(s: &mut AsyncSession, base: &[u64]) -> Result<Vec<(Vec<u64>, Cell)>, String> {
    let mut rows = Vec::new();
    let mut next: Vec<u64> = base.to_vec();
    loop {
        let oid = Oid::from(&next).map_err(|_| "bad OID")?;
        let pdu = match tokio::time::timeout(REQUEST_TIMEOUT, s.getbulk(&[&oid], 0, 25)).await {
            Err(_) => return Err(no_answer()),
            Ok(Err(e)) => return Err(snmp_error(&e)),
            Ok(Ok(p)) => p,
        };
        let mut advanced = false;
        let mut done = true;
        for (oid, value) in pdu.varbinds {
            let Some(parts) = oid.iter().map(|i| i.collect::<Vec<u64>>()) else {
                continue;
            };
            if !parts.starts_with(base) || matches!(value, Value::EndOfMibView) {
                done = true;
                break;
            }
            // Must move forward, or a broken agent could loop us forever.
            if parts <= next {
                done = true;
                break;
            }
            let cell = match value {
                Value::OctetString(b) => Cell::Bytes(b.to_vec()),
                Value::Integer(n) => Cell::Int(n),
                _ => Cell::Other,
            };
            rows.push((parts[base.len()..].to_vec(), cell));
            next = parts;
            advanced = true;
            done = false;
        }
        if done || !advanced || rows.len() >= MAX_ROWS {
            return Ok(rows);
        }
    }
}
