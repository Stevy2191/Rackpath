const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pool = require('../db/pool');

const router = express.Router();

const NODE_FIELDS = `d.id, d.hostname, d.ip, d.mac, d.type, d.snmp_community, d.notes,
              d.icon_color, d.text_color,
              d.updated_at, tl.x, tl.y, tl.width, tl.height`;

// Returns true if the error is MariaDB/MySQL's "table doesn't exist" error.
// Lets older deployments (whose DB volume predates these tables) fall back
// to empty results instead of a 500 while migrate() catches up.
function isTableMissing(err) {
  return err && err.code === 'ER_NO_SUCH_TABLE';
}

const ICON_UPLOAD_DIR = path.join('/uploads', 'topology-icons');
fs.mkdirSync(ICON_UPLOAD_DIR, { recursive: true });

const iconStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ICON_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const iconUpload = multer({
  storage: iconStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/svg+xml') {
      cb(null, true);
    } else {
      cb(new Error('Only PNG and SVG files are allowed'));
    }
  },
});

// GET /api/topology - devices that have been placed on the canvas, with position
router.get('/', async (req, res, next) => {
  try {
    const [nodes] = await pool.query(
      `SELECT ${NODE_FIELDS}
       FROM devices d
       INNER JOIN topology_layout tl ON tl.device_id = d.id
       WHERE tl.project_id = ?`,
      [req.projectId]
    );

    res.json({ nodes });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/all - clear the canvas (all placed nodes, edges, zones, and labels)
router.delete('/all', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM topology_edges WHERE project_id = ?', [req.projectId]);
    await pool.query('DELETE FROM topology_zones WHERE project_id = ?', [req.projectId]);
    await pool.query('DELETE FROM topology_labels WHERE project_id = ?', [req.projectId]);
    await pool.query('DELETE FROM topology_layout WHERE project_id = ?', [req.projectId]);
    res.status(204).send();
  } catch (err) {
    if (isTableMissing(err)) return res.status(204).send();
    next(err);
  }
});

// PATCH /api/topology/layout - bulk upsert canvas positions
router.patch('/layout', async (req, res, next) => {
  try {
    const { positions } = req.body;
    if (!Array.isArray(positions)) {
      return res.status(400).json({ error: 'positions must be an array' });
    }

    for (const pos of positions) {
      const { device_id, x, y, width, height } = pos || {};
      if (device_id === undefined || x === undefined || y === undefined) continue;

      if (width !== undefined && height !== undefined) {
        await pool.query(
          `INSERT INTO topology_layout (project_id, device_id, x, y, width, height)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE x = VALUES(x), y = VALUES(y), width = VALUES(width), height = VALUES(height)`,
          [req.projectId, device_id, x, y, width, height]
        );
      } else {
        await pool.query(
          `INSERT INTO topology_layout (project_id, device_id, x, y)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE x = VALUES(x), y = VALUES(y)`,
          [req.projectId, device_id, x, y]
        );
      }
    }

    res.json({ updated: positions.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/topology/nodes - create a new device and place it on the canvas
router.post('/nodes', async (req, res, next) => {
  try {
    const { hostname, ip, type, x, y, icon_color, text_color } = req.body;

    const [result] = await pool.query(
      `INSERT INTO devices (project_id, hostname, ip, type, icon_color, text_color) VALUES (?, ?, ?, ?, ?, ?)`,
      [req.projectId, hostname || null, ip || null, type || null, icon_color || null, text_color || null]
    );
    const deviceId = result.insertId;

    await pool.query(
      `INSERT INTO topology_layout (project_id, device_id, x, y) VALUES (?, ?, ?, ?)`,
      [req.projectId, deviceId, x || 0, y || 0]
    );

    const [rows] = await pool.query(
      `SELECT ${NODE_FIELDS}
       FROM devices d
       INNER JOIN topology_layout tl ON tl.device_id = d.id
       WHERE d.id = ?`,
      [deviceId]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/nodes/:id - remove a device from the canvas
router.delete('/nodes/:id', async (req, res, next) => {
  try {
    const deviceId = req.params.id;

    await pool.query(
      'DELETE FROM topology_edges WHERE (source_device_id = ? OR target_device_id = ?) AND project_id = ?',
      [deviceId, deviceId, req.projectId]
    );

    await pool.query('DELETE FROM topology_layout WHERE device_id = ? AND project_id = ?', [
      deviceId,
      req.projectId,
    ]);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/topology/nodes/:id/interfaces - list interfaces for a device
router.get('/nodes/:id/interfaces', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM topology_node_interfaces WHERE device_id = ? AND project_id = ? ORDER BY id',
      [req.params.id, req.projectId]
    );
    res.json(rows);
  } catch (err) {
    if (isTableMissing(err)) return res.json([]);
    next(err);
  }
});

// POST /api/topology/nodes/:id/interfaces - add an interface to a device
router.post('/nodes/:id/interfaces', async (req, res, next) => {
  try {
    const { name, description, parent_id, vlan_id } = req.body;

    const [result] = await pool.query(
      `INSERT INTO topology_node_interfaces (project_id, device_id, parent_id, name, vlan_id, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.projectId,
        req.params.id,
        parent_id || null,
        (name || '').trim(),
        vlan_id === undefined || vlan_id === null || vlan_id === '' ? null : Number(vlan_id),
        description || null,
      ]
    );

    const [rows] = await pool.query('SELECT * FROM topology_node_interfaces WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topology/nodes/:id/interfaces/:interfaceId - update an interface's name/description
router.patch('/nodes/:id/interfaces/:interfaceId', async (req, res, next) => {
  try {
    const allowedFields = ['name', 'description', 'vlan_id', 'ip', 'speed', 'cable_type'];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        const raw = req.body[field];
        values.push(field === 'vlan_id' && (raw === null || raw === '') ? null : raw);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.interfaceId, req.params.id, req.projectId);
    const [result] = await pool.query(
      `UPDATE topology_node_interfaces SET ${updates.join(', ')} WHERE id = ? AND device_id = ? AND project_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Interface not found' });

    const [rows] = await pool.query('SELECT * FROM topology_node_interfaces WHERE id = ?', [req.params.interfaceId]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/nodes/:id/interfaces/:interfaceId
router.delete('/nodes/:id/interfaces/:interfaceId', async (req, res, next) => {
  try {
    // Remove any VLAN sub-interfaces of this interface first, so deleting a
    // parent cleans up its children even where the FK cascade isn't present.
    await pool.query(
      'DELETE FROM topology_node_interfaces WHERE parent_id = ? AND device_id = ? AND project_id = ?',
      [req.params.interfaceId, req.params.id, req.projectId]
    );

    const [result] = await pool.query(
      'DELETE FROM topology_node_interfaces WHERE id = ? AND device_id = ? AND project_id = ?',
      [req.params.interfaceId, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Interface not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/topology/connection-points - all named port anchors for the project,
// used to render every node's anchors when the canvas first loads.
router.get('/connection-points', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM topology_connection_points WHERE project_id = ? ORDER BY id',
      [req.projectId]
    );
    res.json(rows);
  } catch (err) {
    if (isTableMissing(err)) return res.json([]);
    next(err);
  }
});

// GET /api/topology/nodes/:id/connection-points - list a device's named port anchors
router.get('/nodes/:id/connection-points', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM topology_connection_points WHERE device_id = ? AND project_id = ? ORDER BY id',
      [req.params.id, req.projectId]
    );
    res.json(rows);
  } catch (err) {
    if (isTableMissing(err)) return res.json([]);
    next(err);
  }
});

// POST /api/topology/nodes/:id/connection-points - add a named port anchor
router.post('/nodes/:id/connection-points', async (req, res, next) => {
  try {
    const { name, position } = req.body;
    const pos = ['top', 'bottom', 'left', 'right'].includes(position) ? position : 'top';

    const [result] = await pool.query(
      'INSERT INTO topology_connection_points (project_id, device_id, name, `position`) VALUES (?, ?, ?, ?)',
      [req.projectId, req.params.id, (name || '').trim(), pos]
    );

    const [rows] = await pool.query('SELECT * FROM topology_connection_points WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topology/nodes/:id/connection-points/:pointId - rename or move an anchor
router.patch('/nodes/:id/connection-points/:pointId', async (req, res, next) => {
  try {
    const updates = [];
    const values = [];

    if (req.body.name !== undefined) {
      updates.push('name = ?');
      values.push((req.body.name || '').trim());
    }
    if (req.body.position !== undefined && ['top', 'bottom', 'left', 'right'].includes(req.body.position)) {
      updates.push('`position` = ?');
      values.push(req.body.position);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.pointId, req.params.id, req.projectId);
    const [result] = await pool.query(
      `UPDATE topology_connection_points SET ${updates.join(', ')} WHERE id = ? AND device_id = ? AND project_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Connection point not found' });

    const [rows] = await pool.query('SELECT * FROM topology_connection_points WHERE id = ?', [req.params.pointId]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/nodes/:id/connection-points/:pointId
router.delete('/nodes/:id/connection-points/:pointId', async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM topology_connection_points WHERE id = ? AND device_id = ? AND project_id = ?',
      [req.params.pointId, req.params.id, req.projectId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Connection point not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/topology/edges
router.get('/edges', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM topology_edges WHERE project_id = ?', [req.projectId]);
    res.json(rows);
  } catch (err) {
    if (isTableMissing(err)) return res.json([]);
    next(err);
  }
});

// POST /api/topology/edges
router.post('/edges', async (req, res, next) => {
  try {
    const {
      source_device_id,
      target_device_id,
      source_handle,
      target_handle,
      source_interface,
      target_interface,
      label,
      speed,
      cable_type,
      vlan,
    } = req.body;
    if (!source_device_id || !target_device_id) {
      return res.status(400).json({ error: 'source_device_id and target_device_id are required' });
    }

    const [result] = await pool.query(
      `INSERT INTO topology_edges (project_id, source_device_id, target_device_id, source_handle, target_handle, source_interface, target_interface, label, speed, cable_type, vlan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.projectId,
        source_device_id,
        target_device_id,
        source_handle || null,
        target_handle || null,
        source_interface || null,
        target_interface || null,
        label || null,
        speed || null,
        cable_type || null,
        vlan || null,
      ]
    );

    const [rows] = await pool.query('SELECT * FROM topology_edges WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topology/edges/:id - update connection metadata or reconnect endpoints
router.patch('/edges/:id', async (req, res, next) => {
  try {
    const allowedFields = [
      'source_device_id',
      'target_device_id',
      'source_handle',
      'target_handle',
      'waypoint_x',
      'waypoint_y',
      'source_interface',
      'target_interface',
      'label',
      'speed',
      'cable_type',
      'vlan',
    ];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id, req.projectId);
    const [result] = await pool.query(
      `UPDATE topology_edges SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Edge not found' });

    const [rows] = await pool.query('SELECT * FROM topology_edges WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/edges/:id
router.delete('/edges/:id', async (req, res, next) => {
  try {
    // Idempotent: an edge may already have been removed by a cascading
    // node deletion, in which case this is a no-op rather than an error.
    await pool.query('DELETE FROM topology_edges WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/topology/zones
router.get('/zones', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM topology_zones WHERE project_id = ?', [req.projectId]);
    res.json(rows);
  } catch (err) {
    if (isTableMissing(err)) return res.json([]);
    next(err);
  }
});

// POST /api/topology/zones
router.post('/zones', async (req, res, next) => {
  try {
    const { name, border_style, color, x, y, width, height } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const [result] = await pool.query(
      `INSERT INTO topology_zones (project_id, name, border_style, color, x, y, width, height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.projectId,
        name,
        border_style === 'dotted' ? 'dotted' : 'solid',
        color || 'blue',
        x ?? 0,
        y ?? 0,
        width ?? 300,
        height ?? 200,
      ]
    );

    const [rows] = await pool.query('SELECT * FROM topology_zones WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topology/zones/:id - update position, size, name, or style
router.patch('/zones/:id', async (req, res, next) => {
  try {
    const allowedFields = ['name', 'border_style', 'color', 'x', 'y', 'width', 'height'];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id, req.projectId);
    const [result] = await pool.query(
      `UPDATE topology_zones SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Zone not found' });

    const [rows] = await pool.query('SELECT * FROM topology_zones WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/zones/:id
router.delete('/zones/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM topology_zones WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Zone not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/topology/labels - floating text labels on the canvas
router.get('/labels', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM topology_labels WHERE project_id = ?', [req.projectId]);
    res.json(rows);
  } catch (err) {
    if (isTableMissing(err)) return res.json([]);
    next(err);
  }
});

// POST /api/topology/labels
router.post('/labels', async (req, res, next) => {
  try {
    const { text, x, y, font_size, color } = req.body;

    const [result] = await pool.query(
      'INSERT INTO topology_labels (project_id, `text`, x, y, font_size, color) VALUES (?, ?, ?, ?, ?, ?)',
      [req.projectId, text || '', x ?? 0, y ?? 0, font_size || 14, color || null]
    );

    const [rows] = await pool.query('SELECT * FROM topology_labels WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topology/labels/:id - update text, position, or styling
router.patch('/labels/:id', async (req, res, next) => {
  try {
    const allowedFields = ['text', 'x', 'y', 'font_size', 'color'];
    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        // Backtick-quote columns: `text` is a reserved word in MariaDB.
        updates.push(`\`${field}\` = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id, req.projectId);
    const [result] = await pool.query(
      `UPDATE topology_labels SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Label not found' });

    const [rows] = await pool.query('SELECT * FROM topology_labels WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/labels/:id
router.delete('/labels/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM topology_labels WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Label not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/topology/icons - list custom icons
router.get('/icons', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM topology_icons ORDER BY name');
    res.json(rows);
  } catch (err) {
    if (isTableMissing(err)) return res.json([]);
    next(err);
  }
});

// POST /api/topology/icons - upload a custom icon (multipart/form-data, field "icon")
router.post('/icons', (req, res, next) => {
  iconUpload.single('icon')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'icon file is required' });

    const name = (req.body.name || req.file.originalname || 'Custom Icon').trim();

    const [result] = await pool.query(
      'INSERT INTO topology_icons (name, filename) VALUES (?, ?)',
      [name, req.file.filename]
    );

    const [rows] = await pool.query('SELECT * FROM topology_icons WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/topology/icons/file/:filename - serve a custom icon's image data.
// Left unauthenticated (see auth middleware) since <img> tags can't send a
// Bearer token.
router.get('/icons/file/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  res.sendFile(path.join(ICON_UPLOAD_DIR, filename), (err) => {
    if (err) res.status(404).end();
  });
});

// DELETE /api/topology/icons/:id
router.delete('/icons/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM topology_icons WHERE id = ?', [req.params.id]);
    if (rows[0]) {
      fs.unlink(path.join(ICON_UPLOAD_DIR, rows[0].filename), () => {});
    }

    await pool.query('DELETE FROM topology_icons WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
