const express = require('express');
const pool = require('../db/pool');
const { logActivity } = require('../services/activityLog');

const router = express.Router();

const FIELDS = [
  'name',
  'model',
  'mac',
  'ip_address',
  'rtsp_url',
  'rtsps_url_high',
  'rtsps_url_medium',
  'rtsps_url_low',
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
    logActivity(req.params.projectId, req.user.id, 'camera.created', rows[0].name);
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
    const [existing] = await pool.query('SELECT name FROM project_cameras WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    const [result] = await pool.query('DELETE FROM project_cameras WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Camera not found' });
    logActivity(req.projectId, req.user.id, 'camera.deleted', existing[0]?.name || `Camera ${req.params.id}`);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/cameras/:id/tags - assign a tag to a camera
router.post('/cameras/:id/tags', async (req, res, next) => {
  try {
    const { tag_id } = req.body || {};
    console.log('[cameras.assignTag] camera', req.params.id, 'tag_id', tag_id, 'project', req.projectId);
    if (!tag_id) return res.status(400).json({ error: 'tag_id is required' });

    const [cameraRows] = await pool.query('SELECT id FROM project_cameras WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (cameraRows.length === 0) {
      console.log('[cameras.assignTag] camera not found:', req.params.id);
      return res.status(404).json({ error: 'Camera not found' });
    }

    const [tagRows] = await pool.query('SELECT id FROM device_tags WHERE id = ? AND project_id = ?', [
      tag_id,
      req.projectId,
    ]);
    if (tagRows.length === 0) {
      console.log('[cameras.assignTag] tag not found:', tag_id, 'for project', req.projectId);
      return res.status(404).json({ error: 'Tag not found' });
    }

    const [insResult] = await pool.query('INSERT IGNORE INTO camera_tag_assignments (camera_id, tag_id) VALUES (?, ?)', [
      req.params.id,
      tag_id,
    ]);
    console.log('[cameras.assignTag] insert affectedRows:', insResult.affectedRows);

    const [tags] = await pool.query(
      `SELECT t.id, t.name, t.color
       FROM camera_tag_assignments cta
       JOIN device_tags t ON t.id = cta.tag_id
       WHERE cta.camera_id = ?
       ORDER BY t.name ASC`,
      [req.params.id]
    );
    console.log('[cameras.assignTag] camera', req.params.id, 'tags now:', tags);
    res.status(201).json(tags);
  } catch (err) {
    console.error('[cameras.assignTag] failed:', err);
    next(err);
  }
});

// DELETE /api/cameras/:id/tags/:tagId - remove a tag from a camera
router.delete('/cameras/:id/tags/:tagId', async (req, res, next) => {
  try {
    console.log('[cameras.removeTag] camera', req.params.id, 'tag_id', req.params.tagId, 'project', req.projectId);
    const [cameraRows] = await pool.query('SELECT id FROM project_cameras WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (cameraRows.length === 0) {
      console.log('[cameras.removeTag] camera not found:', req.params.id);
      return res.status(404).json({ error: 'Camera not found' });
    }

    const [delResult] = await pool.query('DELETE FROM camera_tag_assignments WHERE camera_id = ? AND tag_id = ?', [
      req.params.id,
      req.params.tagId,
    ]);
    console.log('[cameras.removeTag] delete affectedRows:', delResult.affectedRows);
    res.status(204).send();
  } catch (err) {
    console.error('[cameras.removeTag] failed:', err);
    next(err);
  }
});

module.exports = router;
