const express = require('express');
const axios = require('axios');

const router = express.Router();

const SCANNER_URL = process.env.SCANNER_URL || 'http://rackpath-scanner:5001';

// Simple proxies to the scanner's synchronous diagnostic endpoints - no DB
// involved, just forward the body and relay the scanner's response/error.
async function proxyToScanner(req, res, scannerPath, timeout = 60000) {
  try {
    const response = await axios.post(`${SCANNER_URL}${scannerPath}`, req.body, { timeout });
    res.json(response.data);
  } catch (err) {
    if (err.response) {
      res.status(err.response.status).json(err.response.data);
    } else {
      res.status(502).json({ error: 'Scanner service unavailable' });
    }
  }
}

router.post('/ping', (req, res) => proxyToScanner(req, res, '/tools/ping'));
router.post('/traceroute', (req, res) => proxyToScanner(req, res, '/tools/traceroute'));
router.post('/dns', (req, res) => proxyToScanner(req, res, '/tools/dns'));
router.post('/snmp-stats', (req, res) => proxyToScanner(req, res, '/tools/snmp-stats', 90000));

// api.macvendors.com doesn't send CORS headers, so the browser can't call it
// directly - proxy it server-side instead. Still stateless, no DB involved.
router.post('/mac-lookup', async (req, res) => {
  const mac = req.body?.mac;
  if (!mac) {
    res.status(400).json({ error: 'mac is required' });
    return;
  }
  try {
    const response = await axios.get(`https://api.macvendors.com/${encodeURIComponent(mac)}`, { timeout: 10000 });
    res.json({ vendor: response.data });
  } catch (err) {
    if (err.response?.status === 404) {
      res.json({ vendor: 'Unknown vendor' });
    } else {
      res.status(502).json({ error: 'Lookup failed' });
    }
  }
});

module.exports = router;
