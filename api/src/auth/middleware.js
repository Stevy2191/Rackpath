const pool = require('../db/pool');
const { verifyToken, passwordFingerprint, COOKIE_NAME } = require('./jwt');

const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login']);

// Custom topology icons are rendered via <img> tags, which can't send an
// Authorization header, so the raw file route is left unauthenticated.
const TOPOLOGY_ICON_FILE_PATH = /^\/api\/topology\/icons\/file\/[^/]+$/;

// Same reasoning as TOPOLOGY_ICON_FILE_PATH, for uploaded rack device faceplates.
const RACK_DEVICE_IMAGE_FILE_PATH = /^\/api\/rack-custom-devices\/images\/file\/[^/]+$/;
const RACK_SLOT_IMAGE_FILE_PATH = /^\/api\/rack-slots\/images\/file\/[^/]+$/;

function isPublicPath(path) {
  return (
    PUBLIC_PATHS.has(path) ||
    TOPOLOGY_ICON_FILE_PATH.test(path) ||
    RACK_DEVICE_IMAGE_FILE_PATH.test(path) ||
    RACK_SLOT_IMAGE_FILE_PATH.test(path)
  );
}

// While a user still has to change their password (e.g. the seeded admin),
// only these routes work, so the default credentials can't be used to drive
// the API directly.
const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/change-password',
  '/api/auth/logout',
]);

async function requireAuth(req, res, next) {
  if (isPublicPath(req.path)) return next();

  // The session JWT lives in an httpOnly cookie.
  const token = req.cookies && req.cookies[COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT id, username, password_hash, must_change_password FROM users WHERE id = ?',
      [payload.sub]
    );
    const user = rows[0];
    // Reject tokens for deleted users and tokens issued before a password change.
    if (!user || payload.pwf !== passwordFingerprint(user.password_hash)) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (user.must_change_password && !PASSWORD_CHANGE_ALLOWED_PATHS.has(req.path)) {
      return res.status(403).json({
        error: 'You must change your password before continuing',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
    req.user = { id: user.id, username: user.username };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth };
