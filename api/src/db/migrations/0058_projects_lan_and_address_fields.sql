-- LAN network info, alongside the existing WAN fields (0057_projects_site_fields.sql).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS lan_ip      VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lan_subnet  VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lan_gateway VARCHAR(100) DEFAULT NULL;

-- Split the single `address` textarea into structured fields. `address` is
-- kept for backwards compatibility (older rows still have it) but is no
-- longer written by new saves - the Site Info panel now reads/writes the
-- columns below.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS address_street VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS address_city   VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS address_state  VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS address_zip    VARCHAR(20)  DEFAULT NULL;
