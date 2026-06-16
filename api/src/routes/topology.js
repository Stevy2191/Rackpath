const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pool = require('../db/pool');
const { logActivity } = require('../services/activityLog');

const router = express.Router();

const NODE_FIELDS = `n.id, n.device_id, n.label, n.type AS node_type,
              n.icon_color AS node_icon_color, n.text_color AS node_text_color,
              n.x, n.y, n.width, n.height,
              d.hostname, d.ip, d.mac, d.type AS device_type, d.snmp_community, d.notes,
              d.icon_color AS device_icon_color, d.text_color AS device_text_color,
              d.updated_at`;

// Display name for a topology node used in activity-log entries: the linked
// device's hostname, or the standalone node's own label, falling back to its id.
async function nodeDisplayName(projectId, nodeId) {
  const [rows] = await pool.query(
    `SELECT COALESCE(d.hostname, n.label, CONCAT('Node ', n.id)) AS name
     FROM topology_nodes n
     LEFT JOIN devices d ON d.id = n.device_id
     WHERE n.id = ? AND n.project_id = ?`,
    [nodeId, projectId]
  );
  return rows[0]?.name || `Node ${nodeId}`;
}

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

// GET /api/topology - canvas nodes (device-linked or standalone), with position
router.get('/', async (req, res, next) => {
  try {
    const [nodes] = await pool.query(
      `SELECT ${NODE_FIELDS}
       FROM topology_nodes n
       LEFT JOIN devices d ON d.id = n.device_id
       WHERE n.project_id = ?`,
      [req.projectId]
    );

    res.json({ nodes });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/all - clear the canvas (all nodes, edges, zones, and labels)
router.delete('/all', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM topology_edges WHERE project_id = ?', [req.projectId]);
    await pool.query('DELETE FROM topology_zones WHERE project_id = ?', [req.projectId]);
    await pool.query('DELETE FROM topology_labels WHERE project_id = ?', [req.projectId]);
    await pool.query('DELETE FROM topology_shapes WHERE project_id = ?', [req.projectId]);
    await pool.query('DELETE FROM topology_nodes WHERE project_id = ?', [req.projectId]);
    res.status(204).send();
  } catch (err) {
    if (isTableMissing(err)) return res.status(204).send();
    next(err);
  }
});

// PATCH /api/topology/layout - bulk update canvas positions/sizes
router.patch('/layout', async (req, res, next) => {
  try {
    const { positions } = req.body;
    if (!Array.isArray(positions)) {
      return res.status(400).json({ error: 'positions must be an array' });
    }

    for (const pos of positions) {
      const { node_id, x, y, width, height } = pos || {};
      if (node_id === undefined || x === undefined || y === undefined) continue;

      if (width !== undefined && height !== undefined) {
        await pool.query(
          'UPDATE topology_nodes SET x = ?, y = ?, width = ?, height = ? WHERE id = ? AND project_id = ?',
          [x, y, width, height, node_id, req.projectId]
        );
      } else {
        await pool.query('UPDATE topology_nodes SET x = ?, y = ? WHERE id = ? AND project_id = ?', [
          x,
          y,
          node_id,
          req.projectId,
        ]);
      }
    }

    res.json({ updated: positions.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/topology/nodes - add a node to the canvas, either linked to an
// existing device or as a standalone documentation-only node.
router.post('/nodes', async (req, res, next) => {
  try {
    const { device_id, label, type, x, y, icon_color, text_color } = req.body;

    if (device_id) {
      const [devices] = await pool.query('SELECT id FROM devices WHERE id = ? AND project_id = ?', [
        device_id,
        req.projectId,
      ]);
      if (devices.length === 0) return res.status(404).json({ error: 'Device not found' });

      const [existing] = await pool.query(
        'SELECT id FROM topology_nodes WHERE device_id = ? AND project_id = ?',
        [device_id, req.projectId]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Device is already placed on the canvas' });
      }
    }

    const [result] = await pool.query(
      `INSERT INTO topology_nodes (project_id, device_id, label, type, icon_color, text_color, x, y)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.projectId,
        device_id || null,
        device_id ? null : label || null,
        device_id ? null : type || null,
        icon_color || null,
        text_color || null,
        x || 0,
        y || 0,
      ]
    );

    const [rows] = await pool.query(
      `SELECT ${NODE_FIELDS}
       FROM topology_nodes n
       LEFT JOIN devices d ON d.id = n.device_id
       WHERE n.id = ?`,
      [result.insertId]
    );

    logActivity(req.projectId, req.user.id, 'topology.node.created', rows[0].hostname || rows[0].label || `Node ${rows[0].id}`);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topology/nodes/:id - update a standalone node's own label/type/colors
router.patch('/nodes/:id', async (req, res, next) => {
  try {
    const allowedFields = ['label', 'type', 'icon_color', 'text_color'];
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
      `UPDATE topology_nodes SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Node not found' });

    const [rows] = await pool.query(
      `SELECT ${NODE_FIELDS}
       FROM topology_nodes n
       LEFT JOIN devices d ON d.id = n.device_id
       WHERE n.id = ?`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/nodes/:id - remove a node from the canvas. Does not
// delete the linked device (if any) from the Device Inventory.
router.delete('/nodes/:id', async (req, res, next) => {
  try {
    const nodeId = req.params.id;
    const nodeName = await nodeDisplayName(req.projectId, nodeId);

    await pool.query(
      'DELETE FROM topology_edges WHERE (source_node_id = ? OR target_node_id = ?) AND project_id = ?',
      [nodeId, nodeId, req.projectId]
    );

    await pool.query('DELETE FROM topology_nodes WHERE id = ? AND project_id = ?', [nodeId, req.projectId]);

    logActivity(req.projectId, req.user.id, 'topology.node.deleted', nodeName);
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
    const allowedFields = ['name', 'description', 'vlan_id', 'ip', 'speed', 'cable_type', 'status'];
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
      source_node_id,
      target_node_id,
      source_handle,
      target_handle,
      source_interface,
      target_interface,
      label,
      speed,
      cable_type,
      vlan,
    } = req.body;
    if (!source_node_id || !target_node_id) {
      return res.status(400).json({ error: 'source_node_id and target_node_id are required' });
    }

    const [result] = await pool.query(
      `INSERT INTO topology_edges (project_id, source_node_id, target_node_id, source_handle, target_handle, source_interface, target_interface, label, speed, cable_type, vlan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.projectId,
        source_node_id,
        target_node_id,
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

    const [sourceName, targetName] = await Promise.all([
      nodeDisplayName(req.projectId, source_node_id),
      nodeDisplayName(req.projectId, target_node_id),
    ]);
    logActivity(req.projectId, req.user.id, 'topology.edge.created', `${sourceName} ↔ ${targetName}`);

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topology/edges/:id - update connection metadata or reconnect endpoints
router.patch('/edges/:id', async (req, res, next) => {
  try {
    const allowedFields = [
      'source_node_id',
      'target_node_id',
      'source_handle',
      'target_handle',
      'waypoint_x',
      'waypoint_y',
      'source_interface',
      'target_interface',
      'source_label_visible',
      'target_label_visible',
      'label',
      'label_color',
      'speed',
      'cable_type',
      'line_style',
      'animate',
      'snapping',
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
    const [existing] = await pool.query('SELECT source_node_id, target_node_id FROM topology_edges WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);

    // Idempotent: an edge may already have been removed by a cascading
    // node deletion, in which case this is a no-op rather than an error.
    await pool.query('DELETE FROM topology_edges WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);

    if (existing.length > 0) {
      const [sourceName, targetName] = await Promise.all([
        nodeDisplayName(req.projectId, existing[0].source_node_id),
        nodeDisplayName(req.projectId, existing[0].target_node_id),
      ]);
      logActivity(req.projectId, req.user.id, 'topology.edge.deleted', `${sourceName} ↔ ${targetName}`);
    }

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
    const allowedFields = ['name', 'border_style', 'color', 'vlan_id', 'x', 'y', 'width', 'height'];
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

// GET /api/topology/shapes
router.get('/shapes', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM topology_shapes WHERE project_id = ? ORDER BY id ASC', [req.projectId]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/topology/shapes
router.post('/shapes', async (req, res, next) => {
  try {
    const { shape_type, x, y, width, height, fill_color, border_color, label } = req.body;
    const [result] = await pool.query(
      `INSERT INTO topology_shapes (project_id, shape_type, x, y, width, height, fill_color, border_color, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.projectId, shape_type || 'rect', x || 0, y || 0, width || 160, height || 100,
       fill_color || '#3b82f620', border_color || '#3b82f6', label || null]
    );
    const [rows] = await pool.query('SELECT * FROM topology_shapes WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topology/shapes/:id
router.patch('/shapes/:id', async (req, res, next) => {
  try {
    const allowed = ['shape_type', 'x', 'y', 'width', 'height', 'fill_color', 'border_color', 'label'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (key in req.body) {
        updates.push(`${key} = ?`);
        values.push(req.body[key]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    values.push(req.params.id, req.projectId);
    await pool.query(`UPDATE topology_shapes SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`, values);
    const [rows] = await pool.query('SELECT * FROM topology_shapes WHERE id = ?', [req.params.id]);
    res.json(rows[0] || {});
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/shapes/:id
router.delete('/shapes/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM topology_shapes WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Shape not found' });
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
