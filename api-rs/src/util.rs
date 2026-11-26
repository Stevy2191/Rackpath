//! Small shared helpers.

use rand::RngCore;
use sha2::{Digest, Sha256};
use time::format_description::FormatItem;
use time::macros::format_description;
use time::{Duration, OffsetDateTime, PrimitiveDateTime};

/// Fixed-width UTC timestamp format used everywhere in the database, so
/// timestamps compare correctly as strings.
const TS_FORMAT: &[FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");

pub fn format_ts(t: OffsetDateTime) -> String {
    t.to_offset(time::UtcOffset::UTC)
        .format(TS_FORMAT)
        .expect("timestamp formats")
}

pub fn parse_ts(s: &str) -> Option<OffsetDateTime> {
    PrimitiveDateTime::parse(s, TS_FORMAT)
        .ok()
        .map(|p| p.assume_utc())
}

pub fn now_ts() -> String {
    format_ts(OffsetDateTime::now_utc())
}

pub fn ts_in(d: Duration) -> String {
    format_ts(OffsetDateTime::now_utc() + d)
}

/// 256-bit random token, URL-safe base64 without padding.
pub fn random_token() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// SHA-256 hex digest. Used for high-entropy tokens (sessions, invitations,
/// recovery codes), where a slow password hash isn't needed.
pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// Human-friendly random password: 20 characters from an unambiguous
/// alphabet (about 100 bits).
pub fn random_password() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let mut out = String::with_capacity(20);
    let mut buf = [0u8; 1];
    while out.len() < 20 {
        rand::rngs::OsRng.fill_bytes(&mut buf);
        // Rejection sampling keeps the distribution uniform.
        let limit = 256 - (256 % ALPHABET.len());
        if (buf[0] as usize) < limit {
            out.push(ALPHABET[buf[0] as usize % ALPHABET.len()] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_round_trip_and_sort() {
        let a = now_ts();
        let parsed = parse_ts(&a).unwrap();
        assert_eq!(format_ts(parsed), a);
        let later = ts_in(Duration::seconds(5));
        assert!(later > a);
        assert_eq!(a.len(), "2026-11-26T10:00:00.000Z".len());
    }

    #[test]
    fn tokens_are_random_and_long() {
        let a = random_token();
        assert_ne!(a, random_token());
        assert_eq!(a.len(), 43);
        assert_eq!(random_password().len(), 20);
    }
}
