import React, { useState } from 'react';
import { resolveUPosition } from './rackPlacement';

// One empty rack-unit row: a drop target for devices/catalog items, with a
// blue (ok) or red (collision) highlight while something is being dragged
// over it. `halfDepthStripe` marks this U as the opposite face of a
// half-depth device — still a real, droppable empty slot (it only warns
// that the near half of the rack's depth here is taken), unlike the
// non-interactive stripe rendered behind a full-depth device.
export default function RackUnitSlot({ u, band, is5th, halfDepthStripe, draggingMeta, occupiedByU, rackUHeight, onDrop }) {
  const [dragOverState, setDragOverState] = useState(null); // null | 'ok' | 'collision'

  const handleDragOver = (e) => {
    e.preventDefault();
    if (!draggingMeta) {
      setDragOverState('ok');
      return;
    }
    const { uSize, excludeSlotId } = draggingMeta;
    const isFree = (pos) => {
      for (let p = pos; p < pos + uSize; p++) {
        const owner = occupiedByU.get(p);
        if (owner !== undefined && owner !== excludeSlotId) return false;
      }
      return true;
    };
    const uPosition = resolveUPosition(u, uSize, rackUHeight, isFree);
    setDragOverState(isFree(uPosition) ? 'ok' : 'collision');
  };

  const handleDrop = (e) => {
    setDragOverState(null);
    onDrop(u, e);
  };

  return (
    <div
      className={`rack-unit-slot rack-unit-band-${band}${is5th ? ' rack-unit-5th' : ''}${halfDepthStripe ? ' rack-unit-halfdepth-stripe' : ''}${dragOverState ? ` drop-${dragOverState}` : ''}`}
      title={halfDepthStripe ? 'Half-depth device on opposite face — accepts another half-depth device here' : undefined}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOverState(null)}
      onDrop={handleDrop}
    >
      <span className="rack-unit-slot-number">{u}</span>
    </div>
  );
}
