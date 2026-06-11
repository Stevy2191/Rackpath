"""Heuristic device-type inference.

Combines the signals gathered for a host - OS detection, open ports, NetBIOS,
mDNS services, SNMP sysDescr and MAC vendor - into a single best-guess device
type from a fixed vocabulary.
"""

DEVICE_TYPES = [
    "Router", "Switch", "Firewall", "Server", "Windows PC", "Mac",
    "Linux", "Printer", "AP", "IP Camera", "IoT", "NAS", "Unknown",
]

# MAC-vendor substrings that strongly imply a category.
VENDOR_HINTS = [
    (["cisco", "juniper", "arista", "mikrotik", "ubiquiti", "netgear", "tp-link", "aruba"], "Switch"),
    (["fortinet", "palo alto", "sonicwall", "watchguard"], "Firewall"),
    (["hewlett", "hp ", "brother", "canon", "epson", "lexmark", "xerox", "ricoh", "kyocera"], "Printer"),
    (["apple"], "Mac"),
    (["synology", "qnap", "netapp", "western digital"], "NAS"),
    (["hikvision", "dahua", "axis", "amcrest"], "IP Camera"),
    (["raspberry"], "Linux"),
    (["sonos", "nest", "ecobee", "philips", "espressif", "tuya", "amazon technologies"], "IoT"),
]


def _t(value):
    return (value or "").lower()


def infer(*, os_guess=None, ports=None, snmp_descr=None, netbios_name=None,
          mdns_services=None, mac_vendor=None):
    ports = set(ports or [])
    services = [_t(s) for s in (mdns_services or [])]
    descr = _t(snmp_descr)
    os_l = _t(os_guess)
    vendor = _t(mac_vendor)

    # --- Strong signals from SNMP sysDescr (managed infrastructure) ---------
    if descr:
        if any(k in descr for k in ("router", "routeros", "ios xe", "ios-xe")):
            return "Router"
        if any(k in descr for k in ("switch", "catalyst", "nexus", "procurve", "powerconnect")):
            return "Switch"
        if any(k in descr for k in ("firewall", "fortigate", "pan-os", "asa ", "sonicwall")):
            return "Firewall"
        if any(k in descr for k in ("access point", "aironet", "wireless")):
            return "AP"
        if "printer" in descr or "jetdirect" in descr:
            return "Printer"

    # --- mDNS service advertisements ---------------------------------------
    if any(s in ("ipp", "ipps", "printer", "pdl-datastream") for s in services):
        return "Printer"
    if any(s in ("airplay", "raop", "homekit") for s in services):
        if "apple" in vendor:
            return "Mac"
        return "IoT"
    if "googlecast" in services:
        return "IoT"

    # --- Port-based fingerprints -------------------------------------------
    if {515, 631, 9100} & ports:
        return "Printer"
    if {554, 8554} & ports and "server" not in os_l:
        return "IP Camera"
    if {139, 445} & ports and {548, 5000, 5001} & ports:
        return "NAS"

    # --- MAC vendor hints ---------------------------------------------------
    for needles, label in VENDOR_HINTS:
        if any(n in vendor for n in needles):
            # Don't let a generic "Mac" override an obvious Windows OS match.
            if label == "Mac" and "windows" in os_l:
                break
            return label

    # --- OS detection -------------------------------------------------------
    if "windows" in os_l:
        if any(k in os_l for k in ("server", "datacenter")):
            return "Server"
        return "Windows PC"
    if any(k in os_l for k in ("mac os", "macos", "os x", "darwin", "iphone", "ipad")):
        return "Mac"
    if "linux" in os_l or "unix" in os_l:
        # A Linux box exposing typical server ports is most likely a server.
        if {22, 80, 443, 3306, 5432, 25, 53} & ports:
            return "Server"
        return "Linux"

    # --- NetBIOS implies a Windows host ------------------------------------
    if netbios_name:
        return "Windows PC"

    # --- Lightweight catch-alls --------------------------------------------
    if ports and ports.issubset({80, 443, 23, 8080}):
        return "IoT"
    if {22, 80, 443} & ports:
        return "Server"

    return "Unknown"
