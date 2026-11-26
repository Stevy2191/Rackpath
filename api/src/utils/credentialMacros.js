const { decryptSecret } = require('./secrets');

// Credential-macro columns that hold secrets (encrypted at rest, never
// returned to the browser).
const MACRO_SECRET_FIELDS = ['community_string', 'password', 'auth_password', 'priv_password'];

// Returns a copy of a project_credential_macros row with its secrets
// decrypted, for server-side use (SNMP polling, scan enrichment).
function decryptMacro(macro) {
  if (!macro) return macro;
  const out = { ...macro };
  for (const field of MACRO_SECRET_FIELDS) out[field] = decryptSecret(macro[field]);
  return out;
}

module.exports = { MACRO_SECRET_FIELDS, decryptMacro };
