import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronUp, ChevronDown, ChevronRight, Upload, Plus, Trash2, BookmarkPlus, Copy } from 'lucide-react';
import client from '../../api/client';
import {
  isPassiveItem, isPowerDevice, isUps, getOutletCount, getPowerLabel,
  listPowerSources, countOccupiedOutlets, verticalPdusForUps, firstFreeOutlet,
} from '../../utils/power';
import { pduCatalogEntries } from './rackCatalog';
import { COLOR_SWATCHES, getFieldSchema, INPUT_VOLTAGES, INPUT_PLUG_TYPES, CAPACITY_UNITS } from './deviceFieldSchemas';
import DeviceConfigFields from './DeviceConfigFields';
import OutletGroupsEditor, { TypeSelect } from './OutletGroupsEditor';
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

// Collapsed-by-default accordion used to tuck the Power section out of the
// way for plain (non-UPS/PDU) devices, which don't need tabs.
function CollapsibleSection({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="props-collapsible">
      <button type="button" className="props-collapsible-header" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}</span>
      </button>
      {open && <div className="props-collapsible-body">{children}</div>}
    </div>
  );
}

export default function DevicePropertiesPanel({ slot, rackHeight, rackSlots, userCatalogEntries, devices, actions, onClose, onUpdated, onSelectSlot, onSaveToCatalog, onDeleteRequest, onDuplicate }) {
  const [fields, setFields] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savingToCatalog, setSavingToCatalog] = useState(false);
  const [catalogName, setCatalogName] = useState('');
  const [tab, setTab] = useState('general');
  const frontFileRef = useRef(null);
  const rearFileRef = useRef(null);
  const saveTimer = useRef(null);

  const isVerticalPdu = slot?.item_type === 'vertical-pdu';
  const passive = slot ? isPassiveItem(slot) : false;
  const isPower = slot ? isPowerDevice(slot) : false;
  const isUpsSlot = slot ? isUps(slot) : false;
  const configSchema = slot ? getFieldSchema(resolveRenderType(slot)) : [];

  // Reset form (and the tab) when slot changes
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
      outlet_groups:        Array.isArray(slot.outlet_groups) ? slot.outlet_groups : [],
      input_voltage:        slot.input_voltage        || '',
      input_plug_type:      slot.input_plug_type       || '',
      capacity_va:          slot.capacity_va          ?? '',
      capacity_value:       slot.capacity_value       ?? '',
      capacity_unit:        slot.capacity_unit         || 'A',
      port_count:           slot.port_count           ?? '',
      bay_count:            slot.bay_count            ?? '',
      half_width:    !!slot.half_width,
      half_depth:    !!slot.half_depth,
      power_source_slot_id: slot.power_source_slot_id || null,
      power_source_outlet:  slot.power_source_outlet  || null,
    });
    setError(null);
    setSavingToCatalog(false);
    setTab('general');
    // Deliberately keyed on the slot's id, not the slot object — every patch
    // replaces `slot` with a fresh object from the server (same id), and
    // resetting fields/tab on every one of those would snap the user back
    // to the General tab and discard in-flight edits after each autosave.
  }, [slot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const setFieldNow = (key, val) => {
    setFields((f) => ({ ...f, [key]: val }));
    patch({ [key]: val });
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

  const pluggedIntoField = (
    <PluggedIntoField
      key={slot.id}
      slot={slot}
      rackSlots={rackSlots || []}
      fields={fields}
      onChange={(changes) => {
        setFields((f) => ({ ...f, ...changes }));
        patch(changes);
      }}
    />
  );

  const outletsSummary = (
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
  );

  const actionsSection = (
    <>
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
    </>
  );

  const showGeneral = !isPower || tab === 'general';
  const showPower = isPower && tab === 'power';

  return (
    <div className="props-panel">
      <div className="props-panel-header">
        <span className="props-panel-title" title={label}>{label}</span>
        <button type="button" className="props-panel-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {isPower && (
        <div className="props-tabs">
          <button type="button" className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>General</button>
          <button type="button" className={tab === 'power' ? 'active' : ''} onClick={() => setTab('power')}>Power</button>
        </div>
      )}

      {saving && <div className="props-panel-saving">Saving…</div>}
      {error && <div className="props-panel-error" onClick={() => setError(null)}>{error}</div>}

      <div className="props-panel-body">
        {showGeneral && (
          <>
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

            {!isVerticalPdu && (
              <>
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
              </>
            )}

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

                {/* Linked inventory device */}
                {devices && (
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
              </>
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

            {/* Non-power devices keep a single panel — Power is tucked into a
                collapsed-by-default accordion instead of a tab. Shown for
                every non-power device, including passive items (patch
                panels, shelves, etc.) — anything can be wired to a PDU/UPS
                outlet or left on Wall (Direct), so the selector belongs
                here regardless of whether the device itself draws power. */}
            {!isPower && (
              // Keyed on the slot so switching devices always resets it
              // collapsed, instead of inheriting the previous device's
              // expanded/collapsed state (React would otherwise reuse the
              // same component instance here across selections).
              <CollapsibleSection key={slot.id} title="Power">
                {pluggedIntoField}
              </CollapsibleSection>
            )}

            {actionsSection}
          </>
        )}

        {showPower && (
          <>
            {/* Input Plug Type */}
            <div className="props-field">
              <label className="props-field-label">Input Plug Type</label>
              <TypeSelect
                value={fields.input_plug_type}
                presets={INPUT_PLUG_TYPES}
                onChange={(v) => setFieldNow('input_plug_type', v)}
                placeholder="Custom plug type"
              />
            </div>

            {/* Input Voltage */}
            <div className="props-field">
              <label className="props-field-label">Input Voltage</label>
              <select
                className="props-input"
                value={fields.input_voltage}
                onChange={(e) => setFieldNow('input_voltage', e.target.value)}
              >
                <option value="">Unset</option>
                {INPUT_VOLTAGES.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>

            {/* Capacity — UPS keeps VA; PDU/PDU-vertical get a value + unit (A/W) */}
            {isUpsSlot ? (
              <div className="props-field">
                <label className="props-field-label">Capacity (VA)</label>
                <input
                  className="props-input"
                  type="number"
                  min="0"
                  value={fields.capacity_va}
                  onChange={(e) => setField('capacity_va', e.target.value === '' ? null : Number(e.target.value))}
                  placeholder="e.g. 1500"
                />
              </div>
            ) : (
              <div className="props-field">
                <label className="props-field-label">Capacity</label>
                <div className="props-capacity-row">
                  <input
                    className="props-input"
                    type="number"
                    min="0"
                    value={fields.capacity_value}
                    onChange={(e) => setField('capacity_value', e.target.value === '' ? null : Number(e.target.value))}
                    placeholder="e.g. 30"
                  />
                  <select
                    className="props-input props-capacity-unit"
                    value={fields.capacity_unit}
                    onChange={(e) => setFieldNow('capacity_unit', e.target.value)}
                  >
                    {CAPACITY_UNITS.map((u) => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {!passive && (
              <>
                <div className="props-section-divider">Plugged Into</div>
                {pluggedIntoField}
              </>
            )}

            <div className="props-section-divider">Outlet Groups</div>
            <OutletGroupsEditor
              groups={fields.outlet_groups}
              onChange={(groups) => {
                setFields((f) => ({ ...f, outlet_groups: groups }));
                patch({ outlet_groups: groups });
              }}
            />

            {outletsSummary}

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
          </>
        )}
      </div>
    </div>
  );
}

// Two-step "Plugged Into" selector: pick the power device first, then one
// of its outlets, instead of one flat dropdown listing every outlet across
// every PDU/UPS in the rack. Once both steps are set, collapses to a
// compact summary ("UPS → Outlet 3") with a button to reopen the selector.
function PluggedIntoField({ slot, rackSlots, fields, onChange }) {
  const [editing, setEditing] = useState(false);
  const [pendingSourceId, setPendingSourceId] = useState(null);

  const sources = listPowerSources(rackSlots, slot.id);
  const currentSourceId = fields.power_source_slot_id;
  const currentOutlet = fields.power_source_outlet;
  const currentSourceSlot = currentSourceId ? rackSlots.find((s) => s.id === currentSourceId) : null;

  const summary = currentSourceId
    ? `${getPowerLabel(currentSourceSlot)} → Outlet ${currentOutlet}`
    : 'Wall (Direct)';

  const startEditing = () => {
    setPendingSourceId(currentSourceId || null);
    setEditing(true);
  };

  const handleSourceChange = (val) => {
    if (val === WALL_DIRECT) {
      onChange({ power_source_slot_id: null, power_source_outlet: null });
      setEditing(false);
      return;
    }
    // Selecting a different power device always clears the outlet step —
    // re-picking the device that's already wired keeps showing its outlet.
    setPendingSourceId(Number(val));
  };

  const handleOutletChange = (n) => {
    onChange({ power_source_slot_id: pendingSourceId, power_source_outlet: n });
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="props-field">
        <label className="props-field-label">Plugged Into</label>
        <div className="props-plugged-summary">
          <span className="props-plugged-summary-text">{summary}</span>
          <button type="button" className="props-upload-btn" onClick={startEditing}>Change</button>
        </div>
      </div>
    );
  }

  const selectedSourceEntry = pendingSourceId != null ? sources.find((s) => s.slot.id === pendingSourceId) : null;
  const outletValue = pendingSourceId === currentSourceId ? (currentOutlet || '') : '';

  return (
    <div className="props-field">
      <label className="props-field-label">Plugged Into</label>
      <select
        className="props-input"
        value={pendingSourceId == null ? WALL_DIRECT : String(pendingSourceId)}
        onChange={(e) => handleSourceChange(e.target.value)}
        autoFocus
      >
        <option value={WALL_DIRECT}>Wall (Direct)</option>
        {sources.map(({ slot: sourceSlot }) => (
          <option key={sourceSlot.id} value={sourceSlot.id}>{getPowerLabel(sourceSlot)}</option>
        ))}
      </select>

      {selectedSourceEntry && (
        <select
          className="props-input"
          style={{ marginTop: 6 }}
          value={outletValue}
          onChange={(e) => handleOutletChange(Number(e.target.value))}
        >
          <option value="" disabled>Select outlet…</option>
          {selectedSourceEntry.outlets.map(({ n, type, indexInGroup, occupant }) => {
            const occupiedByOther = occupant && occupant.id !== slot.id;
            return (
              <option key={n} value={n} disabled={Boolean(occupiedByOther)}>
                {type} — Outlet {indexInGroup}{occupiedByOther ? ` — in use (${getPowerLabel(occupant)})` : ''}
              </option>
            );
          })}
        </select>
      )}

      <button type="button" className="props-upload-btn" style={{ marginTop: 6 }} onClick={() => setEditing(false)}>Cancel</button>
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
        outlet_groups: entry.outletCount ? [{ type: entry.outletType || 'Other', count: entry.outletCount }] : [],
        input_voltage: entry.inputVoltage,
      };
    } else {
      const custom = customPdus.find((c) => String(c.id) === idRaw);
      if (!custom) return;
      payload = {
        item_label: custom.name,
        custom_type: custom.render_type,
        outlet_groups: Array.isArray(custom.outlet_groups) ? custom.outlet_groups : [],
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
