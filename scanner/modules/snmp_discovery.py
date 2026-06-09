"""SNMP v2c helpers for system info, interface tables, and ARP tables."""

from pysnmp.hlapi import (
    CommunityData,
    ContextData,
    ObjectIdentity,
    ObjectType,
    SnmpEngine,
    UdpTransportTarget,
    getCmd,
    nextCmd,
)

SYS_NAME_OID = '1.3.6.1.2.1.1.5.0'
SYS_DESCR_OID = '1.3.6.1.2.1.1.1.0'
IF_DESCR_OID = '1.3.6.1.2.1.2.2.1.2'
IF_SPEED_OID = '1.3.6.1.2.1.2.2.1.5'
IP_NET_TO_MEDIA_PHYS_ADDRESS_OID = '1.3.6.1.2.1.4.22.1.2'

SNMP_TIMEOUT = 1
SNMP_RETRIES = 0


def _get(ip, community, oid):
    iterator = getCmd(
        SnmpEngine(),
        CommunityData(community, mpModel=1),
        UdpTransportTarget((ip, 161), timeout=SNMP_TIMEOUT, retries=SNMP_RETRIES),
        ContextData(),
        ObjectType(ObjectIdentity(oid)),
    )
    try:
        error_indication, error_status, _error_index, var_binds = next(iterator)
    except Exception:
        return None

    if error_indication or error_status:
        return None

    for var_bind in var_binds:
        return str(var_bind[1])
    return None


def _walk(ip, community, oid):
    results = {}
    iterator = nextCmd(
        SnmpEngine(),
        CommunityData(community, mpModel=1),
        UdpTransportTarget((ip, 161), timeout=SNMP_TIMEOUT, retries=SNMP_RETRIES),
        ContextData(),
        ObjectType(ObjectIdentity(oid)),
        lexicographicMode=False,
    )

    try:
        for error_indication, error_status, _error_index, var_binds in iterator:
            if error_indication or error_status:
                break
            for var_bind in var_binds:
                results[str(var_bind[0])] = str(var_bind[1])
    except Exception:
        return {}

    return results


def get_system_info(ip, community):
    """Return {sysName, sysDescr} or {} if the device doesn't respond to SNMP."""
    sys_name = _get(ip, community, SYS_NAME_OID)
    sys_descr = _get(ip, community, SYS_DESCR_OID)

    if sys_name is None and sys_descr is None:
        return {}

    return {"sysName": sys_name, "sysDescr": sys_descr}


def get_interfaces(ip, community):
    """Return a list of {port_name, port_number, speed} from the IF-MIB interface table."""
    descrs = _walk(ip, community, IF_DESCR_OID)
    speeds = _walk(ip, community, IF_SPEED_OID)

    interfaces = []
    for oid, name in descrs.items():
        index = oid.rsplit('.', 1)[-1]
        speed_oid = f'{IF_SPEED_OID}.{index}'
        interfaces.append({
            "port_name": name,
            "port_number": int(index),
            "speed": speeds.get(speed_oid),
        })

    return interfaces


def get_arp_table(ip, community):
    """Return {ip_address: mac_address} from the device's ipNetToMediaTable."""
    entries = _walk(ip, community, IP_NET_TO_MEDIA_PHYS_ADDRESS_OID)

    arp = {}
    for oid, mac_hex in entries.items():
        ip_addr = '.'.join(oid.split('.')[-4:])
        arp[ip_addr] = mac_hex

    return arp
