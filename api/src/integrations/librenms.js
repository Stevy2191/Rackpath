// Adapter for LibreNMS, using its REST API authenticated with an API token
// (X-Auth-Token header, stored in the integration's api_key field).

const axios = require('axios');
const https = require('https');
const { upsertDevice, upsertVlan } = require('./helpers');

function makeClient(config) {
  return axios.create({
    baseURL: config.base_url.replace(/\/+$/, ''),
    httpsAgent: new https.Agent({ rejectUnauthorized: config.verify_ssl !== false }),
    headers: { 'X-Auth-Token': config.api_key },
    timeout: 10000,
  });
}

async function testConnection(config) {
  try {
    const http = makeClient(config);
    const res = await http.get('/api/v0/devices');
    if (res.status >= 400) {
      return { success: false, message: `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: err.response?.data?.message || err.message };
  }
}

async function syncData(config, projectId, db) {
  const http = makeClient(config);

  let devicesImported = 0;
  let vlansImported = 0;
  const errors = [];

  try {
    const res = await http.get('/api/v0/devices');
    const devices = res.data?.devices || [];

    for (const dev of devices) {
      const ok = await upsertDevice(db, projectId, config.id, {
        hostname: dev.hostname || dev.sysName || dev.ip,
        ip: dev.ip || dev.hostname || null,
        type: dev.type || null,
        model: dev.hardware || null,
        serial_number: dev.serial || null,
        status: Number(dev.status) === 1 ? 'up' : 'down',
      });
      if (ok) devicesImported += 1;
    }
  } catch (err) {
    errors.push(`devices: ${err.response?.data?.message || err.message}`);
  }

  try {
    const res = await http.get('/api/v0/resources/vlans');
    const vlans = res.data?.vlans || [];

    for (const vlan of vlans) {
      const ok = await upsertVlan(db, projectId, {
        vlan_id: vlan.vlan_vlan,
        name: vlan.vlan_name || vlan.vlan_descr || `VLAN ${vlan.vlan_vlan}`,
        subnet: null,
      });
      if (ok) vlansImported += 1;
    }
  } catch (err) {
    errors.push(`vlans: ${err.response?.data?.message || err.message}`);
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
