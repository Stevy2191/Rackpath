const express = require('express');
const pool = require('../db/pool');
const { TEMPLATES, TEMPLATE_KEYS } = require('../templates/networkTemplates');

const router = express.Router();

const DEFAULT_PROJECT_ID = 1;

// Tables that hold project-scoped data, deleted child-first when a project
// is removed. Order matters: each table must come before any table it FKs into.
// This explicit sweep is a safety net for deployments where ON DELETE CASCADE
// wasn't applied retroactively on older schema versions.
const SCOPED_TABLES = [
  // Children of topology_nodes / devices
  'topology_connection_points',
  'topology_node_interfaces',
  'topology_edges',
  'topology_nodes',
  'topology_zones',
  'topology_shapes',
  'topology_labels',
  'topology_layout',
  // Children of scan_jobs
  'scan_results',
  'scan_jobs',
  // Children of project_integrations
  'integration_sync_log',
  'project_integrations',
  // Children of project_cameras / device_tags
  'camera_tag_assignments',
  'project_cameras',
  // Children of devices / device_tags
  'device_tag_assignments',
  'device_tags',
  'project_access_devices',
  'rooms',
  'locations',
  // Children of racks
  'rack_slots',
  'rack_custom_devices',
  'racks',
  // Remaining project-scoped tables
  'project_credential_macros',
  'project_vlans',
  'project_activity_log',
  'devices',
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
    const allowed = [
      'name',
      'description',
      'address',
      'address_street',
      'address_city',
      'address_state',
      'address_zip',
      'site_contact_name',
      'site_contact_phone',
      'site_contact_email',
      'primary_isp_name',
      'primary_isp_circuit_id',
      'primary_isp_contact',
      'secondary_isp_name',
      'secondary_isp_circuit_id',
      'secondary_isp_contact',
      'wan_ip',
      'wan_subnet',
      'wan_gateway',
      'lan_ip',
      'lan_subnet',
      'lan_gateway',
      'dns_servers',
    ];
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

// POST /api/projects/:id/apply-template - populate a project's topology
// canvas, VLANs, and rack from a hardcoded starter template.
router.post('/:id/apply-template', async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const { template } = req.body || {};

    if (!TEMPLATE_KEYS.includes(template)) {
      return res.status(400).json({ error: `template must be one of: ${TEMPLATE_KEYS.join(', ')}` });
    }

    const [projectRows] = await pool.query('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (projectRows.length === 0) return res.status(404).json({ error: 'Project not found' });

    const def = TEMPLATES[template];

    if (def.nodes.length > 0) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        const nodeIdsByKey = {};
        for (const node of def.nodes) {
          const [deviceResult] = await conn.query(
            'INSERT INTO devices (project_id, hostname, type) VALUES (?, ?, ?)',
            [projectId, node.label, node.type]
          );
          const [nodeResult] = await conn.query(
            'INSERT INTO topology_nodes (project_id, device_id, x, y) VALUES (?, ?, ?, ?)',
            [projectId, deviceResult.insertId, node.x, node.y]
          );
          nodeIdsByKey[node.key] = { deviceId: deviceResult.insertId, nodeId: nodeResult.insertId };
        }

        for (const [sourceKey, targetKey] of def.edges) {
          await conn.query(
            'INSERT INTO topology_edges (project_id, source_node_id, target_node_id) VALUES (?, ?, ?)',
            [projectId, nodeIdsByKey[sourceKey].nodeId, nodeIdsByKey[targetKey].nodeId]
          );
        }

        for (const vlan of def.vlans) {
          await conn.query(
            'INSERT INTO project_vlans (project_id, vlan_id, name, subnet) VALUES (?, ?, ?, ?)',
            [projectId, vlan.vlan_id, vlan.name, vlan.subnet]
          );
        }

        if (def.rack) {
          const [rackResult] = await conn.query(
            'INSERT INTO racks (project_id, name, u_height) VALUES (?, ?, ?)',
            [projectId, def.rack.name, def.rack.u_height]
          );
          const rackId = rackResult.insertId;

          for (const item of def.rack.items) {
            await conn.query(
              'INSERT INTO rack_slots (project_id, rack_id, device_id, u_position, u_size, item_type) VALUES (?, ?, ?, ?, ?, ?)',
              [projectId, rackId, nodeIdsByKey[item.key].deviceId, item.u_position, 1, 'device']
            );
          }
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    const [nodes] = await pool.query(
      `SELECT n.id, n.device_id, n.label, n.type AS node_type,
              n.icon_color AS node_icon_color, n.text_color AS node_text_color,
              n.x, n.y, n.width, n.height,
              d.hostname, d.ip, d.mac, d.type AS device_type, d.snmp_community, d.notes,
              d.icon_color AS device_icon_color, d.text_color AS device_text_color, d.updated_at
       FROM topology_nodes n
       LEFT JOIN devices d ON d.id = n.device_id
       WHERE n.project_id = ?`,
      [projectId]
    );
    const [edges] = await pool.query('SELECT * FROM topology_edges WHERE project_id = ?', [projectId]);
    const [vlans] = await pool.query('SELECT * FROM project_vlans WHERE project_id = ? ORDER BY vlan_id ASC', [projectId]);
    const [racks] = await pool.query('SELECT * FROM racks WHERE project_id = ? ORDER BY name', [projectId]);

    for (const rack of racks) {
      const [slots] = await pool.query(
        `SELECT rs.*, d.hostname, d.ip, d.type AS device_type
         FROM rack_slots rs
         LEFT JOIN devices d ON d.id = rs.device_id
         WHERE rs.rack_id = ?
         ORDER BY rs.u_position`,
        [rack.id]
      );
      rack.slots = slots;
    }

    res.status(201).json({
      project: projectRows[0],
      topology: { nodes, edges },
      vlans,
      racks,
    });
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
      vlansNoSubnet,
      nodesNoDevice,
      devices,
      racks,
      vlans,
      links,
      locations,
      rooms,
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
      pool.query("SELECT id, vlan_id, name FROM project_vlans WHERE project_id = ? AND (subnet IS NULL OR subnet = '')", [projectId]),
      pool.query("SELECT id, label, type FROM topology_nodes WHERE project_id = ? AND device_id IS NULL", [projectId]),
      pool.query('SELECT id, hostname, ip, type, location, make, model FROM devices WHERE project_id = ? ORDER BY hostname', [projectId]),
      pool.query(
        `SELECT r.id, r.name, r.u_height, r.location_id, r.room_id,
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
      pool.query(
        `SELECT l.id, l.name, l.building_number,
                COUNT(DISTINCT r2.id) AS room_count,
                COUNT(DISTINCT rk.id) AS rack_count
         FROM locations l
         LEFT JOIN rooms r2 ON r2.location_id = l.id
         LEFT JOIN racks rk ON rk.location_id = l.id
         WHERE l.project_id = ?
         GROUP BY l.id
         ORDER BY l.name`,
        [projectId]
      ),
      pool.query(
        `SELECT r.*, l.name AS location_name
         FROM rooms r
         JOIN locations l ON l.id = r.location_id
         WHERE l.project_id = ?
         ORDER BY l.name, r.name`,
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
        vlansNoSubnet: vlansNoSubnet[0],
        nodesNoDevice: nodesNoDevice[0],
      },
      details: {
        devices: devices[0],
        racks: racks[0],
        vlans: vlans[0],
        links: links[0],
        locations: locations[0],
        rooms: rooms[0],
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
      `SELECT pal.id, pal.action, pal.details, pal.created_at,
              COALESCE(u.username, '[deleted]') AS username
       FROM project_activity_log pal
       LEFT JOIN users u ON u.id = pal.user_id
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
