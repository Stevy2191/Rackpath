const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const FIELDS = [
  'name',
  'model',
  'mac',
  'ip_address',
  'rtsp_url',
  'rtsps_url',
  'stream_password',
  'username',
  'resolution',
  'location_notes',
  'status',
];

// GET /api/projects/:projectId/cameras - list cameras for a project
router.get('/projects/:projectId/cameras', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM project_cameras WHERE project_id = ? ORDER BY name ASC', [
      req.params.projectId,
    ]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/cameras - manually add a camera
router.post('/projects/:projectId/cameras', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const values = FIELDS.map((field) => {
      if (field === 'name') return name.trim();
      if (field === 'status') return req.body.status || 'unknown';
      return req.body[field] !== undefined && req.body[field] !== '' ? req.body[field] : null;
    });

    const [result] = await pool.query(
      `INSERT INTO project_cameras (project_id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`,
      [req.params.projectId, ...values]
    );
    const [rows] = await pool.query('SELECT * FROM project_cameras WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/cameras/:id - update a camera
router.put('/cameras/:id', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const values = FIELDS.map((field) => {
      if (field === 'name') return name.trim();
      if (field === 'status') return req.body.status || 'unknown';
      return req.body[field] !== undefined && req.body[field] !== '' ? req.body[field] : null;
    });

    const [result] = await pool.query(
      `UPDATE project_cameras SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND project_id = ?`,
      [...values, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Camera not found' });

    const [rows] = await pool.query('SELECT * FROM project_cameras WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cameras/:id - remove a camera
router.delete('/cameras/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM project_cameras WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Camera not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
