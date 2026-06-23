const express = require('express');
const pool = require('../db/pool');
const { logActivity } = require('../services/activityLog');
const { parseRowsOutletGroups } = require('../utils/outletGroups');

const router = express.Router();

const RACK_TYPES = ['4-post', '2-post', 'wall-mount', 'open-frame', 'blade-enclosure'];

// `location` is a legacy free-text column, superseded by the
// location_id/room_id hierarchy - the column stays in the DB (no
// migration needed) but is no longer read from requests or exposed in
// responses.
function omitLegacyLocation(row) {
  if (!row) return row;
  const { location, ...rest } = row;
  return rest;
}

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
    const [rows] = await pool.query(
      `SELECT rk.*, l.name AS location_name, r.name AS room_name
       FROM racks rk
       LEFT JOIN locations l ON l.id = rk.location_id
       LEFT JOIN rooms r ON r.id = rk.room_id
       WHERE rk.project_id = ?
       ORDER BY rk.name`,
      [req.projectId]
    );
    res.json(rows.map(omitLegacyLocation));
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

    res.json({ ...omitLegacyLocation(racks[0]), slots: parseRowsOutletGroups(slots) });
  } catch (err) {
    next(err);
  }
});

// POST /api/racks - create rack
router.post('/', async (req, res, next) => {
  try {
    const { name, u_height, rack_type, notes, rack_width, location_id, room_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const validationError = validateRackFields(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const [result] = await pool.query(
      'INSERT INTO racks (project_id, name, u_height, rack_type, notes, rack_width, location_id, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.projectId, name, u_height || 42, rack_type || '4-post', notes || null, rack_width || '19"', location_id || null, room_id || null]
    );
    const [rows] = await pool.query('SELECT * FROM racks WHERE id = ?', [result.insertId]);
    logActivity(req.projectId, req.user.id, 'rack.created', rows[0].name);
    res.status(201).json(omitLegacyLocation(rows[0]));
  } catch (err) {
    next(err);
  }
});

// PUT /api/racks/:id - update rack
router.put('/:id', async (req, res, next) => {
  try {
    const { name, u_height, rack_type, notes, show_rear, rack_width, annotation_field, show_annotations, location_id, room_id } = req.body;

    const validationError = validateRackFields(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const resolvedHeight = u_height || 42;

    const [[currentRack]] = await pool.query(
      'SELECT u_height FROM racks WHERE id = ? AND project_id = ?',
      [req.params.id, req.projectId]
    );
    if (!currentRack) return res.status(404).json({ error: 'Rack not found' });
    const shift = currentRack.u_height - resolvedHeight;

    // Shrinking the rack only fails if the devices genuinely don't fit —
    // i.e. the total number of distinct U rows they occupy exceeds the new
    // height. Vertical PDUs are 0U floating elements, not real U-grid
    // occupants, so they're excluded from both the fit check and the
    // reflow — their u_size is kept in sync with the rack height below
    // instead.
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

    // Shrinking shifts every device down by the same amount (old height -
    // new height) so each one keeps its distance from the TOP of the rack
    // — a device at the old top stays at the new top — rather than
    // collapsing everything down to the floor. Growing (shift <= 0) never
    // needs to move anything.
    if (shift > 0) {
      const updates = [];
      const occupiedAfterShift = new Set();
      const overflowGroups = new Map(); // old u_position -> slots sharing that row

      for (const s of slots) {
        const newPosition = s.u_position - shift;
        if (newPosition >= 1) {
          updates.push({ id: s.id, newPosition });
          const top = newPosition + s.u_size - 1;
          for (let u = newPosition; u <= top; u++) occupiedAfterShift.add(u);
        } else {
          if (!overflowGroups.has(s.u_position)) overflowGroups.set(s.u_position, []);
          overflowGroups.get(s.u_position).push(s);
        }
      }

      // A device shifted below U1 only happens if it was near the bottom
      // of the old rack and the shrink is large. As a last resort, stack
      // these from the bottom (U1) upward into whatever room is left,
      // lowest old position first — grouped by old position so co-located
      // slots (e.g. half-width pairs sharing a row) land on the same row
      // together, same as they were before.
      const sortedOldPositions = Array.from(overflowGroups.keys()).sort((a, b) => a - b);
      for (const oldPosition of sortedOldPositions) {
        const group = overflowGroups.get(oldPosition);
        const span = Math.max(...group.map((s) => s.u_size));
        let pos = 1;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          let free = true;
          for (let u = pos; u < pos + span; u++) {
            if (occupiedAfterShift.has(u)) { free = false; break; }
          }
          if (free) break;
          pos++;
        }
        for (let u = pos; u < pos + span; u++) occupiedAfterShift.add(u);
        for (const s of group) updates.push({ id: s.id, newPosition: pos });
      }

      for (const u of updates) {
        await pool.query('UPDATE rack_slots SET u_position = ? WHERE id = ?', [u.newPosition, u.id]);
      }
    }

    const [result] = await pool.query(
      'UPDATE racks SET name = ?, u_height = ?, rack_type = ?, notes = ?, show_rear = ?, rack_width = ?, annotation_field = ?, show_annotations = ?, location_id = ?, room_id = ? WHERE id = ? AND project_id = ?',
      [name, resolvedHeight, rack_type || '4-post', notes || null, show_rear !== undefined ? show_rear : 1, rack_width || '19"', annotation_field || null, show_annotations ? 1 : 0, location_id || null, room_id || null, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack not found' });

    // Keep floating vertical PDUs spanning the full (new) rack height.
    await pool.query(
      `UPDATE rack_slots SET u_size = ? WHERE rack_id = ? AND project_id = ? AND item_type = 'vertical-pdu'`,
      [resolvedHeight, req.params.id, req.projectId]
    );

    const [rows] = await pool.query('SELECT * FROM racks WHERE id = ?', [req.params.id]);
    res.json(omitLegacyLocation(rows[0]));
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
