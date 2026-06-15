// Adapter for plain SNMP devices, using the net-snmp package. Unlike the
// other adapters this targets a single device: base_url is the device's IP
// (or hostname), the community string is stored in api_key, and the SNMP
// version ('1', '2c' or '3') lives in config.snmp_version.

const snmp = require('net-snmp');
const { upsertDevice } = require('./helpers');
const { translateInterfaceName } = require('../services/interfaceNames');

const SYSTEM_OID = '1.3.6.1.2.1.1';
const SYS_DESCR_OID = '1.3.6.1.2.1.1.1.0';
const SYS_NAME_OID = '1.3.6.1.2.1.1.5.0';
const IFACES_OID = '1.3.6.1.2.1.2.2.1';
const IF_DESCR_COLUMN = '2';
const IF_PHYS_ADDR_COLUMN = '6';

const VERSION_MAP = { '1': snmp.Version1, '2c': snmp.Version2c };

function target(config) {
  return config.base_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function createSession(config) {
  const version = String(config.config?.snmp_version || '2c');

  if (version === '3') {
    return snmp.createV3Session(target(config), config.username || 'admin', {
      level: config.password ? snmp.SecurityLevel.authPriv : snmp.SecurityLevel.noAuthNoPriv,
      authProtocol: snmp.AuthProtocols.sha,
      authKey: config.password || undefined,
      privProtocol: snmp.PrivProtocols.aes,
      privKey: config.password || undefined,
      timeout: 5000,
    });
  }

  return snmp.createSession(target(config), config.api_key || 'public', {
    version: VERSION_MAP[version] || snmp.Version2c,
    timeout: 5000,
    retries: 1,
  });
}

// Walks an OID subtree and resolves with a flat array of { oid, value } pairs.
function walk(session, oid) {
  return new Promise((resolve, reject) => {
    const varbinds = [];
    session.subtree(
      oid,
      20,
      (results) => {
        for (const vb of results) {
          if (snmp.isVarbindError(vb)) continue;
          varbinds.push({ oid: vb.oid, value: vb.value });
        }
      },
      (error) => {
        if (error) reject(error);
        else resolve(varbinds);
      }
    );
  });
}

function valueToString(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function macFromBuffer(value) {
  if (!Buffer.isBuffer(value) || value.length !== 6) return null;
  return Array.from(value)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

async function testConnection(config) {
  const session = createSession(config);
  try {
    await new Promise((resolve, reject) => {
      session.get([SYS_DESCR_OID], (error, varbinds) => {
        if (error) return reject(error);
        if (snmp.isVarbindError(varbinds[0])) return reject(new Error(snmp.varbindError(varbinds[0])));
        resolve();
      });
    });
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    session.close();
  }
}

async function syncData(config, projectId, db) {
  const session = createSession(config);

  try {
    const systemVarbinds = await walk(session, SYSTEM_OID);
    const system = {};
    for (const vb of systemVarbinds) {
      if (vb.oid === SYS_NAME_OID) system.sysName = valueToString(vb.value);
      if (vb.oid === SYS_DESCR_OID) system.sysDescr = valueToString(vb.value);
    }

    const ifaceVarbinds = await walk(session, IFACES_OID);
    const ifaces = {};
    const prefix = `${IFACES_OID}.`;
    for (const vb of ifaceVarbinds) {
      if (!vb.oid.startsWith(prefix)) continue;
      const rest = vb.oid.slice(prefix.length).split('.');
      const [column, index] = rest;
      if (!ifaces[index]) ifaces[index] = {};
      if (column === IF_DESCR_COLUMN) ifaces[index].name = valueToString(vb.value);
      if (column === IF_PHYS_ADDR_COLUMN) ifaces[index].mac = macFromBuffer(vb.value);
    }

    const hostname = system.sysName || target(config);
    await upsertDevice(db, projectId, config.id, {
      hostname,
      ip: target(config),
      type: null,
      model: system.sysDescr || null,
      serial_number: null,
      status: 'up',
    });

    const [deviceRows] = await db.query('SELECT id FROM devices WHERE project_id = ? AND ip = ?', [
      projectId,
      target(config),
    ]);

    if (deviceRows.length > 0) {
      const deviceId = deviceRows[0].id;
      for (const iface of Object.values(ifaces)) {
        if (!iface.name) continue;
        const cleanName = translateInterfaceName(iface.name);
        const [existing] = await db.query(
          'SELECT id FROM topology_node_interfaces WHERE device_id = ? AND name IN (?, ?)',
          [deviceId, cleanName, iface.name]
        );
        if (existing.length === 0) {
          await db.query(
            `INSERT INTO topology_node_interfaces (project_id, device_id, name, description)
             VALUES (?, ?, ?, ?)`,
            [projectId, deviceId, cleanName, iface.mac ? `MAC ${iface.mac}` : null]
          );
        } else {
          await db.query('UPDATE topology_node_interfaces SET name = ? WHERE id = ?', [cleanName, existing[0].id]);
        }
      }
    }

    return { devices_imported: 1, vlans_imported: 0, status: 'success', message: null };
  } catch (err) {
    return { devices_imported: 0, vlans_imported: 0, status: 'failed', message: err.message };
  } finally {
    session.close();
  }
}

module.exports = { testConnection, syncData };
