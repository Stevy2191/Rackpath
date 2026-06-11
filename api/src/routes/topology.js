const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const NODE_FIELDS = `d.id, d.hostname, d.ip, d.mac, d.type, d.snmp_community, d.notes,
              d.updated_at, tl.x, tl.y`;

// GET /api/topology - devices that have been placed on the canvas, with position
router.get('/', async (req, res, next) => {
  try {
    const [nodes] = await pool.query(
      `SELECT ${NODE_FIELDS}
       FROM devices d
       INNER JOIN topology_layout tl ON tl.device_id = d.id`
    );

    res.json({ nodes });
  } catch (err) {
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
      const { device_id, x, y } = pos || {};
      if (device_id === undefined || x === undefined || y === undefined) continue;

      await pool.query(
        `INSERT INTO topology_layout (device_id, x, y)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE x = VALUES(x), y = VALUES(y)`,
        [device_id, x, y]
      );
    }

    res.json({ updated: positions.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/topology/nodes - create a new device and place it on the canvas
router.post('/nodes', async (req, res, next) => {
  try {
    const { hostname, ip, type, x, y } = req.body;

    const [result] = await pool.query(
      `INSERT INTO devices (hostname, ip, type) VALUES (?, ?, ?)`,
      [hostname || null, ip || null, type || null]
    );
    const deviceId = result.insertId;

    await pool.query(
      `INSERT INTO topology_layout (device_id, x, y) VALUES (?, ?, ?)`,
      [deviceId, x || 0, y || 0]
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
      'DELETE FROM topology_edges WHERE source_device_id = ? OR target_device_id = ?',
      [deviceId, deviceId]
    );

    await pool.query('DELETE FROM topology_layout WHERE device_id = ?', [deviceId]);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/topology/edges
router.get('/edges', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM topology_edges');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/topology/edges
router.post('/edges', async (req, res, next) => {
  try {
    const { source_device_id, target_device_id, label, speed, cable_type, vlan } = req.body;
    if (!source_device_id || !target_device_id) {
      return res.status(400).json({ error: 'source_device_id and target_device_id are required' });
    }

    const [result] = await pool.query(
      `INSERT INTO topology_edges (source_device_id, target_device_id, label, speed, cable_type, vlan)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [source_device_id, target_device_id, label || null, speed || null, cable_type || null, vlan || null]
    );

    const [rows] = await pool.query('SELECT * FROM topology_edges WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topology/edges/:id
router.delete('/edges/:id', async (req, res, next) => {
  try {
    // Idempotent: an edge may already have been removed by a cascading
    // node deletion, in which case this is a no-op rather than an error.
    await pool.query('DELETE FROM topology_edges WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/topology/zones
router.get('/zones', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM topology_zones');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/topology/zones
router.post('/zones', async (req, res, next) => {
  try {
    const { name, border_style, color, x, y, width, height } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const [result] = await pool.query(
      `INSERT INTO topology_zones (name, border_style, color, x, y, width, height)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
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

    values.push(req.params.id);
    const [result] = await pool.query(`UPDATE topology_zones SET ${updates.join(', ')} WHERE id = ?`, values);
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
    const [result] = await pool.query('DELETE FROM topology_zones WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Zone not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
