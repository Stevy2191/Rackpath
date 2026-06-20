const express = require('express');
const pool = require('../db/pool');
const { logActivity } = require('../services/activityLog');

const router = express.Router();

const RACK_TYPES = ['4-post', '2-post', 'wall-mount', 'open-frame', 'blade-enclosure'];

function validateRackFields(body) {
  const { rack_type, u_height } = body;
  if (rack_type !== undefined && rack_type !== null && !RACK_TYPES.includes(rack_type)) {
    return 'Invalid rack_type';
  }
  if (u_height !== undefined && u_height !== null && (u_height < 1 || u_height > 100)) {
    return 'u_height must be between 1 and 100';
  }
  return null;
}

// GET /api/racks - list all racks in the current project
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM racks WHERE project_id = ? ORDER BY name', [
      req.projectId,
    ]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/racks/:id - single rack with its slots
router.get('/:id', async (req, res, next) => {
  try {
    const [racks] = await pool.query('SELECT * FROM racks WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (racks.length === 0) return res.status(404).json({ error: 'Rack not found' });

    const [slots] = await pool.query(
      `SELECT rs.*, d.hostname, d.ip, d.mac AS device_mac,
              d.serial_number AS device_serial_number, d.type AS device_type
       FROM rack_slots rs
       LEFT JOIN devices d ON d.id = rs.device_id
       WHERE rs.rack_id = ?
       ORDER BY rs.u_position`,
      [req.params.id]
    );

    res.json({ ...racks[0], slots });
  } catch (err) {
    next(err);
  }
});

// POST /api/racks - create rack
router.post('/', async (req, res, next) => {
  try {
    const { name, location, u_height, rack_type, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const validationError = validateRackFields(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const { rack_width } = req.body;
    const [result] = await pool.query(
      'INSERT INTO racks (project_id, name, location, u_height, rack_type, notes, rack_width) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.projectId, name, location || null, u_height || 42, rack_type || '4-post', notes || null, rack_width || '19"']
    );
    const [rows] = await pool.query('SELECT * FROM racks WHERE id = ?', [result.insertId]);
    logActivity(req.projectId, req.user.id, 'rack.created', rows[0].name);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/racks/:id - update rack
router.put('/:id', async (req, res, next) => {
  try {
    const { name, location, u_height, rack_type, notes, show_rear, rack_width, annotation_field, show_annotations } = req.body;

    const validationError = validateRackFields(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const resolvedHeight = u_height || 42;

    // Shrinking the rack only fails if the devices genuinely don't fit —
    // i.e. the total number of distinct U rows they occupy exceeds the new
    // height. If they do fit but some are positioned above the new height,
    // reflow (compact) everything downward to close the gaps rather than
    // blocking the resize outright. Vertical PDUs are 0U floating elements,
    // not real U-grid occupants, so they're excluded from both the fit
    // check and the reflow — their u_size is kept in sync with the rack
    // height below instead.
    const [slots] = await pool.query(
      `SELECT id, u_position, u_size FROM rack_slots
       WHERE rack_id = ? AND project_id = ? AND item_type != 'vertical-pdu'`,
      [req.params.id, req.projectId]
    );

    const occupied = new Set();
    for (const s of slots) {
      const top = s.u_position + s.u_size - 1;
      for (let u = s.u_position; u <= top; u++) occupied.add(u);
    }
    const usedCount = occupied.size;

    if (usedCount > resolvedHeight) {
      return res.status(400).json({
        error: `Cannot resize: ${usedCount}U of devices installed, but ${resolvedHeight}U rack selected. Remove ${usedCount - resolvedHeight}U of equipment first.`,
      });
    }

    // Only reflow when something would otherwise land above the new
    // height — a shrink that already fits, or a grow, leaves positions
    // untouched. Mapping each occupied row to its rank among occupied rows
    // (ascending) packs everything down from U1 with no gaps, while
    // preserving relative order and keeping co-located slots (half-width
    // pairs sharing a row, or a device spanning multiple contiguous rows)
    // aligned, since they share the same row numbers before and after.
    const needsReflow = slots.some((s) => s.u_position + s.u_size - 1 > resolvedHeight);
    if (needsReflow) {
      const sortedRows = Array.from(occupied).sort((a, b) => a - b);
      const rank = new Map();
      sortedRows.forEach((row, i) => rank.set(row, i + 1));
      for (const s of slots) {
        const newPosition = rank.get(s.u_position);
        if (newPosition !== s.u_position) {
          await pool.query('UPDATE rack_slots SET u_position = ? WHERE id = ?', [newPosition, s.id]);
        }
      }
    }

    const [result] = await pool.query(
      'UPDATE racks SET name = ?, location = ?, u_height = ?, rack_type = ?, notes = ?, show_rear = ?, rack_width = ?, annotation_field = ?, show_annotations = ? WHERE id = ? AND project_id = ?',
      [name, location || null, resolvedHeight, rack_type || '4-post', notes || null, show_rear !== undefined ? show_rear : 1, rack_width || '19"', annotation_field || null, show_annotations ? 1 : 0, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack not found' });

    // Keep floating vertical PDUs spanning the full (new) rack height.
    await pool.query(
      `UPDATE rack_slots SET u_size = ? WHERE rack_id = ? AND project_id = ? AND item_type = 'vertical-pdu'`,
      [resolvedHeight, req.params.id, req.projectId]
    );

    const [rows] = await pool.query('SELECT * FROM racks WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/racks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const [existing] = await pool.query('SELECT name FROM racks WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    const [result] = await pool.query('DELETE FROM racks WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack not found' });
    logActivity(req.projectId, req.user.id, 'rack.deleted', existing[0]?.name || `Rack ${req.params.id}`);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
