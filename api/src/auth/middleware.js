const { verifyToken } = require('./jwt');

const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login']);

// Callback the scanner service posts results to - the scanner has no user
// session/JWT, so this endpoint is left unauthenticated.
const SCAN_RESULTS_PATH = /^\/api\/scans\/\d+\/results$/;

function isPublicPath(path) {
  return PUBLIC_PATHS.has(path) || SCAN_RESULTS_PATH.test(path);
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
