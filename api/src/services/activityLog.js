const pool = require('../db/pool');

// Records an entry in the recent-activity feed shown on the Site Overview
// Dashboard. Logging failures are swallowed (and logged) so they never break
// the request that triggered them.
async function logActivity(projectId, userId, action, details = null) {
  try {
    await pool.query(
      'INSERT INTO project_activity_log (project_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [projectId, userId, action, details || null]
    );
  } catch (err) {
    console.error('[activityLog] failed to log activity:', err);
  }
}

module.exports = { logActivity };
