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


@app.route('/scan', methods=['POST'])
def start_scan():
    data = request.get_json(force=True, silent=True) or {}

    job_id = data.get('job_id')
    target_subnet = data.get('target_subnet')
    snmp_community = data.get('snmp_community') or DEFAULT_SNMP_COMMUNITY
    callback_url = data.get('callback_url')
    host_callback_url = data.get('host_callback_url')
    progress_callback_url = data.get('progress_callback_url')

    if not target_subnet:
        return jsonify({"error": "target_subnet is required"}), 400

    jobs[job_id] = {"status": "running", "target_subnet": target_subnet}

    thread = threading.Thread(
        target=_run_scan,
        args=(job_id, target_subnet, snmp_community, callback_url,
              host_callback_url, progress_callback_url),
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


def _derive_callbacks(callback_url, host_callback_url, progress_callback_url):
    """Fill in host/progress callback URLs from the results callback if the API
    didn't supply them explicitly (keeps backwards compatibility)."""
    if callback_url:
        if not host_callback_url:
            host_callback_url = callback_url.replace('/results', '/host')
        if not progress_callback_url:
            progress_callback_url = callback_url.replace('/results', '/progress')
    return host_callback_url, progress_callback_url


def _enrich_host(ip, snmp_community, local_arp, mdns_map):
    """Run the full enrichment pipeline for a single live host and return the
    flattened result row plus the extra detail used for inventory import."""
    nmap_result = nmap_scan.scan_host(ip)

    # MAC: prefer the kernel ARP cache, fall back to an active ARP probe.
    mac = local_arp.get(ip)
    if not mac:
        try:
            probed = arp_table.send_arp_probe(ip)
            mac = probed.get(ip)
        except Exception:
            mac = None
    mac_vendor = oui_lookup.lookup(mac)

    nb = netbios.query(ip)
    mdns_entry = mdns_map.get(ip, {})
    mdns_services = mdns_entry.get("services", [])

    snmp_info = snmp_discovery.get_system_info(ip, snmp_community)
    interfaces = snmp_discovery.get_interfaces(ip, snmp_community) if snmp_info else []
    neighbors = lldp_discovery.get_neighbors(ip, snmp_community) if snmp_info else []
    snmp_arp = snmp_discovery.get_arp_table(ip, snmp_community) if snmp_info else {}

    open_ports = sorted(
        p["port_number"]
        for p in nmap_result.get("ports", [])
        if p.get("state") == "open" and p.get("protocol") == "tcp"
    )

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
        "os": nmap_result.get("os_guess"),
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


def _run_scan(job_id, target_subnet, snmp_community, callback_url,
              host_callback_url, progress_callback_url):
    host_callback_url, progress_callback_url = _derive_callbacks(
        callback_url, host_callback_url, progress_callback_url
    )

    try:
        network = ipaddress.ip_network(target_subnet, strict=False)
        all_hosts = [str(ip) for ip in network.hosts()]
        total = len(all_hosts)

        # Kick off a one-shot mDNS browse for the whole link in the background;
        # results are collected by the time enrichment needs them.
        mdns_map = {}
        mdns_holder = {}

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
        live_hosts = []
        scanned = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=PING_WORKERS) as executor:
            future_to_ip = {executor.submit(multi_ping.is_up, ip): ip for ip in all_hosts}
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

        live_hosts.sort(key=lambda ip: tuple(int(p) for p in ip.split('.')))

        # Make sure the mDNS browse has finished before enrichment reads it.
        mdns_thread.join(timeout=6.0)
        mdns_map = mdns_holder.get("map", {})

        local_arp = arp_table.read_arp_table()

        # --- Phase 2: parallel per-host enrichment, streaming each row -------
        devices = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=ENRICH_WORKERS) as executor:
            future_to_ip = {
                executor.submit(_enrich_host, ip, snmp_community, local_arp, mdns_map): ip
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
