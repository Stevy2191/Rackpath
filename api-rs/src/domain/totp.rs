//! Two-factor login: TOTP (RFC 6238; SHA-1, 6 digits, 30 s) with replay
//! protection, plus single-use recovery codes.

use rand::RngCore;
use subtle::ConstantTimeEq;
use totp_rs::{Algorithm, TOTP};

use crate::util::sha256_hex;

pub const STEP_SECS: u64 = 30;
const SECRET_LEN: usize = 20; // 160 bits, as RFC 4226 recommends
pub const RECOVERY_CODE_COUNT: usize = 10;

pub fn generate_secret() -> Vec<u8> {
    let mut secret = vec![0u8; SECRET_LEN];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    secret
}

fn totp(secret: &[u8], account: &str) -> TOTP {
    // otpauth labels can't contain ':'.
    let account = account.replace(':', "_");
    TOTP::new_unchecked(
        Algorithm::SHA1,
        6,
        0,
        STEP_SECS,
        secret.to_vec(),
        Some("Rackpath".to_string()),
        account,
    )
}

/// The otpauth:// URI an authenticator app scans (rendered as a QR code by the UI).
pub fn otpauth_url(secret: &[u8], account: &str) -> String {
    totp(secret, account).get_url()
}

pub fn secret_base32(secret: &[u8]) -> String {
    data_encoding::BASE32_NOPAD.encode(secret)
}

/// The code an authenticator app shows at `unix` time (used by tests and
/// tooling; the server only ever verifies).
pub fn code_at(secret: &[u8], unix: u64) -> String {
    totp(secret, "x").generate(unix)
}

/// Checks a 6-digit code against the current step and one step either
/// side (clock drift). Returns the matched step, which must be newer than
/// `last_step` so a code can't be replayed.
pub fn verify(secret: &[u8], code: &str, now_unix: u64, last_step: Option<i64>) -> Option<i64> {
    let code = code.trim().replace(' ', "");
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let t = totp(secret, "x");
    let current = (now_unix / STEP_SECS) as i64;
    for step in [current - 1, current, current + 1] {
        if step < 0 || last_step.is_some_and(|last| step <= last) {
            continue;
        }
        let expected = t.generate(step as u64 * STEP_SECS);
        if bool::from(expected.as_bytes().ct_eq(code.as_bytes())) {
            return Some(step);
        }
    }
    None
}

/// Ten codes like `K7QF2-MZ4XA`. Returned in plain text once; stored hashed.
pub fn generate_recovery_codes() -> Vec<String> {
    (0..RECOVERY_CODE_COUNT)
        .map(|_| {
            let mut bytes = [0u8; 7];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            let raw = data_encoding::BASE32_NOPAD.encode(&bytes);
            format!("{}-{}", &raw[0..5], &raw[5..10])
        })
        .collect()
}

pub fn normalize_recovery_code(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase()
}

pub fn hash_recovery_code(code: &str) -> String {
    sha256_hex(&normalize_recovery_code(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 appendix B test vector (SHA-1 secret "12345678901234567890").
    #[test]
    fn matches_rfc6238_vector() {
        let secret = b"12345678901234567890";
        // T = 59 s → 94287082 (8 digits); 6-digit form is 287082.
        assert_eq!(totp(secret, "x").generate(59), "287082");
        assert_eq!(verify(secret, "287082", 59, None), Some(1));
    }

    #[test]
    fn accepts_adjacent_steps_and_rejects_replays() {
        let secret = generate_secret();
        let t = totp(&secret, "x");
        let now = 1_000_000_000u64;
        let code_now = t.generate(now);
        let step = (now / STEP_SECS) as i64;
        assert_eq!(verify(&secret, &code_now, now, None), Some(step));
        assert_eq!(
            verify(&secret, &code_now, now, Some(step)),
            None,
            "same code twice"
        );
        let previous = t.generate(now - STEP_SECS);
        assert_eq!(
            verify(&secret, &previous, now, None),
            Some(step - 1),
            "30 s of clock drift"
        );
        let old = t.generate(now - 5 * STEP_SECS);
        assert_eq!(verify(&secret, &old, now, None), None);
        assert_eq!(verify(&secret, "12345", now, None), None);
        assert_eq!(verify(&secret, "abcdef", now, None), None);
    }

    #[test]
    fn otpauth_url_has_issuer_and_secret() {
        let secret = generate_secret();
        let url = otpauth_url(&secret, "ad:min");
        assert!(url.starts_with("otpauth://totp/Rackpath:ad_min?"));
        assert!(url.contains(&secret_base32(&secret)));
    }

    #[test]
    fn recovery_codes_are_unique_and_normalize() {
        let codes = generate_recovery_codes();
        assert_eq!(codes.len(), 10);
        let mut sorted = codes.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 10);
        assert_eq!(codes[0].len(), 11);
        let lower = codes[0].to_lowercase().replace('-', " ");
        assert_eq!(hash_recovery_code(&lower), hash_recovery_code(&codes[0]));
    }
}
