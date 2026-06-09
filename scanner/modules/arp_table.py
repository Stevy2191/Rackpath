"""ARP table access - reads the kernel ARP cache and can actively probe via scapy."""

ARP_PROC_PATH = '/proc/net/arp'
EMPTY_MAC = '00:00:00:00:00:00'


def read_arp_table():
    """Return {ip: mac} from the kernel's ARP cache (/proc/net/arp)."""
    arp = {}
    try:
        with open(ARP_PROC_PATH) as handle:
            lines = handle.readlines()[1:]
    except FileNotFoundError:
        return arp

    for line in lines:
        fields = line.split()
        if len(fields) >= 4:
            ip, mac = fields[0], fields[3]
            if mac != EMPTY_MAC:
                arp[ip] = mac

    return arp


def send_arp_probe(target_ip, iface=None, timeout=1):
    """Actively send an ARP request via scapy to discover a host's MAC address.

    Returns {ip: mac} for any hosts that respond. Requires NET_RAW capability.
    """
    from scapy.all import ARP, Ether, srp

    arp_request = ARP(pdst=target_ip)
    broadcast = Ether(dst='ff:ff:ff:ff:ff:ff')
    packet = broadcast / arp_request

    kwargs = {"timeout": timeout, "verbose": False}
    if iface:
        kwargs["iface"] = iface

    answered, _unanswered = srp(packet, **kwargs)

    results = {}
    for _sent, received in answered:
        results[received.psrc] = received.hwsrc

    return results
