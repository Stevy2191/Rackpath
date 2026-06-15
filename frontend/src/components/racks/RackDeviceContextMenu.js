import React, { useEffect, useRef, useState } from 'react';
import { Pencil, Link2, ArrowLeftRight, Trash2 } from 'lucide-react';
import './RackDeviceContextMenu.css';

export default function RackDeviceContextMenu({ slot, x, y, devices, onClose, actions }) {
  const ref = useRef(null);
  const [mode, setMode] = useState('menu');
  const [label, setLabel] = useState(slot.item_label || '');
  const [vendor, setVendor] = useState(slot.vendor || '');
  const [uSize, setUSize] = useState(slot.u_size);

  useEffect(() => {
    const handleMouseDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const saveEdit = () => {
    actions.onSlotUpdate(slot, { item_label: label, vendor, u_size: uSize });
    onClose();
  };

  const toggleFrontBack = () => {
    actions.onSlotUpdate(slot, { front_back: slot.front_back === 'back' ? 'front' : 'back' });
    onClose();
  };

  const linkDevice = (deviceId) => {
    if (!deviceId) return;
    actions.onSlotUpdate(slot, { device_id: Number(deviceId), item_type: 'device' });
    onClose();
  };

  const handleDelete = () => {
    actions.onSlotDelete(slot.id);
    onClose();
  };

  return (
    <div className="rack-context-menu" style={{ left: x, top: y }} ref={ref}>
      {mode === 'edit' && (
        <div className="rack-context-menu-form">
          <label>
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
          </label>
          <label>
            Vendor
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} />
          </label>
          <label>
            U Size
            <input
              type="number"
              min="1"
              value={uSize}
              onChange={(e) => setUSize(Math.max(1, Number(e.target.value)))}
            />
          </label>
          <div className="rack-context-menu-form-actions">
            <button type="button" onClick={() => setMode('menu')}>
              Back
            </button>
            <button type="button" className="primary" onClick={saveEdit}>
              Save
            </button>
          </div>
        </div>
      )}

      {mode === 'link' && (
        <div className="rack-context-menu-form">
          <label>
            Link to device
            <select defaultValue="" onChange={(e) => linkDevice(e.target.value)}>
              <option value="" disabled>
                Select a device&hellip;
              </option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname || d.ip || `Device ${d.id}`}
                </option>
              ))}
            </select>
          </label>
          <div className="rack-context-menu-form-actions">
            <button type="button" onClick={() => setMode('menu')}>
              Back
            </button>
          </div>
        </div>
      )}

      {mode === 'menu' && (
        <ul>
          <li>
            <button type="button" onClick={() => setMode('edit')}>
              <Pencil size={13} /> Edit
            </button>
          </li>
          <li>
            <button type="button" onClick={() => setMode('link')}>
              <Link2 size={13} /> Link to inventory device
            </button>
          </li>
          <li>
            <button type="button" onClick={toggleFrontBack}>
              <ArrowLeftRight size={13} /> Move to {slot.front_back === 'back' ? 'Front' : 'Back'}
            </button>
          </li>
          <li>
            <button type="button" className="danger" onClick={handleDelete}>
              <Trash2 size={13} /> Delete from rack
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
