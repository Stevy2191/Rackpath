"""Rackpath scanner service.

Exposes a small REST API the rackpath-api service calls to trigger network
discovery jobs. Discovery is Slitheris-style: multi-method liveness probing
followed by parallel per-host enrichment (nmap + OS detection, NetBIOS/SMB,
mDNS/Bonjour, SNMP, ARP/MAC, OUI vendor lookup) with a device-type guess.

As each host is fully enriched it is POSTed back to the API immediately so the
frontend can stream rows over SSE in real time.
"""

import concurrent.futures
import ipaddress
import os
import re
import threading

import requests
from flask import Flask, jsonify, request

from modules import (
    arp_table,
    device_type,
    lldp_discovery,
    mdns_discovery,
    multi_ping,
    netbios,
    network_tools,
    nmap_scan,
    oui_lookup,
    snmp_discovery,
)

app = Flask(__name__)

DEFAULT_SNMP_COMMUNITY = os.environ.get('SNMP_COMMUNITY', 'public')
PING_WORKERS = int(os.environ.get('SCAN_PING_WORKERS', 128))
ENRICH_WORKERS = int(os.environ.get('SCAN_ENRICH_WORKERS', 16))

# In-memory job status tracking, keyed by job_id (as provided by the API).
jobs = {}


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok"})


def _resolve_options(options):
    """Normalize the scan options payload into a dict of concrete flags.

    Missing options default to a Standard-style scan so older callers that
    don't send an options object keep their previous behaviour."""
    o = options or {}

    def flag(key, default):
        value = o.get(key)
        return default if value is None else bool(value)

    return {
        'icmp_ping': flag('icmp_ping', True),
        'tcp_ping': flag('tcp_ping', True),
        'udp_ping': flag('udp_ping', False),
        'port_scan': flag('port_scan', True),
        'port_range': o.get('port_range') or 'top1000',
        'os_detection': flag('os_detection', True),
        'service_detection': flag('service_detection', False),
        'snmp': flag('snmp', True),
        'netbios': flag('netbios', True),
        'mdns': flag('mdns', True),
        'mac_vendor': flag('mac_vendor', True),
    }


@app.route('/scan', methods=['POST'])
def start_scan():
    data = request.get_json(force=True, silent=True) or {}

    job_id = data.get('job_id')
    target_subnet = data.get('target_subnet')
    snmp_community = data.get('snmp_community') or DEFAULT_SNMP_COMMUNITY
    callback_url = data.get('callback_url')
    host_callback_url = data.get('host_callback_url')
    progress_callback_url = data.get('progress_callback_url')
    options = _resolve_options(data.get('options'))

    if not target_subnet:
        return jsonify({"error": "target_subnet is required"}), 400

    jobs[job_id] = {"status": "running", "target_subnet": target_subnet}

    thread = threading.Thread(
        target=_run_scan,
        args=(job_id, target_subnet, snmp_community, callback_url,
              host_callback_url, progress_callback_url, options),
        daemon=True,
    )
    thread.start()

    return jsonify({"job_id": job_id, "status": "started"}), 202


@app.route('/scan/<job_id>', methods=['GET'])
def scan_status(job_id):
    job = jobs.get(job_id)
    if job is None:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job)


# --- Simple synchronous diagnostic tools ----------------------------------
# Unlike /scan above, these are quick on-demand operations: run, parse,
# respond - no job tracking or callbacks.

@app.route('/tools/ping', methods=['POST'])
def tools_ping():
    data = request.get_json(force=True, silent=True) or {}
    host = data.get('host')
    if not host:
        return jsonify({"error": "host is required"}), 400
    try:
        return jsonify(network_tools.run_ping(host, data.get('count', 4)))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route('/tools/traceroute', methods=['POST'])
def tools_traceroute():
    data = request.get_json(force=True, silent=True) or {}
    host = data.get('host')
    if not host:
        return jsonify({"error": "host is required"}), 400
    try:
        return jsonify(network_tools.run_traceroute(host, data.get('max_hops', 30)))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route('/tools/dns', methods=['POST'])
def tools_dns():
    data = request.get_json(force=True, silent=True) or {}
    host = data.get('host')
    if not host:
        return jsonify({"error": "host is required"}), 400
    try:
        return jsonify(network_tools.run_dns_lookup(host, data.get('record_type', 'A')))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route('/tools/snmp-stats', methods=['POST'])
def tools_snmp_stats():
    data = request.get_json(force=True, silent=True) or {}
    host = data.get('host')
    if not host:
        return jsonify({"error": "host is required"}), 400
    stats = data.get('stats') or ['system', 'cpu', 'memory', 'interfaces']
    if not isinstance(stats, list):
        return jsonify({"error": "stats must be a list"}), 400
    try:
        result = network_tools.run_snmp_stats(
            host=host,
            version=data.get('version', '2c'),
            community=data.get('community', 'public'),
            v3_user=data.get('v3_user') or '',
            v3_auth_protocol=data.get('v3_auth_protocol') or 'MD5',
            v3_auth_password=data.get('v3_auth_password') or '',
            v3_priv_protocol=data.get('v3_priv_protocol') or 'AES',
            v3_priv_password=data.get('v3_priv_password') or '',
            stats=stats,
        )
        return jsonify(result)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"SNMP query failed: {exc}"}), 500


def _derive_callbacks(callback_url, host_callback_url, progress_callback_url):
    """Fill in host/progress callback URLs from the results callback if the API
    didn't supply them explicitly (keeps backwards compatibility)."""
    if callback_url:
        if not host_callback_url:
            host_callback_url = callback_url.replace('/results', '/host')
        if not progress_callback_url:
            progress_callback_url = callback_url.replace('/results', '/progress')
    return host_callback_url, progress_callback_url


def _enrich_host(ip, snmp_community, local_arp, mdns_map, opts):
    """Run the enrichment pipeline for a single live host, honouring `opts` so
    disabled steps are skipped. Returns the flattened result row plus the extra
    detail used for inventory import."""
    need_nmap = opts['port_scan'] or opts['os_detection'] or opts['service_detection']
    if need_nmap:
        nmap_result = nmap_scan.scan_host(
            ip,
            port_scan=opts['port_scan'],
            port_range=opts['port_range'],
            os_detection=opts['os_detection'],
            service_detection=opts['service_detection'],
        )
    else:
        nmap_result = {"ports": [], "hostname": None, "os_guess": None}

    # MAC: prefer the kernel ARP cache, fall back to an active ARP probe.
    mac = local_arp.get(ip)
    if not mac:
        try:
            probed = arp_table.send_arp_probe(ip)
            mac = probed.get(ip)
        except Exception:
            mac = None
    mac_vendor = oui_lookup.lookup(mac) if opts['mac_vendor'] else None

    nb = netbios.query(ip) if opts['netbios'] else {"netbios_name": None, "workgroup": None}

    mdns_entry = mdns_map.get(ip, {}) if opts['mdns'] else {}
    mdns_services = mdns_entry.get("services", [])

    if opts['snmp']:
        snmp_info = snmp_discovery.get_system_info(ip, snmp_community)
        interfaces = snmp_discovery.get_interfaces(ip, snmp_community) if snmp_info else []
        neighbors = lldp_discovery.get_neighbors(ip, snmp_community) if snmp_info else []
        snmp_arp = snmp_discovery.get_arp_table(ip, snmp_community) if snmp_info else {}
    else:
        snmp_info = {}
        interfaces = []
        neighbors = []
        snmp_arp = {}

    open_ports = sorted(
        p["port_number"]
        for p in nmap_result.get("ports", [])
        if p.get("state") == "open" and p.get("protocol") == "tcp"
    ) if opts['port_scan'] else []

    hostname = (
        (snmp_info.get("sysName") if snmp_info else None)
        or nmap_result.get("hostname")
        or mdns_entry.get("hostname")
        or nb.get("netbios_name")
    )

    inferred = device_type.infer(
        os_guess=nmap_result.get("os_guess"),
        ports=open_ports,
        snmp_descr=snmp_info.get("sysDescr") if snmp_info else None,
        netbios_name=nb.get("netbios_name"),
        mdns_services=mdns_services,
        mac_vendor=mac_vendor,
    )

    # Ports for inventory import: nmap ports + SNMP interfaces.
    import_ports = list(nmap_result.get("ports", []))
    for iface in interfaces:
        import_ports.append({
            "port_name": iface["port_name"],
            "port_number": iface["port_number"],
            "speed": iface["speed"],
        })

    host_row = {
        "status": "up",
        "ip": ip,
        "hostname": hostname,
        "mac": mac,
        "mac_vendor": mac_vendor,
        "device_type": inferred,
        # OS is intentionally left blank here: nmap's range-style OS guesses
        # (e.g. "Linux 5.18" / "FortiOS 6.2 - 7.2") are inaccurate, so the API
        # fills this in from SNMP sysDescr during enrichment when available.
        "os": None,
        "open_ports": open_ports,
        "netbios_name": nb.get("netbios_name"),
        "raw": {
            "snmp_descr": snmp_info.get("sysDescr") if snmp_info else None,
            "snmp_community": snmp_community if snmp_info else None,
            "workgroup": nb.get("workgroup"),
            "mdns_services": mdns_services,
            "neighbors": neighbors,
            "snmp_arp_table": snmp_arp,
            "ports": import_ports,
        },
    }
    return host_row


def _expand_targets(target_subnet):
    """Return the list of host IPs to scan.

    Accepts a single address, a CIDR, or a comma/whitespace/newline-separated
    list of addresses and CIDRs (the "Multiple IPs" target type). Each CIDR is
    expanded to its hosts; duplicates are removed while preserving order."""
    tokens = re.split(r'[\s,]+', target_subnet.strip())
    hosts = []
    seen = set()
    for token in tokens:
        if not token:
            continue
        if '/' in token:
            try:
                network = ipaddress.ip_network(token, strict=False)
                expanded = [str(ip) for ip in network.hosts()]
            except ValueError:
                expanded = []
        else:
            expanded = [token]
        for ip in expanded:
            if ip not in seen:
                seen.add(ip)
                hosts.append(ip)
    return hosts


def _run_scan(job_id, target_subnet, snmp_community, callback_url,
              host_callback_url, progress_callback_url, opts=None):
    host_callback_url, progress_callback_url = _derive_callbacks(
        callback_url, host_callback_url, progress_callback_url
    )
    opts = opts or _resolve_options(None)

    try:
        all_hosts = _expand_targets(target_subnet)
        total = len(all_hosts)

        # Kick off a one-shot mDNS browse for the whole link in the background
        # (only when enabled); results are collected before enrichment reads it.
        mdns_map = {}
        mdns_holder = {}
        mdns_thread = None
        if opts['mdns']:
            def _mdns_worker():
                mdns_holder["map"] = mdns_discovery.discover(timeout=4.0)

            mdns_thread = threading.Thread(target=_mdns_worker, daemon=True)
            mdns_thread.start()

        jobs[job_id] = {
            "status": "running", "target_subnet": target_subnet,
            "progress_current": 0, "progress_total": total,
        }
        _post_callback(progress_callback_url, {"progress_current": 0, "progress_total": total})

        # --- Phase 1: multi-method liveness sweep over the whole subnet ------
        use_ping = opts['icmp_ping'] or opts['tcp_ping'] or opts['udp_ping']
        if not use_ping:
            # No liveness method enabled - treat every target as a host to scan.
            live_hosts = list(all_hosts)
            _post_callback(progress_callback_url,
                           {"progress_current": total, "progress_total": total})
        else:
            live_hosts = []
            scanned = 0
            with concurrent.futures.ThreadPoolExecutor(max_workers=PING_WORKERS) as executor:
                future_to_ip = {
                    executor.submit(
                        multi_ping.is_up, ip,
                        icmp=opts['icmp_ping'], tcp=opts['tcp_ping'], udp=opts['udp_ping'],
                    ): ip
                    for ip in all_hosts
                }
                for future in concurrent.futures.as_completed(future_to_ip):
                    ip = future_to_ip[future]
                    scanned += 1
                    try:
                        if future.result():
                            live_hosts.append(ip)
                    except Exception:
                        pass
                    jobs[job_id]["progress_current"] = scanned
                    # Throttle progress posts a little so we don't flood the API.
                    if scanned % 8 == 0 or scanned == total:
                        _post_callback(progress_callback_url,
                                       {"progress_current": scanned, "progress_total": total})

        def _sort_key(ip):
            # Sort by numeric IPv4 octets; fall back to string order for
            # anything that isn't a plain dotted-quad (hostnames, IPv6, etc).
            try:
                return (0, tuple(int(p) for p in ip.split('.')))
            except (ValueError, AttributeError):
                return (1, ip)

        live_hosts.sort(key=_sort_key)

        # Make sure the mDNS browse has finished before enrichment reads it.
        if mdns_thread is not None:
            mdns_thread.join(timeout=6.0)
            mdns_map = mdns_holder.get("map", {})

        local_arp = arp_table.read_arp_table()

        # --- Phase 2: parallel per-host enrichment, streaming each row -------
        devices = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=ENRICH_WORKERS) as executor:
            future_to_ip = {
                executor.submit(_enrich_host, ip, snmp_community, local_arp, mdns_map, opts): ip
                for ip in live_hosts
            }
            for future in concurrent.futures.as_completed(future_to_ip):
                ip = future_to_ip[future]
                try:
                    host_row = future.result()
                except Exception as exc:  # noqa: BLE001
                    host_row = {
                        "status": "up", "ip": ip, "hostname": None, "mac": None,
                        "mac_vendor": None, "device_type": "Unknown", "os": None,
                        "open_ports": [], "netbios_name": None,
                        "raw": {"error": str(exc)},
                    }
                devices.append(host_row)
                _post_callback(host_callback_url, host_row)

        results = {
            "target_subnet": target_subnet,
            "live_hosts": live_hosts,
            "host_count": len(live_hosts),
            "devices": devices,
        }

        jobs[job_id] = {"status": "completed", "results": results}
        _post_callback(callback_url, {"status": "completed", "results": results})

    except Exception as exc:  # noqa: BLE001 - report any failure back to the API
        jobs[job_id] = {"status": "failed", "error": str(exc)}
        _post_callback(callback_url, {"status": "failed", "results": {"error": str(exc)}})


def _post_callback(callback_url, payload):
    if not callback_url:
        return
    try:
        requests.post(callback_url, json=payload, timeout=30)
    except requests.RequestException:
        pass


if __name__ == '__main__':
    port = int(os.environ.get('SCANNER_PORT', 5001))
    app.run(host='0.0.0.0', port=port, threaded=True)
