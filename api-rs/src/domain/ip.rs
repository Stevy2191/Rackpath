//! IP address maths for IPAM (design section 9). Pure, unit-tested.
//!
//! Every address is also kept as a 16-byte big-endian value: IPv6 as is,
//! IPv4 in its IPv4-mapped form (`::ffff:10.20.30.5`). Byte order equals
//! numeric order, so SQLite compares the BLOBs correctly, and one `u128`
//! comparison works for both families (always alongside a family check,
//! since `::/0` numerically contains the mapped IPv4 block).

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Family {
    V4,
    V6,
}

impl Family {
    pub fn number(self) -> i64 {
        match self {
            Family::V4 => 4,
            Family::V6 => 6,
        }
    }
    pub fn bits(self) -> u8 {
        match self {
            Family::V4 => 32,
            Family::V6 => 128,
        }
    }
}

const V4_MAPPED: u128 = 0xffff_u128 << 32;

/// An address as a family plus its 128-bit (mapped) value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Addr {
    pub value: u128,
    pub v6: bool,
}

impl Addr {
    /// An address on the public internet: not private (RFC 1918, ULA),
    /// shared (CGNAT 100.64/10), loopback, link-local, multicast or
    /// otherwise reserved. A router's WAN address, for instance.
    pub fn is_public(self) -> bool {
        if self.v6 {
            let seg = std::net::Ipv6Addr::from(self.value).segments();
            // Only global unicast (2000::/3) is public, minus reserved
            // blocks in 2001::/16 (Teredo, benchmarking, documentation).
            let global = (seg[0] & 0xe000) == 0x2000;
            let reserved = seg[0] == 0x2001 && (seg[1] < 0x0200 || seg[1] == 0x0db8);
            global && !reserved
        } else {
            let v = std::net::Ipv4Addr::from((self.value & 0xffff_ffff) as u32);
            let [a, b, c, _] = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_multicast()
                || v.is_broadcast()
                || v.is_unspecified()
                || v.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (18..20).contains(&b))
                || a >= 240)
        }
    }

    pub fn from_ip(ip: IpAddr) -> Addr {
        match ip {
            IpAddr::V4(v4) => Addr {
                value: V4_MAPPED | u128::from(u32::from(v4)),
                v6: false,
            },
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => Addr::from_ip(IpAddr::V4(v4)),
                None => Addr {
                    value: u128::from(v6),
                    v6: true,
                },
            },
        }
    }
    pub fn family(self) -> Family {
        if self.v6 {
            Family::V6
        } else {
            Family::V4
        }
    }
    pub fn ip(self) -> IpAddr {
        if self.v6 {
            IpAddr::V6(Ipv6Addr::from(self.value))
        } else {
            IpAddr::V4(Ipv4Addr::from((self.value & 0xffff_ffff) as u32))
        }
    }
    /// The 16-byte form stored in the database.
    pub fn bin(self) -> Vec<u8> {
        self.value.to_be_bytes().to_vec()
    }
    pub fn from_bin(bytes: &[u8]) -> Option<Addr> {
        let arr: [u8; 16] = bytes.try_into().ok()?;
        let value = u128::from_be_bytes(arr);
        let v6 = value >> 32 != 0xffff;
        Some(Addr { value, v6 })
    }
    /// The address `n` places later in the same family, if it exists.
    pub fn offset(self, n: u128) -> Option<Addr> {
        let value = self.value.checked_add(n)?;
        if !self.v6 && value > (V4_MAPPED | 0xffff_ffff) {
            return None;
        }
        Some(Addr { value, v6: self.v6 })
    }
}

impl fmt::Display for Addr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.ip())
    }
}

/// Parses an address in any usual notation. IPv4-mapped IPv6 input is
/// treated as IPv4. Zone ids (`fe80::1%eth0`) and prefix lengths are refused.
pub fn parse_addr(s: &str) -> Result<Addr, String> {
    let s = s.trim();
    s.parse::<IpAddr>()
        .map(Addr::from_ip)
        .map_err(|_| format!("{s} isn't an IP address"))
}

/// A prefix (subnet) such as `10.20.30.0/24` or `2001:db8::/48`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Cidr {
    pub network: Addr,
    pub len: u8,
}

fn host_mask(family: Family, len: u8) -> u128 {
    let host_bits = u32::from(family.bits() - len);
    if host_bits == 0 {
        0
    } else if host_bits >= 128 {
        u128::MAX
    } else {
        (1u128 << host_bits) - 1
    }
}

/// Parses `address/length`. The host bits must be zero; the error then
/// names the prefix that was probably meant.
pub fn parse_cidr(s: &str) -> Result<Cidr, String> {
    let s = s.trim();
    let Some((addr, len)) = s.split_once('/') else {
        return Err(format!("{s} needs a prefix length, e.g. 10.20.30.0/24"));
    };
    let addr = parse_addr(addr)?;
    let len: u8 = len
        .trim()
        .parse()
        .ok()
        .filter(|l| *l <= addr.family().bits())
        .ok_or_else(|| format!("The prefix length must be 0 to {}", addr.family().bits()))?;
    let mask = host_mask(addr.family(), len);
    if addr.value & mask != 0 {
        let meant = Cidr {
            network: Addr {
                value: addr.value & !mask,
                v6: addr.v6,
            },
            len,
        };
        return Err(format!("{s} has host bits set; did you mean {meant}?"));
    }
    Ok(Cidr { network: addr, len })
}

impl fmt::Display for Cidr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.network, self.len)
    }
}

impl Cidr {
    pub fn family(&self) -> Family {
        self.network.family()
    }
    pub fn start(&self) -> Addr {
        self.network
    }
    pub fn end(&self) -> Addr {
        Addr {
            value: self.network.value | host_mask(self.family(), self.len),
            v6: self.network.v6,
        }
    }
    /// Number of addresses (saturating at u128::MAX for ::/0).
    pub fn size(&self) -> u128 {
        host_mask(self.family(), self.len).saturating_add(1)
    }
    pub fn contains(&self, a: Addr) -> bool {
        a.v6 == self.network.v6 && a >= self.start() && a <= self.end()
    }
    pub fn contains_cidr(&self, other: &Cidr) -> bool {
        other.len >= self.len && self.contains(other.network)
    }
    /// First and last addresses a host may use: without the network and
    /// broadcast addresses on IPv4 (except /31 and /32), and without the
    /// subnet-router anycast address on IPv6 (except /127 and /128).
    pub fn usable(&self) -> (Addr, Addr) {
        let (s, e) = (self.start(), self.end());
        match self.family() {
            Family::V4 if self.len < 31 => (
                Addr {
                    value: s.value + 1,
                    v6: false,
                },
                Addr {
                    value: e.value - 1,
                    v6: false,
                },
            ),
            Family::V6 if self.len < 127 => (
                Addr {
                    value: s.value + 1,
                    v6: true,
                },
                e,
            ),
            _ => (s, e),
        }
    }
    /// Whether `a` is this prefix's network or broadcast address (IPv4
    /// prefixes shorter than /31 only).
    pub fn is_network_or_broadcast(&self, a: Addr) -> bool {
        self.family() == Family::V4 && self.len < 31 && (a == self.start() || a == self.end())
    }
}

/// The free runs between `first` and `last` (inclusive): what `taken`
/// (inclusive intervals, in any order, may overlap) leaves, each run split
/// where DHCP `pools` begin and end and marked inside a pool or not. At most
/// `max` runs; the flag says whether there were more.
pub fn free_runs(
    first: u128,
    last: u128,
    taken: &[(u128, u128)],
    pools: &[(u128, u128)],
    max: usize,
) -> (Vec<(u128, u128, bool)>, bool) {
    let mut taken: Vec<(u128, u128)> = taken
        .iter()
        .filter(|(s, e)| s <= e && *e >= first && *s <= last)
        .map(|&(s, e)| (s.max(first), e.min(last)))
        .collect();
    taken.sort_unstable();
    let mut gaps = Vec::new();
    let mut cursor = Some(first);
    for (s, e) in taken {
        let Some(c) = cursor else { break };
        if s > c {
            gaps.push((c, s - 1));
        }
        if e >= c {
            cursor = e.checked_add(1).filter(|n| *n <= last);
        }
    }
    if let Some(c) = cursor {
        gaps.push((c, last));
    }
    let mut pools: Vec<(u128, u128)> = pools.iter().copied().filter(|(s, e)| s <= e).collect();
    pools.sort_unstable();
    let mut out = Vec::new();
    for (a, b) in gaps {
        let mut c = a;
        loop {
            if out.len() == max {
                return (out, true);
            }
            let (end, in_pool) = match pools.iter().find(|(s, e)| *s <= c && c <= *e) {
                Some(&(_, e)) => (e.min(b), true),
                None => {
                    let next = pools.iter().map(|(s, _)| *s).filter(|s| *s > c).min();
                    (next.map_or(b, |n| (n - 1).min(b)), false)
                }
            };
            out.push((c, end, in_pool));
            match end.checked_add(1) {
                Some(n) if n <= b => c = n,
                _ => break,
            }
        }
    }
    (out, false)
}

/// The smallest prefix in `prefixes` containing `a`.
pub fn containing<'a, T>(a: Addr, prefixes: impl IntoIterator<Item = (&'a Cidr, T)>) -> Option<T> {
    prefixes
        .into_iter()
        .filter(|(c, _)| c.contains(a))
        .max_by_key(|(c, _)| c.len)
        .map(|(_, t)| t)
}

/// The first `count` free addresses of `prefix`: inside its usable range,
/// outside every `taken` interval (inclusive bounds, any order).
pub fn next_free(prefix: &Cidr, taken: &[(Addr, Addr)], count: usize) -> Vec<Addr> {
    let (first, last) = prefix.usable();
    within(first, last, taken, count)
}

/// Like `next_free`, between two bounds.
pub fn within(first: Addr, last: Addr, taken: &[(Addr, Addr)], count: usize) -> Vec<Addr> {
    let mut blocks: Vec<(u128, u128)> = taken
        .iter()
        .filter(|(s, e)| s.v6 == first.v6 && e.v6 == first.v6 && s <= e)
        .map(|(s, e)| (s.value, e.value))
        .collect();
    blocks.sort_unstable();
    let mut out = Vec::new();
    let mut cur = first.value;
    let mut i = 0;
    while cur <= last.value && out.len() < count {
        // Skip blocks that end before `cur`.
        while i < blocks.len() && blocks[i].1 < cur {
            i += 1;
        }
        if i < blocks.len() && blocks[i].0 <= cur {
            match blocks[i].1.checked_add(1) {
                Some(next) => cur = next,
                None => break,
            }
            continue;
        }
        out.push(Addr {
            value: cur,
            v6: first.v6,
        });
        match cur.checked_add(1) {
            Some(next) => cur = next,
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn free_runs_around_taken_and_pools() {
        use super::free_runs;
        // .1-.254 usable; .1 gateway, .10-.16 taken, pool .100-.110 with .101 leased.
        let taken = [(1, 1), (10, 16), (101, 101)];
        let (runs, more) = free_runs(1, 254, &taken, &[(100, 110)], 100);
        assert!(!more);
        assert_eq!(
            runs,
            [
                (2, 9, false),
                (17, 99, false),
                (100, 100, true),
                (102, 110, true),
                (111, 254, false)
            ]
        );
        // Overlapping and out-of-range taken intervals; nothing free.
        let (runs, _) = free_runs(5, 9, &[(0, 6), (6, 20)], &[], 10);
        assert!(runs.is_empty());
        // Everything free, a pool at the very end; the cap.
        let (runs, _) = free_runs(1, 10, &[], &[(8, 20)], 10);
        assert_eq!(runs, [(1, 7, false), (8, 10, true)]);
        let (runs, more) = free_runs(1, 100, &[(5, 5), (10, 10), (20, 20)], &[], 2);
        assert_eq!((runs.len(), more), (2, true));
        // The top of the address space doesn't overflow.
        let (runs, _) = free_runs(
            u128::MAX - 3,
            u128::MAX,
            &[(u128::MAX - 1, u128::MAX)],
            &[],
            10,
        );
        assert_eq!(runs, [(u128::MAX - 3, u128::MAX - 2, false)]);
    }

    #[test]
    fn public_addresses() {
        use super::parse_addr;
        for a in [
            "108.204.170.224",
            "8.8.8.8",
            "1.1.1.1",
            "2606:4700::1111",
            "2001:4860::8888",
        ] {
            assert!(parse_addr(a).unwrap().is_public(), "{a}");
        }
        for a in [
            "10.1.1.1",
            "172.16.0.1",
            "172.31.255.1",
            "192.168.1.1",
            "100.64.0.1",
            "100.127.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "224.0.0.1",
            "255.255.255.255",
            "0.0.0.0",
            "192.0.2.1",
            "198.18.0.1",
            "240.0.0.1",
            "fd00::1",
            "fe80::1",
            "::1",
            "2001:db8::1",
            "ff02::1",
        ] {
            assert!(!parse_addr(a).unwrap().is_public(), "{a}");
        }
        // Just outside the private and shared ranges: public.
        for a in ["172.32.0.1", "100.128.0.1", "11.0.0.1"] {
            assert!(parse_addr(a).unwrap().is_public(), "{a}");
        }
    }

    use super::*;

    fn a(s: &str) -> Addr {
        parse_addr(s).unwrap()
    }
    fn c(s: &str) -> Cidr {
        parse_cidr(s).unwrap()
    }

    #[test]
    fn parses_and_prints_canonically() {
        assert_eq!(a(" 10.20.30.5 ").to_string(), "10.20.30.5");
        assert_eq!(a("2001:DB8:0:0::5").to_string(), "2001:db8::5");
        assert_eq!(a("::ffff:10.0.0.1"), a("10.0.0.1"), "mapped input is IPv4");
        assert!(parse_addr("10.0.0.256").is_err());
        assert!(parse_addr("fe80::1%eth0").is_err());
        assert!(parse_addr("10.0.0.1/24").is_err());
        assert_eq!(a("10.0.0.1").family(), Family::V4);
        assert_eq!(a("::1").family(), Family::V6);
    }

    #[test]
    fn binary_form_sorts_and_round_trips() {
        for s in [
            "0.0.0.0",
            "10.20.30.5",
            "255.255.255.255",
            "::",
            "2001:db8::5",
            "ffff::1",
        ] {
            let x = a(s);
            assert_eq!(Addr::from_bin(&x.bin()), Some(x), "{s}");
        }
        assert!(a("10.0.0.2").bin() > a("10.0.0.1").bin());
        assert!(a("10.0.1.0").bin() > a("10.0.0.255").bin());
        assert!(a("2001:db8::1").bin() > a("255.255.255.255").bin());
    }

    #[test]
    fn cidr_rules() {
        let p = c("10.20.30.0/24");
        assert_eq!(p.to_string(), "10.20.30.0/24");
        assert_eq!(p.end().to_string(), "10.20.30.255");
        assert_eq!(p.size(), 256);
        let e = parse_cidr("10.20.30.5/24").unwrap_err();
        assert!(e.contains("did you mean 10.20.30.0/24"), "{e}");
        assert!(parse_cidr("10.20.30.0").is_err());
        assert!(parse_cidr("10.20.30.0/33").is_err());
        assert_eq!(
            c("2001:db8::/48").end().to_string(),
            "2001:db8:0:ffff:ffff:ffff:ffff:ffff"
        );
        assert_eq!(c("0.0.0.0/0").size(), 1 << 32);
        assert_eq!(c("::/0").size(), u128::MAX);
        assert_eq!(c("10.0.0.1/32").size(), 1);
    }

    #[test]
    fn containment_respects_family() {
        let p = c("10.20.0.0/16");
        assert!(p.contains(a("10.20.30.5")));
        assert!(!p.contains(a("10.21.0.0")));
        assert!(p.contains_cidr(&c("10.20.30.0/24")));
        assert!(!c("10.20.30.0/24").contains_cidr(&p));
        // ::/0 numerically spans the mapped IPv4 block, but isn't its parent.
        assert!(!c("::/0").contains(a("10.0.0.1")));
        assert!(!c("0.0.0.0/0").contains(a("::1")));
        let all = [c("10.0.0.0/8"), c("10.20.0.0/16"), c("10.20.30.0/24")];
        let found = containing(a("10.20.30.7"), all.iter().map(|p| (p, p.len)));
        assert_eq!(found, Some(24));
        assert_eq!(
            containing(a("192.168.1.1"), all.iter().map(|p| (p, p.len))),
            None
        );
    }

    #[test]
    fn usable_ranges() {
        let (f, l) = c("10.0.0.0/24").usable();
        assert_eq!(
            (f.to_string(), l.to_string()),
            ("10.0.0.1".into(), "10.0.0.254".into())
        );
        let (f, l) = c("10.0.0.0/31").usable();
        assert_eq!(
            (f.to_string(), l.to_string()),
            ("10.0.0.0".into(), "10.0.0.1".into())
        );
        let (f, _) = c("2001:db8::/64").usable();
        assert_eq!(f.to_string(), "2001:db8::1");
        assert!(c("10.0.0.0/24").is_network_or_broadcast(a("10.0.0.255")));
        assert!(!c("10.0.0.0/31").is_network_or_broadcast(a("10.0.0.1")));
    }

    #[test]
    fn next_free_skips_taken() {
        let p = c("10.0.0.0/29"); // usable .1 - .6
        let taken = [
            (a("10.0.0.1"), a("10.0.0.1")),
            (a("10.0.0.3"), a("10.0.0.4")),
            (a("10.0.0.2"), a("10.0.0.2")),
        ];
        let free: Vec<String> = next_free(&p, &taken, 5)
            .iter()
            .map(|x| x.to_string())
            .collect();
        assert_eq!(free, ["10.0.0.5", "10.0.0.6"]);
        // Full
        let all = [(a("10.0.0.0"), a("10.0.0.7"))];
        assert!(next_free(&p, &all, 1).is_empty());
        // IPv6, large, and the very top of the address space
        let p6 = c("2001:db8::/64");
        assert_eq!(next_free(&p6, &[], 1)[0].to_string(), "2001:db8::1");
        let top = c("ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe/127");
        assert_eq!(next_free(&top, &[(top.start(), top.start())], 3).len(), 1);
        // Intervals of the other family are ignored.
        assert_eq!(
            next_free(&p, &[(a("::1"), a("::ffff"))], 1)[0].to_string(),
            "10.0.0.1"
        );
    }

    #[test]
    fn offsets_stay_in_family() {
        assert_eq!(a("10.0.0.1").offset(1).unwrap().to_string(), "10.0.0.2");
        assert!(a("255.255.255.255").offset(1).is_none());
        assert_eq!(a("::1").offset(1).unwrap().to_string(), "::2");
    }
}
