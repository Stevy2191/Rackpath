const mysql = require('mysql2/promise');
const dbConfig = require('./config');

const pool = mysql.createPool({
  ...dbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true,
});

module.exports = pool;
