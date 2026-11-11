use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

mod binary;
mod codec;
mod fstree;
#[cfg(target_os = "macos")]
mod mac_open;
#[cfg(target_os = "macos")]
mod mac_quit;
#[cfg(target_os = "macos")]
mod menu;
mod migrate;
mod preview;
mod routing;
mod settings;

use routing::{WinInfo, Wins};

#[derive(Default)]
struct AppState {
    wins: Mutex<Wins>,
    counter: AtomicU32,
    /// Most recently focused window, for menu commands while none has focus.
    last_focused: Mutex<Option<String>>,
    /// Staged drafts have been handed to a window for restoring.
    drafts_restored: AtomicBool,
    /// The folders open at last quit have been handed to windows.
    folder_restored: AtomicBool,
    /// Windows are closing because edit2 is quitting (keep their folders for
    /// the next launch). Cleared if a window cancels the quit.
    quitting: AtomicBool,
    /// One-time message for the first window (data migrated from mdit).
    notice: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitData {
    /// Files to open as tabs, in order.
    files: Vec<String>,
    /// Staging area for untitled documents.
    drafts_dir: String,
    /// Something to tell the user once, e.g. that mdit's data was migrated.
    notice: Option<String>,
    /// Folder to show in the sidebar.
    folder: Option<String>,
}

#[derive(Serialize)]
struct Written {
    /// Canonical path of the file that was written.
    path: String,
    mtime: Option<u64>,
}

/// Untitled documents are auto-saved here until the user saves them for real.
fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("drafts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::canonicalize(&dir).map_err(|e| e.to_string())
}

/// Staged drafts, oldest first.
fn staged_drafts(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut drafts: Vec<(u64, String)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "md") && p.is_file())
        .map(|p| (mtime_of(&p).unwrap_or(0), p.to_string_lossy().into_owned()))
        .collect();
    drafts.sort();
    drafts.into_iter().map(|(_, p)| p).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileData {
    /// Canonical path, so the frontend can tell two spellings of one file apart.
    path: String,
    content: String,
    mtime: Option<u64>,
    /// Encoding the file was decoded with, to write it back the same way.
    encoding: String,
    /// The file starts with a byte order mark.
    bom: bool,
    /// The encoding was detected from little evidence.
    guessed: bool,
    size: u64,
}

/// Files above this size only open after the user confirms (read-only).
const CONFIRM_SIZE: u64 = 50 * 1024 * 1024;

fn mtime_of(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn normalize(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

fn create_window(app: &AppHandle, pending: Vec<String>) -> tauri::Result<WebviewWindow> {
    create_window_with(app, pending, None)
}

fn create_window_with(
    app: &AppHandle,
    pending: Vec<String>,
    folder: Option<String>,
) -> tauri::Result<WebviewWindow> {
    let state = app.state::<AppState>();
    let n = state.counter.fetch_add(1, Ordering::SeqCst);
    let label = if n == 0 { "main".to_string() } else { format!("doc-{n}") };

    let has_folder = folder.is_some();
    state.wins.lock().unwrap().insert(
        label.clone(),
        WinInfo {
            pending,
            pending_folder: folder.clone(),
            folder,
            ..Default::default()
        },
    );
    if has_folder {
        save_open_folders(app);
    }

    // Cascade new windows from the one currently in front.
    let anchor = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .and_then(|w| {
            let scale = w.scale_factor().ok()?;
            Some(w.outer_position().ok()?.to_logical::<f64>(scale))
        });

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("edit2")
        .inner_size(920.0, 680.0)
        .min_inner_size(420.0, 320.0)
        .visible(false);

    builder = match anchor {
        Some(p) => builder.position(p.x + 28.0, p.y + 28.0),
        None => builder.center(),
    };

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 24.0));
    }

    builder.build()
}

/// Open `path` as a tab: in the window that already has it, else the front
/// window (whose frontend reuses an empty tab or adds one), else a new window.
fn route_path(app: &AppHandle, path: &str) {
    let path = normalize(path);
    if Path::new(&path).is_dir() {
        return route_folder(app, path);
    }
    let front = front_window(app).map(|w| w.label().to_string());
    let target = {
        let state = app.state::<AppState>();
        let mut wins = state.wins.lock().unwrap();
        let label = routing::file_target(&wins, front.as_deref(), &path);
        label.map(|label| {
            let info = wins.get_mut(&label).unwrap();
            if !info.ready {
                info.pending.push(path.clone());
            }
            (label, info.ready)
        })
    };

    match target {
        Some((label, ready)) => {
            if ready {
                let _ = app.emit_to(label.as_str(), "open-path", &path);
            }
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        None => {
            let _ = create_window(app, vec![path]);
        }
    }
}

/// Show `path` in a sidebar: focus the window that already shows it, else use
/// the front window if it has no folder yet, else open a new window.
fn route_folder(app: &AppHandle, path: String) {
    let front = front_window(app).map(|w| w.label().to_string());
    let target = {
        let state = app.state::<AppState>();
        let mut wins = state.wins.lock().unwrap();
        let label = routing::folder_target(&wins, front.as_deref(), &path);
        label.map(|label| {
            let info = wins.get_mut(&label).unwrap();
            let fresh = info.folder.as_deref() != Some(path.as_str());
            // Claim it now, so a second folder routed meanwhile goes elsewhere.
            info.folder = Some(path.clone());
            if !info.ready {
                info.pending_folder = Some(path.clone());
            }
            (label, info.ready && fresh)
        })
    };

    match target {
        Some((label, emit)) => {
            if emit {
                let _ = app.emit_to(label.as_str(), "open-folder", &path);
            }
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            save_open_folders(app);
        }
        None => {
            let _ = create_window_with(app, Vec::new(), Some(path));
        }
    }
}

/// Bring `label` forward, and have it show `path` (a tab, or its folder).
fn reveal_in(app: &AppHandle, label: &str, path: &str, is_dir: bool) {
    if !is_dir {
        let _ = app.emit_to(label, "open-path", path);
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Remember the windows' folders in settings.json, for the next launch.
fn save_open_folders(app: &AppHandle) {
    let folders = routing::open_folders(&app.state::<AppState>().wins.lock().unwrap());
    let settings = app.state::<settings::Settings>();
    let value = serde_json::json!(folders);
    if settings.all().get("folders") != Some(&value) {
        let _ = settings.set("folders".into(), value);
    }
}

/// Folders to reopen at launch: `folders`, or the single `folder` an earlier
/// build of this feature kept. Ones that no longer exist are skipped.
fn saved_folders(settings: &settings::Settings) -> Vec<String> {
    let all = settings.all();
    let list: Vec<String> = match all.get("folders") {
        Some(serde_json::Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => all.get("folder").and_then(|v| v.as_str()).map(|f| vec![f.to_string()]).unwrap_or_default(),
    };
    list.into_iter().filter(|p| Path::new(p).is_dir()).collect()
}

/// Bring a window forward, or open one if there is none.
fn show_some_window(app: &AppHandle) {
    match front_window(app).or_else(|| app.webview_windows().into_values().next()) {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        None => {
            let _ = create_window(app, Vec::new());
        }
    }
}

/// Ask every window to close; each one prompts about its own unsaved changes.
fn close_all(app: &AppHandle) {
    app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
    for w in app.webview_windows().values() {
        let _ = w.close();
    }
}

#[cfg(target_os = "macos")]
fn has_unsaved(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let wins = state.wins.lock().unwrap();
    wins.values().any(|w| w.unsaved)
}

/// The window commands and opened files go to: the focused one, else the last
/// one that had focus (e.g. while the About panel is key).
fn front_window(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    if let Some(w) = windows.values().find(|w| w.is_focused().unwrap_or(false)) {
        return Some(w.clone());
    }
    let last = app.state::<AppState>().last_focused.lock().unwrap().clone();
    // That one may be gone (closed while edit2 was in the background): any window then.
    last.and_then(|l| windows.get(&l).cloned()).or_else(|| windows.into_values().next())
}

/// Replace `path` atomically: write a sibling temp file, then rename it over
/// the original, so a failed or interrupted save never truncates the file.
pub(crate) fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    // Write through symlinks so the link itself is not replaced by a file.
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return std::fs::write(&target, content);
    };
    let tmp = dir.join(format!(".{}.edit2-{}.tmp", name.to_string_lossy(), std::process::id()));

    let mut file = match std::fs::File::create(&tmp) {
        Ok(f) => f,
        // Directory not writable (but the file may be): fall back to in place.
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return std::fs::write(&target, content);
        }
        Err(e) => return Err(e),
    };
    let result = (|| {
        file.write_all(content)?;
        file.sync_all()?;
        if let Ok(meta) = std::fs::metadata(&target) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Files a preview may load: images, and the styles and fonts of HTML pages.
const ASSET_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "css", "woff", "woff2", "ttf", "otf",
];

fn file_args(args: impl Iterator<Item = String>, cwd: Option<&Path>) -> Vec<String> {
    args.filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            match cwd {
                Some(cwd) if p.is_relative() => cwd.join(p).to_string_lossy().into_owned(),
                _ => a,
            }
        })
        .filter(|a| Path::new(a).is_file() || Path::new(a).is_dir())
        .collect()
}

// ---------- commands ----------

/// Called by a window whenever its frontend boots. Returns the files it should
/// open: staged drafts (first window of the process only), then those queued
/// for it, or the tabs it had before the page was reloaded.
#[tauri::command]
fn init_window(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    settings: tauri::State<'_, settings::Settings>,
) -> Result<InitData, String> {
    let dir = drafts_dir(&app)?;
    let mut files = if state.drafts_restored.swap(true, Ordering::SeqCst) {
        Vec::new()
    } else {
        staged_drafts(&dir)
    };

    let mut wins = state.wins.lock().unwrap();
    let info = wins.entry(window.label().to_string()).or_default();
    info.ready = true;
    let pending = std::mem::take(&mut info.pending);
    let explicit = !pending.is_empty() || info.pending_folder.is_some();
    files.extend(if pending.is_empty() { info.paths.clone() } else { pending });
    files.dedup();

    // A folder sent to this window, else the one it had before a reload, else
    // (first window of a plain launch) the folders open when edit2 last quit:
    // the first here, each other one in a window of its own.
    let mut folder = info.pending_folder.take().or_else(|| info.folder.clone());
    let first = !state.folder_restored.swap(true, Ordering::SeqCst);
    let mut others = Vec::new();
    if folder.is_none() && first && !explicit {
        let mut saved = saved_folders(&settings).into_iter();
        folder = saved.next();
        others = saved.collect();
    }
    info.folder = folder.clone();
    drop(wins);
    for f in others {
        let app = app.clone();
        // Not from inside this command: window creation must not block it.
        tauri::async_runtime::spawn(async move {
            let _ = create_window_with(&app, Vec::new(), Some(f));
        });
    }
    Ok(InitData {
        files,
        drafts_dir: dir.to_string_lossy().into_owned(),
        notice: state.notice.lock().unwrap().take(),
        folder,
    })
}

/// Remove a staged draft once it has been saved for real or discarded.
/// Refuses anything outside the staging area.
#[tauri::command]
fn delete_draft(app: AppHandle, path: String) -> Result<(), String> {
    let dir = drafts_dir(&app)?;
    let p = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if p.parent() != Some(dir.as_path()) {
        return Err("只能删除暂存区中的草稿".into());
    }
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn report_state(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    unsaved: bool,
    folder: Option<String>,
) {
    let folder_changed = {
        let mut wins = state.wins.lock().unwrap();
        let Some(info) = wins.get_mut(window.label()) else {
            return;
        };
        info.paths = paths.iter().map(|p| normalize(p)).collect();
        info.unsaved = unsaved;
        let folder = folder.map(|f| normalize(&f));
        let changed = info.folder != folder;
        info.folder = folder;
        changed
    };
    if folder_changed {
        save_open_folders(&app);
    }
}

/// Open… or Open Folder… in a window that shows a folder: open the file or
/// folder in a new window, unless a window already has it (then bring that
/// one forward). Async so the new window is not built inside the call.
#[tauri::command]
async fn open_in_new_window(app: AppHandle, path: String) -> Result<(), String> {
    let path = normalize(&path);
    let is_dir = Path::new(&path).is_dir();
    let existing = routing::new_window_target(&app.state::<AppState>().wins.lock().unwrap(), &path, is_dir);
    match existing {
        Some(label) => reveal_in(&app, &label, &path, is_dir),
        None if is_dir => {
            create_window_with(&app, Vec::new(), Some(path)).map_err(|e| e.to_string())?;
        }
        None => {
            create_window_with(&app, vec![path], None).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Before a window opens `path` itself: if another window has it as a tab,
/// switch to that tab there and return true, so one file is not edited in two
/// windows at once.
#[tauri::command]
fn focus_if_open(app: AppHandle, window: WebviewWindow, state: tauri::State<'_, AppState>, path: String) -> bool {
    let path = normalize(&path);
    let other = routing::window_with_file(&state.wins.lock().unwrap(), &path, Some(window.label())).map(str::to_string);
    match other {
        Some(label) => {
            reveal_in(&app, &label, &path, false);
            true
        }
        None => false,
    }
}

/// A window refused to close during a quit (the user chose Cancel): edit2
/// keeps running, so closing windows from now on forgets their folders again.
#[tauri::command]
fn close_cancelled(app: AppHandle, state: tauri::State<'_, AppState>) {
    if state.quitting.swap(false, Ordering::SeqCst) {
        // Windows already closed during the attempt are gone for good.
        save_open_folders(&app);
    }
}

#[derive(Serialize)]
struct PathInfo {
    /// Canonical path.
    path: String,
    dir: bool,
}

/// Open… on macOS: one panel that picks a file or a folder. Elsewhere the
/// native dialogs pick one kind only, and the frontend uses the dialog plugin.
#[tauri::command]
async fn pick_file_or_folder(app: AppHandle) -> Option<String> {
    #[cfg(target_os = "macos")]
    return mac_open::pick(&app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

/// Whether `path` exists and is a folder; None if it does not exist.
#[tauri::command]
fn stat_path(path: String) -> Option<PathInfo> {
    let meta = std::fs::metadata(&path).ok()?;
    Some(PathInfo {
        path: normalize(&path),
        dir: meta.is_dir(),
    })
}

/// One level of a folder for the sidebar tree, folders first.
#[tauri::command]
fn list_dir(path: String, show_hidden: Option<bool>) -> Result<Vec<fstree::Entry>, String> {
    fstree::list(Path::new(&path), show_hidden.unwrap_or(false)).map_err(|e| e.to_string())
}

/// Read a text file, detecting its encoding unless one is given. A file over
/// `CONFIRM_SIZE` fails with `TOO_LARGE:<bytes>` unless `force` is set.
#[tauri::command]
fn read_file(path: String, encoding: Option<String>, force: Option<bool>) -> Result<FileData, String> {
    let p = Path::new(&path);
    let size = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    if size > CONFIRM_SIZE && !force.unwrap_or(false) {
        return Err(format!("TOO_LARGE:{size}"));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let decoded = match encoding {
        Some(label) => codec::decode_as(&bytes, &label).ok_or_else(|| format!("未知的编码：{label}"))?,
        None => codec::decode(&bytes).map_err(|codec::DecodeError::Binary| "这不是文本文件".to_string())?,
    };
    Ok(FileData {
        path: normalize(&path),
        content: decoded.text,
        mtime: mtime_of(p),
        encoding: decoded.encoding.to_string(),
        bom: decoded.bom,
        guessed: decoded.guessed,
        size,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BinaryFile {
    /// Canonical path.
    path: String,
    size: u64,
    mtime: Option<u64>,
}

/// A PDF about to be shown: check that it is one, and say how big it is.
/// Its bytes are then read in ranges with `read_bytes`; nothing writes to it.
#[tauri::command]
fn open_binary(path: String) -> Result<BinaryFile, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("这是一个文件夹".into());
    }
    binary::check(p)?;
    Ok(BinaryFile {
        path: normalize(&path),
        size: meta.len(),
        mtime: mtime_of(p),
    })
}

/// Bytes `offset..offset + length` of a PDF, as a raw (not JSON) response.
#[tauri::command]
fn read_bytes(path: String, offset: u64, length: u64) -> Result<tauri::ipc::Response, String> {
    binary::read_range(Path::new(&path), offset, length).map(tauri::ipc::Response::new)
}

/// Write `content` in `encoding` (UTF-8 by default). Fails with `UNMAPPABLE`,
/// writing nothing, if the encoding cannot represent every character.
#[tauri::command]
fn write_file(
    path: String,
    content: String,
    encoding: Option<String>,
    bom: Option<bool>,
) -> Result<Written, String> {
    let p = Path::new(&path);
    let label = encoding.as_deref().unwrap_or("UTF-8");
    let bytes = codec::encode(&content, label, bom.unwrap_or(false)).map_err(|e| match e {
        codec::EncodeError::Unmappable => "UNMAPPABLE".to_string(),
        codec::EncodeError::UnknownEncoding => format!("未知的编码：{label}"),
    })?;
    write_atomic(p, &bytes).map_err(|e| e.to_string())?;
    Ok(Written {
        path: normalize(&path),
        mtime: mtime_of(p),
    })
}

/// Let the preview load the local images (and HTML styles and fonts) a
/// document references, and nothing else.
#[tauri::command]
fn allow_assets(app: AppHandle, paths: Vec<String>) {
    let scope = app.asset_protocol_scope();
    for p in paths {
        let path = Path::new(&p);
        let allowed = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| ASSET_EXTS.contains(&e.to_ascii_lowercase().as_str()));
        if !allowed || !path.is_file() {
            continue;
        }
        let _ = scope.allow_file(path);
        if let Ok(real) = std::fs::canonicalize(path) {
            let _ = scope.allow_file(real);
        }
    }
}

/// The front tab's format can (or cannot) be formatted / minified.
#[tauri::command]
fn set_format_menu(app: AppHandle, format: bool, minify: bool) {
    #[cfg(target_os = "macos")]
    menu::set_enabled(&app, &[("format_doc", format), ("minify_doc", minify)]);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, format, minify);
}

/// The front window has (or has no) folder open.
#[tauri::command]
fn set_folder_menu(app: AppHandle, open: bool) {
    #[cfg(target_os = "macos")]
    menu::set_enabled(&app, &[("close_folder", open), ("toggle_sidebar", open)]);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, open);
}

#[tauri::command]
fn load_settings(settings: tauri::State<'_, settings::Settings>) -> serde_json::Map<String, serde_json::Value> {
    settings.all()
}

/// Change one preference and tell every window (they keep a copy).
#[tauri::command]
fn set_setting(
    app: AppHandle,
    settings: tauri::State<'_, settings::Settings>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    settings.set(key.clone(), value.clone())?;
    let _ = app.emit("setting-changed", serde_json::json!({ "key": key, "value": value }));
    Ok(())
}

/// Publish an HTML document for the script-enabled preview (see preview.rs).
#[tauri::command]
fn serve_preview(sites: tauri::State<'_, preview::Sites>, token: String, path: Option<String>, html: String) {
    sites.put(token, path, html);
}

#[tauri::command]
fn file_mtime(path: String) -> Option<u64> {
    mtime_of(Path::new(&path))
}

#[tauri::command]
fn quit(app: AppHandle) {
    close_all(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any webview exists (and creates its storage).
    let migration = migrate::run();
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = file_args(argv.into_iter().skip(1), Some(Path::new(&cwd)));
            if files.is_empty() {
                show_some_window(app);
            }
            for f in files {
                route_path(app, &f);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            notice: Mutex::new(migration.map(|r| r.message())),
            ..Default::default()
        })
        .manage(settings::Settings::default())
        .manage(preview::Sites::default())
        .register_uri_scheme_protocol("preview", |ctx, request| {
            ctx.app_handle().state::<preview::Sites>().serve(&request)
        })
        .invoke_handler(tauri::generate_handler![
            init_window,
            report_state,
            read_file,
            open_binary,
            read_bytes,
            write_file,
            delete_draft,
            allow_assets,
            set_format_menu,
            set_folder_menu,
            serve_preview,
            load_settings,
            set_setting,
            file_mtime,
            stat_path,
            list_dir,
            pick_file_or_folder,
            open_in_new_window,
            focus_if_open,
            close_cancelled,
            quit
        ])
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                app.state::<settings::Settings>().load(dir.join("settings.json"));
            }

            #[cfg(target_os = "macos")]
            {
                menu::install(app.handle())?;
                mac_quit::install(app.handle());
            }

            let handle = app.handle().clone();
            let files = file_args(std::env::args().skip(1), std::env::current_dir().ok().as_deref());
            if !files.is_empty() {
                for f in files {
                    route_path(&handle, &f);
                }
            } else if handle.webview_windows().is_empty() {
                // On macOS a Finder "Open With" can arrive (as RunEvent::Opened)
                // before setup and has then already created the window.
                create_window(&handle, Vec::new())?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let state = window.state::<AppState>();
            match event {
                tauri::WindowEvent::Focused(true) => {
                    *state.last_focused.lock().unwrap() = Some(window.label().to_string());
                }
                tauri::WindowEvent::Destroyed => {
                    let mut last = state.last_focused.lock().unwrap();
                    if last.as_deref() == Some(window.label()) {
                        *last = None;
                    }
                    drop(last);
                    let left = {
                        let mut wins = state.wins.lock().unwrap();
                        wins.remove(window.label());
                        wins.len()
                    };
                    if routing::forget_on_close(state.quitting.load(Ordering::SeqCst), left) {
                        save_open_folders(window.app_handle());
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running edit2")
        .run(|app, event| {
            // Quit requested from outside our menu (Dock, AppleScript, logout):
            // close windows one by one so each can ask about unsaved changes.
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = &event {
                if !app.webview_windows().is_empty() {
                    api.prevent_exit();
                    close_all(app);
                }
                return;
            }

            #[cfg(target_os = "macos")]
            match event {
                // Finder "Open With", dragging onto the Dock icon, `open -a edit2 file.md`.
                tauri::RunEvent::Opened { urls } => {
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            route_path(app, &path.to_string_lossy());
                        }
                    }
                }
                // Clicking the Dock icon with no windows left.
                tauri::RunEvent::Reopen {
                    has_visible_windows: false,
                    ..
                } => {
                    let _ = create_window(app, Vec::new());
                }
                _ => {}
            }
        });
}
