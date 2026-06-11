import React from 'react';
import { useNavigate } from 'react-router-dom';
import { DEVICE_TYPES, classifyDevice, isCustomType, customIconFilename, customIconUrl } from './deviceTypes';
import './QuickInfoPanel.css';

export default function QuickInfoPanel({ node, onClose, onRemove }) {
  const navigate = useNavigate();

  if (!node) return null;

  const { data } = node;
  const info = DEVICE_TYPES[classifyDevice(data.type)];

  return (
    <aside className="quick-info-panel">
      <button className="quick-info-close" onClick={onClose} aria-label="Close">
        &times;
      </button>

      <div className="quick-info-header">
        <span className="quick-info-icon" style={{ color: info.color }}>
          {isCustomType(data.type) ? (
            <img className="quick-info-custom-icon" src={customIconUrl(customIconFilename(data.type))} alt="" />
          ) : (
            info.icon
          )}
        </span>
        <div>
          <h3>{data.hostname || data.ip || `Device ${data.id}`}</h3>
          <span className="quick-info-type">{info.label}</span>
        </div>
      </div>

      <dl>
        <dt>IP Address</dt>
        <dd>{data.ip || '-'}</dd>

        <dt>MAC Address</dt>
        <dd>{data.mac || '-'}</dd>

        <dt>Device Type</dt>
        <dd>{data.type || '-'}</dd>

        <dt>SNMP Community</dt>
        <dd>{data.snmp_community ? '•'.repeat(Math.min(data.snmp_community.length, 12)) : '-'}</dd>

        {data.updated_at && (
          <>
            <dt>Last Seen</dt>
            <dd>{new Date(data.updated_at).toLocaleString()}</dd>
          </>
        )}
      </dl>

      <div className="quick-info-actions">
        <button className="quick-info-remove" onClick={onRemove}>
          Remove from Canvas
        </button>
        <button className="quick-info-open" onClick={() => navigate(`/devices/${data.id}`)}>
          Open Device Page
        </button>
      </div>
    </aside>
  );
}
