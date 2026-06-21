import React, { useEffect, useRef, useState } from 'react';
import { Link2, ArrowLeftRight, Copy, Trash2 } from 'lucide-react';
import './RackDeviceContextMenu.css';

export default function RackDeviceContextMenu({ slot, x, y, devices, onClose, onDeleteRequest, actions }) {
  const ref = useRef(null);
  const [mode, setMode] = useState('menu');

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

  const toggleFrontBack = () => {
    const curFace = slot.mounted_face || (slot.front_back === 'back' || slot.side === 'back' ? 'rear' : 'front');
    const nextFace = curFace === 'rear' ? 'front' : 'rear';
    actions.onSlotUpdate(slot, { mounted_face: nextFace });
    onClose();
  };

  const linkDevice = (deviceId) => {
    if (!deviceId) return;
    actions.onSlotUpdate(slot, { device_id: Number(deviceId), item_type: 'device' });
    onClose();
  };

  const handleDelete = () => {
    onClose();
    onDeleteRequest(slot);
  };

  const handleDuplicate = () => {
    onClose();
    actions.onSlotDuplicate(slot);
  };

  return (
    <div className="rack-context-menu" style={{ left: x, top: y }} ref={ref}>
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
            <button type="button" onClick={() => setMode('link')}>
              <Link2 size={13} /> Link to inventory device
            </button>
          </li>
          <li>
            <button type="button" onClick={toggleFrontBack}>
              <ArrowLeftRight size={13} /> Move to {(slot.mounted_face === 'rear' || slot.front_back === 'back' || slot.side === 'back') ? 'Front' : 'Rear'}
            </button>
          </li>
          <li>
            <button type="button" onClick={handleDuplicate}>
              <Copy size={13} /> Duplicate
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
