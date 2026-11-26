const express = require('express');
const axios = require('axios');
const pool = require('../db/pool');
const { scannerHeaders } = require('../utils/scannerAuth');
const { decryptMacro } = require('../utils/credentialMacros');

const router = express.Router();

const SCANNER_URL = process.env.SCANNER_URL || 'http://rackpath-scanner:5001';

// Simple proxies to the scanner's synchronous diagnostic endpoints - no DB
// involved, just forward the body and relay the scanner's response/error.
async function proxyToScanner(req, res, scannerPath, timeout = 60000, body = req.body) {
  try {
    const response = await axios.post(`${SCANNER_URL}${scannerPath}`, body, { timeout, headers: scannerHeaders() });
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
// SNMP stats can use a credential macro by id: the browser never holds the
// macro's secrets, so they are filled in here for any field left blank.
router.post('/snmp-stats', async (req, res, next) => {
  try {
    const body = { ...(req.body || {}) };
    const macroId = body.macro_id;
    delete body.macro_id;
    if (macroId) {
      const [rows] = await pool.query(
        "SELECT * FROM project_credential_macros WHERE id = ? AND project_id = ? AND type LIKE 'snmp%'",
        [macroId, req.projectId]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Credential macro not found' });
      const macro = decryptMacro(rows[0]);
      if (macro.type === 'snmp_v3') {
        body.v3_user = body.v3_user || macro.username || '';
        body.v3_auth_password = body.v3_auth_password || macro.auth_password || '';
        body.v3_priv_password = body.v3_priv_password || macro.priv_password || '';
      } else {
        body.community = body.community || macro.community_string || 'public';
      }
    }
    return proxyToScanner(req, res, '/tools/snmp-stats', 90000, body);
  } catch (err) {
    return next(err);
  }
});

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
