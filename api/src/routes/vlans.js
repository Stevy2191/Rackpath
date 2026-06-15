const express = require('express');
const pool = require('../db/pool');
const { logActivity } = require('../services/activityLog');

const router = express.Router();

function isValidVlanId(value) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 1 && num <= 4094;
}

// GET /api/projects/:projectId/vlans - list VLANs defined for a project
router.get('/projects/:projectId/vlans', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM project_vlans WHERE project_id = ? ORDER BY vlan_id ASC',
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/vlans - create a VLAN definition
router.post('/projects/:projectId/vlans', async (req, res, next) => {
  try {
    const { vlan_id, name, description, subnet, color } = req.body || {};
    if (!isValidVlanId(vlan_id)) {
      return res.status(400).json({ error: 'vlan_id must be an integer between 1 and 4094' });
    }
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const [result] = await pool.query(
      `INSERT INTO project_vlans (project_id, vlan_id, name, description, subnet, color)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.projectId, Number(vlan_id), name.trim(), description || null, subnet || null, color || '#4A90E2']
    );

    const [rows] = await pool.query('SELECT * FROM project_vlans WHERE id = ?', [result.insertId]);
    logActivity(req.params.projectId, req.user.id, 'vlan.created', `VLAN ${rows[0].vlan_id} (${rows[0].name})`);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/vlans/:id - update a VLAN definition
router.put('/vlans/:id', async (req, res, next) => {
  try {
    const allowedFields = ['vlan_id', 'name', 'description', 'subnet', 'color'];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] === undefined) continue;

      if (field === 'vlan_id') {
        if (!isValidVlanId(req.body.vlan_id)) {
          return res.status(400).json({ error: 'vlan_id must be an integer between 1 and 4094' });
        }
        updates.push('vlan_id = ?');
        values.push(Number(req.body.vlan_id));
      } else if (field === 'name') {
        if (!req.body.name || !req.body.name.trim()) return res.status(400).json({ error: 'name is required' });
        updates.push('name = ?');
        values.push(req.body.name.trim());
      } else {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id, req.projectId);
    const [result] = await pool.query(
      `UPDATE project_vlans SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'VLAN not found' });

    const [rows] = await pool.query('SELECT * FROM project_vlans WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/vlans/:id - remove a VLAN definition
router.delete('/vlans/:id', async (req, res, next) => {
  try {
    const [existing] = await pool.query('SELECT vlan_id, name FROM project_vlans WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    const [result] = await pool.query('DELETE FROM project_vlans WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'VLAN not found' });
    if (existing.length > 0) {
      logActivity(req.projectId, req.user.id, 'vlan.deleted', `VLAN ${existing[0].vlan_id} (${existing[0].name})`);
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
