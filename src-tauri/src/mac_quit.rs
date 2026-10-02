//! tao does not implement `applicationShouldTerminate:`, so a quit from the
//! Dock, AppleScript or logout would kill the process without giving windows
//! a chance to save. We add the method to tao's app delegate class: with
//! nothing unsaved it lets the quit (or logout/shutdown) proceed; otherwise it
//! cancels the termination and closes every window instead (each one asks
//! about its changes), and once the last window is gone the app exits.

use std::sync::OnceLock;

use objc2::ffi::class_addMethod;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

const NS_TERMINATE_CANCEL: usize = 0;
const NS_TERMINATE_NOW: usize = 1;

extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
    let Some(app) = APP.get() else {
        return NS_TERMINATE_NOW;
    };
    if !crate::has_unsaved(app) {
        return NS_TERMINATE_NOW;
    }
    crate::close_all(app);
    NS_TERMINATE_CANCEL
}

pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(class) = AnyClass::get(c"TaoAppDelegateParent") else {
        return;
    };
    unsafe {
        let imp: Imp = std::mem::transmute(
            should_terminate as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
        );
        // "Q@:@": NSUInteger return, self, _cmd, sender.
        class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        );
    }
}
