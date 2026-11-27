//! Windows DHCP and DNS (design section 15).
//!
//! Two ways in, one format:
//! * `tools/windows/Push-RackpathDhcp.ps1` posts a [`Push`] document;
//! * an `Export-DhcpServer` XML file is uploaded and read into a [`Push`].
//!
//! Scopes become prefixes with their DHCP pool and exclusions,
//! reservations become reserved addresses, static DNS records fill DNS
//! names, and leases (optional) become the lease snapshot. External ids
//! don't include the server name, so failover partners that hold the same
//! scopes de-duplicate naturally.

use std::collections::HashMap;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};

use super::{mac, text, Covers, Snapshot, SrcDns, SrcLease, SrcNetwork, SrcReservation};
use crate::domain::ip::{parse_addr, Addr};

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct Range {
    pub start: String,
    pub end: String,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct Reservation {
    pub ip: String,
    /// MAC for IPv4 (any notation); DUID for IPv6 (not a MAC, ignored).
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct ScopeV4 {
    pub scope_id: String,
    pub subnet_mask: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub start_range: Option<String>,
    #[serde(default)]
    pub end_range: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    /// DHCP options by number: 3 router, 6 DNS servers, 15 domain name.
    #[serde(default)]
    pub options: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub exclusions: Vec<Range>,
    #[serde(default)]
    pub reservations: Vec<Reservation>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct ScopeV6 {
    pub prefix: String,
    #[serde(default = "sixty_four")]
    pub prefix_length: u8,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub options: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub exclusions: Vec<Range>,
    #[serde(default)]
    pub reservations: Vec<Reservation>,
}

fn sixty_four() -> u8 {
    64
}

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct DnsRecord {
    pub zone: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct Lease {
    pub ip: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(default)]
    pub expires: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

/// What the PowerShell script sends.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct Push {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub server: Option<String>,
    #[serde(default)]
    pub generated_at: Option<String>,
    /// Server-wide options, used where a scope doesn't set its own.
    #[serde(default)]
    pub server_options: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub scopes_v4: Vec<ScopeV4>,
    #[serde(default)]
    pub scopes_v6: Vec<ScopeV6>,
    /// None when DNS wasn't exported (e.g. an XML upload).
    #[serde(default)]
    pub dns: Option<Vec<DnsRecord>>,
    /// None when lease collection is off.
    #[serde(default)]
    pub leases: Option<Vec<Lease>>,
}

fn one() -> u32 {
    1
}

/// 255.255.255.0 -> 24. None for a non-contiguous mask.
pub fn mask_len(mask: &str) -> Option<u8> {
    let a: std::net::Ipv4Addr = mask.trim().parse().ok()?;
    let v = u32::from(a);
    let len = v.leading_ones();
    (v.checked_shl(len).unwrap_or(0) == 0).then_some(len as u8)
}

/// Fully qualified, lowercase, without the trailing dot.
fn fqdn(name: &str, zone: &str) -> String {
    let name = name.trim().trim_end_matches('.');
    let zone = zone.trim().trim_end_matches('.');
    let full = if name.is_empty() || name == "@" {
        zone.to_string()
    } else if name
        .to_ascii_lowercase()
        .ends_with(&format!(".{}", zone.to_ascii_lowercase()))
    {
        name.to_string()
    } else {
        format!("{name}.{zone}")
    };
    full.to_ascii_lowercase()
}

/// The address a PTR record names: `9` in zone `30.20.10.in-addr.arpa` is
/// 10.20.30.9; IPv6 nibble zones (`ip6.arpa`) work the same way.
pub fn ptr_address(name: &str, zone: &str) -> Option<Addr> {
    let full = fqdn(name, zone);
    if let Some(rest) = full.strip_suffix(".in-addr.arpa") {
        let mut parts: Vec<&str> = rest.split('.').collect();
        if parts.len() != 4 {
            return None;
        }
        parts.reverse();
        return parse_addr(&parts.join(".")).ok();
    }
    if let Some(rest) = full.strip_suffix(".ip6.arpa") {
        let mut nibbles: Vec<&str> = rest.split('.').collect();
        if nibbles.len() != 32 || nibbles.iter().any(|n| n.len() != 1) {
            return None;
        }
        nibbles.reverse();
        let hex = nibbles.concat();
        let groups: Vec<&str> = (0..8).map(|i| &hex[i * 4..i * 4 + 4]).collect();
        return parse_addr(&groups.join(":")).ok();
    }
    None
}

fn option<'a>(
    own: &'a HashMap<String, Vec<String>>,
    server: &'a HashMap<String, Vec<String>>,
    id: &str,
) -> &'a [String] {
    own.get(id)
        .filter(|v| !v.is_empty())
        .or_else(|| server.get(id))
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn ranges(list: &[Range]) -> Vec<(String, String)> {
    list.iter()
        .map(|r| (r.start.trim().to_string(), r.end.trim().to_string()))
        .collect()
}

fn reservation(r: &Reservation) -> SrcReservation {
    SrcReservation {
        ip: r.ip.trim().to_string(),
        mac: r.client_id.as_deref().and_then(mac),
        name: text(r.name.as_deref(), 253),
        description: text(r.description.as_deref(), 255),
    }
}

/// Turns a push (or XML upload) into a snapshot. Invalid entries are
/// skipped with a note in `skipped`.
pub fn to_snapshot(p: &Push) -> (Snapshot, Vec<String>) {
    let mut snap = Snapshot {
        covers: Covers {
            devices: false,
            networks: true,
            reservations: true,
            dns: p.dns.is_some(),
        },
        ..Default::default()
    };
    let mut skipped = Vec::new();
    for s in &p.scopes_v4 {
        let Some(len) = mask_len(&s.subnet_mask) else {
            skipped.push(format!(
                "scope {}: bad subnet mask {}",
                s.scope_id, s.subnet_mask
            ));
            continue;
        };
        let id = s.scope_id.trim();
        let name = text(s.name.as_deref(), 200);
        let pools = match (&s.start_range, &s.end_range) {
            (Some(a), Some(b)) => vec![(a.trim().to_string(), b.trim().to_string())],
            _ => vec![],
        };
        snap.networks.push(SrcNetwork {
            external_id: format!("v4:{id}"),
            name: match (name, text(s.description.as_deref(), 200)) {
                (Some(n), Some(d)) => Some(format!("{n} — {d}")),
                (n, d) => n.or(d),
            },
            vlan: None,
            cidr: Some(format!("{id}/{len}")),
            gateway: option(&s.options, &p.server_options, "3").first().cloned(),
            dns_servers: option(&s.options, &p.server_options, "6").to_vec(),
            domain: option(&s.options, &p.server_options, "15").first().cloned(),
            pools,
            exclusions: ranges(&s.exclusions),
        });
        snap.reservations
            .extend(s.reservations.iter().map(reservation));
    }
    for s in &p.scopes_v6 {
        let prefix = s.prefix.trim();
        snap.networks.push(SrcNetwork {
            external_id: format!("v6:{prefix}/{}", s.prefix_length),
            name: text(s.name.as_deref(), 200).or(text(s.description.as_deref(), 200)),
            vlan: None,
            cidr: Some(format!("{prefix}/{}", s.prefix_length)),
            gateway: None,
            dns_servers: option(&s.options, &p.server_options, "23").to_vec(),
            domain: option(&s.options, &p.server_options, "24").first().cloned(),
            pools: vec![],
            exclusions: ranges(&s.exclusions),
        });
        snap.reservations
            .extend(s.reservations.iter().map(|r| SrcReservation {
                mac: None,
                ..reservation(r)
            }));
    }
    if let Some(records) = &p.dns {
        for r in records {
            match r.kind.to_ascii_uppercase().as_str() {
                "A" | "AAAA" => snap.dns.push(SrcDns {
                    name: fqdn(&r.name, &r.zone),
                    ip: r.data.trim().to_string(),
                    kind: r.kind.to_ascii_uppercase(),
                }),
                "PTR" => match ptr_address(&r.name, &r.zone) {
                    Some(a) => snap.dns.push(SrcDns {
                        name: r.data.trim().trim_end_matches('.').to_ascii_lowercase(),
                        ip: a.to_string(),
                        kind: "PTR".into(),
                    }),
                    None => {
                        skipped.push(format!("PTR {} in {}: not a reverse name", r.name, r.zone))
                    }
                },
                _ => {}
            }
        }
    }
    snap.leases = p.leases.as_ref().map(|ls| {
        ls.iter()
            .map(|l| SrcLease {
                ip: l.ip.trim().to_string(),
                mac: l.client_id.as_deref().and_then(mac),
                hostname: text(l.hostname.as_deref(), 253),
                expires_at: text(l.expires.as_deref(), 40),
                state: text(l.state.as_deref(), 40),
            })
            .collect()
    });
    (snap, skipped)
}

// ---------------------------------------------------------------- XML

/// A minimal element tree for the export file.
#[derive(Default, Debug)]
struct Node {
    name: String,
    text: String,
    children: Vec<Node>,
}

impl Node {
    fn child(&self, name: &str) -> Option<&Node> {
        self.children
            .iter()
            .find(|c| c.name.eq_ignore_ascii_case(name))
    }
    fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children
            .iter()
            .filter(move |c| c.name.eq_ignore_ascii_case(name))
    }
    fn text_of(&self, name: &str) -> Option<String> {
        self.child(name)
            .map(|c| c.text.trim().to_string())
            .filter(|t| !t.is_empty())
    }
    fn path(&self, names: &[&str]) -> Option<&Node> {
        names.iter().try_fold(self, |n, name| n.child(name))
    }
}

const MAX_ELEMENTS: usize = 2_000_000;
const MAX_DEPTH: usize = 32;

fn parse_tree(xml: &str) -> Result<Node, String> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Node> = vec![Node::default()];
    let mut count = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                count += 1;
                if count > MAX_ELEMENTS || stack.len() > MAX_DEPTH {
                    return Err("The file is too large or too deeply nested".into());
                }
                stack.push(Node {
                    name: String::from_utf8_lossy(e.local_name().as_ref()).into_owned(),
                    ..Default::default()
                });
            }
            Ok(Event::Empty(e)) => {
                count += 1;
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(Node {
                        name: String::from_utf8_lossy(e.local_name().as_ref()).into_owned(),
                        ..Default::default()
                    });
                }
            }
            Ok(Event::Text(t)) => {
                let s = t.decode().map_err(|e| e.to_string())?;
                let s = quick_xml::escape::unescape(&s).map_err(|e| e.to_string())?;
                if let Some(n) = stack.last_mut() {
                    n.text.push_str(&s);
                }
            }
            Ok(Event::GeneralRef(r)) => {
                // Only the predefined entities and character references: no
                // custom entities, so no entity expansion.
                let c = match r.resolve_char_ref() {
                    Ok(Some(c)) => c,
                    _ => match r.decode().map_err(|e| e.to_string())?.as_ref() {
                        "amp" => '&',
                        "lt" => '<',
                        "gt" => '>',
                        "quot" => '"',
                        "apos" => '\'',
                        other => return Err(format!("Unknown XML entity &{other};")),
                    },
                };
                if let Some(n) = stack.last_mut() {
                    n.text.push(c);
                }
            }
            Ok(Event::CData(t)) => {
                if let Some(n) = stack.last_mut() {
                    n.text.push_str(&String::from_utf8_lossy(&t));
                }
            }
            Ok(Event::End(_)) => {
                let done = stack.pop().ok_or("Unbalanced XML")?;
                stack
                    .last_mut()
                    .ok_or("Unbalanced XML")?
                    .children
                    .push(done);
            }
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => return Err("XML with a DOCTYPE isn't accepted".into()),
            Ok(_) => {}
            Err(e) => return Err(format!("Not a valid XML file: {e}")),
        }
    }
    if stack.len() != 1 {
        return Err("The XML file ends too early".into());
    }
    Ok(stack.pop().unwrap_or_default())
}

fn options(n: Option<&Node>) -> HashMap<String, Vec<String>> {
    let mut out = HashMap::new();
    if let Some(n) = n {
        for o in n.all("OptionValue") {
            if let Some(id) = o.text_of("OptionId") {
                let values: Vec<String> = o
                    .all("Value")
                    .map(|v| v.text.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect();
                out.insert(id, values);
            }
        }
    }
    out
}

fn xml_ranges(n: Option<&Node>) -> Vec<Range> {
    n.map(|n| {
        n.all("IPRange")
            .filter_map(|r| {
                Some(Range {
                    start: r.text_of("StartRange")?,
                    end: r.text_of("EndRange")?,
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

fn xml_reservations(n: Option<&Node>) -> Vec<Reservation> {
    n.map(|n| {
        n.all("Reservation")
            .filter_map(|r| {
                Some(Reservation {
                    ip: r.text_of("IPAddress")?,
                    client_id: r.text_of("ClientId"),
                    name: r.text_of("Name"),
                    description: r.text_of("Description"),
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Reads an `Export-DhcpServer` XML file (DHCP only; no DNS, no leases).
pub fn parse_export(xml: &str) -> Result<Push, String> {
    let root = parse_tree(xml)?;
    let server = root
        .child("DHCPServer")
        .ok_or("This isn't an Export-DhcpServer file (no <DHCPServer> element)")?;
    let mut push = Push {
        version: 1,
        server_options: options(server.path(&["IPv4", "OptionValues"])),
        ..Default::default()
    };
    if let Some(scopes) = server.path(&["IPv4", "Scopes"]) {
        for s in scopes.all("Scope") {
            let (Some(id), Some(mask)) = (s.text_of("ScopeId"), s.text_of("SubnetMask")) else {
                continue;
            };
            push.scopes_v4.push(ScopeV4 {
                scope_id: id,
                subnet_mask: mask,
                name: s.text_of("Name"),
                description: s.text_of("Description"),
                start_range: s.text_of("StartRange"),
                end_range: s.text_of("EndRange"),
                state: s.text_of("State"),
                options: options(s.child("OptionValues")),
                exclusions: xml_ranges(s.child("ExclusionRanges")),
                reservations: xml_reservations(s.child("Reservations")),
            });
        }
    }
    if let Some(scopes) = server.path(&["IPv6", "Scopes"]) {
        for s in scopes.all("Scope") {
            let Some(prefix) = s.text_of("Prefix") else {
                continue;
            };
            push.scopes_v6.push(ScopeV6 {
                prefix,
                prefix_length: 64,
                name: s.text_of("Name"),
                description: s.text_of("Description"),
                options: options(s.child("OptionValues")),
                exclusions: xml_ranges(s.child("ExclusionRanges")),
                reservations: xml_reservations(s.child("Reservations")),
            });
        }
    }
    Ok(push)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPORT: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<DHCPServer xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <MajorVersion>10</MajorVersion>
  <IPv4>
    <OptionValues>
      <OptionValue><OptionId>6</OptionId><Value>10.20.0.53</Value><Value>10.20.0.54</Value></OptionValue>
      <OptionValue><OptionId>15</OptionId><Value>corp.example.com</Value></OptionValue>
    </OptionValues>
    <Scopes>
      <Scope>
        <ScopeId>10.20.30.0</ScopeId>
        <Name>Office &amp; Lab</Name>
        <SubnetMask>255.255.255.0</SubnetMask>
        <StartRange>10.20.30.50</StartRange>
        <EndRange>10.20.30.200</EndRange>
        <State>Active</State>
        <Description />
        <OptionValues>
          <OptionValue><OptionId>3</OptionId><Value>10.20.30.1</Value></OptionValue>
        </OptionValues>
        <ExclusionRanges>
          <IPRange><StartRange>10.20.30.50</StartRange><EndRange>10.20.30.59</EndRange></IPRange>
        </ExclusionRanges>
        <Reservations>
          <Reservation>
            <Name>printer1.corp.example.com</Name>
            <IPAddress>10.20.30.60</IPAddress>
            <ClientId>aa-bb-cc-00-11-22</ClientId>
            <Type>Both</Type>
            <Description>2nd floor</Description>
          </Reservation>
        </Reservations>
      </Scope>
    </Scopes>
  </IPv4>
  <IPv6>
    <Scopes>
      <Scope><Prefix>2001:db8:30::</Prefix><Name>Office v6</Name></Scope>
    </Scopes>
  </IPv6>
</DHCPServer>"#;

    #[test]
    fn reads_an_export_file() {
        let p = parse_export(EXPORT).unwrap();
        assert_eq!(p.scopes_v4.len(), 1);
        let s = &p.scopes_v4[0];
        assert_eq!(s.name.as_deref(), Some("Office & Lab"));
        assert_eq!(s.options["3"], vec!["10.20.30.1"]);
        assert_eq!(s.exclusions[0].end, "10.20.30.59");
        assert_eq!(
            s.reservations[0].client_id.as_deref(),
            Some("aa-bb-cc-00-11-22")
        );
        assert_eq!(p.server_options["6"].len(), 2);
        assert_eq!(p.scopes_v6[0].prefix, "2001:db8:30::");
        assert!(p.dns.is_none());

        let (snap, skipped) = to_snapshot(&p);
        assert!(skipped.is_empty());
        let n = &snap.networks[0];
        assert_eq!(n.cidr.as_deref(), Some("10.20.30.0/24"));
        assert_eq!(n.gateway.as_deref(), Some("10.20.30.1"));
        assert_eq!(
            n.dns_servers,
            vec!["10.20.0.53", "10.20.0.54"],
            "server-wide option"
        );
        assert_eq!(n.domain.as_deref(), Some("corp.example.com"));
        assert_eq!(n.pools, vec![("10.20.30.50".into(), "10.20.30.200".into())]);
        assert_eq!(
            snap.reservations[0].mac.as_deref(),
            Some("aa:bb:cc:00:11:22")
        );
        assert_eq!(snap.networks[1].cidr.as_deref(), Some("2001:db8:30::/64"));
        assert!(!snap.covers.dns, "no DNS in an export file");
    }

    #[test]
    fn refuses_bad_xml() {
        assert!(parse_export("<nope/>").is_err());
        assert!(parse_export("<DHCPServer><IPv4>").is_err());
        assert!(parse_export("not xml at all <<<").is_err());
        let bomb = r#"<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><DHCPServer/>"#;
        assert!(
            parse_export(bomb).is_err(),
            "no DTDs, so no entity expansion"
        );
        let deep = format!("{}{}", "<a>".repeat(40), "</a>".repeat(40));
        assert!(parse_export(&deep).is_err());
    }

    #[test]
    fn masks_and_reverse_names() {
        assert_eq!(mask_len("255.255.255.0"), Some(24));
        assert_eq!(mask_len("255.255.252.0"), Some(22));
        assert_eq!(mask_len("255.255.255.255"), Some(32));
        assert_eq!(mask_len("0.0.0.0"), Some(0));
        assert_eq!(mask_len("255.0.255.0"), None);
        assert_eq!(
            ptr_address("9", "30.20.10.in-addr.arpa")
                .unwrap()
                .to_string(),
            "10.20.30.9"
        );
        assert_eq!(
            ptr_address("9.30", "20.10.in-addr.arpa.")
                .unwrap()
                .to_string(),
            "10.20.30.9"
        );
        let v6 = "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2";
        assert_eq!(
            ptr_address(v6, "ip6.arpa").unwrap().to_string(),
            "2001:db8::1"
        );
        assert!(ptr_address("host", "corp.example.com").is_none());
    }

    #[test]
    fn dns_records_are_qualified() {
        let p = Push {
            dns: Some(vec![
                DnsRecord {
                    zone: "corp.example.com".into(),
                    name: "Printer1".into(),
                    kind: "A".into(),
                    data: "10.20.30.60".into(),
                },
                DnsRecord {
                    zone: "corp.example.com".into(),
                    name: "@".into(),
                    kind: "A".into(),
                    data: "10.20.0.53".into(),
                },
                DnsRecord {
                    zone: "30.20.10.in-addr.arpa".into(),
                    name: "60".into(),
                    kind: "PTR".into(),
                    data: "printer1.corp.example.com.".into(),
                },
                DnsRecord {
                    zone: "corp.example.com".into(),
                    name: "mail".into(),
                    kind: "MX".into(),
                    data: "x".into(),
                },
            ]),
            ..Default::default()
        };
        let (s, _) = to_snapshot(&p);
        assert_eq!(s.dns.len(), 3, "MX ignored");
        assert_eq!(s.dns[0].name, "printer1.corp.example.com");
        assert_eq!(s.dns[1].name, "corp.example.com");
        assert_eq!(
            s.dns[2],
            SrcDns {
                name: "printer1.corp.example.com".into(),
                ip: "10.20.30.60".into(),
                kind: "PTR".into()
            }
        );
        assert!(s.covers.dns);
    }

    #[test]
    fn push_json_shape() {
        let json = r#"{"version":1,"server":"dc01","scopes_v4":[{"scope_id":"192.168.1.0","subnet_mask":"255.255.255.0",
            "options":{"3":["192.168.1.1"]},"reservations":[{"ip":"192.168.1.20","client_id":"aabbccddeeff"}]}],
            "leases":[{"ip":"192.168.1.101","client_id":"11-22-33-44-55-66","hostname":"laptop","expires":"2026-11-27T10:00:00Z"}]}"#;
        let p: Push = serde_json::from_str(json).unwrap();
        let (s, _) = to_snapshot(&p);
        assert_eq!(s.networks[0].external_id, "v4:192.168.1.0");
        assert_eq!(
            s.leases.as_ref().unwrap()[0].mac.as_deref(),
            Some("11:22:33:44:55:66")
        );
        assert!(!s.covers.dns);
    }
}
