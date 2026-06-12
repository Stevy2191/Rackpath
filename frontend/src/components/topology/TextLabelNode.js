import React, { memo, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import './TextLabelNode.css';

function TextLabelNode({ id, data, selected }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(data.text || '');
  const inputRef = useRef(null);

  useEffect(() => {
    setValue(data.text || '');
  }, [data.text]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = value;
    if (next !== (data.text || '')) data.onChange?.(id, next);
  };

  return (
    <div
      className={`text-label-node${selected ? ' selected' : ''}`}
      onDoubleClick={() => setEditing(true)}
      style={{ fontSize: `${data.font_size || 14}px`, color: data.color || 'var(--color-text)' }}
    >
      {editing ? (
        <textarea
          ref={inputRef}
          className="text-label-input nodrag"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              setValue(data.text || '');
              setEditing(false);
            }
          }}
          rows={1}
          style={{ fontSize: `${data.font_size || 14}px` }}
        />
      ) : (
        <span className="text-label-content">{data.text || 'Double-click to edit'}</span>
      )}

      {selected && !editing && (
        <button
          type="button"
          className="text-label-delete"
          onClick={() => data.onDelete?.(id)}
          aria-label="Delete label"
          title="Delete label"
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}

export default memo(TextLabelNode);
