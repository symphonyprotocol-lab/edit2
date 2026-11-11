//! Binary files shown by a viewer (PDF). They never go through the text codec:
//! the frontend asks what the file is, then reads byte ranges of it as the
//! viewer needs them, so a large document opens without being read whole.
//! Nothing here writes.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Extensions whose files may be read as bytes.
const VIEWABLE: &[&str] = &["pdf"];

/// Largest range one call returns.
pub const MAX_RANGE: u64 = 64 * 1024 * 1024;

/// How far into the file the `%PDF-` header may start (as in other readers).
const HEADER_WINDOW: usize = 1024;

pub fn is_viewable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIEWABLE.contains(&e.to_ascii_lowercase().as_str()))
}

/// Whether the start of a file looks like a PDF.
pub fn looks_like_pdf(head: &[u8]) -> bool {
    head.windows(5).take(HEADER_WINDOW).any(|w| w == b"%PDF-")
}

/// Check that `path` is a PDF this module may read.
pub fn check(path: &Path) -> Result<(), String> {
    if !is_viewable(path) {
        return Err("只能以字节方式读取 PDF 文件".into());
    }
    let mut head = Vec::with_capacity(HEADER_WINDOW + 5);
    File::open(path)
        .map_err(|e| e.to_string())?
        .take((HEADER_WINDOW + 5) as u64)
        .read_to_end(&mut head)
        .map_err(|e| e.to_string())?;
    if looks_like_pdf(&head) {
        Ok(())
    } else {
        Err("这不是 PDF 文件（缺少 %PDF 文件头）".into())
    }
}

/// Up to `length` bytes from `offset`; shorter at the end of the file.
pub fn read_range(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    if !is_viewable(path) {
        return Err("只能以字节方式读取 PDF 文件".into());
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
    fn only_pdfs_are_viewable() {
        assert!(is_viewable(Path::new("/a/b.pdf")));
        assert!(is_viewable(Path::new("/a/B.PDF")));
        assert!(!is_viewable(Path::new("/a/b.png")));
        assert!(!is_viewable(Path::new("/a/pdf")));
    }

    #[test]
    fn header_is_sniffed() {
        assert!(looks_like_pdf(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3"));
        assert!(looks_like_pdf(b"\xEF\xBB\xBFjunk%PDF-1.4"));
        assert!(!looks_like_pdf(b"<html>%PD"));
        assert!(!looks_like_pdf(b""));
    }

    #[test]
    fn check_refuses_other_files() {
        assert!(check(&temp("ok.pdf", b"%PDF-1.4\n1 0 obj\n")).is_ok());
        assert!(check(&temp("fake.pdf", b"just text")).is_err());
        assert!(check(&temp("doc.txt", b"%PDF-1.4")).is_err());
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
