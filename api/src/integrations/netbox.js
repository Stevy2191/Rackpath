// Adapter for NetBox, using its REST API authenticated with an API token
// (Authorization: Token <api_key> header).

const axios = require('axios');
const https = require('https');
const { upsertDevice, upsertVlan } = require('./helpers');

const MAX_PAGES = 20;

function makeClient(config) {
  return axios.create({
    baseURL: config.base_url.replace(/\/+$/, ''),
    httpsAgent: new https.Agent({ rejectUnauthorized: config.verify_ssl !== false }),
    headers: { Authorization: `Token ${config.api_key}` },
    timeout: 10000,
  });
}

// NetBox list endpoints are paginated via a `next` URL; follow it until
// exhausted (capped at MAX_PAGES as a safety net).
async function fetchAllPages(http, path) {
  const results = [];
  let url = path;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const res = await http.get(url);
    results.push(...(res.data?.results || []));
    url = res.data?.next || null;
    if (url) {
      // `next` is an absolute URL; strip the baseURL so axios re-applies it.
      url = url.replace(http.defaults.baseURL, '');
    }
  }
  return results;
}

async function testConnection(config) {
  try {
    const http = makeClient(config);
    const res = await http.get('/api/dcim/devices/', { params: { limit: 1 } });
    if (res.status >= 400) {
      return { success: false, message: `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: err.response?.data?.detail || err.message };
  }
}

const STATUS_MAP = { active: 'up', offline: 'down', failed: 'down', decommissioning: 'down' };

async function syncData(config, projectId, db) {
  const http = makeClient(config);

  let devicesImported = 0;
  let vlansImported = 0;
  const errors = [];

  try {
    const devices = await fetchAllPages(http, '/api/dcim/devices/');

    for (const dev of devices) {
      const ip = dev.primary_ip4?.address ? dev.primary_ip4.address.split('/')[0] : null;
      const ok = await upsertDevice(db, projectId, config.id, {
        hostname: dev.name,
        ip,
        type: dev.device_role?.slug || dev.device_type?.slug || null,
        model: dev.device_type?.model || null,
        serial_number: dev.serial || null,
        status: STATUS_MAP[dev.status?.value] || 'unknown',
      });
      if (ok) devicesImported += 1;
    }
  } catch (err) {
    errors.push(`devices: ${err.response?.data?.detail || err.message}`);
  }

  try {
    const vlans = await fetchAllPages(http, '/api/ipam/vlans/');

    for (const vlan of vlans) {
      const ok = await upsertVlan(db, projectId, {
        vlan_id: vlan.vid,
        name: vlan.name || `VLAN ${vlan.vid}`,
        subnet: null,
      });
      if (ok) vlansImported += 1;
    }
  } catch (err) {
    errors.push(`vlans: ${err.response?.data?.detail || err.message}`);
  }

  if (errors.length === 0) {
    return { devices_imported: devicesImported, vlans_imported: vlansImported, status: 'success', message: null };
  }

  return {
    devices_imported: devicesImported,
    vlans_imported: vlansImported,
    status: devicesImported || vlansImported ? 'partial' : 'failed',
    message: errors.join('; '),
  };
}

module.exports = { testConnection, syncData };
