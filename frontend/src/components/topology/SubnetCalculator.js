import React, { useState } from 'react';
import { X } from 'lucide-react';
import './SubnetCalculator.css';

function ipToInt(parts) {
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

// Parse "a.b.c.d/n" into its derived subnet facts, or return an error string.
function calculate(cidr) {
  const match = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*\/\s*(\d{1,2})\s*$/.exec(cidr);
  if (!match) return { error: 'Enter an address like 192.168.1.0/24' };

  const octets = [match[1], match[2], match[3], match[4]].map(Number);
  const prefix = Number(match[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return { error: 'Invalid address or prefix' };

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const ipInt = ipToInt(octets);
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = 2 ** (32 - prefix);
  const usable = prefix >= 31 ? (prefix === 32 ? 1 : 2) : total - 2;
  const firstHost = prefix >= 31 ? network : (network + 1) >>> 0;
  const lastHost = prefix >= 31 ? broadcast : (broadcast - 1) >>> 0;

  return {
    network: intToIp(network),
    broadcast: intToIp(broadcast),
    netmask: intToIp(mask),
    wildcard: intToIp(~mask >>> 0),
    firstHost: intToIp(firstHost),
    lastHost: intToIp(lastHost),
    usable: usable.toLocaleString(),
    prefix,
  };
}

export default function SubnetCalculator({ onClose }) {
  const [cidr, setCidr] = useState('192.168.1.0/24');
  const result = calculate(cidr);

  const rows = result.error
    ? []
    : [
        ['Network', result.network],
        ['Netmask', result.netmask],
        ['Wildcard', result.wildcard],
        ['Broadcast', result.broadcast],
        ['First host', result.firstHost],
        ['Last host', result.lastHost],
        ['Usable hosts', result.usable],
      ];

  return (
    <div className="subnet-calc">
      <div className="subnet-calc-header">
        <span className="subnet-calc-title">Subnet Calculator</span>
        <button type="button" className="subnet-calc-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <input
        className="subnet-calc-input"
        value={cidr}
        onChange={(e) => setCidr(e.target.value)}
        placeholder="192.168.1.0/24"
        spellCheck={false}
      />
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
