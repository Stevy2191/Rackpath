const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const DEFAULT_COLOR = '#4A90E2';

// GET /api/projects/:projectId/device-tags - list tags for a project
router.get('/projects/:projectId/device-tags', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM device_tags WHERE project_id = ? ORDER BY name ASC', [
      req.params.projectId,
    ]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/device-tags - create a tag
router.post('/projects/:projectId/device-tags', async (req, res, next) => {
  try {
    const { name, color } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const [result] = await pool.query('INSERT INTO device_tags (project_id, name, color) VALUES (?, ?, ?)', [
      req.params.projectId,
      name.trim(),
      color || DEFAULT_COLOR,
    ]);
    const [rows] = await pool.query('SELECT * FROM device_tags WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/device-tags/:id - update a tag's name/color
router.put('/device-tags/:id', async (req, res, next) => {
  try {
    const { name, color } = req.body || {};
    const updates = [];
    const values = [];

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'name is required' });
      updates.push('name = ?');
      values.push(name.trim());
    }
    if (color !== undefined) {
      updates.push('color = ?');
      values.push(color || DEFAULT_COLOR);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id, req.projectId);
    const [result] = await pool.query(`UPDATE device_tags SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`, values);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Tag not found' });

    const [rows] = await pool.query('SELECT * FROM device_tags WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/device-tags/:id - delete a tag (and its device assignments)
router.delete('/device-tags/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM device_tags WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Tag not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
