-- Site-wide info: address, contacts, ISP details, WAN info.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS address                 TEXT         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS site_contact_name       VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS site_contact_phone      VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS site_contact_email      VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS primary_isp_name        VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS primary_isp_circuit_id  VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS primary_isp_contact     VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS secondary_isp_name      VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS secondary_isp_circuit_id VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS secondary_isp_contact   VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS wan_ip                  VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS wan_subnet              VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS wan_gateway             VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS dns_servers             VARCHAR(255) DEFAULT NULL;
