const express = require('express');
const axios = require('axios');
const pool = require('../db/pool');
const sse = require('../sse/hub');
const { getSystemInfo } = require('../services/snmpScan');

const router = express.Router();

// Infer a device type from SNMP sysDescr/sysObjectID (and a couple of port
// hints). Returns a value from the same DEVICE_TYPES vocabulary as
// scanner/modules/device_type.py, or 'Unknown' when nothing matches so
// callers can keep an existing better guess.
function inferSnmpDeviceType(sysDescr, sysObjectID, openPorts) {
  const text = `${sysDescr || ''} ${sysObjectID || ''}`;
  const ports = new Set((openPorts || []).map(Number));
  if (/UVC|camera/i.test(text)) return 'IP Camera';
  if (/\bNVR\b/i.test(text)) return 'Server';
  if (/UniFi/i.test(text) && /\bAP\b|access point/i.test(text)) return 'AP';
  if (/FortiOS|Fortinet/i.test(text)) return 'Firewall';
  if (/switch/i.test(text)) return 'Switch';
  if (/router|EdgeRouter/i.test(text)) return 'Router';
  if (/Windows/i.test(text)) return 'Windows PC';
  if (/Linux/i.test(text) && ports.has(22)) return 'Server';
  return 'Unknown';
}

// Background SNMP enrichment for a freshly-discovered host: when the scan job
// requested it, try each of the project's SNMP credential macros against the
// host and, on the first that answers, update the row's hostname/OS/device
// type and record which macro responded. Re-published over SSE so the table
// updates in place. Never throws into the request path - it runs detached.
async function enrichResultWithSnmp(jobId, resultId, ip) {
  const [jobRows] = await pool.query('SELECT project_id, snmp_enrichment FROM scan_jobs WHERE id = ?', [jobId]);
  if (jobRows.length === 0 || !jobRows[0].snmp_enrichment) return;
  const projectId = jobRows[0].project_id;

  const [macros] = await pool.query(
    `SELECT * FROM project_credential_macros
     WHERE project_id = ? AND type IN ('snmp_v1', 'snmp_v2c', 'snmp_v3')
     ORDER BY id ASC`,
    [projectId]
  );
  if (macros.length === 0) return;

  let info = null;
  let macro = null;
  for (const candidate of macros) {
    // eslint-disable-next-line no-await-in-loop
    const result = await getSystemInfo(ip, candidate);
    if (result) {
      info = result;
      macro = candidate;
      break;
    }
  }
  if (!info || !macro) return;

  const [current] = await pool.query('SELECT * FROM scan_results WHERE id = ?', [resultId]);
  if (current.length === 0) return;
  const row = current[0];
  const openPorts = parseJsonField(row.open_ports, []);

  const hostname = row.hostname || info.sysName || null;
  const os = info.sysDescr || row.os || null;
  const snmpType = inferSnmpDeviceType(info.sysDescr, info.sysObjectID, openPorts);
  // Only override the device type when SNMP gives us something concrete;
  // otherwise keep whatever the scanner already inferred.
  const deviceType = snmpType !== 'Unknown' ? snmpType : row.device_type;

  const rawObj = parseJsonField(row.raw, {}) || {};
  rawObj.snmp = {
    macro_id: macro.id,
    macro_name: macro.name,
    sysDescr: info.sysDescr,
    sysName: info.sysName,
    sysLocation: info.sysLocation,
    sysObjectID: info.sysObjectID,
  };

  await pool.query(
    `UPDATE scan_results SET hostname = ?, device_type = ?, os = ?, snmp_macro_id = ?, raw = ? WHERE id = ?`,
    [hostname, deviceType, os, macro.id, JSON.stringify(rawObj), resultId]
  );

  const [updated] = await pool.query('SELECT * FROM scan_results WHERE id = ?', [resultId]);
  if (updated.length > 0) sse.publish(jobId, 'host', mapResultRow(updated[0]));
}

const SCANNER_URL = process.env.SCANNER_URL || 'http://rackpath-scanner:5001';
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || `http://rackpath-api:${process.env.API_PORT || 3000}`;

// MariaDB stores JSON columns as LONGTEXT, so the mysql2 driver hands them
// back as raw strings rather than parsed values. Parse defensively so callers
// always receive real arrays/objects (the frontend table expects open_ports to
// be an array and raw to be an object).
function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      return fallback;
    }
  }
  return value;
}

// Map a stored scan_results row to the shape the frontend table consumes.
function mapResultRow(row) {
  const openPorts = parseJsonField(row.open_ports, []);
  return {
    id: row.id,
    status: row.status,
    ip: row.ip,
    hostname: row.hostname,
    mac: row.mac,
    mac_vendor: row.mac_vendor,
    device_type: row.device_type,
    os: row.os,
    open_ports: Array.isArray(openPorts) ? openPorts : [],
    netbios_name: row.netbios_name,
    last_seen: row.last_seen,
    raw: parseJsonField(row.raw, null),
    snmp_macro_id: row.snmp_macro_id ?? null,
    snmp: row.snmp_macro_id != null,
  };
}

// GET /api/scans - list scan jobs with discovered host counts
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT j.id, j.name, j.target_subnet, j.target_type, j.scan_profile, j.options, j.snmp_community,
              j.status, j.progress_current, j.progress_total,
              j.started_at, j.completed_at, j.created_at, j.updated_at,
              COUNT(r.id) AS host_count
       FROM scan_jobs j
       LEFT JOIN scan_results r ON r.scan_job_id = j.id
       WHERE j.project_id = ?
       GROUP BY j.id
       ORDER BY j.id DESC`,
      [req.projectId]
    );
    res.json(rows.map((row) => ({ ...row, options: parseJsonField(row.options, null) })));
  } catch (err) {
    next(err);
  }
});

// GET /api/scans/:id - job status (without per-host rows)
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM scan_jobs WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: 'Scan job not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/scans/:id/results - all discovered host rows for a scan
router.get('/:id/results', async (req, res, next) => {
  try {
    const [jobRows] = await pool.query('SELECT id FROM scan_jobs WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (jobRows.length === 0) return res.status(404).json({ error: 'Scan job not found' });

    const [rows] = await pool.query(
      'SELECT * FROM scan_results WHERE scan_job_id = ? ORDER BY id ASC',
      [req.params.id]
    );
    res.json(rows.map(mapResultRow));
  } catch (err) {
    next(err);
  }
});

// GET /api/scans/:id/stream - Server-Sent Events stream of host results and
// progress for a scan. Authenticated via ?token= (see auth middleware).
router.get('/:id/stream', async (req, res, next) => {
  try {
    const jobId = req.params.id;
    const [jobRows] = await pool.query('SELECT * FROM scan_jobs WHERE id = ?', [jobId]);
    if (jobRows.length === 0) return res.status(404).json({ error: 'Scan job not found' });

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    sse.subscribe(jobId, res);

    // Replay any rows already discovered so a client connecting mid-scan (or
    // after completion) immediately sees the full table.
    const [existing] = await pool.query(
      'SELECT * FROM scan_results WHERE scan_job_id = ? ORDER BY id ASC',
      [jobId]
    );
    const job = jobRows[0];
    res.write(
      `event: init\ndata: ${JSON.stringify({
        progress_current: job.progress_current,
        progress_total: job.progress_total,
        status: job.status,
        hosts: existing.map(mapResultRow),
      })}\n\n`
    );

    // If the scan already finished, tell the client right away.
    if (job.status === 'completed' || job.status === 'failed') {
      res.write(`event: scan_complete\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
    }

    // Heartbeat to keep proxies from closing the idle connection.
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sse.unsubscribe(jobId, res);
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/scans/history - delete all scan jobs and their results.
// Defined before the /:id routes so "history" isn't captured as an id.
router.delete('/history', async (req, res, next) => {
  try {
    // Only clear the current project's scans. scan_results rows are removed via
    // their scan_job_id (joined to scoped jobs) before the jobs themselves.
    await pool.query(
      `DELETE r FROM scan_results r
       JOIN scan_jobs j ON j.id = r.scan_job_id
       WHERE j.project_id = ?`,
      [req.projectId]
    );
    const [result] = await pool.query('DELETE FROM scan_jobs WHERE project_id = ?', [req.projectId]);
    res.json({ ok: true, deleted: result.affectedRows });
  } catch (err) {
    next(err);
  }
});

// POST /api/scans/:id/rescan — restart an existing scan job in place.
// Resets the row's status/results/timestamps and re-submits to the scanner,
// avoiding duplicate history entries. Returns 409 if already pending/running.
// Defined before /api/scans POST so the router doesn't confuse /:id with /.
router.post('/:id/rescan', async (req, res, next) => {
  try {
    const jobId = req.params.id;
    const [jobRows] = await pool.query(
      'SELECT * FROM scan_jobs WHERE id = ? AND project_id = ?',
      [jobId, req.projectId]
    );
    if (jobRows.length === 0) return res.status(404).json({ error: 'Scan job not found' });

    const job = jobRows[0];
    if (job.status === 'pending' || job.status === 'running') {
      return res.status(409).json({ error: 'Scan already running' });
    }

    await pool.query('DELETE FROM scan_results WHERE scan_job_id = ?', [jobId]);
    await pool.query(
      `UPDATE scan_jobs
       SET status = 'pending', started_at = NOW(), completed_at = NULL,
           progress_current = NULL, progress_total = NULL, results = NULL
       WHERE id = ?`,
      [jobId]
    );

    const opts = parseJsonField(job.options, null);

    try {
      await axios.post(`${SCANNER_URL}/scan`, {
        job_id: jobId,
        target_subnet: job.target_subnet,
        snmp_community: job.snmp_community || process.env.SNMP_COMMUNITY || 'public',
        options: opts || undefined,
        callback_url: `${API_PUBLIC_URL}/api/scans/${jobId}/results`,
        host_callback_url: `${API_PUBLIC_URL}/api/scans/${jobId}/host`,
        progress_callback_url: `${API_PUBLIC_URL}/api/scans/${jobId}/progress`,
      });
      await pool.query("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [jobId]);
    } catch (scanErr) {
      await pool.query(
        "UPDATE scan_jobs SET status = 'failed', completed_at = NOW(), results = ? WHERE id = ?",
        [JSON.stringify({ error: `Failed to reach scanner: ${scanErr.message}` }), jobId]
      );
    }

    const [rows] = await pool.query('SELECT * FROM scan_jobs WHERE id = ?', [jobId]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/scans - start a new scan job for a subnet
router.post('/', async (req, res, next) => {
  try {
    const { target_subnet, name, snmp_community, options } = req.body;
    if (!target_subnet) return res.status(400).json({ error: 'target_subnet is required' });

    const targetType = (options && options.target_type) || null;
    const scanProfile = (options && options.profile) || null;
    const snmpEnrichment = !!(options && options.snmp_enrichment);

    const scanName =
      (name && name.trim()) ||
      `${target_subnet} - ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

    const [result] = await pool.query(
      `INSERT INTO scan_jobs (project_id, name, target_subnet, target_type, scan_profile, snmp_enrichment, options, snmp_community, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [req.projectId, scanName, target_subnet, targetType, scanProfile, snmpEnrichment ? 1 : 0, options ? JSON.stringify(options) : null, snmp_community || null]
    );
    const jobId = result.insertId;

    // Kick off the scan on the scanner service. The scanner runs
    // asynchronously and streams per-host results back to the host callback,
    // reports progress, and posts a final completion to the results callback.
    try {
      await axios.post(`${SCANNER_URL}/scan`, {
        job_id: jobId,
        target_subnet,
        snmp_community: snmp_community || process.env.SNMP_COMMUNITY || 'public',
        options: options || undefined,
        callback_url: `${API_PUBLIC_URL}/api/scans/${jobId}/results`,
        host_callback_url: `${API_PUBLIC_URL}/api/scans/${jobId}/host`,
        progress_callback_url: `${API_PUBLIC_URL}/api/scans/${jobId}/progress`,
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

// POST /api/scans/:id/host - callback used by the scanner to report a single
// fully-enriched host as soon as it is discovered. Stored in scan_results and
// pushed to any connected SSE clients.
router.post('/:id/host', async (req, res, next) => {
  try {
    const jobId = req.params.id;
    const host = req.body || {};

    const [jobRows] = await pool.query('SELECT id FROM scan_jobs WHERE id = ?', [jobId]);
    if (jobRows.length === 0) return res.status(404).json({ error: 'Scan job not found' });

    const openPorts = host.open_ports != null ? JSON.stringify(host.open_ports) : null;
    const raw = host.raw != null ? JSON.stringify(host.raw) : null;

    const [result] = await pool.query(
      `INSERT INTO scan_results
        (scan_job_id, status, ip, hostname, mac, mac_vendor, device_type, os,
         open_ports, netbios_name, last_seen, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [
        jobId,
        host.status === 'down' ? 'down' : 'up',
        host.ip || null,
        host.hostname || null,
        host.mac || null,
        host.mac_vendor || null,
        host.device_type || null,
        host.os || null,
        openPorts,
        host.netbios_name || null,
        raw,
      ]
    );

    const [rows] = await pool.query('SELECT * FROM scan_results WHERE id = ?', [result.insertId]);
    sse.publish(jobId, 'host', mapResultRow(rows[0]));

    // Kick off SNMP enrichment in the background (when the job requested it) so
    // the row gets accurate OS/device-type data without blocking scan progress.
    if ((host.status || 'up') !== 'down' && host.ip) {
      enrichResultWithSnmp(jobId, result.insertId, host.ip).catch((enrichErr) =>
        console.error(`SNMP enrichment failed for ${host.ip}:`, enrichErr.message)
      );
    }

    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    next(err);
  }
});

// POST /api/scans/:id/results - final completion callback from the scanner.
// Marks the job done and emits a scan_complete event to SSE clients.
router.post('/:id/results', async (req, res, next) => {
  try {
    const jobId = req.params.id;
    const { status, results } = req.body;

    const [jobRows] = await pool.query('SELECT id FROM scan_jobs WHERE id = ?', [jobId]);
    if (jobRows.length === 0) return res.status(404).json({ error: 'Scan job not found' });

    const finalStatus = status === 'failed' ? 'failed' : 'completed';

    await pool.query(
      `UPDATE scan_jobs
       SET status = ?, completed_at = NOW(), results = ?
       WHERE id = ?`,
      [finalStatus, JSON.stringify(results || req.body), jobId]
    );

    sse.publish(jobId, 'scan_complete', { status: finalStatus });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/scans/:id/progress - incremental progress callback from the scanner.
router.post('/:id/progress', async (req, res, next) => {
  try {
    const jobId = req.params.id;
    const { progress_current, progress_total } = req.body;

    const [result] = await pool.query(
      'UPDATE scan_jobs SET progress_current = ?, progress_total = ? WHERE id = ?',
      [progress_current ?? null, progress_total ?? null, jobId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Scan job not found' });

    sse.publish(jobId, 'progress', {
      progress_current: progress_current ?? null,
      progress_total: progress_total ?? null,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/scans/:id/import - import a user-selected subset of discovered
// hosts into the devices/ports tables. Duplicates (by IP) are updated rather
// than inserted, and reported back so the UI can show what was skipped.
router.post('/:id/import', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const jobId = req.params.id;
    const { devices } = req.body;

    const [jobRows] = await conn.query('SELECT id FROM scan_jobs WHERE id = ? AND project_id = ?', [
      jobId,
      req.projectId,
    ]);
    if (jobRows.length === 0) {
      conn.release();
      return res.status(404).json({ error: 'Scan job not found' });
    }

    if (!Array.isArray(devices) || devices.length === 0) {
      conn.release();
      return res.status(400).json({ error: 'devices must be a non-empty array' });
    }

    await conn.beginTransaction();

    const added = [];
    const skipped = [];
    for (const device of devices) {
      const { ip, mac, hostname, type, device_type, snmp_community, ports, snmp_macro_id } = device;
      const deviceType = type || device_type || null;

      // Duplicate detection is scoped to the current project so the same IP
      // can be imported into different projects.
      const [existing] = await conn.query(
        `SELECT id FROM devices
         WHERE project_id = ? AND ((ip IS NOT NULL AND ip = ?) OR (mac IS NOT NULL AND mac = ?)) LIMIT 1`,
        [req.projectId, ip || null, mac || null]
      );

      if (existing.length > 0) {
        // Duplicate by IP/MAC - skip it and report so the UI can tell the user
        // it already existed in the inventory.
        skipped.push({ id: existing[0].id, ip: ip || null, hostname: hostname || null });
        continue;
      }

      // If SNMP responded during the scan, pre-select that credential macro on
      // the device (and seed its community string) so a later device-page scan
      // uses the right one without the user picking it again.
      let credentialMacroId = null;
      let snmpCommunity = snmp_community || null;
      if (snmp_macro_id) {
        const [macroRows] = await conn.query(
          'SELECT id, community_string FROM project_credential_macros WHERE id = ? AND project_id = ?',
          [snmp_macro_id, req.projectId]
        );
        if (macroRows.length > 0) {
          credentialMacroId = macroRows[0].id;
          if (!snmpCommunity && macroRows[0].community_string) snmpCommunity = macroRows[0].community_string;
        }
      }

      const [insertResult] = await conn.query(
        `INSERT INTO devices (project_id, hostname, ip, mac, type, snmp_community, credential_macro_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.projectId, hostname || null, ip || null, mac || null, deviceType, snmpCommunity, credentialMacroId]
      );
      const deviceId = insertResult.insertId;

      if (Array.isArray(ports)) {
        for (const port of ports) {
          const { port_name, port_number, speed } = port;
          await conn.query(
            `INSERT INTO ports (project_id, device_id, port_name, port_number, speed)
             VALUES (?, ?, ?, ?, ?)`,
            [req.projectId, deviceId, port_name || null, port_number || null, speed || null]
          );
        }
      }

      added.push({ id: deviceId, ip: ip || null, hostname: hostname || null });
    }

    await conn.commit();
    res.json({
      ok: true,
      added,
      skipped,
      device_ids: added.map((d) => d.id),
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
