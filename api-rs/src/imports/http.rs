//! Outbound HTTP for integrations: one client per run, bounded timeouts and
//! response sizes, and errors that never contain credentials.

use std::time::Duration;

use reqwest::header::HeaderMap;
use serde_json::Value;

/// Largest response read from a source (UniFi client lists can be big).
const MAX_BODY: usize = 64 * 1024 * 1024;

pub struct Http {
    client: reqwest::Client,
    pub base: String,
}

pub struct Reply {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    /// The body as JSON, or None (empty, HTML or not JSON).
    pub fn json(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }
    /// UniFi OS consoles answer unknown app paths with their web page.
    pub fn is_html(&self) -> bool {
        let start: Vec<u8> = self
            .body
            .iter()
            .take(64)
            .copied()
            .skip_while(u8::is_ascii_whitespace)
            .collect();
        let s = String::from_utf8_lossy(&start).to_ascii_lowercase();
        s.starts_with("<!doctype") || s.starts_with("<html")
    }
}

/// Checks a base URL: http(s), a host, no credentials or query in it.
pub fn check_base_url(url: &str) -> Result<String, String> {
    let u = url.trim().trim_end_matches('/');
    let rest = u
        .strip_prefix("https://")
        .or_else(|| u.strip_prefix("http://"))
        .ok_or("The address must start with https:// (or http://)")?;
    if rest.is_empty()
        || rest.contains('@')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains(char::is_whitespace)
    {
        return Err(
            "The address must be like https://192.168.1.1 or https://zabbix.example.com/zabbix"
                .into(),
        );
    }
    if u.to_ascii_lowercase().contains("unifi.ui.com") {
        return Err("Use your console's local address (e.g. https://192.168.1.1); the unifi.ui.com cloud proxy doesn't accept API keys".into());
    }
    Ok(u.to_string())
}

impl Http {
    pub fn new(base: &str, verify_tls: bool) -> Result<Http, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .danger_accept_invalid_certs(!verify_tls)
            .redirect(reqwest::redirect::Policy::limited(3))
            .user_agent(concat!("Rackpath/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("HTTP client: {e}"))?;
        Ok(Http {
            client,
            base: base.trim_end_matches('/').to_string(),
        })
    }

    async fn read(resp: reqwest::Response) -> Result<Reply, String> {
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let mut resp = resp;
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| describe(&e))? {
            if body.len() + chunk.len() > MAX_BODY {
                return Err("The response is too large".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Reply {
            status,
            headers,
            body,
        })
    }

    pub async fn get(&self, path: &str, headers: &HeaderMap) -> Result<Reply, String> {
        let resp = self
            .client
            .get(format!("{}{path}", self.base))
            .headers(headers.clone())
            .send()
            .await
            .map_err(|e| describe(&e))?;
        Self::read(resp).await
    }

    pub async fn post(
        &self,
        path: &str,
        body: &Value,
        headers: &HeaderMap,
    ) -> Result<Reply, String> {
        let resp = self
            .client
            .post(format!("{}{path}", self.base))
            .headers(headers.clone())
            .json(body)
            .send()
            .await
            .map_err(|e| describe(&e))?;
        Self::read(resp).await
    }
}

/// A user-facing message for a transport error, without the URL's query or
/// anything sent.
fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "The server didn't answer in time".into()
    } else if e.is_connect() {
        let tls = format!("{e:?}").to_ascii_lowercase();
        if tls.contains("certificate") || tls.contains("tls") {
            "Couldn't verify the server's certificate (turn off certificate checking for self-signed certificates)".into()
        } else {
            "Couldn't connect to the server".into()
        }
    } else if e.is_redirect() {
        "Too many redirects".into()
    } else {
        "The request failed".into()
    }
}

/// UniFi answers lists as a bare array or wrapped in `data`.
pub fn list(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.clone(),
        Value::Object(o) => ["data", "network_devices", "items", "result"]
            .iter()
            .find_map(|k| o.get(*k).and_then(Value::as_array).cloned())
            .unwrap_or_default(),
        _ => vec![],
    }
}

/// A string field, also accepting numbers.
pub fn s(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base_urls() {
        assert_eq!(
            check_base_url(" https://192.168.1.1/ ").unwrap(),
            "https://192.168.1.1"
        );
        assert!(check_base_url("http://zabbix.lan/zabbix").is_ok());
        assert!(check_base_url("ftp://x").is_err());
        assert!(check_base_url("https://user:pw@host").is_err());
        assert!(check_base_url("https://unifi.ui.com/x").is_err());
        assert!(check_base_url("https://").is_err());
    }

    #[test]
    fn lists_and_fields() {
        assert_eq!(list(&json!([1, 2])).len(), 2);
        assert_eq!(list(&json!({ "data": [1] })).len(), 1);
        assert_eq!(list(&json!({ "meta": {} })).len(), 0);
        assert_eq!(s(&json!({ "vlan": 20 }), "vlan").as_deref(), Some("20"));
        assert_eq!(s(&json!({ "n": "  " }), "n"), None);
    }

    #[test]
    fn html_detection() {
        let r = Reply {
            status: 200,
            headers: HeaderMap::new(),
            body: b"  <!DOCTYPE html><html>".to_vec(),
        };
        assert!(r.is_html());
        let r = Reply {
            status: 200,
            headers: HeaderMap::new(),
            body: b"{\"data\":[]}".to_vec(),
        };
        assert!(!r.is_html());
        assert!(r.json().is_some());
    }
}
