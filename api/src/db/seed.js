require('dotenv').config();

const bcrypt = require('bcryptjs');
const pool = require('./pool');

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'rackpath';

async function seed() {
  const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [ADMIN_USERNAME]);

  if (rows.length > 0) {
    console.log(`User '${ADMIN_USERNAME}' already exists, skipping.`);
    return;
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await pool.query(
    'INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, 1)',
    [ADMIN_USERNAME, passwordHash]
  );

  console.log(`Created default user '${ADMIN_USERNAME}' (password change required on first login).`);
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
