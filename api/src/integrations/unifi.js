// Adapter for Ubiquiti UniFi Network controllers — both UniFi OS (UDM /
// Cloud Gateway, API behind /proxy/network) and the legacy standalone
// controller (API at the root).

const axios = require('axios');
const https = require('https');
const { upsertDevice, upsertVlan } = require('./helpers');

const UNIFI_TYPE_MAP = {
  ugw: 'router',
  usg: 'router',
  udm: 'router',
  uxg: 'router',
  usw: 'switch',
  uap: 'ap',
};

function makeClient(config) {
  return axios.create({
    baseURL: config.base_url.replace(/\/+$/, ''),
    httpsAgent: new https.Agent({ rejectUnauthorized: config.verify_ssl !== false }),
    validateStatus: () => true,
    timeout: 10000,
  });
}

// Logs in via the UniFi OS endpoint first, falling back to the legacy
// controller login. Returns an authenticated session (cookie + optional CSRF
// token) and whether the proxy prefix is needed for subsequent API calls.
async function login(config) {
  const http = makeClient(config);
  const credentials = { username: config.username, password: config.password };

  let res = await http.post('/api/auth/login', credentials);
  let isUnifiOS = true;

  if (res.status >= 400) {
    isUnifiOS = false;
    res = await http.post('/api/login', credentials);
  }

  if (res.status >= 400) {
    const message = res.data?.meta?.msg || res.data?.message || `HTTP ${res.status}`;
    throw new Error(`UniFi login failed: ${message}`);
  }

  const setCookie = res.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const csrfToken = res.headers['x-csrf-token'];

  return { http, cookie, csrfToken, isUnifiOS };
}

function authHeaders(session) {
  const headers = { Cookie: session.cookie };
  if (session.csrfToken) headers['X-CSRF-Token'] = session.csrfToken;
  return headers;
}

function apiPrefix(session) {
  return session.isUnifiOS ? '/proxy/network' : '';
}

async function testConnection(config) {
  try {
    const session = await login(config);
    const res = await session.http.get(`${apiPrefix(session)}/api/s/default/self`, {
      headers: authHeaders(session),
    });
    if (res.status >= 400) {
      return { success: false, message: `Connected but request failed (HTTP ${res.status})` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function mapDeviceType(type) {
  return UNIFI_TYPE_MAP[(type || '').toLowerCase()] || type || null;
}

async function syncData(config, projectId, db) {
  const session = await login(config);
  const headers = authHeaders(session);
  const prefix = apiPrefix(session);

  let devicesImported = 0;
  let vlansImported = 0;
  const errors = [];

  try {
    const res = await session.http.get(`${prefix}/api/s/default/stat/device`, { headers });
    if (res.status >= 400) throw new Error(`Failed to fetch devices (HTTP ${res.status})`);
    const devices = res.data?.data || [];

    for (const dev of devices) {
      const ok = await upsertDevice(db, projectId, config.id, {
        hostname: dev.name || dev.model || dev.mac,
        ip: dev.ip || null,
        mac: dev.mac || null,
        type: mapDeviceType(dev.type),
        model: dev.model || null,
        serial_number: dev.serial || dev.mac || null,
        status: dev.state === 1 ? 'up' : 'down',
      });
      if (ok) devicesImported += 1;
    }
  } catch (err) {
    errors.push(`devices: ${err.message}`);
  }

  try {
    const res = await session.http.get(`${prefix}/api/s/default/rest/networkconf`, { headers });
    if (res.status >= 400) throw new Error(`Failed to fetch networks (HTTP ${res.status})`);
    const networks = res.data?.data || [];

    for (const net of networks) {
      if (net.vlan == null) continue;
      const ok = await upsertVlan(db, projectId, {
        vlan_id: net.vlan,
        name: net.name || `VLAN ${net.vlan}`,
        subnet: net.ip_subnet || null,
      });
      if (ok) vlansImported += 1;
    }
  } catch (err) {
    errors.push(`vlans: ${err.message}`);
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
