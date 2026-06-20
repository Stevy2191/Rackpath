import React, { useState } from 'react';
import { clampUPosition } from './rackPlacement';

// One empty rack-unit row: a drop target for devices/catalog items, with a
// blue (ok) or red (collision) highlight while something is being dragged
// over it.
export default function RackUnitSlot({ u, band, is5th, draggingMeta, occupiedByU, rackUHeight, onDrop }) {
  const [dragOverState, setDragOverState] = useState(null); // null | 'ok' | 'collision'

  const handleDragOver = (e) => {
    e.preventDefault();
    if (!draggingMeta) {
      setDragOverState('ok');
      return;
    }
    const { uSize, excludeSlotId } = draggingMeta;
    const uPosition = clampUPosition(u, uSize, rackUHeight);
    const top = uPosition + uSize - 1;
    let state = 'ok';
    for (let pos = uPosition; pos <= top; pos++) {
      const owner = occupiedByU.get(pos);
      if (owner !== undefined && owner !== excludeSlotId) {
        state = 'collision';
        break;
      }
    }
    setDragOverState(state);
  };

  const handleDrop = (e) => {
    setDragOverState(null);
    onDrop(u, e);
  };

  return (
    <div
      className={`rack-unit-slot rack-unit-band-${band}${is5th ? ' rack-unit-5th' : ''}${dragOverState ? ` drop-${dragOverState}` : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOverState(null)}
      onDrop={handleDrop}
    >
      <span className="rack-unit-slot-number">{u}</span>
    </div>
  );
}
