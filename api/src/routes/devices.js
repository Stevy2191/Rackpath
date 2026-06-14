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
router.get('/', async (req, res, next) => {
  try {
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
    if (req.query.type) {
      conditions.push('d.type = ?');
      params.push(req.query.type);
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

    const tagIds = parseTagIds(req.query.tag);
    if (tagIds.length > 0) {
      conditions.push(
        `d.id IN (SELECT device_id FROM device_tag_assignments WHERE tag_id IN (${tagIds.map(() => '?').join(', ')}))`
      );
      params.push(...tagIds);
    }

    query += ` WHERE ${conditions.join(' AND ')} ORDER BY d.hostname, d.ip`;

    const [rows] = await pool.query(query, params);

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const [tagRows] = await pool.query(
        `SELECT dta.device_id, t.id, t.name, t.color
         FROM device_tag_assignments dta
         JOIN device_tags t ON t.id = dta.tag_id
         WHERE dta.device_id IN (${ids.map(() => '?').join(', ')})
         ORDER BY t.name ASC`,
        ids
      );
      const tagsByDevice = {};
      for (const tr of tagRows) {
        if (!tagsByDevice[tr.device_id]) tagsByDevice[tr.device_id] = [];
        tagsByDevice[tr.device_id].push({ id: tr.id, name: tr.name, color: tr.color });
      }
      for (const row of rows) {
        row.tags = tagsByDevice[row.id] || [];
      }
    }

    res.json(rows);
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
    if (!tag_id) return res.status(400).json({ error: 'tag_id is required' });

    const [deviceRows] = await pool.query('SELECT id FROM devices WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (deviceRows.length === 0) return res.status(404).json({ error: 'Device not found' });

    const [tagRows] = await pool.query('SELECT id FROM device_tags WHERE id = ? AND project_id = ?', [
      tag_id,
      req.projectId,
    ]);
    if (tagRows.length === 0) return res.status(404).json({ error: 'Tag not found' });

    await pool.query('INSERT IGNORE INTO device_tag_assignments (device_id, tag_id) VALUES (?, ?)', [
      req.params.id,
      tag_id,
    ]);

    const [tags] = await pool.query(
      `SELECT t.id, t.name, t.color
       FROM device_tag_assignments dta
       JOIN device_tags t ON t.id = dta.tag_id
       WHERE dta.device_id = ?
       ORDER BY t.name ASC`,
      [req.params.id]
    );
    res.status(201).json(tags);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/devices/:id/tags/:tagId - remove a tag from a device
router.delete('/:id/tags/:tagId', async (req, res, next) => {
  try {
    const [deviceRows] = await pool.query('SELECT id FROM devices WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (deviceRows.length === 0) return res.status(404).json({ error: 'Device not found' });

    await pool.query('DELETE FROM device_tag_assignments WHERE device_id = ? AND tag_id = ?', [
      req.params.id,
      req.params.tagId,
    ]);
    res.status(204).send();
  } catch (err) {
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
    if (nodeRows.length > 0) {
      const [existingInterfaces] = await pool.query(
        'SELECT id, name FROM topology_node_interfaces WHERE device_id = ? AND project_id = ?',
        [device.id, req.projectId]
      );
      const existingByName = new Map(existingInterfaces.map((row) => [row.name, row.id]));

      for (const iface of result.interfaces) {
        if (existingByName.has(iface.name)) {
          await pool.query('UPDATE topology_node_interfaces SET speed = ? WHERE id = ?', [
            iface.speed,
            existingByName.get(iface.name),
          ]);
        } else {
          await pool.query(
            'INSERT INTO topology_node_interfaces (project_id, device_id, name, speed) VALUES (?, ?, ?, ?)',
            [req.projectId, device.id, iface.name, iface.speed]
          );
        }
      }
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
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
