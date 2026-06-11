import React, { useState } from 'react';
import './Modal.css';

const ZONE_COLORS = ['blue', 'green', 'red', 'orange', 'purple', 'gray'];

export default function ZoneFormModal({ onSubmit, onCancel }) {
  const [name, setName] = useState('');
  const [borderStyle, setBorderStyle] = useState('solid');
  const [color, setColor] = useState('blue');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), border_style: borderStyle, color });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>New Zone</h2>
        <form className="modal-form" onSubmit={handleSubmit}>
          <label>
            Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Border Style
            <select value={borderStyle} onChange={(e) => setBorderStyle(e.target.value)}>
              <option value="solid">Solid</option>
              <option value="dotted">Dotted</option>
            </select>
          </label>
          <label>
            Color
            <div className="zone-color-picker">
              {ZONE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  className={`zone-color-swatch zone-color-${c}${color === c ? ' selected' : ''}`}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </label>
          <div className="modal-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit">Add Zone</button>
          </div>
        </form>
      </div>
    </div>
  );
}
