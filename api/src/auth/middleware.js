const { verifyToken, COOKIE_NAME } = require('./jwt');

const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login']);

// Callbacks the scanner service posts to - the scanner has no user
// session/JWT, so these endpoints are left unauthenticated.
const SCAN_RESULTS_PATH = /^\/api\/scans\/\d+\/results$/;
const SCAN_PROGRESS_PATH = /^\/api\/scans\/\d+\/progress$/;
const SCAN_HOST_PATH = /^\/api\/scans\/\d+\/host$/;

// Custom topology icons are rendered via <img> tags, which can't send an
// Authorization header, so the raw file route is left unauthenticated.
const TOPOLOGY_ICON_FILE_PATH = /^\/api\/topology\/icons\/file\/[^/]+$/;

// Same reasoning as TOPOLOGY_ICON_FILE_PATH, for uploaded rack device faceplates.
const RACK_DEVICE_IMAGE_FILE_PATH = /^\/api\/rack-custom-devices\/images\/file\/[^/]+$/;
const RACK_SLOT_IMAGE_FILE_PATH = /^\/api\/rack-slots\/images\/file\/[^/]+$/;

function isPublicPath(path) {
  return (
    PUBLIC_PATHS.has(path) ||
    SCAN_RESULTS_PATH.test(path) ||
    SCAN_PROGRESS_PATH.test(path) ||
    SCAN_HOST_PATH.test(path) ||
    TOPOLOGY_ICON_FILE_PATH.test(path) ||
    RACK_DEVICE_IMAGE_FILE_PATH.test(path) ||
    RACK_SLOT_IMAGE_FILE_PATH.test(path)
  );
}

function requireAuth(req, res, next) {
  if (isPublicPath(req.path)) return next();

  // The session JWT lives in an httpOnly cookie. EventSource (used by the scan
  // /stream endpoint) sends it automatically on same-origin requests, so the
  // SSE stream is JWT-protected just like every other route.
  const token = req.cookies && req.cookies[COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, username: payload.username };
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };
