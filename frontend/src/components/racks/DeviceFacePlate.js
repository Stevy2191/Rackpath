import React from 'react';
import { DEVICE_RENDER_CONFIG, resolveRenderType } from './deviceRenderConfig';
import './DeviceFacePlates.css';

// Pure presentational faceplate graphic for a rack slot. Shows an uploaded
// custom image if present, otherwise a generated render based on the slot's
// resolved device type and the current side (front/back).
export default function DeviceFacePlate({ slot, side }) {
  if (slot.custom_image_url) {
    return (
      <div className="rf-face rf-image-face">
        <img src={slot.custom_image_url} alt={slot.item_label || slot.hostname || 'Device'} />
      </div>
    );
  }

  const renderType = resolveRenderType(slot);
  const config = DEVICE_RENDER_CONFIG[renderType] || DEVICE_RENDER_CONFIG.other;
  const renderFn = (side === 'back' ? config.back : config.front) || config.front;

  return <div className={`rf-face ${config.faceplateClass}`}>{renderFn(slot)}</div>;
}
