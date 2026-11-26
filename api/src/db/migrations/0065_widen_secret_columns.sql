-- Credentials are now encrypted in the API (AES-256-GCM, "v1:" + base64),
-- which is longer than the plaintext, so widen every secret column. Existing
-- values are encrypted in place at startup by src/db/encryptSecrets.js.
ALTER TABLE project_credential_macros MODIFY COLUMN community_string VARCHAR(1024) NULL;
ALTER TABLE project_credential_macros MODIFY COLUMN password VARCHAR(1024) NULL;
ALTER TABLE project_credential_macros MODIFY COLUMN auth_password VARCHAR(1024) NULL;
ALTER TABLE project_credential_macros MODIFY COLUMN priv_password VARCHAR(1024) NULL;
ALTER TABLE project_cameras MODIFY COLUMN stream_password VARCHAR(1024) NULL;
ALTER TABLE scan_jobs MODIFY COLUMN snmp_community VARCHAR(1024) NULL;
ALTER TABLE project_integrations MODIFY COLUMN password VARCHAR(1024) NULL;
ALTER TABLE project_integrations MODIFY COLUMN api_key VARCHAR(1024) NULL;
