//! A system rendering of a document as HTML, where there is one: macOS Quick
//! Look (`qlmanage -p -o`), which draws Office files with Apple's own
//! importer. Its attachments (pictures, charts as PDF) are inlined as `data:`
//! URIs so the page stands alone; the frontend shows it in a sandboxed frame
//! without scripts. Elsewhere there is none and the frontend falls back.

use std::path::Path;

/// Inline every attachment file the page refers to by its quoted name.
pub fn inline_attachments(html: &str, attachments: &[(String, String, Vec<u8>)]) -> String {
    let mut out = html.to_string();
    for (name, mime, bytes) in attachments {
        let uri = format!("data:{mime};base64,{}", base64(bytes));
        for q in ['"', '\''] {
            out = out.replace(&format!("{q}{name}{q}"), &format!("{q}{uri}{q}"));
        }
        out = out.replace(&format!("({name})"), &format!("({uri})"));
    }
    out
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mime_of(name: &str) -> &'static str {
    match name.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("tif" | "tiff") => "image/tiff",
        Some("pdf") => "application/pdf",
        Some("svg") => "image/svg+xml",
        Some("css") => "text/css",
        Some("html") => "text/html",
        _ => "application/octet-stream",
    }
}

pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Quick Look's HTML for `path`, attachments inlined; None where there is no Quick Look.
#[cfg(target_os = "macos")]
pub fn preview_html(path: &Path) -> Result<Option<String>, String> {
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};

    static RUN: AtomicU32 = AtomicU32::new(0);
    let out = std::env::temp_dir().join(format!(
        "edit2-quicklook-{}-{}",
        std::process::id(),
        RUN.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut child = Command::new("/usr/bin/qlmanage")
            .arg("-p")
            .arg("-o")
            .arg(&out)
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let started = Instant::now();
        loop {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                break;
            }
            if started.elapsed() > Duration::from_secs(60) {
                let _ = child.kill();
                return Err("系统预览超时".to_string());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let bundle = std::fs::read_dir(&out)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == "qlpreview"))
            .ok_or("系统预览没有生成内容")?;
        let html = std::fs::read_to_string(bundle.join("Preview.html")).map_err(|_| "系统预览不是网页".to_string())?;
        let mut attachments = Vec::new();
        for entry in std::fs::read_dir(&bundle).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("Attachment") {
                let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
                attachments.push((name.clone(), mime_of(&name).to_string(), bytes));
            }
        }
        Ok(Some(inline_attachments(&html, &attachments)))
    })();
    let _ = std::fs::remove_dir_all(&out);
    result
}

#[cfg(not(target_os = "macos"))]
pub fn preview_html(_path: &Path) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xFF, 0xEE, 0x00]), "/+4A");
    }

    #[test]
    fn attachments_are_inlined_by_exact_name() {
        let html = r#"<img src="Attachment1.png"><img src='Attachment10.png'><div style="background:url(Attachment1.png)">"#;
        let out = inline_attachments(
            html,
            &[
                ("Attachment1.png".into(), "image/png".into(), b"a".to_vec()),
                ("Attachment10.png".into(), "image/png".into(), b"b".to_vec()),
            ],
        );
        assert_eq!(
            out,
            r#"<img src="data:image/png;base64,YQ=="><img src='data:image/png;base64,Yg=='><div style="background:url(data:image/png;base64,YQ==)">"#
        );
    }
}
