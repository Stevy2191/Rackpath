const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// GET /api/racks - list all racks
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM racks ORDER BY name');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/racks/:id - single rack with its slots
router.get('/:id', async (req, res, next) => {
  try {
    const [racks] = await pool.query('SELECT * FROM racks WHERE id = ?', [req.params.id]);
    if (racks.length === 0) return res.status(404).json({ error: 'Rack not found' });

    const [slots] = await pool.query(
      `SELECT rs.*, d.hostname, d.ip, d.type AS device_type
       FROM rack_slots rs
       LEFT JOIN devices d ON d.id = rs.device_id
       WHERE rs.rack_id = ?
       ORDER BY rs.u_position`,
      [req.params.id]
    );

    res.json({ ...racks[0], slots });
  } catch (err) {
    next(err);
  }
});

// POST /api/racks - create rack
router.post('/', async (req, res, next) => {
  try {
    const { name, location, u_height, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const [result] = await pool.query(
      'INSERT INTO racks (name, location, u_height, notes) VALUES (?, ?, ?, ?)',
      [name, location || null, u_height || 42, notes || null]
    );
    const [rows] = await pool.query('SELECT * FROM racks WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/racks/:id - update rack
router.put('/:id', async (req, res, next) => {
  try {
    const { name, location, u_height, notes } = req.body;
    const [result] = await pool.query(
      'UPDATE racks SET name = ?, location = ?, u_height = ?, notes = ? WHERE id = ?',
      [name, location || null, u_height || 42, notes || null, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack not found' });
    const [rows] = await pool.query('SELECT * FROM racks WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/racks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM racks WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
