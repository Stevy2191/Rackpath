// Shapes of the v2 API's answers (see api-rs/README.md).

export interface User {
  id: number;
  username: string;
  email: string | null;
  display_name: string | null;
  is_owner: boolean;
  must_change_password: boolean;
  totp_enabled: boolean;
  disabled: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface Grant {
  id: number;
  role: 'reader' | 'editor' | 'admin';
  scope_type: 'account' | 'project' | 'location' | 'floor' | 'room' | 'rack' | 'device';
  scope_id: number | null;
  project_id: number | null;
  created_at: string;
}

export interface Me {
  user: User;
  mfa_pending: boolean;
  account_requires_2fa?: boolean;
  unused_recovery_codes?: number;
  is_account_admin?: boolean;
  grants?: Grant[];
}

export interface Project {
  id: number;
  code: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  can_edit?: boolean;
  can_manage?: boolean;
}

export interface SearchHit {
  kind: 'location' | 'floor' | 'room' | 'rack' | 'device' | 'port' | 'prefix' | 'address';
  id: number;
  project_id: number;
  path: string;
  detail?: string;
}

export interface Location {
  id: number;
  project_id: number;
  code: string;
  name: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_postcode: string | null;
  address_country: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  responsible_user_id: number | null;
  isp_primary_name: string | null;
  isp_primary_circuit: string | null;
  isp_primary_contact: string | null;
  isp_secondary_name: string | null;
  isp_secondary_circuit: string | null;
  isp_secondary_contact: string | null;
  notes: string | null;
  /** Groups a campus's buildings; display only. */
  site: string | null;
  path?: string;
  can_edit?: boolean;
  counts?: { floors: number; rooms: number; racks: number; devices: number };
  floors?: FloorSummary[];
}

export interface FloorSummary {
  id: number;
  code: string;
  name: string | null;
  level: number;
  rooms: number;
  racks: number;
  devices: number;
}

export interface Floor {
  id: number;
  location_id: number;
  code: string;
  name: string | null;
  level: number;
  plan_width: number | null;
  plan_height: number | null;
  scale_px_per_m: number | null;
  plan_image_type: string | null;
  notes: string | null;
  updated_at: string;
  path?: string;
  rooms?: Room[];
  racks?: RackSummary[];
  devices?: Device[];
  can_edit?: boolean;
}

export interface Room {
  id: number;
  floor_id: number;
  code: string;
  name: string | null;
  is_default: boolean;
  shape: { type: 'polygon'; points: [number, number][] } | null;
  color: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
  path?: string;
  racks?: RackSummary[];
  devices?: Device[];
  can_edit?: boolean;
}

export interface Rack {
  id: number;
  room_id: number;
  code: string;
  name: string | null;
  u_height: number;
  width: '19in' | '23in' | '10in';
  depth_mm: number | null;
  numbering: 'bottom_up' | 'top_down';
  rack_type: 'enclosed' | 'open_frame' | 'wall_mount' | 'other';
  plan_x: number | null;
  plan_y: number | null;
  plan_rotation: number | null;
  notes: string | null;
  path: string;
  devices?: Device[];
  can_edit?: boolean;
}

export type RackSummary = Rack & { device_count: number };

export type Placement =
  | { type: 'room'; room_id: number; x: number | null; y: number | null; rotation: number | null }
  | { type: 'rack'; rack_id: number; u: number | null; face: 'front' | 'rear' | 'both'; mount: Mount }
  | { type: 'tray'; tray_id: number }
  | { type: 'unplaced' };

export type Mount = 'full_width' | 'half_left' | 'half_right' | 'zero_u_left' | 'zero_u_right';

export interface Device {
  id: number;
  project_id: number;
  code: string;
  name: string | null;
  path: string;
  device_type: { id: number; key: string; label: string; prefix: string };
  placement: Placement;
  u_height: number | null;
  depth: 'half' | 'full' | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  purchase_date: string | null;
  warranty_expiry: string | null;
  in_service_date: string | null;
  status: 'planned' | 'active' | 'spare' | 'faulty' | 'retired';
  hostname: string | null;
  mac: string | null;
  os: string | null;
  firmware: string | null;
  source: string;
  external_url: string | null;
  missing_from_source_at: string | null;
  template_id: number | null;
  tags: { id: number; name: string; color: string | null }[];
  notes: string | null;
  on_tray?: Device[];
  can_edit?: boolean;
}

export interface DeviceType {
  id: number;
  key: string;
  label: string;
  prefix: string;
  placement: 'floor' | 'rack' | 'either' | 'tray';
  icon: string | null;
  is_builtin: boolean;
}

export interface TemplateSummary {
  id: number;
  project_id: number | null;
  builtin: boolean;
  builtin_key: string | null;
  name: string;
  device_type: string;
  manufacturer: string | null;
  model: string | null;
  u_height: number | null;
  version: number;
  device_count: number;
}

export interface Port {
  id: number;
  device_id: number;
  code: string;
  path: string;
  face: 'front' | 'rear';
  role: 'active' | 'passive';
  requires_permanent: boolean;
  medium: 'copper' | 'fiber' | 'wireless' | 'power' | 'console' | 'coax' | 'other';
  connector: string | null;
  transceiver: string | null;
  fiber_mode: string | null;
  sort_order: number;
  interface_name: string | null;
  speed: number | null;
  effective_speed: number | null;
  poe: string | null;
  description: string | null;
  mac: string | null;
  wlan_id: number | null;
  outlet_group: number | null;
  from_template: boolean;
  notes: string | null;
}

export interface CableOnPort {
  connection_id: number;
  kind: 'patch' | 'permanent' | 'power';
  cable_type: string | null;
  length_m: number | null;
  color: string | null;
  label: string | null;
  far: { port_id: number; side: 'front' | 'rear'; path: string; device_id: number };
}

export type ChainState = 'complete' | 'incomplete' | 'unconnected';

export interface ListedPort extends Port {
  front: CableOnPort | null;
  rear: CableOnPort | null;
  vlans: { id: number; vid: number; name: string; mode: 'untagged' | 'tagged' }[];
  chain_state: ChainState;
  can_edit?: boolean;
}

export type TraceHop =
  | {
      type: 'port';
      id: number;
      path: string | null;
      device_id: number | null;
      role: 'active' | 'passive' | null;
      connector: string | null;
      transceiver: string | null;
      enter: 'front' | 'rear' | null;
      exit: 'front' | 'rear' | null;
    }
  | {
      type: 'cable';
      id: number;
      kind: CableOnPort['kind'] | null;
      cable_type: string | null;
      length_m: number | null;
      color: string | null;
      label: string | null;
    };

export interface Trace {
  state: ChainState;
  truncated: boolean;
  ends: [number, number];
  total_length_m: number | null;
  hops: TraceHop[];
  warnings: string[];
}

export interface Connection {
  id: number;
  kind: CableOnPort['kind'];
  cable_type: string | null;
  length_m: number | null;
  color: string | null;
  label: string | null;
  notes: string | null;
  a: { port_id: number; side: 'front' | 'rear'; path: string; device_id: number };
  b: { port_id: number; side: 'front' | 'rear'; path: string; device_id: number };
  warnings?: string[];
}

export interface MediaCatalog {
  media: string[];
  connectors: { name: string; media: string[]; cage: boolean }[];
  transceivers: { name: string; cage: string; speed: number; medium: string }[];
  cable_types: string[];
}

export interface IpAddress {
  id: number;
  space_id: number;
  address: string;
  notes?: string | null;
  missing_from_source_at?: string | null;
  prefix_len: number | null;
  device_id: number | null;
  port_id: number | null;
  role: string;
  status: string;
  mac: string | null;
  dns_name: string | null;
  dns_aliases: string[];
  dhcp_reservation: boolean;
  description: string | null;
  source: string;
  device_path: string | null;
  port_path: string | null;
}

export interface Space {
  id: number;
  name: string;
  description: string | null;
  is_default: boolean;
  prefix_count: number;
  address_count: number;
}

export interface Prefix {
  id: number;
  project_id: number;
  space_id: number;
  cidr: string;
  family: 4 | 6;
  prefix_len: number;
  vlan_id: number | null;
  location_id: number | null;
  role: string;
  status: 'planned' | 'active' | 'deprecated';
  gateway: string | null;
  dns_servers: string | null;
  domain_name: string | null;
  description: string | null;
  notes: string | null;
  source: string;
  missing_from_source_at: string | null;
  size: number | string;
  address_count: number;
  dhcp_pool_size: number;
  utilization?: number;
  parent_id?: number | null;
  depth?: number;
}

export interface IpRange {
  id: number;
  prefix_id: number;
  start_text: string;
  end_text: string;
  kind: 'dhcp_pool' | 'reserved' | 'static';
  description: string | null;
  source: string;
}

export interface PrefixDetail extends Prefix {
  parent: { id: number; cidr: string } | null;
  children: Prefix[];
  ranges: IpRange[];
  addresses: IpAddress[];
  addresses_truncated: boolean;
  can_edit: boolean;
}

export interface PrefixGrid {
  cidr: string;
  size: number;
  network: number | null;
  broadcast: number | null;
  gateway: number | null;
  ranges: { id: number; kind: IpRange['kind']; from: number; to: number; description: string | null }[];
  addresses: (IpAddress & { offset: number })[];
  leases: { offset: number; address: string; mac: string | null; hostname: string | null; expires_at: string | null; seen_at: string }[];
}

export interface IpamWarning {
  kind: string;
  resource_type: string;
  resource_id: number;
  path: string;
  message: string;
}

export interface Vlan {
  id: number;
  vid: number;
  name: string;
  description: string | null;
  color: string | null;
  notes: string | null;
  port_count: number;
}

export interface Wlan {
  id: number;
  ssid: string;
  description: string | null;
  security: 'open' | 'owe' | 'wpa2' | 'wpa3' | 'wpa2_wpa3' | 'enterprise';
  hidden: boolean;
  vlan_id: number | null;
  notes: string | null;
  port_count: number;
}

export interface CurvePoint {
  load_w: number;
  minutes: number;
}

export interface PowerSpec {
  input_voltage?: string | null;
  capacity_va?: number | null;
  capacity_w?: number | null;
  typical_w?: number | null;
  max_w?: number | null;
  runtime_curve?: CurvePoint[] | null;
  ebm_runtime_curve?: CurvePoint[] | null;
  max_ebm_slots?: number | null;
}

export interface PortGroup {
  face: 'front' | 'rear';
  grid_row: number;
  grid_col: number;
  rows: number;
  cols: number;
  prefix: string;
  numbering?: 'column_major' | 'row_major' | null;
  start?: number | null;
  connector?: string | null;
  medium?: string | null;
  transceiver?: string | null;
  fiber_mode?: string | null;
  role?: 'active' | 'passive' | null;
  requires_permanent?: boolean | null;
  speed?: number | null;
  poe?: string | null;
  outlet_group?: number | null;
  description?: string | null;
}

/** What a template is made of, as saved (PUT replaces all of it). */
export interface TemplateIn {
  name: string;
  device_type: string;
  manufacturer?: string | null;
  model?: string | null;
  u_height?: number | null;
  depth?: string | null;
  half_width?: boolean;
  power?: PowerSpec | null;
  notes?: string | null;
  port_groups: PortGroup[];
  port_overrides: { port_index: number; code: string }[];
  elements: unknown[];
}

export interface Template extends TemplateIn {
  id: number;
  project_id: number | null;
  builtin: boolean;
  builtin_key: string | null;
  version: number;
  device_count: number;
  grid: { rows: number; cols: number };
  ports: { index: number; code: string; face: 'front' | 'rear'; row: number; col: number; group: number }[];
}

export interface TemplateImpact {
  device_id: number;
  path: string;
  ports_added: string[];
  ports_removed: string[];
  ports_changed: string[];
  cables_removed: string[];
  unplaced: boolean;
}

export interface DevicePower {
  device_id: number;
  code: string;
  path: string;
  power: PowerSpec;
  draw_w: number | null;
  demand_w: number;
  output_w: number;
  failover_w: number;
  load_pct: number | null;
  failover_pct: number | null;
  runtime_min: number | null;
  failover_runtime_min: number | null;
  battery_modules: number[];
  outlets: { total: number; used: number; groups: { group: number | null; total: number; used: number }[] };
  inlets: { total: number; used: number };
  warnings: string[];
}

export interface RackPower {
  rack_id: number;
  devices: DevicePower[];
  totals: { draw_w: number; ups_count: number; ups_capacity_va: number; ups_capacity_w: number; ups_redundant_va: number | null; ups_redundant_w: number | null };
  loop_detected: boolean;
}
