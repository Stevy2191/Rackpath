// Starter templates offered in the "Choose a starting template" step of the
// new project flow. `key` must match a key in api/src/templates/networkTemplates.js.
// `nodes`/`edges` describe a rough topology shape (in a 0-120 x 0-90 grid)
// used to render the mini preview diagram on each card.
export const PROJECT_TEMPLATES = [
  {
    key: 'blank',
    name: 'Blank Canvas',
    description: 'Start from scratch with nothing pre-configured.',
    nodes: [],
    edges: [],
  },
  {
    key: 'home',
    name: 'Simple Home Network',
    description: 'Modem, router, switch, and 2 APs pre-placed on topology.',
    nodes: [
      { x: 60, y: 8 },
      { x: 60, y: 28 },
      { x: 60, y: 48 },
      { x: 35, y: 70 },
      { x: 85, y: 70 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [2, 4],
    ],
  },
  {
    key: 'office',
    name: 'Small Office',
    description: 'Firewall, core switch, 2 access switches, AP, and a server.',
    nodes: [
      { x: 60, y: 8 },
      { x: 60, y: 28 },
      { x: 25, y: 48 },
      { x: 95, y: 48 },
      { x: 25, y: 70 },
      { x: 95, y: 70 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [1, 3],
      [1, 4],
      [1, 5],
    ],
  },
  {
    key: 'homelab',
    name: 'Homelab',
    description: 'Router, managed switch with VLANs, NAS, and a proxmox/VM host.',
    nodes: [
      { x: 60, y: 8 },
      { x: 60, y: 28 },
      { x: 30, y: 52 },
      { x: 60, y: 52 },
      { x: 90, y: 52 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [1, 3],
      [1, 4],
    ],
  },
  {
    key: 'branch',
    name: 'Multi-Site Branch',
    description: 'Core router, firewall, switch stack, APs, and cameras placeholder.',
    nodes: [
      { x: 60, y: 5 },
      { x: 60, y: 23 },
      { x: 60, y: 41 },
      { x: 30, y: 60 },
      { x: 90, y: 60 },
      { x: 30, y: 78 },
      { x: 90, y: 78 },
      { x: 60, y: 78 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [2, 4],
      [3, 5],
      [4, 6],
      [2, 7],
    ],
  },
];
