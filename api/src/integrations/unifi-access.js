// Adapter for Ubiquiti UniFi Access — imports door controllers, readers, and
// other access-control hardware from a local UniFi OS console (UDM/UDM-Pro/
// CloudKey) into project_access_devices. Authenticates the same way as the
// UniFi network and Protect adapters: an API key sent via the UniFi OS
// X-API-KEY header, falling back to cookie-based username/password login.

const axios = require('axios');
const https = require('https');
const { upsertAccessDevice } = require('./helpers');

const NOT_INSTALLED_MESSAGE =
  'Could not reach Access API — check URL and API key. Make sure UniFi Access is installed on this controller.';

function makeClient(config) {
  return axios.create({
    baseURL: config.base_url.replace(/\/+$/, ''),
    httpsAgent: new https.Agent({ rejectUnauthorized: config.verify_ssl !== false }),
    validateStatus: () => true,
    timeout: 10000,
  });
}

function logError(url, err) {
  console.log(`[unifi-access] request to ${url} failed: ${err.message}`);
  if (err.response) {
    console.log(`[unifi-access]   error response status: ${err.response.status}`);
  }
}

// A UniFi OS console with no Access application (or a bad URL/API key) serves
// the web UI's HTML shell instead of a JSON error.
function isHtmlResponse(data) {
  if (typeof data !== 'string') return false;
  const trimmed = data.trim().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

// Logs in via the UniFi OS endpoint, returning cookie/CSRF headers for
// subsequent requests. Used when no API key is configured.
async function cookieLogin(http, config) {
  const credentials = { username: config.username, password: config.password };
  const url = `${http.defaults.baseURL}/api/auth/login`;
  let res;
  try {
    res = await http.post('/api/auth/login', credentials);
    console.log(`[unifi-access] POST ${url} -> HTTP ${res.status}`);
  } catch (err) {
    logError(url, err);
    throw err;
  }

  if (res.status >= 400) {
    const message = res.data?.meta?.msg || res.data?.message || `HTTP ${res.status}`;
    throw new Error(`UniFi Access login failed: ${message}`);
  }

  const setCookie = res.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const csrfToken = res.headers['x-csrf-token'];

  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  return headers;
}

// Authenticates against the controller, preferring an API key (X-API-KEY
// header) and falling back to a cookie-based session for username/password.
// Accept: application/json is required by the Access Integration API and
// harmless for the legacy endpoints.
async function authenticate(config) {
  const http = makeClient(config);

  if (config.api_key) {
    return {
      http,
      headers: { 'X-API-KEY': config.api_key, Accept: 'application/json', 'Content-Type': 'application/json' },
    };
  }

  const headers = await cookieLogin(http, config);
  return { http, headers: { ...headers, Accept: 'application/json' } };
}

// GETs each path in `paths` in order, stopping at the first HTTP 200 response
// with a JSON body. Logs every attempt's URL/status and which endpoint
// succeeded. Returns `{ res, path, attempts }`, with `res`/`path` null if
// nothing succeeded.
async function tryEndpoints(http, headers, paths) {
  const attempts = [];

  for (const path of paths) {
    const url = `${http.defaults.baseURL}${path}`;
    let res;
    try {
      res = await http.get(path, { headers });
    } catch (err) {
      logError(url, err);
      attempts.push({ path, status: 'error' });
      continue;
    }

    console.log(`[unifi-access] GET ${url} -> HTTP ${res.status}`);
    attempts.push({ path, status: res.status });

    if (res.status === 200 && typeof res.data === 'object' && res.data !== null) {
      console.log(`[unifi-access] using endpoint ${path}`);
      return { res, path, attempts };
    }
  }

  return { res: null, path: null, attempts };
}

const DEVICE_ENDPOINTS = ['/proxy/access/integration/v1/devices', '/proxy/access/api/v2/device'];

// UniFi Access wraps list responses as `{ code, msg, data: [...] }`.
function extractList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function fetchList(http, headers, path) {
  const url = `${http.defaults.baseURL}${path}`;
  try {
    const res = await http.get(path, { headers });
    console.log(`[unifi-access] GET ${url} -> HTTP ${res.status}`);
    if (res.status >= 400 || isHtmlResponse(res.data)) return [];
    return extractList(res.data);
  } catch (err) {
    logError(url, err);
    return [];
  }
}

const DEVICE_TYPE_PATTERNS = [
  [/intercom/i, 'ua-intercom'],
  [/elevator/i, 'ua-elevator'],
  [/g2.?mini/i, 'ua-g2-mini'],
  [/g2/i, 'ua-g2'],
  [/reader.?lite/i, 'ua-reader-lite'],
  [/reader/i, 'ua-reader'],
  [/hub/i, 'ua-hub'],
  [/pro/i, 'ua-pro'],
  [/door/i, 'ua-door-controller'],
];

// Maps a device's model/type string onto one of the device_type values used
// by the Access Devices UI, defaulting to 'other' for anything unrecognized.
function mapDeviceType(raw) {
  const str = `${raw || ''}`;
  for (const [pattern, type] of DEVICE_TYPE_PATTERNS) {
    if (pattern.test(str)) return type;
  }
  return 'other';
}

function isDeviceOnline(dev) {
  if (typeof dev.connected === 'boolean') return dev.connected;
  if (typeof dev.is_connected === 'boolean') return dev.is_connected;
  const state = dev.connection_status || dev.status || dev.state;
  if (!state) return false;
  return /online|connected/i.test(state);
}

// UniFi Access timestamps may be unix seconds, unix milliseconds, or ISO
// strings depending on endpoint/version.
function parseTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapLockState(value) {
  const v = `${value || ''}`.toLowerCase();
  if (v.includes('unlock')) return 'unlocked';
  if (v.includes('lock')) return 'locked';
  return 'unknown';
}

function mapOpenState(value) {
  const v = `${value || ''}`.toLowerCase();
  if (v.includes('open')) return 'open';
  if (v.includes('clos')) return 'closed';
  return 'unknown';
}

// Pulls device/resource ids out of whatever shape a relation field happens to
// be: a bare id, an array of ids, or an array of objects with id/device_id.
function flattenIds(value) {
  const ids = [];
  const visit = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (typeof v === 'object') {
      if (Array.isArray(v.devices)) {
        v.devices.forEach(visit);
        return;
      }
      if (v.device_id != null) {
        ids.push(String(v.device_id));
        return;
      }
      if (v.id != null) {
        ids.push(String(v.id));
        return;
      }
      return;
    }
    ids.push(String(v));
  };
  visit(value);
  return ids;
}

function buildDeviceIndex(devices) {
  const byId = new Map();
  for (const dev of devices) {
    const id = dev.id || dev.device_id || dev.unique_id;
    if (id != null) byId.set(String(id), dev);
  }
  return byId;
}

// Maps each device id referenced by a door to that door's name/location/
// floor/lock-and-open state, so devices can be enriched with their door info.
function buildDoorIndex(doors) {
  const byDeviceId = new Map();
  for (const door of doors) {
    const doorId = door.id || door.door_id || door.unique_id || null;
    const info = {
      id: doorId,
      name: door.full_name || door.name || null,
      location: door.floor?.building_name || door.location || null,
      floor: door.floor?.name || door.floor_name || (typeof door.floor === 'string' ? door.floor : null),
      lockState: mapLockState(door.door_lock_relay_status || door.lock_state || door.relay_status),
      openState: mapOpenState(door.door_position_status || door.open_state || door.position_status),
    };

    const deviceIds = flattenIds(door.device_groups || door.door_device_ids || door.devices || door.access_devices);
    for (const id of deviceIds) {
      byDeviceId.set(id, info);
    }
  }
  return byDeviceId;
}

// Maps each door id referenced by a policy/schedule to the resource's name,
// so a door's devices can be enriched with the access groups / unlock
// schedules that apply to it.
function buildResourceIndex(items) {
  const byDoorId = new Map();
  for (const item of items) {
    const name = item.name || item.policy_name || item.schedule_name;
    if (!name) continue;
    const doorIds = flattenIds(item.resources || item.door_ids || item.doors || item.scope);
    for (const doorId of doorIds) {
      if (!byDoorId.has(doorId)) byDoorId.set(doorId, []);
      byDoorId.get(doorId).push(name);
    }
  }
  return byDoorId;
}

async function testConnection(config) {
  try {
    const { http, headers } = await authenticate(config);
    const { res, attempts } = await tryEndpoints(http, headers, DEVICE_ENDPOINTS);

    if (!res) {
      if (attempts.some((a) => a.status === 401)) {
        return { success: false, message: 'Authentication failed — check API key' };
      }
      return { success: false, message: NOT_INSTALLED_MESSAGE };
    }

    const devices = extractList(res.data);
    return { success: true, message: `Found ${devices.length} device${devices.length === 1 ? '' : 's'}` };
  } catch (err) {
    console.log(`[unifi-access] testConnection error: ${err.message}`);
    return { success: false, message: err.message };
  }
}

async function syncData(config, projectId, db) {
  let accessDevicesImported = 0;

  try {
    const { http, headers } = await authenticate(config);
    const { res, path, attempts } = await tryEndpoints(http, headers, DEVICE_ENDPOINTS);

    if (!res) {
      const message = attempts.some((a) => a.status === 401) ? 'Authentication failed — check API key' : NOT_INSTALLED_MESSAGE;
      return { devices_imported: 0, vlans_imported: 0, access_devices_imported: 0, status: 'failed', message };
    }

    const devices = extractList(res.data);
    console.log(`[unifi-access] device endpoint ${path} returned ${devices.length} device(s)`);
    if (devices.length > 0) {
      console.log(`[unifi-access] first device fields: ${Object.keys(devices[0]).join(', ')}`);
    }

    const [doors, policies, schedules] = await Promise.all([
      fetchList(http, headers, '/proxy/access/api/v2/door'),
      fetchList(http, headers, '/proxy/access/api/v2/policy'),
      fetchList(http, headers, '/proxy/access/api/v2/schedule'),
    ]);
    console.log(`[unifi-access] door endpoint returned ${doors.length} door(s)`);
    console.log(`[unifi-access] policy endpoint returned ${policies.length} polic${policies.length === 1 ? 'y' : 'ies'}`);
    console.log(`[unifi-access] schedule endpoint returned ${schedules.length} schedule(s)`);

    const deviceIndex = buildDeviceIndex(devices);
    const doorIndex = buildDoorIndex(doors);
    const policyIndex = buildResourceIndex(policies);
    const scheduleIndex = buildResourceIndex(schedules);

    for (const dev of devices) {
      const devId = dev.id || dev.device_id || dev.unique_id;
      const door = devId != null ? doorIndex.get(String(devId)) : null;
      const doorId = door?.id != null ? String(door.id) : null;

      const readerIds = flattenIds(dev.readers || dev.connected_readers || dev.reader_ids);
      const connectedReaders = readerIds.map((id) => deviceIndex.get(id)?.name).filter(Boolean);

      const ok = await upsertAccessDevice(db, projectId, config.id, {
        name: dev.name || dev.alias || dev.mac || dev.device_mac,
        model: dev.model_display_name || dev.model || null,
        mac: dev.mac || dev.device_mac || null,
        ip_address: dev.ip || dev.ip_address || null,
        firmware_version: dev.firmware_version || dev.version || null,
        device_type: mapDeviceType(dev.device_type || dev.type || dev.model),
        online: isDeviceOnline(dev),
        last_seen: parseTimestamp(dev.last_seen || dev.last_seen_at) || new Date(),
        door_name: door?.name || null,
        location: door?.location || null,
        floor: door?.floor || null,
        door_lock_state: door?.lockState || 'unknown',
        door_open_state: door?.openState || 'unknown',
        connected_readers: connectedReaders,
        access_groups: doorId ? policyIndex.get(doorId) || [] : [],
        unlock_schedules: doorId ? scheduleIndex.get(doorId) || [] : [],
      });
      if (ok) accessDevicesImported += 1;
    }

    return { devices_imported: 0, vlans_imported: 0, access_devices_imported: accessDevicesImported, status: 'success', message: null };
  } catch (err) {
    console.log(`[unifi-access] sync error: ${err.message}`);
    return {
      devices_imported: 0,
      vlans_imported: 0,
      access_devices_imported: accessDevicesImported,
      status: accessDevicesImported ? 'partial' : 'failed',
      message: err.message,
    };
  }
}

module.exports = { testConnection, syncData };
