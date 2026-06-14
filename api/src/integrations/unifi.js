// Adapter for Ubiquiti UniFi Network controllers — supports both UniFi OS API
// key (Bearer token, UniFi OS 4.x+) and legacy cookie-based username/password
// login for older standalone controllers.

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
// controller login. Returns the cookie/CSRF headers and whether the proxy
// prefix is needed for subsequent API calls.
async function cookieLogin(http, config) {
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

  const headers = { Cookie: cookie };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  return { headers, isUnifiOS };
}

// Authenticates against the controller using whichever credentials are
// configured. An API key (Bearer token) takes priority and talks to the
// UniFi OS proxy directly; username/password falls back to a cookie-based
// session, which also works against legacy standalone controllers.
async function authenticate(config) {
  const http = makeClient(config);

  if (config.api_key) {
    return {
      http,
      headers: { Authorization: `Bearer ${config.api_key}` },
      prefix: '/proxy/network',
      isUnifiOS: true,
    };
  }

  const { headers, isUnifiOS } = await cookieLogin(http, config);
  return { http, headers, prefix: isUnifiOS ? '/proxy/network' : '', isUnifiOS };
}

async function testConnection(config) {
  try {
    const session = await authenticate(config);
    const path = config.api_key
      ? `${session.prefix}/v2/api/site/default/device`
      : `${session.prefix}/api/s/default/self`;
    const res = await session.http.get(path, { headers: session.headers });
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

// UniFi API responses come back as either a bare array, `{ data: [...] }`
// (v1 REST) or `{ network_devices: [...] }` (v2). Handle all three.
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
  const { http, headers, prefix, isUnifiOS } = session;

  let devicesImported = 0;
  let vlansImported = 0;
  const errors = [];

  try {
    const devicePath = isUnifiOS ? `${prefix}/v2/api/site/default/device` : `${prefix}/api/s/default/stat/device`;
    const res = await http.get(devicePath, { headers });
    if (res.status >= 400) throw new Error(`Failed to fetch devices (HTTP ${res.status})`);

    if (!config.last_synced_at) {
      console.log(`[unifi] device response from ${devicePath}:`, JSON.stringify(res.data, null, 2));
    }

    const devices = extractList(res.data);

    for (const dev of devices) {
      const up = isDeviceUp(dev);
      const ok = await upsertDevice(db, projectId, config.id, {
        hostname: dev.name || dev.displayName || dev.model || dev.mac || dev.macAddress,
        ip: dev.ip || dev.ipAddress || null,
        mac: dev.mac || dev.macAddress || null,
        type: mapDeviceType(dev.type || dev.deviceType),
        model: dev.model || dev.modelDisplayName || null,
        serial_number: dev.serial || dev.serialNumber || dev.mac || dev.macAddress || null,
        status: up == null ? null : up ? 'up' : 'down',
      });
      if (ok) devicesImported += 1;
    }
  } catch (err) {
    errors.push(`devices: ${err.message}`);
  }

  try {
    const res = await http.get(`${prefix}/api/s/default/rest/networkconf`, { headers });
    if (res.status >= 400) throw new Error(`Failed to fetch networks (HTTP ${res.status})`);
    const networks = extractList(res.data);

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
