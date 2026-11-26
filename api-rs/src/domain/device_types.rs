//! Built-in device types (design section 3) and where each may be placed.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    /// On a floor plan (or on a tray).
    Floor,
    /// Mounted in a rack.
    Rack,
    /// Anywhere.
    Either,
}

impl Placement {
    pub fn as_str(self) -> &'static str {
        match self {
            Placement::Floor => "floor",
            Placement::Rack => "rack",
            Placement::Either => "either",
        }
    }
    pub fn parse(s: &str) -> Option<Placement> {
        match s {
            "floor" => Some(Placement::Floor),
            "rack" => Some(Placement::Rack),
            "either" => Some(Placement::Either),
            _ => None,
        }
    }
}

/// Key of the built-in shelf type: the only type other devices can sit on.
pub const TRAY_KEY: &str = "tray";
/// Prefix for rack codes (racks are not devices).
pub const RACK_PREFIX: &str = "RK";

pub struct Builtin {
    pub key: &'static str,
    pub label: &'static str,
    pub prefix: &'static str,
    pub placement: Placement,
    pub icon: &'static str,
}

const fn b(
    key: &'static str,
    label: &'static str,
    prefix: &'static str,
    placement: Placement,
    icon: &'static str,
) -> Builtin {
    Builtin {
        key,
        label,
        prefix,
        placement,
        icon,
    }
}

pub const BUILTINS: &[Builtin] = &[
    // Floor
    b(
        "access_point",
        "Access point",
        "AP",
        Placement::Floor,
        "wifi",
    ),
    b("camera", "Camera", "CAM", Placement::Floor, "camera"),
    b("desktop", "Desktop", "DP", Placement::Floor, "monitor"),
    b("laptop", "Laptop", "LP", Placement::Floor, "laptop"),
    b("phone", "Phone", "PH", Placement::Floor, "phone"),
    b("printer", "Printer", "PR", Placement::Floor, "printer"),
    b("screen", "Screen", "SCR", Placement::Floor, "tv"),
    b(
        "wall_outlet",
        "Wall / telecom outlet",
        "TO",
        Placement::Floor,
        "plug",
    ),
    b(
        "isp_handoff",
        "ISP handoff",
        "ISP",
        Placement::Floor,
        "globe",
    ),
    b(
        "access_control_panel",
        "Access-control panel",
        "ACP",
        Placement::Floor,
        "door-open",
    ),
    b(
        "door_reader",
        "Door reader",
        "RDR",
        Placement::Floor,
        "scan",
    ),
    b("iot", "IoT / other", "IOT", Placement::Floor, "cpu"),
    // Rack
    b("switch", "Switch", "SW", Placement::Rack, "network"),
    b("router", "Router", "RT", Placement::Rack, "router"),
    b("firewall", "Firewall", "FW", Placement::Rack, "shield"),
    b("server", "Server", "SRV", Placement::Rack, "server"),
    b("nas", "NAS", "NAS", Placement::Rack, "hard-drive"),
    b(
        "patch_panel",
        "Patch panel",
        "PP",
        Placement::Rack,
        "layout-grid",
    ),
    b(
        "fibre_panel",
        "Fibre panel",
        "FP",
        Placement::Rack,
        "layout-grid",
    ),
    b(
        "cable_manager",
        "Cable manager",
        "CM",
        Placement::Rack,
        "rows",
    ),
    b(
        "blanking_panel",
        "Blanking panel",
        "BLK",
        Placement::Rack,
        "square",
    ),
    b("pdu", "PDU", "PDU", Placement::Rack, "plug-zap"),
    b("ups", "UPS", "UPS", Placement::Rack, "battery-charging"),
    b(
        "battery_module",
        "Battery module",
        "EBM",
        Placement::Rack,
        "battery",
    ),
    b(
        TRAY_KEY,
        "Shelf / tray",
        "TR",
        Placement::Rack,
        "panel-bottom",
    ),
    b("kvm", "KVM", "KVM", Placement::Rack, "keyboard"),
    // Either
    b(
        "media_converter",
        "Media converter",
        "MC",
        Placement::Either,
        "repeat",
    ),
    b("modem", "Modem", "MDM", Placement::Either, "radio"),
    b("misc", "Miscellaneous", "MISC", Placement::Either, "box"),
];

/// Where a device is being put.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Room,
    Rack,
    Tray,
    Unplaced,
}

/// Whether a device of this type may go to `target`. Trays only mount in
/// racks; devices on a tray are freestanding gear (floor or either types).
pub fn can_place(type_key: &str, placement: Placement, target: Target) -> bool {
    match target {
        Target::Unplaced => true,
        Target::Rack => matches!(placement, Placement::Rack | Placement::Either),
        Target::Room => {
            type_key != TRAY_KEY && matches!(placement, Placement::Floor | Placement::Either)
        }
        Target::Tray => {
            type_key != TRAY_KEY && matches!(placement, Placement::Floor | Placement::Either)
        }
    }
}

pub fn validate_key(key: &str) -> Result<String, &'static str> {
    let key = key.trim().to_ascii_lowercase();
    let mut chars = key.chars();
    let ok = !key.is_empty()
        && key.len() <= 40
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if ok {
        Ok(key)
    } else {
        Err("Key must start with a letter and contain only a-z, 0-9 and '_' (max 40)")
    }
}

pub fn validate_prefix(prefix: &str) -> Result<String, &'static str> {
    let p = prefix.trim().to_ascii_uppercase();
    if p.is_empty() || p.len() > 6 || !p.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Prefix must be 1 to 6 letters or digits");
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_are_unique_and_valid() {
        let mut keys: Vec<_> = BUILTINS.iter().map(|b| b.key).collect();
        let mut prefixes: Vec<_> = BUILTINS.iter().map(|b| b.prefix).collect();
        keys.sort();
        prefixes.sort();
        let (k, p) = (keys.len(), prefixes.len());
        keys.dedup();
        prefixes.dedup();
        assert_eq!(keys.len(), k, "duplicate key");
        assert_eq!(prefixes.len(), p, "duplicate prefix");
        for b in BUILTINS {
            assert_eq!(validate_key(b.key).unwrap(), b.key);
            assert_eq!(validate_prefix(b.prefix).unwrap(), b.prefix);
        }
    }

    #[test]
    fn placement_rules() {
        assert!(can_place("switch", Placement::Rack, Target::Rack));
        assert!(!can_place("switch", Placement::Rack, Target::Room));
        assert!(!can_place("switch", Placement::Rack, Target::Tray));
        assert!(can_place("switch", Placement::Rack, Target::Unplaced));
        assert!(can_place("access_point", Placement::Floor, Target::Room));
        assert!(!can_place("access_point", Placement::Floor, Target::Rack));
        assert!(can_place(
            "media_converter",
            Placement::Either,
            Target::Tray
        ));
        assert!(can_place(
            "media_converter",
            Placement::Either,
            Target::Rack
        ));
        assert!(can_place(TRAY_KEY, Placement::Rack, Target::Rack));
        assert!(
            !can_place(TRAY_KEY, Placement::Rack, Target::Tray),
            "no trays on trays"
        );
    }

    #[test]
    fn key_and_prefix_validation() {
        assert_eq!(validate_key(" Thin_Client2 ").unwrap(), "thin_client2");
        assert!(validate_key("2fast").is_err());
        assert!(validate_key("bad-key").is_err());
        assert_eq!(validate_prefix("tc").unwrap(), "TC");
        assert!(validate_prefix("TOOLONG").is_err());
        assert!(validate_prefix("A-B").is_err());
    }
}
