-- Rackpath v2: an address is either documented (in use) or free; how it's
-- given out is static, DHCP or a DHCP reservation, worked out from its
-- reservation flag and the DHCP pools. The "reserved" and "deprecated"
-- statuses are gone: every documented address is "assigned".
UPDATE ip_addresses SET status = 'assigned' WHERE status <> 'assigned';

-- A UniFi fixed IP outside every DHCP pool is a static address (a host set
-- up statically), not a DHCP reservation. Windows reservations are left as
-- they are (they often sit in an exclusion, outside the pool).
UPDATE ip_addresses SET dhcp_reservation = 0
WHERE dhcp_reservation = 1
  AND source_integration_id IN (SELECT id FROM integrations WHERE kind = 'unifi')
  AND NOT EXISTS (
      SELECT 1 FROM ip_ranges r JOIN prefixes p ON p.id = r.prefix_id
      WHERE r.kind = 'dhcp_pool' AND p.space_id = ip_addresses.space_id AND p.family = ip_addresses.family
        AND ip_addresses.addr_bin BETWEEN r.start_bin AND r.end_bin);
