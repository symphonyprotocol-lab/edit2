use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
mod mac_quit;
#[cfg(target_os = "macos")]
mod menu;

/// What the backend knows about each editor window. One window edits one file.
#[derive(Default)]
struct WinInfo {
    /// Frontend has finished booting and can receive `open-path` events.
    ready: bool,
    /// Window holds an untouched, untitled document and may be reused.
    pristine: bool,
    /// Window has changes that are not on disk.
    unsaved: bool,
    /// File currently shown in the window.
    path: Option<String>,
    /// File to load once the frontend is ready.
    pending: Option<String>,
}

#[derive(Default)]
struct AppState {
    wins: Mutex<HashMap<String, WinInfo>>,
    counter: AtomicU32,
    /// Most recently focused window, for menu commands while none has focus.
    last_focused: Mutex<Option<String>>,
}

#[derive(Serialize)]
struct FileData {
    content: String,
    mtime: Option<u64>,
}

fn mtime_of(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn normalize(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

fn create_window(app: &AppHandle, pending: Option<String>) -> tauri::Result<WebviewWindow> {
    let state = app.state::<AppState>();
    let n = state.counter.fetch_add(1, Ordering::SeqCst);
    let label = if n == 0 { "main".to_string() } else { format!("doc-{n}") };

    state.wins.lock().unwrap().insert(
        label.clone(),
        WinInfo {
            ready: false,
            pristine: pending.is_none(),
            unsaved: false,
            path: pending.clone(),
            pending,
        },
    );

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
        .title("mdit")
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

/// Send `path` to a window: focus it if already open, reuse a pristine window,
/// or open a new one.
fn route_path(app: &AppHandle, path: &str, prefer: Option<&str>) {
    let path = normalize(path);
    let state = app.state::<AppState>();
    let target = {
        let mut wins = state.wins.lock().unwrap();

        if let Some(label) = wins
            .iter()
            .find(|(_, w)| w.path.as_deref() == Some(path.as_str()))
            .map(|(l, _)| l.clone())
        {
            drop(wins);
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            return;
        }

        let reusable = |w: &WinInfo| w.pristine && w.pending.is_none();
        let label = prefer
            .filter(|l| wins.get(*l).is_some_and(reusable))
            .map(str::to_string)
            .or_else(|| {
                wins.iter()
                    .find(|(_, w)| reusable(w))
                    .map(|(l, _)| l.clone())
            });

        label.map(|label| {
            let info = wins.get_mut(&label).unwrap();
            info.pristine = false;
            info.path = Some(path.clone());
            if info.ready {
                (label, true)
            } else {
                info.pending = Some(path.clone());
                (label, false)
            }
        })
    };

    match target {
        Some((label, ready)) => {
            if ready {
                let _ = app.emit_to(label.as_str(), "open-path", &path);
            }
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.set_focus();
            }
        }
        None => {
            let _ = create_window(app, Some(path));
        }
    }
}

/// Ask every window to close; each one prompts about its own unsaved changes.
fn close_all(app: &AppHandle) {
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

/// The window menu commands should act on: the focused one, else the last one
/// that had focus (e.g. while the About panel is key).
#[cfg(target_os = "macos")]
fn command_target(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    if let Some(w) = windows.values().find(|w| w.is_focused().unwrap_or(false)) {
        return Some(w.clone());
    }
    let last = app.state::<AppState>().last_focused.lock().unwrap().clone()?;
    windows.get(&last).cloned()
}

/// Replace `path` atomically: write a sibling temp file, then rename it over
/// the original, so a failed or interrupted save never truncates the file.
fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    // Write through symlinks so the link itself is not replaced by a file.
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return std::fs::write(&target, content);
    };
    let tmp = dir.join(format!(".{}.mdit-{}.tmp", name.to_string_lossy(), std::process::id()));

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

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"];

fn file_args(args: impl Iterator<Item = String>, cwd: Option<&Path>) -> Vec<String> {
    args.filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            match cwd {
                Some(cwd) if p.is_relative() => cwd.join(p).to_string_lossy().into_owned(),
                _ => a,
            }
        })
        .filter(|a| Path::new(a).is_file())
        .collect()
}

// ---------- commands ----------

/// Called by a window whenever its frontend boots. Returns the file it should
/// show: one queued for it, or the one it had before the page was reloaded.
#[tauri::command]
fn init_window(window: WebviewWindow, state: tauri::State<'_, AppState>) -> Option<String> {
    let mut wins = state.wins.lock().unwrap();
    let info = wins.entry(window.label().to_string()).or_default();
    info.ready = true;
    info.pending.take().or_else(|| info.path.clone())
}

#[tauri::command]
fn report_state(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    path: Option<String>,
    pristine: bool,
    unsaved: bool,
) {
    let mut wins = state.wins.lock().unwrap();
    if let Some(info) = wins.get_mut(window.label()) {
        info.path = path.map(|p| normalize(&p));
        info.pristine = pristine;
        info.unsaved = unsaved;
    }
}

#[tauri::command]
async fn open_path(app: AppHandle, window: WebviewWindow, path: String) {
    route_path(&app, &path, Some(window.label()));
}

#[tauri::command]
async fn new_window(app: AppHandle) -> Result<(), String> {
    create_window(&app, None).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<FileData, String> {
    let p = Path::new(&path);
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let mut content =
        String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 编码的文本".to_string())?;
    if content.starts_with('\u{feff}') {
        content.remove(0);
    }
    Ok(FileData {
        content,
        mtime: mtime_of(p),
    })
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<Option<u64>, String> {
    let p = Path::new(&path);
    write_atomic(p, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(mtime_of(p))
}

/// Let the preview load the local images a document references, and nothing else.
#[tauri::command]
fn allow_assets(app: AppHandle, paths: Vec<String>) {
    let scope = app.asset_protocol_scope();
    for p in paths {
        let path = Path::new(&p);
        let is_image = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()));
        if !is_image || !path.is_file() {
            continue;
        }
        let _ = scope.allow_file(path);
        if let Ok(real) = std::fs::canonicalize(path) {
            let _ = scope.allow_file(real);
        }
    }
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
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = file_args(argv.into_iter().skip(1), Some(Path::new(&cwd)));
            if files.is_empty() {
                let _ = create_window(app, None);
            }
            for f in files {
                route_path(app, &f, None);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            init_window,
            report_state,
            open_path,
            new_window,
            read_file,
            write_file,
            allow_assets,
            file_mtime,
            quit
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                menu::install(app.handle())?;
                mac_quit::install(app.handle());
            }

            let handle = app.handle().clone();
            let mut files = file_args(std::env::args().skip(1), std::env::current_dir().ok().as_deref());
            match files.len() {
                // On macOS a Finder "Open With" can arrive (as RunEvent::Opened)
                // before setup and has then already created the window.
                0 if !handle.webview_windows().is_empty() => {}
                0 => {
                    create_window(&handle, None)?;
                }
                _ => {
                    create_window(&handle, Some(normalize(&files.remove(0))))?;
                    for f in files {
                        route_path(&handle, &f, None);
                    }
                }
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
                    state.wins.lock().unwrap().remove(window.label());
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running mdit")
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
                // Finder "Open With", dragging onto the Dock icon, `open -a mdit file.md`.
                tauri::RunEvent::Opened { urls } => {
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            route_path(app, &path.to_string_lossy(), None);
                        }
                    }
                }
                // Clicking the Dock icon with no windows left.
                tauri::RunEvent::Reopen {
                    has_visible_windows: false,
                    ..
                } => {
                    let _ = create_window(app, None);
                }
                _ => {}
            }
        });
}
