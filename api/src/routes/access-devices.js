const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const FIELDS = [
  'name',
  'device_type',
  'model',
  'mac',
  'ip_address',
  'firmware_version',
  'door_name',
  'location',
  'floor',
  'online',
  'door_lock_state',
  'door_open_state',
  'connected_readers',
  'access_groups',
  'unlock_schedules',
];

// connected_readers/access_groups/unlock_schedules are stored as JSON text;
// the frontend sends/receives them as arrays.
const JSON_FIELDS = ['connected_readers', 'access_groups', 'unlock_schedules'];

function serializeRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const field of JSON_FIELDS) {
    if (typeof out[field] === 'string') {
      try {
        out[field] = JSON.parse(out[field]);
      } catch {
        out[field] = [];
      }
    } else if (out[field] == null) {
      out[field] = [];
    }
  }
  return out;
}

function fieldValue(field, body) {
  if (field === 'name') return body.name.trim();
  if (field === 'online') return !!body.online;
  if (field === 'door_lock_state' || field === 'door_open_state') return body[field] || 'unknown';
  if (JSON_FIELDS.includes(field)) return body[field] ? JSON.stringify(body[field]) : null;
  return body[field] !== undefined && body[field] !== '' ? body[field] : null;
}

// GET /api/projects/:projectId/access-devices - list access devices for a project
router.get('/projects/:projectId/access-devices', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM project_access_devices WHERE project_id = ? ORDER BY name ASC', [
      req.params.projectId,
    ]);
    res.json(rows.map(serializeRow));
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/access-devices - manually add an access device
router.post('/projects/:projectId/access-devices', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const values = FIELDS.map((field) => fieldValue(field, req.body));

    const [result] = await pool.query(
      `INSERT INTO project_access_devices (project_id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`,
      [req.params.projectId, ...values]
    );
    const [rows] = await pool.query('SELECT * FROM project_access_devices WHERE id = ?', [result.insertId]);
    res.status(201).json(serializeRow(rows[0]));
  } catch (err) {
    next(err);
  }
});

// PUT /api/access-devices/:id - update an access device
router.put('/access-devices/:id', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const values = FIELDS.map((field) => fieldValue(field, req.body));

    const [result] = await pool.query(
      `UPDATE project_access_devices SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND project_id = ?`,
      [...values, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Access device not found' });

    const [rows] = await pool.query('SELECT * FROM project_access_devices WHERE id = ?', [req.params.id]);
    res.json(serializeRow(rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/access-devices/:id - remove an access device
router.delete('/access-devices/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM project_access_devices WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Access device not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
