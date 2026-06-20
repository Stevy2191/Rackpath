import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronUp, ChevronDown, Upload, Plus, Trash2, BookmarkPlus, Copy } from 'lucide-react';
import client from '../../api/client';
import {
  isPassiveItem, isPowerDevice, isUps, getOutletCount, getPowerLabel,
  buildOutletOptions, countOccupiedOutlets, verticalPdusForUps, firstFreeOutlet,
} from '../../utils/power';
import { pduCatalogEntries } from './rackCatalog';
import { COLOR_SWATCHES, getFieldSchema } from './deviceFieldSchemas';
import DeviceConfigFields from './DeviceConfigFields';
import { resolveRenderType } from './deviceRenderConfig';
import './DevicePropertiesPanel.css';

const FACE_OPTIONS = [
  { value: 'front', label: 'Front' },
  { value: 'rear',  label: 'Rear' },
  { value: 'both',  label: 'Both' },
];

const MOUNT_SIDE_OPTIONS = [
  { value: 'left',  label: 'Left' },
  { value: 'right', label: 'Right' },
];

const WALL_DIRECT = '';

function outletValue(sourceSlotId, outlet) {
  return sourceSlotId ? `${sourceSlotId}:${outlet}` : WALL_DIRECT;
}

export default function DevicePropertiesPanel({ slot, rackHeight, rackSlots, userCatalogEntries, devices, actions, onClose, onUpdated, onSelectSlot, onSaveToCatalog, onDeleteRequest, onDuplicate }) {
  const [fields, setFields] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savingToCatalog, setSavingToCatalog] = useState(false);
  const [catalogName, setCatalogName] = useState('');
  const frontFileRef = useRef(null);
  const rearFileRef = useRef(null);
  const saveTimer = useRef(null);

  const isVerticalPdu = slot?.item_type === 'vertical-pdu';
  const passive = slot ? isPassiveItem(slot) : false;
  const isPower = slot ? isPowerDevice(slot) : false;
  const isUpsSlot = slot ? isUps(slot) : false;
  const configSchema = slot ? getFieldSchema(resolveRenderType(slot)) : [];

  // Reset form when slot changes
  useEffect(() => {
    if (!slot) { setFields(null); return; }
    setFields({
      item_label:    slot.item_label    || '',
      u_size:        slot.u_size        || 1,
      u_position:    slot.u_position    || 1,
      color:         slot.color         || null,
      mounted_face:  slot.mounted_face  || 'front',
      mount_side:    slot.mount_side    || 'left',
      // Pre-fill from linked inventory device when the slot doesn't have its own value
      ip_address:    slot.ip_address    || slot.ip                     || '',
      serial_number: slot.serial_number || slot.device_serial_number   || '',
      slot_notes:    slot.slot_notes    || '',
      asset_tag:     slot.asset_tag     || '',
      outlet_count:        slot.outlet_count         ?? '',
      outlet_type:         slot.outlet_type          || '',
      input_voltage:        slot.input_voltage        || '',
      capacity_va:          slot.capacity_va          ?? '',
      port_count:           slot.port_count           ?? '',
      bay_count:            slot.bay_count            ?? '',
      half_width:    !!slot.half_width,
      half_depth:    !!slot.half_depth,
      power_source_slot_id: slot.power_source_slot_id || null,
      power_source_outlet:  slot.power_source_outlet  || null,
    });
    setError(null);
    setSavingToCatalog(false);
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

    // Vertical PDUs are floating elements alongside the frame — they never
    // collide with U-slot devices, so just clamp to the rack height.
    if (isVerticalPdu) {
      if (curBottom + newSize - 1 > rackHeight) return;
      setFields((f) => ({ ...f, u_size: newSize }));
      patch({ u_size: newSize });
      return;
    }

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

        {!isVerticalPdu && (
          <>
            {/* Width */}
            <div className="props-field">
              <label className="props-field-label">Width</label>
              <div className="props-face-btns">
                <button
                  type="button"
                  className={`props-face-btn${!fields.half_width ? ' active' : ''}`}
                  onClick={() => { setFields((f) => ({ ...f, half_width: false })); patch({ half_width: 0 }); }}
                >
                  Full
                </button>
                <button
                  type="button"
                  className={`props-face-btn${fields.half_width ? ' active' : ''}`}
                  onClick={() => { setFields((f) => ({ ...f, half_width: true })); patch({ half_width: 1 }); }}
                >
                  Half
                </button>
              </div>
            </div>

            {/* Depth */}
            <div className="props-field">
              <label className="props-field-label">Depth</label>
              <div className="props-face-btns">
                <button
                  type="button"
                  className={`props-face-btn${!fields.half_depth ? ' active' : ''}`}
                  onClick={() => { setFields((f) => ({ ...f, half_depth: false })); patch({ half_depth: 0 }); }}
                >
                  Full
                </button>
                <button
                  type="button"
                  className={`props-face-btn${fields.half_depth ? ' active' : ''}`}
                  onClick={() => { setFields((f) => ({ ...f, half_depth: true })); patch({ half_depth: 1 }); }}
                >
                  Half
                </button>
              </div>
            </div>
          </>
        )}

        {/* Mounted face (U-slot devices) / Mount side (vertical PDU) */}
        <div className="props-field">
          <label className="props-field-label">{isVerticalPdu ? 'Mount Side' : 'Mounted Face'}</label>
          <div className="props-face-btns">
            {(isVerticalPdu ? MOUNT_SIDE_OPTIONS : FACE_OPTIONS).map((f) => (
              <button
                key={f.value}
                type="button"
                className={`props-face-btn${(isVerticalPdu ? fields.mount_side : fields.mounted_face) === f.value ? ' active' : ''}`}
                onClick={() => {
                  const key = isVerticalPdu ? 'mount_side' : 'mounted_face';
                  setFields((prev) => ({ ...prev, [key]: f.value }));
                  patch({ [key]: f.value });
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {!isVerticalPdu && (
          <>
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
          </>
        )}

        {/* Linked inventory device */}
        {!isVerticalPdu && devices && (
          <div className="props-field">
            <label className="props-field-label">Linked Inventory Device</label>
            <select
              className="props-input"
              value={slot.device_id || ''}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                actions.onSlotUpdate(slot, { device_id: Number(id), item_type: 'device' });
              }}
            >
              <option value="" disabled>Select a device…</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>{d.hostname || d.ip || `Device ${d.id}`}</option>
              ))}
            </select>
          </div>
        )}

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

        {/* MAC Address — read-only from linked inventory device */}
        {slot.device_mac && (
          <div className="props-field">
            <label className="props-field-label">MAC Address</label>
            <div className="props-readonly">{slot.device_mac}</div>
          </div>
        )}

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

        {configSchema.length > 0 && (
          <>
            <div className="props-section-divider">Configuration</div>
            <DeviceConfigFields schema={configSchema} values={fields} onChange={setField} />
          </>
        )}

        {!passive && (
          <>
            <div className="props-section-divider">Power</div>

            {/* Plugged Into */}
            <div className="props-field">
              <label className="props-field-label">Plugged Into</label>
              <select
                className="props-input"
                value={outletValue(fields.power_source_slot_id, fields.power_source_outlet)}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === WALL_DIRECT) {
                    setFields((f) => ({ ...f, power_source_slot_id: null, power_source_outlet: null }));
                    patch({ power_source_slot_id: null, power_source_outlet: null });
                    return;
                  }
                  const [sourceId, outlet] = val.split(':').map(Number);
                  setFields((f) => ({ ...f, power_source_slot_id: sourceId, power_source_outlet: outlet }));
                  patch({ power_source_slot_id: sourceId, power_source_outlet: outlet });
                }}
              >
                <option value={WALL_DIRECT}>Wall (Direct)</option>
                {buildOutletOptions(rackSlots || [], slot.id, slot.id).map((opt) => (
                  <option
                    key={`${opt.sourceSlotId}:${opt.outlet}`}
                    value={outletValue(opt.sourceSlotId, opt.outlet)}
                    disabled={opt.disabled}
                  >
                    {opt.label}{opt.disabled ? ' (occupied)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {isPower && (
          <>
            <div className="props-section-divider">
              Outlets — {countOccupiedOutlets(slot, rackSlots || [])} of {getOutletCount(slot)} in use
            </div>
            {getOutletCount(slot) === 0 ? (
              <p className="props-empty-note">No outlets defined for this device.</p>
            ) : (
              <PowerOutletList slot={slot} rackSlots={rackSlots || []} onSelectSlot={onSelectSlot} />
            )}
          </>
        )}

        {isUpsSlot && (
          <VerticalPduSection
            ups={slot}
            rackSlots={rackSlots || []}
            userCatalogEntries={userCatalogEntries || []}
            rackHeight={rackHeight}
            actions={actions}
            onSelectSlot={onSelectSlot}
          />
        )}

        <div className="props-section-divider">Actions</div>
        <div className="props-danger-zone">
          {savingToCatalog ? (
            <div className="props-save-catalog-row">
              <input
                className="props-input"
                value={catalogName}
                onChange={(e) => setCatalogName(e.target.value)}
                placeholder="Name for this catalog entry"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Escape') setSavingToCatalog(false); }}
              />
              <button
                type="button"
                className="props-upload-btn"
                onClick={() => {
                  const name = catalogName.trim();
                  if (!name) return;
                  onSaveToCatalog(slot, name);
                  setSavingToCatalog(false);
                }}
              >
                Save
              </button>
              <button type="button" className="props-upload-btn" onClick={() => setSavingToCatalog(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="props-upload-btn"
              onClick={() => { setCatalogName(fields.item_label || 'Untitled device'); setSavingToCatalog(true); }}
            >
              <BookmarkPlus size={12} /> Save to Catalog
            </button>
          )}
          <button type="button" className="props-upload-btn" onClick={() => onDuplicate(slot)}>
            <Copy size={12} /> Duplicate Device
          </button>
          <button type="button" className="props-delete-btn" onClick={() => onDeleteRequest(slot)}>
            <Trash2 size={12} /> Delete Device
          </button>
        </div>
      </div>
    </div>
  );
}

function PowerOutletList({ slot, rackSlots, onSelectSlot }) {
  const outlets = Array.from({ length: getOutletCount(slot) }, (_, i) => {
    const n = i + 1;
    const occupant = rackSlots.find((s) => s.power_source_slot_id === slot.id && s.power_source_outlet === n);
    return { n, occupant };
  });

  return (
    <div className="props-outlet-list">
      {outlets.map(({ n, occupant }) => (
        <div
          key={n}
          className={`props-outlet-row${occupant ? ' has-occupant' : ''}`}
          onClick={() => occupant && onSelectSlot && onSelectSlot(occupant.id)}
          title={occupant ? `Jump to ${getPowerLabel(occupant)}` : undefined}
        >
          <span className="props-outlet-num">{n}</span>
          <span className="props-outlet-name">{occupant ? getPowerLabel(occupant) : 'Empty'}</span>
        </div>
      ))}
    </div>
  );
}

function VerticalPduSection({ ups, rackSlots, userCatalogEntries, rackHeight, actions, onSelectSlot }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const catalogEntries = pduCatalogEntries();
  const customPdus = userCatalogEntries.filter((c) => c.render_type === 'pdu' || c.render_type === 'pdu-vertical');
  const [sourceKey, setSourceKey] = useState('');

  const attached = verticalPdusForUps(rackSlots, ups.id);

  const openAdd = () => {
    setSourceKey(catalogEntries[0] ? `catalog:${catalogEntries[0].id}` : (customPdus[0] ? `custom:${customPdus[0].id}` : ''));
    setError(null);
    setAdding(true);
  };

  const handleAdd = () => {
    if (!sourceKey) { setError('Choose a PDU model'); return; }
    const outlet = firstFreeOutlet(ups, rackSlots);
    if (!outlet) { setError('UPS has no free outlets'); return; }

    const [kind, idRaw] = sourceKey.split(':');
    let payload;
    if (kind === 'catalog') {
      const entry = catalogEntries.find((c) => c.id === idRaw);
      if (!entry) return;
      payload = {
        item_label: entry.name,
        catalog_id: entry.id,
        custom_type: entry.renderType,
        outlet_count: entry.outletCount,
        outlet_type: entry.outletType,
        input_voltage: entry.inputVoltage,
      };
    } else {
      const custom = customPdus.find((c) => String(c.id) === idRaw);
      if (!custom) return;
      payload = {
        item_label: custom.name,
        custom_type: custom.render_type,
        outlet_count: custom.outlet_count,
        outlet_type: custom.outlet_type,
        input_voltage: custom.input_voltage,
      };
    }

    // Alternate sides: 1st left, 2nd right, 3rd left (offset further out), etc.
    const mount_side = attached.length % 2 === 0 ? 'left' : 'right';

    actions.onSlotCreate({
      rack_id: ups.rack_id,
      item_type: 'vertical-pdu',
      mount_side,
      u_position: 1,
      u_size: rackHeight,
      power_source_slot_id: ups.id,
      power_source_outlet: outlet,
      ...payload,
    });
    setAdding(false);
  };

  const handleRemove = (pdu) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove vertical PDU "${pdu.item_label || 'PDU'}"?`)) return;
    actions.onSlotDelete(pdu.id);
  };

  return (
    <>
      <div className="props-section-divider">Vertical PDUs</div>
      {attached.length === 0 && !adding && (
        <p className="props-empty-note">No vertical PDUs attached.</p>
      )}
      {attached.length > 0 && (
        <div className="props-outlet-list">
          {attached.map((pdu) => (
            <div key={pdu.id} className="props-outlet-row has-occupant" onClick={() => onSelectSlot && onSelectSlot(pdu.id)}>
              <span className="props-outlet-name">{pdu.item_label || 'PDU'} ({pdu.mount_side || 'left'})</span>
              <button
                type="button"
                className="props-outlet-remove"
                title="Remove"
                onClick={(e) => { e.stopPropagation(); handleRemove(pdu); }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="props-field">
          <select className="props-input" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            {catalogEntries.length > 0 && (
              <optgroup label="Catalog">
                {catalogEntries.map((c) => (
                  <option key={c.id} value={`catalog:${c.id}`}>{c.name}</option>
                ))}
              </optgroup>
            )}
            {customPdus.length > 0 && (
              <optgroup label="Custom">
                {customPdus.map((c) => (
                  <option key={c.id} value={`custom:${c.id}`}>{c.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {error && <div className="props-panel-error">{error}</div>}
          <div className="props-pdu-add-actions">
            <button type="button" onClick={() => setAdding(false)}>Cancel</button>
            <button type="button" className="props-upload-btn" onClick={handleAdd}>Add</button>
          </div>
        </div>
      ) : (
        <button type="button" className="props-upload-btn" onClick={openAdd} disabled={catalogEntries.length === 0 && customPdus.length === 0}>
          <Plus size={12} /> Add Vertical PDU
        </button>
      )}
    </>
  );
}
