const express = require('express');
const pool = require('../db/pool');
const { getDecrypted, testIntegration, syncIntegration } = require('../integrations/service');

const router = express.Router();

const SECRET = process.env.RACKPATH_JWT_SECRET;

const PLATFORMS = ['unifi', 'unifi-protect', 'unifi-access', 'zabbix', 'librenms', 'netbox', 'snmp', 'custom'];

// Strip encrypted credential columns from a row before sending it to the
// frontend, replacing them with booleans indicating whether a value is set.
function sanitize(row) {
  if (!row) return row;
  const { password, api_key, ...rest } = row;
  return { ...rest, has_password: !!password, has_api_key: !!api_key };
}

// GET /api/projects/:projectId/integrations - list integrations for a project
router.get('/projects/:projectId/integrations', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM project_integrations WHERE project_id = ? ORDER BY name ASC',
      [req.params.projectId]
    );
    res.json(rows.map(sanitize));
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/integrations - create a new integration
router.post('/projects/:projectId/integrations', async (req, res, next) => {
  try {
    const { name, platform, base_url, username, password, api_key, verify_ssl, auto_sync, sync_interval_minutes, config } =
      req.body || {};

    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: `platform must be one of: ${PLATFORMS.join(', ')}` });
    if (!base_url || !base_url.trim()) return res.status(400).json({ error: 'base_url is required' });

    const [result] = await pool.query(
      `INSERT INTO project_integrations
         (project_id, name, platform, base_url, username, password, api_key, verify_ssl, auto_sync, sync_interval_minutes, config)
       VALUES (?, ?, ?, ?, ?, TO_BASE64(AES_ENCRYPT(?, ?)), TO_BASE64(AES_ENCRYPT(?, ?)), ?, ?, ?, ?)`,
      [
        req.params.projectId,
        name.trim(),
        platform,
        base_url.trim(),
        username || null,
        password || null,
        SECRET,
        api_key || null,
        SECRET,
        verify_ssl !== false,
        !!auto_sync,
        sync_interval_minutes || 60,
        config != null ? JSON.stringify(config) : null,
      ]
    );

    const [rows] = await pool.query('SELECT * FROM project_integrations WHERE id = ?', [result.insertId]);
    res.status(201).json(sanitize(rows[0]));
  } catch (err) {
    next(err);
  }
});

// PUT /api/integrations/:id - update an integration
router.put('/integrations/:id', async (req, res, next) => {
  try {
    const { name, platform, base_url, username, password, api_key, verify_ssl, auto_sync, sync_interval_minutes, config } =
      req.body || {};

    if (platform !== undefined && !PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: `platform must be one of: ${PLATFORMS.join(', ')}` });
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'name is required' });
      updates.push('name = ?');
      values.push(name.trim());
    }
    if (platform !== undefined) {
      updates.push('platform = ?');
      values.push(platform);
    }
    if (base_url !== undefined) {
      if (!base_url.trim()) return res.status(400).json({ error: 'base_url is required' });
      updates.push('base_url = ?');
      values.push(base_url.trim());
    }
    if (username !== undefined) {
      updates.push('username = ?');
      values.push(username || null);
    }
    if (password !== undefined) {
      if (password) {
        updates.push('password = TO_BASE64(AES_ENCRYPT(?, ?))');
        values.push(password, SECRET);
      } else {
        updates.push('password = NULL');
      }
    }
    if (api_key !== undefined) {
      if (api_key) {
        updates.push('api_key = TO_BASE64(AES_ENCRYPT(?, ?))');
        values.push(api_key, SECRET);
      } else {
        updates.push('api_key = NULL');
      }
    }
    if (verify_ssl !== undefined) {
      updates.push('verify_ssl = ?');
      values.push(!!verify_ssl);
    }
    if (auto_sync !== undefined) {
      updates.push('auto_sync = ?');
      values.push(!!auto_sync);
    }
    if (sync_interval_minutes !== undefined) {
      updates.push('sync_interval_minutes = ?');
      values.push(sync_interval_minutes);
    }
    if (config !== undefined) {
      updates.push('config = ?');
      values.push(config != null ? JSON.stringify(config) : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id, req.projectId);
    const [result] = await pool.query(
      `UPDATE project_integrations SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`,
      values
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Integration not found' });

    const [rows] = await pool.query('SELECT * FROM project_integrations WHERE id = ?', [req.params.id]);
    res.json(sanitize(rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/integrations/:id - remove an integration
router.delete('/integrations/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM project_integrations WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Integration not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/integrations/:id/test - test the connection, persisting status
router.post('/integrations/:id/test', async (req, res, next) => {
  try {
    const row = await getDecrypted(req.params.id);
    if (!row || row.project_id !== req.projectId) return res.status(404).json({ error: 'Integration not found' });

    const result = await testIntegration(row);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/integrations/:id/sync - trigger a sync, returning an import summary
router.post('/integrations/:id/sync', async (req, res, next) => {
  try {
    const row = await getDecrypted(req.params.id);
    if (!row || row.project_id !== req.projectId) return res.status(404).json({ error: 'Integration not found' });

    const result = await syncIntegration(row);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
