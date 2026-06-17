import React, { useEffect, useRef } from 'react';
import './RackContextMenu.css';

export default function RackContextMenu({ x, y, onClose, onExport, onFocus, onEditRack, onRename, onDuplicate, onDelete, onToggleAnnotations, showAnnotations }) {
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const act = (fn) => () => { onClose(); fn(); };

  return (
    <div className="rack-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <button type="button" className="rack-ctx-item" onClick={act(onExport)}>Export…</button>
      <button type="button" className="rack-ctx-item" onClick={act(onFocus)}>Focus</button>
      <button type="button" className="rack-ctx-item" onClick={act(onEditRack)}>Edit Rack</button>
      <button type="button" className="rack-ctx-item" onClick={act(onRename)}>Rename</button>
      <button type="button" className="rack-ctx-item" onClick={act(onDuplicate)}>Duplicate Rack</button>
      <button
        type="button"
        className="rack-ctx-item"
        onClick={act(onToggleAnnotations)}
      >
        {showAnnotations ? 'Hide Annotations' : 'Show Annotations'}
      </button>
      <div className="rack-ctx-divider" />
      <button type="button" className="rack-ctx-item rack-ctx-danger" onClick={act(onDelete)}>Delete Rack</button>
    </div>
  );
}
