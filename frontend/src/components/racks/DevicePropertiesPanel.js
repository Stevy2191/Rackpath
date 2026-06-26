import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronUp, ChevronDown, Upload, Plus, Trash2, BookmarkPlus, Copy } from 'lucide-react';
import CopySettingsModal from './CopySettingsModal';
import client from '../../api/client';
import {
  isPassiveItem, isPowerDevice, isUps, isAts, getOutletCount, getPowerLabel, getPowerSourceLabel,
  groupPowerSourcesByRack, countOccupiedOutlets, verticalPdusForUps, firstFreeOutlet, findOccupant,
  flattenOutlets,
} from '../../utils/power';
import { pduCatalogEntries } from './rackCatalog';
import {
  COLOR_SWATCHES, getFieldSchema, INPUT_VOLTAGES, INPUT_PLUG_TYPES, CAPACITY_UNITS,
  ATS_INLET_TYPES, ATS_OUTLET_TYPES,
} from './deviceFieldSchemas';
import DeviceConfigFields from './DeviceConfigFields';
import OutletGroupsEditor, { TypeSelect } from './OutletGroupsEditor';
import { resolveRenderType } from './deviceRenderConfig';
import { computeVerticalPduPositions, resolveFractionalPlacement, resolveVerticalPduSide } from './rackPlacement';
import './DevicePropertiesPanel.css';

const DEFAULT_UPS_CURVE = [
  { load_watts: 500,  runtime_minutes: 90 },
  { load_watts: 1000, runtime_minutes: 30 },
  { load_watts: 1500, runtime_minutes: 18 },
  { load_watts: 2000, runtime_minutes: 12 },
  { load_watts: 2500, runtime_minutes: 7  },
  { load_watts: 3000, runtime_minutes: 6  },
  { load_watts: 3500, runtime_minutes: 5  },
  { load_watts: 4000, runtime_minutes: 5  },
  { load_watts: 4500, runtime_minutes: 4  },
  { load_watts: 5000, runtime_minutes: 3  },
];

const DEFAULT_EBM_CURVE = [
  { load_watts: 1000, added_runtime_minutes: 13 },
  { load_watts: 1500, added_runtime_minutes: 11 },
  { load_watts: 2000, added_runtime_minutes: 9  },
  { load_watts: 2500, added_runtime_minutes: 8  },
  { load_watts: 3000, added_runtime_minutes: 7  },
  { load_watts: 3500, added_runtime_minutes: 6  },
  { load_watts: 4000, added_runtime_minutes: 5  },
  { load_watts: 4500, added_runtime_minutes: 4  },
  { load_watts: 5000, added_runtime_minutes: 3  },
];

function RuntimeCurveEditor({ curve, runtimeKey, runtimeLabel, onChange }) {
  const sorted = [...curve].sort((a, b) => a.load_watts - b.load_watts);

  const commitRow = (idx, field, raw) => {
    const num = raw === '' ? null : Number(raw);
    if (num === null || isNaN(num)) return;
    const next = [...sorted];
    next[idx] = { ...next[idx], [field]: num };
    const finalSorted = [...next].sort((a, b) => a.load_watts - b.load_watts);
    onChange(finalSorted);
  };

  const addRow = () => {
    const maxLoad = sorted.length ? sorted[sorted.length - 1].load_watts : 0;
    const newRow = { load_watts: maxLoad + 500, [runtimeKey]: 1 };
    onChange([...sorted, newRow]);
  };

  const removeRow = (idx) => {
    const next = sorted.filter((_, i) => i !== idx);
    onChange(next);
  };

  return (
    <div className="runtime-curve-editor">
      <div className="runtime-curve-header">
        <span>Load (W)</span>
        <span>{runtimeLabel}</span>
        <span />
      </div>
      {sorted.map((row, idx) => (
        <div key={idx} className="runtime-curve-row">
          <input
            className="props-input runtime-curve-input"
            type="number"
            min="0"
            defaultValue={row.load_watts}
            onBlur={(e) => commitRow(idx, 'load_watts', e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          />
          <input
            className="props-input runtime-curve-input"
            type="number"
            min="0"
            defaultValue={row[runtimeKey]}
            onBlur={(e) => commitRow(idx, runtimeKey, e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          />
          <button type="button" className="runtime-curve-remove" onClick={() => removeRow(idx)} title="Remove row">
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="runtime-curve-add" onClick={addRow}>
        <Plus size={13} /> Add Point
      </button>
    </div>
  );
}

const FACE_OPTIONS = [
  { value: 'front', label: 'Front' },
  { value: 'rear',  label: 'Rear' },
  { value: 'both',  label: 'Both' },
];

const VERTICAL_PDU_POSITION_LABELS = {
  left:  'Left',
  right: 'Right',
};

const WALL_DIRECT = '';

export default function DevicePropertiesPanel({ slot, rackHeight, rackSlots, allSlots, racks, userCatalogEntries, devices, actions, onClose, onUpdated, onSelectSlot, onSaveToCatalog, onDeleteRequest }) {
  const [fields, setFields] = useState(null);
  const [error, setError] = useState(null);
  const [savingToCatalog, setSavingToCatalog] = useState(false);
  const [catalogName, setCatalogName] = useState('');
  const [tab, setTab] = useState('general');
  const [showCopyModal, setShowCopyModal] = useState(false);
  // PSU 2 is optional and hidden by default — only shown once the user
  // explicitly adds it, or it already has a value (don't hide existing
  // data just because the UI default changed). Reset alongside the rest
  // of the form whenever the slot being edited changes (see the effect
  // below).
  const [showPsu2, setShowPsu2] = useState(Boolean(slot?.psu2_source_slot_id));
  const frontFileRef = useRef(null);
  const rearFileRef = useRef(null);
  const saveTimer = useRef(null);

  const isVerticalPdu = slot?.item_type === 'vertical-pdu';
  const isAtsSlot = slot ? isAts(slot) : false;
  // Position (Left/Right) is assigned rack-wide by creation order — see
  // computeVerticalPduPositions — so it has to be derived from every
  // vertical PDU in the rack, not just this one: 1st PDU added is Left,
  // 2nd is Right. A 3rd is rejected outright (see VerticalPduSection)
  // since a real rack only mounts one PDU per side.
  const verticalPduPosition = isVerticalPdu
    ? computeVerticalPduPositions((rackSlots || []).filter((s) => s.item_type === 'vertical-pdu')).get(slot.id)
    : null;
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
      // Pre-fill from linked inventory device when the slot doesn't have its own value
      ip_address:    slot.ip_address    || slot.ip                     || '',
      serial_number: slot.serial_number || slot.device_serial_number   || '',
      slot_notes:    slot.slot_notes    || '',
      asset_tag:     slot.asset_tag     || '',
      outlet_groups:        Array.isArray(slot.outlet_groups) ? slot.outlet_groups : [],
      input_voltage:        slot.input_voltage        || '',
      input_plug_type:      slot.input_plug_type       || '',
      capacity_va:          slot.capacity_va          ?? '',
      capacity_w:           slot.capacity_w           ?? '',
      capacity_value:       slot.capacity_value       ?? '',
      capacity_unit:        slot.capacity_unit         || 'A',
      port_count:           slot.port_count           ?? '',
      bay_count:            slot.bay_count            ?? '',
      device_type:              slot.device_type              || null,
      ups_va_rating:            slot.ups_va_rating            ?? '',
      ups_watt_rating:          slot.ups_watt_rating          ?? '',
      ups_runtime_full:         slot.ups_runtime_full         ?? '',
      ups_runtime_half:         slot.ups_runtime_half         ?? '',
      runtime_curve:            Array.isArray(slot.runtime_curve) ? slot.runtime_curve : null,
      ups_max_ebm_slots:        slot.ups_max_ebm_slots        ?? '',
      ebm_connected_ups_id:     slot.ebm_connected_ups_id     || null,
      ebm_runtime_full:         slot.ebm_runtime_full         ?? '',
      ebm_runtime_half:         slot.ebm_runtime_half         ?? '',
      ebm_runtime_curve:        Array.isArray(slot.ebm_runtime_curve) ? slot.ebm_runtime_curve : null,
      slot_width:    slot.slot_width || 'full',
      half_depth:    !!slot.half_depth,
      power_source_slot_id: slot.power_source_slot_id || null,
      power_source_outlet:  slot.power_source_outlet  || null,
      psu2_source_slot_id:  slot.psu2_source_slot_id   || null,
      psu2_source_outlet:   slot.psu2_source_outlet    || null,
    });
    setError(null);
    setSavingToCatalog(false);
    setTab('general');
    setShowPsu2(Boolean(slot.psu2_source_slot_id));
    // Deliberately keyed on the slot's id, not the slot object — every patch
    // replaces `slot` with a fresh object from the server (same id), and
    // resetting fields/tab on every one of those would snap the user back
    // to the General tab and discard in-flight edits after each autosave.
  }, [slot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!slot || !fields) return null;

  const patch = async (changes) => {
    // Capture state before applying this change so we can revert on error.
    const prevSlot = slot;
    const prevFieldSnapshot = Object.fromEntries(
      Object.keys(changes).filter((k) => k in fields).map((k) => [k, fields[k]])
    );
    // Optimistic: parent sees the change immediately without waiting for the API.
    onUpdated({ ...slot, ...changes });
    setError(null);
    try {
      await client.patch(`/rack-slots/${slot.id}`, changes);
    } catch (err) {
      // Revert parent and any fields the API rejected.
      onUpdated(prevSlot);
      setFields((f) => ({ ...f, ...prevFieldSnapshot }));
      setError(err.response?.data?.error || err.message);
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
      // Vertical PDUs are 0U floating elements, not real U-grid occupants
      // — their stored u_position/u_size must never block a real device's
      // resize, same as the backend's own collision check.
      if (s.item_type === 'vertical-pdu') continue;
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
    try {
      await client.post(`/rack-slots/${slot.id}/images`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      // Fetch updated slot to get the new image URL for the faceplate.
      const updated = await client.get('/rack-slots', { params: { rack_id: slot.rack_id } });
      const updatedSlot = updated.data.find((s) => s.id === slot.id);
      if (updatedSlot) onUpdated(updatedSlot);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const label = slot.item_type === 'device'
    ? (slot.hostname || slot.ip || `Device ${slot.device_id}`)
    : (slot.item_label || slot.custom_type || 'Device');

  const onPsuChange = (changes) => {
    setFields((f) => ({ ...f, ...changes }));
    patch(changes);
  };

  const removePsu2 = () => {
    setShowPsu2(false);
    onPsuChange({ psu2_source_slot_id: null, psu2_source_outlet: null });
  };

  // Vertical PDUs only ever have the one connection (to their owning UPS,
  // set automatically when they're attached — see VerticalPduSection), so
  // they keep the single "Plugged Into" field rather than gaining a PSU2
  // that wouldn't mean anything for them. ATS has its own Input A/Input B
  // pair rendered separately below (always both shown — that's the whole
  // point of an ATS), not this generic PSU1/PSU2 pair. Every other
  // non-passive item (regular devices, and a horizontal PDU/UPS chained
  // to an upstream source) gets independent PSU 1 / PSU 2 selectors, with
  // PSU 2 optional and hidden until added.
  const psu1Field = (
    <PsuField
      key={`${slot.id}-psu1`}
      slot={slot}
      allSlots={allSlots || []}
      racks={racks || []}
      fieldPrefix="psu1"
      label={isVerticalPdu ? 'Plugged Into' : 'PSU 1'}
      fields={fields}
      onChange={onPsuChange}
    />
  );
  const psu2Field = !isVerticalPdu && (
    showPsu2 ? (
      <>
        <PsuField
          key={`${slot.id}-psu2`}
          slot={slot}
          allSlots={allSlots || []}
          racks={racks || []}
          fieldPrefix="psu2"
          label="PSU 2"
          fields={fields}
          onChange={onPsuChange}
        />
        <button type="button" className="props-upload-btn" style={{ marginTop: 6 }} onClick={removePsu2}>
          <X size={11} /> Remove PSU 2
        </button>
      </>
    ) : (
      <button type="button" className="props-upload-btn" onClick={() => setShowPsu2(true)}>
        <Plus size={11} /> Add PSU 2
      </button>
    )
  );
  const pluggedIntoFields = <>{psu1Field}{psu2Field}</>;

  const outletsSummary = (
    <>
      <div className="props-section-divider">
        Outlets — {countOccupiedOutlets(slot, allSlots || [])} of {getOutletCount(slot)} in use
      </div>
      {getOutletCount(slot) === 0 ? (
        <p className="props-empty-note">No outlets defined for this device.</p>
      ) : (
        <PowerOutletList slot={slot} allSlots={allSlots || []} onSelectSlot={onSelectSlot} />
      )}
    </>
  );

  // All devices across all project racks with the same catalog type —
  // shown in Copy Settings modal, grouped by rack.
  const sameTypeSlots = !isVerticalPdu ? (allSlots || []).filter((s) => {
    if (s.id === slot.id) return false;
    if (s.item_type === 'vertical-pdu') return false;
    if (slot.catalog_id) return s.catalog_id === slot.catalog_id;
    return slot.custom_type && s.custom_type === slot.custom_type;
  }) : [];

  const actionsSection = (
    <>
      <div className="props-section-divider">Actions</div>
      <div className="props-danger-zone">
        {sameTypeSlots.length > 0 && (
          <button
            type="button"
            className="props-upload-btn"
            onClick={() => setShowCopyModal(true)}
          >
            <Copy size={12} /> Copy Settings To…
          </button>
        )}
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
        <button type="button" className="props-delete-btn" onClick={() => onDeleteRequest(slot)}>
          <Trash2 size={12} /> Delete Device
        </button>
      </div>
    </>
  );

  // Passive items (patch panels, shelves, etc.) and EBM battery modules have
  // no wall power connection, so they get no Power tab — just General fields.
  const isEbm = resolveRenderType(slot) === 'ebm' || fields.device_type === 'ebm';
  // Vertical PDUs get no Power tab either, same reasoning as EBM — their
  // one connection field (Connected To) and outlet count live inline in
  // General instead (see the "Power Connection" section below).
  const showPowerTab = !passive && !isEbm && !isVerticalPdu;
  const showGeneral = !showPowerTab || tab === 'general';
  const showPower = showPowerTab && tab === 'power';
  const powerSourceGroups = groupPowerSourcesByRack(allSlots || [], racks || [], slot.id);

  return (
    <div className="props-panel">
      <div className="props-panel-header">
        <span className="props-panel-title" title={label}>{label}</span>
        <button type="button" className="props-panel-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {showPowerTab && (
        <div className="props-tabs">
          <button type="button" className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>General</button>
          <button type="button" className={tab === 'power' ? 'active' : ''} onClick={() => setTab('power')}>Power</button>
        </div>
      )}

      {error && <div className="props-panel-error" onClick={() => setError(null)}>{error}</div>}

      <div className="props-panel-body">
      <div className="props-panel-fields">
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
                    {[['full', 'Full'], ['half-width', 'Half'], ['third', 'Third']].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`props-face-btn${fields.slot_width === value ? ' active' : ''}`}
                        onClick={() => {
                          // Re-derive slot_position for the new width at this
                          // slot's own current spot (excluding itself) — if
                          // no compatible column is open there, fall back to
                          // 0 and let the backend's collision check surface
                          // the conflict via the usual error banner.
                          const resolved = resolveFractionalPlacement({
                            slots: allSlots || [],
                            rackId: slot.rack_id,
                            face: slot.mounted_face || slot.front_back || 'front',
                            uPosition: slot.u_position,
                            slotWidth: value,
                            excludeSlotId: slot.id,
                          });
                          const slot_position = resolved.ok ? resolved.slot_position : 0;
                          setFields((f) => ({ ...f, slot_width: value }));
                          patch({ slot_width: value, slot_position });
                        }}
                      >
                        {label}
                      </button>
                    ))}
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

            {/* Mounted face (U-slot devices) */}
            {!isVerticalPdu && (
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
            )}

            {/* Vertical PDU side — moves it to the other rail's channel,
                same guarded placement logic as dragging it there onto
                RackEnclosure's PduChannel (rejects if that channel is
                already holding 2). */}
            {isVerticalPdu && (
              <div className="props-field">
                <label className="props-field-label">Side</label>
                <div className="props-face-btns">
                  {['left', 'right'].map((sideOption) => (
                    <button
                      key={sideOption}
                      type="button"
                      className={`props-face-btn${verticalPduPosition?.side === sideOption ? ' active' : ''}`}
                      onClick={() => {
                        if (verticalPduPosition?.side === sideOption) return;
                        const resolved = resolveVerticalPduSide({
                          verticalPdus: (rackSlots || []).filter((s) => s.item_type === 'vertical-pdu'),
                          side: sideOption,
                          excludeSlotId: slot.id,
                        });
                        if (!resolved.ok) { setError(resolved.error); return; }
                        patch({ mount_side: resolved.side });
                      }}
                    >
                      {VERTICAL_PDU_POSITION_LABELS[sideOption]}
                    </button>
                  ))}
                </div>
              </div>
            )}

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

            {/* Vertical PDUs have no separate Power tab (their connection
                isn't an upstream PSU1/PSU2 pair like a regular device's —
                it's the single "Connected To" field below, same reasoning
                EBM devices already skip the tab for their own connection
                field) — Connected To, Input Voltage, and outlet count all
                live here instead, inline in General. */}
            {isVerticalPdu && (
              <>
                <div className="props-section-divider">Power Connection</div>
                {pluggedIntoFields}
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
                <div className="props-section-divider">Outlet Groups</div>
                <OutletGroupsEditor
                  groups={fields.outlet_groups}
                  onChange={(groups) => {
                    setFields((f) => ({ ...f, outlet_groups: groups }));
                    patch({ outlet_groups: groups });
                  }}
                />
              </>
            )}

            {configSchema.length > 0 && (
              <>
                <div className="props-section-divider">Configuration</div>
                <DeviceConfigFields schema={configSchema} values={fields} onChange={setField} />
              </>
            )}

            {!passive && (
              <>
                <div className="props-section-divider">Type Classification</div>
                <div className="props-field">
                  <label className="props-field-label">Device Type</label>
                  <select
                    className="props-input"
                    value={fields.device_type || ''}
                    onChange={(e) => setFieldNow('device_type', e.target.value || null)}
                  >
                    <option value="">None</option>
                    <option value="ups">UPS</option>
                    <option value="ebm">EBM (Extended Battery Module)</option>
                  </select>
                </div>

                {fields.device_type === 'ups' && (
                  <>
                    <div className="props-section-divider">Power Capacity</div>
                    <div className="props-field">
                      <label className="props-field-label">VA Rating</label>
                      <input
                        className="props-input"
                        type="number"
                        min="0"
                        value={fields.ups_va_rating}
                        onChange={(e) => setField('ups_va_rating', e.target.value === '' ? null : Number(e.target.value))}
                        placeholder="e.g. 5000"
                      />
                    </div>
                    <div className="props-field">
                      <label className="props-field-label">Watt Rating</label>
                      <input
                        className="props-input"
                        type="number"
                        min="0"
                        value={fields.ups_watt_rating}
                        onChange={(e) => setField('ups_watt_rating', e.target.value === '' ? null : Number(e.target.value))}
                        placeholder="e.g. 4500"
                      />
                    </div>
                    <div className="props-field props-field-full">
                      <label className="props-field-label">Runtime Curve</label>
                      <RuntimeCurveEditor
                        curve={fields.runtime_curve || DEFAULT_UPS_CURVE}
                        runtimeKey="runtime_minutes"
                        runtimeLabel="Runtime (min)"
                        onChange={(c) => setField('runtime_curve', c)}
                      />
                    </div>
                    <div className="props-field">
                      <label className="props-field-label">Max EBM Slots</label>
                      <input
                        className="props-input"
                        type="number"
                        min="0"
                        value={fields.ups_max_ebm_slots}
                        onChange={(e) => setField('ups_max_ebm_slots', e.target.value === '' ? null : Number(e.target.value))}
                        placeholder="e.g. 4"
                      />
                    </div>
                  </>
                )}

                {fields.device_type === 'ebm' && (
                  <>
                    <div className="props-section-divider">Battery Extension</div>
                    <div className="props-field">
                      <label className="props-field-label">Connected To (UPS)</label>
                      <select
                        className="props-input"
                        value={fields.ebm_connected_ups_id || ''}
                        onChange={(e) => setFieldNow('ebm_connected_ups_id', e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">Not connected</option>
                        {(rackSlots || [])
                          .filter((s) => s.device_type === 'ups' && s.id !== slot.id)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.item_label || s.hostname || `Slot ${s.id}`}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="props-field props-field-full">
                      <label className="props-field-label">Added Runtime Curve</label>
                      <RuntimeCurveEditor
                        curve={fields.ebm_runtime_curve || DEFAULT_EBM_CURVE}
                        runtimeKey="added_runtime_minutes"
                        runtimeLabel="Added Runtime (min)"
                        onChange={(c) => setField('ebm_runtime_curve', c)}
                      />
                    </div>
                  </>
                )}
              </>
            )}

            {actionsSection}
          </>
        )}

        {showPower && !isPower && (
          <>
            {powerSourceGroups.length === 0 && (
              <p className="props-empty-note">
                No power devices in this project. Add a UPS or PDU to any rack to map power connections.
              </p>
            )}
            {pluggedIntoFields}
          </>
        )}

        {showPower && isAtsSlot && (
          <>
            {/* Inlet Type */}
            <div className="props-field">
              <label className="props-field-label">Inlet Type</label>
              <TypeSelect
                value={fields.input_plug_type}
                presets={ATS_INLET_TYPES}
                onChange={(v) => setFieldNow('input_plug_type', v)}
                placeholder="Custom inlet type"
              />
            </div>

            {/* Outlet Type — always exactly one outlet (an ATS feeds one
                downstream device), so this writes outlet_groups directly
                rather than going through the multi-group editor PDU/UPS
                use. */}
            <div className="props-field">
              <label className="props-field-label">Outlet Type</label>
              <TypeSelect
                value={fields.outlet_groups[0]?.type || ''}
                presets={ATS_OUTLET_TYPES}
                onChange={(v) => {
                  const groups = [{ type: v, count: 1 }];
                  setFields((f) => ({ ...f, outlet_groups: groups }));
                  patch({ outlet_groups: groups });
                }}
                placeholder="Custom outlet type"
              />
            </div>

            <div className="props-section-divider">Power Sources</div>
            <PsuField
              slot={slot}
              allSlots={allSlots || []}
              racks={racks || []}
              fieldPrefix="psu1"
              label="Input A"
              fields={fields}
              onChange={onPsuChange}
            />
            <PsuField
              slot={slot}
              allSlots={allSlots || []}
              racks={racks || []}
              fieldPrefix="psu2"
              label="Input B"
              fields={fields}
              onChange={onPsuChange}
            />

            <div className="props-section-divider">Output</div>
            <AtsOutputField ats={slot} allSlots={allSlots || []} actions={actions} onSelectSlot={onSelectSlot} />
          </>
        )}

        {showPower && isPower && !isAtsSlot && (
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

            {/* Capacity — UPS keeps VA + W; PDU/PDU-vertical get a value + unit (A/W) */}
            {isUpsSlot ? (
              <>
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
                <div className="props-field">
                  <label className="props-field-label">Capacity (W)</label>
                  <input
                    className="props-input"
                    type="number"
                    min="0"
                    value={fields.capacity_w}
                    onChange={(e) => setField('capacity_w', e.target.value === '' ? null : Number(e.target.value))}
                    placeholder="e.g. 1350"
                  />
                </div>
              </>
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
                {pluggedIntoFields}
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
                allSlots={allSlots || []}
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

      {showCopyModal && (
        <CopySettingsModal
          slot={slot}
          fields={fields}
          targets={sameTypeSlots}
          racks={racks || []}
          onUpdated={onUpdated}
          onClose={() => setShowCopyModal(false)}
        />
      )}
    </div>
  );
}

// Two-step "Plugged Into" selector: pick the power device first, then one
// of its outlets, instead of one flat dropdown listing every outlet across
// every PDU/UPS in the rack. Once both steps are set, collapses to a
// compact summary ("Rack 2 — PDU Right → Outlet 3") with a button to
// reopen the selector. `fieldPrefix` ('psu1'/'psu2') picks which pair of
// DB columns this instance reads/writes, so a device can have two of
// these — one for each independent power cord — without either one
// stepping on the other's state. Power sources are listed project-wide,
// grouped by rack (see groupPowerSourcesByRack), since either PSU can go
// to a PDU/UPS in any rack, not just this device's own.
function PsuField({ slot, allSlots, racks, fieldPrefix, label, fields, onChange }) {
  const [editing, setEditing] = useState(false);
  const [pendingSourceId, setPendingSourceId] = useState(null);

  const sourceIdKey = fieldPrefix === 'psu2' ? 'psu2_source_slot_id' : 'power_source_slot_id';
  const outletKey    = fieldPrefix === 'psu2' ? 'psu2_source_outlet'  : 'power_source_outlet';
  // PSU1 unconnected reads as "Wall (Direct)" (a device really is drawing
  // straight from the wall) — PSU2 unconnected reads as "Not connected"
  // (it's simply not in use), per the spec for the optional second cord.
  const unsetLabel = fieldPrefix === 'psu2' ? 'Not connected' : 'Wall (Direct)';

  const groups = groupPowerSourcesByRack(allSlots, racks, slot.id);
  const currentSourceId = fields[sourceIdKey];
  const currentOutlet = fields[outletKey];
  const currentSourceSlot = currentSourceId ? allSlots.find((s) => s.id === currentSourceId) : null;

  const currentSourceOutlets = currentSourceSlot ? flattenOutlets(currentSourceSlot) : [];
  const currentOutletInfo = currentOutlet != null ? currentSourceOutlets.find((o) => o.n === currentOutlet) : null;
  const sourceHasMultipleGroups = currentSourceOutlets.some((o) => o.groupIndex > 1);

  const summary = currentSourceId
    ? `${getPowerSourceLabel(currentSourceSlot, allSlots)} → ${
        sourceHasMultipleGroups && currentOutletInfo
          ? `${currentOutletInfo.type} — Group ${currentOutletInfo.groupIndex} / Outlet ${currentOutletInfo.indexInGroup}`
          : `Outlet ${currentOutlet}`
      }`
    : unsetLabel;

  const startEditing = () => {
    setPendingSourceId(currentSourceId || null);
    setEditing(true);
  };

  const handleSourceChange = (val) => {
    if (val === WALL_DIRECT) {
      onChange({ [sourceIdKey]: null, [outletKey]: null });
      setEditing(false);
      return;
    }
    // Selecting a different power device always clears the outlet step —
    // re-picking the device that's already wired keeps showing its outlet.
    setPendingSourceId(Number(val));
  };

  const handleOutletChange = (n) => {
    onChange({ [sourceIdKey]: pendingSourceId, [outletKey]: n });
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="props-field">
        <label className="props-field-label">{label}</label>
        <div className="props-plugged-summary">
          <span className="props-plugged-summary-text">{summary}</span>
          <button type="button" className="props-upload-btn" onClick={startEditing}>Change</button>
        </div>
      </div>
    );
  }

  const selectedSourceEntry = pendingSourceId != null
    ? groups.flatMap((g) => g.sources).find((s) => s.slot.id === pendingSourceId)
    : null;
  const outletValue = pendingSourceId === currentSourceId ? (currentOutlet || '') : '';

  return (
    <div className="props-field">
      <label className="props-field-label">{label}</label>
      <select
        className="props-input"
        value={pendingSourceId == null ? WALL_DIRECT : String(pendingSourceId)}
        onChange={(e) => handleSourceChange(e.target.value)}
        autoFocus
      >
        <option value={WALL_DIRECT}>{unsetLabel}</option>
        {groups.map((g) => (
          <optgroup key={g.rackId} label={g.rackName}>
            {g.sources.map(({ slot: sourceSlot }) => (
              <option key={sourceSlot.id} value={sourceSlot.id}>{getPowerSourceLabel(sourceSlot, allSlots)}</option>
            ))}
          </optgroup>
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
          {(() => {
            const outlets = selectedSourceEntry.outlets;
            const hasMultipleGroups = outlets.some((o) => o.groupIndex > 1);
            return outlets.map(({ n, groupIndex, type, indexInGroup, occupant, occupantPsu }) => {
              const occupiedByOther = occupant && !(occupant.id === slot.id && occupantPsu === fieldPrefix);
              const label = hasMultipleGroups
                ? `${type} — Group ${groupIndex} / Outlet ${indexInGroup}`
                : `${type} — Outlet ${indexInGroup}`;
              return (
                <option key={n} value={n} disabled={Boolean(occupiedByOther)}>
                  {label}{occupiedByOther ? ` — in use (${getPowerLabel(occupant)})` : ''}
                </option>
              );
            });
          })()}
        </select>
      )}

      <button type="button" className="props-upload-btn" style={{ marginTop: 6 }} onClick={() => setEditing(false)}>Cancel</button>
    </div>
  );
}

// Picks which device is plugged into this ATS's single outlet — the
// reverse direction of every other "Plugged Into" editing in this panel
// (which always edits the *consuming* device's own power_source_slot_id).
// An ATS only has the one outlet, so rather than making the user go find
// the downstream device and edit *its* Plugged Into field, this writes
// power_source_slot_id/outlet=1 directly onto whichever device is picked
// here — clearing the previously-assigned one first, since only one
// device can occupy that single outlet at a time.
function AtsOutputField({ ats, allSlots, actions, onSelectSlot }) {
  const candidates = allSlots.filter((s) =>
    s.id !== ats.id && !isPassiveItem(s) && !isPowerDevice(s) && s.item_type !== 'vertical-pdu'
  );
  // The ATS has exactly one outlet — whichever device's PSU1 or PSU2
  // claims it (checking both, since a dual-PSU device could have the
  // ATS on either cord) is the current Output.
  const occupant = findOccupant(allSlots, ats.id, 1);
  const current = occupant?.slot || null;
  const currentField = occupant?.psu === 'psu2' ? { id: 'psu2_source_slot_id', outlet: 'psu2_source_outlet' } : { id: 'power_source_slot_id', outlet: 'power_source_outlet' };

  const handleChange = async (e) => {
    const newId = e.target.value ? Number(e.target.value) : null;
    if (newId === (current?.id ?? null)) return;
    if (current) {
      await actions.onSlotUpdate(current, { [currentField.id]: null, [currentField.outlet]: null });
    }
    if (newId) {
      const target = candidates.find((c) => c.id === newId);
      if (target) await actions.onSlotUpdate(target, { power_source_slot_id: ats.id, power_source_outlet: 1 });
    }
  };

  return (
    <div className="props-field">
      <label className="props-field-label">Output</label>
      <select className="props-input" value={current?.id || ''} onChange={handleChange}>
        <option value="">Not connected</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>{getPowerLabel(c)}</option>
        ))}
      </select>
      {current && (
        <button
          type="button"
          className="props-upload-btn"
          style={{ marginTop: 6 }}
          onClick={() => onSelectSlot && onSelectSlot(current.id)}
        >
          Jump to {getPowerLabel(current)}
        </button>
      )}
    </div>
  );
}

function PowerOutletList({ slot, allSlots, onSelectSlot }) {
  // Project-wide and checking both PSU columns — the device plugged into
  // a given outlet can be in any rack, on either of its two power cords.
  const outlets = Array.from({ length: getOutletCount(slot) }, (_, i) => {
    const n = i + 1;
    const occupant = allSlots.find((s) =>
      (s.power_source_slot_id === slot.id && s.power_source_outlet === n)
      || (s.psu2_source_slot_id === slot.id && s.psu2_source_outlet === n)
    );
    const occupantPsu = occupant && occupant.psu2_source_slot_id === slot.id && occupant.psu2_source_outlet === n ? 'PSU 2' : null;
    return { n, occupant, occupantPsu };
  });

  return (
    <div className="props-outlet-list">
      {outlets.map(({ n, occupant, occupantPsu }) => (
        <div
          key={n}
          className={`props-outlet-row${occupant ? ' has-occupant' : ''}`}
          onClick={() => occupant && onSelectSlot && onSelectSlot(occupant.id)}
          title={occupant ? `Jump to ${getPowerLabel(occupant)}` : undefined}
        >
          <span className="props-outlet-num">{n}</span>
          <span className="props-outlet-name">
            {occupant ? `${getPowerLabel(occupant)}${occupantPsu ? ` (${occupantPsu})` : ''}` : 'Empty'}
          </span>
        </div>
      ))}
    </div>
  );
}

function VerticalPduSection({ ups, rackSlots, allSlots, userCatalogEntries, rackHeight, actions, onSelectSlot }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  // Vertical/0U models only — PDU - Horizontal is a real U-slot device
  // placed normally on a face, it never belongs in this floating-strip list.
  const catalogEntries = pduCatalogEntries();
  const customPdus = userCatalogEntries.filter((c) => c.render_type === 'pdu-vertical');
  const [sourceKey, setSourceKey] = useState('');

  const attached = verticalPdusForUps(rackSlots, ups.id);
  // Position is assigned rack-wide (by stored mount_side/vertical_pdu_position,
  // falling back to creation order for older data — see
  // computeVerticalPduPositions), matching RackEnclosure's layout. This is
  // the PDU's logical slot and doesn't change when Rear is toggled.
  const allRackPdus = rackSlots.filter((s) => s.item_type === 'vertical-pdu');
  const pduPositions = computeVerticalPduPositions(allRackPdus);
  // Each side rail channel holds up to 2, independently — full only once
  // *both* channels are full (4 PDUs total), not at 2 rack-wide.
  const bothSidesTaken = !resolveVerticalPduSide({ verticalPdus: allRackPdus, side: 'left' }).ok
    && !resolveVerticalPduSide({ verticalPdus: allRackPdus, side: 'right' }).ok;

  const openAdd = () => {
    setSourceKey(catalogEntries[0] ? `catalog:${catalogEntries[0].id}` : (customPdus[0] ? `custom:${customPdus[0].id}` : ''));
    setError(null);
    setAdding(true);
  };

  const handleAdd = () => {
    const sideResolved = resolveVerticalPduSide({ verticalPdus: allRackPdus, side: undefined });
    if (!sideResolved.ok) { setError(sideResolved.error); return; }
    if (!sourceKey) { setError('Choose a PDU model'); return; }
    const outlet = firstFreeOutlet(ups, allSlots);
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

    // Half the rack's height, anchored at the top, rather than the full
    // height — a real 0U strip doesn't span floor-to-ceiling, and leaving
    // the bottom half open gives the power cord's curve down to the UPS
    // (wherever it's mounted) room to actually read as a curve.
    const pduSize = Math.max(1, Math.round(rackHeight * 0.5));
    const pduPosition = rackHeight - pduSize + 1;

    actions.onSlotCreate({
      rack_id: ups.rack_id,
      item_type: 'vertical-pdu',
      u_position: pduPosition,
      u_size: pduSize,
      mount_side: sideResolved.side,
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
      {attached.length === 0 && !adding && !bothSidesTaken && (
        <p className="props-empty-note">No vertical PDUs attached.</p>
      )}
      {attached.length > 0 && (
        <div className="props-outlet-list">
          {attached.map((pdu) => (
            <div key={pdu.id} className="props-outlet-row has-occupant" onClick={() => onSelectSlot && onSelectSlot(pdu.id)}>
              <span className="props-outlet-name">
                {pdu.item_label || 'PDU'} ({VERTICAL_PDU_POSITION_LABELS[pduPositions.get(pdu.id)?.side] || 'Left'})
              </span>
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
      ) : bothSidesTaken ? (
        <p className="props-empty-note">Both Left and Right vertical PDU positions are already in use on this rack.</p>
      ) : (
        <button type="button" className="props-upload-btn" onClick={openAdd} disabled={catalogEntries.length === 0 && customPdus.length === 0}>
          <Plus size={12} /> Add Vertical PDU
        </button>
      )}
    </>
  );
}
