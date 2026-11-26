require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const authRouter = require('./routes/auth');
const projectsRouter = require('./routes/projects');
const devicesRouter = require('./routes/devices');
const portsRouter = require('./routes/ports');
const racksRouter = require('./routes/racks');
const rackSlotsRouter = require('./routes/rackSlots');
const rackCustomDevicesRouter = require('./routes/rackCustomDevices');
const userCatalogEntriesRouter = require('./routes/userCatalogEntries');
const topologyRouter = require('./routes/topology');
const topologiesRouter = require('./routes/topologies');
const scanRouter = require('./routes/scan');
const vlansRouter = require('./routes/vlans');
const integrationsRouter = require('./routes/integrations');
const deviceTagsRouter = require('./routes/deviceTags');
const macrosRouter = require('./routes/macros');
const camerasRouter = require('./routes/cameras');
const accessDevicesRouter = require('./routes/access-devices');
const toolsRouter = require('./routes/tools');
const locationsRouter = require('./routes/locations');
const { requireAuth } = require('./auth/middleware');
const { projectScope } = require('./middleware/projectScope');
const { migrate } = require('./db/migrate');
const { startAutoSync } = require('./integrations/autoSync');

const app = express();
const PORT = process.env.API_PORT || 3000;

// Requests arrive through the frontend's nginx on the compose network, so
// trust X-Forwarded-For from private addresses to get the real client IP
// (used by the login rate limiter).
app.set('trust proxy', 'loopback, uniquelocal');
app.disable('x-powered-by');

app.use(helmet({
  // The API serves JSON and uploaded images, never pages, so lock it down.
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  // Uploaded images are loaded by the UI with <img>; keep them same-site.
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

// The UI is served same-origin by rackpath-frontend, so CORS is off unless
// CORS_ORIGINS lists specific origins (e.g. http://localhost:3000 for frontend
// development). Never reflect arbitrary origins with credentials.
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
if (corsOrigins.length > 0) {
  app.use(cors({ origin: corsOrigins, credentials: true }));
}
app.use(cookieParser());
app.use(express.json());
app.use(morgan('combined'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use(requireAuth);
app.use(projectScope);

app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/ports', portsRouter);
app.use('/api/racks', racksRouter);
app.use('/api/rack-slots', rackSlotsRouter);
app.use('/api/rack-custom-devices', rackCustomDevicesRouter);
app.use('/api/user-catalog-entries', userCatalogEntriesRouter);
app.use('/api/topology', topologyRouter);
app.use('/api', topologiesRouter);
app.use('/api/scans', scanRouter);
app.use('/api', vlansRouter);
app.use('/api', integrationsRouter);
app.use('/api', deviceTagsRouter);
app.use('/api', macrosRouter);
app.use('/api', camerasRouter);
app.use('/api', accessDevicesRouter);
app.use('/api/tools', toolsRouter);
app.use('/api', locationsRouter);

// Fallback error handler
// Client errors (4xx) keep their message; server errors are logged but not
// echoed back, since they can carry SQL or internal details.
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    return res.status(status).json({ error: 'Internal server error' });
  }
  return res.status(status).json({ error: err.expose === false ? 'Bad request' : err.message || 'Bad request' });
});

migrate()
  .catch((err) => console.error('Migration failed:', err))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Rackpath API listening on port ${PORT}`);
    });
    startAutoSync();
  });
