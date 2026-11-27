//! Power maths (design section 8). Pure, unit-tested.
//!
//! Power is ordinary ports and `power` connections: a cord runs from an
//! outlet (a PDU's C13, a UPS's NEMA 5-15R) to an inlet (a server's C14).
//! Loads flow upstream: a device's demand is its own draw plus whatever its
//! outlets feed. A device with several connected inlets (redundant PSUs)
//! splits its demand evenly between them.
//!
//! **Failover load** answers "what if the other feed fails?": each source
//! carries the *full* demand of everything it feeds, as when the B side of
//! an A/B pair goes down.

use std::collections::{HashMap, HashSet};

/// A runtime curve: (load in watts, minutes), any order. Points are
/// interpolated linearly; loads beyond the ends take the end values.
pub fn interpolate(curve: &[(f64, f64)], watts: f64) -> Option<f64> {
    let mut pts: Vec<(f64, f64)> = curve
        .iter()
        .copied()
        .filter(|(w, m)| w.is_finite() && m.is_finite())
        .collect();
    if pts.is_empty() {
        return None;
    }
    pts.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (first, last) = (pts[0], pts[pts.len() - 1]);
    if watts <= first.0 {
        return Some(first.1);
    }
    if watts >= last.0 {
        return Some(last.1);
    }
    for w in pts.windows(2) {
        let ((x0, y0), (x1, y1)) = (w[0], w[1]);
        if watts >= x0 && watts <= x1 {
            if x1 == x0 {
                return Some(y0.max(y1));
            }
            return Some(y0 + (watts - x0) / (x1 - x0) * (y1 - y0));
        }
    }
    None
}

/// One power cord: outlet side (source) to inlet side (load).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Feed {
    pub connection_id: i64,
    pub source_device: i64,
    pub load_device: i64,
}

#[derive(Default, Debug)]
pub struct Graph {
    /// Each device's own draw in watts (None when not recorded).
    pub draw: HashMap<i64, Option<f64>>,
    pub feeds: Vec<Feed>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Load {
    /// What the device asks of its inlets: own draw plus what it feeds.
    pub demand_w: f64,
    /// What it delivers through its outlets, sharing redundant loads.
    pub output_w: f64,
    /// What it would deliver if every other feed of its loads failed.
    pub failover_w: f64,
    /// Connected inlets.
    pub feeds_in: usize,
}

#[derive(Debug, Default)]
pub struct Loads {
    pub by_device: HashMap<i64, Load>,
    /// Devices whose draw isn't recorded but that something powers.
    pub unknown_draw: Vec<i64>,
    /// The cords formed a loop (bad data); its loads are understated.
    pub loop_detected: bool,
}

/// Computes every device's loads. Cycle-safe.
pub fn loads(g: &Graph) -> Loads {
    let mut out_feeds: HashMap<i64, Vec<&Feed>> = HashMap::new();
    let mut in_count: HashMap<i64, usize> = HashMap::new();
    for f in &g.feeds {
        out_feeds.entry(f.source_device).or_default().push(f);
        *in_count.entry(f.load_device).or_default() += 1;
    }
    let mut devices: HashSet<i64> = g.draw.keys().copied().collect();
    for f in &g.feeds {
        devices.insert(f.source_device);
        devices.insert(f.load_device);
    }

    struct Ctx<'a> {
        g: &'a Graph,
        out_feeds: &'a HashMap<i64, Vec<&'a Feed>>,
        demand: HashMap<i64, f64>,
        full: HashMap<i64, f64>,
        visiting: HashSet<i64>,
        looped: bool,
    }

    fn own(g: &Graph, d: i64) -> f64 {
        g.draw.get(&d).copied().flatten().unwrap_or(0.0)
    }

    // demand(d) = own(d) + sum over d's cords of demand(load)/inlets(load)
    fn demand(cx: &mut Ctx, in_count: &HashMap<i64, usize>, d: i64) -> f64 {
        if let Some(v) = cx.demand.get(&d) {
            return *v;
        }
        if !cx.visiting.insert(d) {
            cx.looped = true;
            return 0.0;
        }
        let mut total = own(cx.g, d);
        let feeds: Vec<i64> = cx
            .out_feeds
            .get(&d)
            .map(|v| v.iter().map(|f| f.load_device).collect())
            .unwrap_or_default();
        for load in feeds {
            let k = in_count.get(&load).copied().unwrap_or(1).max(1) as f64;
            total += demand(cx, in_count, load) / k;
        }
        cx.visiting.remove(&d);
        cx.demand.insert(d, total);
        total
    }

    // full(d) = own(d) + sum over distinct loads of full(load)
    fn full(cx: &mut Ctx, d: i64) -> f64 {
        if let Some(v) = cx.full.get(&d) {
            return *v;
        }
        if !cx.visiting.insert(d) {
            cx.looped = true;
            return 0.0;
        }
        let mut total = own(cx.g, d);
        let mut loads: Vec<i64> = cx
            .out_feeds
            .get(&d)
            .map(|v| v.iter().map(|f| f.load_device).collect())
            .unwrap_or_default();
        loads.sort_unstable();
        loads.dedup();
        for load in loads {
            total += full(cx, load);
        }
        cx.visiting.remove(&d);
        cx.full.insert(d, total);
        total
    }

    let mut cx = Ctx {
        g,
        out_feeds: &out_feeds,
        demand: HashMap::new(),
        full: HashMap::new(),
        visiting: HashSet::new(),
        looped: false,
    };
    let mut result = Loads::default();
    let mut ids: Vec<i64> = devices.into_iter().collect();
    ids.sort_unstable();
    for &d in &ids {
        let dm = demand(&mut cx, &in_count, d);
        let own_w = own(g, d);
        let mut distinct: Vec<i64> = out_feeds
            .get(&d)
            .map(|v| v.iter().map(|f| f.load_device).collect())
            .unwrap_or_default();
        distinct.sort_unstable();
        distinct.dedup();
        let failover: f64 = distinct.iter().map(|l| full(&mut cx, *l)).sum();
        result.by_device.insert(
            d,
            Load {
                demand_w: dm,
                output_w: dm - own_w,
                failover_w: failover,
                feeds_in: in_count.get(&d).copied().unwrap_or(0),
            },
        );
        let powered = in_count.contains_key(&d);
        let is_source = out_feeds.contains_key(&d);
        if powered && !is_source && g.draw.get(&d).copied().flatten().is_none() {
            result.unknown_draw.push(d);
        }
    }
    result.loop_detected = cx.looped;
    result
}

/// Estimated runtime in minutes for a UPS at `watts`: its own curve plus
/// what each connected battery module adds.
pub fn runtime(
    ups_curve: &[(f64, f64)],
    ebm_curves: &[Vec<(f64, f64)>],
    watts: f64,
) -> Option<f64> {
    let base = interpolate(ups_curve, watts)?;
    let extra: f64 = ebm_curves
        .iter()
        .filter_map(|c| interpolate(c, watts))
        .sum();
    Some(base + extra)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(id: i64, source: i64, load: i64) -> Feed {
        Feed {
            connection_id: id,
            source_device: source,
            load_device: load,
        }
    }

    #[test]
    fn interpolates_and_clamps() {
        let curve = [(1000.0, 5.0), (250.0, 30.0), (500.0, 15.0)];
        assert_eq!(interpolate(&curve, 100.0), Some(30.0));
        assert_eq!(interpolate(&curve, 250.0), Some(30.0));
        assert_eq!(interpolate(&curve, 375.0), Some(22.5));
        assert_eq!(interpolate(&curve, 750.0), Some(10.0));
        assert_eq!(interpolate(&curve, 5000.0), Some(5.0));
        assert_eq!(interpolate(&[], 10.0), None);
        assert_eq!(interpolate(&[(f64::NAN, 1.0)], 10.0), None);
    }

    #[test]
    fn runtime_adds_battery_modules() {
        let ups = [(0.0, 60.0), (1000.0, 10.0)];
        let ebm = vec![vec![(0.0, 120.0), (1000.0, 20.0)]];
        assert_eq!(runtime(&ups, &[], 500.0), Some(35.0));
        assert_eq!(runtime(&ups, &ebm, 500.0), Some(105.0));
        assert_eq!(runtime(&[], &ebm, 500.0), None);
    }

    /// UPS A and UPS B each feed a PDU; two servers (200 W each) have one
    /// PSU on each PDU; a switch (50 W) has a single PSU on PDU A.
    fn ab() -> Graph {
        let mut g = Graph::default();
        for (d, w) in [
            (1, None),
            (2, None),
            (11, Some(10.0)),
            (12, Some(10.0)),
            (21, Some(200.0)),
            (22, Some(200.0)),
            (31, Some(50.0)),
        ] {
            g.draw.insert(d, w);
        }
        g.feeds = vec![
            feed(1, 1, 11),
            feed(2, 2, 12),
            feed(3, 11, 21),
            feed(4, 12, 21),
            feed(5, 11, 22),
            feed(6, 12, 22),
            feed(7, 11, 31),
        ];
        g
    }

    #[test]
    fn redundant_loads_split_and_fail_over() {
        let l = loads(&ab());
        let at = |d: i64| l.by_device[&d];
        // PDU A: half of each server + the switch, plus its own 10 W.
        assert_eq!(at(11).output_w, 250.0);
        assert_eq!(at(11).demand_w, 260.0);
        assert_eq!(at(12).output_w, 200.0);
        assert_eq!(at(1).output_w, 260.0);
        assert_eq!(at(2).output_w, 210.0);
        // If B fails, A carries both servers in full.
        assert_eq!(at(11).failover_w, 450.0);
        assert_eq!(at(1).failover_w, 460.0);
        assert_eq!(at(2).failover_w, 410.0);
        assert_eq!(at(21).feeds_in, 2);
        assert!(l.unknown_draw.is_empty());
        assert!(!l.loop_detected);
    }

    #[test]
    fn two_cords_to_the_same_source_count_once_on_failover() {
        let mut g = Graph::default();
        g.draw.insert(2, Some(300.0));
        g.feeds = vec![feed(1, 1, 2), feed(2, 1, 2)];
        let l = loads(&g);
        assert_eq!(l.by_device[&1].output_w, 300.0);
        assert_eq!(l.by_device[&1].failover_w, 300.0);
    }

    #[test]
    fn unknown_draws_and_loops_are_reported() {
        let mut g = Graph::default();
        g.draw.insert(5, None);
        g.feeds = vec![feed(1, 1, 5), feed(2, 2, 3), feed(3, 3, 2)];
        let l = loads(&g);
        assert_eq!(l.unknown_draw, vec![5]);
        assert!(l.loop_detected);
    }
}
