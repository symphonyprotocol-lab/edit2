//! The `preview:` protocol serves HTML documents whose scripts the user chose
//! to run. The page lives in a sandboxed iframe without `allow-same-origin`,
//! so it cannot reach the editor's window or the IPC key; this protocol gives
//! it its own origin and CSP (an iframe from `srcdoc` would inherit the
//! editor's CSP, which blocks inline scripts).
//!
//! URLs look like `preview://localhost/<token>/<relative path>`. The document
//! itself is served from memory (the editor's current text); other requests
//! resolve against its folder and only return web resources (styles, scripts,
//! images, fonts, media) inside that folder or its parent.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};

struct Site {
    /// Folder of the document, if it is a file.
    dir: Option<PathBuf>,
    /// File name the document is served under.
    name: String,
    html: String,
}

#[derive(Default)]
pub struct Sites(Mutex<Vec<(String, Site)>>);

/// Documents kept around; older ones are dropped.
const KEEP: usize = 16;

const CSP: &str = "default-src 'none'; \
    script-src 'self' 'unsafe-inline' 'unsafe-eval' preview: http://preview.localhost https:; \
    style-src 'self' 'unsafe-inline' preview: http://preview.localhost https:; \
    img-src * data: blob:; media-src * data: blob:; \
    font-src 'self' data: preview: http://preview.localhost https:; \
    connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

const TYPES: &[(&str, &str)] = &[
    ("css", "text/css"),
    ("js", "text/javascript"),
    ("mjs", "text/javascript"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
    ("bmp", "image/bmp"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("mp3", "audio/mpeg"),
    ("ogg", "audio/ogg"),
    ("wav", "audio/wav"),
];

impl Sites {
    /// Publish `html` under `token` (replacing what was there).
    pub fn put(&self, token: String, path: Option<String>, html: String) {
        let (dir, name) = match path.as_deref().map(Path::new) {
            Some(p) => (
                p.parent().map(Path::to_path_buf),
                p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            ),
            None => (None, "index.html".to_string()),
        };
        let mut sites = self.0.lock().unwrap();
        sites.retain(|(t, _)| t != &token);
        sites.push((token, Site { dir, name, html }));
        if sites.len() > KEEP {
            sites.remove(0);
        }
    }

    pub fn serve(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let path = request.uri().path();
        let mut parts = path.trim_start_matches('/').splitn(2, '/');
        let token = parts.next().unwrap_or_default();
        let rest = percent_decode_str(parts.next().unwrap_or_default()).decode_utf8_lossy().into_owned();

        let sites = self.0.lock().unwrap();
        let Some((_, site)) = sites.iter().find(|(t, _)| t == token) else {
            return status(StatusCode::NOT_FOUND);
        };
        if rest == site.name {
            return Response::builder()
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CONTENT_SECURITY_POLICY, CSP)
                .header(header::CACHE_CONTROL, "no-store")
                .body(site.html.clone().into_bytes())
                .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR));
        }
        let Some(dir) = site.dir.clone() else {
            return status(StatusCode::NOT_FOUND);
        };
        drop(sites);
        match resource(&dir, &rest) {
            Some((bytes, mime)) => Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, "no-store")
                .body(bytes)
                .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR)),
            None => status(StatusCode::NOT_FOUND),
        }
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

/// A web resource at `rel` from `dir`, if it is one and stays within reach.
fn resource(dir: &Path, rel: &str) -> Option<(Vec<u8>, &'static str)> {
    let ext = Path::new(rel).extension()?.to_str()?.to_ascii_lowercase();
    let mime = TYPES.iter().find(|(e, _)| *e == ext)?.1;
    if Path::new(rel).components().any(|c| matches!(c, Component::RootDir | Component::Prefix(_))) {
        return None;
    }
    let root = std::fs::canonicalize(dir.parent().unwrap_or(dir)).ok()?;
    let file = std::fs::canonicalize(dir.join(rel)).ok()?;
    if !file.starts_with(&root) || !file.is_file() {
        return None;
    }
    Some((std::fs::read(file).ok()?, mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(sites: &Sites, uri: &str) -> Response<Vec<u8>> {
        sites.serve(&Request::builder().uri(uri).body(Vec::new()).unwrap())
    }

    #[test]
    fn serves_the_document_and_nearby_resources_only() {
        let base = std::env::temp_dir().join(format!("edit2-preview-{}", std::process::id()));
        let docs = base.join("site/docs");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("a.css"), "p{}").unwrap();
        std::fs::write(base.join("site/b.css"), "p{}").unwrap();
        std::fs::write(base.join("secret.css"), "p{}").unwrap();
        std::fs::write(docs.join("notes.txt"), "x").unwrap();

        let sites = Sites::default();
        let page = docs.join("index.html");
        sites.put("t1".into(), Some(page.to_string_lossy().into_owned()), "<p>hi</p>".into());

        let r = get(&sites, "preview://localhost/t1/index.html");
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), b"<p>hi</p>");
        assert!(r.headers().get(header::CONTENT_SECURITY_POLICY).is_some());

        assert_eq!(get(&sites, "preview://localhost/t1/a.css").status(), StatusCode::OK);
        assert_eq!(get(&sites, "preview://localhost/t1/../b.css").status(), StatusCode::OK);
        assert_eq!(get(&sites, "preview://localhost/t1/%2E%2E/%2E%2E/secret.css").status(), StatusCode::NOT_FOUND);
        assert_eq!(get(&sites, "preview://localhost/t1/notes.txt").status(), StatusCode::NOT_FOUND);
        assert_eq!(get(&sites, "preview://localhost/nope/index.html").status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(base).unwrap();
    }
}
