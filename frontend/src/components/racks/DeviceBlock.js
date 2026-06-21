import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GripVertical, Share2, MoreVertical } from 'lucide-react';
import { getCategoryStyle } from './deviceRenderConfig';
import './DeviceBlock.css';

export function getDeviceLabel(slot) {
  const isDevice = slot.item_type === 'device';
  const name = isDevice ? slot.hostname || slot.ip || `Device ${slot.device_id}` : slot.item_label || 'Device';
  return { name };
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
    // One continuous block spanning the device's full height (u_size *
    // uHeight, same as every other device block), not one segment per U
    // row — a multi-U no-go zone is blocked solid for that device's
    // entire span, so it has to read as a single unbroken zone rather
    // than several same-looking 1U blocks stacked with gaps.
    return (
      <div
        className="device-block-halfdepth-stripe"
        style={{ height: blockHeight }}
        title="Half-depth device on opposite face"
      />
    );
  }

  const imageUrl = side === 'rear'
    ? (slot.rear_image_url || slot.custom_image_url)
    : (slot.front_image_url || slot.custom_image_url);

  const { color: categoryColor, Icon } = getCategoryStyle(slot);
  const color = slot.color || categoryColor;
  const iconBoxStyle = { background: 'rgba(0,0,0,0.22)', borderColor: 'rgba(0,0,0,0.3)' };

  return (
    <div
      className={[
        'device-block',
        highlighted ? 'device-block-highlighted' : '',
        isSelected ? 'device-block-selected' : '',
      ].filter(Boolean).join(' ')}
      style={{ height: blockHeight, background: color }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={() => setDraggingMeta(null)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={(e) => {
        if (e.defaultPrevented) return;
        e.stopPropagation();
        onSelect && onSelect(slot.id);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect && onSelect(slot.id);
        actions.onOpenContextMenu(slot, e.clientX, e.clientY);
      }}
      data-slot-id={slot.id}
      data-device-id={slot.device_id || ''}
    >
      {imageUrl ? (
        <div className="device-block-image-wrap">
          <img src={imageUrl} alt={name} className="device-block-image" />
          <span className="device-block-image-label">{name}</span>
        </div>
      ) : (
        <>
          <GripVertical size={12} className="device-block-grip" />
          <div className="device-block-icon-box" style={iconBoxStyle}>
            <Icon size={13} color="rgba(255,255,255,0.9)" />
          </div>
          <span className="device-block-name">{name}</span>
          <div className="device-block-badges">
            <span className="device-block-badge">{slot.u_size}U</span>
            {slot.half_width ? <span className="device-block-badge device-block-badge-accent">½W</span> : null}
            {slot.half_depth ? <span className="device-block-badge device-block-badge-accent">½D</span> : null}
          </div>
        </>
      )}

      <div className="device-block-actions">
        {slot.device_id && (
          <button
            type="button"
            className="device-block-action-btn"
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
          className="device-block-action-btn"
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
