import React from 'react';
import { getOutletCount } from '../../utils/power';

// Floating strip rendered alongside the rack frame, representing a PDU/UPS
// mounted vertically (not occupying U columns). Unlike a horizontal slot,
// its size is NOT derived from u_position/u_size — `top`/`height`/`leftPx`/
// `side` are all computed by the parent (RackEnclosure) as a fraction of
// the rack's own rendered height (see verticalPduLayout.pduBox), which is
// also what draws the power cord to this strip — keeping the position math
// in one place means the strip and its cord can never disagree.
export default function VerticalPdu({ slot, leftPx, top, height, side, isSelected, highlighted, onSelect, actions }) {
  const outletCount = getOutletCount(slot);
  // Same pattern as DeviceBlock's rack-mounted devices: a chosen color
  // overrides the default look entirely. Previously this prop was just
  // never read here, so picking a color in the properties panel saved
  // correctly but had no visible effect on the floating strip.
  const customStyle = slot.color ? { background: slot.color } : null;

  return (
    <div
      className={[
        'rack-vertical-pdu',
        `rack-vertical-pdu-${side}`,
        isSelected ? 'rack-vertical-pdu-selected' : '',
        highlighted ? 'rack-vertical-pdu-highlighted' : '',
      ].filter(Boolean).join(' ')}
      style={{ top, height, left: leftPx, ...customStyle }}
      data-pdu-id={slot.id}
      title={`${slot.item_label || 'PDU'} (${outletCount} outlets)`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect && onSelect(slot.id);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect && onSelect(slot.id);
        actions?.onOpenContextMenu(slot, e.clientX, e.clientY);
      }}
    >
      <div className="rack-vertical-pdu-ticks">
        {Array.from({ length: outletCount }, (_, i) => (
          <span key={i} className="rack-vertical-pdu-tick" />
        ))}
      </div>
      <span className="rack-vertical-pdu-label">{slot.item_label || 'PDU'}</span>
    </div>
  );
}
