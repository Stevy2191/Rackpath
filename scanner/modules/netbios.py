"""NetBIOS / SMB name lookup.

Tries `nmblookup -A <ip>` first (fast, present in the samba package), then
falls back to impacket's NetBIOS implementation. Returns the Windows machine
name and workgroup/domain when available.
"""

import re
import subprocess

# A NetBIOS node-status reply line looks like:
#   WORKSTATION     <00>  UNIQUE      Registered
# The <00> UNIQUE entry is the machine name; <00> GROUP is the workgroup.
_NAME_LINE = re.compile(r'^\s*(\S+)\s+<([0-9a-fA-F]{2})>\s+(UNIQUE|GROUP)', re.MULTILINE)


def _parse_nmblookup(output):
    name = None
    workgroup = None
    for match in _NAME_LINE.finditer(output):
        value, code, kind = match.group(1), match.group(2).lower(), match.group(3)
        if value in ('__MSBROWSE__',) or value.startswith('\x01'):
            continue
        if code == '00' and kind == 'UNIQUE' and name is None:
            name = value
        elif code == '00' and kind == 'GROUP' and workgroup is None:
            workgroup = value
    return name, workgroup


def _via_nmblookup(ip):
    try:
        result = subprocess.run(
            ['nmblookup', '-A', str(ip)],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            text=True,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None, None
    if result.returncode != 0:
        return None, None
    return _parse_nmblookup(result.stdout)


def _via_impacket(ip):
    try:
        from impacket import nmb
    except Exception:
        return None, None

    try:
        netbios = nmb.NetBIOS()
        names = netbios.getnetbiosname(str(ip))
        if names:
            return names, None
    except Exception:
        return None, None
    return None, None


def query(ip):
    """Return {netbios_name, workgroup} (values may be None)."""
    name, workgroup = _via_nmblookup(ip)
    if name is None:
        name, wg2 = _via_impacket(ip)
        workgroup = workgroup or wg2
    return {"netbios_name": name, "workgroup": workgroup}
