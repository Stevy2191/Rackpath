import React from 'react';
import DeviceBlock from './DeviceBlock';
import RackUnitSlot from './RackUnitSlot';
import './RackEnclosure.css';

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

// Groups a Set of U row numbers into contiguous blocks.
// Returns Map<topU, { u_position, u_size }> — one entry per contiguous run.
function groupStripeRows(rowSet) {
  if (rowSet.size === 0) return new Map();
  const sorted = [...rowSet].sort((a, b) => a - b);
  const result = new Map();
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let size = 1;
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + size) {
      size++;
      i++;
    }
    result.set(start + size - 1, { u_position: start, u_size: size });
    i++;
  }
  return result;
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
  // Rows covered by the non-top portion of multi-U stripe blocks (return null for these).
  const stripesCovered = new Set();
  for (const [topU, { u_position }] of halfDepthStripes) {
    for (let u = u_position; u < topU; u++) {
      stripesCovered.add(u);
    }
  }

  return (
    <div className={`rack-panel-frame rack-panel-frame-${face}`}>
      <div className="rack-panel-label">{face === 'front' ? 'FRONT' : 'REAR'}</div>
      <div className="rack-top-blank" />
      <div className="rack-body">
        {showLeftRail && (
          <div className="rack-rail rack-rail-left">
            {uRows.map((u) => (
              <div key={u} className={`rack-rail-number${u % 5 === 0 ? ' rack-rail-5th' : ''}`}>{u}</div>
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
            if (stripesCovered.has(u)) return null;

            // Half-depth stripe from opposite panel — one continuous block per group.
            if (halfDepthStripes.has(u)) {
              const { u_position, u_size } = halfDepthStripes.get(u);
              return (
                <DeviceBlock
                  key={`stripe-${u}`}
                  slot={{ id: `stripe-${u}`, halfDepthStripe: true, u_position, u_size }}
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
                is5th={u % 5 === 0}
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
              <div key={u} className={`rack-rail-number${u % 5 === 0 ? ' rack-rail-5th' : ''}`}>{u}</div>
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
  const uRows = Array.from({ length: rack.u_height }, (_, i) => rack.u_height - i);

  const frontMap = buildUMap(slots, 'front');
  const rearMap  = buildUMap(slots, 'rear');

  // Half-depth front devices → rear panel stripes (grouped into contiguous blocks)
  const rearStripeRows = new Set();
  for (const s of slots) {
    if (resolveface(s) === 'front' && s.half_depth) {
      const top = s.u_position + s.u_size - 1;
      for (let u = s.u_position; u <= top; u++) {
        if (!rearMap.covered.has(u)) rearStripeRows.add(u);
      }
    }
  }
  const rearStripes = groupStripeRows(rearStripeRows);

  // Half-depth rear devices → front panel stripes
  const frontStripeRows = new Set();
  for (const s of slots) {
    if (resolveface(s) === 'rear' && s.half_depth) {
      const top = s.u_position + s.u_size - 1;
      for (let u = s.u_position; u <= top; u++) {
        if (!frontMap.covered.has(u)) frontStripeRows.add(u);
      }
    }
  }
  const frontStripes = groupStripeRows(frontStripeRows);

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

  const showRear = rack.show_rear !== undefined ? Boolean(rack.show_rear) : true;

  return (
    <div className={`rack-enclosure${isFocused ? ' rack-enclosure-focused' : ''}`} id={`rack-${rack.id}`}>
      <div className="rack-name-label">{rack.name}</div>
      <div className="rack-dual-frame" style={{ '--u-height': `${uHeight}px` }} onClick={onFocus}>
        <RackPanel
          face="front"
          showLeftRail
          showRightRail={!showRear}
          slotsByTop={frontMap.slotsByTop}
          covered={frontMap.covered}
          occupiedByU={frontMap.occupiedByU}
          halfDepthStripes={frontStripes}
          {...panelProps}
        />
        {showRear && (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
