//! In-memory sliding-window limiter for failed logins, two-factor codes and
//! invitation acceptance. One process serves Rackpath, so memory is enough.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const WINDOW: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
pub struct RateLimiter {
    failures: Mutex<HashMap<String, Vec<Instant>>>,
}

impl RateLimiter {
    fn prune(list: &mut Vec<Instant>, now: Instant) {
        list.retain(|t| now.duration_since(*t) < WINDOW);
    }

    /// Seconds to wait before another attempt on any of `keys` (each with its
    /// own maximum), or 0 when the attempt may go ahead.
    pub fn retry_after(&self, keys: &[(&str, usize)]) -> u64 {
        let now = Instant::now();
        let mut map = self.failures.lock().expect("limiter lock");
        let mut wait = Duration::ZERO;
        for (key, max) in keys {
            if let Some(list) = map.get_mut(*key) {
                Self::prune(list, now);
                if list.len() >= *max {
                    let oldest_relevant = list[list.len() - max];
                    wait = wait.max(WINDOW.saturating_sub(now.duration_since(oldest_relevant)));
                }
            }
        }
        map.retain(|_, v| !v.is_empty());
        wait.as_secs().max(if wait.is_zero() { 0 } else { 1 })
    }

    pub fn record_failure(&self, keys: &[&str]) {
        let now = Instant::now();
        let mut map = self.failures.lock().expect("limiter lock");
        for key in keys {
            let list = map.entry((*key).to_string()).or_default();
            Self::prune(list, now);
            list.push(now);
        }
    }

    pub fn clear(&self, key: &str) {
        self.failures.lock().expect("limiter lock").remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_failures_and_clears() {
        let l = RateLimiter::default();
        for _ in 0..3 {
            assert_eq!(l.retry_after(&[("u:alice", 3)]), 0);
            l.record_failure(&["u:alice"]);
        }
        assert!(l.retry_after(&[("u:alice", 3)]) > 0);
        assert_eq!(l.retry_after(&[("u:bob", 3)]), 0, "other keys unaffected");
        l.clear("u:alice");
        assert_eq!(l.retry_after(&[("u:alice", 3)]), 0);
    }
}
