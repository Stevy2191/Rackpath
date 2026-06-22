// Pure IPv4 subnet math — no DOM, no network calls. Shared by the Subnet
// Calculator tool's inputs/outputs.

function ipToInt(octets) {
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

export function parseIp(ip) {
  const match = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(ip || '');
  if (!match) return null;
  const octets = [match[1], match[2], match[3], match[4]].map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets;
}

function ipClass(firstOctet) {
  if (firstOctet <= 127) return 'A';
  if (firstOctet <= 191) return 'B';
  if (firstOctet <= 223) return 'C';
  if (firstOctet <= 239) return 'D';
  return 'E';
}

function rangeType(octets) {
  const [a, b] = octets;
  if (a === 127) return 'Loopback';
  if (a === 169 && b === 254) return 'Link-Local';
  if (a === 10) return 'Private';
  if (a === 172 && b >= 16 && b <= 31) return 'Private';
  if (a === 192 && b === 168) return 'Private';
  return 'Public';
}

export function calculateSubnet(ipStr, prefix) {
  const octets = parseIp(ipStr);
  if (!octets) return { error: 'Enter a valid IPv4 address, e.g. 192.168.1.50' };
  if (prefix < 0 || prefix > 32 || Number.isNaN(prefix)) {
    return { error: 'Prefix must be between /0 and /32' };
  }

  const ipInt = ipToInt(octets);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const wildcard = (~mask) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | wildcard) >>> 0;
  const totalHosts = 2 ** (32 - prefix);

  let usableHosts;
  let firstIp;
  let lastIp;
  if (prefix === 32) {
    usableHosts = 1;
    firstIp = network;
    lastIp = network;
  } else if (prefix === 31) {
    usableHosts = 2;
    firstIp = network;
    lastIp = broadcast;
  } else {
    usableHosts = totalHosts - 2;
    firstIp = (network + 1) >>> 0;
    lastIp = (broadcast - 1) >>> 0;
  }

  return {
    network: intToIp(network),
    broadcast: intToIp(broadcast),
    firstIp: intToIp(firstIp),
    lastIp: intToIp(lastIp),
    totalHosts: totalHosts.toLocaleString(),
    usableHosts: usableHosts.toLocaleString(),
    wildcardMask: intToIp(wildcard),
    subnetMask: intToIp(mask),
    ipClass: ipClass(octets[0]),
    rangeType: rangeType(octets),
  };
}
