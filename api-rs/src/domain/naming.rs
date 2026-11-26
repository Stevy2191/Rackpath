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

/// Joins codes into a full path.
pub fn path(codes: &[&str]) -> String {
    codes.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn builds_paths() {
        assert_eq!(
            path(&["ACME", "HQ", "2", "MDF", "RK01", "SW02", "13"]),
            "ACME/HQ/2/MDF/RK01/SW02/13"
        );
    }
}
