import React, { useRef, useState } from 'react';
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

// Resolve the canonical mounted face for a slot, handling legacy front_back/side columns.
function resolveface(s) {
  if (s.mounted_face) return s.mounted_face;
  if (s.front_back === 'back' || s.side === 'back') return 'rear';
  if (s.side === 'both') return 'both';
  return 'front';
}

// Build a U-map from slots visible on a given face.
// Returns { slotsByTop, covered, occupiedByU }
function buildUMap(slots, face) {
  const visible = slots.filter((s) => {
    const mf = resolveface(s);
    if (face === 'front') return mf === 'front' || mf === 'both';
    return mf === 'rear' || mf === 'both';
  });
  const slotsByTop = {};
  const covered = new Set();
  const occupiedByU = new Map();
  for (const s of visible) {
    const top = s.u_position + s.u_size - 1;
    slotsByTop[top] = s;
    for (let u = s.u_position; u <= top; u++) {
      covered.add(u);
      occupiedByU.set(u, s.id);
    }
  }
  return { slotsByTop, covered, occupiedByU };
}

// One face panel (front or rear)
function RackPanel({
  face,
  showLeftRail,
  showRightRail,
  uRows,
  uHeight,
  rack,
  slotsByTop,
  covered,
  occupiedByU,
  halfDepthStripes,
  highlightedSlotId,
  selectedSlotId,
  draggingMeta,
  setDraggingMeta,
  actions,
  onDrop,
  onSelectSlot,
}) {
  return (
    <div className={`rack-panel-frame rack-panel-frame-${face}`}>
      <div className="rack-panel-label">{face === 'front' ? 'FRONT' : 'REAR'}</div>
      <div className="rack-top-blank" />
      <div className="rack-body">
        {showLeftRail && (
          <div className="rack-rail rack-rail-left">
            {uRows.map((u) => (
              <div key={u} className="rack-rail-number">{u}</div>
            ))}
          </div>
        )}
        <div className="rack-units" key={face}>
          {uRows.map((u) => {
            const slot = slotsByTop[u];
            if (slot) {
              return (
                <DeviceBlock
                  key={`slot-${slot.id}`}
                  slot={slot}
                  side={face}
                  uHeight={uHeight}
                  highlighted={slot.id === highlightedSlotId}
                  isSelected={slot.id === selectedSlotId}
                  setDraggingMeta={setDraggingMeta}
                  actions={actions}
                  onSelect={onSelectSlot}
                />
              );
            }
            if (covered.has(u)) return null;

            // Half-depth stripe from opposite panel
            if (halfDepthStripes.has(u)) {
              const stripeSlot = halfDepthStripes.get(u);
              return (
                <DeviceBlock
                  key={`stripe-${u}`}
                  slot={{ ...stripeSlot, halfDepthStripe: true }}
                  side={face}
                  uHeight={uHeight}
                  highlighted={false}
                  isSelected={false}
                  setDraggingMeta={setDraggingMeta}
                  actions={actions}
                />
              );
            }

            const band = Math.floor((u - 1) / 5) % 2;
            return (
              <RackUnitSlot
                key={`unit-${u}`}
                u={u}
                band={band}
                draggingMeta={draggingMeta}
                occupiedByU={occupiedByU}
                onDrop={(uPos, e) => onDrop(rack.id, uPos, face, e)}
              />
            );
          })}
        </div>
        {showRightRail && (
          <div className="rack-rail rack-rail-right">
            {uRows.map((u) => (
              <div key={u} className="rack-rail-number">{u}</div>
            ))}
          </div>
        )}
      </div>
      <div className="rack-bottom-blank" />
    </div>
  );
}

export default function RackEnclosure({
  rack,
  slots,
  highlightedSlotId,
  selectedSlotId,
  actions,
  draggingMeta,
  setDraggingMeta,
  onDrop,
  onFocus,
  isFocused,
  uHeight,
  onSelectSlot,
}) {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState(null);
  const [exporting, setExporting] = useState(false);
  const frameRef = useRef(null);

  const uRows = Array.from({ length: rack.u_height }, (_, i) => rack.u_height - i);

  const frontMap = buildUMap(slots, 'front');
  const rearMap  = buildUMap(slots, 'rear');

  // Half-depth front devices → show 1U stripe per occupied row in rear panel.
  // Each entry must be 1U tall so that N occupied rows produce exactly N×uHeight
  // of visual space — matching the device's own height in the front panel.
  // (Storing the full slot object here caused each row to render at u_size×uHeight,
  // creating N² total height instead of N, displacing every device below.)
  const rearStripes = new Map();
  for (const s of slots) {
    const mf = resolveface(s);
    if (mf === 'front' && s.half_depth) {
      const top = s.u_position + s.u_size - 1;
      for (let u = s.u_position; u <= top; u++) {
        if (!rearMap.covered.has(u)) rearStripes.set(u, { ...s, u_size: 1 });
      }
    }
  }

  // Half-depth rear devices → show 1U stripe per occupied row in front panel.
  const frontStripes = new Map();
  for (const s of slots) {
    const mf = resolveface(s);
    if (mf === 'rear' && s.half_depth) {
      const top = s.u_position + s.u_size - 1;
      for (let u = s.u_position; u <= top; u++) {
        if (!frontMap.covered.has(u)) frontStripes.set(u, { ...s, u_size: 1 });
      }
    }
  }

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
      const dataUrl = await toPng(el, { backgroundColor: '#0a0a0f', width: el.offsetWidth, height: el.offsetHeight });
      const filename = rack.name.trim().replace(/\s+/g, '-').toLowerCase() || 'rack';
      if (format === 'pdf') {
        const pdf = new jsPDF({ orientation: el.offsetWidth >= el.offsetHeight ? 'landscape' : 'portrait', unit: 'px', format: [el.offsetWidth, el.offsetHeight] });
        pdf.addImage(dataUrl, 'PNG', 0, 0, el.offsetWidth, el.offsetHeight);
        pdf.save(`rack-${filename}.pdf`);
      } else {
        const a = document.createElement('a');
        a.download = `rack-${filename}.png`;
        a.href = dataUrl;
        a.click();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Rack export failed', err);
    } finally {
      setExporting(false);
    }
  };

  const panelProps = {
    uRows,
    uHeight,
    rack,
    highlightedSlotId,
    selectedSlotId,
    draggingMeta,
    setDraggingMeta,
    actions,
    onDrop,
    onSelectSlot,
  };

  return (
    <div className={`rack-enclosure${isFocused ? ' rack-enclosure-focused' : ''}`} id={`rack-${rack.id}`}>
      {/* Header: rack name + actions. Sticky while scrolling. */}
      <div className="rack-header" onClick={onFocus}>
        <div className="rack-badge">
          <span className="rack-badge-name">{rack.name}</span>
          {rack.location && <span className="rack-badge-loc">{rack.location}</span>}
          <span className="rack-badge-u">{rack.u_height}U</span>
          <div className="rack-badge-actions">
            <button type="button" className="rack-badge-icon-btn" title="Export PNG" disabled={exporting}
              onClick={(e) => { e.stopPropagation(); handleExport('png'); }}>
              <Download size={13} />
            </button>
            <button type="button" className="rack-badge-icon-btn" title="Export PDF" disabled={exporting}
              onClick={(e) => { e.stopPropagation(); handleExport('pdf'); }}>
              <FileDown size={13} />
            </button>
            <button type="button" className="rack-badge-icon-btn" title="Edit rack"
              onClick={(e) => { e.stopPropagation(); startEdit(); }}>
              <Pencil size={13} />
            </button>
            <button type="button" className="rack-badge-icon-btn rack-badge-danger" title="Delete rack"
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}>
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {editing && (
          <form className="rack-edit-form" onSubmit={submitEdit} onClick={(e) => e.stopPropagation()}>
            <input value={edits.name} onChange={(e) => setEdits({ ...edits, name: e.target.value })} placeholder="Name" required />
            <input value={edits.location} onChange={(e) => setEdits({ ...edits, location: e.target.value })} placeholder="Location" />
            <input type="number" min="1" max="100" value={edits.u_height}
              onChange={(e) => setEdits({ ...edits, u_height: Number(e.target.value) })} placeholder="U Height" />
            <select value={edits.rack_type} onChange={(e) => setEdits({ ...edits, rack_type: e.target.value })}>
              {RACK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <button type="submit">Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        )}
      </div>

      {/* Dual-panel rack frame */}
      <div className="rack-dual-frame" ref={frameRef} style={{ '--u-height': `${uHeight}px` }} onClick={onFocus}>
        <RackPanel
          face="front"
          showLeftRail
          showRightRail={false}
          slotsByTop={frontMap.slotsByTop}
          covered={frontMap.covered}
          occupiedByU={frontMap.occupiedByU}
          halfDepthStripes={frontStripes}
          {...panelProps}
        />
        <div className="rack-panel-divider" />
        <RackPanel
          face="rear"
          showLeftRail={false}
          showRightRail
          slotsByTop={rearMap.slotsByTop}
          covered={rearMap.covered}
          occupiedByU={rearMap.occupiedByU}
          halfDepthStripes={rearStripes}
          {...panelProps}
        />
      </div>
    </div>
  );
}
