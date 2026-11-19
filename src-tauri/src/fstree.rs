//! Directory listing for the folder sidebar. One level at a time: the tree
//! asks for a folder's children when it is expanded.

use std::cmp::Ordering;
use std::path::{Component, Path};

use serde::Serialize;

/// Folders that are rarely edited by hand and can hold huge numbers of files.
/// Hidden with dotfiles unless the user asks to see everything.
const HEAVY_DIRS: &[&str] = &["node_modules", "__pycache__"];

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    /// Full path (the folder's path joined with the name).
    pub path: String,
    /// A directory, or a symlink to one.
    pub dir: bool,
}

/// Dotfiles, and the heavy folders above.
pub fn is_hidden(name: &str, dir: bool) -> bool {
    name.starts_with('.') || (dir && HEAVY_DIRS.contains(&name))
}

/// Directories first, then by name ignoring case; ties by the exact name so
/// the order is stable.
fn order(a: &Entry, b: &Entry) -> Ordering {
    b.dir
        .cmp(&a.dir)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.name.cmp(&b.name))
}

/// The children of `dir`, sorted. Entries that cannot be read (a broken
/// symlink, a permissions problem on one child) are skipped, not fatal.
pub fn list(dir: &Path, show_hidden: bool) -> std::io::Result<Vec<Entry>> {
    let mut entries: Vec<Entry> = std::fs::read_dir(dir)?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            let kind = e.file_type().ok()?;
            // Follow symlinks to decide; a dangling one is left out.
            let is_dir = if kind.is_symlink() {
                std::fs::metadata(&path).ok()?.is_dir()
            } else {
                kind.is_dir()
            };
            if !show_hidden && is_hidden(&name, is_dir) {
                return None;
            }
            Some(Entry {
                name,
                path: path.to_string_lossy().into_owned(),
                dir: is_dir,
            })
        })
        .collect();
    entries.sort_by(order);
    Ok(entries)
}

/// Names Windows keeps for devices, with or without an extension.
#[cfg(windows)]
fn is_reserved_on_windows(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// Why `name` cannot be a new entry's name, if it cannot. One path
/// component only: no separators, not `.` or `..`, no space around it.
pub fn check_name(name: &str) -> Result<(), &'static str> {
    if name.trim().is_empty() {
        return Err("名称不能为空");
    }
    if name.trim() != name {
        return Err("名称前后不能有空格");
    }
    if name == "." || name == ".." {
        return Err("名称不能是 . 或 ..");
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("名称不能包含 / 或 \\");
    }
    #[cfg(windows)]
    if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.ends_with(['.', ' ']) {
        return Err("名称不能包含 < > : \" | ? * ，也不能以点或空格结尾");
    }
    #[cfg(windows)]
    if is_reserved_on_windows(name) {
        return Err("这是 Windows 保留的名称（如 CON、NUL、COM1）");
    }
    Ok(())
}

/// Make an empty file (or folder, with `dir`) called `name` in `parent`.
/// Never replaces anything already there. Returns the new entry's path.
pub fn create(parent: &Path, name: &str, dir: bool) -> Result<String, String> {
    let name = name.trim();
    check_name(name)?;
    if !parent.is_dir() {
        return Err("所在的文件夹不存在".into());
    }
    let path = parent.join(name);
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err(format!("已经有名为“{name}”的文件或文件夹"));
    }
    let made = if dir {
        std::fs::create_dir(&path)
    } else {
        std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map(|_| ())
    };
    made.map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("已经有名为“{name}”的文件或文件夹"),
        _ => e.to_string(),
    })?;
    Ok(path.to_string_lossy().into_owned())
}

/// Check that `path` may be moved to the trash from the sidebar showing
/// `root`: it must be inside `root` (not `root` itself), spelled without
/// `..`, and exist. Compared as written, so a symlinked folder in the tree
/// counts as inside, and a symlink is trashed itself, not what it points to.
pub fn check_trashable(root: &Path, path: &Path) -> Result<(), String> {
    let plain = |p: &Path| p.is_absolute() && !p.components().any(|c| matches!(c, Component::ParentDir));
    if !plain(root) || !plain(path) || path == root || !path.starts_with(root) {
        return Err("只能删除当前文件夹里的文件和文件夹".into());
    }
    std::fs::symlink_metadata(path).map_err(|_| "它已经不在了".to_string())?;
    Ok(())
}

/// Move `path` to the Trash (Recycle Bin on Windows), after `check_trashable`.
pub fn trash(root: &Path, path: &Path) -> Result<(), String> {
    check_trashable(root, path)?;
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    // Finder's way needs permission to script Finder; this one needs none.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A scratch folder removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("edit2-fstree-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn file(&self, rel: &str) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, "x").unwrap();
        }
        fn dir(&self, rel: &str) {
            fs::create_dir_all(self.0.join(rel)).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn names(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn directories_first_then_by_name_ignoring_case() {
        let s = Scratch::new("order");
        s.file("b.md");
        s.file("A.txt");
        s.file("c.json");
        s.dir("zeta");
        s.dir("Alpha");
        let entries = list(&s.0, false).unwrap();
        assert_eq!(names(&entries), ["Alpha", "zeta", "A.txt", "b.md", "c.json"]);
        assert!(entries[0].dir && entries[1].dir && !entries[2].dir);
        assert_eq!(Path::new(&entries[2].path), s.0.join("A.txt"));
    }

    #[test]
    fn hides_dotfiles_and_heavy_folders_by_default() {
        let s = Scratch::new("hidden");
        s.dir(".git");
        s.dir("node_modules");
        s.file(".env");
        s.file("README.md");
        s.dir("src");
        assert_eq!(names(&list(&s.0, false).unwrap()), ["src", "README.md"]);
        assert_eq!(
            names(&list(&s.0, true).unwrap()),
            [".git", "node_modules", "src", ".env", "README.md"]
        );
    }

    #[test]
    fn a_file_named_like_a_heavy_folder_is_shown() {
        assert!(is_hidden("node_modules", true));
        assert!(!is_hidden("node_modules", false));
        assert!(is_hidden(".DS_Store", false));
    }

    #[test]
    fn lists_one_level_only() {
        let s = Scratch::new("shallow");
        s.file("docs/guide/intro.md");
        let top = list(&s.0, false).unwrap();
        assert_eq!(names(&top), ["docs"]);
        let docs = list(Path::new(&top[0].path), false).unwrap();
        assert_eq!(names(&docs), ["guide"]);
        assert!(docs[0].dir);
    }

    #[test]
    fn empty_folder_and_missing_folder() {
        let s = Scratch::new("empty");
        assert!(list(&s.0, false).unwrap().is_empty());
        assert!(list(&s.0.join("nope"), false).is_err());
    }

    #[test]
    fn listing_a_file_is_an_error() {
        let s = Scratch::new("notdir");
        s.file("a.txt");
        assert!(list(&s.0.join("a.txt"), false).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn follows_symlinks_and_skips_dangling_ones() {
        let s = Scratch::new("links");
        s.dir("real");
        s.file("real/x.md");
        std::os::unix::fs::symlink(s.0.join("real"), s.0.join("linked")).unwrap();
        std::os::unix::fs::symlink(s.0.join("gone"), s.0.join("dangling")).unwrap();
        let entries = list(&s.0, false).unwrap();
        assert_eq!(names(&entries), ["linked", "real"]);
        assert!(entries.iter().all(|e| e.dir));
    }

    #[test]
    fn creates_empty_files_and_folders_without_replacing() {
        let s = Scratch::new("create");
        let f = create(&s.0, "notes.weird-ext", false).unwrap();
        assert_eq!(Path::new(&f), s.0.join("notes.weird-ext"));
        assert_eq!(fs::read(&f).unwrap(), b"");
        let d = create(&s.0, "sub", true).unwrap();
        assert!(Path::new(&d).is_dir());
        assert!(create(&s.0, "sub", false).is_err());
        assert!(create(&s.0, "notes.weird-ext", true).is_err());
        fs::write(&f, "keep").unwrap();
        assert!(create(&s.0, "notes.weird-ext", false).is_err());
        assert_eq!(fs::read(&f).unwrap(), b"keep");
        assert!(create(&s.0.join("nope"), "a", false).is_err());
    }

    #[test]
    fn rejects_names_that_are_not_one_component() {
        for bad in ["", "  ", ".", "..", "a/b", "a\\b", " a.md", "a.md "] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
        for ok in ["a", ".env", "Makefile", "x.tar.gz", "中文.md"] {
            assert!(check_name(ok).is_ok(), "{ok:?}");
        }
    }

    #[test]
    fn trims_the_name_before_creating() {
        let s = Scratch::new("trim");
        let f = create(&s.0, "  spaced.md ", false).unwrap();
        assert_eq!(Path::new(&f), s.0.join("spaced.md"));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_device_names() {
        for bad in ["CON", "nul.md", "Com1.txt", "LPT9", "aux.tar.gz"] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
        for ok in ["CONSOLE.md", "com0", "COM10", "nullable.md"] {
            assert!(check_name(ok).is_ok(), "{ok:?}");
        }
    }

    #[test]
    fn only_entries_inside_the_folder_can_be_trashed() {
        let s = Scratch::new("trashable");
        s.file("docs/a.md");
        let root = s.0.as_path();
        assert!(check_trashable(root, &s.0.join("docs")).is_ok());
        assert!(check_trashable(root, &s.0.join("docs/a.md")).is_ok());
        assert!(check_trashable(root, root).is_err(), "the folder itself");
        assert!(check_trashable(root, &s.0.join("docs/../docs")).is_err(), "..");
        assert!(check_trashable(root, &s.0.join("missing.md")).is_err());
        assert!(check_trashable(&s.0.join("docs"), &s.0.join("other")).is_err(), "outside");
        assert!(check_trashable(root, Path::new("docs/a.md")).is_err(), "relative");
        // A sibling whose name starts with the folder's name is still outside.
        let sibling = PathBuf::from(format!("{}-x", s.0.display()));
        assert!(check_trashable(root, &sibling).is_err());
    }
}
