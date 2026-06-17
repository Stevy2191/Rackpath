import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronUp, ChevronDown, Upload } from 'lucide-react';
import client from '../../api/client';
import './DevicePropertiesPanel.css';

const FACE_OPTIONS = [
  { value: 'front', label: 'Front' },
  { value: 'rear',  label: 'Rear' },
  { value: 'both',  label: 'Both' },
];

const COLOR_SWATCHES = [
  '#4adede', '#34d976', '#f59e0b', '#ef4444',
  '#a78bfa', '#fb923c', '#38bdf8', '#f472b6',
  null, // null = clear
];

export default function DevicePropertiesPanel({ slot, rackHeight, rackSlots, onClose, onUpdated }) {
  const [fields, setFields] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const frontFileRef = useRef(null);
  const rearFileRef = useRef(null);
  const saveTimer = useRef(null);

  // Reset form when slot changes
  useEffect(() => {
    if (!slot) { setFields(null); return; }
    setFields({
      item_label:    slot.item_label    || '',
      u_size:        slot.u_size        || 1,
      u_position:    slot.u_position    || 1,
      color:         slot.color         || null,
      mounted_face:  slot.mounted_face  || 'front',
      ip_address:    slot.ip_address    || '',
      slot_notes:    slot.slot_notes    || '',
      asset_tag:     slot.asset_tag     || '',
      serial_number: slot.serial_number || '',
    });
    setError(null);
  }, [slot]);

  if (!slot || !fields) return null;

  const patch = async (changes) => {
    setSaving(true);
    try {
      const updated = await client.patch(`/rack-slots/${slot.id}`, changes);
      onUpdated(updated.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  // Debounce text field saves by 600ms
  const debouncePatch = (changes) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => patch(changes), 600);
  };

  const setField = (key, val) => {
    setFields((f) => ({ ...f, [key]: val }));
    debouncePatch({ [key]: val });
  };

  const adjustUSize = (delta) => {
    const curSize = fields.u_size;
    const newSize = curSize + delta;
    if (newSize < 1) return;

    const curBottom = fields.u_position;        // lowest U number occupied
    const curTop    = curBottom + curSize - 1;  // highest U number occupied

    if (delta < 0) {
      // Shrink: keep the top (highest U) fixed, raise the bottom
      const newBottom = curTop - newSize + 1;
      if (newBottom < 1) return;
      setFields((f) => ({ ...f, u_size: newSize, u_position: newBottom }));
      patch({ u_size: newSize, u_position: newBottom });
      return;
    }

    // Expanding: build the set of U positions occupied by other slots on the same face
    const myFace = slot.mounted_face
      || ((slot.front_back === 'back' || slot.side === 'back') ? 'rear' : slot.side === 'both' ? 'both' : 'front');

    const occupied = new Set();
    for (const s of (rackSlots || [])) {
      if (s.id === slot.id) continue;
      const sFace = s.mounted_face
        || ((s.front_back === 'back' || s.side === 'back') ? 'rear' : s.side === 'both' ? 'both' : 'front');
      // Skip slots on a non-overlapping face
      if (myFace !== 'both' && sFace !== 'both' && myFace !== sFace) continue;
      const sTop = s.u_position + s.u_size - 1;
      for (let u = s.u_position; u <= sTop; u++) occupied.add(u);
    }

    // Count contiguous free space above (higher U numbers = visually higher in rack)
    let spaceAbove = 0;
    for (let u = curTop + 1; u <= rackHeight; u++) {
      if (occupied.has(u)) break;
      spaceAbove++;
    }

    // Count contiguous free space below (lower U numbers = visually lower in rack)
    let spaceBelow = 0;
    for (let u = curBottom - 1; u >= 1; u--) {
      if (occupied.has(u)) break;
      spaceBelow++;
    }

    if (spaceAbove >= delta) {
      // Expand upward: bottom stays, top rises
      setFields((f) => ({ ...f, u_size: newSize }));
      patch({ u_size: newSize });
    } else if (spaceBelow >= delta) {
      // Expand downward: top stays, bottom drops
      const newBottom = curBottom - delta;
      setFields((f) => ({ ...f, u_size: newSize, u_position: newBottom }));
      patch({ u_size: newSize, u_position: newBottom });
    } else if (spaceAbove + spaceBelow >= delta) {
      // Use all space above, take the remainder from below
      const fromBelow = delta - spaceAbove;
      const newBottom = curBottom - fromBelow;
      setFields((f) => ({ ...f, u_size: newSize, u_position: newBottom }));
      patch({ u_size: newSize, u_position: newBottom });
    } else {
      setError('Not enough adjacent space to resize — free up nearby slots first');
    }
  };

  const adjustPosition = (delta) => {
    const next = Math.max(1, Math.min(fields.u_position + delta, rackHeight - fields.u_size + 1));
    if (next === fields.u_position) return;
    setFields((f) => ({ ...f, u_position: next }));
    patch({ u_position: next });
  };

  const uploadImage = async (face, file) => {
    const formData = new FormData();
    formData.append('image', file);
    formData.append('face', face);
    setSaving(true);
    try {
      await client.post(`/rack-slots/${slot.id}/images`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      // Refresh the slot so the image shows in the faceplate
      const updated = await client.get('/rack-slots', { params: { rack_id: slot.rack_id } });
      const updatedSlot = updated.data.find((s) => s.id === slot.id);
      if (updatedSlot) onUpdated(updatedSlot);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const label = slot.item_type === 'device'
    ? (slot.hostname || slot.ip || `Device ${slot.device_id}`)
    : (slot.item_label || slot.custom_type || 'Device');

  return (
    <div className="props-panel">
      <div className="props-panel-header">
        <span className="props-panel-title" title={label}>{label}</span>
        <button type="button" className="props-panel-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {saving && <div className="props-panel-saving">Saving…</div>}
      {error && <div className="props-panel-error" onClick={() => setError(null)}>{error}</div>}

      <div className="props-panel-body">
        {/* Label */}
        <div className="props-field">
          <label className="props-field-label">Label</label>
          <input
            className="props-input"
            value={fields.item_label}
            onChange={(e) => setField('item_label', e.target.value)}
            placeholder="Device name..."
          />
        </div>

        {/* U Height */}
        <div className="props-field">
          <label className="props-field-label">Height (U)</label>
          <div className="props-stepper">
            <button type="button" onClick={() => adjustUSize(-1)} disabled={fields.u_size <= 1}>
              <ChevronDown size={13} />
            </button>
            <span className="props-stepper-val">{fields.u_size}U</span>
            <button type="button" onClick={() => adjustUSize(1)}>
              <ChevronUp size={13} />
            </button>
          </div>
        </div>

        {/* Position */}
        <div className="props-field">
          <label className="props-field-label">Position</label>
          <div className="props-stepper">
            <button type="button" onClick={() => adjustPosition(-1)} disabled={fields.u_position <= 1}>
              <ChevronUp size={13} />
            </button>
            <span className="props-stepper-val">U{fields.u_position}</span>
            <button type="button" onClick={() => adjustPosition(1)}>
              <ChevronDown size={13} />
            </button>
          </div>
        </div>

        {/* Color */}
        <div className="props-field">
          <label className="props-field-label">Color</label>
          <div className="props-swatches">
            {COLOR_SWATCHES.map((c, i) => (
              <button
                key={i}
                type="button"
                className={`props-swatch${fields.color === c ? ' active' : ''}`}
                style={c ? { background: c } : {}}
                title={c || 'None'}
                onClick={() => {
                  setFields((f) => ({ ...f, color: c }));
                  patch({ color: c });
                }}
              >
                {!c && '✕'}
              </button>
            ))}
          </div>
        </div>

        {/* Mounted face */}
        <div className="props-field">
          <label className="props-field-label">Mounted Face</label>
          <div className="props-face-btns">
            {FACE_OPTIONS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={`props-face-btn${fields.mounted_face === f.value ? ' active' : ''}`}
                onClick={() => {
                  setFields((prev) => ({ ...prev, mounted_face: f.value }));
                  patch({ mounted_face: f.value });
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Front image */}
        <div className="props-field">
          <label className="props-field-label">Front Image</label>
          <div className="props-image-row">
            {slot.front_image_url && (
              <img src={slot.front_image_url} alt="Front" className="props-image-thumb" />
            )}
            <button
              type="button"
              className="props-upload-btn"
              onClick={() => frontFileRef.current?.click()}
            >
              <Upload size={12} /> {slot.front_image_url ? 'Replace' : 'Upload'}
            </button>
            <input
              ref={frontFileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files[0]) uploadImage('front', e.target.files[0]); }}
            />
          </div>
        </div>

        {/* Rear image */}
        <div className="props-field">
          <label className="props-field-label">Rear Image</label>
          <div className="props-image-row">
            {slot.rear_image_url && (
              <img src={slot.rear_image_url} alt="Rear" className="props-image-thumb" />
            )}
            <button
              type="button"
              className="props-upload-btn"
              onClick={() => rearFileRef.current?.click()}
            >
              <Upload size={12} /> {slot.rear_image_url ? 'Replace' : 'Upload'}
            </button>
            <input
              ref={rearFileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files[0]) uploadImage('rear', e.target.files[0]); }}
            />
          </div>
        </div>

        {/* IP Address */}
        <div className="props-field">
          <label className="props-field-label">IP Address</label>
          <input
            className="props-input"
            value={fields.ip_address}
            onChange={(e) => setField('ip_address', e.target.value)}
            placeholder="e.g. 192.168.1.1"
          />
        </div>

        {/* Asset Tag */}
        <div className="props-field">
          <label className="props-field-label">Asset Tag</label>
          <input
            className="props-input"
            value={fields.asset_tag}
            onChange={(e) => setField('asset_tag', e.target.value)}
            placeholder="e.g. ASSET-001"
          />
        </div>

        {/* Serial Number */}
        <div className="props-field">
          <label className="props-field-label">Serial Number</label>
          <input
            className="props-input"
            value={fields.serial_number}
            onChange={(e) => setField('serial_number', e.target.value)}
            placeholder="e.g. SN123456"
          />
        </div>

        {/* Notes */}
        <div className="props-field">
          <label className="props-field-label">Notes</label>
          <textarea
            className="props-input props-textarea"
            value={fields.slot_notes}
            onChange={(e) => setField('slot_notes', e.target.value)}
            rows={3}
            placeholder="Notes about this device..."
          />
        </div>
      </div>
    </div>
  );
}
