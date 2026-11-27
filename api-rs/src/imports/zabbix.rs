//! Zabbix (read-only, inventory only): hosts become devices with their
//! interface IPs, inventory model/serial/vendor, and an "Open in Zabbix"
//! link. No monitoring data (problems, availability, graphs) is read.
//!
//! Auth: an API token (Zabbix 5.4+; recommended, read-only user) or a
//! username and password. Uses the JSON-RPC API at `api_jsonrpc.php`.

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};

use super::http::{s, Http};
use super::{mac, text, Covers, Snapshot, SrcDevice};

pub struct Config {
    pub base_url: String,
    pub verify_tls: bool,
    pub token: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

async fn call(
    http: &Http,
    method: &str,
    params: Value,
    auth: Option<&str>,
) -> Result<Value, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json-rpc"),
    );
    let mut body = json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": 1 });
    if let Some(a) = auth {
        // Zabbix 6.4+ reads the bearer header; older versions the "auth" field.
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {a}"))
                .map_err(|_| "The token has characters that can't be sent")?,
        );
        if method != "apiinfo.version" {
            body["auth"] = json!(a);
        }
    }
    let r = http.post("/api_jsonrpc.php", &body, &headers).await?;
    if r.is_html() || r.status == 404 {
        return Err("No Zabbix API at that address (it should end where api_jsonrpc.php lives, e.g. https://host/zabbix)".into());
    }
    let v = r
        .json()
        .ok_or_else(|| format!("Zabbix answered HTTP {} without JSON", r.status))?;
    if let Some(err) = v.get("error") {
        let msg = s(err, "data")
            .or(s(err, "message"))
            .unwrap_or_else(|| "API error".into());
        return Err(format!("Zabbix: {msg}"));
    }
    v.get("result")
        .cloned()
        .ok_or_else(|| "Zabbix answered without a result".into())
}

async fn login(cfg: &Config) -> Result<(Http, String, bool), String> {
    let http = Http::new(&cfg.base_url, cfg.verify_tls)?;
    if let Some(t) = &cfg.token {
        return Ok((http, t.clone(), false));
    }
    let (Some(u), Some(p)) = (&cfg.username, &cfg.password) else {
        return Err("Give an API token, or a username and password".into());
    };
    // Zabbix 6.4+ takes "username"; older versions "user".
    let token = match call(
        &http,
        "user.login",
        json!({ "username": u, "password": p }),
        None,
    )
    .await
    {
        Ok(t) => t,
        Err(_) => {
            call(
                &http,
                "user.login",
                json!({ "user": u, "password": p }),
                None,
            )
            .await?
        }
    };
    let token = token
        .as_str()
        .ok_or("Zabbix login returned no session")?
        .to_string();
    Ok((http, token, true))
}

pub async fn test(cfg: &Config) -> Result<(), String> {
    fetch(cfg).await.map(|_| ())
}

pub async fn fetch(cfg: &Config) -> Result<Snapshot, String> {
    let (http, auth, session) = login(cfg).await?;
    let params = json!({
        "output": ["hostid", "host", "name", "status"],
        "selectInterfaces": ["ip", "dns", "main", "type"],
        "selectHostGroups": ["name"],
        "selectInventory": ["hardware", "model", "vendor", "serialno_a", "os", "macaddress_a", "type"],
    });
    let hosts = match call(&http, "host.get", params.clone(), Some(&auth)).await {
        Ok(h) => h,
        // Before 6.2 host groups were "selectGroups".
        Err(e) if e.contains("selectHostGroups") => {
            let mut p = params;
            if let Some(o) = p.as_object_mut() {
                o.remove("selectHostGroups");
                o.insert("selectGroups".into(), json!(["name"]));
            }
            call(&http, "host.get", p, Some(&auth)).await?
        }
        Err(e) => return Err(e),
    };
    if session {
        let _ = call(&http, "user.logout", json!([]), Some(&auth)).await;
    }
    Ok(Snapshot {
        devices: map_hosts(&hosts, &cfg.base_url),
        covers: Covers {
            devices: true,
            ..Default::default()
        },
        ..Default::default()
    })
}

const TYPE_HINTS: &[(&str, &str)] = &[
    ("firewall", "firewall"),
    ("router", "router"),
    ("gateway", "router"),
    ("switch", "switch"),
    ("access point", "access_point"),
    ("wireless", "access_point"),
    ("printer", "printer"),
    ("camera", "camera"),
    ("ups", "ups"),
    ("pdu", "pdu"),
    ("nas", "nas"),
    ("storage", "nas"),
    ("server", "server"),
    ("hypervisor", "server"),
];

/// A device type from host group names (or the inventory type field).
fn infer_type(groups: &[String]) -> &'static str {
    for g in groups {
        let g = g.to_ascii_lowercase();
        for (hint, t) in TYPE_HINTS {
            if g.contains(hint) {
                return t;
            }
        }
    }
    "misc"
}

pub fn map_hosts(v: &Value, base_url: &str) -> Vec<SrcDevice> {
    v.as_array()
        .map(|hosts| {
            hosts
                .iter()
                .filter_map(|h| {
                    let id = s(h, "hostid")?;
                    let groups: Vec<String> = h
                        .get("hostgroups")
                        .or(h.get("groups"))
                        .and_then(Value::as_array)
                        .map(|g| g.iter().filter_map(|x| s(x, "name")).collect())
                        .unwrap_or_default();
                    let inv = h
                        .get("inventory")
                        .filter(|i| i.is_object())
                        .cloned()
                        .unwrap_or(json!({}));
                    let mut hints = groups.clone();
                    hints.extend(s(&inv, "type"));
                    let mut ips: Vec<(bool, String)> = h
                        .get("interfaces")
                        .and_then(Value::as_array)
                        .map(|ifs| {
                            ifs.iter()
                                .filter_map(|i| {
                                    let ip = s(i, "ip")
                                        .filter(|ip| ip != "127.0.0.1" && ip != "0.0.0.0")?;
                                    Some((s(i, "main").as_deref() == Some("1"), ip))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    // The main interface first.
                    ips.sort_by_key(|(main, _)| !*main);
                    let mut seen = std::collections::HashSet::new();
                    let ips: Vec<String> = ips
                        .into_iter()
                        .map(|(_, ip)| ip)
                        .filter(|ip| seen.insert(ip.clone()))
                        .collect();
                    Some(SrcDevice {
                        external_url: Some(format!(
                            "{}/zabbix.php?action=host.edit&hostid={id}",
                            base_url.trim_end_matches('/')
                        )),
                        external_id: id,
                        name: text(s(h, "name").or(s(h, "host")).as_deref(), 255),
                        hostname: text(s(h, "host").as_deref(), 255),
                        type_key: infer_type(&hints).to_string(),
                        mac: s(&inv, "macaddress_a").and_then(|m| mac(&m)),
                        ips,
                        manufacturer: text(s(&inv, "vendor").as_deref(), 100),
                        model: text(s(&inv, "model").or(s(&inv, "hardware")).as_deref(), 100),
                        serial: text(s(&inv, "serialno_a").as_deref(), 100),
                        firmware: text(s(&inv, "os").as_deref(), 100),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_become_devices() {
        let v = json!([
            { "hostid": "10501", "host": "core-sw-1", "name": "Core switch 1",
              "interfaces": [ { "ip": "10.0.0.3", "main": "0" }, { "ip": "10.0.0.2", "main": "1" }, { "ip": "10.0.0.2", "main": "0" } ],
              "hostgroups": [ { "name": "Network/Switches" } ],
              "inventory": { "vendor": "Cisco", "model": "C9300-48P", "serialno_a": "FOC1234", "macaddress_a": "00-11-22-33-44-55" } },
            { "hostid": "10502", "host": "app01", "groups": [ { "name": "Linux servers" } ], "interfaces": [ { "ip": "127.0.0.1", "main": "1" } ], "inventory": [] },
            { "host": "no-id" }
        ]);
        let d = map_hosts(&v, "https://zbx.example.com/zabbix/");
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].type_key, "switch");
        assert_eq!(
            d[0].ips,
            vec!["10.0.0.2", "10.0.0.3"],
            "main interface first, no duplicates"
        );
        assert_eq!(d[0].mac.as_deref(), Some("00:11:22:33:44:55"));
        assert_eq!(d[0].model.as_deref(), Some("C9300-48P"));
        assert_eq!(
            d[0].external_url.as_deref(),
            Some("https://zbx.example.com/zabbix/zabbix.php?action=host.edit&hostid=10501")
        );
        assert_eq!(d[1].type_key, "server");
        assert!(d[1].ips.is_empty(), "loopback skipped");
        assert_eq!(d[1].name.as_deref(), Some("app01"));
    }
}
