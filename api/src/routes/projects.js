const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const DEFAULT_PROJECT_ID = 1;

// Tables that hold project-scoped data, deleted (child-first) when a project
// is removed. This works regardless of whether the project_id ON DELETE
// CASCADE foreign keys are present in a given deployment.
const SCOPED_TABLES = [
  'topology_edges',
  'topology_nodes',
  'topology_zones',
  'topology_layout',
  'rack_slots',
  'ports',
  'scan_jobs',
  'racks',
  'devices',
  'project_vlans',
  'project_integrations',
];

// GET /api/projects - list all projects
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM projects ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects - create a project
router.post('/', async (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const [result] = await pool.query(
      'INSERT INTO projects (name, description) VALUES (?, ?)',
      [name.trim(), description || null]
    );
    const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/projects/:id - rename / update a project
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'description'];
    const updates = [];
    const values = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(field === 'name' ? String(req.body[field]).trim() : req.body[field]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id);
    const [result] = await pool.query(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, values);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Project not found' });

    const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:id - delete a project and all of its data
router.delete('/:id', async (req, res, next) => {
  const projectId = parseInt(req.params.id, 10);
  if (projectId === DEFAULT_PROJECT_ID) {
    return res.status(400).json({ error: 'The Default Project cannot be deleted' });
  }

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT id FROM projects WHERE id = ?', [projectId]);
    if (rows.length === 0) {
      conn.release();
      return res.status(404).json({ error: 'Project not found' });
    }

    await conn.beginTransaction();
    for (const table of SCOPED_TABLES) {
      await conn.query(`DELETE FROM ${table} WHERE project_id = ?`, [projectId]);
    }
    await conn.query('DELETE FROM projects WHERE id = ?', [projectId]);
    await conn.commit();

    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
