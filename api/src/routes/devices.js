const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// GET /api/devices - list all devices
// GET /api/devices?unplaced=true - only devices with no topology canvas position
router.get('/', async (req, res, next) => {
  try {
    let query = 'SELECT d.* FROM devices d';
    if (req.query.unplaced === 'true') {
      query += ' LEFT JOIN topology_layout tl ON tl.device_id = d.id WHERE tl.id IS NULL';
    }
    query += ' ORDER BY d.hostname, d.ip';
    const [rows] = await pool.query(query);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/devices/:id - single device
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Device not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/devices - create device
router.post('/', async (req, res, next) => {
  try {
    const { hostname, ip, mac, type, snmp_community, notes } = req.body;
    const [result] = await pool.query(
      `INSERT INTO devices (hostname, ip, mac, type, snmp_community, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [hostname || null, ip || null, mac || null, type || null, snmp_community || null, notes || null]
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
    const { hostname, ip, mac, type, snmp_community, notes } = req.body;
    const [result] = await pool.query(
      `UPDATE devices
       SET hostname = ?, ip = ?, mac = ?, type = ?, snmp_community = ?, notes = ?
       WHERE id = ?`,
      [hostname || null, ip || null, mac || null, type || null, snmp_community || null, notes || null, req.params.id]
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
    const [result] = await pool.query('DELETE FROM devices WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Device not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
