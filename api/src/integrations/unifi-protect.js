// Adapter for Ubiquiti UniFi Protect — imports cameras from a local UniFi OS
// console (UDM/UDM-Pro/CloudKey/UNVR) into project_cameras.
//
// UNVRs in particular have been seen to: serve `/proxy/protect/api/bootstrap`
// with an HTTP 500, reject the standard X-API-KEY header on
// `/proxy/protect/api/cameras` with a 401, and expose the cameras list under
// a different path entirely (`/api/cameras` or `/protect/api/cameras`). To
// cope with this every request tries each candidate auth method
// (X-API-KEY header, then Authorization: Bearer, then cookie-based
// username/password login) and, for the cameras sync, each candidate
// endpoint path, logging which combination succeeds.
//
// RTSP/RTSPS stream URLs and stream passwords are sensitive — they must never
// be written to console output. Response bodies from the cameras endpoint are
// therefore never logged in full; only non-sensitive summary info is logged.

const axios = require('axios');
const https = require('https');
const { upsertCamera } = require('./helpers');

function makeClient(config) {
  return axios.create({
    baseURL: config.base_url.replace(/\/+$/, ''),
    httpsAgent: new https.Agent({ rejectUnauthorized: config.verify_ssl !== false }),
    validateStatus: () => true,
    timeout: 10000,
  });
}

// Built once per testConnection/syncData call and passed explicitly on every
// request so self-signed certs are accepted regardless of how axios resolves
// the instance-level agent (e.g. across redirects).
function buildHttpsAgent(config) {
  if (config.verify_ssl === false) {
    return new https.Agent({ rejectUnauthorized: false });
  }
  return undefined;
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

function logError(url, err) {
  console.log(`[unifi-protect] request to ${url} failed: ${err.message}`);
  if (err.response) {
    console.log(`[unifi-protect]   error response status: ${err.response.status}`);
  }
}

// A UniFi OS console with no Protect application (or a bad URL/API key)
// serves the web UI's HTML shell instead of a JSON error.
function isHtmlResponse(data) {
  if (typeof data !== 'string') return false;
  const trimmed = data.trim().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

// Logs in via the UniFi OS endpoint, returning cookie/CSRF/bearer headers for
// subsequent requests. Used when no API key is configured, or as a fallback
// when API-key auth is rejected.
async function cookieLogin(http, config, httpsAgent) {
  const credentials = { username: config.username, password: config.password };
  const url = `${http.defaults.baseURL}/api/auth/login`;
  let res;
  try {
    res = await http.post('/api/auth/login', credentials, { httpsAgent });
    console.log(`[unifi-protect] POST ${url} -> HTTP ${res.status}`);
  } catch (err) {
    logError(url, err);
    throw err;
  }

  if (res.status === 500) {
    console.log(`[unifi-protect] response body (500): ${bodySnippet(res.data)}`);
  }

  if (res.status >= 400) {
    const message = res.data?.meta?.msg || res.data?.message || `HTTP ${res.status}`;
    throw new Error(`UniFi Protect login failed: ${message}`);
  }

  const setCookie = res.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const csrfToken = res.headers['x-csrf-token'];

  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  // Some UniFi OS versions return a bearer token in the login response body.
  const token = res.data?.token || res.data?.access_token;
  if (token) headers.Authorization = `Bearer ${token}`;

  return headers;
}

const AUTH_METHODS = ['api-key', 'bearer', 'cookie'];

// Builds the request headers for a given auth method, returning null if that
// method isn't usable with the configured credentials. Cookie auth is logged
// in at most once per sync/test (cached on `cache`).
async function authHeadersFor(method, http, config, httpsAgent, cache) {
  switch (method) {
    case 'api-key':
      if (!config.api_key) return null;
      return { 'X-API-KEY': config.api_key, 'Content-Type': 'application/json' };
    case 'bearer':
      if (!config.api_key) return null;
      return { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json' };
    case 'cookie':
      if (!config.username || !config.password) return null;
      if (!cache.cookieHeaders) {
        cache.cookieHeaders = await cookieLogin(http, config, httpsAgent);
      }
      return cache.cookieHeaders;
    default:
      return null;
  }
}

// GETs `path`, trying each auth method in turn (starting with
// `preferredMethod` if one is already known to work) until a non-401 response
// is returned. Logs every attempt's status, the full body of any 500
// response, and which auth method ultimately succeeded. Returns
// `{ res, headers, method }` for the last response tried, or null if no auth
// method was usable at all.
async function requestWithAuthFallback(http, path, config, httpsAgent, cache, preferredMethod) {
  const url = `${http.defaults.baseURL}${path}`;
  const methods = preferredMethod ? [preferredMethod, ...AUTH_METHODS.filter((m) => m !== preferredMethod)] : AUTH_METHODS;

  let last = null;
  for (const method of methods) {
    let headers;
    try {
      headers = await authHeadersFor(method, http, config, httpsAgent, cache);
    } catch (err) {
      console.log(`[unifi-protect] ${method} auth attempt for ${url} failed: ${err.message}`);
      continue;
    }
    if (!headers) continue;

    let res;
    try {
      res = await http.get(path, { headers, httpsAgent });
    } catch (err) {
      logError(url, err);
      continue;
    }

    console.log(`[unifi-protect] GET ${url} (auth: ${method}) -> HTTP ${res.status}`);
    if (res.status === 500) {
      console.log(`[unifi-protect] response body (500): ${bodySnippet(res.data)}`);
    }

    last = { res, headers, method };
    if (res.status !== 401) {
      if (res.status === 200) {
        console.log(`[unifi-protect] auth method "${method}" succeeded for ${url}`);
      }
      return last;
    }
  }
  return last;
}

// Extracts the controller's host/IP from its base URL, used to build RTSP(S)
// stream URLs that point at the controller directly.
function controllerHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

// Picks the highest-resolution channel from a camera's `channels` array and
// returns a friendly label like "4K" or "1080p", falling back to the
// channel's own name if it has no dimensions.
function pickResolution(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return null;

  let best = null;
  for (const channel of channels) {
    const area = (channel.width || 0) * (channel.height || 0);
    if (!best || area > best.area) best = { area, channel };
  }
  if (!best) return null;

  const { height } = best.channel;
  if (height >= 2160) return '4K';
  if (height) return `${height}p`;
  return best.channel.name || null;
}

function isCameraOnline(cam) {
  if (!cam.state) return null;
  return cam.state === 'CONNECTED';
}

// UniFi Protect's cameras endpoint may return a bare array, or wrap it in
// `{ cameras: [...] }` / `{ data: [...] }` depending on path/version.
function extractCameras(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.cameras)) return data.cameras;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function testConnection(config) {
  const http = makeClient(config);
  const httpsAgent = buildHttpsAgent(config);
  const cache = {};

  try {
    const result = await requestWithAuthFallback(http, '/proxy/protect/api/cameras', config, httpsAgent, cache, null);

    if (!result) {
      return { success: false, message: 'Authentication failed — check API key' };
    }

    const { res } = result;

    if (res.status === 401) {
      return { success: false, message: 'Authentication failed — check API key' };
    }
    if (res.status === 500 || isHtmlResponse(res.data)) {
      return { success: false, message: 'Protect API not available on this device' };
    }
    if (res.status !== 200) {
      return { success: false, message: `Unexpected response from Protect API (HTTP ${res.status})` };
    }

    const cameras = extractCameras(res.data);
    return { success: true, message: `Found ${cameras.length} camera${cameras.length === 1 ? '' : 's'}` };
  } catch (err) {
    console.log(`[unifi-protect] testConnection error: ${err.message}`);
    return { success: false, message: err.message };
  }
}

const CAMERA_ENDPOINTS = ['/proxy/protect/api/cameras', '/api/cameras', '/protect/api/cameras'];

async function syncData(config, projectId, db) {
  let camerasImported = 0;
  const http = makeClient(config);
  const httpsAgent = buildHttpsAgent(config);
  const cache = {};

  try {
    let found = null;
    let last = null;
    let preferredMethod = null;

    for (const path of CAMERA_ENDPOINTS) {
      const result = await requestWithAuthFallback(http, path, config, httpsAgent, cache, preferredMethod);
      if (!result) continue;

      last = result;
      if (result.method) preferredMethod = result.method;

      if (result.res.status === 200 && !isHtmlResponse(result.res.data)) {
        console.log(`[unifi-protect] using cameras endpoint ${path} (auth: ${result.method})`);
        found = { ...result, path };
        break;
      }
    }

    if (!found) {
      if (last?.res.status === 401) {
        throw new Error('Authentication failed — check API key');
      }
      if (last?.res.status === 500 || isHtmlResponse(last?.res.data)) {
        throw new Error('Protect API not available on this device');
      }
      throw new Error('No cameras endpoint responded successfully — see API logs for details');
    }

    const cameras = extractCameras(found.res.data);
    console.log(`[unifi-protect] cameras endpoint returned ${cameras.length} camera(s)`);

    if (cameras.length > 0) {
      // Log the response body and the field structure of the first camera so
      // future adapter work can see what's available, without leaking stream
      // URLs/passwords.
      const sanitized = cameras.map(({ streamSharing, rtspAlias, ...rest }) => rest);
      console.log(`[unifi-protect] response body (first 500 chars, sanitized): ${bodySnippet(sanitized)}`);
      console.log(`[unifi-protect] first camera fields: ${Object.keys(cameras[0]).join(', ')}`);
    }

    const host = controllerHost(config.base_url);

    for (const cam of cameras) {
      const alias = cam.rtspAlias || cam.id;
      const online = isCameraOnline(cam);

      const ok = await upsertCamera(db, projectId, config.id, {
        name: cam.name || cam.marketName || cam.mac,
        model: cam.marketName || cam.type || null,
        mac: cam.mac || null,
        ip_address: cam.host || null,
        rtsp_url: host && alias ? `rtsp://${host}:7447/${alias}` : null,
        rtsps_url: host && alias ? `rtsps://${host}:7441/${alias}` : null,
        stream_password: cam.streamSharing?.plainPassword || cam.streamSharing?.password || null,
        resolution: pickResolution(cam.channels),
        status: online == null ? 'unknown' : online ? 'online' : 'offline',
        last_seen: cam.lastSeen ? new Date(cam.lastSeen) : null,
      });
      if (ok) camerasImported += 1;
    }

    return { devices_imported: 0, vlans_imported: 0, cameras_imported: camerasImported, status: 'success', message: null };
  } catch (err) {
    console.log(`[unifi-protect] camera sync error: ${err.message}`);
    return {
      devices_imported: 0,
      vlans_imported: 0,
      cameras_imported: camerasImported,
      status: camerasImported ? 'partial' : 'failed',
      message: err.message,
    };
  }
}

module.exports = { testConnection, syncData };
