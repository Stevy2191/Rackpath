"""Ping sweep helper - checks which hosts in a CIDR subnet respond to ICMP."""

import concurrent.futures
import ipaddress
import platform
import subprocess


def _ping(ip):
    is_windows = platform.system().lower() == 'windows'
    count_flag = '-n' if is_windows else '-c'
    timeout_flag = '-w' if is_windows else '-W'
    timeout_value = '1000' if is_windows else '1'

    cmd = ['ping', count_flag, '1', timeout_flag, timeout_value, str(ip)]
    try:
        result = subprocess.run(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2
        )
        return result.returncode == 0
    except Exception:
        return False


def sweep(cidr, max_workers=64):
    """Return a sorted list of IPs in `cidr` that respond to ping."""
    network = ipaddress.ip_network(cidr, strict=False)
    hosts = [str(ip) for ip in network.hosts()]

    live = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_ip = {executor.submit(_ping, ip): ip for ip in hosts}
        for future in concurrent.futures.as_completed(future_to_ip):
            ip = future_to_ip[future]
            if future.result():
                live.append(ip)

    return sorted(live, key=lambda ip: tuple(int(part) for part in ip.split('.')))
