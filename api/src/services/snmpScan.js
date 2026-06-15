const snmp = require('net-snmp');

const SYSTEM_OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysContact: '1.3.6.1.2.1.1.4.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
};

const IF_TABLE_OID = '1.3.6.1.2.1.2.2';
const IP_ADDR_TABLE_OID = '1.3.6.1.2.1.4.20';

const IF_STATUS_LABELS = { 1: 'up', 2: 'down', 3: 'testing' };

function bufToStr(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

function formatUptime(ticks) {
  const totalSeconds = Math.floor(Number(ticks) / 100);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatSpeed(bps) {
  const n = Number(bps);
  if (!n) return null;
  if (n >= 1e9) return `${n / 1e9} Gbps`;
  if (n >= 1e6) return `${n / 1e6} Mbps`;
  if (n >= 1e3) return `${n / 1e3} Kbps`;
  return `${n} bps`;
}

function createSession(ip, macro, { timeout = 5000, retries = 1 } = {}) {
  const port = macro.port || 161;

  if (macro.type === 'snmp_v3') {
    let level = snmp.SecurityLevel.noAuthNoPriv;
    if (macro.auth_password && macro.priv_password) level = snmp.SecurityLevel.authPriv;
    else if (macro.auth_password) level = snmp.SecurityLevel.authNoPriv;

    const user = {
      name: macro.username,
      level,
      authProtocol: macro.auth_protocol === 'SHA' ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5,
      authKey: macro.auth_password || undefined,
      privProtocol: macro.priv_protocol === 'AES' ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des,
      privKey: macro.priv_password || undefined,
    };
    return snmp.createV3Session(ip, user, { port, version: snmp.Version3, timeout, retries });
  }

  const version = macro.type === 'snmp_v1' ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(ip, macro.community_string || 'public', { port, version, timeout, retries });
}

function snmpGet(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (error, varbinds) => {
      if (error) return reject(error);
      resolve(varbinds);
    });
  });
}

function snmpTable(session, oid) {
  return new Promise((resolve, reject) => {
    session.table(oid, 20, (error, table) => {
      if (error) return reject(error);
      resolve(table || {});
    });
  });
}

function varbindValue(varbinds, oid) {
  const vb = varbinds.find((v) => v.oid === oid);
  if (!vb || snmp.isVarbindError(vb)) return null;
  return bufToStr(vb.value);
}

// Performs an SNMP scan of `ip` using the given credential macro row, and
// returns parsed system info plus discovered interfaces/IP addresses.
async function scanDevice(ip, macro) {
  const session = createSession(ip, macro);
  try {
    const sysVarbinds = await snmpGet(session, Object.values(SYSTEM_OIDS));

    const sysUpTimeRaw = varbindValue(sysVarbinds, SYSTEM_OIDS.sysUpTime);

    const ifTable = await snmpTable(session, IF_TABLE_OID);
    const interfaces = Object.keys(ifTable)
      .map((index) => {
        const row = ifTable[index];
        return {
          index: Number(index),
          name: bufToStr(row[2]) || `Interface ${index}`,
          speed: formatSpeed(row[5]),
          adminStatus: IF_STATUS_LABELS[row[7]] || 'unknown',
          operStatus: IF_STATUS_LABELS[row[8]] || 'unknown',
        };
      })
      .sort((a, b) => a.index - b.index);

    const ipTable = await snmpTable(session, IP_ADDR_TABLE_OID);
    const ips = Object.keys(ipTable).map((index) => {
      const row = ipTable[index];
      return {
        address: index,
        ifIndex: row[2] != null ? Number(row[2]) : null,
        netmask: row[3] || null,
      };
    });

    return {
      sysName: varbindValue(sysVarbinds, SYSTEM_OIDS.sysName),
      sysDescr: varbindValue(sysVarbinds, SYSTEM_OIDS.sysDescr),
      sysObjectID: varbindValue(sysVarbinds, SYSTEM_OIDS.sysObjectID),
      sysContact: varbindValue(sysVarbinds, SYSTEM_OIDS.sysContact),
      sysLocation: varbindValue(sysVarbinds, SYSTEM_OIDS.sysLocation),
      uptime: sysUpTimeRaw != null ? formatUptime(sysUpTimeRaw) : null,
      interfaces,
      ips,
    };
  } finally {
    session.close();
  }
}

// Lightweight system-info probe used by subnet-scan SNMP enrichment: a single
// GET of the four system OIDs with a short timeout (so trying several macros
// against many non-SNMP hosts fails fast). Returns null if the host doesn't
// answer SNMP with these credentials.
async function getSystemInfo(ip, macro, { timeout = 1500, retries = 0 } = {}) {
  const session = createSession(ip, macro, { timeout, retries });
  try {
    const varbinds = await snmpGet(session, [
      SYSTEM_OIDS.sysDescr,
      SYSTEM_OIDS.sysName,
      SYSTEM_OIDS.sysLocation,
      SYSTEM_OIDS.sysObjectID,
    ]);
    const sysDescr = varbindValue(varbinds, SYSTEM_OIDS.sysDescr);
    const sysName = varbindValue(varbinds, SYSTEM_OIDS.sysName);
    if (sysDescr == null && sysName == null) return null;
    return {
      sysDescr,
      sysName,
      sysLocation: varbindValue(varbinds, SYSTEM_OIDS.sysLocation),
      sysObjectID: varbindValue(varbinds, SYSTEM_OIDS.sysObjectID),
    };
  } catch (err) {
    return null;
  } finally {
    session.close();
  }
}

module.exports = { scanDevice, getSystemInfo };
