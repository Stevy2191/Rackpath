const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.RACKPATH_JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('RACKPATH_JWT_SECRET environment variable is required');
}

const TOKEN_TTL = '8h';

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { signToken, verifyToken };
