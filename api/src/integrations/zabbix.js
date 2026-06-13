// Adapter for Zabbix, using the JSON-RPC API at /api_jsonrpc.php. Zabbix
// doesn't manage VLANs, so this adapter only syncs devices (hosts).

const axios = require('axios');
const https = require('https');
const { upsertDevice } = require('./helpers');

const TYPE_GROUP_HINTS = [
  { match: /router|gateway|firewall/i, type: 'router' },
  { match: /switch/i, type: 'switch' },
  { match: /access point|wireless|ap\b/i, type: 'ap' },
  { match: /server/i, type: 'server' },
];

function makeClient(config) {
  return axios.create({
    baseURL: config.base_url.replace(/\/+$/, ''),
    httpsAgent: new https.Agent({ rejectUnauthorized: config.verify_ssl !== false }),
    timeout: 10000,
  });
}

let nextRequestId = 1;

async function call(http, method, params, auth) {
  const body = {
    jsonrpc: '2.0',
    method,
    params: params || {},
    id: nextRequestId++,
  };
  if (auth) body.auth = auth;

  const res = await http.post('/api_jsonrpc.php', body, {
    headers: { 'Content-Type': 'application/json-rpc' },
  });

  if (res.data?.error) {
    throw new Error(res.data.error.data || res.data.error.message || 'Zabbix API error');
  }
  return res.data?.result;
}

async function login(config) {
  const http = makeClient(config);
  let token;
  try {
    token = await call(http, 'user.login', { username: config.username, password: config.password });
  } catch (err) {
    // Zabbix < 6.4 expects "user" instead of "username".
    token = await call(http, 'user.login', { user: config.username, password: config.password });
  }
  return { http, token };
}

async function testConnection(config) {
  try {
    await login(config);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function inferTypeFromGroups(groups) {
  for (const group of groups || []) {
    for (const hint of TYPE_GROUP_HINTS) {
      if (hint.match.test(group.name || '')) return hint.type;
    }
  }
  return null;
}

async function syncData(config, projectId, db) {
  const { http, token } = await login(config);

  let devicesImported = 0;
  const errors = [];

  try {
    const hosts = await call(
      http,
      'host.get',
      {
        output: ['hostid', 'host', 'name', 'status'],
        selectInterfaces: ['ip', 'available'],
        selectGroups: ['name'],
        selectInventory: ['serialno_a', 'hardware'],
      },
      token
    );

    for (const host of hosts || []) {
      const iface = (host.interfaces || [])[0] || {};
      const available = Number(iface.available);
      const ok = await upsertDevice(db, projectId, config.id, {
        hostname: host.name || host.host,
        ip: iface.ip || null,
        type: inferTypeFromGroups(host.groups),
        model: host.inventory?.hardware || null,
        serial_number: host.inventory?.serialno_a || null,
        status: available === 1 ? 'up' : available === 2 ? 'down' : 'unknown',
      });
      if (ok) devicesImported += 1;
    }
  } catch (err) {
    errors.push(`devices: ${err.message}`);
  }

  if (errors.length === 0) {
    return { devices_imported: devicesImported, vlans_imported: 0, status: 'success', message: null };
  }

  return {
    devices_imported: devicesImported,
    vlans_imported: 0,
    status: devicesImported ? 'partial' : 'failed',
    message: errors.join('; '),
  };
}

module.exports = { testConnection, syncData };
