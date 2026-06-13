// Adapter for a user-defined custom REST API. The user supplies endpoint
// paths (relative to base_url) for devices and VLANs, each of which is
// expected to return a JSON array. Field names from the source JSON are
// mapped to Rackpath's schema via config.field_mapping / config.vlan_field_mapping.

const axios = require('axios');
const https = require('https');
const { upsertDevice, upsertVlan } = require('./helpers');

const DEFAULT_DEVICE_MAPPING = {
  hostname: 'hostname',
  ip: 'ip',
  mac: 'mac',
  type: 'type',
  model: 'model',
  serial_number: 'serial_number',
};

const DEFAULT_VLAN_MAPPING = {
  vlan_id: 'vlan_id',
  name: 'name',
  subnet: 'subnet',
};

function makeClient(config) {
  const headers = {};
  if (config.api_key) headers.Authorization = `Bearer ${config.api_key}`;
  return axios.create({
    baseURL: config.base_url.replace(/\/+$/, ''),
    httpsAgent: new https.Agent({ rejectUnauthorized: config.verify_ssl !== false }),
    headers,
    timeout: 10000,
  });
}

function mapFields(item, mapping) {
  const out = {};
  for (const [target, source] of Object.entries(mapping)) {
    out[target] = item[source] ?? null;
  }
  return out;
}

async function testConnection(config) {
  const devicesEndpoint = config.config?.devices_endpoint;
  if (!devicesEndpoint) {
    return { success: false, message: 'devices_endpoint is not configured' };
  }
  try {
    const http = makeClient(config);
    const res = await http.get(devicesEndpoint);
    if (!Array.isArray(res.data)) {
      return { success: false, message: 'Expected a JSON array response' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: err.response?.data?.message || err.message };
  }
}

async function syncData(config, projectId, db) {
  const http = makeClient(config);
  const deviceMapping = { ...DEFAULT_DEVICE_MAPPING, ...(config.config?.field_mapping || {}) };
  const vlanMapping = { ...DEFAULT_VLAN_MAPPING, ...(config.config?.vlan_field_mapping || {}) };

  let devicesImported = 0;
  let vlansImported = 0;
  const errors = [];

  const devicesEndpoint = config.config?.devices_endpoint;
  if (devicesEndpoint) {
    try {
      const res = await http.get(devicesEndpoint);
      const items = Array.isArray(res.data) ? res.data : [];
      for (const item of items) {
        const ok = await upsertDevice(db, projectId, config.id, mapFields(item, deviceMapping));
        if (ok) devicesImported += 1;
      }
    } catch (err) {
      errors.push(`devices: ${err.response?.data?.message || err.message}`);
    }
  }

  const vlansEndpoint = config.config?.vlans_endpoint;
  if (vlansEndpoint) {
    try {
      const res = await http.get(vlansEndpoint);
      const items = Array.isArray(res.data) ? res.data : [];
      for (const item of items) {
        const ok = await upsertVlan(db, projectId, mapFields(item, vlanMapping));
        if (ok) vlansImported += 1;
      }
    } catch (err) {
      errors.push(`vlans: ${err.response?.data?.message || err.message}`);
    }
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
