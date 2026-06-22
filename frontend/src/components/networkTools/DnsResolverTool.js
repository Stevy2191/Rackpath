import React, { useState } from 'react';
import { Globe } from 'lucide-react';
import client from '../../api/client';

const RECORD_TYPES = ['A', 'AAAA', 'MX', 'CNAME', 'TXT', 'NS', 'PTR'];

export default function DnsResolverTool() {
  const [host, setHost] = useState('');
  const [recordType, setRecordType] = useState('A');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const run = async () => {
    if (!host.trim()) {
      setError('Enter a hostname or IP address');
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await client.post('/tools/dns', { host: host.trim(), record_type: recordType });
      setResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'DNS lookup failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="nt-card">
      <div className="nt-card-header">
        <Globe size={18} strokeWidth={2} />
        <h3>DNS Resolver</h3>
      </div>
      <div className="nt-card-body">
        <div className="nt-field-row">
          <div className="nt-field">
            <label className="nt-label" htmlFor="dns-host">Hostname / IP</label>
            <input
              id="dns-host"
              className="nt-input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="google.com"
              spellCheck={false}
            />
          </div>
          <div className="nt-field" style={{ flex: '0 0 110px' }}>
            <label className="nt-label" htmlFor="dns-type">Record Type</label>
            <select
              id="dns-type"
              className="nt-select"
              value={recordType}
              onChange={(e) => setRecordType(e.target.value)}
            >
              {RECORD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>
        <button type="button" className="nt-button" onClick={run} disabled={loading}>
          {loading ? 'Resolving...' : 'Run'}
        </button>

        {loading && <div className="nt-loading">Resolving...</div>}
        {error && <div className="nt-error">{error}</div>}

        {result && !error && (
          <>
            <div className="nt-result-list">
              {result.results.length === 0 ? (
                <div className="nt-result-list-item">No records found</div>
              ) : (
                result.results.map((r, i) => (
                  <div className="nt-result-list-item" key={i}>{r}</div>
                ))
              )}
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
