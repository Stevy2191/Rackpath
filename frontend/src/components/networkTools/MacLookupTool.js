import React, { useState } from 'react';
import { Search } from 'lucide-react';
import client from '../../api/client';

function normalizeMac(input) {
  const hex = (input || '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{1,2}/g).join(':').toUpperCase();
}

export default function MacLookupTool() {
  const [mac, setMac] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [vendor, setVendor] = useState(null);

  const run = async () => {
    const normalized = normalizeMac(mac);
    setVendor(null);
    setError(null);
    if (!normalized) {
      setError('Enter a valid MAC address, e.g. AA:BB:CC:DD:EE:FF');
      return;
    }

    setLoading(true);
    try {
      const res = await client.post('/tools/mac-lookup', { mac: normalized });
      setVendor(res.data.vendor);
    } catch (err) {
      setError(err.response?.data?.error || 'Lookup failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="nt-card">
      <div className="nt-card-header">
        <Search size={18} strokeWidth={2} />
        <h3>MAC Address Lookup</h3>
      </div>
      <div className="nt-card-body">
        <div className="nt-field">
          <label className="nt-label" htmlFor="mac-input">MAC Address</label>
          <input
            id="mac-input"
            className="nt-input"
            value={mac}
            onChange={(e) => setMac(e.target.value)}
            placeholder="AA:BB:CC:DD:EE:FF"
            spellCheck={false}
          />
        </div>
        <button type="button" className="nt-button" onClick={run} disabled={loading}>
          {loading ? 'Looking up...' : 'Run'}
        </button>

        {loading && <div className="nt-loading">Looking up vendor...</div>}
        {error && <div className="nt-error">{error}</div>}
        {vendor !== null && !error && (
          <div className="nt-results">
            <div className="nt-result-row">
              <span className="nt-result-label">Vendor</span>
              <span className="nt-result-value">{vendor}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
