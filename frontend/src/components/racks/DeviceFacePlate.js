import React from 'react';
import { Server, Network, Shield, HardDrive, Zap, Plug, Cable, Monitor, Wifi, Box, Minus } from 'lucide-react';
import { CATEGORY_CONFIG, resolveRenderType } from './deviceRenderConfig';
import './DeviceFacePlates.css';

const CATEGORY_ICONS = {
  switch:           Network,
  firewall:         Shield,
  server:           Server,
  storage:          HardDrive,
  ups:              Zap,
  pdu:              Plug,
  'patch-panel':    Cable,
  'cable-manager':  Cable,
  blank:            Minus,
  kvm:              Monitor,
  ap:               Wifi,
  other:            Box,
};

function getSlotName(slot) {
  if (slot.item_type === 'device') return slot.hostname || slot.ip || `Device ${slot.device_id}`;
  return slot.item_label || slot.custom_type || 'Device';
}

export default function DeviceFacePlate({ slot, side }) {
  const imageUrl = side === 'rear'
    ? (slot.rear_image_url || slot.custom_image_url)
    : (slot.front_image_url || slot.custom_image_url);

  if (imageUrl) {
    return (
      <div className="rf-face rf-image-face">
        <img src={imageUrl} alt={slot.item_label || slot.hostname || 'Device'} />
      </div>
    );
  }

  const renderType = resolveRenderType(slot);
  const bgColor = slot.color || CATEGORY_CONFIG[renderType] || CATEGORY_CONFIG.other;
  const Icon = CATEGORY_ICONS[renderType] || Box;
  const name = getSlotName(slot);

  return (
    <div className="rf-face rf-flat-face" style={{ background: bgColor }}>
      <div className="rf-flat-icon">
        <Icon size={11} color="rgba(255,255,255,0.55)" />
      </div>
      <span className="rf-flat-name">{name}</span>
    </div>
  );
}
