const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// GET /api/ports?device_id=123 - list ports, optionally filtered by device
router.get('/', async (req, res, next) => {
  try {
    const { device_id } = req.query;
    let query = 'SELECT * FROM ports';
    const params = [];
    if (device_id) {
      query += ' WHERE device_id = ?';
      params.push(device_id);
    }
    query += ' ORDER BY port_number, port_name';
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/ports/:id
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM ports WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Port not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/ports - create port
router.post('/', async (req, res, next) => {
  try {
    const {
      device_id, port_name, port_number, cable_type,
      connected_device_id, connected_port_id, speed,
    } = req.body;

    if (!device_id) return res.status(400).json({ error: 'device_id is required' });

    const [result] = await pool.query(
      `INSERT INTO ports
        (device_id, port_name, port_number, cable_type, connected_device_id, connected_port_id, speed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [device_id, port_name || null, port_number || null, cable_type || null,
        connected_device_id || null, connected_port_id || null, speed || null]
    );
    const [rows] = await pool.query('SELECT * FROM ports WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/ports/:id - update port (e.g. cable type, connection)
router.put('/:id', async (req, res, next) => {
  try {
    const {
      port_name, port_number, cable_type,
      connected_device_id, connected_port_id, speed,
    } = req.body;

    const [result] = await pool.query(
      `UPDATE ports
       SET port_name = ?, port_number = ?, cable_type = ?,
           connected_device_id = ?, connected_port_id = ?, speed = ?
       WHERE id = ?`,
      [port_name || null, port_number || null, cable_type || null,
        connected_device_id || null, connected_port_id || null, speed || null, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Port not found' });
    const [rows] = await pool.query('SELECT * FROM ports WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ports/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM ports WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Port not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
