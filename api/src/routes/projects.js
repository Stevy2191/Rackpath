const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const DEFAULT_PROJECT_ID = 1;

// Tables that hold project-scoped data, deleted (child-first) when a project
// is removed. This works regardless of whether the project_id ON DELETE
// CASCADE foreign keys are present in a given deployment.
const SCOPED_TABLES = [
  'topology_edges',
  'topology_nodes',
  'topology_zones',
  'topology_layout',
  'rack_slots',
  'ports',
  'scan_jobs',
  'racks',
  'device_tags',
  'project_credential_macros',
  'project_cameras',
  'project_access_devices',
  'devices',
  'project_vlans',
  'project_integrations',
  'project_activity_log',
];

// GET /api/projects - list all projects
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM projects ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects - create a project
router.post('/', async (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const [result] = await pool.query(
      'INSERT INTO projects (name, description) VALUES (?, ?)',
      [name.trim(), description || null]
    );
    const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/projects/:id - rename / update a project
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'description'];
    const updates = [];
    const values = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(field === 'name' ? String(req.body[field]).trim() : req.body[field]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id);
    const [result] = await pool.query(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, values);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Project not found' });

    const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:id/overview - Site Overview Dashboard data: summary
// cards, configuration warnings, and detail lists used for the documentation export.
router.get('/:id/overview', async (req, res, next) => {
  try {
    const projectId = req.params.id;

    const [projectRows] = await pool.query('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (projectRows.length === 0) return res.status(404).json({ error: 'Project not found' });

    const scalar = async (sql, params) => {
      const [rows] = await pool.query(sql, params);
      return rows[0];
    };

    const [
      deviceCount,
      cameraCount,
      linkCount,
      vlanCount,
      rackCount,
      rackUsage,
      devicesNoIp,
      devicesNoRack,
      devicesNoCredential,
      interfacesNoIp,
      vlansNoSubnet,
      nodesNoDevice,
      devices,
      racks,
      vlans,
      links,
    ] = await Promise.all([
      scalar('SELECT COUNT(*) AS count FROM devices WHERE project_id = ?', [projectId]),
      scalar('SELECT COUNT(*) AS count FROM project_cameras WHERE project_id = ?', [projectId]),
      scalar('SELECT COUNT(*) AS count FROM topology_edges WHERE project_id = ?', [projectId]),
      scalar('SELECT COUNT(*) AS count FROM project_vlans WHERE project_id = ?', [projectId]),
      scalar('SELECT COUNT(*) AS count FROM racks WHERE project_id = ?', [projectId]),
      scalar(
        `SELECT
           COALESCE((SELECT SUM(u_size) FROM rack_slots WHERE project_id = ? AND device_id IS NOT NULL), 0) AS used_u,
           COALESCE((SELECT SUM(u_height) FROM racks WHERE project_id = ?), 0) AS total_u`,
        [projectId, projectId]
      ),
      pool.query("SELECT id, hostname, ip FROM devices WHERE project_id = ? AND (ip IS NULL OR ip = '')", [projectId]),
      pool.query(
        `SELECT d.id, d.hostname FROM devices d
         WHERE d.project_id = ? AND d.id NOT IN (
           SELECT device_id FROM rack_slots WHERE project_id = ? AND device_id IS NOT NULL
         )`,
        [projectId, projectId]
      ),
      pool.query('SELECT id, hostname FROM devices WHERE project_id = ? AND credential_macro_id IS NULL', [projectId]),
      pool.query(
        `SELECT tni.id, tni.name, d.hostname
         FROM topology_node_interfaces tni
         JOIN devices d ON d.id = tni.device_id
         WHERE tni.project_id = ? AND (tni.ip IS NULL OR tni.ip = '')`,
        [projectId]
      ),
      pool.query("SELECT id, vlan_id, name FROM project_vlans WHERE project_id = ? AND (subnet IS NULL OR subnet = '')", [projectId]),
      pool.query("SELECT id, label, type FROM topology_nodes WHERE project_id = ? AND device_id IS NULL", [projectId]),
      pool.query('SELECT id, hostname, ip, type, location, make, model FROM devices WHERE project_id = ? ORDER BY hostname', [projectId]),
      pool.query(
        `SELECT r.id, r.name, r.location, r.u_height,
                COALESCE(SUM(rs.u_size), 0) AS used_u
         FROM racks r
         LEFT JOIN rack_slots rs ON rs.rack_id = r.id AND rs.device_id IS NOT NULL
         WHERE r.project_id = ?
         GROUP BY r.id
         ORDER BY r.name`,
        [projectId]
      ),
      pool.query('SELECT id, vlan_id, name, subnet, description FROM project_vlans WHERE project_id = ? ORDER BY vlan_id', [projectId]),
      pool.query(
        `SELECT e.id, e.label, e.speed, e.cable_type, e.vlan, e.source_interface, e.target_interface,
                COALESCE(sd.hostname, sn.label, CONCAT('Node ', sn.id)) AS source_name,
                COALESCE(td.hostname, tn.label, CONCAT('Node ', tn.id)) AS target_name
         FROM topology_edges e
         LEFT JOIN topology_nodes sn ON sn.id = e.source_node_id
         LEFT JOIN devices sd ON sd.id = sn.device_id
         LEFT JOIN topology_nodes tn ON tn.id = e.target_node_id
         LEFT JOIN devices td ON td.id = tn.device_id
         WHERE e.project_id = ?`,
        [projectId]
      ),
    ]);

    const totalU = Number(rackUsage.total_u) || 0;
    const usedU = Number(rackUsage.used_u) || 0;

    res.json({
      summary: {
        totalDevices: deviceCount.count + cameraCount.count,
        totalLinks: linkCount.count,
        vlanCount: vlanCount.count,
        rackCount: rackCount.count,
        rackUtilization: totalU > 0 ? Math.round((usedU / totalU) * 1000) / 10 : 0,
        cameraCount: cameraCount.count,
      },
      warnings: {
        devicesNoIp: devicesNoIp[0],
        devicesNoRack: devicesNoRack[0],
        devicesNoCredential: devicesNoCredential[0],
        interfacesNoIp: interfacesNoIp[0],
        vlansNoSubnet: vlansNoSubnet[0],
        nodesNoDevice: nodesNoDevice[0],
      },
      details: {
        devices: devices[0],
        racks: racks[0],
        vlans: vlans[0],
        links: links[0],
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:id/activity - recent activity feed
router.get('/:id/activity', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const [rows] = await pool.query(
      `SELECT pal.id, pal.action, pal.details, pal.created_at, u.username
       FROM project_activity_log pal
       JOIN users u ON u.id = pal.user_id
       WHERE pal.project_id = ?
       ORDER BY pal.created_at DESC
       LIMIT ?`,
      [req.params.id, limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:id - delete a project and all of its data
router.delete('/:id', async (req, res, next) => {
  const projectId = parseInt(req.params.id, 10);
  if (projectId === DEFAULT_PROJECT_ID) {
    return res.status(400).json({ error: 'The Default Project cannot be deleted' });
  }

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT id FROM projects WHERE id = ?', [projectId]);
    if (rows.length === 0) {
      conn.release();
      return res.status(404).json({ error: 'Project not found' });
    }

    await conn.beginTransaction();
    for (const table of SCOPED_TABLES) {
      await conn.query(`DELETE FROM ${table} WHERE project_id = ?`, [projectId]);
    }
    await conn.query('DELETE FROM projects WHERE id = ?', [projectId]);
    await conn.commit();

    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
