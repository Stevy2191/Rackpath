"""Nmap-based port and OS detection scan for a single host."""

import re

import nmap

# Ports probed when a UDP port scan is requested. UDP scanning is slow (each
# closed port waits out a timeout plus retransmits), so we stick to a short
# list of high-value service ports instead of a top-N sweep.
COMMON_UDP_PORTS = (
    '53,67,69,111,123,137,138,161,162,500,514,520,623,631,1194,1434,1900,4500,5060,5353'
)


def _sanitize_port_range(port_range):
    """Strip everything but digits, commas and hyphens so a user-supplied port
    range can't inject extra nmap flags / shell tokens."""
    if not port_range:
        return ''
    cleaned = re.sub(r'[^0-9,\-]', '', str(port_range))
    return cleaned.strip(',')


def build_arguments(port_scan=True, port_range='top1000', os_detection=True,
                    service_detection=False):
    """Assemble the nmap argument string for the requested scan options."""
    args = ['-sS', '-T4']

    if port_scan:
        if port_range == 'top1000':
            args.append('--top-ports 1000')
        elif port_range == 'top100':
            args.append('-F')
        elif port_range == 'all':
            args.append('-p 1-65535')
        else:
            cleaned = _sanitize_port_range(port_range)
            args.append(f'-p {cleaned}' if cleaned else '--top-ports 1000')
    elif os_detection or service_detection:
        # OS / version detection needs some open|closed ports to work against,
        # so fall back to the top-1000 set even when no port scan was asked.
        args.append('--top-ports 1000')

    if os_detection:
        args.extend(['-O', '--osscan-guess'])
    if service_detection:
        args.append('-sV')

    return ' '.join(args)


def scan_host(ip, arguments=None, port_scan=True, port_range='top1000',
              os_detection=True, service_detection=False):
    """Run an nmap scan against `ip` using the given options.

    `arguments` may be passed to override the assembled flags directly.
    Requires the container to run with NET_RAW/NET_ADMIN capabilities
    (or as root) for -sS / -O to work.
    """
    if arguments is None:
        arguments = build_arguments(
            port_scan=port_scan,
            port_range=port_range,
            os_detection=os_detection,
            service_detection=service_detection,
        )

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


def scan_udp_ports(ip, ports=COMMON_UDP_PORTS):
    """Run a UDP-only nmap pass against the common UDP service ports.

    Returns port entries in the same shape as scan_host(). Kept as a separate
    pass (rather than -sS -sU combined) so the TCP port-range options never
    change UDP behaviour and vice versa. Requires NET_RAW/root like -sS.
    """
    scanner = nmap.PortScanner()

    try:
        scanner.scan(hosts=ip, arguments=f'-sU -T4 -p {ports}')
    except nmap.PortScannerError:
        return []

    if ip not in scanner.all_hosts():
        return []

    host_data = scanner[ip]
    results = []
    for proto in host_data.all_protocols():
        if proto != 'udp':
            continue
        for port_number, port_info in host_data[proto].items():
            results.append({
                "port_name": port_info.get('name'),
                "port_number": port_number,
                "protocol": 'udp',
                "state": port_info.get('state'),
                "service": port_info.get('product') or None,
                "speed": None,
            })
    return results
