//! Updates from GitHub releases (tauri-plugin-updater, set up under
//! `plugins.updater` in tauri.conf.json). A newer release is downloaded and
//! its signature checked as soon as it is found; it is installed as edit2
//! exits, after every window has had its chance to save. The user can restart
//! right away, or carry on and have it installed whenever they next quit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Launches look for a new version at most this often.
const LAUNCH_INTERVAL: Duration = Duration::from_secs(20 * 60 * 60);
/// The look at launch waits for the first window to settle.
const LAUNCH_DELAY: Duration = Duration::from_secs(8);
/// Setting: when edit2 last asked GitHub (ms since the epoch).
const CHECKED_KEY: &str = "updateCheckedAt";

#[derive(Default)]
pub struct Updates {
    /// Held while checking and downloading, so a manual check waits for the
    /// one at launch instead of fetching the same release twice.
    busy: tauri::async_runtime::Mutex<()>,
    /// Downloaded and verified, installed on exit.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    /// The user asked to restart into the new version.
    restart: AtomicBool,
}

/// A downloaded update, as the frontend shows it.
#[derive(Clone, Serialize)]
pub struct Ready {
    version: String,
    current: String,
}

impl Ready {
    fn of(update: &Update) -> Self {
        Ready {
            version: update.version.clone(),
            current: update.current_version.clone(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Ask GitHub for a newer release and download it. `None`: this is the latest.
async fn fetch(app: &AppHandle) -> Result<Option<Ready>, String> {
    let updates = app.state::<Updates>();
    let _busy = updates.busy.lock().await;
    if let Some((update, _)) = updates.ready.lock().unwrap().as_ref() {
        return Ok(Some(Ready::of(update)));
    }

    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("无法获取版本信息：{e}"))?;
    let _ = app.state::<crate::settings::Settings>().set(CHECKED_KEY.into(), now_ms().into());
    let Some(update) = found else {
        return Ok(None);
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| format!("下载 {} 失败：{e}", update.version))?;
    let ready = Ready::of(&update);
    *updates.ready.lock().unwrap() = Some((update, bytes));
    Ok(Some(ready))
}

/// Look for a new version a little after launch, at most once a day, and
/// offer it in the front window once it has been downloaded.
pub fn check_on_launch(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let checked = app.state::<crate::settings::Settings>().all().get(CHECKED_KEY).and_then(|v| v.as_u64());
    if checked.is_some_and(|t| now_ms().saturating_sub(t) < LAUNCH_INTERVAL.as_millis() as u64) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(LAUNCH_DELAY);
        // Offline or GitHub unreachable: say nothing, try at the next launch.
        if let Ok(Some(ready)) = tauri::async_runtime::block_on(fetch(&app)) {
            if let Some(w) = crate::front_window(&app) {
                let _ = app.emit_to(w.label(), "update-ready", ready);
            }
        }
    });
}

/// Menu item / launch screen link: look now.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<Ready>, String> {
    fetch(&app).await
}

/// Quit, letting each window ask about unsaved changes, and come back as the new version.
#[tauri::command]
pub fn restart_to_update(app: AppHandle) {
    if app.state::<Updates>().ready.lock().unwrap().is_some() {
        app.state::<Updates>().restart.store(true, Ordering::SeqCst);
    }
    crate::close_all(&app);
}

/// A window refused to close: edit2 keeps running, so a later quit does not restart it.
pub fn quit_cancelled(app: &AppHandle) {
    app.state::<Updates>().restart.store(false, Ordering::SeqCst);
}

/// edit2 is exiting: install the downloaded update, and restart into it if asked.
/// On Windows the installer takes over and relaunches edit2 itself; this never returns.
pub fn on_exit(app: &AppHandle) {
    let updates = app.state::<Updates>();
    let Some((update, bytes)) = updates.ready.lock().unwrap().take() else {
        return;
    };
    let restart = updates.restart.load(Ordering::SeqCst);
    let version = update.version.clone();
    if let Err(e) = update.restart_after_install(restart).install(&bytes) {
        eprintln!("edit2: installing {version} failed: {e}");
        return;
    }
    if restart {
        app.restart();
    }
}
