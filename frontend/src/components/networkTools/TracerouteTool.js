import React, { useState } from 'react';
import { Route } from 'lucide-react';
import client from '../../api/client';

const MAX_HOPS_OPTIONS = [15, 30];

function formatRtt(rtt) {
  if (!Array.isArray(rtt)) return '* * *';
  return rtt.map((v) => (v == null ? '*' : `${v} ms`)).join('  ');
}

export default function TracerouteTool() {
  const [host, setHost] = useState('');
  const [maxHops, setMaxHops] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const run = async () => {
    if (!host.trim()) {
      setError('Enter a host or IP address');
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await client.post('/tools/traceroute', { host: host.trim(), max_hops: maxHops });
      setResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Traceroute failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="nt-card">
      <div className="nt-card-header">
        <Route size={18} strokeWidth={2} />
        <h3>Traceroute</h3>
      </div>
      <div className="nt-card-body">
        <div className="nt-field-row">
          <div className="nt-field">
            <label className="nt-label" htmlFor="tr-host">Host / IP</label>
            <input
              id="tr-host"
              className="nt-input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="8.8.8.8"
              spellCheck={false}
            />
          </div>
          <div className="nt-field" style={{ flex: '0 0 110px' }}>
            <label className="nt-label" htmlFor="tr-maxhops">Max Hops</label>
            <select
              id="tr-maxhops"
              className="nt-select"
              value={maxHops}
              onChange={(e) => setMaxHops(Number(e.target.value))}
            >
              {MAX_HOPS_OPTIONS.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>
        </div>
        <button type="button" className="nt-button" onClick={run} disabled={loading}>
          {loading ? 'Tracing...' : 'Run'}
        </button>

        {loading && <div className="nt-loading">Running traceroute...</div>}
        {error && <div className="nt-error">{error}</div>}

        {result && !error && (
          <>
            <table className="nt-hop-table">
              <thead>
                <tr>
                  <th>Hop</th>
                  <th>IP</th>
                  <th>RTT</th>
                </tr>
              </thead>
              <tbody>
                {result.hops.map((hop) => (
                  <tr key={hop.hop}>
                    <td>{hop.hop}</td>
                    <td>{hop.ip || '*'}</td>
                    <td>{formatRtt(hop.rtt_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details className="nt-raw-output">
              <summary>Raw output</summary>
              <pre>{result.raw_output}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
