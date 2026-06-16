import React from 'react';
import { DEVICE_RENDER_CONFIG, resolveRenderType } from './deviceRenderConfig';
import './DeviceFacePlates.css';

export default function DeviceFacePlate({ slot, side }) {
  // Side-specific image takes precedence, then generic custom_image_url
  const imageUrl =
    side === 'rear' ? (slot.rear_image_url || slot.custom_image_url) :
    (slot.front_image_url || slot.custom_image_url);

  if (imageUrl) {
    return (
      <div className="rf-face rf-image-face">
        <img src={imageUrl} alt={slot.item_label || slot.hostname || 'Device'} />
      </div>
    );
  }

  const renderType = resolveRenderType(slot);
  const config = DEVICE_RENDER_CONFIG[renderType] || DEVICE_RENDER_CONFIG.other;
  const renderFn = (side === 'rear' ? config.back : config.front) || config.front;

  return <div className={`rf-face ${config.faceplateClass}`}>{renderFn(slot)}</div>;
}
