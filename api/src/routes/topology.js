const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// GET /api/topology - all devices with layout positions, plus links derived from ports
router.get('/', async (req, res, next) => {
  try {
    const [nodes] = await pool.query(
      `SELECT d.id, d.hostname, d.ip, d.mac, d.type, d.snmp_community, d.notes,
              COALESCE(tl.x, 0) AS x, COALESCE(tl.y, 0) AS y
       FROM devices d
       LEFT JOIN topology_layout tl ON tl.device_id = d.id`
    );

    const [edges] = await pool.query(
      `SELECT id, device_id AS source, connected_device_id AS target, port_name, cable_type, speed
       FROM ports
       WHERE connected_device_id IS NOT NULL`
    );

    res.json({ nodes, edges });
  } catch (err) {
    next(err);
  }
});

// PUT /api/topology/:device_id - upsert a device's canvas position
router.put('/:device_id', async (req, res, next) => {
  try {
    const { x, y } = req.body;
    if (x === undefined || y === undefined) {
      return res.status(400).json({ error: 'x and y are required' });
    }

    await pool.query(
      `INSERT INTO topology_layout (device_id, x, y)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE x = VALUES(x), y = VALUES(y)`,
      [req.params.device_id, x, y]
    );

    res.json({ device_id: Number(req.params.device_id), x, y });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
