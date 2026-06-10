"""Rackpath scanner service.

Exposes a small REST API the rackpath-api service calls to trigger network
discovery jobs (ping sweep, nmap, SNMP, LLDP/CDP, ARP) and report results
back via a callback URL.
"""

import os
import threading

import requests
from flask import Flask, jsonify, request

from modules import arp_table, lldp_discovery, nmap_scan, ping_sweep, snmp_discovery

app = Flask(__name__)

DEFAULT_SNMP_COMMUNITY = os.environ.get('SNMP_COMMUNITY', 'public')

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

    if not target_subnet:
        return jsonify({"error": "target_subnet is required"}), 400

    jobs[job_id] = {"status": "running", "target_subnet": target_subnet}

    thread = threading.Thread(
        target=_run_scan,
        args=(job_id, target_subnet, snmp_community, callback_url),
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


def _run_scan(job_id, target_subnet, snmp_community, callback_url):
    try:
        live_hosts = ping_sweep.sweep(target_subnet)
        local_arp = arp_table.read_arp_table()

        devices = []
        for ip in live_hosts:
            nmap_result = nmap_scan.scan_host(ip)
            snmp_info = snmp_discovery.get_system_info(ip, snmp_community)
            interfaces = snmp_discovery.get_interfaces(ip, snmp_community) if snmp_info else []
            neighbors = lldp_discovery.get_neighbors(ip, snmp_community) if snmp_info else []
            snmp_arp_table = snmp_discovery.get_arp_table(ip, snmp_community) if snmp_info else {}

            ports = nmap_result.get("ports", [])
            for iface in interfaces:
                ports.append({
                    "port_name": iface["port_name"],
                    "port_number": iface["port_number"],
                    "speed": iface["speed"],
                })

            devices.append({
                "ip": ip,
                "mac": local_arp.get(ip),
                "hostname": snmp_info.get("sysName") or nmap_result.get("hostname"),
                "type": nmap_result.get("os_guess"),
                "snmp_community": snmp_community if snmp_info else None,
                "snmp_descr": snmp_info.get("sysDescr"),
                "ports": ports,
                "neighbors": neighbors,
                "arp_table": snmp_arp_table,
            })

        results = {
            "target_subnet": target_subnet,
            "live_hosts": live_hosts,
            "arp_table": local_arp,
            "devices": devices,
        }

        jobs[job_id] = {"status": "completed", "results": results}
        _post_callback(callback_url, {"status": "completed", "devices": devices, "results": results})

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
    app.run(host='0.0.0.0', port=port)
