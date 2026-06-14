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

// Replaces stream URL values with a short, non-sensitive placeholder
// (length only) so the shape of an rtsps-stream response can be logged for
// debugging without leaking playable RTSPS URLs.
function redactStreamUrl(value) {
  if (typeof value === 'string') return `<string, ${value.length} chars>`;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactStreamUrl(v);
    return out;
  }
  return value;
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

// Some controllers return each quality as a bare URL string; others nest it
// in an object (e.g. `{ url: "rtsps://..." }`). Handle both.
function extractStreamUrl(value) {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object') {
    return value.url || value.rtspsUrl || value.uri || value.streamUrl || null;
  }
  return null;
}

// Fetches the RTSPS stream URLs for a camera via the Integration API's
// per-camera endpoint and returns the high/medium/low quality URLs, or all
// null if the request fails or the controller doesn't support it (e.g. the
// legacy /protect/api/cameras fallback). When `logResponse` is true, logs the
// shape of the response (key names and value lengths only — never the actual
// URLs) so the high/medium/low fields can be confirmed without leaking
// playable stream URLs.
async function fetchRtspsUrls(http, headers, httpsAgent, cameraId, logResponse = false) {
  const path = `/proxy/protect/integration/v1/cameras/${cameraId}/rtsps-stream`;
  const url = `${http.defaults.baseURL}${path}`;
  const none = { high: null, medium: null, low: null };

  let res;
  try {
    res = await http.post(
      path,
      { qualities: ['high', 'medium', 'low'] },
      { headers: { ...headers, 'Content-Type': 'application/json' }, httpsAgent }
    );
  } catch (err) {
    logError(url, err);
    return none;
  }

  console.log(`[unifi-protect] POST ${url} -> HTTP ${res.status}`);
  if (res.status === 500) {
    console.log(`[unifi-protect] response body (500): ${bodySnippet(res.data)}`);
  }
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') return none;

  if (logResponse) {
    console.log(`[unifi-protect] rtsps-stream response keys: ${Object.keys(res.data).join(', ')}`);
    console.log(`[unifi-protect] rtsps-stream response shape (redacted): ${bodySnippet(redactStreamUrl(res.data))}`);
  }

  return {
    high: extractStreamUrl(res.data.high),
    medium: extractStreamUrl(res.data.medium),
    low: extractStreamUrl(res.data.low),
  };
}

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

    for (let i = 0; i < cameras.length; i++) {
      const cam = cameras[i];
      const online = isCameraOnline(cam);
      const name = cameraDisplayName(cam);

      let rtspUrl = null;
      let rtspsHigh = null;
      let rtspsMedium = null;
      let rtspsLow = null;
      let ipAddress = null;
      let model = null;
      let resolution = null;

      if (usingIntegrationApi) {
        rtspUrl = host && cam.id ? `rtsp://${host}:7447/${cam.id}` : null;

        const rtspsUrls = await fetchRtspsUrls(http, headers, httpsAgent, cam.id, i === 0);
        rtspsHigh = rtspsUrls.high;
        rtspsMedium = rtspsUrls.medium;
        rtspsLow = rtspsUrls.low;

        const detail = await fetchCameraDetail(http, headers, httpsAgent, cam.id);
        if (i === 0 && detail) {
          // Log the first camera's detail fields (sanitized) so future
          // adapter work can confirm where model/IP info actually lives.
          const { streamSharing, rtspAlias, ...sanitizedDetail } = detail;
          console.log(`[unifi-protect] first camera detail (sanitized): ${bodySnippet(sanitizedDetail)}`);
        }

        model = pickCameraModel(cam, detail);
        ipAddress = pickCameraIp(cam, detail);
        resolution = deriveResolution(cam);
      } else {
        const alias = cam.rtspAlias || cam.id;
        rtspUrl = host && alias ? `rtsp://${host}:7447/${alias}` : null;
        rtspsHigh = host && alias ? `rtsps://${host}:7441/${alias}` : null;
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
          rtsp_url: rtspUrl,
          rtsps_url_high: rtspsHigh,
          rtsps_url_medium: rtspsMedium,
          rtsps_url_low: rtspsLow,
          resolution,
          status: online == null ? 'unknown' : online ? 'online' : 'offline',
          last_seen: cam.lastSeen ? new Date(cam.lastSeen) : null,
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
