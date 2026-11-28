# VLANs and Wi-Fi

Open **VLANs and Wi-Fi** in the sidebar.

## VLANs

**Add VLAN** with its ID (1–4094), a name, and optionally a colour and
description. Then:

- link a **prefix** to the VLAN (edit the prefix → VLAN), so Rackpath knows
  which subnet runs on it;
- set a **port's VLANs**: open the port → **Set VLANs** → the **untagged**
  (native) VLAN and any **tagged** VLANs.

Rackpath warns when an address sits on a port that doesn't carry its
prefix's VLAN (see [IP addresses → Warnings](ip-addresses.md#warnings)).

UniFi integrations create VLANs from UniFi's networks.

## Wi-Fi networks

**Add WLAN** with the SSID, its security (WPA2, WPA3 or WPA2/WPA3
Personal, Enterprise (802.1X), Enhanced Open (OWE) or open), the VLAN it
puts clients on, and whether it's hidden.

Rackpath **never stores Wi-Fi passphrases**; the form has no field for one.
Keep them in your password manager and link to the entry in the notes.

UniFi integrations import Wi-Fi networks (without their passphrases). If one
is removed in UniFi, it's marked **missing at source**, or deleted if the
integration is set to (see [Integrations](integrations.md#when-something-disappears-at-the-source)).
