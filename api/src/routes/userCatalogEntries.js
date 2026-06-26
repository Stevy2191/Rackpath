const express = require('express');
const pool = require('../db/pool');
const { parseRowOutletGroups, parseRowsOutletGroups, parseRowRuntimeCurves } = require('../utils/outletGroups');

function parseUserCatalogRow(row) { return parseRowRuntimeCurves(parseRowOutletGroups(row)); }

const router = express.Router();

const MOUNTED_FACES = ['front', 'rear', 'both'];

const COLUMNS = [
  'name', 'render_type', 'u_size', 'color', 'half_width', 'half_depth', 'mounted_face',
  'outlet_groups', 'input_voltage', 'input_plug_type', 'capacity_value', 'capacity_unit',
  'capacity_va', 'capacity_w', 'port_count', 'bay_count',
  'runtime_curve', 'ebm_runtime_curve',
];

// GET /api/user-catalog-entries - list the current user's saved catalog entries
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM user_catalog_entries WHERE user_id = ? ORDER BY name',
      [req.user.id]
    );
    rows.forEach(parseUserCatalogRow);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/user-catalog-entries - save a device configuration as a reusable entry
router.post('/', async (req, res, next) => {
  try {
    const {
      name, render_type, u_size, color, half_width, half_depth, mounted_face,
      outlet_groups, input_voltage, input_plug_type, capacity_value, capacity_unit,
      capacity_va, capacity_w, port_count, bay_count,
      runtime_curve, ebm_runtime_curve,
    } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (mounted_face !== undefined && mounted_face !== null && !MOUNTED_FACES.includes(mounted_face)) {
      return res.status(400).json({ error: 'Invalid mounted_face' });
    }

    const [result] = await pool.query(
      `INSERT INTO user_catalog_entries
         (user_id, name, render_type, u_size, color, half_width, half_depth, mounted_face,
          outlet_groups, input_voltage, input_plug_type, capacity_value, capacity_unit,
          capacity_va, capacity_w, port_count, bay_count,
          runtime_curve, ebm_runtime_curve)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id, name.trim(), render_type || 'other', u_size || 1, color || null,
        half_width ? 1 : 0, half_depth ? 1 : 0, mounted_face || 'front',
        outlet_groups ? JSON.stringify(outlet_groups) : null, input_voltage || null,
        input_plug_type || null, capacity_value || null, capacity_unit || null,
        capacity_va || null, capacity_w || null, port_count || null, bay_count || null,
        runtime_curve ? JSON.stringify(runtime_curve) : null,
        ebm_runtime_curve ? JSON.stringify(ebm_runtime_curve) : null,
      ]
    );
    const [rows] = await pool.query('SELECT * FROM user_catalog_entries WHERE id = ?', [result.insertId]);
    res.status(201).json(parseUserCatalogRow(rows[0]));
  } catch (err) {
    next(err);
  }
});

// PUT /api/user-catalog-entries/:id - rename or update a saved entry
router.put('/:id', async (req, res, next) => {
  try {
    const updates = {};
    for (const key of COLUMNS) {
      if (key in req.body) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    if ('name' in updates && !String(updates.name).trim()) {
      return res.status(400).json({ error: 'name cannot be empty' });
    }
    if ('mounted_face' in updates && !MOUNTED_FACES.includes(updates.mounted_face)) {
      return res.status(400).json({ error: 'Invalid mounted_face' });
    }
    if ('outlet_groups' in updates) {
      updates.outlet_groups = updates.outlet_groups ? JSON.stringify(updates.outlet_groups) : null;
    }
    if ('runtime_curve' in updates) {
      updates.runtime_curve = updates.runtime_curve ? JSON.stringify(updates.runtime_curve) : null;
    }
    if ('ebm_runtime_curve' in updates) {
      updates.ebm_runtime_curve = updates.ebm_runtime_curve ? JSON.stringify(updates.ebm_runtime_curve) : null;
    }

    const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), req.params.id, req.user.id];
    const [result] = await pool.query(
      `UPDATE user_catalog_entries SET ${setClauses} WHERE id = ? AND user_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Catalog entry not found' });

    const [rows] = await pool.query('SELECT * FROM user_catalog_entries WHERE id = ?', [req.params.id]);
    res.json(parseUserCatalogRow(rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/user-catalog-entries/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM user_catalog_entries WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Catalog entry not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
