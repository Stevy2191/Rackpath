"""Simple synchronous network diagnostic tools: ping, traceroute, DNS lookup.

Unlike the /scan job pipeline (threaded, callback-driven), these run a single
subprocess/query and return the result directly in the request/response cycle.
"""

import re
import subprocess

import dns.exception
import dns.resolver
import dns.reversename

# Hostnames, IPv4 and IPv6 literals only - rejects anything that could be
# mistaken for a CLI flag when passed as a subprocess argument.
_HOST_RE = re.compile(r'^[A-Za-z0-9](?:[A-Za-z0-9.\-:]*[A-Za-z0-9])?$')

RECORD_TYPES = {'A', 'AAAA', 'MX', 'CNAME', 'TXT', 'NS', 'PTR'}


def _validate_host(host):
    host = (host or '').strip()
    if not host or not _HOST_RE.match(host):
        raise ValueError('Invalid host')
    return host


def run_ping(host, count=4):
    host = _validate_host(host)
    try:
        count = max(1, min(int(count), 20))
    except (TypeError, ValueError):
        count = 4

    try:
        proc = subprocess.run(
            ['ping', '-c', str(count), host],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=count * 3 + 10,
            text=True,
        )
        output = proc.stdout
    except subprocess.TimeoutExpired as exc:
        output = (exc.output or '') + '\n[ping timed out]'

    sent, received, loss = count, 0, 100.0
    m = re.search(r'(\d+) packets transmitted, (\d+) (?:packets )?received', output)
    if m:
        sent, received = int(m.group(1)), int(m.group(2))
    m_loss = re.search(r'([\d.]+)% packet loss', output)
    if m_loss:
        loss = float(m_loss.group(1))

    min_ms = avg_ms = max_ms = None
    m_rtt = re.search(r'= ([\d.]+)/([\d.]+)/([\d.]+)', output)
    if m_rtt:
        min_ms, avg_ms, max_ms = (float(m_rtt.group(i)) for i in (1, 2, 3))

    return {
        'success': received > 0,
        'host': host,
        'packets_sent': sent,
        'packets_received': received,
        'packet_loss_percent': loss,
        'min_ms': min_ms,
        'avg_ms': avg_ms,
        'max_ms': max_ms,
        'raw_output': output,
    }


def _parse_probes(tokens):
    probes = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok == '*':
            probes.append(None)
            i += 1
            continue
        try:
            val = float(tok)
        except ValueError:
            i += 1
            continue
        if i + 1 < len(tokens) and tokens[i + 1] == 'ms':
            i += 2
        else:
            i += 1
        probes.append(val)
    return probes[:3]


def run_traceroute(host, max_hops=30):
    host = _validate_host(host)
    try:
        max_hops = max(1, min(int(max_hops), 64))
    except (TypeError, ValueError):
        max_hops = 30

    try:
        proc = subprocess.run(
            ['traceroute', '-m', str(max_hops), '-n', host],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=max_hops * 3 + 15,
            text=True,
        )
        output = proc.stdout
    except subprocess.TimeoutExpired as exc:
        output = (exc.output or '') + '\n[traceroute timed out]'

    hops = []
    for line in output.splitlines():
        m = re.match(r'^\s*(\d+)\s+(.*)$', line)
        if not m:
            continue
        hop_num = int(m.group(1))
        tokens = m.group(2).split()
        if not tokens:
            continue

        ip = None
        if tokens[0] != '*':
            ip = tokens[0]
            tokens = tokens[1:]

        probes = _parse_probes(tokens)
        if ip is None and all(p is None for p in probes):
            rtt_ms = None
        else:
            rtt_ms = probes

        hops.append({'hop': hop_num, 'ip': ip, 'rtt_ms': rtt_ms})

    return {'host': host, 'hops': hops, 'raw_output': output}


def run_dns_lookup(host, record_type='A'):
    record_type = (record_type or 'A').upper()
    if record_type not in RECORD_TYPES:
        raise ValueError(f'Unsupported record type: {record_type}')

    host = (host or '').strip()
    if not host:
        raise ValueError('host is required')

    query_name = host
    if record_type == 'PTR':
        try:
            query_name = str(dns.reversename.from_address(host))
        except Exception as exc:
            raise ValueError(f'Invalid IP address for PTR lookup: {host}') from exc

    resolver = dns.resolver.Resolver()
    resolver.timeout = 5
    resolver.lifetime = 5

    try:
        answer = resolver.resolve(query_name, record_type)
    except dns.resolver.NXDOMAIN:
        return {'host': host, 'record_type': record_type, 'results': [], 'raw_output': 'NXDOMAIN: name not found'}
    except dns.resolver.NoAnswer:
        return {'host': host, 'record_type': record_type, 'results': [], 'raw_output': 'No records found'}
    except dns.exception.Timeout:
        return {'host': host, 'record_type': record_type, 'results': [], 'raw_output': 'DNS query timed out'}

    results = []
    for rdata in answer:
        if record_type == 'MX':
            results.append(f'{rdata.preference} {rdata.exchange}'.rstrip('.'))
        elif record_type == 'TXT':
            results.append(b' '.join(rdata.strings).decode('utf-8', errors='replace'))
        elif record_type in ('CNAME', 'NS', 'PTR'):
            results.append(str(rdata).rstrip('.'))
        else:
            results.append(str(rdata))

    raw_output = '\n'.join(results) if results else 'No records found'
    return {'host': host, 'record_type': record_type, 'results': results, 'raw_output': raw_output}
