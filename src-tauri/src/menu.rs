//! Native menu bar (macOS). Custom items are forwarded to the frontmost window
//! as a `menu` event carrying the item id; the frontend owns the behaviour.

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str, accel: &str| {
        MenuItem::with_id(app, id, text, true, Some(accel))
    };
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(
        app,
        "edit2",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 edit2"), None)?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some("隐藏 edit2"))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &item("quit", "退出 edit2", "CmdOrCtrl+Q")?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &item("new", "新建", "CmdOrCtrl+N")?,
            &item("new_tab", "新建标签页", "CmdOrCtrl+T")?,
            &item("open", "打开…", "CmdOrCtrl+O")?,
            &sep()?,
            &item("save", "保存", "CmdOrCtrl+S")?,
            &item("save_as", "另存为…", "CmdOrCtrl+Shift+S")?,
            &sep()?,
            &item("reveal", "在访达中显示", "CmdOrCtrl+Shift+R")?,
            &sep()?,
            &item("close", "关闭标签页", "CmdOrCtrl+W")?,
            &item("close_window", "关闭窗口", "CmdOrCtrl+Shift+W")?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &item("undo", "撤销", "CmdOrCtrl+Z")?,
            &item("redo", "重做", "CmdOrCtrl+Shift+Z")?,
            &sep()?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("拷贝"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
            &sep()?,
            &item("find", "查找…", "CmdOrCtrl+F")?,
            &sep()?,
            &item("format_doc", "格式化文档", "Shift+Alt+F")?,
            &MenuItem::with_id(app, "minify_doc", "压缩", true, None::<&str>)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "显示",
        true,
        &[
            &item("mode_write", "写作", "CmdOrCtrl+1")?,
            &item("mode_split", "分栏", "CmdOrCtrl+2")?,
            &item("mode_read", "阅读", "CmdOrCtrl+3")?,
            &item("toggle_preview", "切换预览", "CmdOrCtrl+\\")?,
            &item("toggle_wrap", "自动换行", "Alt+Z")?,
            &sep()?,
            &item("zoom_in", "放大字号", "CmdOrCtrl+=")?,
            &item("zoom_out", "缩小字号", "CmdOrCtrl+-")?,
            &item("zoom_reset", "默认字号", "CmdOrCtrl+0")?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
            &sep()?,
            &item("prev_tab", "显示上一个标签页", "CmdOrCtrl+Shift+[")?,
            &item("next_tab", "显示下一个标签页", "CmdOrCtrl+Shift+]")?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )?;
    app.set_menu(menu)?;

    set_enabled(app, &[("format_doc", false), ("minify_doc", false)]);

    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        if id == "quit" {
            crate::close_all(app);
            return;
        }
        match crate::front_window(app) {
            Some(w) => {
                let _ = app.emit_to(w.label(), "menu", id);
            }
            None if matches!(id, "new" | "new_tab" | "open") => {
                let _ = crate::create_window(app, Vec::new());
            }
            None => {}
        }
    });
    Ok(())
}

/// Enable or disable custom items (the menu bar follows the front window's tab).
pub fn set_enabled(app: &AppHandle, items: &[(&str, bool)]) {
    let Some(menu) = app.menu() else {
        return;
    };
    for kind in menu.items().unwrap_or_default() {
        let Some(sub) = kind.as_submenu() else {
            continue;
        };
        for (id, on) in items {
            if let Some(MenuItemKind::MenuItem(item)) = sub.get(*id) {
                let _ = item.set_enabled(*on);
            }
        }
    }
}
