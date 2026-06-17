import React from 'react';
import { getOutletCount } from '../../utils/power';

// Floating strip rendered alongside the rack frame, representing a PDU/UPS
// mounted vertically (not occupying U columns). Reuses u_position/u_size as
// the vertical start U / span U, same as horizontal slots.
export default function VerticalPdu({ slot, rack, uHeight, offsetPx, isSelected, highlighted, onSelect, actions }) {
  const top = 16 + (rack.u_height - (slot.u_position + slot.u_size - 1)) * uHeight;
  const height = slot.u_size * uHeight;
  const side = slot.mount_side === 'right' ? 'right' : 'left';
  const outletCount = getOutletCount(slot);
  const sideStyle = side === 'left' ? { left: -offsetPx } : { right: -offsetPx };

  return (
    <div
      className={[
        'rack-vertical-pdu',
        `rack-vertical-pdu-${side}`,
        isSelected ? 'rack-vertical-pdu-selected' : '',
        highlighted ? 'rack-vertical-pdu-highlighted' : '',
      ].filter(Boolean).join(' ')}
      style={{ top, height, ...sideStyle }}
      title={`${slot.item_label || 'PDU'} (${outletCount} outlets)`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect && onSelect(slot.id);
      }}
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
