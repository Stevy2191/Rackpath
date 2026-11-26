const net = require('net');

// Largest number of addresses a single scan may expand to (a /16).
const MAX_SCAN_HOSTS = 65536;

// Hostnames only: letters, digits, dots and hyphens, never starting with '-'
// so a target can't be mistaken for a command-line flag by nmap or ping.
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function splitTargets(value) {
  return String(value || '').trim().split(/[\s,]+/).filter(Boolean);
}

// Parses "a.b.c.d/nn" or an IPv6 CIDR. Returns { address, prefix, family } or null.
function parseCidr(token) {
  const slash = token.indexOf('/');
  if (slash === -1) return null;
  const address = token.slice(0, slash);
  const prefixText = token.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const family = net.isIP(address);
  const prefix = Number(prefixText);
  if (!family || prefix > (family === 4 ? 32 : 128)) return null;
  return { address, prefix, family };
}

// Validates a scan target string (single IP/hostname, CIDR, or a list of them).
// Returns an error message, or null when the target is acceptable.
function validateScanTarget(value) {
  if (typeof value !== 'string') return 'target_subnet must be a string';
  const tokens = splitTargets(value);
  if (tokens.length === 0) return 'target_subnet is required';

  let total = 0;
  for (const token of tokens) {
    if (token.includes('/')) {
      const cidr = parseCidr(token);
      if (!cidr) return `Invalid CIDR: ${token}`;
      const hostBits = (cidr.family === 4 ? 32 : 128) - cidr.prefix;
      if (hostBits > 16) return `${token} is too large to scan (maximum /16 for IPv4, /112 for IPv6)`;
      total += 2 ** hostBits;
    } else if (net.isIP(token) || HOSTNAME_RE.test(token)) {
      total += 1;
    } else {
      return `Invalid target: ${token}`;
    }
    if (total > MAX_SCAN_HOSTS) return `Scan targets expand to more than ${MAX_SCAN_HOSTS} addresses`;
  }
  return null;
}

// True when `ip` is one of the job's targets (exact IP/hostname or inside a CIDR).
function isIpInTarget(ip, target) {
  const family = net.isIP(ip);
  for (const token of splitTargets(target)) {
    if (token === ip) return true;
    const cidr = parseCidr(token);
    if (cidr && family === cidr.family) {
      const list = new net.BlockList();
      list.addSubnet(cidr.address, cidr.prefix, cidr.family === 4 ? 'ipv4' : 'ipv6');
      if (list.check(ip, family === 4 ? 'ipv4' : 'ipv6')) return true;
    }
  }
  return false;
}

module.exports = { validateScanTarget, isIpInTarget, MAX_SCAN_HOSTS };
