const { verifyToken } = require('./jwt');

const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login']);

// Callbacks the scanner service posts to - the scanner has no user
// session/JWT, so these endpoints are left unauthenticated.
const SCAN_RESULTS_PATH = /^\/api\/scans\/\d+\/results$/;
const SCAN_PROGRESS_PATH = /^\/api\/scans\/\d+\/progress$/;

// Custom topology icons are rendered via <img> tags, which can't send an
// Authorization header, so the raw file route is left unauthenticated.
const TOPOLOGY_ICON_FILE_PATH = /^\/api\/topology\/icons\/file\/[^/]+$/;

function isPublicPath(path) {
  return (
    PUBLIC_PATHS.has(path) ||
    SCAN_RESULTS_PATH.test(path) ||
    SCAN_PROGRESS_PATH.test(path) ||
    TOPOLOGY_ICON_FILE_PATH.test(path)
  );
}

function requireAuth(req, res, next) {
  if (isPublicPath(req.path)) return next();

  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
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
