"""Nmap-based port and OS detection scan for a single host."""

import nmap


def scan_host(ip, arguments='-sS -O --osscan-guess -F -T4'):
    """Run an nmap SYN scan with OS detection and the top 100 ports (-F) against `ip`.

    Requires the container to run with NET_RAW/NET_ADMIN capabilities
    (or as root) for -sS / -O to work.
    """
    scanner = nmap.PortScanner()

    try:
        scanner.scan(hosts=ip, arguments=arguments)
    except nmap.PortScannerError as exc:
        return {"ip": ip, "error": str(exc), "ports": [], "hostname": None, "os_guess": None}

    if ip not in scanner.all_hosts():
        return {"ip": ip, "ports": [], "hostname": None, "os_guess": None}

    host_data = scanner[ip]

    ports = []
    for proto in host_data.all_protocols():
        for port_number, port_info in host_data[proto].items():
            ports.append({
                "port_name": port_info.get('name'),
                "port_number": port_number,
                "protocol": proto,
                "state": port_info.get('state'),
                "service": port_info.get('product') or None,
                "speed": None,
            })

    os_guess = None
    if host_data.get('osmatch'):
        os_guess = host_data['osmatch'][0].get('name')

    hostname = None
    if host_data.hostnames():
        hostname = host_data.hostnames()[0].get('name') or None

    return {
        "ip": ip,
        "hostname": hostname,
        "os_guess": os_guess,
        "ports": ports,
    }
