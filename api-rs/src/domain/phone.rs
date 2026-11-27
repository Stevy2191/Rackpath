//! Phone numbers: US/NANP numbers are stored as `(979) 203-4748`; anything
//! else (international numbers, extensions, notes) is kept as typed.

/// Formats a 10-digit US number, or 11 digits starting with the country
/// code 1, as `(xxx) xxx-xxxx`. Only digits, spaces and `()-.+` may appear
/// around them; any other text (`x12`, `ext`, `ask for Bob`) or another
/// number of digits leaves the value unchanged (trimmed).
pub fn format(value: &str) -> String {
    let value = value.trim();
    if !value
        .chars()
        .all(|c| c.is_ascii_digit() || " ()-.+".contains(c))
    {
        return value.to_string();
    }
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    let national = match digits.len() {
        // A leading + means a country code follows: only +1 is a US one.
        10 if !value.starts_with('+') => &digits[..],
        11 if digits.starts_with('1')
            && (!value.starts_with('+') || value[1..].trim_start().starts_with('1')) =>
        {
            &digits[1..]
        }
        _ => return value.to_string(),
    };
    format!(
        "({}) {}-{}",
        &national[..3],
        &national[3..6],
        &national[6..]
    )
}

#[cfg(test)]
mod tests {
    use super::format;

    #[test]
    fn us_numbers_are_formatted() {
        for typed in [
            "9792034748",
            "979-203-4748",
            "979.203.4748",
            "(979) 203-4748",
            "(979)203-4748",
            " 979 203 4748 ",
            "1 979 203 4748",
            "1-979-203-4748",
            "+1 979 203 4748",
            "+1 (979) 203-4748",
        ] {
            assert_eq!(format(typed), "(979) 203-4748", "{typed}");
        }
    }

    #[test]
    fn anything_else_is_kept_as_typed() {
        for typed in [
            "203-4748",            // 7 digits
            "+44 20 7946 0958",    // international
            "+49 30 123456",       // international
            "979-203-4748 x12",    // extension
            "979-203-4748 ext. 5", // extension
            "ask for the desk",    // a note
            "29792034748",         // 11 digits, not starting with 1
            "",
        ] {
            assert_eq!(format(typed), typed.trim(), "{typed}");
        }
    }
}
