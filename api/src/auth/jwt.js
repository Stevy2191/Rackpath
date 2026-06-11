const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.RACKPATH_JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('RACKPATH_JWT_SECRET environment variable is required');
}

const TOKEN_TTL = '8h';
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const COOKIE_NAME = 'rackpath_token';

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { signToken, verifyToken, COOKIE_NAME, TOKEN_TTL_MS };
