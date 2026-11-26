// In-memory limiter for failed logins. Counts failures per username and per
// client IP over a sliding window; a successful login clears the username's
// count. Single-process only, which matches how the API is deployed.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_USERNAME = 10;
const MAX_FAILURES_PER_IP = 50;

const failures = new Map(); // key -> array of failure timestamps

function recent(key, now) {
  const list = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

function keys(username, ip) {
  return [`u:${String(username).toLowerCase()}`, `ip:${ip}`];
}

// Returns the number of seconds to wait, or 0 when the attempt may proceed.
function retryAfterSeconds(username, ip) {
  const now = Date.now();
  const [userKey, ipKey] = keys(username, ip);
  const limits = [
    [recent(userKey, now), MAX_FAILURES_PER_USERNAME],
    [recent(ipKey, now), MAX_FAILURES_PER_IP],
  ];
  let wait = 0;
  for (const [list, max] of limits) {
    if (list.length >= max) wait = Math.max(wait, list[list.length - max] + WINDOW_MS - now);
  }
  return Math.ceil(wait / 1000);
}

function recordFailure(username, ip) {
  const now = Date.now();
  for (const key of keys(username, ip)) {
    const list = recent(key, now);
    list.push(now);
    failures.set(key, list);
  }
}

function recordSuccess(username) {
  failures.delete(keys(username, '')[0]);
}

// Drop stale entries now and then so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const key of failures.keys()) recent(key, now);
}, WINDOW_MS).unref();

module.exports = { retryAfterSeconds, recordFailure, recordSuccess };
