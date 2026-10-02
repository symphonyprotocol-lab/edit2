//! Preferences (view modes, font size, recent files, …) in `settings.json`
//! in the app data folder. The webview's localStorage is tied to the bundle
//! identifier; a plain file survives a future rename with one folder copy.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};

#[derive(Default)]
pub struct Settings {
    path: Mutex<Option<PathBuf>>,
    values: Mutex<Map<String, Value>>,
}

impl Settings {
    /// Read the file (a missing or broken one starts empty).
    pub fn load(&self, path: PathBuf) {
        let values = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Map<String, Value>>(&bytes).ok())
            .unwrap_or_default();
        *self.values.lock().unwrap() = values;
        *self.path.lock().unwrap() = Some(path);
    }

    pub fn all(&self) -> Map<String, Value> {
        self.values.lock().unwrap().clone()
    }

    /// Set (or with `null`, remove) one value and write the file. The lock is
    /// held through the write so concurrent changes land in order.
    pub fn set(&self, key: String, value: Value) -> Result<(), String> {
        let path = self.path.lock().unwrap().clone().ok_or("设置尚未载入")?;
        let mut values = self.values.lock().unwrap();
        if value.is_null() {
            values.remove(&key);
        } else {
            values.insert(key, value);
        }
        let json = serde_json::to_vec_pretty(&*values).map_err(|e| e.to_string())?;
        crate::write_atomic(&path, &json).map_err(|e| e.to_string())
    }
}
