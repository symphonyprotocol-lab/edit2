//! Native menu bar (macOS). Custom items are forwarded to the frontmost window
//! as a `menu` event carrying the item id; the frontend owns the behaviour.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str, accel: &str| {
        MenuItem::with_id(app, id, text, true, Some(accel))
    };
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(
        app,
        "mdit",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 mdit"), None)?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some("隐藏 mdit"))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &item("quit", "退出 mdit", "CmdOrCtrl+Q")?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &item("new", "新建", "CmdOrCtrl+N")?,
            &item("open", "打开…", "CmdOrCtrl+O")?,
            &sep()?,
            &item("save", "保存", "CmdOrCtrl+S")?,
            &item("save_as", "另存为…", "CmdOrCtrl+Shift+S")?,
            &sep()?,
            &item("reveal", "在访达中显示", "CmdOrCtrl+Shift+R")?,
            &sep()?,
            &item("close", "关闭窗口", "CmdOrCtrl+W")?,
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
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        if id == "quit" {
            crate::close_all(app);
            return;
        }
        match crate::command_target(app) {
            Some(w) => {
                let _ = app.emit_to(w.label(), "menu", id);
            }
            None if id == "new" || id == "open" => {
                let _ = crate::create_window(app, None);
            }
            None => {}
        }
    });
    Ok(())
}
