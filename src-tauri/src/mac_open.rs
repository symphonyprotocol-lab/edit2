//! The dialog plugin (rfd) shows a panel for files or one for folders, never
//! both. NSOpenPanel can allow both at once, so Open… on macOS uses it directly
//! and the picked path is then opened as a file or shown as a folder.

use std::ffi::{c_char, CStr};
use std::sync::mpsc;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use tauri::AppHandle;

const NS_MODAL_RESPONSE_OK: isize = 1;

/// Shows the panel (on the main thread, as AppKit requires) and waits for it.
pub fn pick(app: &AppHandle) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(run_panel());
    })
    .ok()?;
    rx.recv().ok().flatten()
}

fn run_panel() -> Option<String> {
    unsafe {
        let panel: Retained<AnyObject> = msg_send![class!(NSOpenPanel), openPanel];
        let _: () = msg_send![&*panel, setCanChooseFiles: true];
        let _: () = msg_send![&*panel, setCanChooseDirectories: true];
        let _: () = msg_send![&*panel, setAllowsMultipleSelection: false];
        let _: () = msg_send![&*panel, setResolvesAliases: true];
        let response: isize = msg_send![&*panel, runModal];
        if response != NS_MODAL_RESPONSE_OK {
            return None;
        }
        let url: Option<Retained<AnyObject>> = msg_send![&*panel, URL];
        let path: Option<Retained<AnyObject>> = msg_send![&*url?, path];
        let utf8: *const c_char = msg_send![&*path?, UTF8String];
        if utf8.is_null() {
            return None;
        }
        Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }
}
