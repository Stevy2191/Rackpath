const pool = require('./pool');
const { encryptSecret, isEncrypted } = require('../utils/secrets');

// Every column that holds a credential. Each must be wide enough for the
// encrypted form (see migration 0065).
const SECRET_COLUMNS = [
  { table: 'project_credential_macros', column: 'community_string' },
  { table: 'project_credential_macros', column: 'password' },
  { table: 'project_credential_macros', column: 'auth_password' },
  { table: 'project_credential_macros', column: 'priv_password' },
  { table: 'project_cameras', column: 'stream_password' },
  { table: 'scan_jobs', column: 'snmp_community' },
  // Integrations used MariaDB AES_ENCRYPT keyed with the JWT secret.
  { table: 'project_integrations', column: 'password', legacyMysqlAes: true },
  { table: 'project_integrations', column: 'api_key', legacyMysqlAes: true },
];

// Runs at startup after migrations: encrypts any credential still stored in
// plain text (or in the old integration format). Idempotent - rows already in
// the v1 format are skipped.
async function encryptStoredSecrets() {
  const legacyKey = process.env.RACKPATH_JWT_SECRET;
  for (const { table, column, legacyMysqlAes } of SECRET_COLUMNS) {
    const select = legacyMysqlAes
      ? `SELECT id, ${column} AS stored, CAST(AES_DECRYPT(FROM_BASE64(${column}), ?) AS CHAR) AS legacy_plain
         FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT LIKE 'v1:%'`
      : `SELECT id, ${column} AS stored FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT LIKE 'v1:%'`;
    // eslint-disable-next-line no-await-in-loop
    const [rows] = await pool.query(select, legacyMysqlAes ? [legacyKey] : []);
    let cleared = 0;
    for (const row of rows) {
      if (isEncrypted(row.stored)) continue;
      const plaintext = legacyMysqlAes ? row.legacy_plain : row.stored;
      if (legacyMysqlAes && plaintext === null) cleared += 1;
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [encryptSecret(plaintext), row.id]);
    }
    if (rows.length > 0) {
      console.log(`Encrypted ${rows.length - cleared} stored value(s) in ${table}.${column}`);
    }
    if (cleared > 0) {
      console.warn(
        `Cleared ${cleared} value(s) in ${table}.${column} that could not be decrypted with the current JWT secret; re-enter them in the UI.`
      );
    }
  }
}

module.exports = { encryptStoredSecrets };
