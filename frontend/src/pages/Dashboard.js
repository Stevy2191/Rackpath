import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
  Building2,
  MapPin,
  Pencil,
  X,
  Check,
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
  const { currentProjectId, currentProject, updateProject, switchProject, removeProject } = useProject();
  const navigate = useNavigate();
  const [overview, setOverview] = useState(null);
  const [activity, setActivity] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editingSiteInfo, setEditingSiteInfo] = useState(false);
  const [siteInfoDraft, setSiteInfoDraft] = useState({});
  const [siteInfoSaving, setSiteInfoSaving] = useState(false);

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
        if (cancelled) return;
        if (err.response?.status === 404) {
          // Project doesn't exist in the DB — remove it from the switcher
          // and send the user to the project selector.
          removeProject(Number(projectId));
          navigate('/projects', { replace: true });
          return;
        }
        setError(err.response?.data?.error || err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, navigate, removeProject]);

  const toggleWarning = (key) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const startEditSiteInfo = () => {
    setSiteInfoDraft({
      address:                   currentProject?.address                    || '',
      site_contact_name:         currentProject?.site_contact_name          || '',
      site_contact_phone:        currentProject?.site_contact_phone         || '',
      site_contact_email:        currentProject?.site_contact_email         || '',
      primary_isp_name:          currentProject?.primary_isp_name           || '',
      primary_isp_circuit_id:    currentProject?.primary_isp_circuit_id     || '',
      primary_isp_contact:       currentProject?.primary_isp_contact        || '',
      secondary_isp_name:        currentProject?.secondary_isp_name         || '',
      secondary_isp_circuit_id:  currentProject?.secondary_isp_circuit_id   || '',
      secondary_isp_contact:     currentProject?.secondary_isp_contact      || '',
      wan_ip:                    currentProject?.wan_ip                     || '',
      wan_subnet:                currentProject?.wan_subnet                  || '',
      wan_gateway:               currentProject?.wan_gateway                 || '',
      dns_servers:               currentProject?.dns_servers                 || '',
    });
    setEditingSiteInfo(true);
  };

  const saveSiteInfo = async () => {
    setSiteInfoSaving(true);
    try {
      await updateProject(currentProjectId, siteInfoDraft);
      setEditingSiteInfo(false);
    } finally {
      setSiteInfoSaving(false);
    }
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
        <div className="dashboard-section-header">
          <h3>Site Info</h3>
          {!editingSiteInfo && (
            <button type="button" className="dashboard-section-edit-btn" onClick={startEditSiteInfo}>
              <Pencil size={13} /> Edit
            </button>
          )}
        </div>
        {editingSiteInfo ? (
          <div className="dashboard-site-info-form">
            <div className="dashboard-site-info-group">
              <div className="dashboard-site-info-group-title">Address</div>
              <textarea
                className="dashboard-site-info-textarea"
                value={siteInfoDraft.address}
                onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, address: e.target.value })}
                placeholder="Street address, city, state, zip"
                rows={2}
              />
            </div>
            <div className="dashboard-site-info-group">
              <div className="dashboard-site-info-group-title">Site Contact</div>
              <div className="dashboard-site-info-fields">
                <label>Name<input value={siteInfoDraft.site_contact_name} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, site_contact_name: e.target.value })} placeholder="Full name" /></label>
                <label>Phone<input value={siteInfoDraft.site_contact_phone} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, site_contact_phone: e.target.value })} placeholder="Phone number" /></label>
                <label>Email<input value={siteInfoDraft.site_contact_email} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, site_contact_email: e.target.value })} placeholder="Email address" /></label>
              </div>
            </div>
            <div className="dashboard-site-info-group">
              <div className="dashboard-site-info-group-title">Primary ISP</div>
              <div className="dashboard-site-info-fields">
                <label>Name<input value={siteInfoDraft.primary_isp_name} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, primary_isp_name: e.target.value })} placeholder="ISP name" /></label>
                <label>Circuit ID<input value={siteInfoDraft.primary_isp_circuit_id} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, primary_isp_circuit_id: e.target.value })} placeholder="Circuit ID" /></label>
                <label>Contact<input value={siteInfoDraft.primary_isp_contact} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, primary_isp_contact: e.target.value })} placeholder="ISP contact" /></label>
              </div>
            </div>
            <div className="dashboard-site-info-group">
              <div className="dashboard-site-info-group-title">Secondary ISP</div>
              <div className="dashboard-site-info-fields">
                <label>Name<input value={siteInfoDraft.secondary_isp_name} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, secondary_isp_name: e.target.value })} placeholder="ISP name" /></label>
                <label>Circuit ID<input value={siteInfoDraft.secondary_isp_circuit_id} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, secondary_isp_circuit_id: e.target.value })} placeholder="Circuit ID" /></label>
                <label>Contact<input value={siteInfoDraft.secondary_isp_contact} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, secondary_isp_contact: e.target.value })} placeholder="ISP contact" /></label>
              </div>
            </div>
            <div className="dashboard-site-info-group">
              <div className="dashboard-site-info-group-title">Network</div>
              <div className="dashboard-site-info-fields">
                <label>WAN IP<input value={siteInfoDraft.wan_ip} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, wan_ip: e.target.value })} placeholder="x.x.x.x" /></label>
                <label>Subnet<input value={siteInfoDraft.wan_subnet} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, wan_subnet: e.target.value })} placeholder="/24" /></label>
                <label>Gateway<input value={siteInfoDraft.wan_gateway} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, wan_gateway: e.target.value })} placeholder="x.x.x.1" /></label>
                <label>DNS Servers<input value={siteInfoDraft.dns_servers} onChange={(e) => setSiteInfoDraft({ ...siteInfoDraft, dns_servers: e.target.value })} placeholder="8.8.8.8, 8.8.4.4" /></label>
              </div>
            </div>
            <div className="dashboard-site-info-actions">
              <button type="button" className="dashboard-site-info-cancel" onClick={() => setEditingSiteInfo(false)}>
                <X size={13} /> Cancel
              </button>
              <button type="button" className="dashboard-site-info-save" onClick={saveSiteInfo} disabled={siteInfoSaving}>
                <Check size={13} /> {siteInfoSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div className="dashboard-site-info-view">
            {currentProject?.address && (
              <div className="dashboard-site-info-item">
                <MapPin size={14} />
                <span>{currentProject.address}</span>
              </div>
            )}
            {currentProject?.site_contact_name && (
              <div className="dashboard-site-info-item">
                <span className="dashboard-site-info-label">Contact:</span>
                <span>{currentProject.site_contact_name}{currentProject.site_contact_phone ? ` — ${currentProject.site_contact_phone}` : ''}{currentProject.site_contact_email ? ` — ${currentProject.site_contact_email}` : ''}</span>
              </div>
            )}
            {currentProject?.primary_isp_name && (
              <div className="dashboard-site-info-item">
                <span className="dashboard-site-info-label">Primary ISP:</span>
                <span>{currentProject.primary_isp_name}{currentProject.primary_isp_circuit_id ? ` — ${currentProject.primary_isp_circuit_id}` : ''}</span>
              </div>
            )}
            {currentProject?.secondary_isp_name && (
              <div className="dashboard-site-info-item">
                <span className="dashboard-site-info-label">Secondary ISP:</span>
                <span>{currentProject.secondary_isp_name}{currentProject.secondary_isp_circuit_id ? ` — ${currentProject.secondary_isp_circuit_id}` : ''}</span>
              </div>
            )}
            {(currentProject?.wan_ip || currentProject?.wan_subnet || currentProject?.wan_gateway) && (
              <div className="dashboard-site-info-item">
                <span className="dashboard-site-info-label">WAN:</span>
                <span>{[currentProject.wan_ip, currentProject.wan_subnet, currentProject.wan_gateway].filter(Boolean).join(' / ')}</span>
              </div>
            )}
            {currentProject?.dns_servers && (
              <div className="dashboard-site-info-item">
                <span className="dashboard-site-info-label">DNS:</span>
                <span>{currentProject.dns_servers}</span>
              </div>
            )}
            {!currentProject?.address && !currentProject?.site_contact_name && !currentProject?.primary_isp_name && (
              <p className="dashboard-empty">No site info recorded. Click Edit to add details.</p>
            )}
          </div>
        )}
      </div>

      {overview.details.locations?.length > 0 && (
        <div className="dashboard-section">
          <h3>Locations</h3>
          <div className="dashboard-locations-grid">
            {overview.details.locations.map((loc) => (
              <div key={loc.id} className="dashboard-location-card">
                <Building2 size={16} className="dashboard-location-icon" />
                <div className="dashboard-location-body">
                  <div className="dashboard-location-name">{loc.name}</div>
                  {loc.building_number && (
                    <div className="dashboard-location-sub">Building {loc.building_number}</div>
                  )}
                  <div className="dashboard-location-counts">
                    <span>{loc.room_count} room{loc.room_count !== 1 ? 's' : ''}</span>
                    <span>{loc.rack_count} rack{loc.rack_count !== 1 ? 's' : ''}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
