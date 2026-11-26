//! Password hashing: argon2id for new hashes. bcrypt hashes (from v1) are
//! still accepted and flagged for rehashing on the next successful login.

use std::sync::OnceLock;

use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;

pub const MIN_LEN: usize = 10;
pub const MAX_LEN: usize = 256;

pub fn validate_new(password: &str) -> Result<(), &'static str> {
    let len = password.chars().count();
    if len < MIN_LEN {
        return Err("Password must be at least 10 characters");
    }
    if len > MAX_LEN {
        return Err("Password must be at most 256 characters");
    }
    Ok(())
}

pub fn hash(password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("argon2 hashing cannot fail")
        .to_string()
}

#[derive(Debug, PartialEq, Eq)]
pub struct Verified {
    pub ok: bool,
    /// The stored hash uses an old scheme and should be replaced.
    pub needs_rehash: bool,
}

pub fn verify(password: &str, stored: &str) -> Verified {
    if stored.starts_with("$2") {
        let ok = bcrypt::verify(password, stored).unwrap_or(false);
        return Verified {
            ok,
            needs_rehash: ok,
        };
    }
    let ok = PasswordHash::new(stored)
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false);
    Verified {
        ok,
        needs_rehash: false,
    }
}

/// Verifies against a fixed hash so that a login for an unknown username
/// takes as long as one with a wrong password.
pub fn verify_dummy(password: &str) {
    static DUMMY: OnceLock<String> = OnceLock::new();
    let stored = DUMMY.get_or_init(|| hash("rackpath-timing-equaliser"));
    let _ = verify(password, stored);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argon2_round_trip() {
        let h = hash("correct horse battery");
        assert!(h.starts_with("$argon2id$"));
        assert_eq!(
            verify("correct horse battery", &h),
            Verified {
                ok: true,
                needs_rehash: false
            }
        );
        assert!(!verify("wrong password!", &h).ok);
        assert_ne!(h, hash("correct horse battery"), "salted");
    }

    #[test]
    fn bcrypt_from_v1_is_accepted_and_flagged() {
        let v1 = bcrypt::hash("rackpath", 4).unwrap();
        assert_eq!(
            verify("rackpath", &v1),
            Verified {
                ok: true,
                needs_rehash: true
            }
        );
        assert_eq!(
            verify("nope", &v1),
            Verified {
                ok: false,
                needs_rehash: false
            }
        );
    }

    #[test]
    fn garbage_hash_never_verifies() {
        assert!(!verify("x", "not-a-hash").ok);
        assert!(!verify("", "").ok);
    }

    #[test]
    fn length_rules() {
        assert!(validate_new("short").is_err());
        assert!(validate_new("exactly10!").is_ok());
        assert!(validate_new(&"x".repeat(257)).is_err());
    }
}
