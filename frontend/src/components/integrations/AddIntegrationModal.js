import React, { useState } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import client from '../../api/client';
import { PLATFORMS, platformInfo } from './platforms';
import '../topology/Modal.css';
import './AddIntegrationModal.css';

function initForm(integration) {
  const config = (() => {
    if (!integration?.config) return {};
    if (typeof integration.config === 'string') {
      try {
        return JSON.parse(integration.config);
      } catch {
        return {};
      }
    }
    return integration.config;
  })();

  return {
    name: integration?.name || '',
    base_url: integration?.base_url || '',
    username: integration?.username || '',
    password: '',
    api_key: '',
    verify_ssl: integration?.verify_ssl != null ? !!integration.verify_ssl : true,
    unifi_auth_method: !integration || integration.has_api_key ? 'api_key' : 'password',
    auto_sync: integration ? !!integration.auto_sync : false,
    sync_interval_minutes: integration?.sync_interval_minutes || 60,
    devices_endpoint: config.devices_endpoint || '',
    vlans_endpoint: config.vlans_endpoint || '',
    snmp_version: config.snmp_version || '2c',
  };
}

function buildPayload(platform, form) {
  const payload = {
    name: form.name.trim(),
    platform,
    base_url: form.base_url.trim(),
    verify_ssl: form.verify_ssl,
    auto_sync: form.auto_sync,
    sync_interval_minutes: Number(form.sync_interval_minutes) || 60,
  };

  if (platform === 'unifi' || platform === 'unifi-protect' || platform === 'unifi-access') {
    if (form.unifi_auth_method === 'password') {
      payload.username = form.username || null;
      if (form.password) payload.password = form.password;
      payload.api_key = null;
    } else {
      if (form.api_key) payload.api_key = form.api_key;
      payload.username = null;
      payload.password = null;
    }
  } else {
    if (platform === 'zabbix') {
      payload.username = form.username || null;
    }
    if (form.password) payload.password = form.password;
    if (form.api_key) payload.api_key = form.api_key;
  }

  if (platform === 'snmp') {
    payload.config = { snmp_version: form.snmp_version };
  }
  if (platform === 'custom') {
    payload.config = { devices_endpoint: form.devices_endpoint || null, vlans_endpoint: form.vlans_endpoint || null };
  }

  return payload;
}

export default function AddIntegrationModal({ integration, projectId, onClose, onSaved }) {
  const [step, setStep] = useState(integration ? 2 : 1);
  const [platform, setPlatform] = useState(integration?.platform || null);
  const [form, setForm] = useState(() => initForm(integration));
  const [integrationId, setIntegrationId] = useState(integration?.id || null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (field) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [field]: value }));
  };

  const persist = async () => {
    const payload = buildPayload(platform, form);
    if (integrationId) {
      const res = await client.put(`/integrations/${integrationId}`, payload);
      return res.data;
    }
    const res = await client.post(`/projects/${projectId}/integrations`, payload);
    setIntegrationId(res.data.id);
    return res.data;
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const saved = await persist();
      const res = await client.post(`/integrations/${saved.id}/test`);
      setTestResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.base_url.trim()) {
      setError('Name and URL are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await persist();
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  if (step === 1) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>Add Integration</h2>
          <div className="integration-platform-grid">
            {PLATFORMS.map((p) => {
              const Icon = p.icon;
              return (
                <button
                  key={p.id}
                  type="button"
                  className="integration-platform-btn"
                  onClick={() => {
                    setPlatform(p.id);
                    if (!integration && (p.id === 'unifi' || p.id === 'unifi-protect' || p.id === 'unifi-access')) {
                      setForm((f) => ({ ...f, verify_ssl: false }));
                    }
                    setStep(2);
                  }}
                >
                  <Icon size={28} />
                  <span>{p.label}</span>
                </button>
              );
            })}
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { label: platformLabel } = platformInfo(platform);
  const passwordPlaceholder = integration?.has_password ? '(unchanged)' : '';
  const apiKeyPlaceholder = integration?.has_api_key ? '(unchanged)' : '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{integration ? `Edit Integration — ${platformLabel}` : `Add Integration — ${platformLabel}`}</h2>
        <form className="modal-form" onSubmit={handleSave}>
          {!integration && (
            <button type="button" className="integration-back-link" onClick={() => setStep(1)}>
              ← Choose a different platform
            </button>
          )}

          <label>
            Name
            <input value={form.name} onChange={set('name')} placeholder="e.g. My UniFi Controller" required />
          </label>

          {platform === 'unifi' && (
            <>
              <label>
                Controller URL
                <input value={form.base_url} onChange={set('base_url')} placeholder="https://192.168.1.1" required />
              </label>

              <div className="integration-radio-group">
                <label className="integration-radio-label">
                  <input
                    type="radio"
                    name="unifi_auth_method"
                    value="api_key"
                    checked={form.unifi_auth_method === 'api_key'}
                    onChange={() => setForm((f) => ({ ...f, unifi_auth_method: 'api_key' }))}
                  />
                  API Key
                </label>
                <label className="integration-radio-label">
                  <input
                    type="radio"
                    name="unifi_auth_method"
                    value="password"
                    checked={form.unifi_auth_method === 'password'}
                    onChange={() => setForm((f) => ({ ...f, unifi_auth_method: 'password' }))}
                  />
                  Username &amp; Password
                </label>
              </div>
              <p className="integration-helper-text">
                API Key is recommended. Generate one in UniFi Console → Settings → Control Plane → API
              </p>

              {form.unifi_auth_method === 'api_key' ? (
                <label>
                  API Key
                  <input type="password" value={form.api_key} onChange={set('api_key')} placeholder={apiKeyPlaceholder} />
                </label>
              ) : (
                <>
                  <label>
                    Username
                    <input value={form.username} onChange={set('username')} />
                  </label>
                  <label>
                    Password
                    <input type="password" value={form.password} onChange={set('password')} placeholder={passwordPlaceholder} />
                  </label>
                </>
              )}

              <label className="integration-checkbox-label">
                <input type="checkbox" checked={form.verify_ssl} onChange={set('verify_ssl')} />
                Verify SSL
              </label>
            </>
          )}

          {platform === 'unifi-protect' && (
            <>
              <label>
                Controller URL
                <input value={form.base_url} onChange={set('base_url')} placeholder="https://192.168.1.1" required />
              </label>

              <div className="integration-radio-group">
                <label className="integration-radio-label">
                  <input
                    type="radio"
                    name="unifi_auth_method"
                    value="api_key"
                    checked={form.unifi_auth_method === 'api_key'}
                    onChange={() => setForm((f) => ({ ...f, unifi_auth_method: 'api_key' }))}
                  />
                  API Key
                </label>
                <label className="integration-radio-label">
                  <input
                    type="radio"
                    name="unifi_auth_method"
                    value="password"
                    checked={form.unifi_auth_method === 'password'}
                    onChange={() => setForm((f) => ({ ...f, unifi_auth_method: 'password' }))}
                  />
                  Username &amp; Password
                </label>
              </div>
              <p className="integration-helper-text">
                API Key is recommended. Generate one in UniFi Console → Settings → Control Plane → API
              </p>

              {form.unifi_auth_method === 'api_key' ? (
                <label>
                  API Key
                  <input type="password" value={form.api_key} onChange={set('api_key')} placeholder={apiKeyPlaceholder} />
                </label>
              ) : (
                <>
                  <label>
                    Username
                    <input value={form.username} onChange={set('username')} />
                  </label>
                  <label>
                    Password
                    <input type="password" value={form.password} onChange={set('password')} placeholder={passwordPlaceholder} />
                  </label>
                </>
              )}

              <label className="integration-checkbox-label">
                <input type="checkbox" checked={form.verify_ssl} onChange={set('verify_ssl')} />
                Verify SSL
              </label>
            </>
          )}

          {platform === 'unifi-access' && (
            <>
              <label>
                Controller URL
                <input value={form.base_url} onChange={set('base_url')} placeholder="https://192.168.1.1" required />
              </label>

              <div className="integration-radio-group">
                <label className="integration-radio-label">
                  <input
                    type="radio"
                    name="unifi_auth_method"
                    value="api_key"
                    checked={form.unifi_auth_method === 'api_key'}
                    onChange={() => setForm((f) => ({ ...f, unifi_auth_method: 'api_key' }))}
                  />
                  API Key
                </label>
                <label className="integration-radio-label">
                  <input
                    type="radio"
                    name="unifi_auth_method"
                    value="password"
                    checked={form.unifi_auth_method === 'password'}
                    onChange={() => setForm((f) => ({ ...f, unifi_auth_method: 'password' }))}
                  />
                  Username &amp; Password
                </label>
              </div>
              <p className="integration-helper-text">
                API Key is recommended. Generate one in UniFi Console → Settings → Control Plane → API
              </p>

              {form.unifi_auth_method === 'api_key' ? (
                <label>
                  API Key
                  <input type="password" value={form.api_key} onChange={set('api_key')} placeholder={apiKeyPlaceholder} />
                </label>
              ) : (
                <>
                  <label>
                    Username
                    <input value={form.username} onChange={set('username')} />
                  </label>
                  <label>
                    Password
                    <input type="password" value={form.password} onChange={set('password')} placeholder={passwordPlaceholder} />
                  </label>
                </>
              )}

              <label className="integration-checkbox-label">
                <input type="checkbox" checked={form.verify_ssl} onChange={set('verify_ssl')} />
                Verify SSL
              </label>
            </>
          )}

          {platform === 'zabbix' && (
            <>
              <label>
                URL
                <input value={form.base_url} onChange={set('base_url')} placeholder="https://zabbix.example.com" required />
              </label>
              <label>
                Username
                <input value={form.username} onChange={set('username')} />
              </label>
              <label>
                Password
                <input type="password" value={form.password} onChange={set('password')} placeholder={passwordPlaceholder} />
              </label>
            </>
          )}

          {platform === 'librenms' && (
            <>
              <label>
                URL
                <input value={form.base_url} onChange={set('base_url')} placeholder="https://librenms.example.com" required />
              </label>
              <label>
                API Token
                <input type="password" value={form.api_key} onChange={set('api_key')} placeholder={apiKeyPlaceholder} />
              </label>
            </>
          )}

          {platform === 'netbox' && (
            <>
              <label>
                URL
                <input value={form.base_url} onChange={set('base_url')} placeholder="https://netbox.example.com" required />
              </label>
              <label>
                API Token
                <input type="password" value={form.api_key} onChange={set('api_key')} placeholder={apiKeyPlaceholder} />
              </label>
            </>
          )}

          {platform === 'snmp' && (
            <>
              <label>
                Device IP
                <input value={form.base_url} onChange={set('base_url')} placeholder="192.168.1.1" required />
              </label>
              <label>
                Community String
                <input type="password" value={form.api_key} onChange={set('api_key')} placeholder={apiKeyPlaceholder} />
              </label>
              <label>
                SNMP Version
                <select value={form.snmp_version} onChange={set('snmp_version')}>
                  <option value="1">v1</option>
                  <option value="2c">v2c</option>
                  <option value="3">v3</option>
                </select>
              </label>
            </>
          )}

          {platform === 'custom' && (
            <>
              <label>
                Base URL
                <input value={form.base_url} onChange={set('base_url')} placeholder="https://api.example.com" required />
              </label>
              <label>
                API Key
                <input type="password" value={form.api_key} onChange={set('api_key')} placeholder={apiKeyPlaceholder} />
              </label>
              <label>
                Devices Endpoint
                <input value={form.devices_endpoint} onChange={set('devices_endpoint')} placeholder="/api/devices" />
              </label>
              <label>
                VLANs Endpoint
                <input value={form.vlans_endpoint} onChange={set('vlans_endpoint')} placeholder="/api/vlans" />
              </label>
            </>
          )}

          <label className="integration-checkbox-label">
            <input type="checkbox" checked={form.auto_sync} onChange={set('auto_sync')} />
            Auto-sync
          </label>
          {form.auto_sync && (
            <label>
              Sync Interval (minutes)
              <input type="number" min="1" value={form.sync_interval_minutes} onChange={set('sync_interval_minutes')} />
            </label>
          )}

          {error && <div className="integration-form-error">{error}</div>}

          <div className="integration-test-row">
            <button type="button" onClick={handleTest} disabled={testing}>
              {testing ? <Loader2 size={14} className="integration-spin" /> : null}
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            {testResult &&
              (testResult.success ? (
                <span className="integration-test-ok">
                  <CheckCircle2 size={16} /> Connected
                </span>
              ) : (
                <span className="integration-test-fail">
                  <XCircle size={16} /> {testResult.message || 'Connection failed'}
                </span>
              ))}
          </div>

          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
