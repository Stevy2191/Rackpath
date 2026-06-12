module.exports = {
  host: process.env.DB_HOST || 'rackpath-db',
  port: Number(process.env.DB_PORT_INTERNAL || 3306),
  user: process.env.DB_USER || 'rackpath',
  password: process.env.DB_PASSWORD || 'rackpath',
  database: process.env.DB_NAME || 'rackpath',
};
