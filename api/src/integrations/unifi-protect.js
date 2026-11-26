// Adapter for Ubiquiti UniFi Protect: imports the camera inventory (name,
// model, MAC, IP, resolution) from a local UniFi OS console
// (UDM/UDM-Pro/CloudKey/UNVR) into project_cameras.
//
// Uses the official UniFi Protect Integration API
// (/proxy/protect/integration/v1/*) with an API key in X-API-KEY, falling back
// to the legacy /protect/api/cameras path on consoles that don't expose it, or
// the bootstrap API when configured with a username and password.
//
// Rackpath is documentation, not a video system: stream URLs, stream
// credentials and online state are deliberately not imported.

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

// True when the integration is configured for the unofficial bootstrap API
// (username/password, no API key) rather than the official Integration API.
function usesBootstrapApi(config) {
  return !config.api_key && !!config.username && !!config.password;
}

// Logs in via the UniFi OS endpoint using username/password and manually
// extracts the session token from the response, since axios-cookiejar-support
// is incompatible with a custom httpsAgent (needed for self-signed certs).
// The token is found either in a `TOKEN=` Set-Cookie entry, an Authorization
// header, or the response body, and is sent back as a `Cookie: TOKEN=...`
// header on subsequent requests. Returns extra headers (Cookie / X-CSRF-Token).
async function bootstrapLogin(http, config, httpsAgent) {
  const url = `${http.defaults.baseURL}/api/auth/login`;
  let res;
  try {
    res = await http.post(
      '/api/auth/login',
      { username: config.username, password: config.password },
      { headers: { 'Content-Type': 'application/json' }, httpsAgent }
    );
    console.log(`[unifi-protect] [bootstrap] POST ${url} -> HTTP ${res.status}`);
  } catch (err) {
    logError(url, err);
    throw err;
  }

  if (res.status === 500) {
    console.log(`[unifi-protect] [bootstrap] response body (500): ${bodySnippet(res.data)}`);
  }

  if (res.status >= 400) {
    const message = res.data?.meta?.msg || res.data?.message || `HTTP ${res.status}`;
    throw new Error(`UniFi Protect bootstrap login failed: ${message}`);
  }

  const cookies = res.headers['set-cookie'];
  const tokenCookie = cookies?.find((c) => c.startsWith('TOKEN='));
  let token = tokenCookie?.split(';')[0]?.replace('TOKEN=', '');

  if (!token) {
    const authHeader = res.headers['authorization'];
    if (authHeader) token = authHeader.replace(/^Bearer\s+/i, '');
  }
  if (!token) {
    token = res.data?.token || res.data?.access_token || null;
  }

  console.log(`[unifi-protect] [bootstrap] login ${token ? 'received' : 'did not receive'} a session token`);

  if (!token) {
    throw new Error('UniFi Protect bootstrap login did not return a session token');
  }

  const headers = { Cookie: `TOKEN=${token}` };
  const csrfToken = res.headers['x-csrf-token'];
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  return headers;
}

// GETs the bootstrap endpoint, which returns the full NVR config (including
// the cameras array with channels, host/IP, and feature flags). Returns
// `res.data`, or null if unavailable.
async function fetchBootstrap(http, headers, httpsAgent) {
  const path = '/proxy/protect/api/bootstrap';
  const url = `${http.defaults.baseURL}${path}`;

  let res;
  try {
    res = await http.get(path, { headers, httpsAgent });
  } catch (err) {
    logError(url, err);
    return null;
  }

  console.log(`[unifi-protect] [bootstrap] GET ${url} -> HTTP ${res.status}`);
  console.log(`[unifi-protect] [bootstrap] response body (first 200 chars): ${bodySnippet(res.data).slice(0, 200)}`);
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') return null;

  return res.data;
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

// On the Integration API, `camera.name` is an object keyed by locale (e.g.
// `{ default: "...", custom: "..." }`); the legacy /protect/api/cameras
// endpoint returns a plain string.
function cameraDisplayName(cam) {
  const { name } = cam;
  if (name && typeof name === 'object') {
    return name.default || name.custom || Object.values(name)[0] || cam.mac || 'Unknown';
  }
  return name || cam.marketName || cam.mac || 'Unknown';
}

const VIDEO_MODE_RESOLUTIONS = {
  default: '1080p',
  highFps: '1080p High FPS',
  sport: '1080p Sport',
  slowShutter: '1080p Slow Shutter',
};

// The Integration API's cameras list doesn't include sensor resolution
// directly, so approximate it from the model and video mode.
function deriveResolution(cam) {
  const modelKey = cam.modelKey || '';

  if (/G5-Pro|G4-Pro/i.test(modelKey)) return '8MP';
  if (cam.featureFlags?.supportFullHdSnapshot && /G4/i.test(modelKey)) return '4MP';
  if (/G3/i.test(modelKey)) return '1080p';

  return VIDEO_MODE_RESOLUTIONS[cam.videoMode] || null;
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

// The Integration API's cameras list doesn't include the camera's IP, so
// fetch the single-camera detail endpoint, which may. Returns the detail
// object, or null if unavailable.
async function fetchCameraDetail(http, headers, httpsAgent, cameraId) {
  const path = `/proxy/protect/integration/v1/cameras/${cameraId}`;
  const url = `${http.defaults.baseURL}${path}`;

  let res;
  try {
    res = await http.get(path, { headers, httpsAgent });
  } catch (err) {
    logError(url, err);
    return null;
  }

  console.log(`[unifi-protect] GET ${url} -> HTTP ${res.status}`);
  if (res.status === 500) {
    console.log(`[unifi-protect] response body (500): ${bodySnippet(res.data)}`);
  }
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') return null;

  return res.data;
}

// camera.modelKey on the Integration API list endpoint can come back as a
// generic placeholder (e.g. "camera") rather than a real model identifier
// like "UVC-G4-Pro". The per-camera detail endpoint may expose a better
// field — prefer those, falling back to modelKey only as a last resort.
function pickCameraModel(cam, detail) {
  return (
    detail?.type ||
    detail?.hardwareRevision ||
    detail?.marketName ||
    detail?.model ||
    cam.marketName ||
    cam.type ||
    cam.model ||
    cam.modelKey ||
    null
  );
}

// The Integration API's cameras list doesn't include the camera's IP; try
// the per-camera detail endpoint's likely IP fields in order of preference.
function pickCameraIp(cam, detail) {
  return detail?.host || detail?.ipAddress || detail?.ip || detail?.connectionHost || cam.host || null;
}

// Tests connectivity for the unofficial bootstrap API: logs in with
// username/password and fetches the bootstrap config, reporting the number
// of cameras found.
async function testConnectionBootstrap(config) {
  const httpsAgent = buildHttpsAgent(config);

  try {
    const http = makeClient(config);
    const headers = await bootstrapLogin(http, config, httpsAgent);
    const bootstrap = await fetchBootstrap(http, headers, httpsAgent);

    if (!bootstrap) {
      return { success: false, message: 'Bootstrap endpoint not available — check URL and credentials' };
    }

    const cameras = Array.isArray(bootstrap.cameras) ? bootstrap.cameras : [];
    console.log(`[unifi-protect] [bootstrap] testConnection succeeded — ${cameras.length} camera(s) found`);

    return { success: true, message: `Connected — ${cameras.length} camera${cameras.length === 1 ? '' : 's'} found` };
  } catch (err) {
    console.log(`[unifi-protect] [bootstrap] testConnection error: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// Syncs cameras via the unofficial bootstrap API
// (/proxy/protect/api/bootstrap). Inventory only: name, model, MAC, IP and
// resolution. Stream URLs, credentials and online state are not imported.
async function syncDataBootstrap(config, projectId, db) {
  let camerasImported = 0;
  const httpsAgent = buildHttpsAgent(config);

  try {
    const http = makeClient(config);
    const headers = await bootstrapLogin(http, config, httpsAgent);
    const bootstrap = await fetchBootstrap(http, headers, httpsAgent);

    if (!bootstrap) {
      throw new Error('Bootstrap endpoint not available — check URL and credentials');
    }

    const cameras = Array.isArray(bootstrap.cameras) ? bootstrap.cameras : [];
    console.log(`[unifi-protect] [bootstrap] bootstrap returned ${cameras.length} camera(s)`);

    console.log(`[unifi-protect] [bootstrap] Upserting ${cameras.length} cameras for project ${projectId}`);

    for (const cam of cameras) {
      const name = cameraDisplayName(cam);
      const payload = {
        name,
        model: cam.type || cam.marketName || cam.modelKey || null,
        mac: cam.mac || null,
        ip_address: cam.host || null,
        resolution: pickResolution(Array.isArray(cam.channels) ? cam.channels : []),
      };

      try {
        const ok = await upsertCamera(db, projectId, config.id, payload);
        if (ok) camerasImported += 1;
      } catch (err) {
        console.log(`[unifi-protect] [bootstrap] failed to upsert camera ${cam.mac || cam.id || name || '(unknown)'}: ${err.message}`);
        console.log(err.stack);
      }
    }

    console.log(`[unifi-protect] [bootstrap] Upserted ${camerasImported} of ${cameras.length} cameras for project ${projectId}`);

    return { devices_imported: 0, vlans_imported: 0, cameras_imported: camerasImported, status: 'success', message: null };
  } catch (err) {
    console.log(`[unifi-protect] [bootstrap] camera sync error: ${err.message}`);
    return {
      devices_imported: 0,
      vlans_imported: 0,
      cameras_imported: camerasImported,
      status: camerasImported ? 'partial' : 'failed',
      message: err.message,
    };
  }
}

async function testConnection(config) {
  if (usesBootstrapApi(config)) {
    console.log('[unifi-protect] using unofficial bootstrap API (username/password)');
    return testConnectionBootstrap(config);
  }
  console.log('[unifi-protect] using official Integration API (API key)');

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
  if (usesBootstrapApi(config)) {
    console.log('[unifi-protect] using unofficial bootstrap API (username/password)');
    return syncDataBootstrap(config, projectId, db);
  }
  console.log('[unifi-protect] using official Integration API (API key)');

  let camerasImported = 0;
  const httpsAgent = buildHttpsAgent(config);

  try {
    const { http, headers } = await authenticate(config, httpsAgent);
    const { res, path, attempts } = await tryEndpoints(http, headers, httpsAgent, CAMERA_ENDPOINTS);

    if (!res) {
      throw new Error(connectionFailureMessage(attempts));
    }

    const cameras = extractCameras(res.data);
    console.log(`[unifi-protect] cameras endpoint ${path} returned ${cameras.length} camera(s)`);

    const usingIntegrationApi = path === '/proxy/protect/integration/v1/cameras';

    console.log(`[unifi-protect] Upserting ${cameras.length} cameras for project ${projectId}`);

    for (const cam of cameras) {
      const name = cameraDisplayName(cam);
      let ipAddress = null;
      let model = null;
      let resolution = null;

      if (usingIntegrationApi) {
        const detail = await fetchCameraDetail(http, headers, httpsAgent, cam.id);
        model = pickCameraModel(cam, detail);
        ipAddress = pickCameraIp(cam, detail);
        resolution = deriveResolution(cam);
      } else {
        model = pickCameraModel(cam, null);
        ipAddress = pickCameraIp(cam, null);
        resolution = pickResolution(cam.channels);
      }

      try {
        const ok = await upsertCamera(db, projectId, config.id, {
          name,
          model,
          mac: cam.mac || null,
          ip_address: ipAddress,
          resolution,
        });
        if (ok) camerasImported += 1;
      } catch (err) {
        console.log(`[unifi-protect] failed to upsert camera ${cam.mac || cam.id || name || '(unknown)'}: ${err.message}`);
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
