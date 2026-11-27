//! Uploaded images (floor plans): identified by their bytes, never by name
//! or the browser's claimed type, with the pixel size read from the header.
//! Only PNG, JPEG and WebP are accepted; SVG is refused because it can carry
//! scripts.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub mime: &'static str,
    pub ext: &'static str,
    pub width: u32,
    pub height: u32,
}

fn be16(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?])))
}
fn le16(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes([*b.get(i)?, *b.get(i + 1)?])))
}
fn be32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?))
}
fn le24(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from(*b.get(i)?) | u32::from(*b.get(i + 1)?) << 8 | u32::from(*b.get(i + 2)?) << 16)
}

fn png(b: &[u8]) -> Option<ImageInfo> {
    if !b.starts_with(b"\x89PNG\r\n\x1a\n") || b.get(12..16)? != b"IHDR" {
        return None;
    }
    Some(ImageInfo {
        mime: "image/png",
        ext: "png",
        width: be32(b, 16)?,
        height: be32(b, 20)?,
    })
}

fn jpeg(b: &[u8]) -> Option<ImageInfo> {
    if !b.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    // Walk the segments to the first start-of-frame marker.
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            return None;
        }
        let marker = b[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        let len = be16(b, i + 2)? as usize;
        let sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if sof {
            return Some(ImageInfo {
                mime: "image/jpeg",
                ext: "jpg",
                height: be16(b, i + 5)?,
                width: be16(b, i + 7)?,
            });
        }
        if len < 2 {
            return None;
        }
        i += 2 + len;
    }
    None
}

fn webp(b: &[u8]) -> Option<ImageInfo> {
    if b.get(0..4)? != b"RIFF" || b.get(8..12)? != b"WEBP" {
        return None;
    }
    let (w, h) = match b.get(12..16)? {
        b"VP8 " => (le16(b, 26)? & 0x3FFF, le16(b, 28)? & 0x3FFF),
        b"VP8L" => {
            let v = u32::from_le_bytes(b.get(21..25)?.try_into().ok()?);
            ((v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1)
        }
        b"VP8X" => (le24(b, 24)? + 1, le24(b, 27)? + 1),
        _ => return None,
    };
    Some(ImageInfo {
        mime: "image/webp",
        ext: "webp",
        width: w,
        height: h,
    })
}

/// Identifies an image. None if it isn't a PNG, JPEG or WebP with a
/// sensible size (1 to 20,000 pixels each way).
pub fn sniff(bytes: &[u8]) -> Option<ImageInfo> {
    let info = png(bytes).or_else(|| jpeg(bytes)).or_else(|| webp(bytes))?;
    let ok = |v: u32| (1..=20_000).contains(&v);
    (ok(info.width) && ok(info.height)).then_some(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        v.extend(w.to_be_bytes());
        v.extend(h.to_be_bytes());
        v.extend([8, 6, 0, 0, 0]);
        v
    }

    #[test]
    fn png_size() {
        assert_eq!(
            sniff(&png_bytes(1600, 900)).map(|i| (i.mime, i.width, i.height)),
            Some(("image/png", 1600, 900))
        );
        assert!(sniff(&png_bytes(0, 900)).is_none());
        assert!(sniff(&png_bytes(30_000, 10)).is_none());
    }

    #[test]
    fn jpeg_size() {
        // SOI, an APP0 segment, then SOF0 with height 480 and width 640.
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00];
        v.extend([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x01, 0xE0, 0x02, 0x80]);
        let i = sniff(&v).unwrap();
        assert_eq!((i.ext, i.width, i.height), ("jpg", 640, 480));
        assert!(sniff(&[0xFF, 0xD8, 0x00]).is_none());
    }

    #[test]
    fn webp_sizes() {
        let mut lossy = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0".to_vec();
        lossy.extend([0, 0, 0, 0x9D, 0x01, 0x2A]);
        lossy.extend(800u16.to_le_bytes());
        lossy.extend(600u16.to_le_bytes());
        assert_eq!(sniff(&lossy).map(|i| (i.width, i.height)), Some((800, 600)));
        let mut x = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0".to_vec();
        x.extend([0x1F, 0x03, 0x00, 0x57, 0x02, 0x00]); // 799+1, 599+1
        assert_eq!(sniff(&x).map(|i| (i.width, i.height)), Some((800, 600)));
    }

    #[test]
    fn refuses_other_files() {
        assert!(
            sniff(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
                .is_none()
        );
        assert!(sniff(b"GIF89a").is_none());
        assert!(sniff(b"").is_none());
        assert!(sniff(b"%PDF-1.7").is_none());
    }
}
