import React, { useState } from 'react';
import { X } from 'lucide-react';
import './SubnetCalculator.css';

// Prefix lengths offered in the dropdown.
const PREFIXES = [];
for (let p = 8; p <= 30; p += 1) PREFIXES.push(p);

function ipToInt(parts) {
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

// RFC 1918 private ranges, evaluated against the network address.
function rangeType(networkInt) {
  const a = (networkInt >>> 24) & 255;
  const b = (networkInt >>> 16) & 255;
  if (a === 10) return 'Private';
  if (a === 172 && b >= 16 && b <= 31) return 'Private';
  if (a === 192 && b === 168) return 'Private';
  return 'Public';
}

// Derive subnet facts from a dotted IP string and a prefix length, or return
// an error when the address is malformed.
function calculate(ip, prefix) {
  const match = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(ip);
  if (!match) return { error: 'Enter an address like 10.1.20.0' };

  const octets = [match[1], match[2], match[3], match[4]].map(Number);
  if (octets.some((o) => o > 255)) return { error: 'Each octet must be 0-255' };

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const ipInt = ipToInt(octets);
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const totalHosts = 2 ** (32 - prefix) - 2;

  return {
    network: intToIp(network),
    broadcast: intToIp(broadcast),
    firstIp: intToIp((network + 1) >>> 0),
    lastIp: intToIp((broadcast - 1) >>> 0),
    totalHosts: totalHosts.toLocaleString(),
    rangeType: rangeType(network),
  };
}

export default function SubnetCalculator({ onClose }) {
  const [ip, setIp] = useState('192.168.1.0');
  const [prefix, setPrefix] = useState(24);

  const result = calculate(ip, prefix);

  const rows = result.error
    ? []
    : [
        ['Network', result.network],
        ['Broadcast', result.broadcast],
        ['First IP', result.firstIp],
        ['Last IP', result.lastIp],
        ['Total Hosts', result.totalHosts],
        ['Range Type', result.rangeType],
      ];

  return (
    <div className="subnet-calc">
      <div className="subnet-calc-header">
        <span className="subnet-calc-title">Subnet Calculator</span>
        <button type="button" className="subnet-calc-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="subnet-calc-row">
        <input
          className="subnet-calc-input"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="10.1.20.0"
          spellCheck={false}
          aria-label="Network address"
        />
        <select
          className="subnet-calc-prefix"
          value={prefix}
          onChange={(e) => setPrefix(Number(e.target.value))}
          aria-label="Prefix length"
        >
          {PREFIXES.map((p) => (
            <option key={p} value={p}>
              /{p}
            </option>
          ))}
        </select>
      </div>

      {result.error ? (
        <div className="subnet-calc-error">{result.error}</div>
      ) : (
        <table className="subnet-calc-table">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <th>{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
