const path = require('path');
const multer = require('multer');

// Uploaded images are stored with an extension chosen from the validated
// mimetype, never from the client's filename, and served back with headers
// that stop the browser from running anything inside them (an SVG with a
// <script>, or a file renamed to .html).
const IMAGE_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};
const SERVABLE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

const UPLOAD_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

function imageUpload(dir, allowedMimetypes, errorMessage) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${IMAGE_EXTENSIONS[file.mimetype]}`);
    },
  });
  return multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (allowedMimetypes.includes(file.mimetype) && IMAGE_EXTENSIONS[file.mimetype]) {
        cb(null, true);
      } else {
        cb(Object.assign(new Error(errorMessage), { status: 400 }));
      }
    },
  });
}

// Route handler that serves one uploaded image from `dir`.
function serveUploadedImage(dir) {
  return (req, res) => {
    const filename = path.basename(req.params.filename);
    if (!SERVABLE_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
      return res.status(404).end();
    }
    res.set({
      'Content-Security-Policy': UPLOAD_CSP,
      'X-Content-Type-Options': 'nosniff',
    });
    return res.sendFile(path.join(dir, filename), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  };
}

module.exports = { imageUpload, serveUploadedImage };
