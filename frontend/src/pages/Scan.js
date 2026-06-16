import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
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

const DEFAULT_PORT_RANGE = '1-1000';

// Scan profile presets. Each resolves to the concrete flags the scanner reads.
// port_range may be 'top100', 'all', or an explicit range string.
const PROFILE_PRESETS = {
  quick: {
    icmp_ping: true, tcp_ping: true, port_scan: false, port_range: null,
    os_detection: false, service_detection: false, snmp: false,
    netbios: false, mdns: false, mac_vendor: true,
  },
  standard: {
    icmp_ping: true, tcp_ping: true, port_scan: true, port_range: 'top1000',
    os_detection: true, service_detection: false, snmp: true,
    netbios: true, mdns: false, mac_vendor: true,
  },
  deep: {
    icmp_ping: true, tcp_ping: true, port_scan: true, port_range: 'all',
    os_detection: true, service_detection: true, snmp: true,
    netbios: true, mdns: true, mac_vendor: true,
  },
  ports: {
    icmp_ping: true, tcp_ping: true, port_scan: true, port_range: 'top1000',
    os_detection: false, service_detection: false, snmp: false,
    netbios: false, mdns: false, mac_vendor: true,
  },
};

const PROFILE_LABELS = [
  { value: 'quick', label: 'Quick Scan — ping sweep only' },
  { value: 'standard', label: 'Standard Scan — ping + top 1000 ports + OS + NetBIOS + SNMP' },
  { value: 'deep', label: 'Deep Scan — all 65535 ports + OS + version + NetBIOS + SNMP + mDNS' },
  { value: 'ports', label: 'Port Scan Only — top 1000 ports on up hosts, skip discovery' },
  { value: 'custom', label: 'Custom — choose individual options' },
];

const DEFAULT_CUSTOM = {
  icmp_ping: true,
  tcp_ping: true,
  port_scan: true,
  port_range: DEFAULT_PORT_RANGE,
  os_detection: true,
  service_detection: false,
  snmp: true,
  snmp_community: '',
  netbios: true,
  mdns: false,
  mac_vendor: true,
};

// Browser download helper: append the anchor to the DOM (required by Firefox),
// click it, then clean up. Revoking the object URL is deferred so the download
// isn't cancelled before it starts.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 1000);
}

// Build a safe filename slug from a scan name.
function scanSlug(name) {
  return (name || 'scan').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'scan';
}

function ipToNum(ip) {
  if (!ip) return -1;
  return ip.split('.').reduce((acc, part) => acc * 256 + (parseInt(part, 10) || 0), 0);
}

// Coerce whatever the API hands us for open_ports into an array. It should
// always be an array, but defend against null/undefined/string/number so a
// single odd row can never crash the whole table render.
function toPortsArray(ports) {
  if (Array.isArray(ports)) return ports;
  if (ports == null || ports === '') return [];
  if (typeof ports === 'string') {
    try {
      const parsed = JSON.parse(ports);
      return Array.isArray(parsed) ? parsed : [ports];
    } catch (err) {
      return ports.split(',').map((p) => p.trim()).filter(Boolean);
    }
  }
  return [ports];
}

function sortValue(row, key) {
  if (!row) return '';
  if (key === 'ip') return ipToNum(row.ip);
  if (key === 'open_ports') return toPortsArray(row.open_ports).length;
  const v = row[key];
  return v == null ? '' : String(v).toLowerCase();
}

function formatPorts(ports) {
  const arr = toPortsArray(ports);
  if (arr.length === 0) return '-';
  return arr.join(', ');
}

function formatDate(value) {
  if (!value) return '-';
  try {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  } catch (err) {
    return '-';
  }
}

// Fallback helpers: most fields show a dash when empty; device type defaults
// to "Unknown" so the column is never blank.
function dash(value) {
  return value == null || value === '' ? '-' : value;
}

function deviceType(value) {
  return value == null || value === '' ? 'Unknown' : value;
}

const PROFILE_NAMES = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
  ports: 'Port Scan Only',
  custom: 'Custom',
};

function profileName(value) {
  return PROFILE_NAMES[value] || (value ? String(value) : 'Standard');
}

// Format the elapsed time between two timestamps as e.g. "2m 34s" / "1h 5m 2s".
function formatDuration(start, end) {
  if (!start || !end) return '-';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m || h) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// Pick the right metadata label for the scanned target. Prefers the stored
// target_type (so reloaded scans are accurate), falling back to inspecting the
// target string for live scans started before the type was known.
function targetMeta(job, targetString) {
  const value = targetString || '';
  let type = job?.target_type;
  if (!type) {
    if (value.includes('/')) type = 'subnet';
    else if (/[,\s]/.test(value.trim())) type = 'multiple';
    else type = 'single';
  }
  if (type === 'subnet') return { label: 'Subnet', value };
  if (type === 'multiple') return { label: 'Targets', value };
  return { label: 'IP Address', value };
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

  // Scan options
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [targetType, setTargetType] = useState('subnet');
  const [multiTargets, setMultiTargets] = useState('');
  const [profile, setProfile] = useState('standard');
  const [custom, setCustom] = useState(DEFAULT_CUSTOM);
  const [clearing, setClearing] = useState(false);
  const [rescanningIds, setRescanningIds] = useState(new Set());
  const [rescanAllRunning, setRescanAllRunning] = useState(false);
  const [toast, setToast] = useState(null);

  // SNMP enrichment: which credential macros are available for this project,
  // and whether to run enrichment during the scan (default on when macros exist).
  const { currentProjectId } = useProject();
  const [snmpMacros, setSnmpMacros] = useState([]);
  const [snmpEnrichment, setSnmpEnrichment] = useState(true);

  const esRef = useRef(null);
  const rescanStreamsRef = useRef(new Map());

  useEffect(() => {
    if (!currentProjectId) return undefined;
    let cancelled = false;
    client
      .get(`/projects/${currentProjectId}/macros`)
      .then((res) => {
        if (cancelled) return;
        const snmp = (res.data || []).filter((m) => (m.type || '').startsWith('snmp'));
        setSnmpMacros(snmp);
        setSnmpEnrichment(snmp.length > 0);
      })
      .catch(() => {
        if (!cancelled) setSnmpMacros([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId]);

  const setCustomField = (field, value) =>
    setCustom((prev) => ({ ...prev, [field]: value }));

  // Resolve the current profile + target type into the options payload the
  // scanner consumes.
  const buildOptions = () => {
    const snmp_enrichment = snmpEnrichment && snmpMacros.length > 0;
    if (profile === 'custom') {
      return {
        profile: 'custom',
        target_type: targetType,
        snmp_enrichment,
        icmp_ping: custom.icmp_ping,
        tcp_ping: custom.tcp_ping,
        port_scan: custom.port_scan,
        port_range: custom.port_scan ? custom.port_range || DEFAULT_PORT_RANGE : null,
        os_detection: custom.os_detection,
        service_detection: custom.service_detection,
        snmp: custom.snmp,
        netbios: custom.netbios,
        mdns: custom.mdns,
        mac_vendor: custom.mac_vendor,
      };
    }
    return { profile, target_type: targetType, snmp_enrichment, ...PROFILE_PRESETS[profile] };
  };

  // Normalize the chosen target into the string the API/scanner parse. For
  // "Multiple IPs" the textarea (one per line or comma separated) becomes a
  // single comma-separated list.
  const buildTarget = () => {
    if (targetType === 'multiple') {
      return multiTargets
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .join(', ');
    }
    return subnet.trim();
  };

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

      const safeParse = (raw) => {
        try {
          return JSON.parse(raw);
        } catch (err) {
          return null;
        }
      };

      es.addEventListener('init', (e) => {
        const data = safeParse(e.data);
        if (!data) return;
        setRows(Array.isArray(data.hosts) ? data.hosts : []);
        setProgress({ current: data.progress_current || 0, total: data.progress_total || 0 });
        setStatus(data.status);
      });

      es.addEventListener('host', (e) => {
        const host = safeParse(e.data);
        if (!host) return;
        // Upsert by id: a host arrives once on discovery and again once SNMP
        // enrichment updates its OS/device-type, so replace the existing row.
        setRows((prev) => {
          const idx = prev.findIndex((r) => r.id === host.id);
          if (idx === -1) return [...prev, host];
          const next = prev.slice();
          next[idx] = host;
          return next;
        });
      });

      es.addEventListener('progress', (e) => {
        const data = safeParse(e.data);
        if (!data) return;
        setProgress({ current: data.progress_current || 0, total: data.progress_total || 0 });
      });

      es.addEventListener('scan_complete', (e) => {
        const data = safeParse(e.data) || {};
        setStatus(data.status || 'completed');
        closeStream();
        loadJobs();
        // Refresh the active job so export metadata (completed_at / duration)
        // reflects the finished scan without needing to reselect it.
        client
          .get(`/scans/${jobId}`)
          .then((res) => setActiveJob((prev) => (prev && prev.id === res.data.id ? res.data : prev)))
          .catch(() => {});
      });

      es.onerror = () => {
        // The browser auto-reconnects EventSource by default. Once the scan is
        // finished the stream is intentionally closed server-side and there's
        // nothing to reconnect to, so close it here to stop the retry loop.
        const es = esRef.current;
        if (es && es.readyState === EventSource.CLOSED) {
          closeStream();
        }
      };
    },
    [closeStream, loadJobs]
  );

  useEffect(() => closeStream, [closeStream]);

  // Close any open rescan SSE streams on unmount.
  useEffect(() => {
    const streams = rescanStreamsRef.current;
    return () => {
      streams.forEach((es) => es.close());
      streams.clear();
    };
  }, []);

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
      const target = buildTarget();
      if (!target) {
        setError(targetType === 'multiple' ? 'Enter at least one IP address.' : 'Enter a target to scan.');
        setSubmitting(false);
        return;
      }
      const options = buildOptions();
      // Custom profile with SNMP enabled may carry a community string override.
      const snmpCommunity =
        profile === 'custom' && custom.snmp && custom.snmp_community.trim()
          ? custom.snmp_community.trim()
          : undefined;

      const res = await client.post('/scans', {
        target_subnet: target,
        name: scanName.trim() || undefined,
        snmp_community: snmpCommunity,
        options,
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

  // Immediately start a new scan for a history job using the same settings.
  // Returns a Promise that resolves when the new scan completes so that
  // handleRescanAll can await each one in sequence.
  const handleRescan = async (job) => {
    if (rescanningIds.has(job.id)) return;

    const opts =
      job.options != null
        ? job.options
        : {
            profile: job.scan_profile || 'standard',
            target_type: job.target_type || 'subnet',
            ...(PROFILE_PRESETS[job.scan_profile] || PROFILE_PRESETS.standard),
          };

    setRescanningIds((prev) => new Set([...prev, job.id]));

    try {
      const res = await client.post('/scans', {
        target_subnet: job.target_subnet,
        name: job.name,
        snmp_community: job.snmp_community || undefined,
        options: opts,
      });
      const newJobId = res.data.id;
      loadJobs();

      await new Promise((resolve) => {
        const url = `${API_BASE}/scans/${newJobId}/stream`;
        const es = new EventSource(url, { withCredentials: true });
        rescanStreamsRef.current.set(job.id, es);

        const finish = () => {
          es.close();
          rescanStreamsRef.current.delete(job.id);
          setRescanningIds((prev) => {
            const next = new Set(prev);
            next.delete(job.id);
            return next;
          });
          loadJobs();
          resolve();
        };

        es.addEventListener('scan_complete', finish);
        es.onerror = () => {
          if (es.readyState === EventSource.CLOSED) finish();
        };
      });
    } catch (err) {
      setRescanningIds((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleRescanAll = async () => {
    if (rescanAllRunning || jobs.length === 0) return;
    setRescanAllRunning(true);
    try {
      for (const job of jobs) {
        // eslint-disable-next-line no-await-in-loop
        await handleRescan(job);
      }
    } finally {
      setRescanAllRunning(false);
      setToast('All subnets rescanned');
      setTimeout(() => setToast(null), 4000);
    }
  };

  const handleClearHistory = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete all scan history? This cannot be undone.')) return;
    setClearing(true);
    setError(null);
    try {
      await client.delete('/scans/history');
      closeStream();
      setJobs([]);
      setActiveJob(null);
      setRows([]);
      setStatus(null);
      setProgress({ current: 0, total: 0 });
      setSelected(new Set());
      setImportMessage(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setClearing(false);
    }
  };

  const toggleSort = (key) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    );
  };

  const sortedRows = useMemo(() => {
    const copy = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
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
    const up = sortedRows.filter((r) => r.status === 'up').length;
    const down = Math.max(0, (progress.current || 0) - up);
    return { found: sortedRows.length, up, down };
  }, [sortedRows, progress]);

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
    setSelected((prev) =>
      prev.size === sortedRows.length
        ? new Set()
        : new Set(sortedRows.map((r) => r.id).filter((id) => id != null))
    );
  };

  const handleImportSelected = async () => {
    const chosen = sortedRows.filter((r) => r.id != null && selected.has(r.id));
    if (chosen.length === 0 || !activeJob) return;

    const devices = chosen.map((r) => ({
      ip: r.ip,
      mac: r.mac,
      hostname: r.hostname,
      device_type: r.device_type,
      snmp_community: r.raw?.snmp_community || undefined,
      snmp_macro_id: r.snmp_macro_id || undefined,
      ports: Array.isArray(r.raw?.ports) ? r.raw.ports : undefined,
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
      r.device_type || 'Unknown',
      r.os || '',
      formatPorts(r.open_ports),
      r.netbios_name || '',
      formatDate(r.last_seen),
    ]);

  // Metadata rows shared by the PDF and CSV exports. Uses the active job's
  // stored fields (target_type, scan_profile, started/completed_at) so a
  // reloaded historical scan exports accurate metadata rather than a guess.
  const exportMeta = () => {
    const target = targetMeta(activeJob, activeJob?.target_subnet || subnet);
    return [
      ['Name', activeJob?.name || '-'],
      [target.label, target.value || '-'],
      ['Scan Profile', profileName(activeJob?.scan_profile)],
      ['Scan Duration', formatDuration(activeJob?.started_at, activeJob?.completed_at)],
      ['Date', formatDate(activeJob?.completed_at || activeJob?.started_at || Date.now())],
      ['Hosts found', String(sortedRows.length)],
    ];
  };

  const handleExportCsv = () => {
    setExportOpen(false);
    if (sortedRows.length === 0) return;
    const q = (c) => `"${String(c).replace(/"/g, '""')}"`;
    const metaLines = exportMeta().map(([k, v]) => `${q(k)},${q(v)}`);
    const header = COLUMNS.map((c) => q(c.label)).join(',');
    const bodyLines = exportRows().map((cols) => cols.map(q).join(','));
    const lines = [...metaLines, '', header, ...bodyLines].join('\r\n');
    // Prepend a BOM so Excel reads UTF-8 correctly.
    const blob = new Blob(['﻿', lines], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `rackpath-scan-${scanSlug(activeJob?.name)}.csv`);
  };

  const handleExportPdf = () => {
    setExportOpen(false);
    if (sortedRows.length === 0) return;
    try {
      const doc = new jsPDF({ orientation: 'landscape' });
      doc.setFontSize(16);
      doc.text('Rackpath Scan Report', 14, 16);
      doc.setFontSize(10);
      const meta = exportMeta();
      meta.forEach(([k, v], i) => doc.text(`${k}: ${v}`, 14, 24 + i * 5));

      autoTable(doc, {
        head: [COLUMNS.map((c) => c.label)],
        body: exportRows(),
        startY: 24 + meta.length * 5 + 4,
        styles: { fontSize: 7, cellPadding: 1.5 },
        headStyles: { fillColor: [37, 99, 235] },
      });

      // Generate a blob and use the shared downloader for reliable downloads
      // across browsers (more robust than jsPDF's internal save()).
      const blob = doc.output('blob');
      downloadBlob(blob, `rackpath-scan-${scanSlug(activeJob?.name)}.pdf`);
    } catch (err) {
      setError(`PDF export failed: ${err.message}`);
    }
  };

  return (
    <div className="scan-page">
      {error && <div className="page-error">{error}</div>}

      <div className="scan-layout">
        <aside className="scan-history">
          <div className="scan-history-header">
            <h3>Scan History</h3>
            <button
              type="button"
              className="scan-rescan-all-btn"
              onClick={handleRescanAll}
              disabled={rescanAllRunning || jobs.length === 0}
              title="Rescan all subnets sequentially"
            >
              {rescanAllRunning ? '↻ Running…' : '↻ Rescan All'}
            </button>
          </div>
          <ul className="scan-history-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <div className={`scan-history-item${rescanningIds.has(job.id) ? ' rescanning' : ''}`}>
                  <button
                    className={`scan-history-select-btn${activeJob?.id === job.id ? ' active' : ''}`}
                    onClick={() => handleSelectJob(job)}
                  >
                    <span className="scan-history-name">{job.name || job.target_subnet}</span>
                    <span className="scan-history-meta">
                      {job.target_subnet} · {job.status} · {job.host_count ?? 0} hosts
                    </span>
                    <span className="scan-history-date">{formatDate(job.created_at)}</span>
                  </button>
                  <button
                    type="button"
                    className="scan-rescan-btn"
                    title="Rescan this subnet"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRescan(job);
                    }}
                    disabled={rescanningIds.has(job.id) || rescanAllRunning}
                  >
                    ↻
                  </button>
                </div>
              </li>
            ))}
            {jobs.length === 0 && <li className="scan-history-empty">No scans yet.</li>}
          </ul>
          <button
            type="button"
            className="scan-clear-history"
            onClick={handleClearHistory}
            disabled={clearing || jobs.length === 0}
          >
            {clearing ? 'Clearing...' : 'Clear History'}
          </button>
        </aside>

        <section className="scan-main">
          <form onSubmit={handleStartScan} className="scan-config">
            <h2>Scan Configuration</h2>
            <div className="scan-config-fields">
              {targetType === 'multiple' ? (
                <label className="scan-multi-target">
                  Target IPs
                  <textarea
                    value={multiTargets}
                    onChange={(e) => setMultiTargets(e.target.value)}
                    placeholder={'One per line or comma separated\ne.g. 10.1.20.1, 10.1.20.5, 10.1.20.100'}
                    rows={3}
                  />
                </label>
              ) : (
                <label>
                  {targetType === 'single' ? 'IP Address' : 'Subnet'}
                  <input
                    value={subnet}
                    onChange={(e) => setSubnet(e.target.value)}
                    placeholder={targetType === 'single' ? 'e.g. 10.1.20.5' : 'e.g. 10.1.20.0/24'}
                    required
                  />
                </label>
              )}
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

            <button
              type="button"
              className="scan-options-toggle"
              aria-expanded={optionsOpen}
              onClick={() => setOptionsOpen((v) => !v)}
            >
              {optionsOpen ? '▾' : '▸'} Scan Options
            </button>

            {optionsOpen && (
              <div className="scan-options">
                <div className="scan-options-row">
                  <span className="scan-options-heading">Target type</span>
                  <label className="scan-radio">
                    <input
                      type="radio"
                      name="target_type"
                      checked={targetType === 'subnet'}
                      onChange={() => setTargetType('subnet')}
                    />
                    Subnet
                  </label>
                  <label className="scan-radio">
                    <input
                      type="radio"
                      name="target_type"
                      checked={targetType === 'single'}
                      onChange={() => setTargetType('single')}
                    />
                    Single IP
                  </label>
                  <label className="scan-radio">
                    <input
                      type="radio"
                      name="target_type"
                      checked={targetType === 'multiple'}
                      onChange={() => setTargetType('multiple')}
                    />
                    Multiple IPs
                  </label>
                </div>

                <div className="scan-options-row">
                  <label className="scan-options-field">
                    <span className="scan-options-heading">Scan profile</span>
                    <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                      {PROFILE_LABELS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="scan-options-row scan-snmp-enrich">
                  <label className="scan-checkbox">
                    <input
                      type="checkbox"
                      checked={snmpEnrichment && snmpMacros.length > 0}
                      disabled={snmpMacros.length === 0}
                      onChange={(e) => setSnmpEnrichment(e.target.checked)}
                    />
                    Use SNMP enrichment
                  </label>
                  {snmpMacros.length === 0 ? (
                    <span className="scan-snmp-hint">
                      Add a credential macro to enable SNMP enrichment during scans
                    </span>
                  ) : (
                    <span className="scan-snmp-macros">
                      Tries: {snmpMacros.map((m) => m.name).join(', ')}
                    </span>
                  )}
                </div>

                {profile === 'custom' && (
                  <div className="scan-custom-options">
                    <label className="scan-checkbox">
                      <input
                        type="checkbox"
                        checked={custom.icmp_ping}
                        onChange={(e) => setCustomField('icmp_ping', e.target.checked)}
                      />
                      ICMP Ping
                    </label>
                    <label className="scan-checkbox">
                      <input
                        type="checkbox"
                        checked={custom.tcp_ping}
                        onChange={(e) => setCustomField('tcp_ping', e.target.checked)}
                      />
                      TCP Ping (ports 22, 80, 443)
                    </label>
                    <label className="scan-checkbox">
                      <input
                        type="checkbox"
                        checked={custom.port_scan}
                        onChange={(e) => setCustomField('port_scan', e.target.checked)}
                      />
                      Port Scan
                      <input
                        type="text"
                        className="scan-inline-input"
                        value={custom.port_range}
                        onChange={(e) => setCustomField('port_range', e.target.value)}
                        disabled={!custom.port_scan}
                        placeholder={DEFAULT_PORT_RANGE}
                        aria-label="Port range"
                      />
                    </label>
                    <label className="scan-checkbox">
                      <input
                        type="checkbox"
                        checked={custom.os_detection}
                        onChange={(e) => setCustomField('os_detection', e.target.checked)}
                      />
                      OS Detection
                    </label>
                    <label className="scan-checkbox">
                      <input
                        type="checkbox"
                        checked={custom.service_detection}
                        onChange={(e) => setCustomField('service_detection', e.target.checked)}
                      />
                      Service Version Detection
                    </label>
                    <label className="scan-checkbox">
                      <input
                        type="checkbox"
                        checked={custom.snmp}
                        onChange={(e) => setCustomField('snmp', e.target.checked)}
                      />
                      SNMP Walk
                      <input
                        type="text"
                        className="scan-inline-input"
                        value={custom.snmp_community}
                        onChange={(e) => setCustomField('snmp_community', e.target.value)}
                        disabled={!custom.snmp}
                        placeholder="community (server default)"
                        aria-label="SNMP community string"
                      />
                    </label>
                    <label className="scan-checkbox">
                      <input
                        type="checkbox"
                        checked={custom.netbios}
                        onChange={(e) => setCustomField('netbios', e.target.checked)}
                      />
                      NetBIOS/SMB
                    </label>
                    <label className="scan-checkbox">
                      <input
                        type="checkbox"
                        checked={custom.mdns}
                        onChange={(e) => setCustomField('mdns', e.target.checked)}
                      />
                      mDNS/Bonjour
                    </label>
                    <label className="scan-checkbox">
                      <input
                        type="checkbox"
                        checked={custom.mac_vendor}
                        onChange={(e) => setCustomField('mac_vendor', e.target.checked)}
                      />
                      MAC Vendor Lookup
                    </label>
                  </div>
                )}
              </div>
            )}
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
                      ? `Scanned ${progress.current} of ${progress.total} ${
                          activeJob?.target_type === 'multiple' ? 'IPs' : 'hosts'
                        } (${progressPercent}%)`
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
                          checked={sortedRows.length > 0 && selected.size === sortedRows.length}
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
                    {sortedRows.map((row, index) => (
                      <tr key={row?.id ?? `row-${index}`}>
                        <td className="scan-check-col">
                          <input
                            type="checkbox"
                            checked={row?.id != null && selected.has(row.id)}
                            onChange={() => row?.id != null && toggleRow(row.id)}
                          />
                        </td>
                        <td>
                          <span
                            className={`status-dot ${row?.status === 'up' ? 'up' : 'down'}`}
                            title={row?.status || 'unknown'}
                          />
                        </td>
                        <td>{dash(row?.ip)}</td>
                        <td>{dash(row?.hostname)}</td>
                        <td>{dash(row?.mac)}</td>
                        <td>{dash(row?.mac_vendor)}</td>
                        <td>
                          {deviceType(row?.device_type)}
                          {row?.snmp && (
                            <span
                              className="scan-snmp-badge"
                              title={row?.raw?.snmp?.sysDescr || 'SNMP responded during scan'}
                            >
                              SNMP
                            </span>
                          )}
                        </td>
                        <td>{dash(row?.os)}</td>
                        <td>{formatPorts(row?.open_ports)}</td>
                        <td>{dash(row?.netbios_name)}</td>
                        <td>{formatDate(row?.last_seen)}</td>
                      </tr>
                    ))}
                    {sortedRows.length === 0 && (
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
                  <button type="button" onClick={() => setExportOpen((v) => !v)} disabled={sortedRows.length === 0}>
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
      {toast && <div className="scan-toast">{toast}</div>}
    </div>
  );
}
