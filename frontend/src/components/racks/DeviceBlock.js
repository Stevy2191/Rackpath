import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Share2, MoreVertical } from 'lucide-react';
import DeviceFacePlate from './DeviceFacePlate';
import './DeviceBlock.css';

const STATUS_LED_CLASS = { up: 'led-online', down: 'led-offline' };

// One occupied rack slot: faceplate graphic, name/vendor labels, status LED,
// and hover actions (topology link, context menu). Draggable to move within
// or between racks/sides.
export default function DeviceBlock({ slot, side, highlighted, setDraggingMeta, actions }) {
  const navigate = useNavigate();

  const isDevice = slot.item_type === 'device';
  const name = isDevice ? slot.hostname || slot.ip || `Device ${slot.device_id}` : slot.item_label || 'Device';
  const subtitle = slot.vendor || slot.custom_type || null;
  const ledClass = STATUS_LED_CLASS[slot.device_status] || 'led-unknown';
  const badgeText = (slot.vendor || slot.device_type || slot.custom_type || '?').slice(0, 2).toUpperCase();

  const handleDragStart = (e) => {
    e.dataTransfer.setData('text/slot-id', String(slot.id));
    setDraggingMeta({ uSize: slot.u_size, excludeSlotId: slot.id });
  };

  const handleNameClick = () => {
    if (isDevice && slot.device_id) {
      actions.onOpenPortEditor({ id: slot.device_id, hostname: slot.hostname, ip: slot.ip });
    }
  };

  return (
    <div
      className={`device-block${highlighted ? ' device-block-highlighted' : ''}`}
      style={{ height: `${slot.u_size * 44}px` }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={() => setDraggingMeta(null)}
      data-slot-id={slot.id}
      data-device-id={slot.device_id || ''}
    >
      <div className="device-block-vendor-badge">{badgeText}</div>
      <div className="device-block-info">
        <button
          type="button"
          className={`device-block-name${isDevice ? ' linked' : ''}`}
          onClick={handleNameClick}
          title={name}
        >
          {name}
        </button>
        {subtitle && <span className="device-block-subtitle">{subtitle}</span>}
      </div>
      <DeviceFacePlate slot={slot} side={side} />
      <span className={`device-block-led ${ledClass}`} title={slot.device_status || 'unknown'} />
      <div className="device-block-actions">
        {slot.device_id && (
          <button
            type="button"
            className="device-block-icon-btn"
            title="View in Topology"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/topology?focusDevice=${slot.device_id}`);
            }}
          >
            <Share2 size={12} />
          </button>
        )}
        <button
          type="button"
          className="device-block-icon-btn"
          title="Options"
          onClick={(e) => {
            e.stopPropagation();
            actions.onOpenContextMenu(slot, e.clientX, e.clientY);
          }}
        >
          <MoreVertical size={12} />
        </button>
      </div>
    </div>
  );
}
