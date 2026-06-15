import React, { useEffect, useRef, useState } from 'react';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { Pencil, Trash2, Download, FileDown } from 'lucide-react';
import DeviceBlock from './DeviceBlock';
import RackUnitSlot from './RackUnitSlot';
import './RackEnclosure.css';

const RACK_TYPES = [
  { value: '4-post', label: '4-Post Rack' },
  { value: '2-post', label: '2-Post Rack' },
  { value: 'wall-mount', label: 'Wall Mount' },
  { value: 'open-frame', label: 'Open Frame' },
  { value: 'blade-enclosure', label: 'Blade Enclosure' },
];

// One rack's full visual: steel enclosure, U-numbered rails, front/back
// toggle, device blocks/empty slots, rename/resize/delete, and PNG/PDF export.
export default function RackEnclosure({
  rack,
  slots,
  highlightedSlotId,
  actions,
  draggingMeta,
  setDraggingMeta,
  onDrop,
  onFocus,
  isFocused,
  uHeight,
}) {
  // The view side ("which face of the rack am I looking at") is per-rack UI
  // state, persisted to localStorage so it survives reloads but never hits
  // the DB.
  const [side, setSide] = useState(() => {
    try {
      return window.localStorage.getItem(`rack-view-side-${rack.id}`) === 'back' ? 'back' : 'front';
    } catch {
      return 'front';
    }
  });

  const changeSide = (next) => {
    setSide(next);
    try {
      window.localStorage.setItem(`rack-view-side-${rack.id}`, next);
    } catch {
      // ignore (e.g. localStorage disabled)
    }
  };

  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState(null);
  const [exporting, setExporting] = useState(false);
  const frameRef = useRef(null);

  useEffect(() => {
    if (highlightedSlotId == null) return;
    const slot = slots.find((s) => s.id === highlightedSlotId);
    if (slot) changeSide(slot.front_back === 'back' ? 'back' : 'front');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedSlotId, slots]);

  // The Front/Back toggle is a *view* of the rack, not a filter: every device
  // stays visible and just switches between its front and back faceplate
  // (LEDs/ports vs PSU/exhaust). The only time a slot is hidden is when
  // another slot mounted on the opposite rail occupies the same U range -
  // then the slot matching the current view side wins.
  const primarySlots = slots.filter((s) => (s.front_back || 'front') === side);
  const primaryCovered = new Set();
  for (const s of primarySlots) {
    for (let u = s.u_position; u <= s.u_position + s.u_size - 1; u++) primaryCovered.add(u);
  }
  const otherSide = side === 'front' ? 'back' : 'front';
  const secondarySlots = slots.filter((s) => {
    if ((s.front_back || 'front') !== otherSide) return false;
    for (let u = s.u_position; u <= s.u_position + s.u_size - 1; u++) {
      if (primaryCovered.has(u)) return false;
    }
    return true;
  });
  const visibleSlots = [...primarySlots, ...secondarySlots];

  const slotsByTop = {};
  const covered = new Set();
  const occupiedByU = new Map();
  for (const s of visibleSlots) {
    const top = s.u_position + s.u_size - 1;
    slotsByTop[top] = s;
    for (let u = s.u_position; u <= top; u++) {
      covered.add(u);
      occupiedByU.set(u, s.id);
    }
  }

  const uRows = Array.from({ length: rack.u_height }, (_, i) => rack.u_height - i);

  const startEdit = () => {
    setEdits({
      name: rack.name,
      location: rack.location || '',
      u_height: rack.u_height,
      rack_type: rack.rack_type || '4-post',
      notes: rack.notes || '',
    });
    setEditing(true);
  };

  const submitEdit = (e) => {
    e.preventDefault();
    actions.onRackSave(rack.id, edits);
    setEditing(false);
  };

  const handleDelete = () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete rack "${rack.name}" and all its slots? This cannot be undone.`)) return;
    actions.onRackDelete(rack.id);
  };

  const handleExport = async (format) => {
    if (!frameRef.current) return;
    setExporting(true);
    try {
      const el = frameRef.current;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const dataUrl = await toPng(el, { backgroundColor: '#0a0a0f', width, height });
      const filename = rack.name.trim().replace(/\s+/g, '-').toLowerCase() || 'rack';

      if (format === 'pdf') {
        const orientation = width >= height ? 'landscape' : 'portrait';
        const pdf = new jsPDF({ orientation, unit: 'px', format: [width, height] });
        pdf.addImage(dataUrl, 'PNG', 0, 0, width, height);
        pdf.save(`rack-${filename}.pdf`);
      } else {
        const link = document.createElement('a');
        link.download = `rack-${filename}.png`;
        link.href = dataUrl;
        link.click();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Rack export failed', err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={`rack-enclosure${isFocused ? ' rack-enclosure-focused' : ''}`} id={`rack-${rack.id}`}>
      <div className="rack-badge" onClick={onFocus}>
        <span className="rack-badge-name">{rack.name}</span>
        <span className="rack-badge-u">{rack.u_height}U</span>
        <div className="rack-badge-actions">
          <div className="rack-side-toggle">
            <button
              type="button"
              className={side === 'front' ? 'active' : ''}
              onClick={(e) => {
                e.stopPropagation();
                changeSide('front');
              }}
            >
              Front
            </button>
            <button
              type="button"
              className={side === 'back' ? 'active' : ''}
              onClick={(e) => {
                e.stopPropagation();
                changeSide('back');
              }}
            >
              Back
            </button>
          </div>
          <button
            type="button"
            className="rack-badge-icon-btn"
            title="Export PNG"
            disabled={exporting}
            onClick={(e) => {
              e.stopPropagation();
              handleExport('png');
            }}
          >
            <Download size={13} />
          </button>
          <button
            type="button"
            className="rack-badge-icon-btn"
            title="Export PDF"
            disabled={exporting}
            onClick={(e) => {
              e.stopPropagation();
              handleExport('pdf');
            }}
          >
            <FileDown size={13} />
          </button>
          <button
            type="button"
            className="rack-badge-icon-btn"
            title="Edit rack"
            onClick={(e) => {
              e.stopPropagation();
              startEdit();
            }}
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            className="rack-badge-icon-btn rack-badge-danger"
            title="Delete rack"
            onClick={(e) => {
              e.stopPropagation();
              handleDelete();
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {editing && (
        <form className="rack-edit-form" onSubmit={submitEdit} onClick={(e) => e.stopPropagation()}>
          <input
            value={edits.name}
            onChange={(e) => setEdits({ ...edits, name: e.target.value })}
            placeholder="Name"
            required
          />
          <input
            value={edits.location}
            onChange={(e) => setEdits({ ...edits, location: e.target.value })}
            placeholder="Location"
          />
          <input
            type="number"
            min="4"
            max="52"
            value={edits.u_height}
            onChange={(e) => setEdits({ ...edits, u_height: Number(e.target.value) })}
            placeholder="U Height"
          />
          <select value={edits.rack_type} onChange={(e) => setEdits({ ...edits, rack_type: e.target.value })}>
            {RACK_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button type="submit">Save</button>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}

      <div className="rack-frame" ref={frameRef} style={{ '--u-height': `${uHeight}px` }}>
        <div className="rack-panel rack-panel-top" />
        <div className="rack-body">
          <div className="rack-rail rack-rail-left">
            {uRows.map((u) => (
              <div key={u} className="rack-rail-number">
                {u}
              </div>
            ))}
          </div>
          <div className="rack-units" key={side}>
            {uRows.map((u) => {
              const slot = slotsByTop[u];
              if (slot) {
                return (
                  <DeviceBlock
                    key={slot.id}
                    slot={slot}
                    side={side}
                    uHeight={uHeight}
                    highlighted={slot.id === highlightedSlotId}
                    setDraggingMeta={setDraggingMeta}
                    actions={actions}
                  />
                );
              }
              if (covered.has(u)) return null;
              const band = Math.floor((u - 1) / 5) % 2;
              return (
                <RackUnitSlot
                  key={u}
                  u={u}
                  band={band}
                  draggingMeta={draggingMeta}
                  occupiedByU={occupiedByU}
                  onDrop={(uPos, e) => onDrop(rack.id, uPos, side, e)}
                />
              );
            })}
          </div>
          <div className="rack-rail rack-rail-right">
            {uRows.map((u) => (
              <div key={u} className="rack-rail-number">
                {u}
              </div>
            ))}
          </div>
        </div>
        <div className="rack-panel rack-panel-bottom" />
      </div>
    </div>
  );
}
