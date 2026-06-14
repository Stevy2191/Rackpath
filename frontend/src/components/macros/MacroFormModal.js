import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import '../topology/Modal.css';
import './MacroFormModal.css';

export const MACRO_TYPES = [
  { value: 'snmp_v1', label: 'SNMP v1' },
  { value: 'snmp_v2c', label: 'SNMP v2c' },
  { value: 'snmp_v3', label: 'SNMP v3' },
  { value: 'ssh', label: 'SSH' },
  { value: 'telnet', label: 'Telnet' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
];

export const MACRO_TYPE_LABELS = MACRO_TYPES.reduce((acc, t) => {
  acc[t.value] = t.label;
  return acc;
}, {});

const DEFAULT_PORTS = {
  snmp_v1: 161,
  snmp_v2c: 161,
  snmp_v3: 161,
  ssh: 22,
  telnet: 23,
  http: 80,
  https: 443,
};

export const emptyMacro = {
  name: '',
  type: 'snmp_v2c',
  community_string: '',
  username: '',
  password: '',
  auth_protocol: 'SHA',
  auth_password: '',
  priv_protocol: 'AES',
  priv_password: '',
  port: 161,
  notes: '',
};

function PasswordField({ label, value, onChange, placeholder }) {
  const [visible, setVisible] = useState(false);
  return (
    <label>
      {label}
      <div className="macro-password-field">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          autoComplete="off"
        />
        <button
          type="button"
          className="macro-password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide' : 'Show'}
          title={visible ? 'Hide' : 'Show'}
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </label>
  );
}

export default function MacroFormModal({ initial, onSave, onClose }) {
  const [draft, setDraft] = useState(initial || emptyMacro);
  const [error, setError] = useState(null);

  const handleTypeChange = (type) => {
    setDraft((prev) => ({ ...prev, type, port: DEFAULT_PORTS[type] }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!draft.name.trim()) {
      setError('Name is required');
      return;
    }
    try {
      await onSave(draft);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const isSnmpV1V2 = draft.type === 'snmp_v1' || draft.type === 'snmp_v2c';
  const isSnmpV3 = draft.type === 'snmp_v3';
  const isCredsType = ['ssh', 'telnet', 'http', 'https'].includes(draft.type);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit Macro' : 'Add Macro'}</h2>

        {error && <div className="integration-form-error">{error}</div>}

        <form onSubmit={handleSubmit} className="modal-form">
          <label>
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Default SNMP v2"
              autoFocus
              required
            />
          </label>

          <label>
            Type
            <select value={draft.type} onChange={(e) => handleTypeChange(e.target.value)}>
              {MACRO_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          {isSnmpV1V2 && (
            <PasswordField
              label="Community String"
              value={draft.community_string || ''}
              onChange={(e) => setDraft({ ...draft, community_string: e.target.value })}
              placeholder="public"
            />
          )}

          {(isSnmpV3 || isCredsType) && (
            <label>
              Username
              <input
                value={draft.username || ''}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              />
            </label>
          )}

          {isCredsType && (
            <PasswordField
              label="Password"
              value={draft.password || ''}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
          )}

          {isSnmpV3 && (
            <>
              <label>
                Auth Protocol
                <select
                  value={draft.auth_protocol || 'SHA'}
                  onChange={(e) => setDraft({ ...draft, auth_protocol: e.target.value })}
                >
                  <option value="MD5">MD5</option>
                  <option value="SHA">SHA</option>
                </select>
              </label>
              <PasswordField
                label="Auth Password"
                value={draft.auth_password || ''}
                onChange={(e) => setDraft({ ...draft, auth_password: e.target.value })}
              />
              <label>
                Priv Protocol
                <select
                  value={draft.priv_protocol || 'AES'}
                  onChange={(e) => setDraft({ ...draft, priv_protocol: e.target.value })}
                >
                  <option value="DES">DES</option>
                  <option value="AES">AES</option>
                </select>
              </label>
              <PasswordField
                label="Priv Password"
                value={draft.priv_password || ''}
                onChange={(e) => setDraft({ ...draft, priv_password: e.target.value })}
              />
            </>
          )}

          <label>
            Port
            <input
              type="number"
              min="1"
              max="65535"
              value={draft.port ?? ''}
              onChange={(e) => setDraft({ ...draft, port: e.target.value === '' ? '' : Number(e.target.value) })}
            />
          </label>

          <label>
            Notes
            <input value={draft.notes || ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </label>

          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}
