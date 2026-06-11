"""Multi-method host liveness check.

A host is considered "up" if it responds to ANY of:
  * ICMP echo (system ping)
  * a TCP connect to a common port (80/443/22)
  * a UDP probe (best effort, via scapy when raw sockets are available)

This mirrors Slitheris-style discovery, which catches hosts that drop ICMP but
still expose services.
"""

import errno
import platform
import socket
import subprocess

TCP_PROBE_PORTS = (80, 443, 22)
TCP_TIMEOUT = 0.6
UDP_PROBE_PORT = 137  # NetBIOS name service - commonly open on Windows hosts


def icmp_ping(ip):
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


def tcp_ping(ip, ports=TCP_PROBE_PORTS):
    for port in ports:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(TCP_TIMEOUT)
                # connect_ex returns 0 on success; a refused connection (econnrefused)
                # still proves the host is up, so treat that as alive too.
                rc = sock.connect_ex((str(ip), port))
                if rc == 0 or rc == errno.ECONNREFUSED:
                    return True
        except OSError:
            continue
    return False


def udp_ping(ip, port=UDP_PROBE_PORT, timeout=1):
    """Best-effort UDP liveness probe using scapy. Returns True if the host
    answers with a UDP reply or an ICMP error (which proves reachability).
    Silently returns False if scapy/raw sockets are unavailable."""
    try:
        from scapy.all import IP, UDP, ICMP, sr1
    except Exception:
        return False

    try:
        packet = IP(dst=str(ip)) / UDP(dport=port)
        reply = sr1(packet, timeout=timeout, verbose=False)
        return reply is not None
    except Exception:
        return False


def is_up(ip, icmp=True, tcp=True, udp=True):
    """Return True if the host responds to any of the enabled probe methods."""
    if icmp and icmp_ping(ip):
        return True
    if tcp and tcp_ping(ip):
        return True
    if udp and udp_ping(ip):
        return True
    return False
