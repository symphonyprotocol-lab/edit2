//! The `preview:` protocol serves HTML documents whose scripts the user chose
//! to run. The page lives in a sandboxed iframe without `allow-same-origin`,
//! so it cannot reach the editor's window or the IPC key; this protocol gives
//! it its own origin and CSP (an iframe from `srcdoc` would inherit the
//! editor's CSP, which blocks inline scripts).
//!
//! The document's URL is `preview://localhost/<token>/<folder>/<file>`, its
//! folder's name included so that the page can reach one level up: a browser
//! resolves `../shared.css` itself, to `<token>/shared.css`, before asking.
//! The document is served from memory (the editor's current text); every other
//! request resolves against the parent of its folder and only returns web
//! resources (styles, scripts, images, fonts, media) inside it.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::http::{header, Request, Response, StatusCode};

struct Site {
    /// Folder that requests resolve against, if the document is a file: the
    /// parent of its folder (or the folder itself at the top of a drive).
    root: Option<PathBuf>,
    /// Path the document is served under, from the root: `folder/file`.
    doc: String,
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
    /// Publish `html` under `token` (replacing what was there). Returns the
    /// document's URL path, `<token>/<folder>/<file>`, percent-encoded.
    pub fn put(&self, token: String, path: Option<String>, html: String) -> String {
        let name_of = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned());
        let file = path.as_deref().map(Path::new);
        let dir = file.and_then(Path::parent);
        let (root, parts) = match (file.and_then(name_of), dir) {
            (Some(name), Some(dir)) => match (dir.parent(), name_of(dir)) {
                (Some(parent), Some(folder)) => (Some(parent.to_path_buf()), vec![folder, name]),
                _ => (Some(dir.to_path_buf()), vec![name]),
            },
            _ => (None, vec!["index.html".to_string()]),
        };
        let url = std::iter::once(&token)
            .chain(&parts)
            .map(|part| utf8_percent_encode(part, NON_ALPHANUMERIC).to_string())
            .collect::<Vec<_>>()
            .join("/");
        let mut sites = self.0.lock().unwrap();
        sites.retain(|(t, _)| t != &token);
        sites.push((token, Site { root, doc: parts.join("/"), html }));
        if sites.len() > KEEP {
            sites.remove(0);
        }
        url
    }

    pub fn serve(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let path = request.uri().path();
        let mut parts = path.trim_start_matches('/').splitn(2, '/');
        // Decoded like the rest: `put` percent-encodes every part of the URL it hands out.
        let token = percent_decode_str(parts.next().unwrap_or_default()).decode_utf8_lossy();
        let rest = percent_decode_str(parts.next().unwrap_or_default()).decode_utf8_lossy().into_owned();

        let sites = self.0.lock().unwrap();
        let Some((_, site)) = sites.iter().find(|(t, _)| *t == token) else {
            return status(StatusCode::NOT_FOUND);
        };
        if rest == site.doc {
            return Response::builder()
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CONTENT_SECURITY_POLICY, CSP)
                .header(header::CACHE_CONTROL, "no-store")
                .body(site.html.clone().into_bytes())
                .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR));
        }
        let Some(root) = site.root.clone() else {
            return status(StatusCode::NOT_FOUND);
        };
        drop(sites);
        match resource(&root, &rest) {
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

/// A web resource at `rel` from `root`, if it is one and stays inside it.
fn resource(root: &Path, rel: &str) -> Option<(Vec<u8>, &'static str)> {
    let ext = Path::new(rel).extension()?.to_str()?.to_ascii_lowercase();
    let mime = TYPES.iter().find(|(e, _)| *e == ext)?.1;
    if Path::new(rel).components().any(|c| matches!(c, Component::RootDir | Component::Prefix(_))) {
        return None;
    }
    let file = std::fs::canonicalize(root.join(rel)).ok()?;
    let root = std::fs::canonicalize(root).ok()?;
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
        let url = sites.put("t1".into(), Some(page.to_string_lossy().into_owned()), "<p>hi</p>".into());
        assert_eq!(url, "t1/docs/index%2Ehtml");

        let r = get(&sites, &format!("preview://localhost/{url}"));
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), b"<p>hi</p>");
        assert!(r.headers().get(header::CONTENT_SECURITY_POLICY).is_some());

        // As a browser asks for `a.css` and `../b.css` from the page: it resolves the dots itself.
        assert_eq!(get(&sites, "preview://localhost/t1/docs/a.css").status(), StatusCode::OK);
        assert_eq!(get(&sites, "preview://localhost/t1/b.css").status(), StatusCode::OK);
        // Not above the folder's parent, however the request is spelled.
        assert_eq!(get(&sites, "preview://localhost/t1/docs/%2E%2E/%2E%2E/secret.css").status(), StatusCode::NOT_FOUND);
        assert_eq!(get(&sites, "preview://localhost/t1/../secret.css").status(), StatusCode::NOT_FOUND);
        assert_eq!(get(&sites, "preview://localhost/secret.css").status(), StatusCode::NOT_FOUND);
        assert_eq!(get(&sites, "preview://localhost/t1/docs/notes.txt").status(), StatusCode::NOT_FOUND);
        assert_eq!(get(&sites, "preview://localhost/nope/docs/index.html").status(), StatusCode::NOT_FOUND);

        // An untitled document has no folder to load from. Tokens are UUIDs:
        // the URL handed out must lead back to the page, encoded or not.
        let url = sites.put("t-2".into(), None, "x".into());
        assert_eq!(url, "t%2D2/index%2Ehtml");
        assert_eq!(get(&sites, &format!("preview://localhost/{url}")).status(), StatusCode::OK);
        assert_eq!(get(&sites, "preview://localhost/t-2/index.html").status(), StatusCode::OK);
        assert_eq!(get(&sites, "preview://localhost/t-2/a.css").status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(base).unwrap();
    }
}
