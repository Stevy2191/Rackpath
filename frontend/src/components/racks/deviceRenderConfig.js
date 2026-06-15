import React from 'react';

// Data-driven faceplate renderers, keyed by "render type". Each entry has a
// `faceplateClass` (top-level wrapper class for DeviceFacePlates.css) and
// `front(slot)` / `back(slot)` functions returning the JSX for that face.
// `resolveRenderType` maps a rack_slots row onto one of these keys.

const range = (n) => Array.from({ length: Math.max(0, n) }, (_, i) => i);

function PortGrid({ count, columns }) {
  return (
    <div className="rf-port-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {range(count).map((i) => (
        <span key={i} className={`rf-port${i % 8 === 0 ? ' rf-port-link' : ''}`} />
      ))}
    </div>
  );
}

function Vents({ rows = 3 }) {
  return (
    <div className="rf-vents">
      {range(rows).map((i) => (
        <span key={i} className="rf-vent-line" />
      ))}
    </div>
  );
}

function DriveBays({ count, dense }) {
  return (
    <div className={`rf-drive-bays${dense ? ' rf-drive-bays-dense' : ''}`}>
      {range(count).map((i) => (
        <div key={i} className="rf-drive-bay">
          <span className="rf-drive-handle" />
        </div>
      ))}
    </div>
  );
}

function PsuRow({ count = 2 }) {
  return (
    <div className="rf-psu-row">
      {range(count).map((i) => (
        <div key={i} className="rf-psu-module">
          <span className="rf-psu-fan" />
        </div>
      ))}
    </div>
  );
}

function OutletRow({ count }) {
  return (
    <div className="rf-outlet-row">
      {range(count).map((i) => (
        <span key={i} className="rf-outlet" />
      ))}
    </div>
  );
}

function BatteryBars({ count = 4 }) {
  return (
    <div className="rf-battery-bars">
      {range(count).map((i) => (
        <span key={i} className="rf-battery-bar" />
      ))}
    </div>
  );
}

function StatusLeds({ count = 4 }) {
  return (
    <div className="rf-status-leds">
      {range(count).map((i) => (
        <span key={i} className={`rf-status-led${i === 0 ? ' rf-status-led-on' : ''}`} />
      ))}
    </div>
  );
}

export const DEVICE_RENDER_CONFIG = {
  switch: {
    faceplateClass: 'rf-switch',
    front: (slot) => (
      <div className="rf-switch-front">
        <PortGrid count={Math.max(8, (slot.u_size || 1) * 24)} columns={12} />
        <StatusLeds count={4} />
      </div>
    ),
    back: (slot) => (
      <div className="rf-switch-back">
        <Vents rows={3} />
        <div className="rf-power-input" />
      </div>
    ),
  },

  firewall: {
    faceplateClass: 'rf-firewall',
    front: (slot) => (
      <div className="rf-firewall-front">
        <PortGrid count={8} columns={8} />
        <StatusLeds count={6} />
      </div>
    ),
    back: () => (
      <div className="rf-firewall-back">
        <Vents rows={2} />
        <div className="rf-power-input" />
      </div>
    ),
  },

  server: {
    faceplateClass: 'rf-server',
    front: (slot) => (
      <div className="rf-server-front">
        <DriveBays count={Math.max(4, (slot.u_size || 1) * 4)} />
        <div className="rf-server-controls">
          <span className="rf-lcd" />
          <span className="rf-power-button" />
        </div>
      </div>
    ),
    back: (slot) => (
      <div className="rf-server-back">
        <PsuRow count={2} />
        <PortGrid count={4} columns={4} />
        <Vents rows={2} />
      </div>
    ),
  },

  storage: {
    faceplateClass: 'rf-storage',
    front: (slot) => (
      <div className="rf-storage-front">
        <DriveBays count={Math.max(8, (slot.u_size || 1) * 12)} dense />
      </div>
    ),
    back: () => (
      <div className="rf-storage-back">
        <PsuRow count={2} />
        <PortGrid count={4} columns={4} />
      </div>
    ),
  },

  ups: {
    faceplateClass: 'rf-ups',
    front: () => (
      <div className="rf-ups-front">
        <span className="rf-lcd rf-ups-lcd" />
        <BatteryBars count={5} />
        <div className="rf-ups-buttons">
          <span className="rf-ups-button" />
          <span className="rf-ups-button" />
        </div>
      </div>
    ),
    back: (slot) => (
      <div className="rf-ups-back">
        <OutletRow count={Math.max(4, (slot.u_size || 1) * 2)} />
        <div className="rf-battery-compartment" />
      </div>
    ),
  },

  pdu: {
    faceplateClass: 'rf-pdu',
    front: () => (
      <div className="rf-pdu-front">
        <span className="rf-lcd" />
        <span className="rf-pdu-label">PDU</span>
      </div>
    ),
    back: (slot) => (
      <div className="rf-pdu-back">
        <OutletRow count={Math.max(8, (slot.u_size || 1) * 8)} />
      </div>
    ),
  },

  'patch-panel': {
    faceplateClass: 'rf-patch-panel',
    front: (slot) => <PortGrid count={Math.max(12, (slot.u_size || 1) * 24)} columns={24} />,
    back: (slot) => <PortGrid count={Math.max(12, (slot.u_size || 1) * 24)} columns={24} />,
  },

  'cable-manager': {
    faceplateClass: 'rf-cable-manager',
    front: () => (
      <div className="rf-cable-manager-face">
        <span className="rf-d-ring" />
        <span className="rf-d-ring" />
        <span className="rf-d-ring" />
      </div>
    ),
    back: () => (
      <div className="rf-cable-manager-face">
        <span className="rf-d-ring" />
        <span className="rf-d-ring" />
        <span className="rf-d-ring" />
      </div>
    ),
  },

  blank: {
    faceplateClass: 'rf-blank',
    front: () => <div className="rf-blank-face" />,
    back: () => <div className="rf-blank-face" />,
  },

  kvm: {
    faceplateClass: 'rf-kvm',
    front: () => (
      <div className="rf-kvm-front">
        <span className="rf-kvm-screen" />
        <PortGrid count={8} columns={8} />
      </div>
    ),
    back: () => (
      <div className="rf-kvm-back">
        <PortGrid count={8} columns={8} />
        <Vents rows={1} />
      </div>
    ),
  },

  ap: {
    faceplateClass: 'rf-ap',
    front: () => (
      <div className="rf-ap-front">
        <span className="rf-ap-icon" />
        <PortGrid count={4} columns={4} />
      </div>
    ),
    back: () => (
      <div className="rf-ap-back">
        <Vents rows={1} />
        <div className="rf-power-input" />
      </div>
    ),
  },

  other: {
    faceplateClass: 'rf-other',
    front: () => <div className="rf-other-face" />,
    back: () => <div className="rf-other-face" />,
  },
};

// Keyword fallbacks for inventory devices / custom types that don't match a
// config key directly (e.g. device_type "Fortigate Firewall" -> 'firewall').
const KEYWORD_RULES = [
  [/firewall|fortigate|palo ?alto|fortinet|udm|router/i, 'firewall'],
  [/switch/i, 'switch'],
  [/poweredge|proliant|thinksystem|superserver|^server$/i, 'server'],
  [/storage|^nas$|rackstation|powervault|netapp/i, 'storage'],
  [/ups|battery/i, 'ups'],
  [/pdu|power distribution/i, 'pdu'],
  [/patch/i, 'patch-panel'],
  [/cable/i, 'cable-manager'],
  [/blank/i, 'blank'],
  [/kvm/i, 'kvm'],
  [/access point|wireless|^ap$/i, 'ap'],
];

// Resolve a rack_slots row (optionally joined with device fields) to a
// DEVICE_RENDER_CONFIG key.
export function resolveRenderType(slot) {
  const raw = slot.custom_type || slot.device_type || slot.item_type || '';
  const lower = String(raw).toLowerCase();
  if (DEVICE_RENDER_CONFIG[lower]) return lower;
  for (const [re, type] of KEYWORD_RULES) {
    if (re.test(raw)) return type;
  }
  if (slot.item_type === 'patch-panel') return 'patch-panel';
  if (slot.item_type === 'blank') return 'blank';
  if (slot.item_type === 'cable-manager') return 'cable-manager';
  return 'other';
}
