import React, { useState } from 'react';
import RackEnclosure from './RackEnclosure';
import CableOverlay from './CableOverlay';
import './RackCanvas.css';

const SIMPLE_ITEM_TYPES = ['patch-panel', 'blank', 'cable-manager'];

const U_HEIGHT = 40;

export default function RackCanvas({
  racks,
  allSlots,
  rackCustomDevices,
  highlightedSlotId,
  selectedSlotId,
  actions,
  cableViewEnabled,
  focusedRackId,
  onFocusRack,
  onSelectSlot,
}) {
  const [draggingMeta, setDraggingMeta] = useState(null);

  const sortedRacks = [...racks].sort((a, b) => a.id - b.id);

  // face is 'front' or 'rear' from whichever panel the item was dropped on
  const handleDrop = (rackId, uPosition, face, e) => {
    e.preventDefault();
    setDraggingMeta(null);

    const slotId       = e.dataTransfer.getData('text/slot-id');
    const deviceId     = e.dataTransfer.getData('text/device-id');
    const catalogItem  = e.dataTransfer.getData('text/catalog-item');
    const customDevId  = e.dataTransfer.getData('text/custom-device-id');

    if (slotId) {
      const slot = allSlots.find((s) => String(s.id) === slotId);
      if (!slot) return;
      const u_position = uPosition - slot.u_size + 1;
      if (u_position < 1) return;
      const curFace = slot.mounted_face || slot.front_back || 'front';
      if (u_position === slot.u_position && slot.rack_id === rackId && curFace === face) return;
      actions.onSlotUpdate(slot, { rack_id: rackId, u_position, mounted_face: face });
      return;
    }

    if (deviceId) {
      actions.onSlotCreate({
        rack_id: rackId,
        device_id: Number(deviceId),
        item_type: 'device',
        u_position: uPosition,
        u_size: 1,
        mounted_face: face,
      });
      return;
    }

    if (catalogItem) {
      const entry = JSON.parse(catalogItem);
      const itemType = SIMPLE_ITEM_TYPES.includes(entry.renderType) ? entry.renderType : 'custom-device';
      const u_position = uPosition - entry.uSize + 1;
      if (u_position < 1) return;
      actions.onSlotCreate({
        rack_id: rackId,
        item_type: itemType,
        item_label: entry.name,
        vendor: entry.vendor,
        catalog_id: entry.id,
        custom_type: entry.renderType,
        u_position,
        u_size: entry.uSize,
        mounted_face: entry.mountedFace || face,
        half_depth: entry.halfDepth ? 1 : 0,
        half_width: entry.halfWidth ? 1 : 0,
      });
      return;
    }

    if (customDevId) {
      const custom = rackCustomDevices.find((c) => String(c.id) === customDevId);
      if (!custom) return;
      const u_position = uPosition - custom.u_size + 1;
      if (u_position < 1) return;
      actions.onSlotCreate({
        rack_id: rackId,
        item_type: 'custom-device',
        item_label: custom.name,
        vendor: custom.vendor,
        custom_type: custom.type,
        custom_image_url: custom.image_url,
        u_position,
        u_size: custom.u_size,
        mounted_face: face,
      });
    }
  };

  return (
    <div className="rack-canvas">
      {sortedRacks.map((rack) => (
        <RackEnclosure
          key={rack.id}
          rack={rack}
          slots={allSlots.filter((s) => s.rack_id === rack.id)}
          highlightedSlotId={highlightedSlotId}
          selectedSlotId={selectedSlotId}
          actions={actions}
          draggingMeta={draggingMeta}
          setDraggingMeta={setDraggingMeta}
          onDrop={handleDrop}
          onFocus={() => onFocusRack(rack.id)}
          isFocused={focusedRackId === rack.id}
          uHeight={U_HEIGHT}
          onSelectSlot={onSelectSlot}
        />
      ))}

      {cableViewEnabled && <CableOverlay racks={sortedRacks} allSlots={allSlots} />}
    </div>
  );
}
