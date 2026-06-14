const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const ITEM_TYPES = ['device', 'patch-panel', 'blank', 'cable-manager', 'custom-device'];
const SIDES = ['front', 'back', 'both'];

// Find an existing slot in the same rack whose U range overlaps the given
// range on a "compatible" side (either slot is 'both', or both sides match).
// Returns the colliding row, or null if the placement is free.
async function findCollision(rackId, projectId, uPosition, uSize, side, excludeId) {
  let query = 'SELECT id, u_position, u_size, side FROM rack_slots WHERE rack_id = ? AND project_id = ?';
  const params = [rackId, projectId];
  if (excludeId) {
    query += ' AND id != ?';
    params.push(excludeId);
  }
  const [rows] = await pool.query(query, params);

  const top = uPosition + uSize - 1;
  for (const row of rows) {
    const rowTop = row.u_position + row.u_size - 1;
    const overlaps = uPosition <= rowTop && top >= row.u_position;
    if (!overlaps) continue;
    const sidesCollide = side === 'both' || row.side === 'both' || side === row.side;
    if (sidesCollide) return row;
  }
  return null;
}

// GET /api/rack-slots?rack_id=1 - list slots in the current project, optionally
// filtered by rack
router.get('/', async (req, res, next) => {
  try {
    const { rack_id } = req.query;
    let query = `
      SELECT rs.*, d.hostname, d.ip, d.type AS device_type
      FROM rack_slots rs
      LEFT JOIN devices d ON d.id = rs.device_id
      WHERE rs.project_id = ?`;
    const params = [req.projectId];
    if (rack_id) {
      query += ' AND rs.rack_id = ?';
      params.push(rack_id);
    }
    query += ' ORDER BY rs.u_position';
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/rack-slots - assign a device (or rack item) to a rack U position
router.post('/', async (req, res, next) => {
  try {
    const { rack_id, device_id, u_position, item_type, item_label, side, custom_type, color } = req.body;
    const u_size = req.body.u_size || 1;
    if (!rack_id || u_position === undefined) {
      return res.status(400).json({ error: 'rack_id and u_position are required' });
    }
    if (item_type !== undefined && item_type !== null && !ITEM_TYPES.includes(item_type)) {
      return res.status(400).json({ error: 'Invalid item_type' });
    }
    if (side !== undefined && side !== null && !SIDES.includes(side)) {
      return res.status(400).json({ error: 'Invalid side' });
    }
    if (u_size < 1) return res.status(400).json({ error: 'u_size must be at least 1' });

    const [racks] = await pool.query('SELECT u_height FROM racks WHERE id = ? AND project_id = ?', [
      rack_id,
      req.projectId,
    ]);
    if (racks.length === 0) return res.status(404).json({ error: 'Rack not found' });
    if (u_position + u_size - 1 > racks[0].u_height) {
      return res.status(400).json({ error: 'Slot extends beyond rack height' });
    }

    const resolvedSide = side || 'both';
    const collision = await findCollision(rack_id, req.projectId, u_position, u_size, resolvedSide, null);
    if (collision) {
      return res.status(409).json({ error: `U${collision.u_position} is already occupied` });
    }

    const [result] = await pool.query(
      `INSERT INTO rack_slots (project_id, rack_id, device_id, item_type, item_label, custom_type, color, u_position, u_size, side)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.projectId, rack_id, device_id || null, item_type || 'device', item_label || null, custom_type || null, color || null, u_position, u_size, resolvedSide]
    );
    const [rows] = await pool.query('SELECT * FROM rack_slots WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/rack-slots/:id - update slot (move device, resize, re-side, relabel)
router.put('/:id', async (req, res, next) => {
  try {
    const { rack_id, device_id, item_type, item_label, side, custom_type, color } = req.body;
    let u_position = req.body.u_position;
    const u_size = req.body.u_size || 1;
    if (item_type !== undefined && item_type !== null && !ITEM_TYPES.includes(item_type)) {
      return res.status(400).json({ error: 'Invalid item_type' });
    }
    if (side !== undefined && side !== null && !SIDES.includes(side)) {
      return res.status(400).json({ error: 'Invalid side' });
    }
    if (u_size < 1) return res.status(400).json({ error: 'u_size must be at least 1' });

    const [racks] = await pool.query('SELECT u_height FROM racks WHERE id = ? AND project_id = ?', [
      rack_id,
      req.projectId,
    ]);
    if (racks.length === 0) return res.status(404).json({ error: 'Rack not found' });

    const uHeight = racks[0].u_height;
    if (u_position + u_size - 1 > uHeight) {
      if (u_size > uHeight) {
        return res.status(400).json({ error: 'Not enough space to resize — free up adjacent slots first' });
      }
      // Slot's top edge would land above the top of the rack - shift it down
      // so it still fits, rather than rejecting the resize outright.
      u_position = uHeight - u_size + 1;
    }
    if (u_position < 1) {
      return res.status(400).json({ error: 'Not enough space to resize — free up adjacent slots first' });
    }

    const resolvedSide = side || 'both';
    const collision = await findCollision(rack_id, req.projectId, u_position, u_size, resolvedSide, req.params.id);
    if (collision) {
      return res.status(409).json({ error: `U${collision.u_position} is already occupied` });
    }

    const [result] = await pool.query(
      `UPDATE rack_slots
       SET rack_id = ?, device_id = ?, item_type = ?, item_label = ?, custom_type = ?, color = ?, u_position = ?, u_size = ?, side = ?
       WHERE id = ? AND project_id = ?`,
      [rack_id, device_id || null, item_type || 'device', item_label || null, custom_type || null, color || null, u_position, u_size, resolvedSide, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack slot not found' });
    const [rows] = await pool.query('SELECT * FROM rack_slots WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/rack-slots/:id - remove device from rack
router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM rack_slots WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack slot not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
