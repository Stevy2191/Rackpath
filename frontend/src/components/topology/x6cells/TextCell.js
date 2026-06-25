import React, { useState, useEffect, useRef } from 'react';
import { useTopologyGraph } from '../TopologyGraphContext';

export default function TextCell({ node }) {
  const { onLabelChange, onLabelDelete } = useTopologyGraph();
  const [, forceUpdate] = useState(0);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const refresh = () => forceUpdate((n) => n + 1);
    node.on('change:data', refresh);
    return () => node.off('change:data', refresh);
  }, [node]);

  // Open editor on dblclick signal from X6Canvas
  useEffect(() => {
    const openEditor = () => {
      const d = node.getData() || {};
      setValue(d.text || '');
      setEditing(true);
    };
    node.on('label:edit', openEditor);
    return () => node.off('label:edit', openEditor);
  }, [node]);

  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  const data = node.getData() || {};

  const commit = () => {
    setEditing(false);
    const next = value;
    if (next !== (data.text || '')) {
      onLabelChange(data.id, next);
      node.setData({ text: next });
    }
  };

  const stop = (e) => e.stopPropagation();

  return (
    <div
      className="x6-text-cell"
      style={{ fontSize: `${data.font_size || 14}px`, color: data.color || 'var(--color-text)' }}
    >
      {editing ? (
        <textarea
          ref={inputRef}
          className="x6-text-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onMouseDown={stop}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setValue(data.text || ''); setEditing(false); }
          }}
          rows={1}
          style={{ fontSize: `${data.font_size || 14}px` }}
        />
      ) : (
        <span className="x6-text-content">{data.text || 'Double-click to edit'}</span>
      )}
      {!editing && (
        <button
          className="x6-text-delete"
          onMouseDown={stop}
          onClick={(e) => { stop(e); onLabelDelete(node.id); }}
          aria-label="Delete label"
        >
          &times;
        </button>
      )}
    </div>
  );
}
