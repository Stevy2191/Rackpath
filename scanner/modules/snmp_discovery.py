"""SNMP v2c helpers for system info, interface tables, and ARP tables."""

from puresnmp import get as snmp_get, walk as snmp_walk

SYS_NAME_OID = '1.3.6.1.2.1.1.5.0'
SYS_DESCR_OID = '1.3.6.1.2.1.1.1.0'
IF_DESCR_OID = '1.3.6.1.2.1.2.2.1.2'
IF_SPEED_OID = '1.3.6.1.2.1.2.2.1.5'
IP_NET_TO_MEDIA_PHYS_ADDRESS_OID = '1.3.6.1.2.1.4.22.1.2'

SNMP_TIMEOUT = 1


def _decode(value):
    """Render a puresnmp value as text: printable bytes decode to str, binary bytes become 0x-hex."""
    if isinstance(value, bytes):
        try:
            return value.decode('ascii')
        except UnicodeDecodeError:
            return '0x' + value.hex()
    return str(value)


def _get(ip, community, oid):
    try:
        value = snmp_get(ip, community, oid, timeout=SNMP_TIMEOUT)
    except Exception:
        return None

    return _decode(value)


def _walk(ip, community, oid):
    results = {}
    try:
        for varbind in snmp_walk(ip, community, oid, timeout=SNMP_TIMEOUT):
            results[str(varbind.oid)] = _decode(varbind.value)
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
