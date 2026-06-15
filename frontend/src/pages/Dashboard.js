import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Server,
  Link2,
  Network,
  Warehouse,
  Percent,
  Camera,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Activity,
} from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import './Dashboard.css';

const SUMMARY_CARDS = [
  { key: 'totalDevices', label: 'Total Devices', icon: Server, color: 'blue' },
  { key: 'totalLinks', label: 'Total Links', icon: Link2, color: 'purple' },
  { key: 'vlanCount', label: 'VLAN Count', icon: Network, color: 'green' },
  { key: 'rackCount', label: 'Rack Count', icon: Warehouse, color: 'orange' },
  { key: 'rackUtilization', label: 'Rack Utilization', icon: Percent, color: 'teal', suffix: '%' },
  { key: 'cameraCount', label: 'Camera Count', icon: Camera, color: 'pink' },
];

const WARNING_DEFS = [
  {
    key: 'devicesNoIp',
    label: 'Devices with no IP assigned',
    render: (item) => item.hostname || `Device ${item.id}`,
  },
  {
    key: 'devicesNoRack',
    label: 'Devices with no rack assignment',
    render: (item) => item.hostname || `Device ${item.id}`,
  },
  {
    key: 'devicesNoCredential',
    label: 'Devices with no credential macro assigned',
    render: (item) => item.hostname || `Device ${item.id}`,
  },
  {
    key: 'vlansNoSubnet',
    label: 'VLANs with no subnet defined',
    render: (item) => `VLAN ${item.vlan_id} (${item.name})`,
  },
  {
    key: 'nodesNoDevice',
    label: 'Topology nodes with no linked device',
    render: (item) => item.label || `Node ${item.id}`,
  },
];

const ACTION_LABELS = {
  'device.created': 'created device',
  'device.updated': 'updated device',
  'device.deleted': 'deleted device',
  'topology.node.created': 'added topology node',
  'topology.node.deleted': 'removed topology node',
  'topology.edge.created': 'added link',
  'topology.edge.deleted': 'removed link',
  'rack.created': 'created rack',
  'rack.deleted': 'deleted rack',
  'rack_slot.assigned': 'placed item in rack',
  'rack_slot.removed': 'removed item from rack',
  'vlan.created': 'created VLAN',
  'vlan.deleted': 'deleted VLAN',
  'camera.created': 'added camera',
  'camera.deleted': 'removed camera',
  'macro.created': 'created credential macro',
  'macro.deleted': 'deleted credential macro',
};

function describeAction(action) {
  return ACTION_LABELS[action] || action;
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function fileBaseName(project) {
  return (project?.name || 'project').trim().replace(/\s+/g, '_').toLowerCase();
}

function buildMarkdown(project, overview, activity) {
  const { summary, warnings, details } = overview;
  const lines = [];

  lines.push(`# ${project?.name || 'Project'} — Site Overview`);
  lines.push('');
  lines.push(`Generated ${new Date().toLocaleString()}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Total Devices | ${summary.totalDevices} |`);
  lines.push(`| Total Links | ${summary.totalLinks} |`);
  lines.push(`| VLAN Count | ${summary.vlanCount} |`);
  lines.push(`| Rack Count | ${summary.rackCount} |`);
  lines.push(`| Rack Utilization | ${summary.rackUtilization}% |`);
  lines.push(`| Camera Count | ${summary.cameraCount} |`);
  lines.push('');

  lines.push('## Devices');
  lines.push('');
  lines.push('| Hostname | IP | Type | Location | Make | Model |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  details.devices.forEach((d) => {
    lines.push(`| ${d.hostname || ''} | ${d.ip || ''} | ${d.type || ''} | ${d.location || ''} | ${d.make || ''} | ${d.model || ''} |`);
  });
  lines.push('');

  lines.push('## Racks');
  lines.push('');
  lines.push('| Name | Location | Used U | Total U |');
  lines.push('| --- | --- | --- | --- |');
  details.racks.forEach((r) => {
    lines.push(`| ${r.name} | ${r.location || ''} | ${r.used_u} | ${r.u_height} |`);
  });
  lines.push('');

  lines.push('## VLANs');
  lines.push('');
  lines.push('| VLAN ID | Name | Subnet | Description |');
  lines.push('| --- | --- | --- | --- |');
  details.vlans.forEach((v) => {
    lines.push(`| ${v.vlan_id} | ${v.name} | ${v.subnet || ''} | ${v.description || ''} |`);
  });
  lines.push('');

  lines.push('## Topology Links');
  lines.push('');
  lines.push('| Source | Target | Label | Speed | Cable Type | VLAN |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  details.links.forEach((l) => {
    lines.push(`| ${l.source_name} | ${l.target_name} | ${l.label || ''} | ${l.speed || ''} | ${l.cable_type || ''} | ${l.vlan || ''} |`);
  });
  lines.push('');

  lines.push('## Warnings');
  lines.push('');
  WARNING_DEFS.forEach((def) => {
    const items = warnings[def.key] || [];
    lines.push(`### ${def.label} (${items.length})`);
    lines.push('');
    if (items.length === 0) {
      lines.push('None');
    } else {
      items.forEach((item) => lines.push(`- ${def.render(item)}`));
    }
    lines.push('');
  });

  lines.push('## Recent Activity');
  lines.push('');
  if (activity.length === 0) {
    lines.push('No activity recorded yet.');
  } else {
    lines.push('| Time | User | Action | Details |');
    lines.push('| --- | --- | --- | --- |');
    activity.forEach((entry) => {
      lines.push(`| ${formatTimestamp(entry.created_at)} | ${entry.username} | ${describeAction(entry.action)} | ${entry.details || ''} |`);
    });
  }
  lines.push('');

  return lines.join('\n');
}

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildPdf(project, overview, activity) {
  const { summary, warnings, details } = overview;
  const doc = new jsPDF();
  const margin = 14;
  let y = 16;

  const ensureSpace = (needed) => {
    if (y + needed > 280) {
      doc.addPage();
      y = 16;
    }
  };

  doc.setFontSize(16);
  doc.text(`${project?.name || 'Project'} — Site Overview`, margin, y);
  y += 6;
  doc.setFontSize(10);
  doc.text(`Generated ${new Date().toLocaleString()}`, margin, y);
  y += 8;

  autoTable(doc, {
    startY: y,
    head: [['Metric', 'Value']],
    body: [
      ['Total Devices', String(summary.totalDevices)],
      ['Total Links', String(summary.totalLinks)],
      ['VLAN Count', String(summary.vlanCount)],
      ['Rack Count', String(summary.rackCount)],
      ['Rack Utilization', `${summary.rackUtilization}%`],
      ['Camera Count', String(summary.cameraCount)],
    ],
  });
  y = doc.lastAutoTable.finalY + 10;

  ensureSpace(14);
  doc.setFontSize(12);
  doc.text('Devices', margin, y);
  y += 4;
  autoTable(doc, {
    startY: y,
    head: [['Hostname', 'IP', 'Type', 'Location', 'Make', 'Model']],
    body: details.devices.map((d) => [d.hostname || '', d.ip || '', d.type || '', d.location || '', d.make || '', d.model || '']),
  });
  y = doc.lastAutoTable.finalY + 10;

  ensureSpace(14);
  doc.setFontSize(12);
  doc.text('Racks', margin, y);
  y += 4;
  autoTable(doc, {
    startY: y,
    head: [['Name', 'Location', 'Used U', 'Total U']],
    body: details.racks.map((r) => [r.name, r.location || '', String(r.used_u), String(r.u_height)]),
  });
  y = doc.lastAutoTable.finalY + 10;

  ensureSpace(14);
  doc.setFontSize(12);
  doc.text('VLANs', margin, y);
  y += 4;
  autoTable(doc, {
    startY: y,
    head: [['VLAN ID', 'Name', 'Subnet', 'Description']],
    body: details.vlans.map((v) => [String(v.vlan_id), v.name, v.subnet || '', v.description || '']),
  });
  y = doc.lastAutoTable.finalY + 10;

  ensureSpace(14);
  doc.setFontSize(12);
  doc.text('Topology Links', margin, y);
  y += 4;
  autoTable(doc, {
    startY: y,
    head: [['Source', 'Target', 'Label', 'Speed', 'Cable Type', 'VLAN']],
    body: details.links.map((l) => [l.source_name, l.target_name, l.label || '', l.speed || '', l.cable_type || '', l.vlan || '']),
  });
  y = doc.lastAutoTable.finalY + 10;

  ensureSpace(14);
  doc.setFontSize(12);
  doc.text('Warnings', margin, y);
  y += 4;
  autoTable(doc, {
    startY: y,
    head: [['Warning', 'Count', 'Affected Items']],
    body: WARNING_DEFS.map((def) => {
      const items = warnings[def.key] || [];
      return [def.label, String(items.length), items.map((item) => def.render(item)).join(', ') || '—'];
    }),
    columnStyles: { 2: { cellWidth: 90 } },
  });
  y = doc.lastAutoTable.finalY + 10;

  ensureSpace(14);
  doc.setFontSize(12);
  doc.text('Recent Activity', margin, y);
  y += 4;
  autoTable(doc, {
    startY: y,
    head: [['Time', 'User', 'Action', 'Details']],
    body: activity.map((entry) => [formatTimestamp(entry.created_at), entry.username, describeAction(entry.action), entry.details || '']),
  });

  return doc;
}

export default function DashboardPage() {
  const { id } = useParams();
  const { currentProjectId, currentProject, switchProject } = useProject();
  const [overview, setOverview] = useState(null);
  const [activity, setActivity] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const projectId = id || currentProjectId;

  // Keep the active-project context (used by the navbar's project switcher
  // and every other page) in sync with the project id in the URL.
  useEffect(() => {
    const numericId = Number(id);
    if (Number.isInteger(numericId) && numericId > 0 && numericId !== currentProjectId) {
      switchProject(numericId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([client.get(`/projects/${projectId}/overview`), client.get(`/projects/${projectId}/activity`)])
      .then(([overviewRes, activityRes]) => {
        if (cancelled) return;
        setOverview(overviewRes.data);
        setActivity(activityRes.data || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const toggleWarning = (key) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const exportMarkdown = () => {
    if (!overview) return;
    const md = buildMarkdown(currentProject, overview, activity);
    downloadBlob(md, 'text/markdown', `${fileBaseName(currentProject)}-overview.md`);
  };

  const exportPdf = () => {
    if (!overview) return;
    const doc = buildPdf(currentProject, overview, activity);
    doc.save(`${fileBaseName(currentProject)}-overview.pdf`);
  };

  if (loading) return <div className="page-status">Loading...</div>;
  if (error) return <div className="page-error">{error}</div>;
  if (!overview) return null;

  const { summary, warnings } = overview;

  return (
    <div className="dashboard-page">
      <div className="dashboard-header">
        <h2>{currentProject?.name || 'Project'} Overview</h2>
        <div className="dashboard-export-actions">
          <button className="dashboard-export-btn" onClick={exportMarkdown}>
            <FileText size={16} />
            Export Markdown
          </button>
          <button className="dashboard-export-btn" onClick={exportPdf}>
            <Download size={16} />
            Export PDF
          </button>
        </div>
      </div>

      <div className="dashboard-cards">
        {SUMMARY_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.key} className={`dashboard-card dashboard-card-${card.color}`}>
              <Icon size={28} className="dashboard-card-icon" />
              <div className="dashboard-card-body">
                <div className="dashboard-card-value">
                  {summary[card.key]}
                  {card.suffix || ''}
                </div>
                <div className="dashboard-card-label">{card.label}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="dashboard-section">
        <h3>Warnings</h3>
        <div className="dashboard-warnings">
          {WARNING_DEFS.map((def) => {
            const items = warnings[def.key] || [];
            const isOpen = !!expanded[def.key] && items.length > 0;
            return (
              <div key={def.key} className="dashboard-warning">
                <button
                  type="button"
                  className="dashboard-warning-header"
                  onClick={() => toggleWarning(def.key)}
                  disabled={items.length === 0}
                >
                  {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <AlertTriangle size={16} className={`dashboard-warning-icon${items.length === 0 ? ' ok' : ''}`} />
                  <span className="dashboard-warning-label">{def.label}</span>
                  <span className={`dashboard-warning-badge${items.length === 0 ? ' zero' : ''}`}>{items.length}</span>
                </button>
                {isOpen && (
                  <ul className="dashboard-warning-list">
                    {items.map((item) => (
                      <li key={item.id}>{def.render(item)}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="dashboard-section">
        <h3>Recent Activity</h3>
        {activity.length === 0 ? (
          <p className="dashboard-empty">No activity recorded yet.</p>
        ) : (
          <ul className="dashboard-activity-list">
            {activity.map((entry) => (
              <li key={entry.id} className="dashboard-activity-item">
                <Activity size={14} className="dashboard-activity-icon" />
                <span className="dashboard-activity-text">
                  <strong>{entry.username}</strong> {describeAction(entry.action)}
                  {entry.details ? <> — {entry.details}</> : null}
                </span>
                <span className="dashboard-activity-time">{formatTimestamp(entry.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
