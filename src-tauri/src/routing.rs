//! Which window a file or folder goes to, and which folders to reopen at the
//! next launch. Pure functions over the backend's view of the windows, so the
//! rules can be tested without a running app.

use std::collections::HashMap;

/// What the backend knows about each editor window. A window has one tab per file.
#[derive(Default, Debug)]
pub struct WinInfo {
    /// Frontend has finished booting and can receive `open-path` events.
    pub ready: bool,
    /// Some tab has changes that are not on disk.
    pub unsaved: bool,
    /// Files open in the window's tabs (reopened if the page reloads).
    pub paths: Vec<String>,
    /// Files to open once the frontend is ready.
    pub pending: Vec<String>,
    /// Folder shown in the sidebar (reopened if the page reloads).
    pub folder: Option<String>,
    /// Folder to show once the frontend is ready.
    pub pending_folder: Option<String>,
}

pub type Wins = HashMap<String, WinInfo>;

/// Windows in the order they were opened: "main", then "doc-1", "doc-2", …
fn window_order(label: &str) -> u32 {
    label.strip_prefix("doc-").and_then(|n| n.parse().ok()).unwrap_or(0)
}

/// A window other than `except` that has `path` open (or about to open) as a tab.
pub fn window_with_file<'a>(wins: &'a Wins, path: &str, except: Option<&str>) -> Option<&'a str> {
    wins.iter()
        .filter(|(l, _)| Some(l.as_str()) != except)
        .find(|(_, w)| w.paths.iter().chain(&w.pending).any(|p| p == path))
        .map(|(l, _)| l.as_str())
}

/// The window showing `folder` in its sidebar (or about to).
pub fn window_with_folder<'a>(wins: &'a Wins, folder: &str) -> Option<&'a str> {
    wins.iter()
        .find(|(_, w)| w.folder.as_deref() == Some(folder) || w.pending_folder.as_deref() == Some(folder))
        .map(|(l, _)| l.as_str())
}

/// A file from Finder, the Dock or the command line: the window that has it,
/// else the front window (folder or not), else any window. None: open one.
pub fn file_target(wins: &Wins, front: Option<&str>, path: &str) -> Option<String> {
    window_with_file(wins, path, None)
        .or(front.filter(|l| wins.contains_key(*l)))
        .or_else(|| wins.keys().min_by_key(|l| window_order(l)).map(String::as_str))
        .map(str::to_string)
}

/// A folder from Finder, the Dock or the command line: the window showing it,
/// else the front window if it has no folder yet. None: open a new window.
/// A window's folder is never replaced from outside.
pub fn folder_target(wins: &Wins, front: Option<&str>, folder: &str) -> Option<String> {
    if let Some(l) = window_with_folder(wins, folder) {
        return Some(l.to_string());
    }
    let candidate = front
        .filter(|l| wins.contains_key(*l))
        .or_else(|| wins.keys().min_by_key(|l| window_order(l)).map(String::as_str))?;
    let w = &wins[candidate];
    (w.folder.is_none() && w.pending_folder.is_none()).then(|| candidate.to_string())
}

/// Open… or Open Folder… from a window that shows a folder: the window that
/// already has the file or folder, else None (open a new window).
pub fn new_window_target(wins: &Wins, path: &str, is_dir: bool) -> Option<String> {
    if is_dir {
        window_with_folder(wins, path)
    } else {
        window_with_file(wins, path, None)
    }
    .map(str::to_string)
}

/// The folders shown in windows, in the order the windows were opened: what
/// the next launch reopens.
pub fn open_folders(wins: &Wins) -> Vec<String> {
    let mut labels: Vec<&String> = wins.keys().collect();
    labels.sort_by_key(|l| (window_order(l), l.as_str()));
    let mut folders: Vec<String> = Vec::new();
    for l in labels {
        let w = &wins[l];
        if let Some(f) = w.folder.as_ref().or(w.pending_folder.as_ref()) {
            if !folders.contains(f) {
                folders.push(f.clone());
            }
        }
    }
    folders
}

/// A window was closed. Forget its folder for the next launch only when the
/// user closed just that window: not while quitting, and not for the last
/// window (closing it quits edit2, and its folder should come back).
pub fn forget_on_close(quitting: bool, windows_left: usize) -> bool {
    !quitting && windows_left > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(folder: Option<&str>, paths: &[&str]) -> WinInfo {
        WinInfo {
            ready: true,
            folder: folder.map(str::to_string),
            paths: paths.iter().map(|p| p.to_string()).collect(),
            ..Default::default()
        }
    }

    fn wins(list: Vec<(&str, WinInfo)>) -> Wins {
        list.into_iter().map(|(l, w)| (l.to_string(), w)).collect()
    }

    #[test]
    fn files_go_to_the_window_that_has_them_else_the_front_one() {
        let w = wins(vec![
            ("main", win(Some("/proj"), &["/proj/a.md"])),
            ("doc-1", win(None, &["/b.md"])),
        ]);
        assert_eq!(file_target(&w, Some("main"), "/b.md").as_deref(), Some("doc-1"));
        // A folder window still takes files from outside when it is in front.
        assert_eq!(file_target(&w, Some("main"), "/c.md").as_deref(), Some("main"));
        assert_eq!(file_target(&w, None, "/c.md").as_deref(), Some("main"));
        assert_eq!(file_target(&Wins::new(), None, "/c.md"), None);
    }

    #[test]
    fn a_pending_file_counts_as_open() {
        let mut w = wins(vec![("main", win(None, &[])), ("doc-1", win(None, &[]))]);
        w.get_mut("doc-1").unwrap().pending.push("/x.md".into());
        assert_eq!(file_target(&w, Some("main"), "/x.md").as_deref(), Some("doc-1"));
        assert_eq!(window_with_file(&w, "/x.md", Some("doc-1")), None);
    }

    #[test]
    fn folders_never_replace_another_folder() {
        let w = wins(vec![("main", win(Some("/a"), &[])), ("doc-1", win(None, &[]))]);
        // Already shown: that window.
        assert_eq!(folder_target(&w, Some("doc-1"), "/a").as_deref(), Some("main"));
        // Front window has no folder: it takes this one.
        assert_eq!(folder_target(&w, Some("doc-1"), "/b").as_deref(), Some("doc-1"));
        // Front window shows another folder: a new window.
        assert_eq!(folder_target(&w, Some("main"), "/b"), None);
        // A folder on its way to a window is taken too.
        let mut w = wins(vec![("main", win(None, &[]))]);
        w.get_mut("main").unwrap().pending_folder = Some("/a".into());
        assert_eq!(folder_target(&w, Some("main"), "/b"), None);
        assert_eq!(folder_target(&w, Some("main"), "/a").as_deref(), Some("main"));
    }

    #[test]
    fn open_from_a_folder_window_reuses_a_window_only_if_it_has_the_item() {
        let w = wins(vec![
            ("main", win(Some("/a"), &["/a/x.md"])),
            ("doc-2", win(Some("/b"), &[])),
        ]);
        assert_eq!(new_window_target(&w, "/a/x.md", false).as_deref(), Some("main"));
        assert_eq!(new_window_target(&w, "/a/y.md", false), None);
        assert_eq!(new_window_target(&w, "/b", true).as_deref(), Some("doc-2"));
        assert_eq!(new_window_target(&w, "/c", true), None);
    }

    #[test]
    fn open_folders_follow_window_order_without_duplicates() {
        let mut w = wins(vec![
            ("doc-10", win(Some("/c"), &[])),
            ("doc-2", win(Some("/b"), &[])),
            ("main", win(Some("/a"), &[])),
            ("doc-3", win(None, &[])),
            ("doc-4", win(Some("/a"), &[])),
        ]);
        w.get_mut("doc-3").unwrap().pending_folder = Some("/d".into());
        assert_eq!(open_folders(&w), ["/a", "/b", "/d", "/c"]);
        assert!(open_folders(&Wins::new()).is_empty());
    }

    #[test]
    fn closing_the_last_window_or_quitting_keeps_folders() {
        assert!(forget_on_close(false, 1));
        assert!(!forget_on_close(false, 0));
        assert!(!forget_on_close(true, 2));
    }
}
