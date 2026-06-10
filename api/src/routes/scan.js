const express = require('express');
const axios = require('axios');
const pool = require('../db/pool');

const router = express.Router();

const SCANNER_URL = process.env.SCANNER_URL || 'http://rackpath-scanner:5001';
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || `http://rackpath-api:${process.env.API_PORT || 3000}`;

// GET /api/scans - list scan jobs
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, target_subnet, status, started_at, completed_at, created_at, updated_at FROM scan_jobs ORDER BY id DESC'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/scans/:id - job status + results
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM scan_jobs WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Scan job not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/scans - start a new scan job for a subnet
router.post('/', async (req, res, next) => {
  try {
    const { target_subnet, snmp_community } = req.body;
    if (!target_subnet) return res.status(400).json({ error: 'target_subnet is required' });

    const [result] = await pool.query(
      `INSERT INTO scan_jobs (target_subnet, status, started_at)
       VALUES (?, 'pending', NOW())`,
      [target_subnet]
    );
    const jobId = result.insertId;

    // Kick off the scan on the scanner service. The scanner runs
    // asynchronously and reports results back via the callback URL.
    try {
      await axios.post(`${SCANNER_URL}/scan`, {
        job_id: jobId,
        target_subnet,
        snmp_community: snmp_community || process.env.SNMP_COMMUNITY || 'public',
        callback_url: `${API_PUBLIC_URL}/api/scans/${jobId}/results`,
      });

      await pool.query("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [jobId]);
    } catch (scanErr) {
      await pool.query(
        "UPDATE scan_jobs SET status = 'failed', completed_at = NOW(), results = ? WHERE id = ?",
        [JSON.stringify({ error: `Failed to reach scanner: ${scanErr.message}` }), jobId]
      );
    }

    const [rows] = await pool.query('SELECT * FROM scan_jobs WHERE id = ?', [jobId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/scans/:id/results - callback used by the scanner service to
// report completed scan results, which are persisted to the DB.
router.post('/:id/results', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const jobId = req.params.id;
    const { status, devices, results } = req.body;

    const [jobRows] = await conn.query('SELECT * FROM scan_jobs WHERE id = ?', [jobId]);
    if (jobRows.length === 0) return res.status(404).json({ error: 'Scan job not found' });

    await conn.beginTransaction();

    if (Array.isArray(devices)) {
      for (const device of devices) {
        const { ip, mac, hostname, type, snmp_community, ports, neighbors } = device;

        const [existing] = await conn.query(
          'SELECT id FROM devices WHERE (ip IS NOT NULL AND ip = ?) OR (mac IS NOT NULL AND mac = ?) LIMIT 1',
          [ip || null, mac || null]
        );

        let deviceId;
        if (existing.length > 0) {
          deviceId = existing[0].id;
          await conn.query(
            `UPDATE devices SET hostname = COALESCE(?, hostname), ip = COALESCE(?, ip),
                                 mac = COALESCE(?, mac), type = COALESCE(?, type),
                                 snmp_community = COALESCE(?, snmp_community)
             WHERE id = ?`,
            [hostname || null, ip || null, mac || null, type || null, snmp_community || null, deviceId]
          );
        } else {
          const [insertResult] = await conn.query(
            `INSERT INTO devices (hostname, ip, mac, type, snmp_community)
             VALUES (?, ?, ?, ?, ?)`,
            [hostname || null, ip || null, mac || null, type || null, snmp_community || null]
          );
          deviceId = insertResult.insertId;
        }

        if (Array.isArray(ports)) {
          for (const port of ports) {
            const { port_name, port_number, speed } = port;
            const [existingPort] = await conn.query(
              'SELECT id FROM ports WHERE device_id = ? AND port_name = ? LIMIT 1',
              [deviceId, port_name || null]
            );
            if (existingPort.length > 0) {
              await conn.query(
                'UPDATE ports SET port_number = ?, speed = ? WHERE id = ?',
                [port_number || null, speed || null, existingPort[0].id]
              );
            } else {
              await conn.query(
                `INSERT INTO ports (device_id, port_name, port_number, speed)
                 VALUES (?, ?, ?, ?)`,
                [deviceId, port_name || null, port_number || null, speed || null]
              );
            }
          }
        }
      }
    }

    const finalStatus = status === 'failed' ? 'failed' : 'completed';
    await conn.query(
      "UPDATE scan_jobs SET status = ?, completed_at = NOW(), results = ? WHERE id = ?",
      [finalStatus, JSON.stringify(results || req.body), jobId]
    );

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
