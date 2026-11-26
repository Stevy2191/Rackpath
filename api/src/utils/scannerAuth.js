const crypto = require('crypto');

// Shared secret between the API and the scanner service. The scanner runs on
// the host network, so without this anyone on the LAN could drive scans or
// post fake results back into the API.
const SCANNER_TOKEN = process.env.SCANNER_TOKEN || '';
const SCANNER_TOKEN_HEADER = 'x-scanner-token';

if (!SCANNER_TOKEN) {
  console.warn(
    'SCANNER_TOKEN is not set: the scanner will reject requests from the API and ' +
      'scan callbacks will be refused. Set SCANNER_TOKEN for both rackpath-api and rackpath-scanner.'
  );
}

function scannerHeaders() {
  return SCANNER_TOKEN ? { 'X-Scanner-Token': SCANNER_TOKEN } : {};
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Constant-time comparison; an unset token never matches.
function isValidScannerToken(value) {
  if (!SCANNER_TOKEN || typeof value !== 'string' || value.length === 0) return false;
  return crypto.timingSafeEqual(digest(value), digest(SCANNER_TOKEN));
}

module.exports = { scannerHeaders, isValidScannerToken, SCANNER_TOKEN_HEADER };
