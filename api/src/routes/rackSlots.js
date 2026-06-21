const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pool = require('../db/pool');
const { logActivity } = require('../services/activityLog');
const { parseRowOutletGroups, parseRowsOutletGroups, sumOutletGroups } = require('../utils/outletGroups');

const router = express.Router();

const ITEM_TYPES = ['device', 'patch-panel', 'blank', 'cable-manager', 'custom-device', 'vertical-pdu'];
const SIDES = ['front', 'back', 'both'];
const FRONT_BACK = ['front', 'back'];
const MOUNTED_FACES = ['front', 'rear', 'both'];
const MOUNT_SIDES = ['left', 'right'];

// Image upload for slot front/rear faceplate images
const SLOT_IMAGE_DIR = path.join('/uploads', 'rack-slots');
fs.mkdirSync(SLOT_IMAGE_DIR, { recursive: true });

const slotImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SLOT_IMAGE_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const slotImageUpload = multer({
  storage: slotImageStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPEG, WEBP, and SVG files are allowed'));
    }
  },
});

// Map mounted_face to the legacy side/front_back values for collision compat.
function mountedFaceToLegacy(mounted_face) {
  if (mounted_face === 'rear') return { side: 'back', front_back: 'back' };
  if (mounted_face === 'both') return { side: 'both', front_back: 'front' };
  return { side: 'front', front_back: 'front' };
}

async function findCollision(rackId, projectId, uPosition, uSize, side, excludeId, halfWidth, halfPosition) {
  let query = 'SELECT id, u_position, u_size, side, half_width, half_position FROM rack_slots WHERE rack_id = ? AND project_id = ?';
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
    if (!sidesCollide) continue;
    // Two half-width devices can share the same U rows when on opposite halves.
    if (halfWidth && row.half_width) {
      const rowHalf = row.half_position || 'left';
      if (rowHalf !== (halfPosition || 'left')) continue;
    }
    return row;
  }
  return null;
}

// Finds a different device-PSU slot already plugged into the same source
// outlet, if any. Project-wide, not rack-scoped — a PDU/UPS's outlets are
// occupied by whichever device claims them, regardless of which rack that
// consuming device physically sits in, and checks *both* PSU1 and PSU2
// columns since either of a device's two independent power cords could be
// the one claiming this outlet. `excludeSlotId`/`excludeField` (PSU1' or
// 'psu2') skip the one column being actively edited on the slot itself, so
// re-saving its own existing value isn't flagged as a conflict with itself.
async function findOutletConflict(projectId, sourceSlotId, outlet, excludeSlotId, excludeField) {
  if (!sourceSlotId || outlet == null) return null;

  let q1 = `SELECT id, item_label FROM rack_slots
            WHERE project_id = ? AND power_source_slot_id = ? AND power_source_outlet = ?`;
  const p1 = [projectId, sourceSlotId, outlet];
  if (excludeSlotId && excludeField === 'psu1') { q1 += ' AND id != ?'; p1.push(excludeSlotId); }
  const [rows1] = await pool.query(q1, p1);
  if (rows1[0]) return rows1[0];

  let q2 = `SELECT id, item_label FROM rack_slots
            WHERE project_id = ? AND psu2_source_slot_id = ? AND psu2_source_outlet = ?`;
  const p2 = [projectId, sourceSlotId, outlet];
  if (excludeSlotId && excludeField === 'psu2') { q2 += ' AND id != ?'; p2.push(excludeSlotId); }
  const [rows2] = await pool.query(q2, p2);
  if (rows2[0]) return rows2[0];

  return null;
}

// Validates a power source slot/outlet pair for either PSU: the source
// must exist somewhere in the same *project* (any rack — devices can now
// plug into a PDU/UPS in a different rack than their own), the outlet
// must be within the total count of its outlet groups, and a slot can't
// be wired to itself. Returns an error string, or null if valid (including
// the "no source set" / Wall-Direct case).
async function validatePowerSource(projectId, slotId, sourceSlotId, outlet) {
  if (!sourceSlotId) return null;
  if (outlet === undefined || outlet === null) {
    return 'An outlet is required when a power source is set';
  }
  if (slotId && String(sourceSlotId) === String(slotId)) {
    return 'A device cannot be its own power source';
  }
  const [[source]] = await pool.query(
    'SELECT id, outlet_groups FROM rack_slots WHERE id = ? AND project_id = ?',
    [sourceSlotId, projectId]
  );
  if (!source) return 'Power source not found in this project';
  const outletCount = sumOutletGroups(source.outlet_groups);
  if (!outletCount || outlet < 1 || outlet > outletCount) {
    return `Outlet must be between 1 and ${outletCount || 0}`;
  }
  return null;
}

// GET /api/rack-slots
router.get('/', async (req, res, next) => {
  try {
    const { rack_id } = req.query;
    let query = `
      SELECT rs.*, d.hostname, d.ip, d.type AS device_type, d.status AS device_status
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
    res.json(parseRowsOutletGroups(rows));
  } catch (err) {
    next(err);
  }
});

// GET /api/rack-slots/images/file/:filename - unauthenticated (see auth middleware)
router.get('/images/file/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  res.sendFile(path.join(SLOT_IMAGE_DIR, filename), (err) => {
    if (err) res.status(404).end();
  });
});

// POST /api/rack-slots
router.post('/', async (req, res, next) => {
  try {
    const {
      rack_id, device_id, u_position, item_type, item_label, side,
      custom_type, color, front_back, mounted_face, half_depth, half_width, half_position,
      catalog_id, custom_image_url, vendor, ip_address, slot_notes, position_offset,
      outlet_groups, input_voltage, input_plug_type, capacity_value, capacity_unit,
      port_count, bay_count, capacity_va,
      power_source_slot_id, power_source_outlet, mount_side,
      psu2_source_slot_id, psu2_source_outlet,
    } = req.body;
    const u_size = req.body.u_size || 1;

    if (!rack_id || u_position === undefined) {
      return res.status(400).json({ error: 'rack_id and u_position are required' });
    }
    if (item_type !== undefined && item_type !== null && !ITEM_TYPES.includes(item_type)) {
      return res.status(400).json({ error: 'Invalid item_type' });
    }
    if (mounted_face !== undefined && mounted_face !== null && !MOUNTED_FACES.includes(mounted_face)) {
      return res.status(400).json({ error: 'Invalid mounted_face' });
    }
    if (mount_side !== undefined && mount_side !== null && !MOUNT_SIDES.includes(mount_side)) {
      return res.status(400).json({ error: 'Invalid mount_side' });
    }
    if (u_size < 1) return res.status(400).json({ error: 'u_size must be at least 1' });

    const [racks] = await pool.query('SELECT u_height FROM racks WHERE id = ? AND project_id = ?', [rack_id, req.projectId]);
    if (racks.length === 0) return res.status(404).json({ error: 'Rack not found' });
    if (u_position + u_size - 1 > racks[0].u_height) {
      return res.status(400).json({ error: 'Slot extends beyond rack height' });
    }

    const resolvedFace = mounted_face || 'front';
    const legacy = mountedFaceToLegacy(resolvedFace);
    const resolvedSide = (side && SIDES.includes(side)) ? side : legacy.side;
    const resolvedFrontBack = (front_back && FRONT_BACK.includes(front_back)) ? front_back : legacy.front_back;
    const resolvedHalfPos = (half_position === 'right') ? 'right' : 'left';

    // Vertical PDUs are floating elements alongside the rack frame, not
    // occupying U columns — they never collide with U-slot devices. A real
    // rack only has physical room for one PDU per side, so a 3rd is
    // rejected outright rather than being given some less-meaningful
    // stacked position.
    if (item_type === 'vertical-pdu') {
      const [[{ pduCount }]] = await pool.query(
        `SELECT COUNT(*) AS pduCount FROM rack_slots WHERE rack_id = ? AND project_id = ? AND item_type = 'vertical-pdu'`,
        [rack_id, req.projectId]
      );
      if (pduCount >= 2) {
        return res.status(409).json({ error: 'Both Left and Right vertical PDU positions are already in use on this rack' });
      }
    } else {
      const collision = await findCollision(rack_id, req.projectId, u_position, u_size, resolvedSide, null, half_width, resolvedHalfPos);
      if (collision) {
        return res.status(409).json({ error: `U${collision.u_position} is already occupied` });
      }
    }

    const psu1Error = await validatePowerSource(req.projectId, null, power_source_slot_id, power_source_outlet);
    if (psu1Error) return res.status(400).json({ error: psu1Error });
    if (power_source_slot_id) {
      const conflict = await findOutletConflict(req.projectId, power_source_slot_id, power_source_outlet, null, 'psu1');
      if (conflict) {
        return res.status(409).json({ error: `Outlet ${power_source_outlet} is already in use by ${conflict.item_label || 'another device'}` });
      }
    }

    const psu2Error = await validatePowerSource(req.projectId, null, psu2_source_slot_id, psu2_source_outlet);
    if (psu2Error) return res.status(400).json({ error: `PSU 2: ${psu2Error}` });
    if (psu2_source_slot_id) {
      const conflict = await findOutletConflict(req.projectId, psu2_source_slot_id, psu2_source_outlet, null, 'psu2');
      if (conflict) {
        return res.status(409).json({ error: `Outlet ${psu2_source_outlet} is already in use by ${conflict.item_label || 'another device'}` });
      }
    }

    const [result] = await pool.query(
      `INSERT INTO rack_slots
         (project_id, rack_id, device_id, item_type, item_label, custom_type, color,
          u_position, position_offset, u_size, side, front_back, mounted_face,
          half_depth, half_width, half_position, catalog_id, custom_image_url, vendor, ip_address, slot_notes,
          outlet_groups, input_voltage, input_plug_type, capacity_value, capacity_unit,
          port_count, bay_count, capacity_va,
          power_source_slot_id, power_source_outlet, mount_side,
          psu2_source_slot_id, psu2_source_outlet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.projectId, rack_id, device_id || null,
        item_type || 'device', item_label || null, custom_type || null, color || null,
        u_position, position_offset || 0, u_size,
        resolvedSide, resolvedFrontBack, resolvedFace,
        half_depth ? 1 : 0, half_width ? 1 : 0, resolvedHalfPos,
        catalog_id || null, custom_image_url || null, vendor || null,
        ip_address || null, slot_notes || null,
        outlet_groups ? JSON.stringify(outlet_groups) : null, input_voltage || null,
        input_plug_type || null, capacity_value || null, capacity_unit || null,
        port_count || null, bay_count || null, capacity_va || null,
        power_source_slot_id || null, power_source_outlet || null, mount_side || null,
        psu2_source_slot_id || null, psu2_source_outlet || null,
      ]
    );

    const [rows] = await pool.query(
      `SELECT rs.*, d.hostname, d.ip, d.type AS device_type, d.status AS device_status
       FROM rack_slots rs LEFT JOIN devices d ON d.id = rs.device_id WHERE rs.id = ?`,
      [result.insertId]
    );

    let itemName = item_label || `${item_type || 'device'}`;
    if (device_id) {
      const [deviceRows] = await pool.query('SELECT hostname FROM devices WHERE id = ?', [device_id]);
      itemName = deviceRows[0]?.hostname || itemName;
    }
    logActivity(req.projectId, req.user.id, 'rack_slot.assigned', `${itemName} → U${u_position}`);
    res.status(201).json(parseRowOutletGroups(rows[0]));
  } catch (err) {
    next(err);
  }
});

// PUT /api/rack-slots/:id - full update
router.put('/:id', async (req, res, next) => {
  try {
    const {
      rack_id, device_id, item_type, item_label, side,
      custom_type, color, front_back, mounted_face, half_depth, half_width, half_position,
      catalog_id, custom_image_url, vendor, ip_address, slot_notes, position_offset,
      outlet_groups, input_voltage, input_plug_type, capacity_value, capacity_unit,
      port_count, bay_count, capacity_va,
      power_source_slot_id, power_source_outlet, mount_side,
      psu2_source_slot_id, psu2_source_outlet,
    } = req.body;
    let u_position = req.body.u_position;
    const u_size = req.body.u_size || 1;

    if (item_type !== undefined && item_type !== null && !ITEM_TYPES.includes(item_type)) {
      return res.status(400).json({ error: 'Invalid item_type' });
    }
    if (mounted_face !== undefined && mounted_face !== null && !MOUNTED_FACES.includes(mounted_face)) {
      return res.status(400).json({ error: 'Invalid mounted_face' });
    }
    if (mount_side !== undefined && mount_side !== null && !MOUNT_SIDES.includes(mount_side)) {
      return res.status(400).json({ error: 'Invalid mount_side' });
    }
    if (u_size < 1) return res.status(400).json({ error: 'u_size must be at least 1' });

    const [racks] = await pool.query('SELECT u_height FROM racks WHERE id = ? AND project_id = ?', [rack_id, req.projectId]);
    if (racks.length === 0) return res.status(404).json({ error: 'Rack not found' });
    const uHeight = racks[0].u_height;
    if (u_position + u_size - 1 > uHeight) {
      if (u_size > uHeight) return res.status(400).json({ error: 'Not enough space to resize' });
      u_position = uHeight - u_size + 1;
    }
    if (u_position < 1) return res.status(400).json({ error: 'Not enough space to resize' });

    const resolvedFace = mounted_face || 'front';
    const legacy = mountedFaceToLegacy(resolvedFace);
    const resolvedSide = (side && SIDES.includes(side)) ? side : legacy.side;
    const resolvedFrontBack = (front_back && FRONT_BACK.includes(front_back)) ? front_back : legacy.front_back;
    const resolvedHalfPos = (half_position === 'right') ? 'right' : 'left';

    if (item_type !== 'vertical-pdu') {
      const collision = await findCollision(rack_id, req.projectId, u_position, u_size, resolvedSide, req.params.id, half_width, resolvedHalfPos);
      if (collision) {
        return res.status(409).json({ error: `U${collision.u_position} is already occupied` });
      }
    }

    const psu1Error = await validatePowerSource(req.projectId, req.params.id, power_source_slot_id, power_source_outlet);
    if (psu1Error) return res.status(400).json({ error: psu1Error });
    if (power_source_slot_id) {
      const conflict = await findOutletConflict(req.projectId, power_source_slot_id, power_source_outlet, req.params.id, 'psu1');
      if (conflict) {
        return res.status(409).json({ error: `Outlet ${power_source_outlet} is already in use by ${conflict.item_label || 'another device'}` });
      }
    }

    const psu2Error = await validatePowerSource(req.projectId, req.params.id, psu2_source_slot_id, psu2_source_outlet);
    if (psu2Error) return res.status(400).json({ error: `PSU 2: ${psu2Error}` });
    if (psu2_source_slot_id) {
      const conflict = await findOutletConflict(req.projectId, psu2_source_slot_id, psu2_source_outlet, req.params.id, 'psu2');
      if (conflict) {
        return res.status(409).json({ error: `Outlet ${psu2_source_outlet} is already in use by ${conflict.item_label || 'another device'}` });
      }
    }

    const [result] = await pool.query(
      `UPDATE rack_slots
       SET rack_id=?, device_id=?, item_type=?, item_label=?, custom_type=?, color=?,
           u_position=?, position_offset=?, u_size=?, side=?, front_back=?, mounted_face=?,
           half_depth=?, half_width=?, half_position=?, catalog_id=?, custom_image_url=?, vendor=?,
           ip_address=?, slot_notes=?,
           outlet_groups=?, input_voltage=?, input_plug_type=?, capacity_value=?, capacity_unit=?,
           port_count=?, bay_count=?, capacity_va=?,
           power_source_slot_id=?, power_source_outlet=?, mount_side=?,
           psu2_source_slot_id=?, psu2_source_outlet=?
       WHERE id=? AND project_id=?`,
      [
        rack_id, device_id || null,
        item_type || 'device', item_label || null, custom_type || null, color || null,
        u_position, position_offset || 0, u_size,
        resolvedSide, resolvedFrontBack, resolvedFace,
        half_depth ? 1 : 0, half_width ? 1 : 0, resolvedHalfPos,
        catalog_id || null, custom_image_url || null, vendor || null,
        ip_address || null, slot_notes || null,
        outlet_groups ? JSON.stringify(outlet_groups) : null, input_voltage || null,
        input_plug_type || null, capacity_value || null, capacity_unit || null,
        port_count || null, bay_count || null, capacity_va || null,
        power_source_slot_id || null, power_source_outlet || null, mount_side || null,
        psu2_source_slot_id || null, psu2_source_outlet || null,
        req.params.id, req.projectId,
      ]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack slot not found' });

    const [rows] = await pool.query(
      `SELECT rs.*, d.hostname, d.ip, d.type AS device_type, d.status AS device_status
       FROM rack_slots rs LEFT JOIN devices d ON d.id = rs.device_id WHERE rs.id = ?`,
      [req.params.id]
    );
    res.json(parseRowOutletGroups(rows[0]));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/rack-slots/:id - partial update (used by properties panel)
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = [
      'item_label', 'color', 'mounted_face', 'half_depth', 'half_width', 'half_position',
      'u_size', 'u_position', 'position_offset', 'ip_address', 'slot_notes',
      'asset_tag', 'serial_number',
      'front_image_url', 'rear_image_url',
      'outlet_groups', 'input_voltage', 'input_plug_type', 'capacity_value', 'capacity_unit',
      'port_count', 'bay_count', 'capacity_va',
      'power_source_slot_id', 'power_source_outlet', 'mount_side',
      'psu2_source_slot_id', 'psu2_source_outlet',
    ];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    if ('outlet_groups' in updates) {
      updates.outlet_groups = updates.outlet_groups ? JSON.stringify(updates.outlet_groups) : null;
    }

    if ('mount_side' in updates && updates.mount_side !== null && !MOUNT_SIDES.includes(updates.mount_side)) {
      return res.status(400).json({ error: 'Invalid mount_side' });
    }

    // Sync legacy columns when mounted_face changes
    if (updates.mounted_face) {
      const legacy = mountedFaceToLegacy(updates.mounted_face);
      updates.side = legacy.side;
      updates.front_back = legacy.front_back;
    }

    // Collision check when position or size changes
    if ('u_position' in updates || 'u_size' in updates) {
      const [[cur]] = await pool.query(
        'SELECT rack_id, item_type, u_position, u_size, side FROM rack_slots WHERE id = ? AND project_id = ?',
        [req.params.id, req.projectId]
      );
      if (!cur) return res.status(404).json({ error: 'Rack slot not found' });

      const newPos  = 'u_position' in updates ? Number(updates.u_position) : cur.u_position;
      const newSize = 'u_size'     in updates ? Number(updates.u_size)     : cur.u_size;
      const checkSide = updates.side || cur.side;

      if (newPos < 1 || newSize < 1) {
        return res.status(400).json({ error: 'Position and size must be at least 1' });
      }

      const [[rack]] = await pool.query(
        'SELECT u_height FROM racks WHERE id = ? AND project_id = ?',
        [cur.rack_id, req.projectId]
      );
      if (!rack) return res.status(404).json({ error: 'Rack not found' });
      if (newPos + newSize - 1 > rack.u_height) {
        return res.status(400).json({ error: 'Slot extends beyond rack height' });
      }

      if (cur.item_type !== 'vertical-pdu') {
        const collision = await findCollision(cur.rack_id, req.projectId, newPos, newSize, checkSide, req.params.id);
        if (collision) {
          return res.status(409).json({ error: `U${collision.u_position} is already occupied` });
        }
      }
    }

    // Outlet assignment check when either PSU's power source changes
    if ('power_source_slot_id' in updates || 'power_source_outlet' in updates
      || 'psu2_source_slot_id' in updates || 'psu2_source_outlet' in updates) {
      const [[cur]] = await pool.query(
        'SELECT power_source_slot_id, power_source_outlet, psu2_source_slot_id, psu2_source_outlet FROM rack_slots WHERE id = ? AND project_id = ?',
        [req.params.id, req.projectId]
      );
      if (!cur) return res.status(404).json({ error: 'Rack slot not found' });

      if ('power_source_slot_id' in updates || 'power_source_outlet' in updates) {
        const newSourceId = 'power_source_slot_id' in updates ? updates.power_source_slot_id : cur.power_source_slot_id;
        const newOutlet    = 'power_source_outlet'  in updates ? updates.power_source_outlet  : cur.power_source_outlet;

        const psu1Error = await validatePowerSource(req.projectId, req.params.id, newSourceId, newOutlet);
        if (psu1Error) return res.status(400).json({ error: psu1Error });
        if (newSourceId) {
          const conflict = await findOutletConflict(req.projectId, newSourceId, newOutlet, req.params.id, 'psu1');
          if (conflict) {
            return res.status(409).json({ error: `Outlet ${newOutlet} is already in use by ${conflict.item_label || 'another device'}` });
          }
        }
      }

      if ('psu2_source_slot_id' in updates || 'psu2_source_outlet' in updates) {
        const newSourceId = 'psu2_source_slot_id' in updates ? updates.psu2_source_slot_id : cur.psu2_source_slot_id;
        const newOutlet    = 'psu2_source_outlet'  in updates ? updates.psu2_source_outlet  : cur.psu2_source_outlet;

        const psu2Error = await validatePowerSource(req.projectId, req.params.id, newSourceId, newOutlet);
        if (psu2Error) return res.status(400).json({ error: `PSU 2: ${psu2Error}` });
        if (newSourceId) {
          const conflict = await findOutletConflict(req.projectId, newSourceId, newOutlet, req.params.id, 'psu2');
          if (conflict) {
            return res.status(409).json({ error: `Outlet ${newOutlet} is already in use by ${conflict.item_label || 'another device'}` });
          }
        }
      }
    }

    const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), req.params.id, req.projectId];
    const [result] = await pool.query(
      `UPDATE rack_slots SET ${setClauses} WHERE id = ? AND project_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack slot not found' });

    const [rows] = await pool.query(
      `SELECT rs.*, d.hostname, d.ip, d.type AS device_type, d.status AS device_status
       FROM rack_slots rs LEFT JOIN devices d ON d.id = rs.device_id WHERE rs.id = ?`,
      [req.params.id]
    );
    res.json(parseRowOutletGroups(rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /api/rack-slots/:id/images - upload front or rear faceplate image
router.post('/:id/images', (req, res, next) => {
  slotImageUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, async (req, res, next) => {
  try {
    const { face } = req.body; // 'front' or 'rear'
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    if (face !== 'front' && face !== 'rear') return res.status(400).json({ error: 'face must be front or rear' });

    const imageUrl = `/api/rack-slots/images/file/${req.file.filename}`;
    const column = face === 'front' ? 'front_image_url' : 'rear_image_url';

    // Delete old image if it exists
    const [existing] = await pool.query(
      `SELECT ${column} FROM rack_slots WHERE id = ? AND project_id = ?`,
      [req.params.id, req.projectId]
    );
    const oldUrl = existing[0]?.[column];
    if (oldUrl) {
      const oldFile = path.join(SLOT_IMAGE_DIR, path.basename(oldUrl));
      fs.unlink(oldFile, () => {});
    }

    const [result] = await pool.query(
      `UPDATE rack_slots SET ${column} = ? WHERE id = ? AND project_id = ?`,
      [imageUrl, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack slot not found' });

    res.json({ url: imageUrl });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/rack-slots/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const [existing] = await pool.query(
      `SELECT rs.item_label, rs.item_type, rs.u_position, rs.front_image_url, rs.rear_image_url, d.hostname
       FROM rack_slots rs LEFT JOIN devices d ON d.id = rs.device_id
       WHERE rs.id = ? AND rs.project_id = ?`,
      [req.params.id, req.projectId]
    );
    const [result] = await pool.query('DELETE FROM rack_slots WHERE id = ? AND project_id = ?', [req.params.id, req.projectId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Rack slot not found' });

    if (existing.length > 0) {
      const slot = existing[0];
      // Clean up uploaded images
      if (slot.front_image_url) fs.unlink(path.join(SLOT_IMAGE_DIR, path.basename(slot.front_image_url)), () => {});
      if (slot.rear_image_url) fs.unlink(path.join(SLOT_IMAGE_DIR, path.basename(slot.rear_image_url)), () => {});
      const itemName = slot.hostname || slot.item_label || slot.item_type || 'item';
      logActivity(req.projectId, req.user.id, 'rack_slot.removed', `${itemName} (was U${slot.u_position})`);
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
