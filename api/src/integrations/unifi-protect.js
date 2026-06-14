// Adapter for Ubiquiti UniFi Protect — imports cameras from a local UniFi OS
// console (UDM/UDM-Pro/CloudKey/UNVR) into project_cameras.
//
// Uses the official UniFi Protect Integration API
// (/proxy/protect/integration/v1/*), authenticated with an API key sent via
// the X-API-KEY header plus Accept: application/json. The cameras endpoint
// returns a bare JSON array of camera objects and does not include RTSP(S)
// stream URLs — those are fetched per-camera via a separate
// `.../cameras/{id}/rtsps-stream` call. Some UNVR consoles don't expose the
// integration API and instead serve cameras under the legacy
// /protect/api/cameras path, so every request tries the integration endpoint
// first and falls back to that legacy path, logging the URL/status of every
// attempt and which endpoint ultimately succeeds.
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

// Logs in via the UniFi OS endpoint, returning cookie/CSRF/bearer headers for
// subsequent requests. Used only when no API key is configured.
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

// Authenticates against the controller, preferring an API key sent via the
// X-API-KEY header (as required by the Protect Integration API) and falling
// back to a cookie-based session for username/password. Accept:
// application/json is required by the Integration API and harmless for the
// legacy endpoints.
async function authenticate(config, httpsAgent) {
  const http = makeClient(config);

  if (config.api_key) {
    return { http, headers: { 'X-API-KEY': config.api_key, Accept: 'application/json' } };
  }

  const headers = await cookieLogin(http, config, httpsAgent);
  return { http, headers: { ...headers, Accept: 'application/json' } };
}

// GETs each path in `paths` in order, stopping at the first HTTP 200 response
// with a JSON body. Logs every attempt's URL/status (and the full body of any
// 500 response), and which endpoint succeeded. Returns
// `{ res, path, attempts }`, with `res`/`path` null if nothing succeeded.
async function tryEndpoints(http, headers, httpsAgent, paths) {
  const attempts = [];

  for (const path of paths) {
    const url = `${http.defaults.baseURL}${path}`;
    let res;
    try {
      res = await http.get(path, { headers, httpsAgent });
    } catch (err) {
      logError(url, err);
      attempts.push({ path, status: 'error' });
      continue;
    }

    console.log(`[unifi-protect] GET ${url} -> HTTP ${res.status}`);
    if (res.status === 500) {
      console.log(`[unifi-protect] response body (500): ${bodySnippet(res.data)}`);
    }
    attempts.push({ path, status: res.status });

    if (res.status === 200 && typeof res.data === 'object' && res.data !== null) {
      console.log(`[unifi-protect] using endpoint ${path}`);
      return { res, path, attempts };
    }
  }

  return { res: null, path: null, attempts };
}

function connectionFailureMessage(attempts) {
  if (attempts.some((a) => a.status === 401)) {
    return 'Authentication failed — check API key';
  }
  const tried = attempts.map((a) => `${a.path} -> ${a.status}`).join(', ');
  return `Protect API not available on this device (tried: ${tried})`;
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
// `{ cameras: [...] }` / `{ data: [...] }` / `{ data: { cameras: [...] } }`
// depending on path/version.
function extractCameras(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.cameras)) return data.cameras;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.cameras)) return data.data.cameras;
  return [];
}

const CAMERA_ENDPOINTS = ['/proxy/protect/integration/v1/cameras', '/protect/api/cameras'];

// Fetches the RTSPS stream URLs for a camera via the Integration API's
// per-camera endpoint and returns the "high" quality URL, or null if the
// request fails or the controller doesn't support it (e.g. the legacy
// /protect/api/cameras fallback).
async function fetchHighRtspsUrl(http, headers, httpsAgent, cameraId) {
  const path = `/proxy/protect/integration/v1/cameras/${cameraId}/rtsps-stream`;
  const url = `${http.defaults.baseURL}${path}`;

  let res;
  try {
    res = await http.post(
      path,
      { qualities: ['high', 'medium', 'low'] },
      { headers: { ...headers, 'Content-Type': 'application/json' }, httpsAgent }
    );
  } catch (err) {
    logError(url, err);
    return null;
  }

  console.log(`[unifi-protect] POST ${url} -> HTTP ${res.status}`);
  if (res.status === 500) {
    console.log(`[unifi-protect] response body (500): ${bodySnippet(res.data)}`);
  }
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') return null;

  return res.data.high || null;
}

async function testConnection(config) {
  const httpsAgent = buildHttpsAgent(config);

  try {
    const { http, headers } = await authenticate(config, httpsAgent);
    const { res, path, attempts } = await tryEndpoints(http, headers, httpsAgent, CAMERA_ENDPOINTS);

    if (!res) {
      return { success: false, message: connectionFailureMessage(attempts) };
    }

    const cameras = extractCameras(res.data);
    console.log(`[unifi-protect] testConnection succeeded via ${path}`);
    if (cameras.length > 0) {
      console.log(`[unifi-protect] first camera keys: ${Object.keys(cameras[0]).join(', ')}`);
    }

    return { success: true, message: `Connected — ${cameras.length} camera${cameras.length === 1 ? '' : 's'} found` };
  } catch (err) {
    console.log(`[unifi-protect] testConnection error: ${err.message}`);
    return { success: false, message: err.message };
  }
}

async function syncData(config, projectId, db) {
  let camerasImported = 0;
  const httpsAgent = buildHttpsAgent(config);

  try {
    const { http, headers } = await authenticate(config, httpsAgent);
    const { res, path, attempts } = await tryEndpoints(http, headers, httpsAgent, CAMERA_ENDPOINTS);

    if (!res) {
      throw new Error(connectionFailureMessage(attempts));
    }

    const url = `${http.defaults.baseURL}${path}`;
    const dataType = Array.isArray(res.data)
      ? `array (length ${res.data.length})`
      : res.data && typeof res.data === 'object'
        ? `object with keys: ${Object.keys(res.data).join(', ')}`
        : typeof res.data;
    console.log(`[unifi-protect] cameras endpoint succeeded: ${url}`);
    console.log(`[unifi-protect] response data type: ${dataType}`);

    const cameras = extractCameras(res.data);
    console.log(`[unifi-protect] cameras endpoint ${path} returned ${cameras.length} camera(s) before filtering`);

    if (cameras.length > 0) {
      console.log(`[unifi-protect] first camera keys: ${Object.keys(cameras[0]).join(', ')}`);
      // Log the first camera's fields so future adapter work can see the
      // real shape, without leaking stream URLs/passwords.
      const { streamSharing, rtspAlias, ...sanitizedFirst } = cameras[0];
      console.log(`[unifi-protect] first camera (sanitized): ${bodySnippet(sanitizedFirst)}`);
    }

    const host = controllerHost(config.base_url);
    const usingIntegrationApi = path === '/proxy/protect/integration/v1/cameras';

    console.log(`[unifi-protect] Upserting ${cameras.length} cameras for project ${projectId}`);

    for (const cam of cameras) {
      const online = isCameraOnline(cam);

      let rtspUrl = null;
      let rtspsUrl = null;
      let streamPassword = null;

      if (usingIntegrationApi) {
        rtspUrl = host && cam.id ? `rtsp://${host}:7447/${cam.id}` : null;
        rtspsUrl = await fetchHighRtspsUrl(http, headers, httpsAgent, cam.id);
      } else {
        const alias = cam.rtspAlias || cam.id;
        rtspUrl = host && alias ? `rtsp://${host}:7447/${alias}` : null;
        rtspsUrl = host && alias ? `rtsps://${host}:7441/${alias}` : null;
        streamPassword = cam.streamSharing?.plainPassword || cam.streamSharing?.password || null;
      }

      try {
        const ok = await upsertCamera(db, projectId, config.id, {
          name: cam.name || cam.marketName || cam.mac,
          model: cam.model || cam.marketName || cam.type || null,
          mac: cam.mac || null,
          ip_address: cam.host || null,
          rtsp_url: rtspUrl,
          rtsps_url: rtspsUrl,
          stream_password: streamPassword,
          resolution: pickResolution(cam.channels),
          status: online == null ? 'unknown' : online ? 'online' : 'offline',
          last_seen: cam.lastSeen ? new Date(cam.lastSeen) : null,
        });
        if (ok) camerasImported += 1;
      } catch (err) {
        console.log(`[unifi-protect] failed to upsert camera ${cam.mac || cam.id || cam.name || '(unknown)'}: ${err.message}`);
        console.log(err.stack);
      }
    }

    console.log(`[unifi-protect] Upserted ${camerasImported} of ${cameras.length} cameras for project ${projectId}`);

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
