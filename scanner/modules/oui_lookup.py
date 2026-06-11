"""MAC address OUI -> vendor lookup using the `manuf` library.

`manuf` ships a bundled copy of the Wireshark OUI database, so this works
offline. A single parser instance is reused across lookups.
"""

_parser = None
_unavailable = False


def _get_parser():
    global _parser, _unavailable
    if _parser is not None or _unavailable:
        return _parser
    try:
        from manuf import manuf
        _parser = manuf.MacParser()
    except Exception:
        _unavailable = True
        _parser = None
    return _parser


def lookup(mac):
    """Return the vendor name for a MAC address, or None if unknown."""
    if not mac:
        return None
    parser = _get_parser()
    if parser is None:
        return None
    try:
        # Prefer the manufacturer's long name, fall back to the short alias.
        result = parser.get_all(mac)
        return result.manuf_long or result.manuf or None
    except Exception:
        return None
