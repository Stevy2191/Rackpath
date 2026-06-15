const express = require('express');
const pool = require('../db/pool');
const { logActivity } = require('../services/activityLog');

const router = express.Router();

const MACRO_TYPES = ['snmp_v1', 'snmp_v2c', 'snmp_v3', 'ssh', 'telnet', 'http', 'https'];

const FIELDS = [
  'name',
  'type',
  'community_string',
  'username',
  'password',
  'auth_protocol',
  'auth_password',
  'priv_protocol',
  'priv_password',
  'port',
  'notes',
];

// GET /api/projects/:projectId/macros - list credential macros for a project
router.get('/projects/:projectId/macros', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM project_credential_macros WHERE project_id = ? ORDER BY name ASC',
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/macros - create a credential macro
router.post('/projects/:projectId/macros', async (req, res, next) => {
  try {
    const { name, type } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!type || !MACRO_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });

    const values = FIELDS.map((field) => {
      if (field === 'name') return name.trim();
      if (field === 'type') return type;
      return req.body[field] !== undefined && req.body[field] !== '' ? req.body[field] : null;
    });

    const [result] = await pool.query(
      `INSERT INTO project_credential_macros (project_id, ${FIELDS.join(', ')})
       VALUES (?, ${FIELDS.map(() => '?').join(', ')})`,
      [req.params.projectId, ...values]
    );
    const [rows] = await pool.query('SELECT * FROM project_credential_macros WHERE id = ?', [result.insertId]);
    logActivity(req.params.projectId, req.user.id, 'macro.created', rows[0].name);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/macros/:id - update a credential macro
router.put('/macros/:id', async (req, res, next) => {
  try {
    const { name, type } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!type || !MACRO_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });

    const values = FIELDS.map((field) => {
      if (field === 'name') return name.trim();
      if (field === 'type') return type;
      return req.body[field] !== undefined && req.body[field] !== '' ? req.body[field] : null;
    });

    const [result] = await pool.query(
      `UPDATE project_credential_macros SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND project_id = ?`,
      [...values, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Macro not found' });

    const [rows] = await pool.query('SELECT * FROM project_credential_macros WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/macros/:id - delete a credential macro
router.delete('/macros/:id', async (req, res, next) => {
  try {
    const [existing] = await pool.query('SELECT name FROM project_credential_macros WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    const [result] = await pool.query('DELETE FROM project_credential_macros WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Macro not found' });
    logActivity(req.projectId, req.user.id, 'macro.deleted', existing[0]?.name || `Macro ${req.params.id}`);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
