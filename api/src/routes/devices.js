const express = require('express');
const snmp = require('net-snmp');
const pool = require('../db/pool');
const { scanDevice } = require('../services/snmpScan');

const router = express.Router();

// Normalizes the `tag` query param, which may arrive as a single value, a
// comma-separated string, or (with `tag=1&tag=2`) an array.
function parseTagIds(tag) {
  return []
    .concat(tag || [])
    .flatMap((value) => String(value).split(','))
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));
}

// GET /api/devices - list devices in the current project
// GET /api/devices?unplaced=true - only devices with no linked topology node
// GET /api/devices?type=&location=&tag=&search= - filter results
//
// Combines rows from `devices` and `project_cameras` into a single list so
// cameras show up in the All Devices view. Each row gets a `source` of
// 'device' or 'camera' so the frontend knows which table it came from and
// which edit modal to open. Filtering by type='camera' returns only camera
// rows; any other type (or no type filter) includes `devices` rows, and an
// empty type filter also includes cameras. Tag and "unplaced" filters only
// apply to `devices`, since cameras have neither tags nor topology nodes.
router.get('/', async (req, res, next) => {
  try {
    const typeFilter = req.query.type || '';
    const tagIds = parseTagIds(req.query.tag);
    const includeDevices = typeFilter !== 'camera';
    const includeCameras =
      (typeFilter === '' || typeFilter === 'camera') && tagIds.length === 0 && req.query.unplaced !== 'true';

    let rows = [];

    if (includeDevices) {
      let query =
        'SELECT d.*, tn.id AS topology_node_id, pi.platform AS source_integration_platform, pi.name AS source_integration_name ' +
        'FROM devices d ' +
        'LEFT JOIN topology_nodes tn ON tn.device_id = d.id ' +
        'LEFT JOIN project_integrations pi ON pi.id = d.source_integration_id';

      const conditions = ['d.project_id = ?'];
      const params = [req.projectId];

      if (req.query.unplaced === 'true') {
        conditions.push('tn.id IS NULL');
      }
      if (typeFilter) {
        conditions.push('d.type = ?');
        params.push(typeFilter);
      }
      if (req.query.location) {
        conditions.push('d.location = ?');
        params.push(req.query.location);
      }
      if (req.query.search) {
        conditions.push('(d.hostname LIKE ? OR d.ip LIKE ? OR d.model LIKE ? OR d.serial_number LIKE ?)');
        const like = `%${req.query.search}%`;
        params.push(like, like, like, like);
      }
      if (tagIds.length > 0) {
        conditions.push(
          `d.id IN (SELECT device_id FROM device_tag_assignments WHERE tag_id IN (${tagIds.map(() => '?').join(', ')}))`
        );
        params.push(...tagIds);
      }

      query += ` WHERE ${conditions.join(' AND ')}`;

      const [deviceRows] = await pool.query(query, params);
      for (const row of deviceRows) row.source = 'device';
      rows = rows.concat(deviceRows);
    }

    if (includeCameras) {
      let cameraQuery =
        `SELECT pc.id, pc.name AS hostname, pc.ip_address AS ip, pc.mac, 'camera' AS type, pc.model, ` +
        `pc.status, pc.location_notes AS location, pc.last_seen AS last_scanned_at, ` +
        `pc.integration_id AS source_integration_id, pi.platform AS source_integration_platform, ` +
        `pi.name AS source_integration_name ` +
        'FROM project_cameras pc ' +
        'LEFT JOIN project_integrations pi ON pi.id = pc.integration_id';

      const cameraConditions = ['pc.project_id = ?'];
      const cameraParams = [req.projectId];

      if (req.query.location) {
        cameraConditions.push('pc.location_notes = ?');
        cameraParams.push(req.query.location);
      }
      if (req.query.search) {
        cameraConditions.push('(pc.name LIKE ? OR pc.ip_address LIKE ? OR pc.model LIKE ?)');
        const like = `%${req.query.search}%`;
        cameraParams.push(like, like, like);
      }

      cameraQuery += ` WHERE ${cameraConditions.join(' AND ')}`;

      const [cameraRows] = await pool.query(cameraQuery, cameraParams);
      for (const row of cameraRows) {
        row.source = 'camera';
        row.topology_node_id = null;
        row.credential_macro_id = null;
        row.tags = [];
      }
      rows = rows.concat(cameraRows);
    }

    const deviceIds = rows.filter((r) => r.source === 'device').map((r) => r.id);
    if (deviceIds.length > 0) {
      const [tagRows] = await pool.query(
        `SELECT dta.device_id, t.id, t.name, t.color
         FROM device_tag_assignments dta
         JOIN device_tags t ON t.id = dta.tag_id
         WHERE dta.device_id IN (${deviceIds.map(() => '?').join(', ')})
         ORDER BY t.name ASC`,
        deviceIds
      );
      const tagsByDevice = {};
      for (const tr of tagRows) {
        if (!tagsByDevice[tr.device_id]) tagsByDevice[tr.device_id] = [];
        tagsByDevice[tr.device_id].push({ id: tr.id, name: tr.name, color: tr.color });
      }
      console.log('[devices.list] tag assignments by device:', tagsByDevice);
      for (const row of rows) {
        if (row.source === 'device') row.tags = tagsByDevice[row.id] || [];
      }
    }

    const cameraIds = rows.filter((r) => r.source === 'camera').map((r) => r.id);
    if (cameraIds.length > 0) {
      const [camTagRows] = await pool.query(
        `SELECT cta.camera_id, t.id, t.name, t.color
         FROM camera_tag_assignments cta
         JOIN device_tags t ON t.id = cta.tag_id
         WHERE cta.camera_id IN (${cameraIds.map(() => '?').join(', ')})
         ORDER BY t.name ASC`,
        cameraIds
      );
      const tagsByCamera = {};
      for (const tr of camTagRows) {
        if (!tagsByCamera[tr.camera_id]) tagsByCamera[tr.camera_id] = [];
        tagsByCamera[tr.camera_id].push({ id: tr.id, name: tr.name, color: tr.color });
      }
      console.log('[devices.list] tag assignments by camera:', tagsByCamera);
      for (const row of rows) {
        if (row.source === 'camera') row.tags = tagsByCamera[row.id] || [];
      }
    }

    rows.sort((a, b) => {
      const ah = (a.hostname || '').toLowerCase();
      const bh = (b.hostname || '').toLowerCase();
      if (ah !== bh) return ah < bh ? -1 : 1;
      const ai = (a.ip || '').toLowerCase();
      const bi = (b.ip || '').toLowerCase();
      if (ai !== bi) return ai < bi ? -1 : 1;
      return 0;
    });

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Maps the bulk-edit "Status" dropdown (online/offline/unknown, matching how
// project_cameras stores status) onto the up/down/unknown vocabulary used by
// the devices table and its SNMP/integration syncs.
const BULK_DEVICE_STATUS_MAP = { online: 'up', offline: 'down', unknown: 'unknown' };

// POST /api/devices/bulk-update - apply the same field changes to a batch of
// devices and/or cameras (selected via checkboxes on the Devices/Cameras
// pages). Only fields present in the body are applied; everything else is
// left untouched. `items` is an array of { id, source: 'device' | 'camera' }.
router.post('/bulk-update', async (req, res, next) => {
  try {
    const { items, location, tag_ids, tag_mode, credential_macro_id, status } = req.body || {};
    console.log('[devices.bulk-update] request body:', JSON.stringify(req.body));
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items is required' });
    }

    const deviceIds = items.filter((i) => i && i.source !== 'camera').map((i) => Number(i.id));
    const cameraIds = items.filter((i) => i && i.source === 'camera').map((i) => Number(i.id));
    console.log('[devices.bulk-update] deviceIds:', deviceIds, 'cameraIds:', cameraIds);

    if (deviceIds.length > 0) {
      const updates = [];
      const values = [];
      if (location !== undefined) {
        updates.push('location = ?');
        values.push(location || null);
      }
      if (credential_macro_id !== undefined) {
        updates.push('credential_macro_id = ?');
        values.push(credential_macro_id || null);
      }
      if (status !== undefined) {
        updates.push('status = ?');
        values.push(BULK_DEVICE_STATUS_MAP[status] || status);
      }
      if (updates.length > 0) {
        console.log('[devices.bulk-update] updating devices columns:', updates, 'values:', values);
        const [updateResult] = await pool.query(
          `UPDATE devices SET ${updates.join(', ')} WHERE project_id = ? AND id IN (${deviceIds.map(() => '?').join(', ')})`,
          [...values, req.projectId, ...deviceIds]
        );
        console.log('[devices.bulk-update] devices update affectedRows:', updateResult.affectedRows);
      }

      if (Array.isArray(tag_ids)) {
        console.log('[devices.bulk-update] tag update requested, tag_mode:', tag_mode, 'tag_ids:', tag_ids);

        let validTagIds = [];
        if (tag_ids.length > 0) {
          const [validTagRows] = await pool.query(
            `SELECT id FROM device_tags WHERE project_id = ? AND id IN (${tag_ids.map(() => '?').join(', ')})`,
            [req.projectId, ...tag_ids]
          );
          validTagIds = validTagRows.map((r) => r.id);
          console.log('[devices.bulk-update] valid tag ids for project', req.projectId, ':', validTagIds);
        }

        if (tag_mode === 'replace') {
          const delSql = `DELETE FROM device_tag_assignments WHERE device_id IN (${deviceIds.map(() => '?').join(', ')})`;
          console.log('[devices.bulk-update] replace mode SQL:', delSql, 'params:', deviceIds);
          try {
            const [delResult] = await pool.query(delSql, deviceIds);
            console.log('[devices.bulk-update] replace mode: deleted existing tag assignments, affectedRows:', delResult.affectedRows);
          } catch (err) {
            console.error('[devices.bulk-update] device tag assignment delete failed:', err);
            throw err;
          }
        }

        if (validTagIds.length > 0) {
          const pairs = [];
          const params = [];
          for (const deviceId of deviceIds) {
            for (const tagId of validTagIds) {
              pairs.push('(?, ?)');
              params.push(deviceId, tagId);
            }
          }
          const insSql = `INSERT IGNORE INTO device_tag_assignments (device_id, tag_id) VALUES ${pairs.join(', ')}`;
          console.log('[devices.bulk-update] device tag assignment insert SQL:', insSql, 'params:', params);
          try {
            const [insResult] = await pool.query(insSql, params);
            console.log('[devices.bulk-update] tag assignment insert affectedRows:', insResult.affectedRows);
          } catch (err) {
            console.error('[devices.bulk-update] device tag assignment insert failed:', err);
            throw err;
          }
        }
      }
    }

    if (cameraIds.length > 0) {
      const updates = [];
      const values = [];
      if (location !== undefined) {
        updates.push('location_notes = ?');
        values.push(location || null);
      }
      if (status !== undefined) {
        updates.push('status = ?');
        values.push(status || 'unknown');
      }
      if (updates.length > 0) {
        console.log('[devices.bulk-update] updating project_cameras columns:', updates, 'values:', values);
        const [updateResult] = await pool.query(
          `UPDATE project_cameras SET ${updates.join(', ')} WHERE project_id = ? AND id IN (${cameraIds.map(() => '?').join(', ')})`,
          [...values, req.projectId, ...cameraIds]
        );
        console.log('[devices.bulk-update] project_cameras update affectedRows:', updateResult.affectedRows);
      }

      if (Array.isArray(tag_ids)) {
        console.log('[devices.bulk-update] camera tag update requested, tag_mode:', tag_mode, 'tag_ids:', tag_ids);

        let validTagIds = [];
        if (tag_ids.length > 0) {
          const [validTagRows] = await pool.query(
            `SELECT id FROM device_tags WHERE project_id = ? AND id IN (${tag_ids.map(() => '?').join(', ')})`,
            [req.projectId, ...tag_ids]
          );
          validTagIds = validTagRows.map((r) => r.id);
          console.log('[devices.bulk-update] valid tag ids for project', req.projectId, '(cameras):', validTagIds);
        }

        if (tag_mode === 'replace') {
          const delSql = `DELETE FROM camera_tag_assignments WHERE camera_id IN (${cameraIds.map(() => '?').join(', ')})`;
          console.log('[devices.bulk-update] camera replace mode SQL:', delSql, 'params:', cameraIds);
          try {
            const [delResult] = await pool.query(delSql, cameraIds);
            console.log('[devices.bulk-update] camera replace mode: deleted existing tag assignments, affectedRows:', delResult.affectedRows);
          } catch (err) {
            console.error('[devices.bulk-update] camera tag assignment delete failed:', err);
            throw err;
          }
        }

        if (validTagIds.length > 0) {
          const pairs = [];
          const params = [];
          for (const cameraId of cameraIds) {
            for (const tagId of validTagIds) {
              pairs.push('(?, ?)');
              params.push(cameraId, tagId);
            }
          }
          const insSql = `INSERT IGNORE INTO camera_tag_assignments (camera_id, tag_id) VALUES ${pairs.join(', ')}`;
          console.log('[devices.bulk-update] camera tag assignment insert SQL:', insSql, 'params:', params);
          try {
            const [insResult] = await pool.query(insSql, params);
            console.log('[devices.bulk-update] camera tag assignment insert affectedRows:', insResult.affectedRows);
          } catch (err) {
            console.error('[devices.bulk-update] camera tag assignment insert failed:', err);
            throw err;
          }
        }
      }
    }

    res.json({ updated: deviceIds.length + cameraIds.length });
  } catch (err) {
    console.error('[devices.bulk-update] failed:', err);
    next(err);
  }
});

// POST /api/devices/bulk-delete - delete a batch of devices and/or cameras.
// `items` is an array of { id, source: 'device' | 'camera' }.
router.post('/bulk-delete', async (req, res, next) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items is required' });
    }

    const deviceIds = items.filter((i) => i && i.source !== 'camera').map((i) => Number(i.id));
    const cameraIds = items.filter((i) => i && i.source === 'camera').map((i) => Number(i.id));

    if (deviceIds.length > 0) {
      await pool.query(`DELETE FROM devices WHERE project_id = ? AND id IN (${deviceIds.map(() => '?').join(', ')})`, [
        req.projectId,
        ...deviceIds,
      ]);
    }
    if (cameraIds.length > 0) {
      await pool.query(`DELETE FROM project_cameras WHERE project_id = ? AND id IN (${cameraIds.map(() => '?').join(', ')})`, [
        req.projectId,
        ...cameraIds,
      ]);
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/devices/:id - single device
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: 'Device not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/devices - create device
router.post('/', async (req, res, next) => {
  try {
    const { hostname, ip, mac, type, snmp_community, notes, location, make, model, serial_number, purchase_date, warranty_expiry } = req.body;
    const [result] = await pool.query(
      `INSERT INTO devices (project_id, hostname, ip, mac, type, snmp_community, notes, location, make, model, serial_number, purchase_date, warranty_expiry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.projectId,
        hostname || null,
        ip || null,
        mac || null,
        type || null,
        snmp_community || null,
        notes || null,
        location || null,
        make || null,
        model || null,
        serial_number || null,
        purchase_date || null,
        warranty_expiry || null,
      ]
    );
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/devices/:id - update device
router.put('/:id', async (req, res, next) => {
  try {
    const { hostname, ip, mac, type, snmp_community, notes, location, make, model, serial_number, purchase_date, warranty_expiry } = req.body;
    const [result] = await pool.query(
      `UPDATE devices
       SET hostname = ?, ip = ?, mac = ?, type = ?, snmp_community = ?, notes = ?, location = ?,
           make = ?, model = ?, serial_number = ?, purchase_date = ?, warranty_expiry = ?
       WHERE id = ? AND project_id = ?`,
      [
        hostname || null,
        ip || null,
        mac || null,
        type || null,
        snmp_community || null,
        notes || null,
        location || null,
        make || null,
        model || null,
        serial_number || null,
        purchase_date || null,
        warranty_expiry || null,
        req.params.id,
        req.projectId,
      ]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Device not found' });
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/devices/:id - partial update (used for auto-save from the
// topology properties panel and inline edits on the Device Inventory page)
router.patch('/:id', async (req, res, next) => {
  try {
    const allowedFields = [
      'hostname',
      'ip',
      'mac',
      'type',
      'snmp_community',
      'notes',
      'location',
      'icon_color',
      'text_color',
      'make',
      'model',
      'serial_number',
      'purchase_date',
      'warranty_expiry',
      'credential_macro_id',
    ];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id, req.projectId);
    const [result] = await pool.query(
      `UPDATE devices SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Device not found' });

    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/devices/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM devices WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Device not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/devices/:id/tags - assign a tag to a device
router.post('/:id/tags', async (req, res, next) => {
  try {
    const { tag_id } = req.body || {};
    console.log('[devices.assignTag] device', req.params.id, 'tag_id', tag_id, 'project', req.projectId);
    if (!tag_id) return res.status(400).json({ error: 'tag_id is required' });

    const [deviceRows] = await pool.query('SELECT id FROM devices WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (deviceRows.length === 0) {
      console.log('[devices.assignTag] device not found:', req.params.id);
      return res.status(404).json({ error: 'Device not found' });
    }

    const [tagRows] = await pool.query('SELECT id FROM device_tags WHERE id = ? AND project_id = ?', [
      tag_id,
      req.projectId,
    ]);
    if (tagRows.length === 0) {
      console.log('[devices.assignTag] tag not found:', tag_id, 'for project', req.projectId);
      return res.status(404).json({ error: 'Tag not found' });
    }

    const [insResult] = await pool.query('INSERT IGNORE INTO device_tag_assignments (device_id, tag_id) VALUES (?, ?)', [
      req.params.id,
      tag_id,
    ]);
    console.log('[devices.assignTag] insert affectedRows:', insResult.affectedRows);

    const [tags] = await pool.query(
      `SELECT t.id, t.name, t.color
       FROM device_tag_assignments dta
       JOIN device_tags t ON t.id = dta.tag_id
       WHERE dta.device_id = ?
       ORDER BY t.name ASC`,
      [req.params.id]
    );
    console.log('[devices.assignTag] device', req.params.id, 'tags now:', tags);
    res.status(201).json(tags);
  } catch (err) {
    console.error('[devices.assignTag] failed:', err);
    next(err);
  }
});

// DELETE /api/devices/:id/tags/:tagId - remove a tag from a device
router.delete('/:id/tags/:tagId', async (req, res, next) => {
  try {
    console.log('[devices.removeTag] device', req.params.id, 'tag_id', req.params.tagId, 'project', req.projectId);
    const [deviceRows] = await pool.query('SELECT id FROM devices WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (deviceRows.length === 0) {
      console.log('[devices.removeTag] device not found:', req.params.id);
      return res.status(404).json({ error: 'Device not found' });
    }

    const [delResult] = await pool.query('DELETE FROM device_tag_assignments WHERE device_id = ? AND tag_id = ?', [
      req.params.id,
      req.params.tagId,
    ]);
    console.log('[devices.removeTag] delete affectedRows:', delResult.affectedRows);
    res.status(204).send();
  } catch (err) {
    console.error('[devices.removeTag] failed:', err);
    next(err);
  }
});

// POST /api/devices/:id/scan - probe a device over SNMP using its assigned
// credential macro, refresh hostname/location, and sync topology interfaces.
router.post('/:id/scan', async (req, res, next) => {
  try {
    const [deviceRows] = await pool.query('SELECT * FROM devices WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (deviceRows.length === 0) return res.status(404).json({ error: 'Device not found' });
    const device = deviceRows[0];

    if (!device.ip) {
      return res.status(400).json({ error: 'Device has no IP address' });
    }
    if (!device.credential_macro_id) {
      return res.status(400).json({ error: 'Device has no credential macro assigned' });
    }

    const [macroRows] = await pool.query(
      'SELECT * FROM project_credential_macros WHERE id = ? AND project_id = ?',
      [device.credential_macro_id, req.projectId]
    );
    if (macroRows.length === 0) return res.status(400).json({ error: 'Assigned credential macro not found' });
    const macro = macroRows[0];

    if (!macro.type.startsWith('snmp')) {
      return res.status(400).json({ error: 'Assigned credential macro is not an SNMP profile' });
    }

    let result;
    try {
      result = await scanDevice(device.ip, macro);
    } catch (err) {
      if (err instanceof snmp.RequestTimedOutError || err.name === 'RequestTimedOutError') {
        return res.status(502).json({ error: 'SNMP timeout — check IP and community string' });
      }
      return res.status(502).json({ error: err.message });
    }

    const updates = ['last_scanned_at = NOW()'];
    const values = [];

    const blankHostname = !device.hostname || device.hostname.toLowerCase() === 'unknown';
    if (blankHostname && result.sysName) {
      updates.push('hostname = ?');
      values.push(result.sysName);
    }
    if (!device.location && result.sysLocation) {
      updates.push('location = ?');
      values.push(result.sysLocation);
    }

    values.push(device.id, req.projectId);
    await pool.query(`UPDATE devices SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`, values);

    const [nodeRows] = await pool.query(
      'SELECT id FROM topology_nodes WHERE device_id = ? AND project_id = ?',
      [device.id, req.projectId]
    );

    let topologyInterfaceCount = 0;
    let topologyNodeHostname = null;
    if (nodeRows.length > 0) {
      const ipByIfIndex = new Map();
      for (const ipEntry of result.ips) {
        if (ipEntry.ifIndex != null && ipEntry.address) {
          ipByIfIndex.set(ipEntry.ifIndex, ipEntry.address);
        }
      }

      const [existingInterfaces] = await pool.query(
        'SELECT id, name, ip FROM topology_node_interfaces WHERE device_id = ? AND project_id = ?',
        [device.id, req.projectId]
      );
      const existingByName = new Map(existingInterfaces.map((row) => [row.name, row]));

      for (const iface of result.interfaces) {
        const discoveredIp = ipByIfIndex.get(iface.index) || null;
        const existing = existingByName.get(iface.name);

        if (existing) {
          await pool.query(
            'UPDATE topology_node_interfaces SET speed = ?, status = ?, description = ?, ip = ? WHERE id = ?',
            [iface.speed, iface.operStatus, iface.name, discoveredIp || existing.ip, existing.id]
          );
        } else {
          await pool.query(
            `INSERT INTO topology_node_interfaces (project_id, device_id, parent_id, name, description, ip, speed, status)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
            [req.projectId, device.id, iface.name, iface.name, discoveredIp, iface.speed, iface.operStatus]
          );
        }
      }

      topologyInterfaceCount = result.interfaces.length;
      topologyNodeHostname =
        blankHostname && result.sysName ? result.sysName : device.hostname || device.ip || `Device ${device.id}`;
    }

    res.json({
      sysName: result.sysName,
      sysDescr: result.sysDescr,
      sysLocation: result.sysLocation,
      sysContact: result.sysContact,
      uptime: result.uptime,
      interfaceCount: result.interfaces.length,
      ipCount: result.ips.length,
      interfaces: result.interfaces,
      ips: result.ips,
      topologyInterfaceCount,
      topologyNodeHostname,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
