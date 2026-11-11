//! Directory listing for the folder sidebar. One level at a time: the tree
//! asks for a folder's children when it is expanded.

use std::cmp::Ordering;
use std::path::Path;

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
}
