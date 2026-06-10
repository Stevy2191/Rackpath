require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const devicesRouter = require('./routes/devices');
const portsRouter = require('./routes/ports');
const racksRouter = require('./routes/racks');
const rackSlotsRouter = require('./routes/rackSlots');
const topologyRouter = require('./routes/topology');
const scanRouter = require('./routes/scan');

const app = express();
const PORT = process.env.API_PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/devices', devicesRouter);
app.use('/api/ports', portsRouter);
app.use('/api/racks', racksRouter);
app.use('/api/rack-slots', rackSlotsRouter);
app.use('/api/topology', topologyRouter);
app.use('/api/scans', scanRouter);

// Fallback error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Rackpath API listening on port ${PORT}`);
});
