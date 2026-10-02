//! Text encodings: detect and decode what is read, and write it back in the
//! same encoding. UTF-16 is handled here because encoding_rs only decodes it.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

/// A decoded file and how to write it back.
#[derive(Debug, PartialEq)]
pub struct Decoded {
    pub text: String,
    /// encoding_rs name: "UTF-8", "GBK", "UTF-16LE", …
    pub encoding: &'static str,
    /// The file started with a byte order mark.
    pub bom: bool,
    /// Detection had little evidence to go on.
    pub guessed: bool,
}

#[derive(Debug, PartialEq)]
pub enum DecodeError {
    /// Looks like a binary file.
    Binary,
    /// No encoding decodes it cleanly.
    Unknown,
}

/// Fewer non-ASCII bytes than this and a non-UTF-8 guess is flagged as uncertain.
const EVIDENCE: usize = 24;

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// Decode with a known encoding (the user picked one). Bad bytes become U+FFFD.
pub fn decode_as(bytes: &[u8], label: &str) -> Option<Decoded> {
    let encoding = Encoding::for_label(label.as_bytes())?;
    let (bom_encoding, bom_len) = Encoding::for_bom(bytes).unwrap_or((encoding, 0));
    let bom = bom_len > 0 && bom_encoding == encoding;
    let body = if bom { &bytes[bom_len..] } else { bytes };
    let (text, _) = encoding.decode_without_bom_handling(body);
    Some(Decoded { text: text.into_owned(), encoding: encoding.name(), bom, guessed: false })
}

/// Detect the encoding and decode.
pub fn decode(bytes: &[u8]) -> Result<Decoded, DecodeError> {
    if let Some((encoding, len)) = Encoding::for_bom(bytes) {
        let (text, _) = encoding.decode_without_bom_handling(&bytes[len..]);
        return Ok(Decoded { text: text.into_owned(), encoding: encoding.name(), bom: true, guessed: false });
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        if looks_binary(bytes) {
            return Err(DecodeError::Binary);
        }
        return Ok(Decoded { text: text.to_owned(), encoding: UTF_8.name(), bom: false, guessed: false });
    }
    if looks_binary(bytes) {
        return Err(DecodeError::Binary);
    }
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    let encoding = detector.guess(None, chardetng::Utf8Detection::Allow);
    let text = encoding
        .decode_without_bom_handling_and_without_replacement(bytes)
        .ok_or(DecodeError::Unknown)?;
    let evidence = bytes.iter().filter(|b| !b.is_ascii()).count();
    Ok(Decoded { text: text.into_owned(), encoding: encoding.name(), bom: false, guessed: evidence < EVIDENCE })
}

#[derive(Debug, PartialEq)]
pub enum EncodeError {
    UnknownEncoding,
    /// Some characters have no representation in the encoding.
    Unmappable,
}

/// Encode `text` for writing, refusing rather than losing characters.
pub fn encode(text: &str, label: &str, bom: bool) -> Result<Vec<u8>, EncodeError> {
    let encoding = Encoding::for_label(label.as_bytes()).ok_or(EncodeError::UnknownEncoding)?;
    let mut out = Vec::with_capacity(text.len() + 3);
    if encoding == UTF_16LE || encoding == UTF_16BE {
        let le = encoding == UTF_16LE;
        if bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        return Ok(out);
    }
    if encoding == UTF_8 {
        if bom {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        out.extend_from_slice(text.as_bytes());
        return Ok(out);
    }
    let (bytes, _, unmappable) = encoding.encode(text);
    if unmappable {
        return Err(EncodeError::Unmappable);
    }
    out.extend_from_slice(&bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gbk(s: &str) -> Vec<u8> {
        encoding_rs::GBK.encode(s).0.into_owned()
    }

    #[test]
    fn utf8_plain_and_bom() {
        let d = decode("héllo 你好".as_bytes()).unwrap();
        assert_eq!((d.encoding, d.bom, d.text.as_str()), ("UTF-8", false, "héllo 你好"));
        let d = decode(b"\xEF\xBB\xBFabc").unwrap();
        assert_eq!((d.encoding, d.bom, d.text.as_str()), ("UTF-8", true, "abc"));
        assert_eq!(encode("abc", "UTF-8", true).unwrap(), b"\xEF\xBB\xBFabc");
    }

    #[test]
    fn gbk_round_trip() {
        let source = "名称,数量,备注\n苹果,3,红色的苹果很甜\n香蕉,12,产地是海南省三亚市\n";
        let bytes = gbk(source);
        let d = decode(&bytes).unwrap();
        assert_eq!(d.encoding, "GBK");
        assert_eq!(d.text, source);
        assert!(!d.guessed);
        assert_eq!(encode(&d.text, d.encoding, d.bom).unwrap(), bytes);
    }

    #[test]
    fn short_gbk_is_flagged_as_a_guess() {
        let d = decode(&gbk("你好")).unwrap();
        assert!(d.guessed);
    }

    #[test]
    fn unmappable_is_refused() {
        assert_eq!(encode("表情 😀", "GBK", false), Err(EncodeError::Unmappable));
        assert!(encode("表情 😀", "gb18030", false).is_ok());
    }

    #[test]
    fn utf16_both_ways() {
        let le = encode("A你", "UTF-16LE", true).unwrap();
        assert_eq!(le, [0xFF, 0xFE, 0x41, 0x00, 0x60, 0x4F]);
        let d = decode(&le).unwrap();
        assert_eq!((d.encoding, d.bom, d.text.as_str()), ("UTF-16LE", true, "A你"));
        let be = encode("A你", "UTF-16BE", true).unwrap();
        let d = decode(&be).unwrap();
        assert_eq!((d.encoding, d.text.as_str()), ("UTF-16BE", "A你"));
    }

    #[test]
    fn binary_is_rejected() {
        assert_eq!(decode(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), Err(DecodeError::Binary));
        assert_eq!(decode(b"abc\0def"), Err(DecodeError::Binary));
    }

    #[test]
    fn explicit_encoding_overrides_detection() {
        let bytes = gbk("你好");
        let d = decode_as(&bytes, "Big5").unwrap();
        assert_eq!(d.encoding, "Big5");
        let d = decode_as(&bytes, "gbk").unwrap();
        assert_eq!(d.text, "你好");
        assert!(decode_as(&bytes, "nope").is_none());
    }
}
