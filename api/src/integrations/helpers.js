// Shared helpers used by platform adapters to write discovered devices and
// VLANs into Rackpath's schema.

const { nextVlanColor } = require('../utils/vlanColors');

// Inventory fields only. Integrations don't write online/offline status:
// Rackpath records what exists, it doesn't monitor it.
const DEVICE_FIELDS = ['hostname', 'ip', 'mac', 'type', 'model', 'serial_number'];

// Insert or update a device discovered by an integration sync. Devices are
// matched on (project_id, ip) or (project_id, mac) where available, falling
// back to (project_id, hostname) when neither is present.
async function upsertDevice(db, projectId, integrationId, device) {
  const values = {};
  for (const field of DEVICE_FIELDS) {
    values[field] = device[field] || null;
  }

  if (values.ip || values.mac) {
    await db.query(
      `INSERT INTO devices (project_id, hostname, ip, mac, type, model, serial_number, source_integration_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         hostname = VALUES(hostname),
         type = COALESCE(VALUES(type), type),
         model = COALESCE(VALUES(model), model),
         serial_number = COALESCE(VALUES(serial_number), serial_number),
         source_integration_id = VALUES(source_integration_id)`,
      [
        projectId,
        values.hostname,
        values.ip,
        values.mac,
        values.type,
        values.model,
        values.serial_number,
        integrationId,
      ]
    );
    return true;
  }

  if (!values.hostname) return false;

  const [existing] = await db.query('SELECT id FROM devices WHERE project_id = ? AND hostname = ?', [
    projectId,
    values.hostname,
  ]);

  if (existing.length > 0) {
    await db.query(
      `UPDATE devices SET type = COALESCE(?, type), model = COALESCE(?, model),
         serial_number = COALESCE(?, serial_number), source_integration_id = ?
       WHERE id = ?`,
      [values.type, values.model, values.serial_number, integrationId, existing[0].id]
    );
  } else {
    await db.query(
      `INSERT INTO devices (project_id, hostname, type, model, serial_number, source_integration_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [projectId, values.hostname, values.type, values.model, values.serial_number, integrationId]
    );
  }
  return true;
}

// Insert or update a VLAN definition discovered by an integration sync,
// matched on (project_id, vlan_id).  Color is never overwritten on update
// so user-customised or auto-assigned colors survive repeated syncs.
async function upsertVlan(db, projectId, vlan) {
  if (!vlan.vlan_id || !Number.isFinite(Number(vlan.vlan_id))) return false;

  const [existing] = await db.query('SELECT id FROM project_vlans WHERE project_id = ? AND vlan_id = ?', [
    projectId,
    vlan.vlan_id,
  ]);

  if (existing.length > 0) {
    await db.query('UPDATE project_vlans SET name = ?, subnet = COALESCE(?, subnet) WHERE id = ?', [
      vlan.name || `VLAN ${vlan.vlan_id}`,
      vlan.subnet || null,
      existing[0].id,
    ]);
  } else {
    const color = await nextVlanColor(db, projectId);
    await db.query(
      `INSERT INTO project_vlans (project_id, vlan_id, name, subnet, color) VALUES (?, ?, ?, ?, ?)`,
      [projectId, vlan.vlan_id, vlan.name || `VLAN ${vlan.vlan_id}`, vlan.subnet || null, color]
    );
  }
  return true;
}

// Insert or update a camera discovered by a UniFi Protect sync, matched on
// (project_id, mac). Cameras without a mac are always inserted as new rows
// since there's nothing reliable to match them on. Inventory only: name,
// model, IP and resolution. location_notes is user-editable and never
// overwritten by a sync.
async function upsertCamera(db, projectId, integrationId, camera) {
  const fields = {
    name: camera.name || camera.mac || 'Camera',
    model: camera.model || null,
    mac: camera.mac || null,
    ip_address: camera.ip_address || null,
    resolution: camera.resolution || null,
  };

  if (fields.mac) {
    const [existing] = await db.query('SELECT id FROM project_cameras WHERE project_id = ? AND mac = ?', [
      projectId,
      fields.mac,
    ]);
    if (existing.length > 0) {
      await db.query(
        `UPDATE project_cameras SET integration_id = ?, name = ?, model = ?, ip_address = ?, resolution = ?
         WHERE id = ?`,
        [integrationId, fields.name, fields.model, fields.ip_address, fields.resolution, existing[0].id]
      );
      return true;
    }
  }

  await db.query(
    `INSERT INTO project_cameras (project_id, integration_id, name, model, mac, ip_address, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [projectId, integrationId, fields.name, fields.model, fields.mac, fields.ip_address, fields.resolution]
  );
  return true;
}

// Insert or update an access-control device discovered by a UniFi Access
// sync, matched on (project_id, mac). Devices without a mac are always
// inserted as new rows since there's nothing reliable to match them on.
// Inventory only: no online state, door lock/open state, access groups or
// schedules.
async function upsertAccessDevice(db, projectId, integrationId, device) {
  const fields = {
    name: device.name || device.mac || 'Access Device',
    device_type: device.device_type || null,
    model: device.model || null,
    mac: device.mac || null,
    ip_address: device.ip_address || null,
    firmware_version: device.firmware_version || null,
    door_name: device.door_name || null,
    location: device.location || null,
    floor: device.floor || null,
    connected_readers: device.connected_readers ? JSON.stringify(device.connected_readers) : null,
  };
  const columns = Object.keys(fields);

  if (fields.mac) {
    const [existing] = await db.query('SELECT id FROM project_access_devices WHERE project_id = ? AND mac = ?', [
      projectId,
      fields.mac,
    ]);
    if (existing.length > 0) {
      await db.query(
        `UPDATE project_access_devices SET integration_id = ?, ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        [integrationId, ...columns.map((c) => fields[c]), existing[0].id]
      );
      return true;
    }
  }

  await db.query(
    `INSERT INTO project_access_devices (project_id, integration_id, ${columns.join(', ')})
     VALUES (?, ?, ${columns.map(() => '?').join(', ')})`,
    [projectId, integrationId, ...columns.map((c) => fields[c])]
  );
  return true;
}

module.exports = { upsertDevice, upsertVlan, upsertCamera, upsertAccessDevice };
