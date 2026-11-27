//! Cabling rules and chain tracing (design section 6). Pure: the caller
//! loads the relevant ports and cables into a `Graph`.
//!
//! An **active** port (switch port, NIC) has one side, `front`. A
//! **passive** port (patch-panel port, wall outlet) joins two cables: the
//! patch cord on its `front` and the permanent cable on its `rear`. A
//! chain is what you reach by following cables through passive ports.

use std::collections::{HashMap, HashSet};

/// Longest chain walked in one direction, so bad data can't loop forever.
pub const MAX_HOPS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Front,
    Rear,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Front => "front",
            Side::Rear => "rear",
        }
    }
    pub fn parse(s: &str) -> Option<Side> {
        match s {
            "front" => Some(Side::Front),
            "rear" => Some(Side::Rear),
            _ => None,
        }
    }
    pub fn other(self) -> Side {
        match self {
            Side::Front => Side::Rear,
            Side::Rear => Side::Front,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Active,
    Passive,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Active => "active",
            Role::Passive => "passive",
        }
    }
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "active" => Some(Role::Active),
            "passive" => Some(Role::Passive),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// In-wall or backbone cable between the rear sides of passive ports.
    Permanent,
    /// Patch cord between front sides.
    Patch,
    /// Power cord (phase 5).
    Power,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Permanent => "permanent",
            Kind::Patch => "patch",
            Kind::Power => "power",
        }
    }
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "permanent" => Some(Kind::Permanent),
            "patch" => Some(Kind::Patch),
            "power" => Some(Kind::Power),
            _ => None,
        }
    }
    /// The side a cable of this kind plugs into.
    pub fn side(self) -> Side {
        match self {
            Kind::Permanent => Side::Rear,
            Kind::Patch | Kind::Power => Side::Front,
        }
    }
}

/// What the side rules need to know about one end.
#[derive(Clone, Copy, Debug)]
pub struct EndInfo {
    pub port_id: i64,
    pub role: Role,
    pub side: Side,
    /// Passive ports only: whether the front can only be patched once the
    /// rear is cabled (false for couplers and pass-through panels).
    pub requires_permanent: bool,
    /// Whether the rear side already has a permanent cable.
    pub rear_cabled: bool,
    /// Whether the chosen side already has a cable.
    pub side_taken: bool,
}

/// Side rules for a new cable. Returns a message for the user on failure.
pub fn check_sides(kind: Kind, a: &EndInfo, b: &EndInfo) -> Result<(), String> {
    if a.port_id == b.port_id {
        return Err("A cable can't connect a port to itself".into());
    }
    if kind == Kind::Power && (a.role != Role::Active || b.role != Role::Active) {
        return Err("Power cords join outlets and inlets, which are active ports".into());
    }
    for e in [a, b] {
        if e.side != kind.side() {
            return Err(match kind {
                Kind::Permanent => {
                    "Permanent cables connect the rear sides of patch-panel ports and outlets"
                        .into()
                }
                _ => "Patch cables plug into the front side of a port".into(),
            });
        }
        if e.role == Role::Active && e.side != Side::Front {
            return Err(
                "An active port has only a front side: permanent cabling ends at passive ports"
                    .into(),
            );
        }
        if e.side_taken {
            return Err(format!(
                "That port's {} side already has a cable",
                e.side.as_str()
            ));
        }
        if e.role == Role::Passive
            && e.side == Side::Front
            && e.requires_permanent
            && !e.rear_cabled
        {
            return Err(
                "That patch-panel port or outlet has no permanent cable behind it yet; add the permanent cable first"
                    .into(),
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- tracing

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cable {
    pub connection_id: i64,
    pub kind: Kind,
    pub far_port: i64,
    pub far_side: Side,
}

/// The ports and cables of (at least) one chain.
#[derive(Default, Debug)]
pub struct Graph {
    roles: HashMap<i64, Role>,
    cables: HashMap<(i64, Side), Cable>,
}

impl Graph {
    pub fn add_port(&mut self, port_id: i64, role: Role) {
        self.roles.insert(port_id, role);
    }

    /// Adds both ends of a cable.
    pub fn add_cable(&mut self, connection_id: i64, kind: Kind, a: (i64, Side), b: (i64, Side)) {
        self.cables.insert(
            a,
            Cable {
                connection_id,
                kind,
                far_port: b.0,
                far_side: b.1,
            },
        );
        self.cables.insert(
            b,
            Cable {
                connection_id,
                kind,
                far_port: a.0,
                far_side: a.1,
            },
        );
    }

    pub fn role(&self, port_id: i64) -> Option<Role> {
        self.roles.get(&port_id).copied()
    }

    pub fn cable(&self, port_id: i64, side: Side) -> Option<&Cable> {
        self.cables.get(&(port_id, side))
    }

    /// The sides of a port a chain passes through.
    fn sides(&self, port_id: i64) -> &'static [Side] {
        match self.role(port_id) {
            Some(Role::Passive) => &[Side::Front, Side::Rear],
            _ => &[Side::Front],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChainState {
    /// Both ends reach active ports.
    Complete,
    /// At least one end stops at a passive port (or the walk gave up).
    Incomplete,
    /// No cables at all.
    Unconnected,
}

impl ChainState {
    pub fn as_str(self) -> &'static str {
        match self {
            ChainState::Complete => "complete",
            ChainState::Incomplete => "incomplete",
            ChainState::Unconnected => "unconnected",
        }
    }
}

/// One element of a traced chain, in order from one end to the other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// A port; `enter`/`exit` are the sides the chain uses (None at an end).
    Port {
        port_id: i64,
        enter: Option<Side>,
        exit: Option<Side>,
    },
    Cable {
        connection_id: i64,
        kind: Kind,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct Trace {
    pub steps: Vec<Step>,
    pub state: ChainState,
    /// The port at each end of the chain.
    pub ends: (i64, i64),
    /// The walk stopped at a loop or the hop limit.
    pub truncated: bool,
}

impl Trace {
    pub fn ports(&self) -> impl Iterator<Item = i64> + '_ {
        self.steps.iter().filter_map(|s| match s {
            Step::Port { port_id, .. } => Some(*port_id),
            Step::Cable { .. } => None,
        })
    }
    pub fn connections(&self) -> impl Iterator<Item = (i64, Kind)> + '_ {
        self.steps.iter().filter_map(|s| match s {
            Step::Cable {
                connection_id,
                kind,
            } => Some((*connection_id, *kind)),
            Step::Port { .. } => None,
        })
    }
}

/// Walks out of `start` through `side`. Returns the steps after the start
/// port, whether the far end is an active port, and whether it gave up.
fn walk(g: &Graph, start: i64, side: Side) -> (Vec<Step>, bool, bool) {
    let mut steps = Vec::new();
    let mut visited: HashSet<(i64, Side)> = HashSet::new();
    visited.insert((start, side));
    let (mut port, mut out) = (start, side);
    for _ in 0..MAX_HOPS {
        let Some(cable) = g.cable(port, out) else {
            // Dead end: a passive port with nothing on its far side (or
            // the start itself, with no cable on this side).
            return (steps, false, false);
        };
        steps.push(Step::Cable {
            connection_id: cable.connection_id,
            kind: cable.kind,
        });
        let (far, enter) = (cable.far_port, cable.far_side);
        if g.role(far) != Some(Role::Passive) {
            steps.push(Step::Port {
                port_id: far,
                enter: Some(enter),
                exit: None,
            });
            return (steps, true, false);
        }
        let exit = enter.other();
        if !visited.insert((far, enter)) || !visited.insert((far, exit)) {
            steps.push(Step::Port {
                port_id: far,
                enter: Some(enter),
                exit: None,
            });
            return (steps, false, true);
        }
        steps.push(Step::Port {
            port_id: far,
            enter: Some(enter),
            exit: Some(exit),
        });
        port = far;
        out = exit;
    }
    // Hop limit: mark the last port as an end.
    if let Some(Step::Port { exit, .. }) = steps.last_mut() {
        *exit = None;
    }
    (steps, false, true)
}

/// Traces the chain through `port_id` in both directions.
pub fn trace(g: &Graph, port_id: i64) -> Trace {
    let sides = g.sides(port_id);
    let (forward, fwd_active, fwd_cut) = walk(g, port_id, sides[0]);
    let (backward, back_active, back_cut) = if sides.len() == 2 {
        walk(g, port_id, sides[1])
    } else {
        (Vec::new(), false, false)
    };
    let start_active = g.role(port_id) != Some(Role::Passive);

    // Order: far end of the backward walk ... start ... far end of the
    // forward walk. Reversing the backward walk swaps enter and exit.
    let mut steps: Vec<Step> = backward
        .iter()
        .rev()
        .map(|s| match *s {
            Step::Port {
                port_id,
                enter,
                exit,
            } => Step::Port {
                port_id,
                enter: exit,
                exit: enter,
            },
            other => other,
        })
        .collect();
    let has_back = !backward.is_empty();
    let has_fwd = !forward.is_empty();
    steps.push(Step::Port {
        port_id,
        enter: has_back.then_some(sides.get(1).copied()).flatten(),
        exit: has_fwd.then_some(sides[0]),
    });
    steps.extend(forward);

    let first = match steps.first() {
        Some(Step::Port { port_id, .. }) => *port_id,
        _ => port_id,
    };
    let last = match steps.last() {
        Some(Step::Port { port_id, .. }) => *port_id,
        _ => port_id,
    };
    let truncated = fwd_cut || back_cut;
    let state = if !has_fwd && !has_back {
        ChainState::Unconnected
    } else {
        // Each end of the chain must be an active port.
        let back_end_active = if has_back { back_active } else { start_active };
        let fwd_end_active = if has_fwd { fwd_active } else { start_active };
        if back_end_active && fwd_end_active && !truncated {
            ChainState::Complete
        } else {
            ChainState::Incomplete
        }
    };
    Trace {
        steps,
        state,
        ends: (first, last),
        truncated,
    }
}

/// Chain state for every port in the graph, tracing each chain once.
pub fn states(g: &Graph) -> HashMap<i64, ChainState> {
    let all: Vec<i64> = g.roles.keys().copied().collect();
    states_for(g, &all)
}

/// Chain state for the given ports (and, as a by-product, every other
/// port on their chains), tracing each chain once.
pub fn states_for(g: &Graph, ports: &[i64]) -> HashMap<i64, ChainState> {
    let mut out = HashMap::with_capacity(ports.len());
    for &port in ports {
        if out.contains_key(&port) {
            continue;
        }
        let t = trace(g, port);
        for p in t.ports() {
            out.entry(p).or_insert(t.state);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use Side::{Front, Rear};

    const SW: i64 = 1; // switch port (active)
    const PP: i64 = 2; // patch-panel port (passive)
    const TO: i64 = 3; // wall outlet (passive)
    const AP: i64 = 4; // access point (active)

    /// switch ─patch─ panel ═permanent═ outlet ─patch─ AP
    fn office() -> Graph {
        let mut g = Graph::default();
        g.add_port(SW, Role::Active);
        g.add_port(PP, Role::Passive);
        g.add_port(TO, Role::Passive);
        g.add_port(AP, Role::Active);
        g.add_cable(10, Kind::Patch, (SW, Front), (PP, Front));
        g.add_cable(11, Kind::Permanent, (PP, Rear), (TO, Rear));
        g.add_cable(12, Kind::Patch, (TO, Front), (AP, Front));
        g
    }

    fn end(port_id: i64, role: Role, side: Side) -> EndInfo {
        EndInfo {
            port_id,
            role,
            side,
            requires_permanent: true,
            rear_cabled: true,
            side_taken: false,
        }
    }

    #[test]
    fn full_chain_is_complete_from_any_port() {
        let g = office();
        for start in [SW, PP, TO, AP] {
            let t = trace(&g, start);
            assert_eq!(t.state, ChainState::Complete, "from {start}");
            assert_eq!(t.ports().collect::<Vec<_>>().len(), 4);
            assert_eq!(
                t.connections().map(|c| c.0).collect::<HashSet<_>>(),
                HashSet::from([10, 11, 12])
            );
            let ends = HashSet::from([t.ends.0, t.ends.1]);
            assert_eq!(ends, HashSet::from([SW, AP]));
        }
    }

    #[test]
    fn steps_are_ordered_with_sides() {
        let t = trace(&office(), SW);
        assert_eq!(
            t.steps,
            vec![
                Step::Port {
                    port_id: SW,
                    enter: None,
                    exit: Some(Front)
                },
                Step::Cable {
                    connection_id: 10,
                    kind: Kind::Patch
                },
                Step::Port {
                    port_id: PP,
                    enter: Some(Front),
                    exit: Some(Rear)
                },
                Step::Cable {
                    connection_id: 11,
                    kind: Kind::Permanent
                },
                Step::Port {
                    port_id: TO,
                    enter: Some(Rear),
                    exit: Some(Front)
                },
                Step::Cable {
                    connection_id: 12,
                    kind: Kind::Patch
                },
                Step::Port {
                    port_id: AP,
                    enter: Some(Front),
                    exit: None
                },
            ]
        );
        // From the middle: the same chain, one direction or the other.
        let mid = trace(&office(), TO);
        let ids: Vec<i64> = mid.ports().collect();
        assert!(
            ids == vec![SW, PP, TO, AP] || ids == vec![AP, TO, PP, SW],
            "{ids:?}"
        );
        if let Step::Port {
            port_id,
            enter,
            exit,
        } = mid.steps[4]
        {
            assert_eq!(port_id, TO);
            assert!(enter.is_some() && exit.is_some());
        }
    }

    #[test]
    fn unplugged_end_is_incomplete() {
        let mut g = office();
        g.cables.remove(&(TO, Front));
        g.cables.remove(&(AP, Front));
        for start in [SW, PP, TO] {
            assert_eq!(trace(&g, start).state, ChainState::Incomplete);
        }
        assert_eq!(trace(&g, AP).state, ChainState::Unconnected);
        let t = trace(&g, SW);
        assert_eq!(t.ends, (SW, TO));
    }

    #[test]
    fn direct_patch_between_active_ports_is_complete() {
        let mut g = Graph::default();
        g.add_port(1, Role::Active);
        g.add_port(2, Role::Active);
        g.add_port(3, Role::Active);
        g.add_cable(7, Kind::Patch, (1, Front), (2, Front));
        assert_eq!(trace(&g, 1).state, ChainState::Complete);
        assert_eq!(trace(&g, 2).state, ChainState::Complete);
        assert_eq!(trace(&g, 3).state, ChainState::Unconnected);
        let s = states(&g);
        assert_eq!(s[&1], ChainState::Complete);
        assert_eq!(s[&3], ChainState::Unconnected);
    }

    #[test]
    fn loops_and_long_chains_stop() {
        // Two passive ports cabled to each other on both sides: a loop.
        let mut g = Graph::default();
        g.add_port(1, Role::Passive);
        g.add_port(2, Role::Passive);
        g.add_cable(1, Kind::Patch, (1, Front), (2, Front));
        g.add_cable(2, Kind::Permanent, (1, Rear), (2, Rear));
        let t = trace(&g, 1);
        assert!(t.truncated);
        assert_eq!(t.state, ChainState::Incomplete);

        // A chain longer than the hop limit.
        let mut g = Graph::default();
        let n = (MAX_HOPS * 2 + 10) as i64;
        for p in 0..n {
            g.add_port(p, Role::Passive);
        }
        for p in 0..n - 1 {
            let (a, b) = if p % 2 == 0 {
                (Rear, Rear)
            } else {
                (Front, Front)
            };
            let kind = if p % 2 == 0 {
                Kind::Permanent
            } else {
                Kind::Patch
            };
            g.add_cable(p, kind, (p, a), (p + 1, b));
        }
        let t = trace(&g, 0);
        assert!(t.truncated);
        assert!(t.ports().count() <= MAX_HOPS + 1);
    }

    #[test]
    fn side_rules() {
        use Role::{Active, Passive};
        // Patch: fronts; permanent: passive rears.
        assert!(check_sides(Kind::Patch, &end(1, Active, Front), &end(2, Passive, Front)).is_ok());
        assert!(check_sides(
            Kind::Permanent,
            &end(1, Passive, Rear),
            &end(2, Passive, Rear)
        )
        .is_ok());
        assert!(check_sides(Kind::Patch, &end(1, Active, Front), &end(2, Passive, Rear)).is_err());
        assert!(check_sides(
            Kind::Permanent,
            &end(1, Active, Rear),
            &end(2, Passive, Rear)
        )
        .is_err());
        assert!(check_sides(
            Kind::Permanent,
            &end(1, Active, Front),
            &end(2, Passive, Front)
        )
        .is_err());
        // Itself
        assert!(check_sides(Kind::Patch, &end(1, Active, Front), &end(1, Active, Front)).is_err());
        // Side already used
        let mut taken = end(2, Active, Front);
        taken.side_taken = true;
        assert!(check_sides(Kind::Patch, &end(1, Active, Front), &taken).is_err());
        // No keystone yet
        let mut empty = end(2, Passive, Front);
        empty.rear_cabled = false;
        let e = check_sides(Kind::Patch, &end(1, Active, Front), &empty).unwrap_err();
        assert!(e.contains("permanent cable first"));
        // ... unless the port doesn't need one (coupler)
        empty.requires_permanent = false;
        assert!(check_sides(Kind::Patch, &end(1, Active, Front), &empty).is_ok());
        // Power cords: front sides of active ports.
        assert!(check_sides(Kind::Power, &end(1, Active, Front), &end(2, Active, Front)).is_ok());
        assert!(check_sides(Kind::Power, &end(1, Active, Front), &end(2, Passive, Front)).is_err());
    }

    #[test]
    fn names_round_trip() {
        for k in [Kind::Permanent, Kind::Patch, Kind::Power] {
            assert_eq!(Kind::parse(k.as_str()), Some(k));
        }
        for r in [Role::Active, Role::Passive] {
            assert_eq!(Role::parse(r.as_str()), Some(r));
        }
        for s in [Front, Rear] {
            assert_eq!(Side::parse(s.as_str()), Some(s));
            assert_eq!(s.other().other(), s);
        }
    }
}

/// Port defaults for a device type: patch panels, fibre panels and wall
/// outlets join cables (passive); everything else uses them (active).
pub fn default_port(type_key: &str) -> (Role, &'static str) {
    match type_key {
        "patch_panel" | "wall_outlet" => (Role::Passive, "RJ45"),
        "fibre_panel" => (Role::Passive, "LC"),
        _ => (Role::Active, "RJ45"),
    }
}

#[cfg(test)]
mod default_tests {
    use super::*;

    #[test]
    fn defaults_by_type() {
        assert_eq!(default_port("patch_panel"), (Role::Passive, "RJ45"));
        assert_eq!(default_port("fibre_panel"), (Role::Passive, "LC"));
        assert_eq!(default_port("switch"), (Role::Active, "RJ45"));
    }
}
