"""mDNS / Bonjour discovery using zeroconf.

Browses common service types for a short window and builds a map of
IP address -> {hostname, services} for any responders on the local link.
Apple devices, printers and many IoT gadgets advertise here.
"""

import socket
import time

# A representative spread of service types: AirPlay/Apple, printers (IPP),
# file sharing, web, SSH and the generic device-info record.
SERVICE_TYPES = [
    "_airplay._tcp.local.",
    "_raop._tcp.local.",
    "_ipp._tcp.local.",
    "_ipps._tcp.local.",
    "_printer._tcp.local.",
    "_pdl-datastream._tcp.local.",
    "_smb._tcp.local.",
    "_afpovertcp._tcp.local.",
    "_http._tcp.local.",
    "_ssh._tcp.local.",
    "_device-info._tcp.local.",
    "_googlecast._tcp.local.",
    "_homekit._tcp.local.",
]


def discover(timeout=3.0):
    """Return {ip: {"hostname": str|None, "services": [type, ...]}}."""
    try:
        from zeroconf import Zeroconf, ServiceBrowser
    except Exception:
        return {}

    results = {}

    class _Listener:
        def _record(self, zc, type_, name):
            try:
                info = zc.get_service_info(type_, name, timeout=1500)
            except Exception:
                info = None
            if not info:
                return
            addresses = []
            try:
                addresses = [socket.inet_ntoa(addr) for addr in info.addresses if len(addr) == 4]
            except Exception:
                addresses = []
            server = (info.server or '').rstrip('.') or None
            for ip in addresses:
                entry = results.setdefault(ip, {"hostname": None, "services": []})
                if server and not entry["hostname"]:
                    entry["hostname"] = server
                short_type = type_.replace('._tcp.local.', '').replace('._udp.local.', '')
                if short_type not in entry["services"]:
                    entry["services"].append(short_type)

        def add_service(self, zc, type_, name):
            self._record(zc, type_, name)

        def update_service(self, zc, type_, name):
            self._record(zc, type_, name)

        def remove_service(self, zc, type_, name):
            pass

    zeroconf = None
    try:
        zeroconf = Zeroconf()
        listener = _Listener()
        for service_type in SERVICE_TYPES:
            ServiceBrowser(zeroconf, service_type, listener)
        time.sleep(timeout)
    except Exception:
        return results
    finally:
        if zeroconf is not None:
            try:
                zeroconf.close()
            except Exception:
                pass

    return results
