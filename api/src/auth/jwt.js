const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.RACKPATH_JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('RACKPATH_JWT_SECRET environment variable is required');
}

const TOKEN_TTL = '8h';
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const COOKIE_NAME = 'rackpath_token';

// Session cookie settings. Secure is opt-in (COOKIE_SECURE=true) because many
// self-hosted installs are plain HTTP on a LAN, where a Secure cookie would
// never be sent back.
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.COOKIE_SECURE === 'true',
  path: '/',
};

// A short fingerprint of the user's current password hash. Tokens carry it,
// and requireAuth compares it to the stored hash, so changing the password
// invalidates every token issued before the change.
function passwordFingerprint(passwordHash) {
  return crypto
    .createHmac('sha256', JWT_SECRET)
    .update(String(passwordHash || ''))
    .digest('base64url')
    .slice(0, 16);
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, pwf: passwordFingerprint(user.password_hash) },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL, algorithm: 'HS256' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

module.exports = {
  signToken,
  verifyToken,
  passwordFingerprint,
  COOKIE_NAME,
  COOKIE_OPTIONS,
  TOKEN_TTL_MS,
};
