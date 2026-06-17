const express = require('express');
const pool = require('../db/pool');
const { logActivity } = require('../services/activityLog');

const router = express.Router();

const RACK_TYPES = ['4-post', '2-post', 'wall-mount', 'open-frame', 'blade-enclosure'];

function validateRackFields(body) {
  const { rack_type, u_height } = body;
  if (rack_type !== undefined && rack_type !== null && !RACK_TYPES.includes(rack_type)) {
    return 'Invalid rack_type';
  }
  if (u_height !== undefined && u_height !== null && (u_height < 1 || u_height > 100)) {
    return 'u_height must be between 1 and 100';
  }
  return null;
}

// GET /api/racks - list all racks in the current project
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM racks WHERE project_id = ? ORDER BY name', [
      req.projectId,
    ]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/racks/:id - single rack with its slots
router.get('/:id', async (req, res, next) => {
  try {
    const [racks] = await pool.query('SELECT * FROM racks WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
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
    const { name, location, u_height, rack_type, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const validationError = validateRackFields(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const { rack_width } = req.body;
    const [result] = await pool.query(
      'INSERT INTO racks (project_id, name, location, u_height, rack_type, notes, rack_width) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.projectId, name, location || null, u_height || 42, rack_type || '4-post', notes || null, rack_width || '19"']
    );
    const [rows] = await pool.query('SELECT * FROM racks WHERE id = ?', [result.insertId]);
    logActivity(req.projectId, req.user.id, 'rack.created', rows[0].name);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/racks/:id - update rack
router.put('/:id', async (req, res, next) => {
  try {
    const { name, location, u_height, rack_type, notes, show_rear, rack_width, annotation_field, show_annotations } = req.body;

    const validationError = validateRackFields(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const [result] = await pool.query(
      'UPDATE racks SET name = ?, location = ?, u_height = ?, rack_type = ?, notes = ?, show_rear = ?, rack_width = ?, annotation_field = ?, show_annotations = ? WHERE id = ? AND project_id = ?',
      [name, location || null, u_height || 42, rack_type || '4-post', notes || null, show_rear !== undefined ? show_rear : 1, rack_width || '19"', annotation_field || null, show_annotations ? 1 : 0, req.params.id, req.projectId]
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
    const [existing] = await pool.query('SELECT name FROM racks WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    const [result] = await pool.query('DELETE FROM racks WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack not found' });
    logActivity(req.projectId, req.user.id, 'rack.deleted', existing[0]?.name || `Rack ${req.params.id}`);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
