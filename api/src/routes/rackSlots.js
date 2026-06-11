const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// GET /api/rack-slots?rack_id=1 - list slots in the current project, optionally
// filtered by rack
router.get('/', async (req, res, next) => {
  try {
    const { rack_id } = req.query;
    let query = `
      SELECT rs.*, d.hostname, d.ip, d.type AS device_type
      FROM rack_slots rs
      LEFT JOIN devices d ON d.id = rs.device_id
      WHERE rs.project_id = ?`;
    const params = [req.projectId];
    if (rack_id) {
      query += ' AND rs.rack_id = ?';
      params.push(rack_id);
    }
    query += ' ORDER BY rs.u_position';
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/rack-slots - assign a device to a rack U position
router.post('/', async (req, res, next) => {
  try {
    const { rack_id, device_id, u_position, u_size } = req.body;
    if (!rack_id || u_position === undefined) {
      return res.status(400).json({ error: 'rack_id and u_position are required' });
    }

    const [result] = await pool.query(
      'INSERT INTO rack_slots (project_id, rack_id, device_id, u_position, u_size) VALUES (?, ?, ?, ?, ?)',
      [req.projectId, rack_id, device_id || null, u_position, u_size || 1]
    );
    const [rows] = await pool.query('SELECT * FROM rack_slots WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/rack-slots/:id - update slot (move device, resize)
router.put('/:id', async (req, res, next) => {
  try {
    const { rack_id, device_id, u_position, u_size } = req.body;
    const [result] = await pool.query(
      'UPDATE rack_slots SET rack_id = ?, device_id = ?, u_position = ?, u_size = ? WHERE id = ? AND project_id = ?',
      [rack_id, device_id || null, u_position, u_size || 1, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack slot not found' });
    const [rows] = await pool.query('SELECT * FROM rack_slots WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/rack-slots/:id - remove device from rack
router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM rack_slots WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack slot not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
