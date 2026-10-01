//! App preferences shared by the Projects home and Studio.
//!
//! One JSON file, `~/.openvids/app/preferences.json` (the directory can be
//! overridden with `OPENVIDS_APP_DIR`). The studio-server serves the same file
//! at `GET/PUT /api/app/preferences`, so both sides follow the same rules:
//!
//! - a missing or unreadable file means the defaults below;
//! - known keys with an invalid value fall back to their default on read;
//! - unknown keys (written by a newer app, or by the other side) are kept —
//!   updates are a deep merge into the stored document, never a replacement;
//! - writes are atomic (temp file + rename), so a crash never leaves half a file.
//!
//! The file is re-read on every request instead of cached: Studio may have
//! changed it since the home page last looked.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

pub const THEMES: [&str; 3] = ["system", "dark", "light"];
pub const WORKSPACES: [&str; 3] = ["media", "story", "edit"];
pub const LAUNCH_MODES: [&str; 2] = ["projects", "last"];
pub const FPS_CHOICES: [u64; 4] = [24, 25, 30, 60];
const MAX_SIZE: u64 = 8192;

/// The defaults, i.e. what a missing file means.
pub fn defaults() -> Value {
    json!({
        "version": 1,
        "theme": "system",
        "newProject": {
            "location": "~/Movies/OpenVids",
            "openIn": "media",
            "width": 1920,
            "height": 1080,
            "fps": 24
        },
        "confirmTrash": true,
        "onLaunch": "projects"
    })
}

/// The preferences directory: `OPENVIDS_APP_DIR`, else `~/.openvids/app`.
pub fn app_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OPENVIDS_APP_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    home_dir().join(".openvids").join("app")
}

pub fn prefs_path() -> PathBuf {
    app_dir().join("preferences.json")
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// `~` and `~/…` → the user's home directory; everything else unchanged.
pub fn expand_tilde(raw: &str) -> PathBuf {
    if raw == "~" {
        return home_dir();
    }
    match raw.strip_prefix("~/") {
        Some(rest) => home_dir().join(rest),
        None => PathBuf::from(raw),
    }
}

/// The inverse of `expand_tilde` for display: `/Users/me/x` → `~/x`.
pub fn abbreviate_home(path: &Path) -> String {
    let home = home_dir();
    match path.strip_prefix(&home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.to_string_lossy()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

/// Read the stored document (unknown keys included) without validation.
fn read_raw(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// The effective preferences: the stored document with every known key
/// validated (invalid or missing → default), unknown keys kept.
pub fn load(path: &Path) -> Value {
    normalize(read_raw(path))
}

/// Deep-merge `patch` into the stored document, validate, write atomically and
/// return the effective result. Only objects merge; any other value replaces.
pub fn update(path: &Path, patch: &Value) -> std::io::Result<Value> {
    if !patch.is_object() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "preferences must be a JSON object",
        ));
    }
    let mut stored = read_raw(path);
    merge(&mut stored, patch);
    let effective = normalize(stored);
    write_atomic(path, &effective)?;
    Ok(effective)
}

pub fn merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(into), Value::Object(from)) => {
            for (key, value) in from {
                match into.get_mut(key) {
                    Some(existing) if existing.is_object() && value.is_object() => {
                        merge(existing, value)
                    }
                    _ => {
                        into.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (slot, value) => *slot = value.clone(),
    }
}

fn normalize(stored: Value) -> Value {
    let mut out = match stored {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let base = defaults();
    out.insert("version".into(), json!(1));
    let theme = pick_str(out.get("theme"), &THEMES, "system");
    out.insert("theme".into(), json!(theme));
    let launch = pick_str(out.get("onLaunch"), &LAUNCH_MODES, "projects");
    out.insert("onLaunch".into(), json!(launch));
    let confirm = out
        .get("confirmTrash")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    out.insert("confirmTrash".into(), json!(confirm));

    let mut np = match out.remove("newProject") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let np_base = &base["newProject"];
    let location = np
        .get("location")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| np_base["location"].as_str().unwrap_or("~").to_string());
    np.insert("location".into(), json!(location));
    let open_in = pick_str(np.get("openIn"), &WORKSPACES, "media");
    np.insert("openIn".into(), json!(open_in));
    let width = pick_size(np.get("width")).unwrap_or(1920);
    let height = pick_size(np.get("height")).unwrap_or(1080);
    np.insert("width".into(), json!(width));
    np.insert("height".into(), json!(height));
    let fps = np
        .get("fps")
        .and_then(Value::as_u64)
        .filter(|f| FPS_CHOICES.contains(f))
        .unwrap_or(24);
    np.insert("fps".into(), json!(fps));
    out.insert("newProject".into(), Value::Object(np));
    Value::Object(out)
}

fn pick_str(value: Option<&Value>, allowed: &[&str], fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|s| allowed.contains(s))
        .unwrap_or(fallback)
        .to_string()
}

fn pick_size(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|n| (1..=MAX_SIZE).contains(n))
}

fn write_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "preferences.json".into()),
        std::process::id()
    ));
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Typed view of the fields the desktop acts on.
#[derive(Debug, Clone, PartialEq)]
pub struct NewProjectPrefs {
    pub location: PathBuf,
    pub open_in: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

pub fn new_project(prefs: &Value) -> NewProjectPrefs {
    let np = &prefs["newProject"];
    NewProjectPrefs {
        location: expand_tilde(np["location"].as_str().unwrap_or("~/Movies/OpenVids")),
        open_in: np["openIn"].as_str().unwrap_or("media").to_string(),
        width: np["width"].as_u64().unwrap_or(1920) as u32,
        height: np["height"].as_u64().unwrap_or(1080) as u32,
        fps: np["fps"].as_u64().unwrap_or(24) as u32,
    }
}

pub fn theme(prefs: &Value) -> &str {
    prefs["theme"].as_str().unwrap_or("system")
}

pub fn reopen_last(prefs: &Value) -> bool {
    prefs["onLaunch"].as_str() == Some("last")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openvids-prefs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("preferences.json")
    }

    #[test]
    fn a_missing_file_reads_as_the_defaults() {
        let path = tmp("missing");
        assert_eq!(load(&path), defaults());
    }

    #[test]
    fn invalid_known_values_fall_back_and_unknown_keys_survive() {
        let path = tmp("invalid");
        std::fs::write(
            &path,
            br#"{"theme":"neon","onLaunch":"last","future":{"x":1},"newProject":{"fps":23,"width":0,"height":1920,"openIn":"story","extra":true}}"#,
        )
        .unwrap();
        let prefs = load(&path);
        assert_eq!(prefs["theme"], "system");
        assert_eq!(prefs["onLaunch"], "last");
        assert_eq!(prefs["future"]["x"], 1);
        assert_eq!(prefs["newProject"]["fps"], 24);
        assert_eq!(prefs["newProject"]["width"], 1920);
        assert_eq!(prefs["newProject"]["height"], 1920);
        assert_eq!(prefs["newProject"]["openIn"], "story");
        assert_eq!(prefs["newProject"]["extra"], true);
        assert_eq!(prefs["newProject"]["location"], "~/Movies/OpenVids");
    }

    #[test]
    fn update_deep_merges_and_keeps_keys_written_by_the_other_side() {
        let path = tmp("merge");
        std::fs::write(
            &path,
            br#"{"studioOnly":{"panel":"left"},"newProject":{"fps":30,"location":"/x"}}"#,
        )
        .unwrap();
        let next = update(&path, &json!({"theme":"light","newProject":{"fps":60}})).unwrap();
        assert_eq!(next["theme"], "light");
        assert_eq!(next["newProject"]["fps"], 60);
        assert_eq!(next["newProject"]["location"], "/x");
        assert_eq!(next["studioOnly"]["panel"], "left");
        // Persisted, and the write left no temp file behind.
        assert_eq!(load(&path), next);
        let leftovers = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn update_refuses_a_non_object_patch() {
        let path = tmp("non-object");
        assert!(update(&path, &json!([1, 2])).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn tilde_round_trips() {
        let home = home_dir();
        assert_eq!(expand_tilde("~/Movies/OpenVids"), home.join("Movies/OpenVids"));
        assert_eq!(expand_tilde("/abs"), PathBuf::from("/abs"));
        assert_eq!(abbreviate_home(&home.join("Movies/X")), "~/Movies/X");
        assert_eq!(abbreviate_home(Path::new("/Volumes/SSD/X")), "/Volumes/SSD/X");
    }
}
