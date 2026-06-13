// Shared logic for testing/syncing an integration, used by both the
// integrations routes and the background auto-sync loop.

const pool = require('../db/pool');
const adapters = require('./index');

const SECRET = process.env.RACKPATH_JWT_SECRET;

// Fetches an integration row with its credentials decrypted via the
// server-side AES secret. Returns undefined if the row doesn't exist.
async function getDecrypted(integrationId) {
  const [rows] = await pool.query(
    `SELECT *,
            CAST(AES_DECRYPT(FROM_BASE64(password), ?) AS CHAR) AS password_plain,
            CAST(AES_DECRYPT(FROM_BASE64(api_key), ?) AS CHAR) AS api_key_plain
     FROM project_integrations WHERE id = ?`,
    [SECRET, SECRET, integrationId]
  );
  return rows[0];
}

function buildConfig(row) {
  return {
    id: row.id,
    base_url: row.base_url,
    username: row.username,
    password: row.password_plain,
    api_key: row.api_key_plain,
    verify_ssl: !!row.verify_ssl,
    config: row.config || null,
  };
}

async function recordResult(row, result, { touchLastSynced }) {
  if (touchLastSynced) {
    await pool.query('UPDATE project_integrations SET last_synced_at = NOW(), status = ?, status_message = ? WHERE id = ?', [
      result.status === 'failed' ? 'error' : 'connected',
      result.message || null,
      row.id,
    ]);
    await pool.query(
      `INSERT INTO integration_sync_log (integration_id, devices_imported, vlans_imported, status, message)
       VALUES (?, ?, ?, ?, ?)`,
      [row.id, result.devices_imported, result.vlans_imported, result.status, result.message || null]
    );
  } else {
    await pool.query('UPDATE project_integrations SET status = ?, status_message = ? WHERE id = ?', [
      result.success ? 'connected' : 'error',
      result.success ? null : result.message || 'Connection failed',
      row.id,
    ]);
  }
}

// Runs testConnection for the given (decrypted) integration row and persists
// the resulting status/status_message.
async function testIntegration(row) {
  const adapter = adapters[row.platform];
  if (!adapter) {
    const result = { success: false, message: `Unknown platform: ${row.platform}` };
    await recordResult(row, result, { touchLastSynced: false });
    return result;
  }

  const result = await adapter.testConnection(buildConfig(row));
  await recordResult(row, result, { touchLastSynced: false });
  return result;
}

// Runs syncData for the given (decrypted) integration row, logs the run to
// integration_sync_log, and persists last_synced_at/status.
async function syncIntegration(row) {
  const adapter = adapters[row.platform];
  let result;

  if (!adapter) {
    result = { devices_imported: 0, vlans_imported: 0, status: 'failed', message: `Unknown platform: ${row.platform}` };
  } else {
    try {
      result = await adapter.syncData(buildConfig(row), row.project_id, pool);
    } catch (err) {
      result = { devices_imported: 0, vlans_imported: 0, status: 'failed', message: err.message };
    }
  }

  await recordResult(row, result, { touchLastSynced: true });
  return result;
}

module.exports = { getDecrypted, testIntegration, syncIntegration };
