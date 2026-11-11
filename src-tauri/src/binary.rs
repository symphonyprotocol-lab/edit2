//! Binary files shown by a viewer (PDF, images, Office documents). They never go through the
//! text codec: the frontend asks what the file is, then either loads it
//! through the asset protocol (images) or reads byte ranges of it as the
//! viewer needs them (PDF), so a large document opens without being read
//! whole. Nothing here writes.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// What a viewable file is, by its extension.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Kind {
    Pdf,
    Image,
    Office,
}

const PDF_EXTS: &[&str] = &["pdf"];

/// Image extensions with a viewer. SVG is not here: it opens as XML.
pub const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "avif", "tif", "tiff", "heic", "heif",
];

/// Office documents: the zip-based ones (Office Open XML, OpenDocument) and
/// the legacy binary ones (OLE compound files). Old Word and PowerPoint files
/// only get a button to open them in another app; old Excel files are shown.
pub const OFFICE_EXTS: &[&str] = &["docx", "xlsx", "xlsm", "xlsb", "ods", "pptx", "doc", "xls", "ppt"];

/// Largest range one call returns.
pub const MAX_RANGE: u64 = 64 * 1024 * 1024;

/// How much of the start of a file the sniffing looks at.
const HEAD: usize = 1024 + 5;

fn is_ext(path: &Path, ext: &str) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

pub fn kind_of(path: &Path) -> Option<Kind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if PDF_EXTS.contains(&ext.as_str()) {
        Some(Kind::Pdf)
    } else if IMAGE_EXTS.contains(&ext.as_str()) {
        Some(Kind::Image)
    } else if OFFICE_EXTS.contains(&ext.as_str()) {
        Some(Kind::Office)
    } else {
        None
    }
}

/// Whether the start of a file looks like a PDF (the header may come after some junk, as in other readers).
pub fn looks_like_pdf(head: &[u8]) -> bool {
    head.windows(5).take(1024).any(|w| w == b"%PDF-")
}

/// Whether the start of a file looks like an image of any supported type.
/// The extension is not required to match: web views go by content, and a
/// `.jpg` that is really a PNG still shows.
pub fn looks_like_image(head: &[u8]) -> bool {
    let at = |i: usize, sig: &[u8]| head.get(i..i + sig.len()) == Some(sig);
    at(0, b"\x89PNG\r\n\x1a\n")
        || at(0, b"\xFF\xD8\xFF")
        || at(0, b"GIF87a")
        || at(0, b"GIF89a")
        || at(0, b"BM")
        || at(0, b"\0\0\x01\0") // ICO
        || at(0, b"icns")
        || (at(0, b"RIFF") && at(8, b"WEBP"))
        || at(0, b"II*\0") // TIFF, little-endian
        || at(0, b"MM\0*") // TIFF, big-endian
        || (at(4, b"ftyp")
            && [&b"avif"[..], b"avis", b"heic", b"heix", b"hevc", b"heim", b"heis", b"mif1", b"msf1"]
                .iter()
                .any(|brand| at(8, brand)))
}

/// Whether the start of a file looks like an Office document: a zip archive
/// (.docx, .xlsx, .pptx, .ods) or an OLE compound file (.doc, .xls, .ppt).
pub fn looks_like_office(head: &[u8]) -> bool {
    head.starts_with(b"PK\x03\x04") || head.starts_with(b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1")
}

/// Whether a file starts like markup: many systems export HTML or
/// SpreadsheetML (XML) tables under a `.xls` name, and Excel opens them.
pub fn looks_like_markup(head: &[u8]) -> bool {
    let text = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
    let start = text.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(text.len());
    text[start..].starts_with(b"<")
}

fn head_of(path: &Path) -> Result<Vec<u8>, String> {
    let mut head = Vec::with_capacity(HEAD);
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(HEAD as u64)
        .read_to_end(&mut head)
        .map_err(|e| e.to_string())?;
    Ok(head)
}

/// Check that `path` is a file of a viewable kind, by extension and content.
pub fn check(path: &Path) -> Result<Kind, String> {
    let kind = kind_of(path).ok_or("只能以只读方式查看 PDF、图片和 Office 文件")?;
    let head = head_of(path)?;
    match kind {
        Kind::Pdf if looks_like_pdf(&head) => Ok(kind),
        Kind::Pdf => Err("这不是 PDF 文件（缺少 %PDF 文件头）".into()),
        Kind::Image if looks_like_image(&head) => Ok(kind),
        Kind::Image => Err("这不是可以识别的图片文件".into()),
        Kind::Office if looks_like_office(&head) => Ok(kind),
        Kind::Office if is_ext(path, "xls") && looks_like_markup(&head) => Ok(kind),
        Kind::Office => Err("这不是可以识别的 Office 文件".into()),
    }
}

/// Up to `length` bytes from `offset`; shorter at the end of the file.
pub fn read_range(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    if kind_of(path).is_none() {
        return Err("只能以字节方式读取 PDF、图片和 Office 文件".into());
    }
    if length > MAX_RANGE {
        return Err(format!("一次最多读取 {MAX_RANGE} 字节"));
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("edit2-binary-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::File::create(&path).unwrap().write_all(bytes).unwrap();
        path
    }

    #[test]
    fn kinds_come_from_the_extension() {
        assert_eq!(kind_of(Path::new("/a/b.pdf")), Some(Kind::Pdf));
        assert_eq!(kind_of(Path::new("/a/B.PDF")), Some(Kind::Pdf));
        assert_eq!(kind_of(Path::new("/a/b.JPG")), Some(Kind::Image));
        assert_eq!(kind_of(Path::new("/a/b.icns")), Some(Kind::Image));
        assert_eq!(kind_of(Path::new("/a/b.svg")), None);
        assert_eq!(kind_of(Path::new("/a/b.DOCX")), Some(Kind::Office));
        assert_eq!(kind_of(Path::new("/a/b.ppt")), Some(Kind::Office));
        assert_eq!(kind_of(Path::new("/a/pdf")), None);
    }

    #[test]
    fn pdf_header_is_sniffed() {
        assert!(looks_like_pdf(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3"));
        assert!(looks_like_pdf(b"\xEF\xBB\xBFjunk%PDF-1.4"));
        assert!(!looks_like_pdf(b"<html>%PD"));
        assert!(!looks_like_pdf(b""));
    }

    #[test]
    fn image_signatures_are_sniffed() {
        for head in [
            &b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"[..],
            b"\xFF\xD8\xFF\xE0\0\x10JFIF",
            b"GIF89a\x01\0",
            b"BM6\0\0\0",
            b"\0\0\x01\0\x01\0",
            b"icns\0\0\x10\0",
            b"RIFF\x24\0\0\0WEBPVP8 ",
            b"II*\0\x08\0\0\0",
            b"MM\0*\0\0\0\x08",
            b"\0\0\0\x1cftypavif\0\0\0\0",
            b"\0\0\0\x18ftypheic\0\0\0\0",
        ] {
            assert!(looks_like_image(head), "{head:?}");
        }
        assert!(!looks_like_image(b"%PDF-1.4"));
        assert!(!looks_like_image(b"<svg xmlns"));
        assert!(!looks_like_image(b"RIFF\0\0\0\0WAVE"));
        assert!(!looks_like_image(b""));
    }

    #[test]
    fn check_refuses_other_files() {
        assert_eq!(check(&temp("ok.pdf", b"%PDF-1.4\n1 0 obj\n")), Ok(Kind::Pdf));
        assert!(check(&temp("fake.pdf", b"just text")).is_err());
        assert!(check(&temp("doc.txt", b"%PDF-1.4")).is_err());
        assert_eq!(check(&temp("ok.png", b"\x89PNG\r\n\x1a\n\0\0")), Ok(Kind::Image));
        // Named .jpg but a PNG inside: still an image.
        assert_eq!(check(&temp("misnamed.jpg", b"\x89PNG\r\n\x1a\n\0\0")), Ok(Kind::Image));
        assert!(check(&temp("fake.png", b"not an image")).is_err());
        assert_eq!(check(&temp("ok.docx", b"PK\x03\x04\x14\0")), Ok(Kind::Office));
        assert_eq!(check(&temp("old.xls", b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1\0")), Ok(Kind::Office));
        assert!(check(&temp("fake.pptx", b"<html>")).is_err());
        // An HTML or XML table saved as .xls (common in exports) is let through; not as .xlsx.
        assert_eq!(check(&temp("export.xls", b"\xEF\xBB\xBF\r\n<html><table>")), Ok(Kind::Office));
        assert_eq!(check(&temp("ml.xls", b"<?xml version=\"1.0\"?><Workbook>")), Ok(Kind::Office));
        assert!(check(&temp("export.xlsx", b"<html><table>")).is_err());
        assert!(check(&temp("plain.xls", b"a\tb\n")).is_err());
    }

    #[test]
    fn ranges_are_read_without_writing() {
        let bytes: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
        let path = temp("range.pdf", &bytes);
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(read_range(&path, 0, 5).unwrap(), &bytes[..5]);
        assert_eq!(read_range(&path, 9_998, 100).unwrap(), &bytes[9_998..]);
        assert!(read_range(&path, 20_000, 10).unwrap().is_empty());
        assert!(read_range(&path, 0, MAX_RANGE + 1).is_err());
        assert!(read_range(&temp("x.txt", b"abc"), 0, 3).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
    }
}
