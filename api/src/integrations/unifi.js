// Adapter for Ubiquiti UniFi Network controllers — supports both UniFi OS API
// key (Bearer token, UniFi OS 4.x+) and legacy cookie-based username/password
// login for older standalone controllers. Works against both a local
// controller IP (e.g. https://192.168.1.1, UDM/UDM-SE direct) and
// https://unifi.ui.com (cloud-managed).
//
// UniFi's API layout varies a lot between controller versions, so most
// endpoints are tried in a fallback order and every request/response is
// logged to make it easy to see exactly what a given controller returns.

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

function bodySnippet(data) {
  let str;
  try {
    str = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    str = String(data);
  }
  return (str || '').slice(0, 500);
}

function logResponse(url, res) {
  console.log(`[unifi] GET ${url} -> HTTP ${res.status}`);
  console.log(`[unifi] response body (first 500 chars): ${bodySnippet(res.data)}`);
}

function logError(url, err) {
  console.log(`[unifi] request to ${url} failed: ${err.message}`);
  if (err.response) {
    console.log(`[unifi]   error response status: ${err.response.status}`);
    console.log(`[unifi]   error response data: ${bodySnippet(err.response.data)}`);
  }
}

// Tries each path in order against `http`, logging the URL, status code, and
// a snippet of the body for each attempt. Returns the first response with a
// non-error status, or null if none succeeded.
async function tryEndpoints(http, headers, paths) {
  for (const path of paths) {
    const url = `${http.defaults.baseURL}${path}`;
    try {
      const res = await http.get(path, { headers });
      logResponse(url, res);
      if (res.status < 400) {
        return { path, url, res };
      }
    } catch (err) {
      logError(url, err);
    }
  }
  return null;
}

// Logs in via the UniFi OS endpoint first, falling back to the legacy
// controller login. Returns the cookie/CSRF headers for subsequent requests.
async function cookieLogin(http, config) {
  const credentials = { username: config.username, password: config.password };

  let url = `${http.defaults.baseURL}/api/auth/login`;
  let res;
  try {
    res = await http.post('/api/auth/login', credentials);
    logResponse(url, res);
  } catch (err) {
    logError(url, err);
    throw err;
  }

  if (res.status >= 400) {
    url = `${http.defaults.baseURL}/api/login`;
    try {
      res = await http.post('/api/login', credentials);
      logResponse(url, res);
    } catch (err) {
      logError(url, err);
      throw err;
    }
  }

  if (res.status >= 400) {
    const message = res.data?.meta?.msg || res.data?.message || `HTTP ${res.status}`;
    throw new Error(`UniFi login failed: ${message}`);
  }

  const setCookie = res.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const csrfToken = res.headers['x-csrf-token'];

  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  return headers;
}

// Authenticates against the controller using whichever credentials are
// configured. An API key (Bearer token) takes priority and works against
// both local-IP and cloud (unifi.ui.com) controllers; username/password
// falls back to a cookie-based session for legacy/older controllers.
async function authenticate(config) {
  const http = makeClient(config);

  if (config.api_key) {
    return {
      http,
      headers: { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json' },
    };
  }

  const headers = await cookieLogin(http, config);
  return { http, headers };
}

const DEVICE_ENDPOINTS = [
  '/proxy/network/v2/api/site/default/device',
  '/proxy/network/api/s/default/stat/device',
  '/api/s/default/stat/device',
];

const VLAN_ENDPOINTS = ['/proxy/network/api/s/default/rest/networkconf', '/api/s/default/rest/networkconf'];

const SELF_ENDPOINTS = ['/proxy/network/api/s/default/self', '/api/s/default/self'];

async function testConnection(config) {
  try {
    const session = await authenticate(config);
    const paths = config.api_key ? DEVICE_ENDPOINTS : SELF_ENDPOINTS;
    const found = await tryEndpoints(session.http, session.headers, paths);
    if (!found) {
      return { success: false, message: 'No endpoint responded successfully — see API logs for details' };
    }
    return { success: true };
  } catch (err) {
    console.log(`[unifi] testConnection error: ${err.message}`);
    return { success: false, message: err.message };
  }
}

function mapDeviceType(type) {
  return UNIFI_TYPE_MAP[(type || '').toLowerCase()] || 'unknown';
}

// UniFi API responses come back as either a bare array or `{ data: [...] }`
// (both v1 and v2 wrap the device/network list in `data`).
function extractList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.network_devices)) return data.network_devices;
  return [];
}

// v1 reports device state as a numeric `state` (1 = online). v2 reports a
// `connectionState`/`status` string instead. Returns null if neither field
// is present so callers can leave the device's status untouched.
function isDeviceUp(dev) {
  if (typeof dev.state === 'number') return dev.state === 1;
  if (dev.connectionState) return dev.connectionState === 'CONNECTED';
  if (dev.status) return dev.status === 'online' || dev.status === 'CONNECTED';
  return null;
}

async function syncData(config, projectId, db) {
  const session = await authenticate(config);
  const { http, headers } = session;

  let devicesImported = 0;
  let vlansImported = 0;
  const errors = [];

  try {
    const found = await tryEndpoints(http, headers, DEVICE_ENDPOINTS);
    if (!found) throw new Error('No device endpoint responded successfully');

    const devices = extractList(found.res.data);
    console.log(`[unifi] devices endpoint: ${found.path} (${devices.length} device(s))`);
    if (devices.length > 0) {
      console.log(`[unifi] first device keys: ${Object.keys(devices[0]).join(', ')}`);
    }

    for (const dev of devices) {
      const up = isDeviceUp(dev);
      const ok = await upsertDevice(db, projectId, config.id, {
        hostname: dev.name || dev.hostname || dev.model || dev.mac || dev.macAddress,
        ip: dev.ip || dev.ipAddress || null,
        mac: dev.mac || dev.macAddress || null,
        type: mapDeviceType(dev.type),
        model: dev.model || dev.productLine || null,
        serial_number: dev.serial || dev.serialNumber || dev.mac || dev.macAddress || null,
        status: up == null ? null : up ? 'up' : 'down',
      });
      if (ok) devicesImported += 1;
    }
  } catch (err) {
    console.log(`[unifi] device sync error: ${err.message}`);
    if (err.response) {
      console.log(`[unifi]   error response status: ${err.response.status}`);
      console.log(`[unifi]   error response data: ${bodySnippet(err.response.data)}`);
    }
    errors.push(`devices: ${err.message}`);
  }

  try {
    const found = await tryEndpoints(http, headers, VLAN_ENDPOINTS);
    if (!found) throw new Error('No VLAN endpoint responded successfully');

    const networks = extractList(found.res.data);
    console.log(`[unifi] vlans endpoint: ${found.path} (${networks.length} network(s))`);
    if (networks.length > 0) {
      console.log(`[unifi] first network keys: ${Object.keys(networks[0]).join(', ')}`);
    }

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
    console.log(`[unifi] vlan sync error: ${err.message}`);
    if (err.response) {
      console.log(`[unifi]   error response status: ${err.response.status}`);
      console.log(`[unifi]   error response data: ${bodySnippet(err.response.data)}`);
    }
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
