const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pool = require('../db/pool');

const router = express.Router();

const IMAGE_UPLOAD_DIR = path.join('/uploads', 'rack-devices');
fs.mkdirSync(IMAGE_UPLOAD_DIR, { recursive: true });

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMAGE_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPEG, WEBP, and SVG files are allowed'));
    }
  },
});

// GET /api/rack-custom-devices - list custom catalog devices for the project
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM rack_custom_devices WHERE project_id = ? ORDER BY created_at',
      [req.projectId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/rack-custom-devices - create a custom catalog device (multipart/form-data, field "image")
router.post('/', (req, res, next) => {
  imageUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, async (req, res, next) => {
  try {
    const {
      name, vendor, type, u_size,
      power_draw_w, outlet_count, outlet_type, power_capacity, power_capacity_unit, input_voltage,
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const imageUrl = req.file ? `/api/rack-custom-devices/images/file/${req.file.filename}` : null;

    const [result] = await pool.query(
      `INSERT INTO rack_custom_devices
         (project_id, name, vendor, type, u_size, image_url,
          power_draw_w, outlet_count, outlet_type, power_capacity, power_capacity_unit, input_voltage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.projectId, name, vendor || null, type || 'other', u_size || 1, imageUrl,
        power_draw_w || null, outlet_count || null, outlet_type || null,
        power_capacity || null, power_capacity_unit || 'W', input_voltage || null,
      ]
    );
    const [rows] = await pool.query('SELECT * FROM rack_custom_devices WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/rack-custom-devices/images/file/:filename - serve an uploaded
// faceplate image. Left unauthenticated (see auth middleware) since <img>
// tags can't send a Bearer token.
router.get('/images/file/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  res.sendFile(path.join(IMAGE_UPLOAD_DIR, filename), (err) => {
    if (err) res.status(404).end();
  });
});

// DELETE /api/rack-custom-devices/:id - remove a custom catalog device
router.delete('/:id', async (req, res, next) => {
  try {
    const [existing] = await pool.query(
      'SELECT image_url FROM rack_custom_devices WHERE id = ? AND project_id = ?',
      [req.params.id, req.projectId]
    );
    const [result] = await pool.query('DELETE FROM rack_custom_devices WHERE id = ? AND project_id = ?', [
      req.params.id,
      req.projectId,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Custom device not found' });

    const imageUrl = existing[0]?.image_url;
    if (imageUrl) {
      const filename = path.basename(imageUrl);
      fs.unlink(path.join(IMAGE_UPLOAD_DIR, filename), () => {});
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
