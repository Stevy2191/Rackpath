import React, { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import AddIntegrationModal from '../components/integrations/AddIntegrationModal';
import { platformInfo } from '../components/integrations/platforms';
import './Integrations.css';

const STATUS_LABELS = {
  unconfigured: 'Unconfigured',
  connected: 'Connected',
  error: 'Error',
};

function formatLastSynced(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString();
}

export default function IntegrationsPage() {
  const { currentProjectId } = useProject();
  const [integrations, setIntegrations] = useState([]);
  const [error, setError] = useState(null);
  const [modalState, setModalState] = useState(null); // null | 'new' | integration object
  const [syncingId, setSyncingId] = useState(null);
  const [toast, setToast] = useState(null);

  const load = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/integrations`)
      .then((res) => setIntegrations(res.data || []))
      .catch((err) => setError(err.response?.data?.error || err.message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  const showToast = (toastInfo) => {
    setToast(toastInfo);
    setTimeout(() => setToast(null), 6000);
  };

  const handleSync = async (integration) => {
    setSyncingId(integration.id);
    try {
      const res = await client.post(`/integrations/${integration.id}/sync`);
      const { devices_imported, vlans_imported, status, message } = res.data;
      if (status === 'failed') {
        showToast({ type: 'error', text: message || 'Sync failed' });
      } else {
        const deviceText = `${devices_imported} device${devices_imported === 1 ? '' : 's'} imported`;
        const vlanText = `${vlans_imported} VLAN${vlans_imported === 1 ? '' : 's'} imported`;
        showToast({ type: 'success', text: `Sync complete — ${deviceText}, ${vlanText}` });
      }
      load();
    } catch (err) {
      showToast({ type: 'error', text: err.response?.data?.error || err.message });
    } finally {
      setSyncingId(null);
    }
  };

  const handleDelete = async (integration) => {
    if (!window.confirm(`Delete integration "${integration.name}"?`)) return;
    try {
      await client.delete(`/integrations/${integration.id}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  return (
    <div className="integrations-page">
      <div className="integrations-header">
        <h2>Integrations</h2>
        <button className="integrations-add-btn" onClick={() => setModalState('new')}>
          + Add Integration
        </button>
      </div>

      {error && <div className="page-error">{error}</div>}

      {integrations.length === 0 ? (
        <div className="page-status">No integrations configured yet.</div>
      ) : (
        <div className="integrations-grid">
          {integrations.map((integ) => {
            const { icon: Icon, label } = platformInfo(integ.platform);
            const isProtectOnlyWarning =
              integ.status === 'error' && (integ.status_message || '').includes('Protect-only device');
            return (
              <div key={integ.id} className="integration-card">
                <div className="integration-card-header">
                  <span className="integration-card-icon">
                    <Icon size={22} />
                  </span>
                  <span className="integration-card-name">{integ.name}</span>
                  {isProtectOnlyWarning ? (
                    <span className="integration-status-badge status-warning">
                      <AlertTriangle size={12} /> Protect-only device
                    </span>
                  ) : (
                    <span className={`integration-status-badge status-${integ.status}`}>
                      {STATUS_LABELS[integ.status] || integ.status}
                    </span>
                  )}
                </div>
                <div className="integration-card-meta">
                  <span>{label}</span>
                  <span>Last synced: {formatLastSynced(integ.last_synced_at)}</span>
                </div>
                {integ.status === 'error' && integ.status_message && (
                  <div className={isProtectOnlyWarning ? 'integration-card-warning' : 'integration-card-error'}>
                    {integ.status_message}
                  </div>
                )}
                <div className="integration-card-actions">
                  <button
                    className="integration-sync-btn"
                    onClick={() => handleSync(integ)}
                    disabled={syncingId === integ.id}
                  >
                    {syncingId === integ.id ? (
                      <Loader2 size={14} className="integration-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    Sync Now
                  </button>
                  <button
                    className="integration-icon-btn"
                    onClick={() => setModalState(integ)}
                    aria-label="Edit integration"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="integration-icon-btn integration-icon-btn-danger"
                    onClick={() => handleDelete(integ)}
                    aria-label="Delete integration"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalState && (
        <AddIntegrationModal
          integration={modalState === 'new' ? null : modalState}
          projectId={currentProjectId}
          onClose={() => setModalState(null)}
          onSaved={() => {
            setModalState(null);
            load();
          }}
        />
      )}

      {toast && <div className={`integrations-toast integrations-toast-${toast.type}`}>{toast.text}</div>}
    </div>
  );
}
