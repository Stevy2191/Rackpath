import React, { useState } from 'react';
import { Activity } from 'lucide-react';
import client from '../../api/client';

const COUNT_OPTIONS = [1, 4, 10];

export default function PingTool() {
  const [host, setHost] = useState('');
  const [count, setCount] = useState(4);
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
      const res = await client.post('/tools/ping', { host: host.trim(), count });
      setResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Ping failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="nt-card">
      <div className="nt-card-header">
        <Activity size={18} strokeWidth={2} />
        <h3>Ping</h3>
      </div>
      <div className="nt-card-body">
        <div className="nt-field-row">
          <div className="nt-field">
            <label className="nt-label" htmlFor="ping-host">Host / IP</label>
            <input
              id="ping-host"
              className="nt-input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.1"
              spellCheck={false}
            />
          </div>
          <div className="nt-field" style={{ flex: '0 0 90px' }}>
            <label className="nt-label" htmlFor="ping-count">Count</label>
            <select
              id="ping-count"
              className="nt-select"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            >
              {COUNT_OPTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        <button type="button" className="nt-button" onClick={run} disabled={loading}>
          {loading ? 'Pinging...' : 'Run'}
        </button>

        {loading && <div className="nt-loading">Running ping...</div>}
        {error && <div className="nt-error">{error}</div>}

        {result && !error && (
          <>
            <div className="nt-results">
              <div className="nt-result-row">
                <span className="nt-result-label">Result</span>
                <span className={`nt-result-value ${result.success ? 'nt-success' : 'nt-fail'}`}>
                  {result.success ? 'Success' : 'No response'}
                </span>
              </div>
              <div className="nt-result-row">
                <span className="nt-result-label">Packets Sent</span>
                <span className="nt-result-value">{result.packets_sent}</span>
              </div>
              <div className="nt-result-row">
                <span className="nt-result-label">Packets Received</span>
                <span className="nt-result-value">{result.packets_received}</span>
              </div>
              <div className="nt-result-row">
                <span className="nt-result-label">Packet Loss</span>
                <span className="nt-result-value">{result.packet_loss_percent}%</span>
              </div>
              <div className="nt-result-row">
                <span className="nt-result-label">Min / Avg / Max RTT</span>
                <span className="nt-result-value">
                  {result.min_ms != null ? `${result.min_ms} / ${result.avg_ms} / ${result.max_ms} ms` : 'n/a'}
                </span>
              </div>
            </div>
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
