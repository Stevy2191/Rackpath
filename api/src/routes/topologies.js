const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const TOPO_SELECT = `
  SELECT t.*, l.name AS location_name
  FROM topologies t
  LEFT JOIN locations l ON l.id = t.location_id
`;

// Auto-create a master "Main Topology" for a project that has none yet,
// then return all topologies for the project.
async function getOrCreateTopologies(projectId) {
  let [rows] = await pool.query(
    `${TOPO_SELECT} WHERE t.project_id = ? ORDER BY t.is_master DESC, t.created_at ASC`,
    [projectId]
  );
  if (rows.length === 0) {
    const [result] = await pool.query(
      `INSERT INTO topologies (project_id, name, is_master) VALUES (?, 'Main Topology', TRUE)`,
      [projectId]
    );
    [rows] = await pool.query(`${TOPO_SELECT} WHERE t.id = ?`, [result.insertId]);
  }
  return rows;
}

// GET /api/projects/:projectId/topologies
router.get('/projects/:projectId/topologies', async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.projectId, 10);
    if (!projectId) return res.status(400).json({ error: 'Invalid projectId' });
    const rows = await getOrCreateTopologies(projectId);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/topologies
router.post('/projects/:projectId/topologies', async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.projectId, 10);
    if (!projectId) return res.status(400).json({ error: 'Invalid projectId' });

    const { name, description, location_id } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const [result] = await pool.query(
      `INSERT INTO topologies (project_id, name, description, location_id) VALUES (?, ?, ?, ?)`,
      [projectId, name.trim(), description?.trim() || null, location_id || null]
    );

    const [rows] = await pool.query(`${TOPO_SELECT} WHERE t.id = ?`, [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/topologies/:id
router.put('/topologies/:id', async (req, res, next) => {
  try {
    const { name, description, location_id } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const [result] = await pool.query(
      `UPDATE topologies SET name = ?, description = ?, location_id = ? WHERE id = ?`,
      [name.trim(), description?.trim() || null, location_id || null, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Topology not found' });

    const [rows] = await pool.query(`${TOPO_SELECT} WHERE t.id = ?`, [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topologies/:id
// Cannot delete if it is the master AND the only topology for the project.
router.delete('/topologies/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM topologies WHERE id = ?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Topology not found' });

    const topo = rows[0];

    if (topo.is_master) {
      const [[{ cnt }]] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM topologies WHERE project_id = ?`,
        [topo.project_id]
      );
      if (cnt <= 1) {
        return res.status(400).json({ error: 'Cannot delete the only topology' });
      }
    }

    // Cascade-delete all canvas elements belonging to this topology.
    await pool.query(`DELETE FROM topology_edges  WHERE topology_id = ?`, [req.params.id]);
    await pool.query(`DELETE FROM topology_nodes  WHERE topology_id = ?`, [req.params.id]);
    await pool.query(`DELETE FROM topology_zones  WHERE topology_id = ?`, [req.params.id]);
    await pool.query(`DELETE FROM topology_labels WHERE topology_id = ?`, [req.params.id]);
    await pool.query(`DELETE FROM topology_shapes WHERE topology_id = ?`, [req.params.id]);
    await pool.query(`DELETE FROM topologies WHERE id = ?`, [req.params.id]);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
