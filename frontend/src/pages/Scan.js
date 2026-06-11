import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import client from '../api/client';
import './Scan.css';

const API_BASE = process.env.REACT_APP_API_BASE_URL || '/api';

const COLUMNS = [
  { key: 'status', label: 'Status' },
  { key: 'ip', label: 'IP Address' },
  { key: 'hostname', label: 'Hostname' },
  { key: 'mac', label: 'MAC Address' },
  { key: 'mac_vendor', label: 'MAC Vendor' },
  { key: 'device_type', label: 'Device Type' },
  { key: 'os', label: 'OS' },
  { key: 'open_ports', label: 'Open Ports' },
  { key: 'netbios_name', label: 'NetBIOS Name' },
  { key: 'last_seen', label: 'Last Seen' },
];

const ACTIVE_STATUSES = ['pending', 'running'];

function ipToNum(ip) {
  if (!ip) return -1;
  return ip.split('.').reduce((acc, part) => acc * 256 + (parseInt(part, 10) || 0), 0);
}

function sortValue(row, key) {
  if (key === 'ip') return ipToNum(row.ip);
  if (key === 'open_ports') return (row.open_ports || []).length;
  const v = row[key];
  return v == null ? '' : String(v).toLowerCase();
}

function formatPorts(ports) {
  if (!ports || ports.length === 0) return '-';
  return ports.join(', ');
}

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export default function ScanPage() {
  const [subnet, setSubnet] = useState('10.1.20.0/24');
  const [scanName, setScanName] = useState('');
  const [jobs, setJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [rows, setRows] = useState([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState(null);
  const [sort, setSort] = useState({ key: 'ip', dir: 'asc' });
  const [exportOpen, setExportOpen] = useState(false);

  const esRef = useRef(null);

  const loadJobs = useCallback(() => {
    client.get('/scans').then((res) => setJobs(res.data)).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const closeStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  // Open an SSE connection for a given scan job. Works for both live scans
  // (rows stream in) and completed ones (the init event replays all rows).
  const connectStream = useCallback(
    (jobId) => {
      closeStream();
      setRows([]);
      setSelected(new Set());
      setImportMessage(null);
      setError(null);

      // EventSource sends the httpOnly session cookie automatically on
      // same-origin requests, so the stream is JWT-protected like every route.
      const url = `${API_BASE}/scans/${jobId}/stream`;
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.addEventListener('init', (e) => {
        const data = JSON.parse(e.data);
        setRows(data.hosts || []);
        setProgress({ current: data.progress_current || 0, total: data.progress_total || 0 });
        setStatus(data.status);
      });

      es.addEventListener('host', (e) => {
        const host = JSON.parse(e.data);
        setRows((prev) => (prev.some((r) => r.id === host.id) ? prev : [...prev, host]));
      });

      es.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);
        setProgress({ current: data.progress_current || 0, total: data.progress_total || 0 });
      });

      es.addEventListener('scan_complete', (e) => {
        const data = JSON.parse(e.data);
        setStatus(data.status || 'completed');
        closeStream();
        loadJobs();
      });

      es.onerror = () => {
        // The browser auto-reconnects EventSource; if the scan is already done
        // there's nothing to reconnect to, so just close quietly.
        if (esRef.current === es && (status === 'completed' || status === 'failed')) {
          closeStream();
        }
      };
    },
    [closeStream, loadJobs, status]
  );

  useEffect(() => closeStream, [closeStream]);

  const handleSelectJob = (job) => {
    setActiveJob(job);
    setStatus(job.status);
    setProgress({ current: job.progress_current || 0, total: job.progress_total || 0 });
    connectStream(job.id);
  };

  const handleStartScan = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await client.post('/scans', {
        target_subnet: subnet,
        name: scanName.trim() || undefined,
      });
      setActiveJob(res.data);
      setStatus(res.data.status);
      setProgress({ current: 0, total: 0 });
      setScanName('');
      connectStream(res.data.id);
      loadJobs();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleSort = (key) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    );
  };

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, sort]);

  const counts = useMemo(() => {
    const up = rows.filter((r) => r.status === 'up').length;
    const down = Math.max(0, (progress.current || 0) - up);
    return { found: rows.length, up, down };
  }, [rows, progress]);

  const progressPercent =
    progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  const isActive = ACTIVE_STATUSES.includes(status);

  const toggleRow = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
  };

  const handleImportSelected = async () => {
    const chosen = rows.filter((r) => selected.has(r.id));
    if (chosen.length === 0 || !activeJob) return;

    const devices = chosen.map((r) => ({
      ip: r.ip,
      mac: r.mac,
      hostname: r.hostname,
      device_type: r.device_type,
      snmp_community: r.raw?.snmp_community || undefined,
      ports: r.raw?.ports || undefined,
    }));

    setImporting(true);
    setImportMessage(null);
    try {
      const res = await client.post(`/scans/${activeJob.id}/import`, { devices });
      const addedNames = res.data.added.map((d) => d.ip || d.hostname || `#${d.id}`);
      const skippedNames = res.data.skipped.map((d) => d.ip || d.hostname || `#${d.id}`);
      let msg = `Added ${res.data.added.length} device(s)`;
      if (addedNames.length) msg += `: ${addedNames.join(', ')}`;
      if (skippedNames.length) {
        msg += `. Skipped ${skippedNames.length} duplicate(s): ${skippedNames.join(', ')}`;
      }
      setImportMessage(msg);
      setSelected(new Set());
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setImporting(false);
    }
  };

  const exportRows = () =>
    sortedRows.map((r) => [
      r.status || '',
      r.ip || '',
      r.hostname || '',
      r.mac || '',
      r.mac_vendor || '',
      r.device_type || '',
      r.os || '',
      formatPorts(r.open_ports),
      r.netbios_name || '',
      formatDate(r.last_seen),
    ]);

  const handleExportCsv = () => {
    setExportOpen(false);
    const header = COLUMNS.map((c) => c.label);
    const lines = [header, ...exportRows()]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${(activeJob?.name || 'scan').replace(/[^\w.-]+/g, '_')}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleExportPdf = () => {
    setExportOpen(false);
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(16);
    doc.text('Rackpath Scan Report', 14, 16);
    doc.setFontSize(10);
    const meta = [
      `Name: ${activeJob?.name || '-'}`,
      `Subnet: ${activeJob?.target_subnet || subnet}`,
      `Date: ${formatDate(activeJob?.completed_at || activeJob?.started_at || Date.now())}`,
      `Hosts found: ${rows.length}`,
    ];
    meta.forEach((line, i) => doc.text(line, 14, 24 + i * 5));

    autoTable(doc, {
      head: [COLUMNS.map((c) => c.label)],
      body: exportRows(),
      startY: 24 + meta.length * 5 + 4,
      styles: { fontSize: 7, cellPadding: 1.5 },
      headStyles: { fillColor: [37, 99, 235] },
    });

    doc.save(`${(activeJob?.name || 'scan').replace(/[^\w.-]+/g, '_')}.pdf`);
  };

  return (
    <div className="scan-page">
      {error && <div className="page-error">{error}</div>}

      <div className="scan-layout">
        <aside className="scan-history">
          <h3>Scan History</h3>
          <ul>
            {jobs.map((job) => (
              <li key={job.id}>
                <button
                  className={activeJob?.id === job.id ? 'active' : ''}
                  onClick={() => handleSelectJob(job)}
                >
                  <span className="scan-history-name">{job.name || job.target_subnet}</span>
                  <span className="scan-history-meta">
                    {job.target_subnet} · {job.status} · {job.host_count ?? 0} hosts
                  </span>
                  <span className="scan-history-date">{formatDate(job.created_at)}</span>
                </button>
              </li>
            ))}
            {jobs.length === 0 && <li className="scan-history-empty">No scans yet.</li>}
          </ul>
        </aside>

        <section className="scan-main">
          <form onSubmit={handleStartScan} className="scan-config">
            <h2>Scan Configuration</h2>
            <div className="scan-config-fields">
              <label>
                Subnet
                <input
                  value={subnet}
                  onChange={(e) => setSubnet(e.target.value)}
                  placeholder="e.g. 10.1.20.0/24"
                  required
                />
              </label>
              <label>
                Scan Name (optional)
                <input
                  value={scanName}
                  onChange={(e) => setScanName(e.target.value)}
                  placeholder="Defaults to subnet + timestamp"
                />
              </label>
              <button type="submit" disabled={submitting}>
                {submitting ? 'Starting...' : 'Start Scan'}
              </button>
            </div>
          </form>

          {activeJob ? (
            <>
              <div className="scan-status-bar">
                <div className="scan-progress">
                  <div className="scan-progress-bar">
                    <div className="scan-progress-fill" style={{ width: `${progressPercent}%` }} />
                  </div>
                  <div className="scan-progress-label">
                    {progress.total > 0
                      ? `Scanned ${progress.current} of ${progress.total} hosts (${progressPercent}%)`
                      : isActive
                      ? 'Preparing scan...'
                      : 'Scan complete'}
                  </div>
                </div>
                <div className="scan-counters">
                  <span className="scan-counter">{counts.found} found</span>
                  <span className="scan-counter scan-counter-up">{counts.up} up</span>
                  <span className="scan-counter scan-counter-down">{counts.down} down</span>
                </div>
              </div>

              <div className="scan-results-wrap">
                <table className="scan-results-table">
                  <thead>
                    <tr>
                      <th className="scan-check-col">
                        <input
                          type="checkbox"
                          checked={rows.length > 0 && selected.size === rows.length}
                          onChange={toggleSelectAll}
                          aria-label="Select all"
                        />
                      </th>
                      {COLUMNS.map((col) => (
                        <th key={col.key} onClick={() => toggleSort(col.key)} className="sortable">
                          {col.label}
                          {sort.key === col.key && (
                            <span className="sort-indicator">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row) => (
                      <tr key={row.id}>
                        <td className="scan-check-col">
                          <input
                            type="checkbox"
                            checked={selected.has(row.id)}
                            onChange={() => toggleRow(row.id)}
                          />
                        </td>
                        <td>
                          <span
                            className={`status-dot ${row.status === 'up' ? 'up' : 'down'}`}
                            title={row.status}
                          />
                        </td>
                        <td>{row.ip || '-'}</td>
                        <td>{row.hostname || '-'}</td>
                        <td>{row.mac || '-'}</td>
                        <td>{row.mac_vendor || '-'}</td>
                        <td>{row.device_type || '-'}</td>
                        <td>{row.os || '-'}</td>
                        <td>{formatPorts(row.open_ports)}</td>
                        <td>{row.netbios_name || '-'}</td>
                        <td>{formatDate(row.last_seen)}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={COLUMNS.length + 1} className="scan-empty-row">
                          {isActive ? 'Waiting for hosts to be discovered...' : 'No hosts discovered.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="scan-actions">
                <div className="scan-export">
                  <button type="button" onClick={() => setExportOpen((v) => !v)} disabled={rows.length === 0}>
                    Export ▾
                  </button>
                  {exportOpen && (
                    <div className="scan-export-menu">
                      <button type="button" onClick={handleExportPdf}>
                        Export as PDF
                      </button>
                      <button type="button" onClick={handleExportCsv}>
                        Export as CSV
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="scan-import-btn"
                  onClick={handleImportSelected}
                  disabled={importing || selected.size === 0}
                >
                  {importing ? 'Adding...' : `Add Selected to Inventory (${selected.size})`}
                </button>
                {importMessage && <span className="scan-import-message">{importMessage}</span>}
              </div>
            </>
          ) : (
            <div className="page-status">Start a scan or pick one from the history to view results.</div>
          )}
        </section>
      </div>
    </div>
  );
}
