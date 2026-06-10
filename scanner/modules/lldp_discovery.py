"""LLDP/CDP neighbor discovery via SNMP OIDs (LLDP-MIB and CISCO-CDP-MIB)."""

from .snmp_discovery import _walk

LLDP_REM_PORT_ID_OID = '1.0.8802.1.1.2.1.4.1.1.7'
LLDP_REM_SYS_NAME_OID = '1.0.8802.1.1.2.1.4.1.1.9'
LLDP_REM_SYS_DESC_OID = '1.0.8802.1.1.2.1.4.1.1.10'
CDP_CACHE_DEVICE_ID_OID = '1.3.6.1.4.1.9.9.23.1.2.1.1.6'
CDP_CACHE_DEVICE_PORT_OID = '1.3.6.1.4.1.9.9.23.1.2.1.1.7'


def _index_suffix(oid, base_oid):
    return oid[len(base_oid):]


def get_neighbors(ip, community):
    """Return a list of {protocol, neighbor_name, neighbor_port, neighbor_description} via LLDP and CDP SNMP tables."""
    neighbors = []

    lldp_names = _walk(ip, community, LLDP_REM_SYS_NAME_OID)
    lldp_ports = _walk(ip, community, LLDP_REM_PORT_ID_OID)
    lldp_descs = _walk(ip, community, LLDP_REM_SYS_DESC_OID)
    lldp_ports_by_index = {
        _index_suffix(oid, LLDP_REM_PORT_ID_OID): value for oid, value in lldp_ports.items()
    }
    lldp_descs_by_index = {
        _index_suffix(oid, LLDP_REM_SYS_DESC_OID): value for oid, value in lldp_descs.items()
    }
    for oid, name in lldp_names.items():
        index = _index_suffix(oid, LLDP_REM_SYS_NAME_OID)
        neighbors.append({
            "protocol": "LLDP",
            "neighbor_name": name,
            "neighbor_port": lldp_ports_by_index.get(index),
            "neighbor_description": lldp_descs_by_index.get(index),
        })

    cdp_names = _walk(ip, community, CDP_CACHE_DEVICE_ID_OID)
    cdp_ports = _walk(ip, community, CDP_CACHE_DEVICE_PORT_OID)
    cdp_ports_by_index = {
        _index_suffix(oid, CDP_CACHE_DEVICE_PORT_OID): value for oid, value in cdp_ports.items()
    }
    for oid, name in cdp_names.items():
        index = _index_suffix(oid, CDP_CACHE_DEVICE_ID_OID)
        neighbors.append({
            "protocol": "CDP",
            "neighbor_name": name,
            "neighbor_port": cdp_ports_by_index.get(index),
            "neighbor_description": None,
        })

    return neighbors
