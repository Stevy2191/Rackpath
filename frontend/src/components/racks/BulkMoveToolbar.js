import React, { useState } from 'react';
import { ChevronUp, ChevronDown, X, Trash2 } from 'lucide-react';
import './BulkMoveToolbar.css';

export default function BulkMoveToolbar({ selectedCount, onMoveUp, onMoveDown, onMoveByN, onDeselectAll, onDelete }) {
  const [n, setN] = useState(5);

  const handleN = (e) => setN(Math.max(1, parseInt(e.target.value, 10) || 1));

  return (
    <div className="bulk-move-toolbar">
      <span className="bulk-move-count">{selectedCount} devices selected</span>
      <div className="bulk-move-sep" />
      <button type="button" className="bulk-move-btn" onClick={() => onMoveUp(1)} title="Move up 1U">
        <ChevronUp size={13} /> Up 1U
      </button>
      <button type="button" className="bulk-move-btn" onClick={() => onMoveDown(1)} title="Move down 1U">
        <ChevronDown size={13} /> Down 1U
      </button>
      <div className="bulk-move-sep" />
      <div className="bulk-move-n-row">
        <span>Move</span>
        <input
          type="number"
          min={1}
          max={100}
          value={n}
          onChange={handleN}
          className="bulk-move-n-input"
        />
        <span>U</span>
        <button type="button" className="bulk-move-btn" onClick={() => onMoveByN(n, 'up')}>Up</button>
        <button type="button" className="bulk-move-btn" onClick={() => onMoveByN(n, 'down')}>Down</button>
      </div>
      <div className="bulk-move-sep" />
      <button type="button" className="bulk-move-btn" onClick={onDeselectAll} title="Deselect all">
        <X size={13} /> Deselect
      </button>
      <button type="button" className="bulk-move-btn bulk-move-delete" onClick={onDelete} title="Delete selected">
        <Trash2 size={13} /> Delete
      </button>
    </div>
  );
}
