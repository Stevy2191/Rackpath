const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// ─── LOCATIONS ────────────────────────────────────────────────────────────────

// GET /api/projects/:projectId/locations
router.get('/projects/:projectId/locations', async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.projectId, 10);
    // Include room count and rack count per location
    const [rows] = await pool.query(
      `SELECT l.*,
              COUNT(DISTINCT r.id) AS room_count,
              COUNT(DISTINCT rk.id) AS rack_count
       FROM locations l
       LEFT JOIN rooms r ON r.location_id = l.id
       LEFT JOIN racks rk ON rk.location_id = l.id
       WHERE l.project_id = ?
       GROUP BY l.id
       ORDER BY l.name`,
      [projectId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/locations
router.post('/projects/:projectId/locations', async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.projectId, 10);
    const { name, building_number, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const [result] = await pool.query(
      'INSERT INTO locations (project_id, name, building_number, notes) VALUES (?, ?, ?, ?)',
      [projectId, String(name).trim(), building_number || null, notes || null]
    );
    const [rows] = await pool.query(
      `SELECT l.*, 0 AS room_count, 0 AS rack_count FROM locations l WHERE l.id = ?`,
      [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/locations/:id
router.put('/locations/:id', async (req, res, next) => {
  try {
    const { name, building_number, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const [result] = await pool.query(
      'UPDATE locations SET name = ?, building_number = ?, notes = ? WHERE id = ? AND project_id = ?',
      [String(name).trim(), building_number || null, notes || null, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Location not found' });
    const [rows] = await pool.query(
      `SELECT l.*,
              COUNT(DISTINCT r.id) AS room_count,
              COUNT(DISTINCT rk.id) AS rack_count
       FROM locations l
       LEFT JOIN rooms r ON r.location_id = l.id
       LEFT JOIN racks rk ON rk.location_id = l.id
       WHERE l.id = ?
       GROUP BY l.id`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/locations/:id
router.delete('/locations/:id', async (req, res, next) => {
  try {
    // Null-out location_id on racks and devices before deleting (rooms cascade via FK)
    await pool.query('UPDATE racks SET location_id = NULL, room_id = NULL WHERE location_id = ?', [req.params.id]);
    await pool.query('UPDATE devices SET location_id = NULL, room_id = NULL WHERE location_id = ?', [req.params.id]);
    const [result] = await pool.query(
      'DELETE FROM locations WHERE id = ? AND project_id = ?',
      [req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Location not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── ROOMS ────────────────────────────────────────────────────────────────────

// GET /api/locations/:locationId/rooms
router.get('/locations/:locationId/rooms', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*,
              COUNT(DISTINCT rk.id) AS rack_count
       FROM rooms r
       LEFT JOIN racks rk ON rk.room_id = r.id
       WHERE r.location_id = ?
       GROUP BY r.id
       ORDER BY r.name`,
      [req.params.locationId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/locations/:locationId/rooms
router.post('/locations/:locationId/rooms', async (req, res, next) => {
  try {
    const { name, floor, room_number, notes, contact_name, contact_phone, contact_email } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    // Verify location belongs to the current project
    const [locs] = await pool.query(
      'SELECT id FROM locations WHERE id = ? AND project_id = ?',
      [req.params.locationId, req.projectId]
    );
    if (locs.length === 0) return res.status(404).json({ error: 'Location not found' });

    const [result] = await pool.query(
      `INSERT INTO rooms (location_id, name, floor, room_number, notes, contact_name, contact_phone, contact_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.params.locationId,
        String(name).trim(),
        floor || null,
        room_number || null,
        notes || null,
        contact_name || null,
        contact_phone || null,
        contact_email || null,
      ]
    );
    const [rows] = await pool.query(
      'SELECT r.*, 0 AS rack_count FROM rooms r WHERE r.id = ?',
      [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/rooms/:id
router.put('/rooms/:id', async (req, res, next) => {
  try {
    const { name, floor, room_number, notes, contact_name, contact_phone, contact_email } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    // Verify room's location belongs to the current project
    const [rooms] = await pool.query(
      `SELECT r.id FROM rooms r
       JOIN locations l ON l.id = r.location_id
       WHERE r.id = ? AND l.project_id = ?`,
      [req.params.id, req.projectId]
    );
    if (rooms.length === 0) return res.status(404).json({ error: 'Room not found' });

    await pool.query(
      `UPDATE rooms SET name = ?, floor = ?, room_number = ?, notes = ?,
              contact_name = ?, contact_phone = ?, contact_email = ?
       WHERE id = ?`,
      [
        String(name).trim(),
        floor || null,
        room_number || null,
        notes || null,
        contact_name || null,
        contact_phone || null,
        contact_email || null,
        req.params.id,
      ]
    );
    const [rows] = await pool.query(
      `SELECT r.*,
              COUNT(DISTINCT rk.id) AS rack_count
       FROM rooms r
       LEFT JOIN racks rk ON rk.room_id = r.id
       WHERE r.id = ?
       GROUP BY r.id`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/rooms/:id
router.delete('/rooms/:id', async (req, res, next) => {
  try {
    // Null-out room_id on racks and devices before deleting
    await pool.query('UPDATE racks SET room_id = NULL WHERE room_id = ?', [req.params.id]);
    await pool.query('UPDATE devices SET room_id = NULL WHERE room_id = ?', [req.params.id]);
    const [result] = await pool.query(
      `DELETE FROM rooms WHERE id = ? AND location_id IN (
         SELECT id FROM locations WHERE project_id = ?
       )`,
      [req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Room not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
