//! The naming scheme (design section 3): short codes, unique within their
//! parent, that build full paths like `ACME/HQ/2/MDF/RK01/SW02/13`.

pub const MAX_CODE_LEN: usize = 16;

/// Normalises and validates a code: trimmed, uppercased, 1–16 characters of
/// A–Z, 0–9, `.`, `_` and `-`, starting with a letter or digit.
pub fn normalize_code(input: &str) -> Result<String, &'static str> {
    let code = input.trim().to_ascii_uppercase();
    if code.is_empty() {
        return Err("Code is required");
    }
    if code.len() > MAX_CODE_LEN {
        return Err("Code must be at most 16 characters");
    }
    let mut chars = code.chars();
    let first = chars.next().expect("non-empty");
    if !first.is_ascii_alphanumeric() {
        return Err("Code must start with a letter or digit");
    }
    if !code
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err("Code may only contain letters, digits, '.', '_' and '-'");
    }
    Ok(code)
}

/// The next free code for a prefix among existing sibling codes: `SW01`,
/// `SW02`, … (at least two digits).
pub fn next_free_code(prefix: &str, existing: &[String]) -> String {
    let prefix = prefix.to_ascii_uppercase();
    let mut n = 1u32;
    loop {
        let candidate = format!("{prefix}{n:02}");
        if !existing.iter().any(|e| e.eq_ignore_ascii_case(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

/// A code made from a free-text name (an imported device's name):
/// uppercased, anything but letters and digits becomes `-`, runs of `-`
/// collapse, and it's cut to 16 characters. "Living Room AP" becomes
/// `LIVING-ROOM-AP`. None when nothing usable is left (no ASCII letters or
/// digits).
pub fn code_from_name(name: &str) -> Option<String> {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_uppercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(MAX_CODE_LEN);
    let out = out.trim_end_matches('-');
    normalize_code(out).ok()
}

/// Whether `code` is an automatic one for `prefix`: the prefix and digits,
/// as `next_free_code` makes (`AP01`, `SW12`).
pub fn is_auto_code(code: &str, prefix: &str) -> bool {
    code.len() > prefix.len()
        && code[..prefix.len()].eq_ignore_ascii_case(prefix)
        && code[prefix.len()..].chars().all(|c| c.is_ascii_digit())
}

/// A variant of `code` that isn't in `taken`: `CODE`, then `CODE-2`,
/// `CODE-3`, … shortening the base so the result stays within 16 characters.
pub fn unique_variant(code: &str, taken: &[String]) -> String {
    if !taken.iter().any(|t| t.eq_ignore_ascii_case(code)) {
        return code.to_string();
    }
    let mut n = 2u32;
    loop {
        let suffix = format!("-{n}");
        let keep = MAX_CODE_LEN.saturating_sub(suffix.len()).min(code.len());
        let candidate = format!("{}{suffix}", &code[..keep]);
        if !taken.iter().any(|t| t.eq_ignore_ascii_case(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

/// Joins codes into a full path.
pub fn path(codes: &[&str]) -> String {
    codes.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_from_names() {
        for (name, code) in [
            ("Living Room AP", Some("LIVING-ROOM-AP")),
            ("  office-ap ", Some("OFFICE-AP")),
            ("U7 Pro (Upstairs Hallway)", Some("U7-PRO-UPSTAIRS")),
            ("USW-Pro-24-PoE", Some("USW-PRO-24-POE")),
            ("Switch / Rack 2", Some("SWITCH-RACK-2")),
            ("Café AP", Some("CAF-AP")),
            ("---", None),
            ("Ångström", Some("NGSTR-M")),
            ("📡", None),
            ("", None),
        ] {
            assert_eq!(code_from_name(name).as_deref(), code, "{name}");
        }
        assert!(
            code_from_name("A very long access point name")
                .unwrap()
                .len()
                <= MAX_CODE_LEN
        );
        assert_eq!(
            code_from_name("A very long access point name").as_deref(),
            Some("A-VERY-LONG-ACCE")
        );
    }

    #[test]
    fn auto_codes() {
        assert!(is_auto_code("AP01", "AP"));
        assert!(is_auto_code("ap12", "AP"));
        assert!(!is_auto_code("AP", "AP"));
        assert!(!is_auto_code("AP-OFFICE", "AP"));
        assert!(!is_auto_code("SW01", "AP"));
    }

    #[test]
    fn accepts_and_uppercases_valid_codes() {
        assert_eq!(normalize_code(" hq ").unwrap(), "HQ");
        assert_eq!(normalize_code("vie-1").unwrap(), "VIE-1");
        assert_eq!(normalize_code("RK01").unwrap(), "RK01");
        assert_eq!(normalize_code("2").unwrap(), "2");
        assert_eq!(normalize_code("A.B_C-D").unwrap(), "A.B_C-D");
        assert_eq!(normalize_code("ABCDEFGHIJKLMNOP").unwrap().len(), 16);
    }

    #[test]
    fn rejects_invalid_codes() {
        for bad in [
            "",
            "   ",
            "sw 1",
            "-SW",
            ".A",
            "ABCDEFGHIJKLMNOPQ",
            "SW/1",
            "ÄB",
            "a'b",
        ] {
            assert!(normalize_code(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn next_free_code_skips_taken_numbers() {
        assert_eq!(next_free_code("sw", &[]), "SW01");
        let taken = vec!["SW01".to_string(), "sw02".to_string(), "SW04".to_string()];
        assert_eq!(next_free_code("SW", &taken), "SW03");
        let many: Vec<String> = (1..=99).map(|n| format!("PP{n:02}")).collect();
        assert_eq!(next_free_code("PP", &many), "PP100");
    }

    #[test]
    fn unique_variants_stay_valid() {
        assert_eq!(unique_variant("SW01", &[]), "SW01");
        assert_eq!(unique_variant("SW01", &["sw01".into()]), "SW01-2");
        assert_eq!(
            unique_variant("SW01", &["SW01".into(), "SW01-2".into()]),
            "SW01-3"
        );
        let long = "ABCDEFGHIJKLMNOP";
        let v = unique_variant(long, &[long.into()]);
        assert_eq!(v, "ABCDEFGHIJKLMN-2");
        assert!(normalize_code(&v).is_ok());
    }

    #[test]
    fn builds_paths() {
        assert_eq!(
            path(&["ACME", "HQ", "2", "MDF", "RK01", "SW02", "13"]),
            "ACME/HQ/2/MDF/RK01/SW02/13"
        );
    }
}
