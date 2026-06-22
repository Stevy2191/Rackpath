import React, { useState, useEffect } from 'react';
import { Server } from 'lucide-react';
import client from '../../api/client';
import { useProject } from '../../project/ProjectContext';

const STAT_OPTIONS = [
  { key: 'system', label: 'System Info' },
  { key: 'cpu', label: 'CPU Usage' },
  { key: 'memory', label: 'Memory Usage' },
  { key: 'interfaces', label: 'Interface Stats' },
];

const AUTH_PROTOCOLS = ['MD5', 'SHA'];
const PRIV_PROTOCOLS = ['DES', 'AES'];

const IF_STATUS = {
  1: 'up', 2: 'down', 3: 'testing', 4: 'unknown',
  5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown',
};


function formatKb(kb) {
  if (kb == null) return 'n/a';
  const mb = Math.round(Number(kb) / 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function formatSpeed(bps) {
  if (bps == null) return 'n/a';
  const n = Number(bps);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} Kbps`;
  return `${n} bps`;
}

export default function SnmpStatsTool() {
  const { currentProjectId } = useProject();

  const [host, setHost] = useState('');
  const [version, setVersion] = useState('2c');
  const [community, setCommunity] = useState('public');
  const [v3User, setV3User] = useState('');
  const [v3AuthProto, setV3AuthProto] = useState('MD5');
  const [v3AuthPass, setV3AuthPass] = useState('');
  const [v3PrivProto, setV3PrivProto] = useState('AES');
  const [v3PrivPass, setV3PrivPass] = useState('');
  const [selectedStats, setSelectedStats] = useState(['system', 'cpu', 'memory', 'interfaces']);
  const [macros, setMacros] = useState([]);
  const [selectedMacro, setSelectedMacro] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!currentProjectId) return;
    client.get(`/projects/${currentProjectId}/macros`)
      .then((res) => {
        setMacros(res.data.filter((m) =>
          m.type === 'snmp_v1' || m.type === 'snmp_v2c' || m.type === 'snmp_v3'
        ));
      })
      .catch(() => {});
  }, [currentProjectId]);

  const applyMacro = (macroId) => {
    setSelectedMacro(macroId);
    if (!macroId) return;
    const macro = macros.find((m) => String(m.id) === macroId);
    if (!macro) return;
    if (macro.type === 'snmp_v1') {
      setVersion('1');
      setCommunity(macro.community_string || 'public');
    } else if (macro.type === 'snmp_v2c') {
      setVersion('2c');
      setCommunity(macro.community_string || 'public');
    } else if (macro.type === 'snmp_v3') {
      setVersion('v3');
      setV3User(macro.username || '');
      setV3AuthProto(macro.auth_protocol || 'MD5');
      setV3AuthPass(macro.auth_password || '');
      setV3PrivProto(macro.priv_protocol || 'AES');
      setV3PrivPass(macro.priv_password || '');
    }
  };

  const toggleStat = (key) => {
    setSelectedStats((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const run = async () => {
    if (!host.trim()) {
      setError('Enter a host or IP address');
      setResult(null);
      return;
    }
    if (selectedStats.length === 0) {
      setError('Select at least one stat to retrieve');
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const payload = {
        host: host.trim(),
        version,
        community: version !== 'v3' ? community : undefined,
        v3_user: version === 'v3' ? v3User : undefined,
        v3_auth_protocol: version === 'v3' ? v3AuthProto : undefined,
        v3_auth_password: version === 'v3' ? v3AuthPass : undefined,
        v3_priv_protocol: version === 'v3' ? v3PrivProto : undefined,
        v3_priv_password: version === 'v3' ? v3PrivPass : undefined,
        stats: selectedStats,
      };
      const res = await client.post('/tools/snmp-stats', payload);
      setResult(res.data);
    } catch (err) {
      const msg = err.response?.data?.error || '';
      if (!msg || msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('unavailable')) {
        setError('No response from host — check IP, SNMP is enabled, and community string');
      } else if (msg.toLowerCase().includes('auth') || msg.toLowerCase().includes('credential')) {
        setError('SNMP authentication failed — check credentials');
      } else {
        setError(msg || 'SNMP query failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const isV3 = version === 'v3';

  return (
    <div className="nt-card">
      <div className="nt-card-header">
        <Server size={18} strokeWidth={2} />
        <h3>SNMP Device Stats</h3>
      </div>
      <div className="nt-card-body">

        {macros.length > 0 && (
          <div className="nt-field">
            <label className="nt-label" htmlFor="snmp-macro">Credential Macro</label>
            <select
              id="snmp-macro"
              className="nt-select"
              value={selectedMacro}
              onChange={(e) => applyMacro(e.target.value)}
            >
              <option value="">— or enter manually —</option>
              {macros.map((m) => (
                <option key={m.id} value={String(m.id)}>{m.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="nt-field-row">
          <div className="nt-field">
            <label className="nt-label" htmlFor="snmp-host">Host / IP</label>
            <input
              id="snmp-host"
              className="nt-input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.1"
              spellCheck={false}
            />
          </div>
          <div className="nt-field" style={{ flex: '0 0 80px' }}>
            <label className="nt-label" htmlFor="snmp-version">Version</label>
            <select
              id="snmp-version"
              className="nt-select"
              value={version}
              onChange={(e) => { setVersion(e.target.value); setSelectedMacro(''); }}
            >
              <option value="1">v1</option>
              <option value="2c">v2c</option>
              <option value="v3">v3</option>
            </select>
          </div>
        </div>

        {!isV3 && (
          <div className="nt-field">
            <label className="nt-label" htmlFor="snmp-community">Community String</label>
            <input
              id="snmp-community"
              className="nt-input"
              value={community}
              onChange={(e) => { setCommunity(e.target.value); setSelectedMacro(''); }}
              placeholder="public"
              spellCheck={false}
            />
          </div>
        )}

        {isV3 && (
          <>
            <div className="nt-field">
              <label className="nt-label" htmlFor="snmp-v3-user">Username</label>
              <input
                id="snmp-v3-user"
                className="nt-input"
                value={v3User}
                onChange={(e) => { setV3User(e.target.value); setSelectedMacro(''); }}
                placeholder="admin"
                spellCheck={false}
              />
            </div>
            <div className="nt-field-row">
              <div className="nt-field">
                <label className="nt-label" htmlFor="snmp-auth-proto">Auth Protocol</label>
                <select
                  id="snmp-auth-proto"
                  className="nt-select"
                  value={v3AuthProto}
                  onChange={(e) => { setV3AuthProto(e.target.value); setSelectedMacro(''); }}
                >
                  {AUTH_PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="nt-field">
                <label className="nt-label" htmlFor="snmp-auth-pass">Auth Password</label>
                <input
                  id="snmp-auth-pass"
                  type="password"
                  className="nt-input"
                  value={v3AuthPass}
                  onChange={(e) => { setV3AuthPass(e.target.value); setSelectedMacro(''); }}
                  placeholder="Auth password"
                />
              </div>
            </div>
            <div className="nt-field-row">
              <div className="nt-field">
                <label className="nt-label" htmlFor="snmp-priv-proto">Privacy Protocol</label>
                <select
                  id="snmp-priv-proto"
                  className="nt-select"
                  value={v3PrivProto}
                  onChange={(e) => { setV3PrivProto(e.target.value); setSelectedMacro(''); }}
                >
                  {PRIV_PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="nt-field">
                <label className="nt-label" htmlFor="snmp-priv-pass">Privacy Password</label>
                <input
                  id="snmp-priv-pass"
                  type="password"
                  className="nt-input"
                  value={v3PrivPass}
                  onChange={(e) => { setV3PrivPass(e.target.value); setSelectedMacro(''); }}
                  placeholder="Privacy password"
                />
              </div>
            </div>
          </>
        )}

        <div className="nt-field">
          <span className="nt-label">Stats to Retrieve</span>
          <div className="nt-checkbox-group">
            {STAT_OPTIONS.map(({ key, label }) => (
              <label key={key} className="nt-checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedStats.includes(key)}
                  onChange={() => toggleStat(key)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <button type="button" className="nt-button" onClick={run} disabled={loading}>
          {loading ? 'Querying...' : 'Run'}
        </button>

        {loading && <div className="nt-loading">Querying device via SNMP...</div>}
        {error && <div className="nt-error">{error}</div>}

        {result && !error && (
          <>
            {result.system && (
              <div className="nt-snmp-section">
                <div className="nt-snmp-section-title">System Info</div>
                {[
                  ['Name', result.system.sysName],
                  ['Description', result.system.sysDescr],
                  ['Location', result.system.sysLocation],
                  ['Contact', result.system.sysContact],
                  ['Uptime', result.system.sysUptime ?? 'n/a'],
                ].map(([label, value]) => (
                  <div className="nt-result-row" key={label}>
                    <span className="nt-result-label">{label}</span>
                    <span className="nt-result-value">{value ?? 'n/a'}</span>
                  </div>
                ))}
              </div>
            )}

            {result.cpu && (
              <div className="nt-snmp-section">
                <div className="nt-snmp-section-title">
                  CPU Usage{result.cpu.source ? ` — ${result.cpu.source}` : ''}
                </div>
                {result.cpu.source ? (
                  <>
                    {result.cpu.load_5sec != null && (
                      <div className="nt-result-row">
                        <span className="nt-result-label">5 sec</span>
                        <span className="nt-result-value">{result.cpu.load_5sec}%</span>
                      </div>
                    )}
                    {result.cpu.load_1min != null && (
                      <div className="nt-result-row">
                        <span className="nt-result-label">1 min</span>
                        <span className="nt-result-value">{result.cpu.load_1min}%</span>
                      </div>
                    )}
                    {result.cpu.load_5min != null && (
                      <div className="nt-result-row">
                        <span className="nt-result-label">5 min</span>
                        <span className="nt-result-value">{result.cpu.load_5min}%</span>
                      </div>
                    )}
                    {result.cpu.load_15min != null && (
                      <div className="nt-result-row">
                        <span className="nt-result-label">15 min</span>
                        <span className="nt-result-value">{result.cpu.load_15min}%</span>
                      </div>
                    )}
                    {result.cpu.load_percent != null && (
                      <div className="nt-result-row">
                        <span className="nt-result-label">Usage</span>
                        <span className="nt-result-value">{result.cpu.load_percent}%</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="nt-snmp-no-data">No CPU data available for this device</div>
                )}
              </div>
            )}

            {result.memory && (
              <div className="nt-snmp-section">
                <div className="nt-snmp-section-title">
                  Memory Usage{result.memory.source ? ` — ${result.memory.source}` : ''}
                </div>
                {result.memory.source ? (
                  <>
                    {result.memory.total_kb != null && (
                      <div className="nt-result-row">
                        <span className="nt-result-label">Total</span>
                        <span className="nt-result-value">{formatKb(result.memory.total_kb)}</span>
                      </div>
                    )}
                    {result.memory.used_kb != null && (
                      <div className="nt-result-row">
                        <span className="nt-result-label">Used</span>
                        <span className="nt-result-value">{formatKb(result.memory.used_kb)}</span>
                      </div>
                    )}
                    {result.memory.free_kb != null && (
                      <div className="nt-result-row">
                        <span className="nt-result-label">Free</span>
                        <span className="nt-result-value">{formatKb(result.memory.free_kb)}</span>
                      </div>
                    )}
                    {result.memory.percent != null && (
                      <div className="nt-result-row">
                        <span className="nt-result-label">Usage</span>
                        <span className="nt-result-value">{result.memory.percent}%</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="nt-snmp-no-data">No memory data available for this device</div>
                )}
              </div>
            )}

            {result.interfaces != null && (
              <div className="nt-snmp-section">
                <div className="nt-snmp-section-title">Interface Stats</div>
                {result.interfaces.length === 0 ? (
                  <div className="nt-snmp-no-data">No interface data available</div>
                ) : (
                  <div className="nt-table-wrap">
                    <table className="nt-iface-table">
                      <thead>
                        <tr>
                          <th>Idx</th>
                          <th>Description</th>
                          <th>Speed</th>
                          <th>Admin</th>
                          <th>Oper</th>
                          <th>In Octets</th>
                          <th>Out Octets</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.interfaces.map((iface) => (
                          <tr key={iface.index}>
                            <td>{iface.index}</td>
                            <td>{iface.description ?? '-'}</td>
                            <td>{formatSpeed(iface.speed)}</td>
                            <td>{IF_STATUS[iface.admin_status] ?? iface.admin_status ?? '-'}</td>
                            <td className={
                              iface.oper_status === 1 ? 'nt-iface-up'
                                : iface.oper_status === 2 ? 'nt-iface-down'
                                  : ''
                            }>
                              {IF_STATUS[iface.oper_status] ?? iface.oper_status ?? '-'}
                            </td>
                            <td>{iface.in_octets != null ? Number(iface.in_octets).toLocaleString() : '-'}</td>
                            <td>{iface.out_octets != null ? Number(iface.out_octets).toLocaleString() : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {result.raw_oids && Object.keys(result.raw_oids).length > 0 && (
              <details className="nt-raw-output">
                <summary>Raw OID Data ({Object.keys(result.raw_oids).length} entries)</summary>
                <pre>
                  {Object.entries(result.raw_oids)
                    .map(([oid, val]) => `${oid} = ${val}`)
                    .join('\n')}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
