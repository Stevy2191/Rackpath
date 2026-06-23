import React, { useMemo, useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import client from '../../api/client';
import './CopySettingsModal.css';

function deviceLabel(s) {
  return s.item_label || s.custom_type || `Device ${s.id}`;
}

export default function CopySettingsModal({ slot, fields, targets, racks, onUpdated, onClose }) {
  const [selected, setSelected] = useState(new Set(targets.map((t) => t.id)));
  const [copying, setCopying] = useState(false);
  const [copyCount, setCopyCount] = useState(null);
  const [error, setError] = useState(null);

  // Group targets by rack; source rack first, then alphabetical by name.
  const groups = useMemo(() => {
    const rackMap = new Map((racks || []).map((r) => [r.id, r]));
    const byRack = new Map();
    for (const t of targets) {
      if (!byRack.has(t.rack_id)) byRack.set(t.rack_id, []);
      byRack.get(t.rack_id).push(t);
    }
    const result = [];
    for (const [rackId, devices] of byRack) {
      const rack = rackMap.get(rackId) || { id: rackId, name: `Rack ${rackId}` };
      result.push({ rack, devices });
    }
    result.sort((a, b) => {
      if (a.rack.id === slot.rack_id) return -1;
      if (b.rack.id === slot.rack_id) return 1;
      return (a.rack.name || '').localeCompare(b.rack.name || '');
    });
    return result;
  }, [targets, racks, slot.rack_id]);

  const allIds = targets.map((t) => t.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allIds));
  };

  const toggleGroup = (devices) => {
    const ids = devices.map((d) => d.id);
    const groupAll = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (groupAll) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopy = async () => {
    if (selected.size === 0 || copying) return;
    setCopying(true);
    setError(null);

    const val = (v) => (v !== '' && v != null ? v : null);

    const payload = {
      color:             fields.color,
      mounted_face:      fields.mounted_face,
      half_depth:        fields.half_depth ? 1 : 0,
      slot_notes:        fields.slot_notes || null,
      ip_address:        fields.ip_address || null,
      serial_number:     fields.serial_number || null,
      asset_tag:         fields.asset_tag || null,
      outlet_groups:     fields.outlet_groups,
      input_voltage:     fields.input_voltage || null,
      input_plug_type:   fields.input_plug_type || null,
      capacity_va:       val(fields.capacity_va),
      capacity_w:        val(fields.capacity_w),
      capacity_value:    val(fields.capacity_value),
      capacity_unit:     fields.capacity_unit || null,
      port_count:        val(fields.port_count),
      bay_count:         val(fields.bay_count),
      device_type:       fields.device_type || null,
      ups_va_rating:     val(fields.ups_va_rating),
      ups_watt_rating:   val(fields.ups_watt_rating),
      ups_runtime_full:  val(fields.ups_runtime_full),
      ups_runtime_half:  val(fields.ups_runtime_half),
      ups_max_ebm_slots: val(fields.ups_max_ebm_slots),
      ebm_runtime_full:  val(fields.ebm_runtime_full),
      ebm_runtime_half:  val(fields.ebm_runtime_half),
    };

    try {
      const selectedTargets = targets.filter((t) => selected.has(t.id));
      for (const target of selectedTargets) {
        const res = await client.patch(`/rack-slots/${target.id}`, payload);
        onUpdated(res.data);
      }
      setCopyCount(selectedTargets.length);
      setTimeout(() => onClose(), 1400);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to copy settings.');
    } finally {
      setCopying(false);
    }
  };

  const rackCount = groups.length;
  const deviceCount = targets.length;

  return (
    <div
      className="copy-settings-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="copy-settings-modal">
        <div className="copy-settings-header">
          <span className="copy-settings-title">Copy Settings To…</span>
          <button type="button" className="copy-settings-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {copyCount != null ? (
          <div className="copy-settings-success">
            <Check size={18} />
            <span>Settings copied to {copyCount} device{copyCount !== 1 ? 's' : ''}</span>
          </div>
        ) : (
          <>
            <div className="copy-settings-source">
              From: <strong>{deviceLabel(slot)}</strong>
            </div>
            <div className="copy-settings-desc">
              Copies power, outlet, and device settings. Label and rack position are preserved on each target device.
            </div>

            <div className="copy-settings-list-hdr">
              <span>
                {deviceCount} device{deviceCount !== 1 ? 's' : ''} across{' '}
                {rackCount} rack{rackCount !== 1 ? 's' : ''}
              </span>
              <button type="button" className="copy-settings-toggle-all" onClick={toggleAll}>
                {allSelected ? 'Deselect All' : 'Select All'}
              </button>
            </div>

            <div className="copy-settings-list">
              {groups.map(({ rack, devices }) => {
                const groupIds = devices.map((d) => d.id);
                const groupAllSelected = groupIds.every((id) => selected.has(id));
                const groupSomeSelected = !groupAllSelected && groupIds.some((id) => selected.has(id));
                return (
                  <div key={rack.id} className="copy-settings-group">
                    <div className="copy-settings-group-hdr">
                      <span className="copy-settings-group-name">
                        {rack.name || `Rack ${rack.id}`}
                        {rack.id === slot.rack_id && (
                          <span className="copy-settings-group-badge">current</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="copy-settings-toggle-all"
                        onClick={() => toggleGroup(devices)}
                      >
                        {groupAllSelected ? 'Deselect' : groupSomeSelected ? 'Select All' : 'Select All'}
                      </button>
                    </div>
                    {devices.map((t) => (
                      <label key={t.id} className="copy-settings-item">
                        <input
                          type="checkbox"
                          checked={selected.has(t.id)}
                          onChange={() => toggle(t.id)}
                        />
                        <span className="copy-settings-item-name">{deviceLabel(t)}</span>
                        {t.u_position != null && (
                          <span className="copy-settings-item-pos">U{t.u_position}</span>
                        )}
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>

            {error && <div className="copy-settings-error">{error}</div>}

            <div className="copy-settings-footer">
              <button type="button" className="copy-settings-cancel" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="copy-settings-confirm"
                onClick={handleCopy}
                disabled={selected.size === 0 || copying}
              >
                <Copy size={11} />
                {copying ? 'Copying…' : `Copy to ${selected.size} device${selected.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
