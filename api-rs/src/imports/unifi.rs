//! UniFi Network, Protect and Access (read-only, inventory only).
//!
//! * **Network:** devices (gateways, switches, access points) with their
//!   management IPs; networks with VLAN, subnet and gateway; and, unless
//!   switched off, DHCP: each network's DHCP range and DNS servers, and
//!   clients with a fixed IP as reservations. With "lease snapshot" on, the
//!   connected clients become the lease layer.
//! * **Protect:** cameras. **Access:** hubs and readers.
//!
//! Auth: an API key (UniFi OS consoles, local address only) in `X-API-KEY`,
//! or a local username and password (cookie session; older controllers
//! too). Nothing is ever written to the console.

use reqwest::header::{HeaderMap, HeaderValue, COOKIE};
use serde_json::{json, Value};

use super::http::{list, s, Http};
use super::{
    mac, text, Covers, Snapshot, SrcDevice, SrcLease, SrcNetwork, SrcReservation, SrcWlan,
};
use crate::domain::ip::{parse_cidr, Addr, Cidr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum App {
    Network,
    Protect,
    Access,
}

pub struct Config {
    pub app: App,
    pub base_url: String,
    pub verify_tls: bool,
    pub api_key: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub site: String,
    pub import_dhcp: bool,
    pub lease_snapshot: bool,
}

const PROTECT_ONLY: &str =
    "This console answered with its web page instead of data: it may run Protect only. Use a UniFi Protect integration instead.";

struct Session {
    http: Http,
    headers: HeaderMap,
    /// "/proxy/network" on UniFi OS consoles, "" on older controllers.
    prefix: &'static str,
}

async fn session(cfg: &Config) -> Result<Session, String> {
    let http = Http::new(&cfg.base_url, cfg.verify_tls)?;
    let mut headers = HeaderMap::new();
    headers.insert("accept", HeaderValue::from_static("application/json"));
    if let Some(key) = &cfg.api_key {
        headers.insert(
            "x-api-key",
            HeaderValue::from_str(key)
                .map_err(|_| "The API key has characters that can't be sent")?,
        );
        return Ok(Session {
            http,
            headers,
            prefix: "/proxy/network",
        });
    }
    let (Some(user), Some(pass)) = (&cfg.username, &cfg.password) else {
        return Err("Give an API key, or a username and password".into());
    };
    let creds = json!({ "username": user, "password": pass });
    // UniFi OS first, then the older standalone controller.
    for (path, prefix) in [("/api/auth/login", "/proxy/network"), ("/api/login", "")] {
        let r = http.post(path, &creds, &headers).await?;
        if !r.ok() {
            continue;
        }
        let cookie: Vec<String> = r
            .headers
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|c| c.split(';').next().map(str::to_string))
            .collect();
        let mut h = headers.clone();
        if !cookie.is_empty() {
            h.insert(
                COOKIE,
                HeaderValue::from_str(&cookie.join("; ")).map_err(|_| "Bad session cookie")?,
            );
        }
        if let Some(csrf) = r.headers.get("x-csrf-token") {
            h.insert("x-csrf-token", csrf.clone());
        }
        return Ok(Session {
            http,
            headers: h,
            prefix,
        });
    }
    Err("Sign-in to the UniFi console failed (check the username and password; it must be a local account)".into())
}

/// GETs the first path that answers with JSON.
async fn first_json(s: &Session, paths: &[String]) -> Result<Value, String> {
    let mut last = String::from("No data");
    for p in paths {
        let r = s.http.get(p, &s.headers).await?;
        if r.is_html() {
            last = PROTECT_ONLY.into();
            continue;
        }
        if r.status == 401 || r.status == 403 {
            return Err("The console refused the credentials (401/403)".into());
        }
        if r.ok() {
            if let Some(v) = r.json() {
                return Ok(v);
            }
        }
        last = format!("The console answered HTTP {} for {p}", r.status);
    }
    Err(last)
}

fn site_path(s: &Session, site: &str, rest: &str) -> String {
    format!("{}/api/s/{site}/{rest}", s.prefix)
}

pub async fn test(cfg: &Config) -> Result<(), String> {
    fetch(cfg).await.map(|_| ())
}

pub async fn fetch(cfg: &Config) -> Result<Snapshot, String> {
    let sess = session(cfg).await?;
    let site = cfg.site.as_str();
    match cfg.app {
        App::Network => {
            let devices = first_json(
                &sess,
                &[
                    site_path(&sess, site, "stat/device"),
                    format!("{}/v2/api/site/{site}/device", sess.prefix),
                ],
            )
            .await?;
            let networks = first_json(&sess, &[site_path(&sess, site, "rest/networkconf")]).await?;
            let mut snap = Snapshot {
                devices: map_devices(&devices),
                networks: map_networks(&networks, cfg.import_dhcp),
                covers: Covers {
                    devices: true,
                    networks: true,
                    reservations: cfg.import_dhcp,
                    dns: false,
                    // Set once the Wi-Fi list has been read (below).
                    wlans: false,
                },
                ..Default::default()
            };
            if cfg.import_dhcp {
                let users = first_json(&sess, &[site_path(&sess, site, "rest/user")]).await?;
                snap.reservations = map_fixed_ips(&users);
            }
            // Wi-Fi networks. A controller that won't list them (an older
            // version, or a key without that permission) doesn't stop the
            // sync: Wi-Fi is then left as it is.
            if let Ok(wlans) = first_json(&sess, &[site_path(&sess, site, "rest/wlanconf")]).await {
                snap.wlans = map_wlans(&wlans, &networks);
                snap.covers.wlans = true;
            }
            if cfg.lease_snapshot {
                let clients = first_json(&sess, &[site_path(&sess, site, "stat/sta")]).await?;
                snap.leases = Some(map_clients(&clients));
            }
            Ok(snap)
        }
        App::Protect => {
            let v = first_json(
                &sess,
                &[
                    "/proxy/protect/integration/v1/cameras".into(),
                    "/proxy/protect/api/bootstrap".into(),
                ],
            )
            .await?;
            Ok(Snapshot {
                devices: map_cameras(&v),
                covers: Covers {
                    devices: true,
                    ..Default::default()
                },
                ..Default::default()
            })
        }
        App::Access => {
            let v = first_json(
                &sess,
                &[
                    "/proxy/access/integration/v1/devices".into(),
                    "/proxy/access/api/v2/device".into(),
                ],
            )
            .await?;
            Ok(Snapshot {
                devices: map_access(&v),
                covers: Covers {
                    devices: true,
                    ..Default::default()
                },
                ..Default::default()
            })
        }
    }
}

// ---------------------------------------------------------------- mapping

fn device_type(t: &str) -> &'static str {
    match t.to_ascii_lowercase().as_str() {
        "ugw" | "usg" | "udm" | "uxg" | "ucg" => "router",
        "usw" => "switch",
        "uap" => "access_point",
        _ => "misc",
    }
}

/// Network devices (stat/device or the v2 device list).
pub fn map_devices(v: &Value) -> Vec<SrcDevice> {
    list(v)
        .iter()
        .filter_map(|d| {
            let m = s(d, "mac").or(s(d, "macAddress")).and_then(|m| mac(&m));
            let id = m.clone().or(s(d, "_id")).or(s(d, "id"))?;
            let ip = s(d, "ip").or(s(d, "ipAddress"));
            Some(SrcDevice {
                external_id: id,
                name: text(
                    s(d, "name")
                        .or(s(d, "hostname"))
                        .or(s(d, "model"))
                        .as_deref(),
                    255,
                ),
                hostname: text(s(d, "hostname").as_deref(), 255),
                type_key: device_type(&s(d, "type").unwrap_or_default()).to_string(),
                mac: m,
                ips: ip.into_iter().collect(),
                manufacturer: Some("Ubiquiti".into()),
                model: text(s(d, "model_name").or(s(d, "model")).as_deref(), 100),
                serial: text(s(d, "serial").or(s(d, "serialNumber")).as_deref(), 100),
                firmware: text(s(d, "version").or(s(d, "firmwareVersion")).as_deref(), 100),
                external_url: None,
            })
        })
        .collect()
}

/// Networks: VLAN, subnet, gateway and (when DHCP is imported) the DHCP
/// range and DNS servers. WAN and VPN entries are skipped.
pub fn map_networks(v: &Value, import_dhcp: bool) -> Vec<SrcNetwork> {
    list(v)
        .iter()
        .filter_map(|n| {
            let purpose = s(n, "purpose").unwrap_or_default();
            if purpose == "wan"
                || purpose.starts_with("vpn")
                || purpose == "remote-user-vpn"
                || purpose == "site-vpn"
            {
                return None;
            }
            let id = s(n, "_id").or(s(n, "id"))?;
            let vlan_on = n
                .get("vlan_enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let vlan = if vlan_on {
                s(n, "vlan")
                    .and_then(|v| v.parse::<i64>().ok())
                    .filter(|v| (1..=4094).contains(v))
            } else {
                None
            };
            // ip_subnet is the gateway with its prefix length: 192.168.10.1/24.
            let (cidr, gateway) = match s(n, "ip_subnet").and_then(|x| {
                let (ip, len) = x.split_once('/')?;
                let a = crate::domain::ip::parse_addr(ip).ok()?;
                let len: u8 = len.parse().ok()?;
                let mask_bits = u32::from(a.family().bits() - len.min(a.family().bits()));
                let host = if mask_bits >= 128 {
                    u128::MAX
                } else {
                    (1u128 << mask_bits) - 1
                };
                let net = Cidr {
                    network: Addr {
                        value: a.value & !host,
                        v6: a.v6,
                    },
                    len,
                };
                Some((net.to_string(), a.to_string()))
            }) {
                Some((c, g)) if parse_cidr(&c).is_ok() => (Some(c), Some(g)),
                _ => (None, None),
            };
            let dhcp_on = import_dhcp
                && n.get("dhcpd_enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            let pools = match (dhcp_on, s(n, "dhcpd_start"), s(n, "dhcpd_stop")) {
                (true, Some(a), Some(b)) => vec![(a, b)],
                _ => vec![],
            };
            let dns_on = n
                .get("dhcpd_dns_enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let dns_servers = if import_dhcp && dns_on {
                (1..=4)
                    .filter_map(|i| s(n, &format!("dhcpd_dns_{i}")))
                    .collect()
            } else {
                vec![]
            };
            if cidr.is_none() && vlan.is_none() {
                return None;
            }
            Some(SrcNetwork {
                external_id: id,
                name: text(s(n, "name").as_deref(), 200),
                vlan,
                cidr,
                gateway,
                dns_servers,
                domain: if import_dhcp {
                    text(s(n, "domain_name").as_deref(), 253)
                } else {
                    None
                },
                pools,
                exclusions: vec![],
            })
        })
        .collect()
}

/// The Wi-Fi networks (WLANs), with the VLAN of the network each one
/// puts its clients on. Passphrases are never read.
pub fn map_wlans(v: &Value, networks: &Value) -> Vec<SrcWlan> {
    let vlan_of = |n: &Value| -> Option<i64> {
        let on = n
            .get("vlan_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        s(n, "vlan")
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| on && (1..=4094).contains(v))
    };
    let flag = |w: &Value, k: &str| w.get(k).and_then(Value::as_bool).unwrap_or(false);
    list(v)
        .iter()
        .filter_map(|w| {
            let id = s(w, "_id").or(s(w, "id"))?;
            let ssid = s(w, "name")?.trim().to_string();
            if ssid.is_empty() || ssid.chars().count() > 32 {
                return None;
            }
            let security = match s(w, "security").unwrap_or_default().as_str() {
                "wpaeap" => "enterprise",
                "wpapsk" | "wpa2" | "wpa3" => {
                    match (flag(w, "wpa3_support"), flag(w, "wpa3_transition")) {
                        (true, false) => "wpa3",
                        (true, true) => "wpa2_wpa3",
                        _ => "wpa2",
                    }
                }
                _ if flag(w, "wpa3_enhanced_open") => "owe",
                _ => "open",
            };
            // Newer controllers name the network; older ones put a VLAN
            // on the WLAN itself.
            let vlan = match s(w, "networkconf_id") {
                Some(net) => list(networks)
                    .iter()
                    .find(|n| s(n, "_id").as_deref() == Some(net.as_str()))
                    .and_then(vlan_of),
                None => vlan_of(w),
            };
            Some(SrcWlan {
                external_id: id,
                ssid,
                security: security.into(),
                hidden: flag(w, "hide_ssid"),
                vlan,
                enabled: w.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            })
        })
        .collect()
}

/// Clients with a fixed IP: UniFi's DHCP reservations.
pub fn map_fixed_ips(v: &Value) -> Vec<SrcReservation> {
    list(v)
        .iter()
        .filter(|c| {
            c.get("use_fixedip")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|c| {
            Some(SrcReservation {
                ip: s(c, "fixed_ip")?,
                mac: s(c, "mac").and_then(|m| mac(&m)),
                name: text(s(c, "name").or(s(c, "hostname")).as_deref(), 253),
                description: text(s(c, "note").as_deref(), 255),
            })
        })
        .collect()
}

/// Connected clients, for the lease layer.
pub fn map_clients(v: &Value) -> Vec<SrcLease> {
    list(v)
        .iter()
        .filter_map(|c| {
            Some(SrcLease {
                ip: s(c, "ip")?,
                mac: s(c, "mac").and_then(|m| mac(&m)),
                hostname: text(s(c, "hostname").or(s(c, "name")).as_deref(), 253),
                expires_at: None,
                state: Some("connected".into()),
            })
        })
        .collect()
}

/// Protect cameras, from the integration API or the bootstrap document.
pub fn map_cameras(v: &Value) -> Vec<SrcDevice> {
    let cams = match v.get("cameras").and_then(Value::as_array) {
        Some(c) => c.clone(),
        None => list(v),
    };
    cams.iter()
        .filter_map(|c| {
            let m = s(c, "mac").and_then(|m| mac(&m));
            let id = s(c, "id").or(m.clone())?;
            Some(SrcDevice {
                external_id: id,
                name: text(s(c, "name").or(s(c, "marketName")).as_deref(), 255),
                hostname: None,
                type_key: "camera".into(),
                mac: m,
                ips: s(c, "host").or(s(c, "ipAddress")).into_iter().collect(),
                manufacturer: Some("Ubiquiti".into()),
                model: text(
                    s(c, "marketName")
                        .or(s(c, "type"))
                        .or(s(c, "modelKey"))
                        .as_deref(),
                    100,
                ),
                serial: None,
                firmware: text(s(c, "firmwareVersion").as_deref(), 100),
                external_url: None,
            })
        })
        .collect()
}

/// Access hubs and readers (nested lists are flattened).
pub fn map_access(v: &Value) -> Vec<SrcDevice> {
    fn flatten(v: &Value, out: &mut Vec<Value>) {
        match v {
            Value::Array(a) => a.iter().for_each(|x| flatten(x, out)),
            Value::Object(o) if o.contains_key("mac") || o.contains_key("unique_id") => {
                out.push(v.clone())
            }
            Value::Object(o) => o.values().for_each(|x| flatten(x, out)),
            _ => {}
        }
    }
    let mut items = Vec::new();
    flatten(&Value::Array(list(v)), &mut items);
    items
        .iter()
        .filter_map(|d| {
            let m = s(d, "mac").and_then(|m| mac(&m));
            let id = s(d, "unique_id").or(s(d, "id")).or(m.clone())?;
            let kind = format!(
                "{} {}",
                s(d, "type").unwrap_or_default(),
                s(d, "device_type").unwrap_or_default()
            );
            Some(SrcDevice {
                external_id: id,
                name: text(s(d, "alias").or(s(d, "name")).as_deref(), 255),
                hostname: None,
                type_key: if kind.to_ascii_lowercase().contains("reader")
                    || kind.to_ascii_lowercase().contains("intercom")
                {
                    "door_reader".into()
                } else {
                    "access_control_panel".into()
                },
                mac: m,
                ips: s(d, "ip").into_iter().collect(),
                manufacturer: Some("Ubiquiti".into()),
                model: text(s(d, "model").or(s(d, "type")).as_deref(), 100),
                serial: None,
                firmware: text(s(d, "firmware").or(s(d, "version")).as_deref(), 100),
                external_url: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices() {
        let v = json!({ "data": [
            { "_id": "x1", "mac": "F0:9F:C2:00:00:01", "ip": "192.168.1.1", "name": "Gateway", "type": "udm", "model": "UDMPRO", "serial": "F09FC2000001", "version": "4.0.6" },
            { "mac": "f0:9f:c2:00:00:02", "ip": "192.168.1.2", "type": "usw", "model": "US8P60" },
            { "type": "uap" }
        ]});
        let d = map_devices(&v);
        assert_eq!(d.len(), 2, "no id, no device");
        assert_eq!(d[0].external_id, "f0:9f:c2:00:00:01");
        assert_eq!(d[0].type_key, "router");
        assert_eq!(d[0].ips, vec!["192.168.1.1"]);
        assert_eq!(d[1].name.as_deref(), Some("US8P60"), "model when unnamed");
        assert_eq!(d[1].type_key, "switch");
    }

    #[test]
    fn networks_with_and_without_dhcp() {
        let v = json!({ "data": [
            { "_id": "n1", "name": "LAN", "purpose": "corporate", "ip_subnet": "192.168.1.1/24", "dhcpd_enabled": true,
              "dhcpd_start": "192.168.1.6", "dhcpd_stop": "192.168.1.254", "dhcpd_dns_enabled": true, "dhcpd_dns_1": "1.1.1.1",
              "domain_name": "home.lan" },
            { "_id": "n2", "name": "IoT", "purpose": "corporate", "vlan_enabled": true, "vlan": "30", "ip_subnet": "10.0.30.1/24",
              "dhcpd_enabled": true, "dhcpd_start": "10.0.30.100", "dhcpd_stop": "10.0.30.199" },
            { "_id": "w", "purpose": "wan", "name": "Internet" },
            { "_id": "v", "purpose": "vlan-only", "vlan": 99, "name": "Trunk only" }
        ]});
        let n = map_networks(&v, true);
        assert_eq!(n.len(), 3);
        assert_eq!(n[0].cidr.as_deref(), Some("192.168.1.0/24"));
        assert_eq!(n[0].gateway.as_deref(), Some("192.168.1.1"));
        assert_eq!(n[0].vlan, None, "the default LAN is untagged");
        assert_eq!(
            n[0].pools,
            vec![("192.168.1.6".into(), "192.168.1.254".into())]
        );
        assert_eq!(n[0].dns_servers, vec!["1.1.1.1"]);
        assert_eq!(n[1].vlan, Some(30));
        assert_eq!(n[2].cidr, None);
        assert_eq!(n[2].vlan, Some(99));
        let n = map_networks(&v, false);
        assert!(n[0].pools.is_empty() && n[0].dns_servers.is_empty() && n[0].domain.is_none());
    }

    #[test]
    fn wlans() {
        let networks = json!({ "data": [
            { "_id": "n1", "name": "LAN" },
            { "_id": "n2", "name": "IoT", "vlan_enabled": true, "vlan": 40 },
        ] });
        let v = json!({ "data": [
            { "_id": "w1", "name": "Home", "security": "wpapsk", "networkconf_id": "n1", "x_passphrase": "secret" },
            { "_id": "w2", "name": "Things", "security": "wpapsk", "wpa3_support": true, "wpa3_transition": true,
              "networkconf_id": "n2", "hide_ssid": true },
            { "_id": "w3", "name": "Office", "security": "wpaeap", "vlan_enabled": true, "vlan": "20", "enabled": false },
            { "_id": "w4", "name": "Guests", "security": "open", "wpa3_enhanced_open": true },
            { "_id": "w5", "name": "Lab", "security": "wpapsk", "wpa3_support": true },
            { "_id": "w6", "name": "" },
        ] });
        let w = map_wlans(&v, &networks);
        let got: Vec<_> = w
            .iter()
            .map(|w| {
                (
                    w.ssid.as_str(),
                    w.security.as_str(),
                    w.hidden,
                    w.vlan,
                    w.enabled,
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("Home", "wpa2", false, None, true),
                ("Things", "wpa2_wpa3", true, Some(40), true),
                ("Office", "enterprise", false, Some(20), false),
                ("Guests", "owe", false, None, true),
                ("Lab", "wpa3", false, None, true),
            ]
        );
        assert!(!format!("{w:?}").contains("secret"), "never the passphrase");
    }

    #[test]
    fn fixed_ips_and_clients() {
        let users = json!({ "data": [
            { "mac": "aa:bb:cc:00:00:01", "name": "NAS", "use_fixedip": true, "fixed_ip": "192.168.1.10" },
            { "mac": "aa:bb:cc:00:00:02", "hostname": "phone", "use_fixedip": false }
        ]});
        let r = map_fixed_ips(&users);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].name.as_deref(), Some("NAS"));
        let clients = json!({ "data": [ { "mac": "aa:bb:cc:00:00:02", "ip": "192.168.1.150", "hostname": "phone" }, { "mac": "x" } ]});
        assert_eq!(map_clients(&clients).len(), 1);
    }

    #[test]
    fn cameras_and_access() {
        let boot = json!({ "cameras": [ { "id": "c1", "name": "Front door", "mac": "AABBCC000010", "host": "192.168.1.50", "marketName": "G4 Bullet", "firmwareVersion": "4.69" } ] });
        let c = map_cameras(&boot);
        assert_eq!(c[0].type_key, "camera");
        assert_eq!(c[0].mac.as_deref(), Some("aa:bb:cc:00:00:10"));
        assert_eq!(c[0].ips, vec!["192.168.1.50"]);
        let integ =
            json!([ { "id": "c2", "name": "Yard", "mac": "aabbcc000011", "modelKey": "camera" } ]);
        assert_eq!(map_cameras(&integ)[0].ips.len(), 0);
        let access = json!({ "data": [ [ { "unique_id": "h1", "alias": "Hub", "type": "UAH", "mac": "aabbcc000020", "ip": "192.168.1.60" },
                                         { "unique_id": "r1", "name": "Front reader", "device_type": "UA-Reader-Lite", "mac": "aabbcc000021" } ] ] });
        let a = map_access(&access);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].type_key, "access_control_panel");
        assert_eq!(a[1].type_key, "door_reader");
    }
}
