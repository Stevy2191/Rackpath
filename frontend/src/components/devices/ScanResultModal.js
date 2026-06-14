import React from 'react';
import '../topology/Modal.css';
import './ScanResultModal.css';

export default function ScanResultModal({ device, result, onClose, onUpdateDevice }) {
  const canUpdate = !!(result.sysName || result.sysLocation);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Scan Results: {device.hostname || device.ip || `Device ${device.id}`}</h2>

        <div className="scan-result-summary">
          <div>
            <span className="scan-result-label">Description</span>
            <span>{result.sysDescr || '—'}</span>
          </div>
          <div>
            <span className="scan-result-label">Location</span>
            <span>{result.sysLocation || '—'}</span>
          </div>
          <div>
            <span className="scan-result-label">Contact</span>
            <span>{result.sysContact || '—'}</span>
          </div>
          <div>
            <span className="scan-result-label">Uptime</span>
            <span>{result.uptime || '—'}</span>
          </div>
        </div>

        <h3>Interfaces ({result.interfaceCount})</h3>
        <table className="scan-result-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Speed</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {result.interfaces.map((iface) => (
              <tr key={iface.index}>
                <td>{iface.name}</td>
                <td>{iface.speed || '—'}</td>
                <td>
                  <span className={`scan-status scan-status-${iface.operStatus}`}>{iface.operStatus}</span>
                </td>
              </tr>
            ))}
            {result.interfaces.length === 0 && (
              <tr>
                <td colSpan={3} className="scan-result-empty">
                  No interfaces discovered.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <h3>IP Addresses ({result.ipCount})</h3>
        <table className="scan-result-table">
          <thead>
            <tr>
              <th>Address</th>
              <th>Netmask</th>
              <th>Interface Index</th>
            </tr>
          </thead>
          <tbody>
            {result.ips.map((ip) => (
              <tr key={ip.address}>
                <td>{ip.address}</td>
                <td>{ip.netmask || '—'}</td>
                <td>{ip.ifIndex ?? '—'}</td>
              </tr>
            ))}
            {result.ips.length === 0 && (
              <tr>
                <td colSpan={3} className="scan-result-empty">
                  No IP addresses discovered.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="modal-actions">
          <button type="button" onClick={() => onUpdateDevice(device, result)} disabled={!canUpdate}>
            Update Device
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
