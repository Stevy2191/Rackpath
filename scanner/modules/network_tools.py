"""Simple synchronous network diagnostic tools: ping, traceroute, DNS lookup,
and SNMP device stats.

Unlike the /scan job pipeline (threaded, callback-driven), these run a single
subprocess/query and return the result directly in the request/response cycle.
"""

import re
import subprocess

import dns.exception
import dns.resolver
import dns.reversename
from puresnmp import get as snmp_get, walk as snmp_walk

# Hostnames, IPv4 and IPv6 literals only - rejects anything that could be
# mistaken for a CLI flag when passed as a subprocess argument.
_HOST_RE = re.compile(r'^[A-Za-z0-9](?:[A-Za-z0-9.\-:]*[A-Za-z0-9])?$')

# Optional puresnmp v3 credential API (added in puresnmp 1.7.0).
try:
    from puresnmp.credentials import V3, Auth, Priv as PrivCred
    from puresnmp.api.raw import get as raw_get, walk as raw_walk
    _HAS_V3 = True
except Exception:
    _HAS_V3 = False

_SNMP_TIMEOUT = 5

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


# ---------------------------------------------------------------------------
# SNMP device stats
# ---------------------------------------------------------------------------

def _decode_snmp(value):
    """Convert a puresnmp value to a JSON-safe Python type."""
    if isinstance(value, bytes):
        try:
            return value.decode('utf-8').strip('\x00')
        except UnicodeDecodeError:
            return '0x' + value.hex()
    if isinstance(value, (int, float)):
        return value
    return str(value)


def _make_snmp_fns(host, version, community, v3_user, v3_auth_protocol,
                   v3_auth_password, v3_priv_protocol, v3_priv_password):
    """Return (get_fn, walk_fn) closures for the requested SNMP version.

    get_fn(oid, raw_oids) -> value | None
    walk_fn(oid, raw_oids) -> {oid_str: value}
    """
    if version in ('1', '2c'):
        def _get(oid, raw_oids):
            try:
                val = snmp_get(host, community, oid, timeout=_SNMP_TIMEOUT)
                decoded = _decode_snmp(val)
                raw_oids[oid] = decoded
                return decoded
            except Exception:
                return None

        def _walk(base_oid, raw_oids):
            results = {}
            try:
                for varbind in snmp_walk(host, community, base_oid, timeout=_SNMP_TIMEOUT):
                    decoded = _decode_snmp(varbind.value)
                    key = str(varbind.oid)
                    results[key] = decoded
                    raw_oids[key] = decoded
            except Exception:
                pass
            return results

        return _get, _walk

    # --- SNMPv3 ---
    if not _HAS_V3:
        raise ValueError('SNMPv3 is not supported by this version of puresnmp')

    try:
        auth_obj = None
        priv_obj = None
        if v3_auth_password:
            auth_obj = Auth(
                secret=v3_auth_password.encode(),
                method=(v3_auth_protocol or 'md5').lower(),
            )
        if v3_priv_password and auth_obj:
            priv_obj = PrivCred(
                secret=v3_priv_password.encode(),
                method=(v3_priv_protocol or 'des').lower(),
            )
        creds = V3(username=v3_user or '', auth=auth_obj, priv=priv_obj)
    except Exception as exc:
        raise ValueError(f'SNMPv3 credential error: {exc}') from exc

    def _get_v3(oid, raw_oids):
        try:
            val = raw_get(host, creds, oid, timeout=_SNMP_TIMEOUT)
            decoded = _decode_snmp(val)
            raw_oids[oid] = decoded
            return decoded
        except Exception:
            return None

    def _walk_v3(base_oid, raw_oids):
        results = {}
        try:
            for varbind in raw_walk(host, creds, base_oid, timeout=_SNMP_TIMEOUT):
                decoded = _decode_snmp(varbind.value)
                key = str(varbind.oid)
                results[key] = decoded
                raw_oids[key] = decoded
        except Exception:
            pass
        return results

    return _get_v3, _walk_v3


def _format_timeticks(val):
    """Convert SNMP TimeTicks (hundredths of a second) to 'Xd Xh Xm Xs' string.

    puresnmp may return a TimeTicks int subclass, a plain int/float, or a
    string representation. Try every extraction path to get the raw integer.
    """
    import sys
    print(f'[DEBUG snmp uptime] raw={val!r} type={type(val).__name__}', file=sys.stderr, flush=True)
    if val is None:
        return None
    try:
        hundredths = None

        # 1. Prefer an explicit .value attribute (some puresnmp typed wrappers)
        if hasattr(val, 'value'):
            try:
                hundredths = int(val.value)
            except (TypeError, ValueError):
                pass

        # 2. Direct int() cast — works for plain int, float, and int subclasses
        #    (puresnmp TimeTicks IS an int subclass in 1.x, so this should succeed)
        if hundredths is None:
            try:
                hundredths = int(val)
            except (TypeError, ValueError):
                pass

        # 3. String extraction — handles "TimeTicks: 1234567" or similar
        if hundredths is None:
            m = re.search(r'\d+', str(val))
            hundredths = int(m.group()) if m else 0

        print(f'[DEBUG snmp uptime] hundredths={hundredths}', file=sys.stderr, flush=True)
        secs = hundredths // 100
        days = secs // 86400
        hours = (secs % 86400) // 3600
        mins = (secs % 3600) // 60
        s = secs % 60
        if days > 0:
            return f'{days}d {hours}h {mins}m {s}s'
        return f'{hours}h {mins}m {s}s'
    except Exception as exc:
        print(f'[DEBUG snmp uptime] error={exc!r}', file=sys.stderr, flush=True)
        return str(val)


def _query_system(get_fn, raw_oids):
    result = {}
    for key, oid in (
        ('sysDescr',    '1.3.6.1.2.1.1.1.0'),
        ('sysName',     '1.3.6.1.2.1.1.5.0'),
        ('sysLocation', '1.3.6.1.2.1.1.6.0'),
        ('sysContact',  '1.3.6.1.2.1.1.4.0'),
    ):
        result[key] = get_fn(oid, raw_oids)
    uptime_raw = get_fn('1.3.6.1.2.1.1.3.0', raw_oids)
    result['sysUptime'] = _format_timeticks(uptime_raw)
    return result


def _query_cpu(get_fn, walk_fn, raw_oids):
    # NET-SNMP (Linux)
    load_1min  = get_fn('1.3.6.1.4.1.2021.11.9.0', raw_oids)
    load_5min  = get_fn('1.3.6.1.4.1.2021.11.10.0', raw_oids)
    load_15min = get_fn('1.3.6.1.4.1.2021.11.11.0', raw_oids)
    if any(v is not None for v in (load_1min, load_5min, load_15min)):
        return {
            'source': 'NET-SNMP',
            'load_1min':  _to_num(load_1min),
            'load_5min':  _to_num(load_5min),
            'load_15min': _to_num(load_15min),
        }

    # Cisco IOS
    ios_5sec = get_fn('1.3.6.1.4.1.9.2.1.57.0', raw_oids)
    ios_1min = get_fn('1.3.6.1.4.1.9.2.1.58.0', raw_oids)
    ios_5min = get_fn('1.3.6.1.4.1.9.2.1.59.0', raw_oids)
    if any(v is not None for v in (ios_5sec, ios_1min, ios_5min)):
        return {
            'source': 'Cisco IOS',
            'load_5sec': _to_num(ios_5sec),
            'load_1min': _to_num(ios_1min),
            'load_5min': _to_num(ios_5min),
        }

    # Cisco NX-OS
    nxos = get_fn('1.3.6.1.4.1.9.9.109.1.1.1.1.3.1', raw_oids)
    if nxos is not None:
        return {'source': 'Cisco NX-OS', 'load_percent': _to_num(nxos)}

    # Fortinet FortiGate
    forti = get_fn('1.3.6.1.4.1.12356.101.4.1.3.0', raw_oids)
    if forti is not None:
        return {'source': 'FortiGate', 'load_percent': _to_num(forti)}

    # Ubiquiti EdgeSwitch — walk the subtree first; fall back to direct GETs
    import sys
    ubnt_cpu_5sec = ubnt_cpu_1min = ubnt_cpu_5min = None
    ubnt_cpu_walk = walk_fn('1.3.6.1.4.1.41112.1.5.1.2.1.5', raw_oids)
    print(f'[DEBUG snmp cpu] ubnt walk .5={ubnt_cpu_walk!r}', file=sys.stderr, flush=True)
    if ubnt_cpu_walk:
        first = next((v for v in ubnt_cpu_walk.values() if v is not None), None)
        ubnt_cpu_1min = first
    if ubnt_cpu_1min is None:
        ubnt_cpu_5sec = get_fn('1.3.6.1.4.1.41112.1.5.1.2.1.3.1', raw_oids)
        ubnt_cpu_1min = get_fn('1.3.6.1.4.1.41112.1.5.1.2.1.5.1', raw_oids)
        ubnt_cpu_5min = get_fn('1.3.6.1.4.1.41112.1.5.1.2.1.7.1', raw_oids)
        print(f'[DEBUG snmp cpu] ubnt GET 5s={ubnt_cpu_5sec!r} 1m={ubnt_cpu_1min!r} 5m={ubnt_cpu_5min!r}', file=sys.stderr, flush=True)
    if any(v is not None for v in (ubnt_cpu_5sec, ubnt_cpu_1min, ubnt_cpu_5min)):
        return {
            'source': 'Ubiquiti EdgeSwitch',
            'load_5sec': _to_num(ubnt_cpu_5sec),
            'load_1min': _to_num(ubnt_cpu_1min),
            'load_5min': _to_num(ubnt_cpu_5min),
        }

    # Generic HOST-RESOURCES-MIB processor load walk
    hr_cpu = walk_fn('1.3.6.1.2.1.25.3.3.1.2', raw_oids)
    if hr_cpu:
        values = [_to_num(v) for v in hr_cpu.values() if v is not None]
        avg = round(sum(values) / len(values)) if values else None
        return {'source': 'HOST-RESOURCES-MIB', 'load_percent': avg}

    return {'source': None}


def _query_memory(get_fn, walk_fn, raw_oids):
    # NET-SNMP UCD-SNMP-MIB
    total_real = get_fn('1.3.6.1.4.1.2021.4.5.0', raw_oids)
    avail_real = get_fn('1.3.6.1.4.1.2021.4.6.0', raw_oids)
    total_free = get_fn('1.3.6.1.4.1.2021.4.11.0', raw_oids)
    if any(v is not None for v in (total_real, avail_real)):
        total_kb = _to_num(total_real)
        free_kb  = _to_num(avail_real) or _to_num(total_free)
        used_kb  = (total_kb - free_kb) if total_kb is not None and free_kb is not None else None
        return {'source': 'NET-SNMP', 'total_kb': total_kb, 'used_kb': used_kb, 'free_kb': free_kb}

    # Cisco IOS ciscoMemoryPool
    used_mem = get_fn('1.3.6.1.4.1.9.9.48.1.1.1.5.1', raw_oids)
    free_mem = get_fn('1.3.6.1.4.1.9.9.48.1.1.1.6.1', raw_oids)
    if any(v is not None for v in (used_mem, free_mem)):
        u = _to_num(used_mem)
        f = _to_num(free_mem)
        total = (u + f) if u is not None and f is not None else None
        # Values are bytes; convert to kB
        return {
            'source': 'Cisco IOS',
            'total_kb': _div(total, 1024),
            'used_kb':  _div(u, 1024),
            'free_kb':  _div(f, 1024),
        }

    # Fortinet (returns usage %)
    forti_mem = get_fn('1.3.6.1.4.1.12356.101.4.1.4.0', raw_oids)
    if forti_mem is not None:
        return {'source': 'FortiGate', 'percent': _to_num(forti_mem)}

    # Ubiquiti EdgeSwitch (values in bytes) — walk subtrees first, GET as fallback
    import sys
    ubnt_total = ubnt_free = None
    ubnt_total_walk = walk_fn('1.3.6.1.4.1.41112.1.5.1.2.1.11', raw_oids)
    ubnt_free_walk  = walk_fn('1.3.6.1.4.1.41112.1.5.1.2.1.12', raw_oids)
    print(f'[DEBUG snmp mem] ubnt walk total={ubnt_total_walk!r} free={ubnt_free_walk!r}', file=sys.stderr, flush=True)
    if ubnt_total_walk:
        ubnt_total = next((v for v in ubnt_total_walk.values() if v is not None), None)
    if ubnt_free_walk:
        ubnt_free = next((v for v in ubnt_free_walk.values() if v is not None), None)
    if ubnt_total is None:
        ubnt_total = get_fn('1.3.6.1.4.1.41112.1.5.1.2.1.11.1', raw_oids)
    if ubnt_free is None:
        ubnt_free  = get_fn('1.3.6.1.4.1.41112.1.5.1.2.1.12.1', raw_oids)
    print(f'[DEBUG snmp mem] ubnt total={ubnt_total!r} free={ubnt_free!r}', file=sys.stderr, flush=True)
    if any(v is not None for v in (ubnt_total, ubnt_free)):
        t = _to_num(ubnt_total)
        f = _to_num(ubnt_free)
        u = (t - f) if t is not None and f is not None else None
        return {
            'source': 'Ubiquiti EdgeSwitch',
            'total_kb': _div(t, 1024),
            'used_kb':  _div(u, 1024),
            'free_kb':  _div(f, 1024),
        }

    # Generic HOST-RESOURCES-MIB hrStorage table
    hr_descr = walk_fn('1.3.6.1.2.1.25.2.3.1.3', raw_oids)
    hr_units  = walk_fn('1.3.6.1.2.1.25.2.3.1.4', raw_oids)
    hr_size   = walk_fn('1.3.6.1.2.1.25.2.3.1.5', raw_oids)
    hr_used   = walk_fn('1.3.6.1.2.1.25.2.3.1.6', raw_oids)
    if hr_size:
        for oid, descr in hr_descr.items():
            idx = oid.rsplit('.', 1)[-1]
            if descr and 'ram' in str(descr).lower():
                units_oid = f'1.3.6.1.2.1.25.2.3.1.4.{idx}'
                size_oid  = f'1.3.6.1.2.1.25.2.3.1.5.{idx}'
                used_oid  = f'1.3.6.1.2.1.25.2.3.1.6.{idx}'
                unit_bytes = _to_num(hr_units.get(units_oid)) or 1
                size_units = _to_num(hr_size.get(size_oid))
                used_units = _to_num(hr_used.get(used_oid))
                total_kb = _div(size_units * unit_bytes if size_units else None, 1024)
                used_kb  = _div(used_units * unit_bytes if used_units else None, 1024)
                free_kb  = (total_kb - used_kb) if total_kb and used_kb else None
                return {'source': 'HOST-RESOURCES-MIB', 'total_kb': total_kb, 'used_kb': used_kb, 'free_kb': free_kb}

    return {'source': None}


def _query_interfaces(walk_fn, raw_oids):
    base = '1.3.6.1.2.1.2.2.1'
    tables = {
        'index':        walk_fn(f'{base}.1', raw_oids),
        'descr':        walk_fn(f'{base}.2', raw_oids),
        'type':         walk_fn(f'{base}.3', raw_oids),
        'speed':        walk_fn(f'{base}.5', raw_oids),
        'admin_status': walk_fn(f'{base}.7', raw_oids),
        'oper_status':  walk_fn(f'{base}.8', raw_oids),
        'in_octets':    walk_fn(f'{base}.10', raw_oids),
        'out_octets':   walk_fn(f'{base}.16', raw_oids),
    }

    # Collect all interface indexes from the descr table
    indexes = set()
    for oid in tables['descr']:
        idx = oid.rsplit('.', 1)[-1]
        indexes.add(idx)

    interfaces = []
    for idx in sorted(indexes, key=lambda x: int(x) if x.isdigit() else 0):
        def col(name):
            return tables[name].get(f'{base}.{_COL_NUM[name]}.{idx}')

        interfaces.append({
            'index':        _to_num(col('index')) or int(idx),
            'description':  col('descr'),
            'type':         _to_num(col('type')),
            'speed':        _to_num(col('speed')),
            'admin_status': _to_num(col('admin_status')),
            'oper_status':  _to_num(col('oper_status')),
            'in_octets':    _to_num(col('in_octets')),
            'out_octets':   _to_num(col('out_octets')),
        })

    return interfaces


_COL_NUM = {
    'index': '1', 'descr': '2', 'type': '3', 'speed': '5',
    'admin_status': '7', 'oper_status': '8', 'in_octets': '10', 'out_octets': '16',
}


def _to_num(val):
    if val is None:
        return None
    try:
        f = float(val)
        return int(f) if f == int(f) else f
    except (TypeError, ValueError):
        return None


def _div(val, divisor):
    if val is None:
        return None
    try:
        return int(val) // divisor
    except (TypeError, ValueError):
        return None


def run_snmp_stats(host, version, community, v3_user, v3_auth_protocol,
                   v3_auth_password, v3_priv_protocol, v3_priv_password, stats):
    host = _validate_host(host)
    version = (version or '2c').lower()
    if version not in ('1', '2c', 'v3'):
        raise ValueError(f'Unsupported SNMP version: {version}')

    raw_oids = {}
    try:
        get_fn, walk_fn = _make_snmp_fns(
            host, version, community or 'public',
            v3_user, v3_auth_protocol, v3_auth_password,
            v3_priv_protocol, v3_priv_password,
        )
    except ValueError:
        raise

    result = {'raw_oids': raw_oids}

    # Probe system info first to detect auth/timeout; if SNMP is completely
    # unresponsive, all get calls return None but we don't hard-error here —
    # the frontend can show "no data" rather than a failure.
    if 'system' in stats:
        result['system'] = _query_system(get_fn, raw_oids)

    if 'cpu' in stats:
        result['cpu'] = _query_cpu(get_fn, walk_fn, raw_oids)

    if 'memory' in stats:
        result['memory'] = _query_memory(get_fn, walk_fn, raw_oids)

    if 'interfaces' in stats:
        result['interfaces'] = _query_interfaces(walk_fn, raw_oids)

    return result
