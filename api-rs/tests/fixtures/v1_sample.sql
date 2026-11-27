-- A small v1 site for the importer test. The user's password is
-- "old-v1-password"; the integration's API key was encrypted by v1 with
-- RACKPATH_ENCRYPTION_KEY = 07 repeated 32 times (the tests' key).
SET FOREIGN_KEY_CHECKS = 0;
INSERT INTO users (id, username, password_hash, must_change_password) VALUES
  (1, 'jane', '$2b$04$hrUjuNT5HnHHvUddDevya.7JbSPC0RG.8PpFQNdktLNy.RtIMrLWK', 0);

INSERT INTO projects (id, name, description, address_street, address_city, address_zip, site_contact_name,
  primary_isp_name, primary_isp_circuit_id, lan_ip, lan_subnet, lan_gateway, wan_ip, wan_subnet, dns_servers) VALUES
  (1, 'Acme Head Office', 'Main site', '1 High St', 'Springfield', '12345', 'Pat', 'FastNet', 'CIR-9',
   '192.168.10.0', '255.255.255.0', '192.168.10.1', '203.0.113.10', '/29', '1.1.1.1');

INSERT INTO locations (id, project_id, name, building_number, notes) VALUES
  (1, 1, 'Main building', 'B1', 'The big one');

INSERT INTO rooms (id, location_id, name, floor, room_number, notes) VALUES
  (1, 1, 'Server room', '1', 'SR-101', NULL),
  (2, 1, 'Reception', 'Ground', NULL, 'Front desk');

INSERT INTO racks (id, project_id, name, u_height, rack_type, rack_width, notes, location_id, room_id) VALUES
  (1, 1, 'Rack A', 42, '4-post', '19"', 'Main rack', 1, 1),
  (2, 1, 'Rack B', 12, 'wall-mount', '10"', NULL, 1, NULL),
  (3, 1, 'Loose rack', 24, 'open-frame', '19"', NULL, NULL, NULL);

INSERT INTO devices (id, project_id, hostname, ip, mac, type, make, model, serial_number, purchase_date, status, notes, room_id) VALUES
  (1, 1, 'core-sw-1', '192.168.10.2', 'AA:BB:CC:00:00:01', 'switch', 'Ubiquiti', 'USW-48', 'SN1', '2023-04-01', 'online', 'Core', NULL),
  (2, 1, 'srv-1', '192.168.10.20', NULL, 'server', 'Dell', 'R650', 'SN2', NULL, 'online', NULL, NULL),
  (3, 1, 'pp-1', NULL, NULL, 'patch-panel', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (4, 1, 'printer-1', '192.168.10.50', 'AA:BB:CC:00:00:04', 'printer', 'HP', 'M404', NULL, NULL, NULL, NULL, 2),
  (5, 1, 'clash', NULL, NULL, 'server', NULL, NULL, NULL, NULL, NULL, NULL, NULL);

INSERT INTO rack_slots (id, project_id, rack_id, device_id, item_type, item_label, u_position, u_size, mounted_face,
  half_width, outlet_groups, capacity_va, capacity_w, device_type, ups_va_rating, ups_watt_rating, runtime_curve,
  power_source_slot_id, power_source_outlet, mount_side, asset_tag) VALUES
  (1, 1, 1, 1, 'device', NULL, 40, 1, 'front', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'AT-1'),
  (2, 1, 1, 2, 'device', NULL, 20, 2, 'both', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 3, 1, NULL, NULL),
  (3, 1, 1, NULL, 'custom-device', 'UPS 1500', 1, 2, 'both', 0, '[{"type":"IEC C13","count":4}]', 1500, 1000, 'ups', 1500, 1000,
     '[{"load_watts":500,"runtime_minutes":20},{"load_watts":1000,"runtime_minutes":7}]', NULL, NULL, NULL, NULL),
  (4, 1, 1, 3, 'patch-panel', NULL, 41, 1, 'front', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (5, 1, 1, NULL, 'blank', 'Blank', 30, 1, 'front', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (6, 1, 1, 5, 'device', NULL, 20, 1, 'both', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (7, 1, 1, NULL, 'vertical-pdu', 'PDU left', 1, 1, 'rear', 0, '[{"type":"C19","count":2}]', NULL, NULL, 'pdu', NULL, NULL, NULL, NULL, NULL, 'left', NULL);

INSERT INTO ports (id, project_id, device_id, port_name, port_number, cable_type, connected_port_id, speed) VALUES
  (1, 1, 1, 'Gi0/1', 1, 'Cat6', 3, '1G'),
  (2, 1, 1, 'Gi0/2', 2, NULL, NULL, '1G'),
  (3, 1, 3, 'Port 1', 1, 'Cat6', 1, NULL),
  (4, 1, 2, 'eth0', NULL, 'Fiber', 2, '10 Gbps');
UPDATE ports SET connected_port_id = 4 WHERE id = 2;

INSERT INTO project_vlans (id, project_id, vlan_id, name, description, subnet, color) VALUES
  (1, 1, 10, 'Users', 'Staff', '192.168.20.5/24', '#22c55e'),
  (2, 1, 99, 'Mgmt', NULL, NULL, '#64748b');

INSERT INTO device_tags (id, project_id, name, color) VALUES (1, 1, 'critical', '#ef4444');
INSERT INTO device_tag_assignments (device_id, tag_id) VALUES (1, 1), (2, 1);

INSERT INTO project_cameras (id, project_id, name, model, mac, ip_address, resolution, location_notes) VALUES
  (1, 1, 'Lobby cam', 'G4 Pro', 'AA:BB:CC:00:00:09', '192.168.10.60', '4K', 'Above the door');
INSERT INTO camera_tag_assignments (camera_id, tag_id) VALUES (1, 1);
INSERT INTO project_access_devices (id, project_id, name, device_type, model, door_name) VALUES
  (1, 1, 'Front reader', 'reader', 'UA-G2', 'Main door');

INSERT INTO rack_custom_devices (id, project_id, name, vendor, type, u_size, outlet_count, outlet_type, input_voltage) VALUES
  (1, 1, 'Custom PDU 8', 'APC', 'pdu', 1, 8, 'C13', '230V');
INSERT INTO user_catalog_entries (id, user_id, name, render_type, u_size, outlet_groups, capacity_w) VALUES
  (1, 1, 'Shelf 2U', 'shelf', 2, NULL, NULL);

INSERT INTO topologies (id, project_id, name, description) VALUES (1, 1, 'Core', 'Core network');
INSERT INTO topology_nodes (id, project_id, device_id, label, type, x, y, width, height, topology_id) VALUES
  (1, 1, 1, 'Core switch', 'switch', 100, 100, 150, 50, 1),
  (2, 1, 2, NULL, 'server', 400, 100, 150, 50, 1);
INSERT INTO topology_edges (id, project_id, source_node_id, target_node_id, label, topology_id, source_element_type, target_element_type) VALUES
  (1, 1, 1, 2, '10G', 1, 'node', 'node');
INSERT INTO topology_labels (project_id, text, x, y, topology_id) VALUES (1, 'Server side', 400, 40, 1);
INSERT INTO topology_zones (project_id, name, border_style, color, x, y, width, height, topology_id) VALUES (1, 'DC', 'solid', '#999', 50, 50, 600, 200, 1);

INSERT INTO project_integrations (id, project_id, name, platform, base_url, api_key, verify_ssl, auto_sync, sync_interval_minutes, config) VALUES
  (1, 1, 'Office UniFi', 'unifi', 'https://192.168.10.1', 'v1:XuboltLeQ0RDkrLMSPNRU20BoLII095+foklSkRsmza4ghx5sM6oIWeIhTw3', 0, 1, 30, '{"site":"default"}');

INSERT INTO project_activity_log (project_id, user_id, action, details, created_at) VALUES
  (1, 1, 'rack.create', 'Created Rack A', '2024-02-03 10:11:12');
SET FOREIGN_KEY_CHECKS = 1;
