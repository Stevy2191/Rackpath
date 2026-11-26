//! Physical media (design section 6): what a port accepts, what a cable is,
//! and whether a cable fits the two port sides it joins.
//!
//! Three separate things, each recorded where it physically belongs:
//! - **Connector** (on the port): the jack or cage, e.g. RJ45, LC, SFP+.
//! - **Transceiver** (on a cage port): the module plugged into it, e.g.
//!   10GBASE-SR. It decides what the port really takes (LC multimode here).
//! - **Cable type** (on the connection): Cat6a, OS2, OM4, DAC SFP+ and so on.
//!
//! `check_cable` returns hard errors for things that can't physically be
//! plugged together (RJ45 to LC) and warnings for things that plug in but
//! probably won't work as intended (single-mode cable on a multimode
//! optic, Cat5e at 10G, a run longer than the optic reaches).

use std::fmt;

/// Coarse category of a port, stored for filtering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Medium {
    Copper,
    Fiber,
    Wireless,
    Power,
    Console,
    Coax,
    Other,
}

impl Medium {
    pub const ALL: [Medium; 7] = [
        Medium::Copper,
        Medium::Fiber,
        Medium::Wireless,
        Medium::Power,
        Medium::Console,
        Medium::Coax,
        Medium::Other,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Medium::Copper => "copper",
            Medium::Fiber => "fiber",
            Medium::Wireless => "wireless",
            Medium::Power => "power",
            Medium::Console => "console",
            Medium::Coax => "coax",
            Medium::Other => "other",
        }
    }
    pub fn parse(s: &str) -> Option<Medium> {
        Medium::ALL.into_iter().find(|m| m.as_str() == s)
    }
}

/// Pluggable-module cage families, from smallest to largest within a
/// size class (SFP-sized and QSFP-sized).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Cage {
    Sfp,
    SfpPlus,
    Sfp28,
    QsfpPlus,
    Qsfp28,
}

impl Cage {
    pub fn is_quad(self) -> bool {
        matches!(self, Cage::QsfpPlus | Cage::Qsfp28)
    }
    /// Top speed in Mb/s.
    pub fn speed(self) -> u32 {
        match self {
            Cage::Sfp => 1_000,
            Cage::SfpPlus => 10_000,
            Cage::Sfp28 => 25_000,
            Cage::QsfpPlus => 40_000,
            Cage::Qsfp28 => 100_000,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Cage::Sfp => "SFP",
            Cage::SfpPlus => "SFP+",
            Cage::Sfp28 => "SFP28",
            Cage::QsfpPlus => "QSFP+",
            Cage::Qsfp28 => "QSFP28",
        }
    }
    /// Whether a module or direct-attach cable made for `module` fits this
    /// cage physically (same size class; electrical speed is a separate check).
    fn same_size(self, module: Cage) -> bool {
        self.is_quad() == module.is_quad()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FiberConn {
    Lc,
    Sc,
    St,
    E2000,
    Mpo,
}

/// What a port physically has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Connector {
    Rj45,
    Rj11,
    Cage(Cage),
    Fiber(FiberConn),
    Db9,
    Usb,
    F,
    Bnc,
    Other,
}

pub const CONNECTORS: &[(&str, Connector)] = &[
    ("RJ45", Connector::Rj45),
    ("RJ11", Connector::Rj11),
    ("SFP", Connector::Cage(Cage::Sfp)),
    ("SFP+", Connector::Cage(Cage::SfpPlus)),
    ("SFP28", Connector::Cage(Cage::Sfp28)),
    ("QSFP+", Connector::Cage(Cage::QsfpPlus)),
    ("QSFP28", Connector::Cage(Cage::Qsfp28)),
    ("LC", Connector::Fiber(FiberConn::Lc)),
    ("SC", Connector::Fiber(FiberConn::Sc)),
    ("ST", Connector::Fiber(FiberConn::St)),
    ("E2000", Connector::Fiber(FiberConn::E2000)),
    ("MPO", Connector::Fiber(FiberConn::Mpo)),
    ("DB9", Connector::Db9),
    ("USB", Connector::Usb),
    ("F", Connector::F),
    ("BNC", Connector::Bnc),
    ("Other", Connector::Other),
];

impl Connector {
    pub fn parse(s: &str) -> Option<Connector> {
        CONNECTORS
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(s.trim()))
            .map(|(_, c)| *c)
    }
    pub fn name(self) -> &'static str {
        CONNECTORS
            .iter()
            .find(|(_, c)| *c == self)
            .map(|(n, _)| *n)
            .unwrap_or("Other")
    }
    /// Media a port with this connector may be recorded as; the first is
    /// the default.
    pub fn media(self) -> &'static [Medium] {
        match self {
            Connector::Rj45 => &[Medium::Copper, Medium::Console],
            Connector::Rj11 => &[Medium::Copper],
            // A cage's medium follows its transceiver; empty, it's "other".
            Connector::Cage(_) => &[Medium::Other, Medium::Copper, Medium::Fiber],
            Connector::Fiber(_) => &[Medium::Fiber],
            Connector::Db9 | Connector::Usb => &[Medium::Console, Medium::Other],
            Connector::F | Connector::Bnc => &[Medium::Coax],
            Connector::Other => &[
                Medium::Other,
                Medium::Copper,
                Medium::Fiber,
                Medium::Console,
                Medium::Coax,
            ],
        }
    }
}

/// Single-mode or multimode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FiberClass {
    SingleMode,
    MultiMode,
}

impl FiberClass {
    fn name(self) -> &'static str {
        match self {
            FiberClass::SingleMode => "single-mode",
            FiberClass::MultiMode => "multimode",
        }
    }
}

/// What a transceiver presents on its outside.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Optic {
    /// Copper module with an RJ45 jack (1000BASE-T, 10GBASE-T).
    CopperRj45,
    Fiber(FiberClass, FiberConn),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transceiver {
    pub name: &'static str,
    pub cage: Cage,
    pub speed: u32,
    pub optic: Optic,
}

const fn t(name: &'static str, cage: Cage, speed: u32, optic: Optic) -> Transceiver {
    Transceiver {
        name,
        cage,
        speed,
        optic,
    }
}

const SMF_LC: Optic = Optic::Fiber(FiberClass::SingleMode, FiberConn::Lc);
const MMF_LC: Optic = Optic::Fiber(FiberClass::MultiMode, FiberConn::Lc);
const MMF_MPO: Optic = Optic::Fiber(FiberClass::MultiMode, FiberConn::Mpo);

pub const TRANSCEIVERS: &[Transceiver] = &[
    t("1000BASE-T", Cage::Sfp, 1_000, Optic::CopperRj45),
    t("1000BASE-SX", Cage::Sfp, 1_000, MMF_LC),
    t("1000BASE-LX", Cage::Sfp, 1_000, SMF_LC),
    t("1000BASE-ZX", Cage::Sfp, 1_000, SMF_LC),
    t("1000BASE-BX", Cage::Sfp, 1_000, SMF_LC),
    t("10GBASE-T", Cage::SfpPlus, 10_000, Optic::CopperRj45),
    t("10GBASE-SR", Cage::SfpPlus, 10_000, MMF_LC),
    t("10GBASE-LR", Cage::SfpPlus, 10_000, SMF_LC),
    t("10GBASE-ER", Cage::SfpPlus, 10_000, SMF_LC),
    t("10GBASE-BX", Cage::SfpPlus, 10_000, SMF_LC),
    t("25GBASE-SR", Cage::Sfp28, 25_000, MMF_LC),
    t("25GBASE-LR", Cage::Sfp28, 25_000, SMF_LC),
    t("40GBASE-SR4", Cage::QsfpPlus, 40_000, MMF_MPO),
    t("40GBASE-LR4", Cage::QsfpPlus, 40_000, SMF_LC),
    t("100GBASE-SR4", Cage::Qsfp28, 100_000, MMF_MPO),
    t("100GBASE-LR4", Cage::Qsfp28, 100_000, SMF_LC),
];

impl Transceiver {
    pub fn parse(s: &str) -> Option<Transceiver> {
        TRANSCEIVERS
            .iter()
            .find(|t| t.name.eq_ignore_ascii_case(s.trim()))
            .copied()
    }
    pub fn medium(self) -> Medium {
        match self.optic {
            Optic::CopperRj45 => Medium::Copper,
            Optic::Fiber(..) => Medium::Fiber,
        }
    }
}

/// Whether `module` can go in `cage`. A module fits a cage of its size
/// class whose speed is at least the module's (an SFP in an SFP+ port is
/// normal; a 10G SFP+ module in a 1G SFP port is not).
pub fn transceiver_fits(cage: Cage, module: &Transceiver) -> Result<(), String> {
    if !cage.same_size(module.cage) {
        return Err(format!(
            "A {} module doesn't fit an {} port",
            module.name,
            cage.name()
        ));
    }
    if module.speed > cage.speed() {
        return Err(format!(
            "A {} module needs at least an {} port; this is an {} port",
            module.name,
            module.cage.name(),
            cage.name()
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------- cables

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Category {
    Cat3,
    Cat5,
    Cat5e,
    Cat6,
    Cat6a,
    Cat7,
    Cat8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FiberGrade {
    Om1,
    Om2,
    Om3,
    Om4,
    Om5,
    Os1,
    Os2,
}

impl FiberGrade {
    pub fn class(self) -> FiberClass {
        match self {
            FiberGrade::Os1 | FiberGrade::Os2 => FiberClass::SingleMode,
            _ => FiberClass::MultiMode,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectAttach {
    Dac,
    Aoc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CableType {
    TwistedPair(Category),
    Fiber(FiberGrade),
    Direct(DirectAttach, Cage),
    Console,
    Usb,
    Coax,
    Other,
}

pub const CABLE_TYPES: &[(&str, CableType)] = &[
    ("Cat3", CableType::TwistedPair(Category::Cat3)),
    ("Cat5", CableType::TwistedPair(Category::Cat5)),
    ("Cat5e", CableType::TwistedPair(Category::Cat5e)),
    ("Cat6", CableType::TwistedPair(Category::Cat6)),
    ("Cat6a", CableType::TwistedPair(Category::Cat6a)),
    ("Cat7", CableType::TwistedPair(Category::Cat7)),
    ("Cat8", CableType::TwistedPair(Category::Cat8)),
    ("OM1", CableType::Fiber(FiberGrade::Om1)),
    ("OM2", CableType::Fiber(FiberGrade::Om2)),
    ("OM3", CableType::Fiber(FiberGrade::Om3)),
    ("OM4", CableType::Fiber(FiberGrade::Om4)),
    ("OM5", CableType::Fiber(FiberGrade::Om5)),
    ("OS1", CableType::Fiber(FiberGrade::Os1)),
    ("OS2", CableType::Fiber(FiberGrade::Os2)),
    (
        "DAC SFP+",
        CableType::Direct(DirectAttach::Dac, Cage::SfpPlus),
    ),
    (
        "DAC SFP28",
        CableType::Direct(DirectAttach::Dac, Cage::Sfp28),
    ),
    (
        "DAC QSFP+",
        CableType::Direct(DirectAttach::Dac, Cage::QsfpPlus),
    ),
    (
        "DAC QSFP28",
        CableType::Direct(DirectAttach::Dac, Cage::Qsfp28),
    ),
    (
        "AOC SFP+",
        CableType::Direct(DirectAttach::Aoc, Cage::SfpPlus),
    ),
    (
        "AOC SFP28",
        CableType::Direct(DirectAttach::Aoc, Cage::Sfp28),
    ),
    (
        "AOC QSFP+",
        CableType::Direct(DirectAttach::Aoc, Cage::QsfpPlus),
    ),
    (
        "AOC QSFP28",
        CableType::Direct(DirectAttach::Aoc, Cage::Qsfp28),
    ),
    ("Console", CableType::Console),
    ("USB", CableType::Usb),
    ("Coax", CableType::Coax),
    ("Other", CableType::Other),
];

impl CableType {
    pub fn parse(s: &str) -> Option<CableType> {
        let wanted: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
        CABLE_TYPES
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(&wanted))
            .map(|(_, c)| *c)
    }
    pub fn name(self) -> &'static str {
        CABLE_TYPES
            .iter()
            .find(|(_, c)| *c == self)
            .map(|(n, _)| *n)
            .unwrap_or("Other")
    }
    /// The medium a passive port's permanent side must have for this cable.
    fn medium(self) -> Option<Medium> {
        match self {
            CableType::TwistedPair(_) => Some(Medium::Copper),
            CableType::Fiber(_) => Some(Medium::Fiber),
            CableType::Coax => Some(Medium::Coax),
            CableType::Console | CableType::Usb => Some(Medium::Console),
            CableType::Direct(..) | CableType::Other => None,
        }
    }
}

// ---------------------------------------------------------------- checks

/// One side of a port as far as a cable is concerned.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PortMedia {
    pub medium: Medium,
    pub connector: Option<Connector>,
    pub transceiver: Option<Transceiver>,
    /// Recorded speed in Mb/s (copper ports); a transceiver's speed wins.
    pub speed: Option<u32>,
    /// The rear (permanent) side of a passive port: only the medium matters
    /// there, since the cable is punched down or spliced.
    pub rear: bool,
}

impl PortMedia {
    pub fn speed(&self) -> Option<u32> {
        self.transceiver.map(|t| t.speed).or(self.speed)
    }
}

/// What the cable end physically meets at a port side.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Socket {
    Rj45,
    Rj11,
    Fiber(FiberConn, Option<FiberClass>),
    EmptyCage(Cage),
    Console,
    Coax,
    /// Rear side of a passive port: medium only.
    Termination(Medium),
    Wireless,
    Unknown,
}

fn socket(p: &PortMedia) -> Socket {
    if p.medium == Medium::Wireless {
        return Socket::Wireless;
    }
    if p.rear {
        return Socket::Termination(p.medium);
    }
    match p.connector {
        None | Some(Connector::Other) => Socket::Unknown,
        Some(Connector::Rj45) if p.medium == Medium::Console => Socket::Console,
        Some(Connector::Rj45) => Socket::Rj45,
        Some(Connector::Rj11) => Socket::Rj11,
        Some(Connector::Fiber(c)) => Socket::Fiber(c, None),
        Some(Connector::Db9 | Connector::Usb) => Socket::Console,
        Some(Connector::F | Connector::Bnc) => Socket::Coax,
        Some(Connector::Cage(cage)) => match p.transceiver {
            None => Socket::EmptyCage(cage),
            Some(t) => match t.optic {
                Optic::CopperRj45 => Socket::Rj45,
                Optic::Fiber(class, conn) => Socket::Fiber(conn, Some(class)),
            },
        },
    }
}

fn describe(s: Socket) -> String {
    match s {
        Socket::Rj45 => "an RJ45 port".into(),
        Socket::Rj11 => "an RJ11 port".into(),
        Socket::Fiber(c, _) => format!("a {} fibre port", Connector::Fiber(c).name()),
        Socket::EmptyCage(c) => format!("an empty {} port", c.name()),
        Socket::Console => "a console port".into(),
        Socket::Coax => "a coax port".into(),
        Socket::Termination(m) => format!("a {} termination", m.as_str()),
        Socket::Wireless => "a wireless port".into(),
        Socket::Unknown => "a port".into(),
    }
}

/// Broad family a socket belongs to, for "can these two ever be joined by
/// one cable" checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    TwistedPair,
    Fiber,
    Direct,
    Console,
    Coax,
    Any,
}

fn family(s: Socket) -> Option<Family> {
    Some(match s {
        Socket::Rj45 | Socket::Rj11 => Family::TwistedPair,
        Socket::Fiber(..) => Family::Fiber,
        Socket::EmptyCage(_) => Family::Direct,
        Socket::Console => Family::Console,
        Socket::Coax => Family::Coax,
        Socket::Termination(m) => match m {
            Medium::Copper => Family::TwistedPair,
            Medium::Fiber => Family::Fiber,
            Medium::Coax => Family::Coax,
            Medium::Console => Family::Console,
            _ => Family::Any,
        },
        Socket::Unknown => Family::Any,
        Socket::Wireless => return None,
    })
}

#[derive(Debug, Default, PartialEq)]
pub struct Verdict {
    pub warnings: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Incompatible(pub String);

impl fmt::Display for Incompatible {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Checks a cable between two port sides. `link_speed` is the speed the
/// link is expected to run at (the slower of the two ends of the whole
/// chain when known); used for category and reach warnings.
pub fn check_cable(
    a: &PortMedia,
    b: &PortMedia,
    cable: Option<CableType>,
    length_m: Option<f64>,
    link_speed: Option<u32>,
) -> Result<Verdict, Incompatible> {
    let (sa, sb) = (socket(a), socket(b));
    let mut v = Verdict::default();
    let (Some(fa), Some(fb)) = (family(sa), family(sb)) else {
        return Err(Incompatible(
            "Wireless ports don't take cables; link them through their WLAN instead".into(),
        ));
    };
    // One cable, two ends: without a cable type, the ends must at least be
    // of the same family. With one, each end is checked against the cable.
    let typed = cable.is_some_and(|c| c != CableType::Other);
    if !typed && fa != Family::Any && fb != Family::Any && fa != fb {
        return Err(Incompatible(format!(
            "One cable can't join {} to {}{}",
            describe(sa),
            describe(sb),
            if (fa == Family::Fiber) != (fb == Family::Fiber)
                && matches!(fa, Family::TwistedPair | Family::Fiber)
                && matches!(fb, Family::TwistedPair | Family::Fiber)
            {
                " (use a media converter, or a copper transceiver in the fibre port)"
            } else {
                ""
            }
        )));
    }
    if let Some(cable) = cable {
        for s in [sa, sb] {
            cable_fits(cable, s, &mut v)?;
        }
        if let Some(speed) = link_speed {
            speed_warnings(cable, speed, length_m, &mut v);
        }
    }
    // Two optics facing each other directly.
    if let (Socket::Fiber(_, Some(ca)), Socket::Fiber(_, Some(cb))) = (sa, sb) {
        if ca != cb {
            v.warnings.push(format!(
                "A {} optic won't link with a {} optic",
                ca.name(),
                cb.name()
            ));
        }
    }
    if let (Some(x), Some(y)) = (a.transceiver, b.transceiver) {
        if x.speed != y.speed {
            v.warnings.push(format!(
                "{} and {} run at different speeds and won't link",
                x.name, y.name
            ));
        }
    }
    Ok(v)
}

fn cable_fits(cable: CableType, s: Socket, v: &mut Verdict) -> Result<(), Incompatible> {
    let wrong = || {
        Err(Incompatible(format!(
            "A {} cable doesn't fit {}",
            cable.name(),
            describe(s)
        )))
    };
    match (cable, s) {
        (CableType::Other, _) | (_, Socket::Unknown) => Ok(()),
        (_, Socket::Wireless) => wrong(),
        (_, Socket::Termination(m)) => match cable.medium() {
            Some(cm) if cm == m || m == Medium::Other => Ok(()),
            _ => wrong(),
        },
        (CableType::TwistedPair(_), Socket::Rj45 | Socket::Rj11) => Ok(()),
        (CableType::Fiber(grade), Socket::Fiber(_, class)) => {
            if let Some(class) = class {
                if grade.class() != class {
                    v.warnings.push(format!(
                        "{} is {} fibre but the optic is {}",
                        cable.name(),
                        grade.class().name(),
                        class.name()
                    ));
                }
            }
            Ok(())
        }
        (CableType::Direct(_, made_for), Socket::EmptyCage(cage)) => {
            if !cage.same_size(made_for) {
                return wrong();
            }
            if made_for.speed() > cage.speed() {
                v.warnings.push(format!(
                    "A {} cable in an {} port runs at {} at most, if it links at all",
                    cable.name(),
                    cage.name(),
                    speed_name(cage.speed())
                ));
            }
            Ok(())
        }
        (CableType::Direct(..), Socket::Fiber(_, Some(_))) => Err(Incompatible(format!(
            "A {} cable has its own modules: take the transceiver out of the port first",
            cable.name()
        ))),
        (CableType::Console | CableType::Usb, Socket::Console) => Ok(()),
        (CableType::Console, Socket::Rj45) => {
            v.warnings.push(
                "A console cable on a network port: is this port really a console port?".into(),
            );
            Ok(())
        }
        (CableType::Coax, Socket::Coax) => Ok(()),
        _ => wrong(),
    }
}

fn speed_name(mbps: u32) -> String {
    if mbps >= 1000 {
        format!("{}G", mbps / 1000)
    } else {
        format!("{mbps}M")
    }
}

/// Maximum multimode reach in metres for short-reach optics, by speed.
fn mmf_reach(grade: FiberGrade, speed: u32) -> Option<u32> {
    use FiberGrade::*;
    let table: &[(FiberGrade, u32)] = match speed {
        0..=1_000 => &[
            (Om1, 275),
            (Om2, 550),
            (Om3, 1000),
            (Om4, 1000),
            (Om5, 1000),
        ],
        1_001..=10_000 => &[(Om1, 33), (Om2, 82), (Om3, 300), (Om4, 400), (Om5, 400)],
        10_001..=25_000 => &[(Om3, 70), (Om4, 100), (Om5, 100)],
        25_001..=40_000 => &[(Om3, 100), (Om4, 150), (Om5, 150)],
        _ => &[(Om3, 70), (Om4, 100), (Om5, 100)],
    };
    table.iter().find(|(g, _)| *g == grade).map(|(_, m)| *m)
}

fn speed_warnings(cable: CableType, speed: u32, length_m: Option<f64>, v: &mut Verdict) {
    match cable {
        CableType::TwistedPair(cat) => {
            // Rated speeds per category (100 m channel).
            let rated = match cat {
                Category::Cat3 => 10,
                Category::Cat5 => 100,
                Category::Cat5e => 5_000,
                Category::Cat6 => 5_000,
                Category::Cat6a | Category::Cat7 => 10_000,
                Category::Cat8 => 40_000,
            };
            if speed > rated {
                if cat == Category::Cat6 && speed <= 10_000 {
                    if length_m.is_none_or(|l| l > 55.0) {
                        v.warnings.push(
                            "Cat6 carries 10G only up to about 55 m; use Cat6a for longer runs"
                                .into(),
                        );
                    }
                } else {
                    v.warnings.push(format!(
                        "{} isn't rated for {}",
                        cable.name(),
                        speed_name(speed)
                    ));
                }
            }
            if length_m.is_some_and(|l| l > 100.0) {
                v.warnings
                    .push("Twisted-pair Ethernet runs are limited to 100 m".into());
            }
        }
        CableType::Fiber(grade) if grade.class() == FiberClass::MultiMode => {
            match mmf_reach(grade, speed) {
                None => v.warnings.push(format!(
                    "{} isn't suitable for {}",
                    cable.name(),
                    speed_name(speed)
                )),
                Some(max) => {
                    if length_m.is_some_and(|l| l > f64::from(max)) {
                        v.warnings.push(format!(
                            "{} reaches about {max} m at {}",
                            cable.name(),
                            speed_name(speed)
                        ));
                    }
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port(connector: &str) -> PortMedia {
        let c = Connector::parse(connector).unwrap();
        PortMedia {
            medium: c.media()[0],
            connector: Some(c),
            transceiver: None,
            speed: None,
            rear: false,
        }
    }

    fn optic(cage: &str, module: &str) -> PortMedia {
        let t = Transceiver::parse(module).unwrap();
        PortMedia {
            medium: t.medium(),
            transceiver: Some(t),
            ..port(cage)
        }
    }

    fn rear(medium: Medium) -> PortMedia {
        PortMedia {
            medium,
            connector: None,
            transceiver: None,
            speed: None,
            rear: true,
        }
    }

    fn cable(s: &str) -> Option<CableType> {
        Some(CableType::parse(s).unwrap())
    }

    #[test]
    fn catalogs_parse_and_round_trip() {
        for (name, c) in CONNECTORS {
            assert_eq!(Connector::parse(name), Some(*c));
            assert_eq!(c.name(), *name);
        }
        for (name, c) in CABLE_TYPES {
            assert_eq!(CableType::parse(name), Some(*c));
            assert_eq!(c.name(), *name);
        }
        assert_eq!(CableType::parse("dac  sfp+"), cable("DAC SFP+"));
        assert_eq!(
            Connector::parse("sfp28"),
            Some(Connector::Cage(Cage::Sfp28))
        );
        assert!(Transceiver::parse("10gbase-sr").is_some());
        assert!(CableType::parse("Cat9").is_none());
        for m in Medium::ALL {
            assert_eq!(Medium::parse(m.as_str()), Some(m));
        }
    }

    #[test]
    fn modules_fit_cages_of_their_size_and_speed() {
        let sr = Transceiver::parse("10GBASE-SR").unwrap();
        let sx = Transceiver::parse("1000BASE-SX").unwrap();
        let sr4 = Transceiver::parse("40GBASE-SR4").unwrap();
        assert!(transceiver_fits(Cage::SfpPlus, &sr).is_ok());
        assert!(transceiver_fits(Cage::Sfp28, &sr).is_ok());
        assert!(transceiver_fits(Cage::SfpPlus, &sx).is_ok());
        assert!(transceiver_fits(Cage::Sfp, &sr).is_err());
        assert!(transceiver_fits(Cage::SfpPlus, &sr4).is_err());
        assert!(transceiver_fits(Cage::Qsfp28, &sr4).is_ok());
    }

    #[test]
    fn impossible_combinations_are_refused() {
        // RJ45 to LC
        let e = check_cable(&port("RJ45"), &port("LC"), None, None, None).unwrap_err();
        assert!(e.0.contains("media converter"), "{e}");
        // Copper cable into a fibre optic
        assert!(check_cable(
            &port("RJ45"),
            &optic("SFP+", "10GBASE-T"),
            cable("OM4"),
            None,
            None
        )
        .is_err());
        // Wireless
        let mut w = port("Other");
        w.medium = Medium::Wireless;
        assert!(check_cable(&w, &port("RJ45"), None, None, None).is_err());
        // QSFP DAC in an SFP+ cage
        assert!(check_cable(&port("SFP+"), &port("SFP+"), cable("DAC QSFP+"), None, None).is_err());
        // DAC into a port that already holds an optic
        let e = check_cable(
            &optic("SFP+", "10GBASE-SR"),
            &port("SFP+"),
            cable("DAC SFP+"),
            None,
            None,
        )
        .unwrap_err();
        assert!(e.0.contains("transceiver"), "{e}");
        // Empty cage to RJ45: needs a module first
        assert!(check_cable(&port("SFP+"), &port("RJ45"), None, None, None).is_err());
        // Fibre cable on a copper rear termination
        assert!(check_cable(
            &rear(Medium::Copper),
            &rear(Medium::Copper),
            cable("OS2"),
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn plausible_combinations_pass() {
        let ok = |a: &PortMedia, b: &PortMedia, c: Option<CableType>| {
            let v = check_cable(a, b, c, None, None).unwrap();
            assert!(v.warnings.is_empty(), "{:?}", v.warnings);
        };
        ok(&port("RJ45"), &port("RJ45"), cable("Cat6a"));
        ok(&port("RJ45"), &optic("SFP+", "10GBASE-T"), cable("Cat6a"));
        ok(&optic("SFP+", "10GBASE-SR"), &port("LC"), cable("OM4"));
        ok(&port("LC"), &port("SC"), cable("OS2"));
        ok(&port("SFP28"), &port("SFP28"), cable("DAC SFP28"));
        ok(&port("SFP28"), &port("SFP28"), cable("DAC SFP+"));
        ok(&port("SFP+"), &port("SFP+"), None);
        ok(&rear(Medium::Copper), &rear(Medium::Copper), cable("Cat6"));
        ok(&rear(Medium::Fiber), &rear(Medium::Fiber), cable("OS2"));
        ok(&port("DB9"), &port("USB"), cable("Console"));
        ok(&port("Other"), &port("LC"), None);
        ok(&port("RJ45"), &port("RJ45"), cable("Other"));
    }

    #[test]
    fn likely_mistakes_warn() {
        let warns = |a: &PortMedia, b: &PortMedia, c: Option<CableType>, len, speed| {
            check_cable(a, b, c, len, speed).unwrap().warnings
        };
        // Single-mode cable on a multimode optic
        let w = warns(
            &optic("SFP+", "10GBASE-SR"),
            &port("LC"),
            cable("OS2"),
            None,
            None,
        );
        assert!(w[0].contains("single-mode"), "{w:?}");
        // SR facing LR
        let w = warns(
            &optic("SFP+", "10GBASE-SR"),
            &optic("SFP+", "10GBASE-LR"),
            cable("OM4"),
            None,
            None,
        );
        assert!(w.iter().any(|x| x.contains("won't link")), "{w:?}");
        // Speed mismatch between optics
        let w = warns(
            &optic("SFP+", "10GBASE-SR"),
            &optic("SFP", "1000BASE-SX"),
            cable("OM3"),
            None,
            None,
        );
        assert!(w.iter().any(|x| x.contains("different speeds")), "{w:?}");
        // Cat5e at 10G
        let w = warns(
            &port("RJ45"),
            &port("RJ45"),
            cable("Cat5e"),
            None,
            Some(10_000),
        );
        assert!(w[0].contains("isn't rated for 10G"), "{w:?}");
        // Cat5e at 2.5G is fine
        assert!(warns(
            &port("RJ45"),
            &port("RJ45"),
            cable("Cat5e"),
            None,
            Some(2_500)
        )
        .is_empty());
        // Cat6 at 10G: fine when short, warned when long or unknown
        assert!(warns(
            &port("RJ45"),
            &port("RJ45"),
            cable("Cat6"),
            Some(30.0),
            Some(10_000)
        )
        .is_empty());
        assert_eq!(
            warns(
                &port("RJ45"),
                &port("RJ45"),
                cable("Cat6"),
                Some(80.0),
                Some(10_000)
            )
            .len(),
            1
        );
        // Over 100 m of copper
        let w = warns(
            &port("RJ45"),
            &port("RJ45"),
            cable("Cat6a"),
            Some(120.0),
            Some(1_000),
        );
        assert!(w[0].contains("100 m"), "{w:?}");
        // OM3 too long at 10G, OM1 unsuitable at 25G
        let w = warns(
            &port("LC"),
            &port("LC"),
            cable("OM3"),
            Some(350.0),
            Some(10_000),
        );
        assert!(w[0].contains("300 m"), "{w:?}");
        let w = warns(&port("LC"), &port("LC"), cable("OM1"), None, Some(25_000));
        assert!(w[0].contains("isn't suitable"), "{w:?}");
        // A faster DAC in a slower cage
        let w = warns(&port("SFP+"), &port("SFP+"), cable("DAC SFP28"), None, None);
        assert!(w[0].contains("10G at most"), "{w:?}");
        // Console cable on a network RJ45
        assert_eq!(
            warns(&port("RJ45"), &port("DB9"), cable("Console"), None, None).len(),
            1
        );
    }

    #[test]
    fn speed_comes_from_the_transceiver() {
        let p = optic("SFP28", "25GBASE-SR");
        assert_eq!(p.speed(), Some(25_000));
        let mut q = port("RJ45");
        q.speed = Some(1_000);
        assert_eq!(q.speed(), Some(1_000));
    }
}
