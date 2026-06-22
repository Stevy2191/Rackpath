import React, { useState } from 'react';
import { Calculator } from 'lucide-react';
import { calculateSubnet } from './subnetMath';

export default function SubnetCalculatorTool() {
  const [ip, setIp] = useState('192.168.1.50');
  const [prefix, setPrefix] = useState(24);

  const result = calculateSubnet(ip, prefix);

  const rows = result.error
    ? []
    : [
        ['Network Address', result.network],
        ['Broadcast Address', result.broadcast],
        ['First Usable IP', result.firstIp],
        ['Last Usable IP', result.lastIp],
        ['Total Hosts', result.totalHosts],
        ['Usable Hosts', result.usableHosts],
        ['Subnet Mask', result.subnetMask],
        ['Wildcard Mask', result.wildcardMask],
        ['IP Class', result.ipClass],
        ['Range Type', result.rangeType],
      ];

  return (
    <div className="nt-card">
      <div className="nt-card-header">
        <Calculator size={18} strokeWidth={2} />
        <h3>Subnet Calculator</h3>
      </div>
      <div className="nt-card-body">
        <div className="nt-field-row">
          <div className="nt-field">
            <label className="nt-label" htmlFor="subnet-ip">IP Address</label>
            <input
              id="subnet-ip"
              className="nt-input"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.1.50"
              spellCheck={false}
            />
          </div>
          <div className="nt-field" style={{ flex: '0 0 90px' }}>
            <label className="nt-label" htmlFor="subnet-prefix">Prefix</label>
            <input
              id="subnet-prefix"
              type="number"
              min={0}
              max={32}
              className="nt-input"
              value={prefix}
              onChange={(e) => setPrefix(Number(e.target.value))}
            />
          </div>
        </div>
        <input
          type="range"
          className="nt-range-slider"
          min={0}
          max={32}
          value={prefix}
          onChange={(e) => setPrefix(Number(e.target.value))}
          aria-label="Prefix slider"
        />

        {result.error ? (
          <div className="nt-error">{result.error}</div>
        ) : (
          <div className="nt-results">
            {rows.map(([label, value]) => (
              <div className="nt-result-row" key={label}>
                <span className="nt-result-label">{label}</span>
                <span className="nt-result-value">{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
