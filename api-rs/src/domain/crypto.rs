//! Encryption for credentials stored at rest: AES-256-GCM, stored as
//! `"v1:" + base64(iv[12] | tag[16] | ciphertext)`. This is the same format
//! the v1 Node API writes (api/src/utils/secrets.js), so values move between
//! versions unchanged.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;

const PREFIX: &str = "v1:";
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;

#[derive(Clone)]
pub struct SecretBox {
    cipher: Aes256Gcm,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("stored secret is not in the expected format")]
    Format,
    #[error("stored secret could not be decrypted (wrong key or tampered data)")]
    Decrypt,
}

impl SecretBox {
    pub fn new(key: &[u8; 32]) -> SecretBox {
        SecretBox {
            cipher: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key)),
        }
    }

    pub fn encrypt(&self, plaintext: &str) -> String {
        let mut iv = [0u8; IV_LEN];
        rand::rngs::OsRng.fill_bytes(&mut iv);
        // aes-gcm returns ciphertext || tag; the stored layout is iv | tag | ciphertext.
        let sealed = self
            .cipher
            .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
            .expect("AES-GCM encryption cannot fail");
        let (ct, tag) = sealed.split_at(sealed.len() - TAG_LEN);
        let mut out = Vec::with_capacity(IV_LEN + TAG_LEN + ct.len());
        out.extend_from_slice(&iv);
        out.extend_from_slice(tag);
        out.extend_from_slice(ct);
        format!("{PREFIX}{}", B64.encode(out))
    }

    pub fn decrypt(&self, stored: &str) -> Result<String, CryptoError> {
        let data = stored.strip_prefix(PREFIX).ok_or(CryptoError::Format)?;
        let data = B64.decode(data).map_err(|_| CryptoError::Format)?;
        if data.len() < IV_LEN + TAG_LEN {
            return Err(CryptoError::Format);
        }
        let (iv, rest) = data.split_at(IV_LEN);
        let (tag, ct) = rest.split_at(TAG_LEN);
        let mut sealed = Vec::with_capacity(ct.len() + TAG_LEN);
        sealed.extend_from_slice(ct);
        sealed.extend_from_slice(tag);
        let plain = self
            .cipher
            .decrypt(Nonce::from_slice(iv), sealed.as_ref())
            .map_err(|_| CryptoError::Decrypt)?;
        String::from_utf8(plain).map_err(|_| CryptoError::Decrypt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    #[test]
    fn round_trip() {
        let b = SecretBox::new(&key());
        let s = b.encrypt("hello rackpath");
        assert!(s.starts_with("v1:"));
        assert_ne!(s, b.encrypt("hello rackpath"), "random IV each time");
        assert_eq!(b.decrypt(&s).unwrap(), "hello rackpath");
        assert_eq!(b.decrypt(&b.encrypt("")).unwrap(), "");
    }

    #[test]
    fn wrong_key_or_tampering_fails() {
        let b = SecretBox::new(&key());
        let s = b.encrypt("secret");
        let other = SecretBox::new(&[7u8; 32]);
        assert_eq!(other.decrypt(&s), Err(CryptoError::Decrypt));
        let mut raw = B64.decode(&s[3..]).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        assert_eq!(
            b.decrypt(&format!("v1:{}", B64.encode(raw))),
            Err(CryptoError::Decrypt)
        );
        assert_eq!(b.decrypt("plaintext"), Err(CryptoError::Format));
        assert_eq!(b.decrypt("v1:!!!"), Err(CryptoError::Format));
    }

    /// Produced by the v1 Node API (api/src/utils/secrets.js) with key
    /// 000102…1f, so v1 and v2 can read each other's stored secrets.
    #[test]
    fn decrypts_values_written_by_v1_node_api() {
        let b = SecretBox::new(&key());
        assert_eq!(b.decrypt(NODE_FIXTURE).unwrap(), "hello from v1 node");
    }

    const NODE_FIXTURE: &str =
        "v1:LAjSJlNeA6BQMwkXBeCVXDMHnygGjEiUZtNmubZ8yZ0BnlguFfnlG93JUdS2+w==";
}
