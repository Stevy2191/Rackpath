require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const authRouter = require('./routes/auth');
const projectsRouter = require('./routes/projects');
const devicesRouter = require('./routes/devices');
const portsRouter = require('./routes/ports');
const racksRouter = require('./routes/racks');
const rackSlotsRouter = require('./routes/rackSlots');
const topologyRouter = require('./routes/topology');
const scanRouter = require('./routes/scan');
const vlansRouter = require('./routes/vlans');
const integrationsRouter = require('./routes/integrations');
const deviceTagsRouter = require('./routes/deviceTags');
const macrosRouter = require('./routes/macros');
const camerasRouter = require('./routes/cameras');
const { requireAuth } = require('./auth/middleware');
const { projectScope } = require('./middleware/projectScope');
const { migrate } = require('./db/migrate');
const { startAutoSync } = require('./integrations/autoSync');

const app = express();
const PORT = process.env.API_PORT || 3000;

// `origin: true` reflects the request's Origin header back, which (combined
// with `credentials: true`) is required for browsers to send/receive the
// httpOnly session cookie on cross-origin requests (e.g. local dev where the
// frontend and API run on different ports).
app.use(cors({ origin: true, credentials: true }));
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
app.use('/api/topology', topologyRouter);
app.use('/api/scans', scanRouter);
app.use('/api', vlansRouter);
app.use('/api', integrationsRouter);
app.use('/api', deviceTagsRouter);
app.use('/api', macrosRouter);
app.use('/api', camerasRouter);

// Fallback error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

migrate()
  .catch((err) => console.error('Migration failed:', err))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Rackpath API listening on port ${PORT}`);
    });
    startAutoSync();
  });
