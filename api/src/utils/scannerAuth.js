const crypto = require('crypto');

// Shared secret between the API and the scanner service. The scanner runs on
// the host network, so without this anyone on the LAN could drive scans or
// post fake results back into the API.
const SCANNER_TOKEN = process.env.SCANNER_TOKEN || '';
const SCANNER_TOKEN_HEADER = 'x-scanner-token';

if (SCANNER_TOKEN.length < 32) {
  throw new Error(
    'SCANNER_TOKEN must be set (at least 32 characters) for both rackpath-api and rackpath-scanner. ' +
      'Generate one with: openssl rand -hex 32'
  );
}

function scannerHeaders() {
  return { 'X-Scanner-Token': SCANNER_TOKEN };
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Constant-time comparison.
function isValidScannerToken(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return crypto.timingSafeEqual(digest(value), digest(SCANNER_TOKEN));
}

module.exports = { scannerHeaders, isValidScannerToken, SCANNER_TOKEN_HEADER };
