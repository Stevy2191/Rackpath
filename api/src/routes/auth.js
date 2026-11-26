const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { signToken, COOKIE_NAME, COOKIE_OPTIONS, TOKEN_TTL_MS } = require('../auth/jwt');
const loginRateLimit = require('../auth/loginRateLimit');

const router = express.Router();

// Compared against when the username doesn't exist, so a login for an
// unknown user takes as long as one with a wrong password.
const DUMMY_HASH = bcrypt.hashSync('rackpath-timing-equaliser', 12);

// POST /api/auth/login - verify credentials and issue a JWT
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const wait = loginRateLimit.retryAfterSeconds(username, req.ip);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];

    const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !valid) {
      loginRateLimit.recordFailure(username, req.ip);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    loginRateLimit.recordSuccess(username);

    const token = signToken(user);
    res.cookie(COOKIE_NAME, token, { ...COOKIE_OPTIONS, maxAge: TOKEN_TTL_MS });
    res.json({
      user: {
        id: user.id,
        username: user.username,
        must_change_password: !!user.must_change_password,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout - clear the session cookie
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
  res.status(204).send();
});

// GET /api/auth/me - return the authenticated user's info
router.get('/me', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, username, must_change_password, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ...user, must_change_password: !!user.must_change_password });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password - change the authenticated user's password
router.post('/change-password', async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (typeof current_password !== 'string' || typeof new_password !== 'string' || !current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (new_password === current_password) {
      return res.status(400).json({ error: 'new_password must be different from the current password' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'new_password must be at least 8 characters' });
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(new_password, 12);
    await pool.query(
      'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
      [passwordHash, user.id]
    );

    // Changing the password invalidates every existing token (see requireAuth),
    // so issue this session a fresh one.
    const token = signToken({ ...user, password_hash: passwordHash });
    res.cookie(COOKIE_NAME, token, { ...COOKIE_OPTIONS, maxAge: TOKEN_TTL_MS });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
