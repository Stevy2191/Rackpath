// Shared helpers used by platform adapters to write discovered devices and
// VLANs into Rackpath's schema.

const { nextVlanColor } = require('../utils/vlanColors');

const DEVICE_FIELDS = ['hostname', 'ip', 'mac', 'type', 'model', 'serial_number', 'status'];

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
      `INSERT INTO devices (project_id, hostname, ip, mac, type, model, serial_number, status, source_integration_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         hostname = VALUES(hostname),
         type = COALESCE(VALUES(type), type),
         model = COALESCE(VALUES(model), model),
         serial_number = COALESCE(VALUES(serial_number), serial_number),
         status = VALUES(status),
         source_integration_id = VALUES(source_integration_id)`,
      [
        projectId,
        values.hostname,
        values.ip,
        values.mac,
        values.type,
        values.model,
        values.serial_number,
        values.status,
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
         serial_number = COALESCE(?, serial_number), status = ?, source_integration_id = ?
       WHERE id = ?`,
      [values.type, values.model, values.serial_number, values.status, integrationId, existing[0].id]
    );
  } else {
    await db.query(
      `INSERT INTO devices (project_id, hostname, type, model, serial_number, status, source_integration_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [projectId, values.hostname, values.type, values.model, values.serial_number, values.status, integrationId]
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
// since there's nothing reliable to match them on.
async function upsertCamera(db, projectId, integrationId, camera) {
  const fields = {
    name: camera.name || camera.mac || 'Camera',
    model: camera.model || null,
    mac: camera.mac || null,
    ip_address: camera.ip_address || null,
    rtsp_url: camera.rtsp_url || null,
    rtsps_url_high: camera.rtsps_url_high || null,
    rtsps_url_medium: camera.rtsps_url_medium || null,
    rtsps_url_low: camera.rtsps_url_low || null,
    resolution: camera.resolution || null,
    status: camera.status || 'unknown',
    last_seen: camera.last_seen || new Date(),
  };

  if (fields.mac) {
    const [existing] = await db.query('SELECT id FROM project_cameras WHERE project_id = ? AND mac = ?', [
      projectId,
      fields.mac,
    ]);

    if (existing.length > 0) {
      // location_notes and stream_password are user-editable only (the
      // latter is the Manual Recovery code, which isn't available via the
      // Protect API) and must never be overwritten by a sync.
      await db.query(
        `UPDATE project_cameras SET integration_id = ?, name = ?, model = ?, ip_address = ?,
           rtsp_url = ?, rtsps_url_high = ?, rtsps_url_medium = ?, rtsps_url_low = ?, resolution = ?, status = ?, last_seen = ?
         WHERE id = ?`,
        [
          integrationId,
          fields.name,
          fields.model,
          fields.ip_address,
          fields.rtsp_url,
          fields.rtsps_url_high,
          fields.rtsps_url_medium,
          fields.rtsps_url_low,
          fields.resolution,
          fields.status,
          fields.last_seen,
          existing[0].id,
        ]
      );
      return true;
    }
  }

  await db.query(
    `INSERT INTO project_cameras
       (project_id, integration_id, name, model, mac, ip_address, rtsp_url, rtsps_url_high, rtsps_url_medium, rtsps_url_low, resolution, status, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      integrationId,
      fields.name,
      fields.model,
      fields.mac,
      fields.ip_address,
      fields.rtsp_url,
      fields.rtsps_url_high,
      fields.rtsps_url_medium,
      fields.rtsps_url_low,
      fields.resolution,
      fields.status,
      fields.last_seen,
    ]
  );
  return true;
}

// Insert or update an access-control device discovered by a UniFi Access
// sync, matched on (project_id, mac). Devices without a mac are always
// inserted as new rows since there's nothing reliable to match them on.
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
    online: !!device.online,
    door_lock_state: device.door_lock_state || null,
    door_open_state: device.door_open_state || null,
    connected_readers: device.connected_readers ? JSON.stringify(device.connected_readers) : null,
    access_groups: device.access_groups ? JSON.stringify(device.access_groups) : null,
    unlock_schedules: device.unlock_schedules ? JSON.stringify(device.unlock_schedules) : null,
    last_seen: device.last_seen || new Date(),
  };

  if (fields.mac) {
    const [existing] = await db.query('SELECT id FROM project_access_devices WHERE project_id = ? AND mac = ?', [
      projectId,
      fields.mac,
    ]);

    if (existing.length > 0) {
      await db.query(
        `UPDATE project_access_devices SET integration_id = ?, name = ?, device_type = ?, model = ?, ip_address = ?,
           firmware_version = ?, door_name = ?, location = ?, floor = ?, online = ?, door_lock_state = ?,
           door_open_state = ?, connected_readers = ?, access_groups = ?, unlock_schedules = ?, last_seen = ?
         WHERE id = ?`,
        [
          integrationId,
          fields.name,
          fields.device_type,
          fields.model,
          fields.ip_address,
          fields.firmware_version,
          fields.door_name,
          fields.location,
          fields.floor,
          fields.online,
          fields.door_lock_state,
          fields.door_open_state,
          fields.connected_readers,
          fields.access_groups,
          fields.unlock_schedules,
          fields.last_seen,
          existing[0].id,
        ]
      );
      return true;
    }
  }

  await db.query(
    `INSERT INTO project_access_devices
       (project_id, integration_id, name, device_type, model, mac, ip_address, firmware_version, door_name,
        location, floor, online, door_lock_state, door_open_state, connected_readers, access_groups,
        unlock_schedules, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      integrationId,
      fields.name,
      fields.device_type,
      fields.model,
      fields.mac,
      fields.ip_address,
      fields.firmware_version,
      fields.door_name,
      fields.location,
      fields.floor,
      fields.online,
      fields.door_lock_state,
      fields.door_open_state,
      fields.connected_readers,
      fields.access_groups,
      fields.unlock_schedules,
      fields.last_seen,
    ]
  );
  return true;
}

module.exports = { upsertDevice, upsertVlan, upsertCamera, upsertAccessDevice };
