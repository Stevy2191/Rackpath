-- The previous SNMP interface-name translation mapped UniFi switch ports
-- ("Slot: 0 Port: N Gigabit - Level") to "PortN". That's now translated to
-- "ethN" (1-indexed, same N) instead, so rename any rows saved with the old
-- "PortN" format to match.
--
-- Interfaces already named "eth<N>" were either translated by this same
-- 1-indexed rule already, manually added, or genuinely reported as eth0/ethN
-- by the device itself (router/AP) — left as-is, since there's no reliable
-- way to recompute the original ifIndex from the stored name alone.
UPDATE topology_node_interfaces
SET name = CONCAT('eth', SUBSTRING(name, 5))
WHERE name REGEXP '^Port[0-9]+$';
