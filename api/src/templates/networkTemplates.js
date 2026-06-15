// Hardcoded starter layouts for the "Network Diagram Templates" feature.
// Each template lists the devices/topology nodes to create, the edges
// connecting them (by node key), the VLANs to define, and a rack with
// device placements (by node key + U position).
//
// Node positions are canvas coordinates (top-left corner); topology_nodes
// defaults to a 120x80 size, so spacing below keeps nodes non-overlapping.

const TEMPLATES = {
  blank: {
    name: 'Blank Canvas',
    description: 'Start from scratch with nothing pre-configured.',
    nodes: [],
    edges: [],
    vlans: [],
    rack: null,
  },

  home: {
    name: 'Simple Home Network',
    description: 'Modem, router, switch, and 2 APs pre-placed on topology.',
    nodes: [
      { key: 'modem', label: 'Modem', type: 'modem', x: 300, y: 20 },
      { key: 'router', label: 'Router', type: 'router', x: 300, y: 140 },
      { key: 'switch', label: 'Core Switch', type: 'switch', x: 300, y: 260 },
      { key: 'ap1', label: 'AP-1', type: 'ap', x: 160, y: 380 },
      { key: 'ap2', label: 'AP-2', type: 'ap', x: 440, y: 380 },
    ],
    edges: [
      ['modem', 'router'],
      ['router', 'switch'],
      ['switch', 'ap1'],
      ['switch', 'ap2'],
    ],
    vlans: [
      { vlan_id: 1, name: 'Main', subnet: '192.168.1.0/24' },
      { vlan_id: 10, name: 'IoT', subnet: '192.168.10.0/24' },
      { vlan_id: 20, name: 'Guest', subnet: '192.168.20.0/24' },
    ],
    rack: {
      name: 'Home Rack',
      u_height: 12,
      items: [
        { key: 'router', u_position: 1 },
        { key: 'switch', u_position: 2 },
      ],
    },
  },

  office: {
    name: 'Small Office',
    description: 'Firewall, core switch, 2 access switches, AP, and a server.',
    nodes: [
      { key: 'firewall', label: 'Firewall', type: 'firewall', x: 340, y: 20 },
      { key: 'core_switch', label: 'Core Switch', type: 'switch', x: 340, y: 140 },
      { key: 'access_switch_1', label: 'Access Switch 1', type: 'switch', x: 140, y: 280 },
      { key: 'access_switch_2', label: 'Access Switch 2', type: 'switch', x: 540, y: 280 },
      { key: 'office_ap', label: 'Office AP', type: 'ap', x: 140, y: 420 },
      { key: 'file_server', label: 'File Server', type: 'server', x: 540, y: 420 },
    ],
    edges: [
      ['firewall', 'core_switch'],
      ['core_switch', 'access_switch_1'],
      ['core_switch', 'access_switch_2'],
      ['core_switch', 'office_ap'],
      ['core_switch', 'file_server'],
    ],
    vlans: [
      { vlan_id: 10, name: 'Staff', subnet: '10.0.10.0/24' },
      { vlan_id: 20, name: 'Guest WiFi', subnet: '10.0.20.0/24' },
      { vlan_id: 30, name: 'Servers', subnet: '10.0.30.0/24' },
      { vlan_id: 40, name: 'Management', subnet: '10.0.40.0/24' },
    ],
    rack: {
      name: 'Office Rack',
      u_height: 24,
      items: [
        { key: 'firewall', u_position: 1 },
        { key: 'core_switch', u_position: 2 },
        { key: 'access_switch_1', u_position: 3 },
        { key: 'access_switch_2', u_position: 4 },
        { key: 'file_server', u_position: 6 },
      ],
    },
  },

  homelab: {
    name: 'Homelab',
    description: 'Router, managed switch with VLANs, NAS, and a proxmox/VM host.',
    nodes: [
      { key: 'router_firewall', label: 'Router/Firewall', type: 'router', x: 300, y: 20 },
      { key: 'managed_switch', label: 'Managed Switch', type: 'switch', x: 300, y: 140 },
      { key: 'nas', label: 'NAS', type: 'server', x: 140, y: 280 },
      { key: 'proxmox_host', label: 'Proxmox Host', type: 'server', x: 300, y: 280 },
      { key: 'vm_host_2', label: 'VM Host 2', type: 'server', x: 460, y: 280 },
    ],
    edges: [
      ['router_firewall', 'managed_switch'],
      ['managed_switch', 'nas'],
      ['managed_switch', 'proxmox_host'],
      ['managed_switch', 'vm_host_2'],
    ],
    vlans: [
      { vlan_id: 10, name: 'Management', subnet: '10.0.10.0/24' },
      { vlan_id: 20, name: 'Servers', subnet: '10.0.20.0/24' },
      { vlan_id: 30, name: 'Storage', subnet: '10.0.30.0/24' },
      { vlan_id: 40, name: 'IoT', subnet: '10.0.40.0/24' },
      { vlan_id: 50, name: 'Media', subnet: '10.0.50.0/24' },
    ],
    rack: {
      name: 'Homelab Rack',
      u_height: 16,
      items: [
        { key: 'router_firewall', u_position: 1 },
        { key: 'managed_switch', u_position: 2 },
        { key: 'nas', u_position: 4 },
        { key: 'proxmox_host', u_position: 6 },
        { key: 'vm_host_2', u_position: 8 },
      ],
    },
  },

  branch: {
    name: 'Multi-Site Branch',
    description: 'Core router, firewall, switch stack, APs, and cameras placeholder.',
    nodes: [
      { key: 'wan_router', label: 'WAN Router', type: 'router', x: 380, y: 0 },
      { key: 'firewall', label: 'Firewall', type: 'firewall', x: 380, y: 120 },
      { key: 'core_switch', label: 'Core Switch', type: 'switch', x: 380, y: 240 },
      { key: 'switch_stack_1', label: 'Switch Stack 1', type: 'switch', x: 180, y: 360 },
      { key: 'switch_stack_2', label: 'Switch Stack 2', type: 'switch', x: 580, y: 360 },
      { key: 'branch_ap_1', label: 'Branch AP 1', type: 'ap', x: 180, y: 480 },
      { key: 'branch_ap_2', label: 'Branch AP 2', type: 'ap', x: 580, y: 480 },
      { key: 'camera_nvr', label: 'Camera NVR', type: 'server', x: 380, y: 480 },
    ],
    edges: [
      ['wan_router', 'firewall'],
      ['firewall', 'core_switch'],
      ['core_switch', 'switch_stack_1'],
      ['core_switch', 'switch_stack_2'],
      ['switch_stack_1', 'branch_ap_1'],
      ['switch_stack_2', 'branch_ap_2'],
      ['core_switch', 'camera_nvr'],
    ],
    vlans: [
      { vlan_id: 10, name: 'Corporate', subnet: '10.10.10.0/24' },
      { vlan_id: 20, name: 'Guest', subnet: '10.10.20.0/24' },
      { vlan_id: 30, name: 'Cameras', subnet: '10.10.30.0/24' },
      { vlan_id: 40, name: 'VoIP', subnet: '10.10.40.0/24' },
      { vlan_id: 255, name: 'Management', subnet: '10.10.255.0/24' },
    ],
    rack: {
      name: 'Branch Rack',
      u_height: 24,
      items: [
        { key: 'wan_router', u_position: 1 },
        { key: 'firewall', u_position: 2 },
        { key: 'core_switch', u_position: 3 },
        { key: 'switch_stack_1', u_position: 4 },
        { key: 'switch_stack_2', u_position: 5 },
        { key: 'camera_nvr', u_position: 7 },
      ],
    },
  },
};

const TEMPLATE_KEYS = Object.keys(TEMPLATES);

module.exports = { TEMPLATES, TEMPLATE_KEYS };
