import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Share2, MoreVertical } from 'lucide-react';
import DeviceFacePlate from './DeviceFacePlate';
import { VENDOR_COLORS } from './rackCatalog';
import './DeviceBlock.css';

const STATUS_LED_CLASS = { up: 'led-online', down: 'led-offline' };

export function getDeviceLabel(slot) {
  const isDevice = slot.item_type === 'device';
  const name = isDevice ? slot.hostname || slot.ip || `Device ${slot.device_id}` : slot.item_label || 'Device';
  const subtitle = slot.vendor || slot.custom_type || null;
  return { name, subtitle };
}

export default function DeviceBlock({
  slot,
  side,
  uHeight,
  highlighted,
  isSelected,
  setDraggingMeta,
  actions,
  onSelect,
}) {
  const navigate = useNavigate();
  const tooltipTimer = useRef(null);
  const [tooltip, setTooltip] = useState(false);

  const ledClass = STATUS_LED_CLASS[slot.device_status] || 'led-unknown';
  const vendorColor = VENDOR_COLORS[slot.vendor] || '#555';
  const badgeText = (slot.vendor || slot.device_type || slot.custom_type || '?').slice(0, 3).toUpperCase();
  const { name } = getDeviceLabel(slot);

  const isHalfDepthStripe = slot.halfDepthStripe;

  const handleMouseEnter = () => {
    tooltipTimer.current = setTimeout(() => setTooltip(true), 500);
  };

  const handleMouseLeave = () => {
    clearTimeout(tooltipTimer.current);
    setTooltip(false);
  };

  const handleDragStart = (e) => {
    e.dataTransfer.setData('text/slot-id', String(slot.id));
    setDraggingMeta({ uSize: slot.u_size, excludeSlotId: slot.id });
    setTooltip(false);
    clearTimeout(tooltipTimer.current);
  };

  const blockHeight = `${slot.u_size * (uHeight || 40)}px`;

  if (isHalfDepthStripe) {
    return (
      <div
        className="device-block device-block-halfdepth-stripe"
        style={{ height: blockHeight }}
        title="Half-depth device on opposite face"
      />
    );
  }

  return (
    <div
      className={[
        'device-block',
        highlighted ? 'device-block-highlighted' : '',
        isSelected ? 'device-block-selected' : '',
      ].filter(Boolean).join(' ')}
      style={{ height: blockHeight }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={() => setDraggingMeta(null)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={(e) => {
        if (e.defaultPrevented) return;
        onSelect && onSelect(slot.id);
      }}
      data-slot-id={slot.id}
      data-device-id={slot.device_id || ''}
    >
      <div className="device-block-vendor-badge" style={{ background: vendorColor }} title={slot.vendor || ''}>
        {badgeText}
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
              e.preventDefault();
              navigate(`/topology?focusDevice=${slot.device_id}`);
            }}
          >
            <Share2 size={11} />
          </button>
        )}
        <button
          type="button"
          className="device-block-icon-btn"
          title="Options"
          onClick={(e) => {
            e.preventDefault();
            actions.onOpenContextMenu(slot, e.clientX, e.clientY);
          }}
        >
          <MoreVertical size={11} />
        </button>
      </div>

      {tooltip && (
        <div className="device-block-tooltip">
          <strong>{name}</strong>
          {slot.ip_address && <span>{slot.ip_address}</span>}
          {slot.slot_notes && <span className="device-block-tooltip-notes">{slot.slot_notes}</span>}
        </div>
      )}
    </div>
  );
}
