const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// GET /api/devices - list all devices in the current project
// GET /api/devices?unplaced=true - only devices with no linked topology node
router.get('/', async (req, res, next) => {
  try {
    let query =
      'SELECT d.*, tn.id AS topology_node_id, pi.platform AS source_integration_platform, pi.name AS source_integration_name ' +
      'FROM devices d ' +
      'LEFT JOIN topology_nodes tn ON tn.device_id = d.id ' +
      'LEFT JOIN project_integrations pi ON pi.id = d.source_integration_id';
    const params = [];
    if (req.query.unplaced === 'true') {
      query += ' WHERE tn.id IS NULL AND d.project_id = ?';
    } else {
      query += ' WHERE d.project_id = ?';
    }
    params.push(req.projectId);
    query += ' ORDER BY d.hostname, d.ip';
    const [rows] = await pool.query(query, params);
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
    const { hostname, ip, mac, type, snmp_community, notes, make, model, serial_number, purchase_date, warranty_expiry } = req.body;
    const [result] = await pool.query(
      `INSERT INTO devices (project_id, hostname, ip, mac, type, snmp_community, notes, make, model, serial_number, purchase_date, warranty_expiry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.projectId,
        hostname || null,
        ip || null,
        mac || null,
        type || null,
        snmp_community || null,
        notes || null,
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
    const { hostname, ip, mac, type, snmp_community, notes, make, model, serial_number, purchase_date, warranty_expiry } = req.body;
    const [result] = await pool.query(
      `UPDATE devices
       SET hostname = ?, ip = ?, mac = ?, type = ?, snmp_community = ?, notes = ?,
           make = ?, model = ?, serial_number = ?, purchase_date = ?, warranty_expiry = ?
       WHERE id = ? AND project_id = ?`,
      [
        hostname || null,
        ip || null,
        mac || null,
        type || null,
        snmp_community || null,
        notes || null,
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
// topology properties panel)
router.patch('/:id', async (req, res, next) => {
  try {
    const allowedFields = [
      'hostname',
      'ip',
      'mac',
      'type',
      'snmp_community',
      'notes',
      'icon_color',
      'text_color',
      'make',
      'model',
      'serial_number',
      'purchase_date',
      'warranty_expiry',
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

module.exports = router;
