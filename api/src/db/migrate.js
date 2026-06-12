const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dbConfig = require('./config');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Applies any *.sql files in migrations/ that haven't already been recorded
// in schema_migrations, in filename order. Each file is applied at most once.
async function migrate() {
  const connection = await mysql.createConnection({ ...dbConfig, multipleStatements: true });

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
          id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          name        VARCHAR(255)    NOT NULL,
          applied_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_schema_migrations_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [appliedRows] = await connection.query('SELECT name FROM schema_migrations');
    const applied = new Set(appliedRows.map((row) => row.name));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;

      console.log(`Applying migration ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await connection.query(sql);
      await connection.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    }
  } finally {
    await connection.end();
  }
}

module.exports = { migrate };
