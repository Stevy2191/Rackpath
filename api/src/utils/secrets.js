const crypto = require('crypto');

// Application-level encryption for stored credentials (SNMP communities,
// device/camera/integration passwords, API keys). AES-256-GCM with a key that
// is separate from the JWT secret and never sent to the database.
//
// Stored format: "v1:" + base64(iv[12] | authTag[16] | ciphertext).

const PREFIX = 'v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadKey() {
  const hex = process.env.RACKPATH_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'RACKPATH_ENCRYPTION_KEY must be set to 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32'
    );
  }
  return Buffer.from(hex, 'hex');
}

const KEY = loadKey();

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// Encrypts a secret for storage. null, undefined and '' are stored as NULL.
function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

// Decrypts a stored secret. Returns null for NULL. Throws if the value was
// tampered with or encrypted under a different key.
function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === '') return null;
  if (!isEncrypted(stored)) throw new Error('Stored secret is not in the expected encrypted format');
  const data = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

// Returns a copy of `row` with each secret column replaced by a has_<column>
// boolean, so stored credentials never reach the browser.
function redactSecrets(row, columns) {
  if (!row) return row;
  const out = { ...row };
  for (const column of columns) {
    out[`has_${column}`] = out[column] !== null && out[column] !== undefined && out[column] !== '';
    delete out[column];
  }
  return out;
}

module.exports = { encryptSecret, decryptSecret, isEncrypted, redactSecrets };
