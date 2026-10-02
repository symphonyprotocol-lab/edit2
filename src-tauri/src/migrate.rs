//! First launch after the rename from mdit: copy mdit's drafts, settings and
//! webview storage (preferences and recent files) to edit2's locations. This
//! runs before any webview exists, so WebKit has not yet created edit2's
//! storage. It only copies; mdit's data stays where it is.

use std::path::{Path, PathBuf};

const OLD_ID: &str = "dev.symphonyprotocollab.mdit";
const NEW_ID: &str = "dev.symphonyprotocollab.edit2";
const MARKER: &str = "migrated-from-mdit";

pub struct Report {
    pub drafts: usize,
    /// What could not be copied, and from where.
    pub failed: Vec<String>,
    pub old_data: PathBuf,
}

impl Report {
    /// One-line notice for the first window.
    pub fn message(&self) -> String {
        if self.failed.is_empty() {
            return match self.drafts {
                0 => "已从 mdit 迁移设置和最近文件".to_string(),
                n => format!("已从 mdit 迁移 {n} 份草稿、设置和最近文件"),
            };
        }
        format!(
            "从 mdit 迁移时，{}未能复制。原来的数据仍在 {}",
            self.failed.join("、"),
            self.old_data.display()
        )
    }
}

/// Folders that hold each app's data, as (mdit, edit2) pairs: the first is
/// the data folder (drafts, settings), the rest are webview storage.
fn locations() -> Option<Vec<(PathBuf, PathBuf)>> {
    let pair = |base: &Path, old: &str, new: &str| (base.join(old), base.join(new));
    #[cfg(target_os = "macos")]
    {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        let webkit = home.join("Library/WebKit");
        Some(vec![
            pair(&home.join("Library/Application Support"), OLD_ID, NEW_ID),
            pair(&webkit, OLD_ID, NEW_ID),
            // Unbundled development builds are keyed by the executable name.
            pair(&webkit, "mdit", "edit2"),
        ])
    }
    #[cfg(target_os = "windows")]
    {
        let roaming = PathBuf::from(std::env::var_os("APPDATA")?);
        let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
        Some(vec![pair(&roaming, OLD_ID, NEW_ID), pair(&local, OLD_ID, NEW_ID)])
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| Some(PathBuf::from(std::env::var_os("HOME")?).join(".local/share")))?;
        Some(vec![pair(&data, OLD_ID, NEW_ID)])
    }
}

/// Copy `from` into `to` recursively, keeping files that already exist there.
/// Returns how many files were copied.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<usize> {
    std::fs::create_dir_all(to)?;
    let mut copied = 0;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copied += copy_tree(&entry.path(), &target)?;
        } else if !target.exists() {
            std::fs::copy(entry.path(), &target)?;
            copied += 1;
        }
    }
    Ok(copied)
}

pub fn run() -> Option<Report> {
    run_at(&locations()?)
}

fn run_at(locations: &[(PathBuf, PathBuf)]) -> Option<Report> {
    let (old_data, new_data) = locations.first()?;
    if new_data.join(MARKER).exists() {
        return None;
    }
    let found = locations.iter().any(|(old, _)| old.is_dir());
    let mut report = Report { drafts: 0, failed: Vec::new(), old_data: old_data.clone() };

    if old_data.is_dir() {
        let drafts = old_data.join("drafts");
        let before = std::fs::read_dir(new_data.join("drafts")).map(|d| d.count()).unwrap_or(0);
        if copy_tree(old_data, new_data).is_err() {
            report.failed.push("草稿".to_string());
        }
        if drafts.is_dir() {
            let after = std::fs::read_dir(new_data.join("drafts")).map(|d| d.count()).unwrap_or(0);
            report.drafts = after.saturating_sub(before);
        }
    }
    for (old, new) in &locations[1..] {
        // Storage already created by edit2 is never mixed with mdit's.
        if old.is_dir() && !new.exists() && copy_tree(old, new).is_err() {
            report.failed.push("设置和最近文件".to_string());
        }
    }

    // Mark it done even when there was nothing to copy, so this runs once.
    let _ = std::fs::create_dir_all(new_data);
    let _ = std::fs::write(new_data.join(MARKER), "");
    found.then_some(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_once_and_leaves_the_original() {
        let base = std::env::temp_dir().join(format!("edit2-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (old_data, new_data) = (base.join("old"), base.join("new"));
        let (old_web, new_web) = (base.join("old-web"), base.join("new-web"));
        std::fs::create_dir_all(old_data.join("drafts")).unwrap();
        std::fs::write(old_data.join("drafts/a.md"), "a").unwrap();
        std::fs::write(old_data.join("drafts/b.md"), "b").unwrap();
        std::fs::create_dir_all(old_web.join("Default/x")).unwrap();
        std::fs::write(old_web.join("Default/x/localstorage.sqlite3"), "db").unwrap();
        let locations = vec![(old_data.clone(), new_data.clone()), (old_web.clone(), new_web.clone())];

        let report = run_at(&locations).expect("migrated");
        assert_eq!(report.drafts, 2);
        assert!(report.failed.is_empty());
        assert_eq!(std::fs::read_to_string(new_data.join("drafts/a.md")).unwrap(), "a");
        assert!(new_web.join("Default/x/localstorage.sqlite3").exists());
        assert!(old_data.join("drafts/a.md").exists(), "original kept");

        // Second launch: nothing happens, even if mdit gained a draft.
        std::fs::write(old_data.join("drafts/c.md"), "c").unwrap();
        assert!(run_at(&locations).is_none());
        assert!(!new_data.join("drafts/c.md").exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn nothing_to_migrate() {
        let base = std::env::temp_dir().join(format!("edit2-migrate-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let locations = vec![(base.join("old"), base.join("new"))];
        assert!(run_at(&locations).is_none());
        assert!(base.join("new").join(MARKER).exists());
        std::fs::remove_dir_all(base).unwrap();
    }
}
