import React from 'react';
import { Link } from 'react-router-dom';
import { getCategoryStyle } from '../racks/deviceRenderConfig';
import './SiteElevation.css';

// Pixels per rack unit. Small enough that a 42U rack fits above the fold,
// big enough that a 1U device is still a readable band.
const U_PX = 9;

const SLOT_COLUMNS = { 'half-width': 2, third: 3 };

// Same face resolution the rack builder uses (see pages/Racks.js): a slot
// mounted "both" shows on the front elevation too.
function facesFront(slot) {
  const face = slot.mounted_face || slot.front_back || 'front';
  return face === 'front' || face === 'both';
}

// devices.status is free-form across integrations — normalise the two
// spellings the app already recognises (see pages/Devices.js) and treat
// everything else as unknown, which draws no LED.
function ledState(slot) {
  const status = slot.device_status;
  if (status === 'down' || status === 'offline') return 'fault';
  if (status === 'up' || status === 'online') return 'up';
  return null;
}

function slotLabel(slot) {
  return slot.item_label || slot.hostname || '';
}

function SlotBlock({ slot, rackHeight }) {
  const { color: categoryColor } = getCategoryStyle(slot);
  const color = slot.color || categoryColor;
  const topU = slot.u_position + slot.u_size - 1;
  const columns = SLOT_COLUMNS[slot.slot_width] || 1;
  const column = columns > 1 ? Math.min(slot.slot_position || 0, columns - 1) : 0;
  const led = ledState(slot);
  const label = slotLabel(slot);

  const style = {
    top: (rackHeight - topU) * U_PX,
    height: slot.u_size * U_PX - 1,
    left: `${(column / columns) * 100}%`,
    width: `${100 / columns}%`,
    backgroundColor: color,
  };

  const position = slot.u_size > 1 ? `U${slot.u_position}–U${topU}` : `U${slot.u_position}`;
  // A 4px LED is too quiet for the one thing on this panel that needs a
  // person, so a fault also rings the whole block.
  const className = `elevation-slot${led === 'fault' ? ' elevation-slot-fault' : ''}`;
  const title = led === 'fault'
    ? `${label || 'Slot'} — ${position} · ${slot.u_size}U · unreachable`
    : `${label || 'Slot'} — ${position} · ${slot.u_size}U`;
  const contents = (
    <>
      <span className="elevation-slot-label">{label}</span>
      {led && <span className={`elevation-led elevation-led-${led}`} />}
    </>
  );

  // Slots holding an inventory device open it; blanks, patch panels and
  // cable managers have nothing to open, so they stay inert.
  if (slot.device_id) {
    return (
      <Link to={`/devices/${slot.device_id}`} className={className} style={style} title={title}>
        {contents}
      </Link>
    );
  }
  return (
    <span className={`${className} elevation-slot-inert`} style={style} title={title}>
      {contents}
    </span>
  );
}

function Rack({ rack, slots }) {
  const height = Number(rack.u_height) || 0;
  const usedU = Number(rack.used_u) || 0;
  const ticks = [];
  for (let u = 5; u <= height; u += 5) ticks.push(u);

  return (
    <div className="elevation-rack">
      <div className="elevation-rack-head">
        <span className="elevation-rack-name">{rack.name}</span>
        <span className="elevation-rack-usage">
          {usedU}/{height}U
        </span>
      </div>
      <div className="elevation-rack-body">
        <div className="elevation-scale" style={{ height: height * U_PX }}>
          {ticks.map((u) => (
            <span key={u} className="elevation-tick" style={{ top: (height - u) * U_PX + U_PX / 2 }}>
              {u}
            </span>
          ))}
        </div>
        <div className="elevation-frame">
          <div className="elevation-slots" style={{ height: height * U_PX }}>
            {slots.map((slot) => (
              <SlotBlock key={slot.id} slot={slot} rackHeight={height} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SiteElevation({ racks, slots }) {
  if (!racks || racks.length === 0) {
    return (
      <p className="elevation-empty">
        No racks yet. Build one in <Link to="/racks">Racks</Link> and it will appear here.
      </p>
    );
  }

  // Vertical PDUs mount to the side rails rather than into U slots, so they
  // have no place on a U-indexed elevation.
  const mountable = (slots || []).filter(
    (slot) => slot.item_type !== 'vertical-pdu' && facesFront(slot)
  );

  return (
    <div className="elevation">
      {racks.map((rack) => (
        <Rack
          key={rack.id}
          rack={rack}
          slots={mountable.filter((slot) => slot.rack_id === rack.id)}
        />
      ))}
    </div>
  );
}
