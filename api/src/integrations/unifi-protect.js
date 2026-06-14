// Adapter for Ubiquiti UniFi Protect — imports cameras from a local UniFi OS
// console (UDM/UDM-Pro/CloudKey) into project_cameras. Authenticates the same
// way as the UniFi network adapter: an API key sent via the UniFi OS
// X-API-KEY header, falling back to cookie-based username/password login.
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

// Logs in via the UniFi OS endpoint, returning cookie/CSRF headers for
// subsequent requests. Used when no API key is configured.
async function cookieLogin(http, config) {
  const credentials = { username: config.username, password: config.password };
  const url = `${http.defaults.baseURL}/api/auth/login`;
  let res;
  try {
    res = await http.post('/api/auth/login', credentials);
    console.log(`[unifi-protect] POST ${url} -> HTTP ${res.status}`);
  } catch (err) {
    logError(url, err);
    throw err;
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
  return headers;
}

// Authenticates against the controller, preferring an API key (X-API-KEY
// header) and falling back to a cookie-based session for username/password.
async function authenticate(config) {
  const http = makeClient(config);

  if (config.api_key) {
    return {
      http,
      headers: { 'X-API-KEY': config.api_key, 'Content-Type': 'application/json' },
    };
  }

  const headers = await cookieLogin(http, config);
  return { http, headers };
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
// returns a "WIDTHxHEIGHT" label, falling back to the channel's own name.
function pickResolution(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return null;

  let best = null;
  for (const channel of channels) {
    const area = (channel.width || 0) * (channel.height || 0);
    if (!best || area > best.area) best = { area, channel };
  }
  if (!best) return null;

  const { channel } = best;
  if (channel.width && channel.height) return `${channel.width}x${channel.height}`;
  return channel.name || null;
}

function isCameraOnline(cam) {
  if (!cam.state) return null;
  return cam.state === 'CONNECTED';
}

async function testConnection(config) {
  try {
    const { http, headers } = await authenticate(config);
    const url = `${http.defaults.baseURL}/proxy/protect/api/bootstrap`;
    const res = await http.get('/proxy/protect/api/bootstrap', { headers });
    console.log(`[unifi-protect] GET ${url} -> HTTP ${res.status}`);

    if (res.status !== 200) {
      return { success: false, message: `Bootstrap endpoint returned HTTP ${res.status}` };
    }

    const cameras = Array.isArray(res.data?.cameras) ? res.data.cameras : [];
    return { success: true, message: `Found ${cameras.length} camera${cameras.length === 1 ? '' : 's'}` };
  } catch (err) {
    console.log(`[unifi-protect] testConnection error: ${err.message}`);
    return { success: false, message: err.message };
  }
}

async function syncData(config, projectId, db) {
  let camerasImported = 0;

  try {
    const { http, headers } = await authenticate(config);
    const url = `${http.defaults.baseURL}/proxy/protect/api/cameras`;
    const res = await http.get('/proxy/protect/api/cameras', { headers });
    console.log(`[unifi-protect] GET ${url} -> HTTP ${res.status}`);

    if (res.status >= 400) {
      throw new Error(`Cameras endpoint returned HTTP ${res.status}: ${bodySnippet(res.data)}`);
    }

    const cameras = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.data) ? res.data.data : [];
    console.log(`[unifi-protect] cameras endpoint returned ${cameras.length} camera(s)`);

    if (cameras.length > 0) {
      // Log the field structure of the first camera so future adapter work
      // can see what's available, without leaking stream URLs/passwords.
      const { streamSharing, rtspAlias, ...safe } = cameras[0];
      console.log(`[unifi-protect] first camera fields: ${Object.keys(cameras[0]).join(', ')}`);
      console.log(`[unifi-protect] first camera (sanitized): ${bodySnippet(safe)}`);
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
