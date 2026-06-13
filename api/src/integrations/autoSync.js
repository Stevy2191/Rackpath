// Background loop that runs syncIntegration() for any integration with
// auto_sync enabled whose last sync is missing or older than its configured
// interval.

const pool = require('../db/pool');
const { getDecrypted, syncIntegration } = require('./service');

const CHECK_INTERVAL_MS = 60 * 1000;

async function runAutoSync() {
  let due;
  try {
    [due] = await pool.query(
      `SELECT id FROM project_integrations
       WHERE auto_sync = TRUE
         AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL sync_interval_minutes MINUTE)`
    );
  } catch (err) {
    console.error('Auto-sync check failed:', err.message);
    return;
  }

  for (const { id } of due) {
    try {
      const integration = await getDecrypted(id);
      if (integration) await syncIntegration(integration);
    } catch (err) {
      console.error(`Auto-sync failed for integration ${id}:`, err.message);
    }
  }
}

function startAutoSync() {
  setInterval(runAutoSync, CHECK_INTERVAL_MS);
}

module.exports = { startAutoSync, runAutoSync };
