//! The design-system library, for the Projects page.
//!
//! The library is global (per user): `$OPENVIDS_DESIGN_SYSTEMS_DIR`, else `~/.openvids/design-systems` (the same
//! `home_dir()` rules as `research_policy.rs`; the Studio server's `packages/studio-server/src/design` and this
//! module agree on the default, so the shell never has to pass the variable on: a sidecar inherits the
//! environment). Layout, written by the Studio server:
//!
//! ```text
//! <root>/.lock                  cross-process write lock (see `design_lock`)
//! <root>/<id>/meta.json         DesignSystemMeta (schema `openvids.design-system-meta/1`)
//! <root>/<id>/system.html       the current version: showcase + embedded manifest
//! <root>/<id>/tokens.css        :root tokens + @font-face for fonts/
//! <root>/<id>/thumbnail.svg     generated card image
//! <root>/<id>/logo.<ext>        optional
//! <root>/<id>/fonts/<file>      woff2 / ttf / otf
//! <root>/<id>/versions/<n>/…    every version, complete
//! ```
//!
//! This side READS the library (list, detail, the files the Projects page previews), WRITES only two things —
//! a rename (edits `name` and `updatedAt` of `meta.json`, keeps every other field, atomic temp + rename) and a
//! delete — both under the library lock, and copies a system into a new project (the snapshot, below). It never
//! writes `versions/` and never creates a system.
//!
//! ## The project snapshot
//!
//! `<project>/design/{system.html, tokens.css, logo.*, fonts/*, design.json}`, copied verbatim from the library's
//! top level (the thumbnail is not copied), `design.json` last: `{schema: "openvids.project-design/1", id,
//! version, name, attachedAt, unknownLicenses, nonPortableFonts}` (the key order of `AttachedDesign`, 2-space
//! pretty JSON and a trailing newline: what the Studio server writes, byte for byte). The files are built in a
//! staging folder inside the project and swapped in as a whole, so a failure leaves the previous `design/` (or
//! none), never half of one, and nothing outside `design/` is written. [`DesignLibrary::attach_to_new_project`]
//! also links `design/tokens.css` from the new project's `index.html` (a fresh project has nothing to recolour):
//! compositions only pick the system up through that link.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::design_lock::{self, LockError};

pub const META_SCHEMA: &str = "openvids.design-system-meta/1";
pub const PROJECT_SCHEMA: &str = "openvids.project-design/1";
const MANIFEST_ID: &str = "openvids-design-manifest";
/// The longest name `parseDesignSystemName` takes (`DESIGN_LIMITS.nameChars`), in UTF-16 units like JavaScript.
const NAME_CHARS: usize = 80;
/// The longest id: the first character plus 47 more.
const ID_CHARS: usize = 48;
const LOCK_WAIT: Duration = Duration::from_secs(5);
/// A `meta.json` or `system.html` larger than this is not one of ours.
const META_BYTES: u64 = 256 * 1024;
const FILE_BYTES: u64 = 32 * 1024 * 1024;

// ── Errors ──────────────────────────────────────────────────────────────────

/// A refused request: the wire error `{ code, message }` of a `DesignError` (`design.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesignError {
    pub code: &'static str,
    pub message: String,
}

impl DesignError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message)
    }

    fn not_found(id: &str) -> Self {
        Self::new("not_found", format!("there is no design system {id:?}"))
    }

    pub(crate) fn unavailable(action: &str, err: impl std::fmt::Display) -> Self {
        Self::new("unavailable", format!("could not {action}: {err}"))
    }

    pub fn status(&self) -> u16 {
        match self.code {
            "invalid_request" => 400,
            "not_found" => 404,
            "conflict" => 409,
            "invalid_system" => 422,
            "busy" => 503,
            _ => 500,
        }
    }
}

impl std::fmt::Display for DesignError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DesignError {}

impl From<LockError> for DesignError {
    fn from(err: LockError) -> Self {
        match err {
            LockError::Busy(_) => Self::new("busy", err.to_string()),
            LockError::Io(io) => Self::unavailable("lock the design library", io),
        }
    }
}

// ── Shapes ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesignSource {
    pub kind: String,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

/// `DesignSystemSummary` (`design.ts`): a library card. Read from `meta.json`; fields this side does not know
/// stay in the file (a rename never goes through this type).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignSummary {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub source: DesignSource,
    pub created_at: u64,
    pub updated_at: u64,
    pub palette: Vec<String>,
    #[serde(default)]
    pub display_font: Option<String>,
    #[serde(default)]
    pub unknown_licenses: Vec<String>,
    #[serde(default)]
    pub non_portable_fonts: Vec<String>,
}

/// A font of the manifest, as the Projects page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignFontInfo {
    pub family: String,
    pub role: String,
    pub source: String,
    pub portable: bool,
    pub license_name: Option<String>,
    pub guess: bool,
}

/// `GET /api/design-systems/:id`: the summary plus what the detail sheet shows beside the preview.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DesignDetail {
    #[serde(flatten)]
    pub summary: DesignSummary,
    pub fonts: Vec<DesignFontInfo>,
    pub transitions: usize,
    pub versions: usize,
}

/// `<project>/design/design.json` (`AttachedDesign`); the field order is the file's key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedDesign {
    pub schema: &'static str,
    pub id: String,
    pub version: u32,
    pub name: String,
    pub attached_at: u64,
    pub unknown_licenses: Vec<String>,
    pub non_portable_fonts: Vec<String>,
}

// ── Ids, names, paths ───────────────────────────────────────────────────────

/// `^[a-z0-9][a-z0-9-]{0,47}$` (`DESIGN_SYSTEM_ID_PATTERN`).
pub fn is_design_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= ID_CHARS
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A library name as `parseDesignSystemName` takes it: not blank, at most 80 characters, no `<`, `>` or control
/// characters. The trimmed name.
pub fn parse_name(value: &str) -> Option<String> {
    let plain = !value.chars().any(|c| c == '<' || c == '>' || c.is_control());
    (plain && !value.trim().is_empty() && value.encode_utf16().count() <= NAME_CHARS)
        .then(|| value.trim().to_string())
}

/// The library root: `OPENVIDS_DESIGN_SYSTEMS_DIR`, else `~/.openvids/design-systems`.
pub fn library_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OPENVIDS_DESIGN_SYSTEMS_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    super::prefs::home_dir().join(".openvids").join("design-systems")
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The library files a request may name, as path segments: `system.html`, `tokens.css`, `thumbnail.svg`,
/// `logo.<ext>`, `fonts/<file>`. Anything else — a `..`, an absolute or drive path, a separator of the other
/// platform, a stream suffix, a control character, a nested or hidden name — is refused.
pub(crate) fn allowed_segments(rel: &str) -> Option<Vec<&str>> {
    let plain = |segment: &str| {
        !segment.is_empty()
            && !segment.starts_with('.')
            && !segment.chars().any(|c| matches!(c, '\\' | ':' | '/') || c.is_control())
    };
    let parts: Vec<&str> = rel.split('/').collect();
    let ok = match parts.as_slice() {
        ["system.html" | "tokens.css" | "thumbnail.svg"] => true,
        [logo] => logo
            .strip_prefix("logo.")
            .is_some_and(|ext| !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric())),
        ["fonts", file] => plain(file),
        _ => false,
    };
    ok.then_some(parts)
}

fn content_type(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

/// A regular file (not a link) of at most `limit` bytes; its bytes.
fn read_regular(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.len() > limit {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not a regular file of a usable size"));
    }
    std::fs::read(path)
}

/// Replaces `path` with `bytes` atomically: written beside it, then renamed over it.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".{}-{}.tmp", std::process::id(), design_lock::random_hex()));
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

// ── The manifest ────────────────────────────────────────────────────────────

/// The JSON block `<script type="application/json" id="openvids-design-manifest">` of a `system.html`, parsed.
/// A scan, not an HTML parser: tag and attribute names are matched case-insensitively, attribute order and quote
/// style do not matter, and anything that is not that block, or does not parse, yields `None`.
pub fn extract_manifest(html: &str) -> Option<Value> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<script") {
        let open = from + found;
        from = open + "<script".len();
        let Some(next) = lower.as_bytes().get(from) else { break };
        if !(next.is_ascii_whitespace() || *next == b'>' || *next == b'/') {
            continue;
        }
        let Some(tag_len) = lower[from..].find('>') else { break };
        let tag_end = from + tag_len;
        let tag = &lower[from..tag_end];
        let names_manifest = [format!("id=\"{MANIFEST_ID}\""), format!("id='{MANIFEST_ID}'"), format!("id={MANIFEST_ID}")]
            .iter()
            .any(|attribute| tag.contains(attribute.as_str()));
        if !names_manifest {
            continue;
        }
        let body_start = tag_end + 1;
        let Some(close) = lower[body_start..].find("</script") else { break };
        if let Ok(value) = serde_json::from_str::<Value>(html[body_start..body_start + close].trim()) {
            return Some(value);
        }
        from = body_start + close;
    }
    None
}

fn font_infos(manifest: &Value) -> Vec<DesignFontInfo> {
    let text = |font: &Value, key: &str| font.get(key).and_then(Value::as_str).map(str::to_string);
    manifest
        .get("fonts")
        .and_then(Value::as_array)
        .map(|fonts| {
            fonts
                .iter()
                .filter_map(|font| {
                    let source = text(font, "source")?;
                    Some(DesignFontInfo {
                        family: text(font, "family")?,
                        role: text(font, "role")?,
                        portable: font.get("portable").and_then(Value::as_bool).unwrap_or(source != "system"),
                        license_name: font.get("license").and_then(|license| text(license, "name")),
                        guess: font.get("guess").and_then(Value::as_bool).unwrap_or(false),
                        source,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ── The library ─────────────────────────────────────────────────────────────

pub struct DesignLibrary {
    root: PathBuf,
}

impl DesignLibrary {
    /// The library at its configured location.
    pub fn open() -> Self {
        Self::at(library_dir())
    }

    pub fn at(root: PathBuf) -> Self {
        Self { root }
    }

    fn dir_of(&self, id: &str) -> Result<PathBuf, DesignError> {
        if !is_design_id(id) {
            return Err(DesignError::invalid(format!("{id:?} is not a design system id")));
        }
        Ok(self.root.join(id))
    }

    /// A system's folder when it is one (a real directory, not a link).
    pub(crate) fn existing_dir(&self, id: &str) -> Result<PathBuf, DesignError> {
        let dir = self.dir_of(id)?;
        match std::fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() => Ok(dir),
            _ => Err(DesignError::not_found(id)),
        }
    }

    pub(crate) fn lock(&self) -> Result<design_lock::LibraryLock, DesignError> {
        Ok(design_lock::acquire(&self.root.join(".lock"), LOCK_WAIT)?)
    }

    fn read_meta_value(&self, dir: &Path) -> Option<Value> {
        let bytes = read_regular(&dir.join("meta.json"), META_BYTES).ok()?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        (value.get("schema").and_then(Value::as_str) == Some(META_SCHEMA)).then_some(value)
    }

    /// One folder's card; `None` for anything that is not a well-formed entry: unreadable or garbage `meta.json`,
    /// an id that is not the folder's name, a blank name, version 0.
    fn read_summary(&self, id: &str) -> Option<DesignSummary> {
        let dir = self.root.join(id);
        let value = self.read_meta_value(&dir)?;
        let summary: DesignSummary = serde_json::from_value(value).ok()?;
        let well_formed = summary.id == id
            && !summary.name.trim().is_empty()
            && summary.version >= 1
            && !summary.source.kind.is_empty();
        well_formed.then_some(summary)
    }

    /// Every system, newest updated first (ties by id). A folder that is not a well-formed entry is skipped.
    pub fn list(&self) -> Vec<DesignSummary> {
        let Ok(entries) = std::fs::read_dir(&self.root) else { return Vec::new() };
        let mut systems: Vec<DesignSummary> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|id| is_design_id(id))
            .filter_map(|id| self.read_summary(&id))
            .collect();
        systems.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
        systems
    }

    pub fn summary(&self, id: &str) -> Result<DesignSummary, DesignError> {
        self.existing_dir(id)?;
        self.read_summary(id).ok_or_else(|| DesignError::not_found(id))
    }

    /// The embedded manifest of the current `system.html`; `None` when there is no readable one.
    pub fn read_manifest(&self, id: &str) -> Result<Option<Value>, DesignError> {
        let dir = self.existing_dir(id)?;
        let html = read_regular(&dir.join("system.html"), FILE_BYTES).ok();
        Ok(html.and_then(|html| extract_manifest(&String::from_utf8_lossy(&html))))
    }

    pub fn detail(&self, id: &str) -> Result<DesignDetail, DesignError> {
        let summary = self.summary(id)?;
        let manifest = self.read_manifest(id)?;
        let transitions = manifest
            .as_ref()
            .and_then(|m| m.get("transitions"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let versions = std::fs::read_dir(self.root.join(id).join("versions"))
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                    .filter(|entry| entry.file_name().to_string_lossy().parse::<u32>().is_ok())
                    .count()
            })
            .unwrap_or(0)
            .max(1);
        Ok(DesignDetail {
            fonts: manifest.as_ref().map(font_infos).unwrap_or_default(),
            summary,
            transitions,
            versions,
        })
    }

    /// Renames a system: only `name` and `updatedAt` of `meta.json` change (every other field, known or not, is
    /// kept), no new version, written under the library lock by replacing the file atomically.
    pub fn rename(&self, id: &str, name: &str) -> Result<DesignSummary, DesignError> {
        let name = parse_name(name)
            .ok_or_else(|| DesignError::invalid(format!("name must be 1 to {NAME_CHARS} plain characters")))?;
        let dir = self.existing_dir(id)?;
        let _lock = self.lock()?;
        // Under the lock: a writer may have deleted or replaced the entry while this one waited.
        self.existing_dir(id)?;
        let mut value = self.read_meta_value(&dir).ok_or_else(|| DesignError::not_found(id))?;
        let fields = value.as_object_mut().ok_or_else(|| DesignError::not_found(id))?;
        let previous = fields.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
        fields.insert("name".to_string(), Value::String(name));
        fields.insert("updatedAt".to_string(), Value::from(now_ms().max(previous)));
        let mut bytes = serde_json::to_vec_pretty(&value).map_err(|e| DesignError::unavailable("write meta.json", e))?;
        bytes.push(b'\n');
        write_atomic(&dir.join("meta.json"), &bytes).map_err(|e| DesignError::unavailable("write meta.json", e))?;
        self.read_summary(id).ok_or_else(|| DesignError::not_found(id))
    }

    /// Deletes a system and everything in its folder, under the library lock. The folder is renamed out of the
    /// listing first, so a reader never sees half a system.
    pub fn delete(&self, id: &str) -> Result<(), DesignError> {
        let dir = self.existing_dir(id)?;
        let _lock = self.lock()?;
        let gone = self.root.join(format!(".deleting-{id}-{}", design_lock::random_hex()));
        std::fs::rename(&dir, &gone).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                DesignError::not_found(id)
            } else {
                DesignError::unavailable("delete the design system", e)
            }
        })?;
        // The system is gone either way; a leftover hidden folder is cleared by the next delete.
        let _ = std::fs::remove_dir_all(&gone);
        if let Ok(entries) = std::fs::read_dir(&self.root) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(".deleting-") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        Ok(())
    }

    /// One file of the current version, with its content type. `rel` is checked against the allow-list of
    /// [`allowed_segments`], and the file must be a regular file whose real path is inside the system's folder
    /// (a link, in the file or in `fonts`, never leads out of it).
    pub fn file(&self, id: &str, rel: &str) -> Result<(Vec<u8>, &'static str), DesignError> {
        let dir = self.existing_dir(id)?;
        let parts = allowed_segments(rel)
            .ok_or_else(|| DesignError::invalid(format!("{rel:?} is not a file of a design system")))?;
        let path = parts.iter().fold(dir.clone(), |path, part| path.join(part));
        let not_found = || DesignError::new("not_found", format!("{id:?} has no file {rel:?}"));
        let inside = match (path.canonicalize(), dir.canonicalize()) {
            (Ok(path), Ok(dir)) => path.starts_with(dir),
            _ => false,
        };
        if !inside {
            return Err(not_found());
        }
        let bytes = read_regular(&path, FILE_BYTES).map_err(|_| not_found())?;
        Ok((bytes, content_type(parts.last().copied().unwrap_or_default())))
    }
}

/// A library on disk as the Studio server writes it, for the tests of this module and of `design_snapshot`.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use serde_json::json;

    pub const MANIFEST_HTML: &str = concat!(
        "<!doctype html><html><head><style>:root{--bg:#000}</style>",
        "<script type=\"application/json\" id=\"openvids-design-manifest\">",
        "{\"schema\":\"openvids.design-system/1\",\"version\":1,\"fonts\":[",
        "{\"family\":\"Inter\",\"role\":\"display\",\"source\":\"google\",\"portable\":true,",
        "\"license\":{\"name\":\"SIL OFL 1.1\"}},",
        "{\"family\":\"Helvetica\",\"role\":\"body\",\"source\":\"system\",\"portable\":false,",
        "\"license\":null,\"guess\":true}],",
        "\"transitions\":[{\"kind\":\"fade\"},{\"kind\":\"wipe\"}]}",
        "</script></head><body></body></html>"
    );

    pub fn meta(id: &str, name: &str, updated: u64) -> Value {
        json!({
            "schema": META_SCHEMA,
            "id": id,
            "name": name,
            "version": 1,
            "source": { "kind": "manual", "ref": "somewhere" },
            "createdAt": 1000,
            "updatedAt": updated,
            "palette": ["#000000", "#ffffff"],
            "displayFont": "Inter",
            "unknownLicenses": ["logo"],
            "nonPortableFonts": ["Helvetica"],
            "futureField": { "keep": ["me", 1] }
        })
    }

    /// A complete system folder, like the Studio server writes one.
    pub fn write_system(root: &Path, id: &str, name: &str, updated: u64) {
        let dir = root.join(id);
        std::fs::create_dir_all(dir.join("fonts")).expect("fonts dir");
        std::fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(&meta(id, name, updated)).expect("json"))
            .expect("meta");
        std::fs::write(dir.join("system.html"), MANIFEST_HTML).expect("system.html");
        std::fs::write(dir.join("tokens.css"), ":root{--bg:#000}\n").expect("tokens.css");
        std::fs::write(dir.join("thumbnail.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>").expect("thumbnail");
        std::fs::write(dir.join("logo.svg"), "<svg/>").expect("logo");
        std::fs::write(dir.join("fonts").join("inter-400.woff2"), b"wOF2font").expect("font");
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{meta, write_system, MANIFEST_HTML};
    use super::*;
    use crate::design_lock::scratch::Dir;
    use serde_json::json;

    fn library(label: &str) -> (Dir, DesignLibrary) {
        let dir = Dir::new(label);
        let library = DesignLibrary::at(dir.path().to_path_buf());
        (dir, library)
    }

    fn ids(systems: &[DesignSummary]) -> Vec<&str> {
        systems.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn ids_follow_the_pattern_and_names_the_plain_rules() {
        for good in ["a", "0", "brand-kit", "a-", &"a".repeat(48)] {
            assert!(is_design_id(good), "{good:?}");
        }
        for bad in ["", "-a", "A", "a_b", "a b", "a.b", "../a", "a/b", "é", &"a".repeat(49)] {
            assert!(!is_design_id(bad), "{bad:?}");
        }
        assert_eq!(parse_name("  Acme Brand  ").as_deref(), Some("Acme Brand"));
        assert_eq!(parse_name(&"я".repeat(80)).as_deref().map(|n| n.chars().count()), Some(80));
        for bad in ["", "   ", "a<b", "a>b", "tab\there", "line\nbreak", "nul\0", "\u{85}", &"x".repeat(81)] {
            assert_eq!(parse_name(bad), None, "{bad:?}");
        }
        // 80 astral characters are 160 UTF-16 units: too long, as `String.length` counts them.
        assert_eq!(parse_name(&"😀".repeat(80)), None);
    }

    #[test]
    fn list_is_empty_for_a_library_that_does_not_exist() {
        let dir = Dir::new("lib-missing");
        assert!(DesignLibrary::at(dir.path().join("nope")).list().is_empty());
    }

    #[test]
    fn list_sorts_newest_updated_first_and_skips_garbage() {
        let (dir, library) = library("lib-list");
        let root = dir.path();
        write_system(root, "oldest", "Oldest", 10);
        write_system(root, "newest", "Newest", 30);
        write_system(root, "middle", "Middle", 20);
        write_system(root, "tied-b", "Tied B", 5);
        write_system(root, "tied-a", "Tied A", 5);
        // Entries that are not well-formed systems.
        std::fs::create_dir_all(root.join("garbage")).expect("dir");
        std::fs::write(root.join("garbage/meta.json"), "{ not json").expect("garbage meta");
        std::fs::create_dir_all(root.join("empty")).expect("dir");
        std::fs::create_dir_all(root.join("Upper-Case")).expect("dir");
        std::fs::write(root.join("Upper-Case/meta.json"), meta("Upper-Case", "x", 99).to_string()).expect("meta");
        std::fs::create_dir_all(root.join("liar")).expect("dir");
        std::fs::write(root.join("liar/meta.json"), meta("someone-else", "x", 99).to_string()).expect("meta");
        std::fs::create_dir_all(root.join("wrong-schema")).expect("dir");
        let mut other = meta("wrong-schema", "x", 99);
        other["schema"] = json!("openvids.something-else/1");
        std::fs::write(root.join("wrong-schema/meta.json"), other.to_string()).expect("meta");
        std::fs::create_dir_all(root.join("blank-name")).expect("dir");
        std::fs::write(root.join("blank-name/meta.json"), meta("blank-name", "  ", 99).to_string()).expect("meta");
        std::fs::create_dir_all(root.join("no-version")).expect("dir");
        let mut zero = meta("no-version", "x", 99);
        zero["version"] = json!(0);
        std::fs::write(root.join("no-version/meta.json"), zero.to_string()).expect("meta");
        std::fs::write(root.join("stray-file.txt"), "x").expect("stray file");
        std::fs::write(root.join(".lock"), "1").expect("lock file");

        let systems = library.list();
        assert_eq!(ids(&systems), ["newest", "middle", "oldest", "tied-a", "tied-b"]);
        let first = &systems[0];
        assert_eq!((first.name.as_str(), first.version, first.updated_at), ("Newest", 1, 30));
        assert_eq!(first.palette, ["#000000", "#ffffff"]);
        assert_eq!(first.display_font.as_deref(), Some("Inter"));
        assert_eq!((first.unknown_licenses.as_slice(), first.non_portable_fonts.as_slice()), (&["logo".to_string()][..], &["Helvetica".to_string()][..]));
        assert_eq!(first.source.reference.as_deref(), Some("somewhere"));
    }

    #[cfg(unix)]
    #[test]
    fn list_skips_a_linked_folder() {
        let (dir, library) = library("lib-linked");
        write_system(dir.path(), "real", "Real", 1);
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("alias")).expect("symlink");
        assert_eq!(ids(&library.list()), ["real"]);
    }

    #[test]
    fn rename_changes_only_name_and_updated_at_and_keeps_unknown_fields() {
        let (dir, library) = library("lib-rename");
        write_system(dir.path(), "brand", "Brand", 50);
        write_system(dir.path(), "other", "Other", 60);
        let read = |rel: &str| std::fs::read(dir.path().join(rel)).expect(rel);
        let untouched = ["brand/system.html", "brand/tokens.css", "brand/thumbnail.svg", "brand/logo.svg", "brand/fonts/inter-400.woff2", "other/meta.json"];
        let before: Vec<Vec<u8>> = untouched.iter().map(|rel| read(rel)).collect();
        let before_meta: Value = serde_json::from_slice(&read("brand/meta.json")).expect("meta");

        let renamed = library.rename("brand", "  New Name ").expect("rename");
        assert_eq!(renamed.name, "New Name");
        assert!(renamed.updated_at >= 50);
        assert_eq!(renamed.version, 1);

        let after_meta: Value = serde_json::from_slice(&read("brand/meta.json")).expect("meta");
        let mut expected = before_meta.clone();
        expected["name"] = json!("New Name");
        expected["updatedAt"] = after_meta["updatedAt"].clone();
        assert_eq!(after_meta, expected, "only name and updatedAt differ");
        assert!(after_meta["updatedAt"].as_u64().is_some_and(|ms| ms > 1_700_000_000_000), "a real clock value");
        assert_eq!(after_meta["futureField"], json!({ "keep": ["me", 1] }));
        for (rel, bytes) in untouched.iter().zip(&before) {
            assert_eq!(&read(rel), bytes, "{rel} is untouched");
        }
        let mut leftovers: Vec<String> = std::fs::read_dir(dir.path().join("brand"))
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        leftovers.sort();
        assert_eq!(leftovers, ["fonts", "logo.svg", "meta.json", "system.html", "thumbnail.svg", "tokens.css"]);
        assert!(!dir.path().join(".lock").exists(), "the lock is released");
        assert_eq!(ids(&library.list()), ["brand", "other"], "the renamed system is the newest updated");
    }

    #[test]
    fn rename_refuses_bad_names_and_unknown_systems() {
        let (dir, library) = library("lib-rename-bad");
        write_system(dir.path(), "brand", "Brand", 50);
        let before = std::fs::read(dir.path().join("brand/meta.json")).expect("meta");
        for bad in ["", "   ", "<b>x</b>", "a\nb", &"x".repeat(81)] {
            let err = library.rename("brand", bad).expect_err(bad);
            assert_eq!((err.code, err.status()), ("invalid_request", 400), "{bad:?}");
        }
        assert_eq!(library.rename("missing", "Fine").expect_err("missing").code, "not_found");
        assert_eq!(library.rename("../brand", "Fine").expect_err("traversal").code, "invalid_request");
        assert_eq!(std::fs::read(dir.path().join("brand/meta.json")).expect("meta"), before);
        assert!(!dir.path().join("missing").exists(), "a rename never creates a system");
    }

    #[test]
    fn rename_of_a_damaged_entry_is_not_found_and_leaves_it_alone() {
        let (dir, library) = library("lib-rename-damaged");
        std::fs::create_dir_all(dir.path().join("broken")).expect("dir");
        std::fs::write(dir.path().join("broken/meta.json"), "[1,2]").expect("meta");
        assert_eq!(library.rename("broken", "Fine").expect_err("damaged").code, "not_found");
        assert_eq!(std::fs::read_to_string(dir.path().join("broken/meta.json")).expect("meta"), "[1,2]");
    }

    #[test]
    fn rename_takes_over_a_stale_lock() {
        let (dir, library) = library("lib-rename-lock");
        write_system(dir.path(), "brand", "Brand", 50);
        // A lock left by a process that is long gone (an unparsable owner reads as dead).
        std::fs::write(dir.path().join(".lock"), "garbage").expect("stale lock");
        library.rename("brand", "Again").expect("a dead owner does not block");
        assert!(!dir.path().join(".lock").exists());
    }

    #[test]
    fn delete_removes_the_folder_and_nothing_else() {
        let (dir, library) = library("lib-delete");
        write_system(dir.path(), "gone", "Gone", 10);
        write_system(dir.path(), "kept", "Kept", 20);
        std::fs::create_dir_all(dir.path().join("gone/versions/1")).expect("versions");
        std::fs::write(dir.path().join("gone/versions/1/system.html"), "x").expect("version file");
        library.delete("gone").expect("delete");
        assert!(!dir.path().join("gone").exists());
        assert_eq!(ids(&library.list()), ["kept"]);
        assert!(dir.path().join("kept/fonts/inter-400.woff2").is_file());
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["kept"], "no hidden leftovers, no lock");
        assert_eq!(library.delete("gone").expect_err("twice").code, "not_found");
        assert_eq!(library.delete("../kept").expect_err("traversal").code, "invalid_request");
        assert!(dir.path().join("kept").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn delete_never_follows_a_linked_folder() {
        let (dir, library) = library("lib-delete-link");
        let outside = Dir::new("lib-delete-outside");
        std::fs::write(outside.path().join("precious.txt"), "keep").expect("file");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("alias")).expect("symlink");
        assert_eq!(library.delete("alias").expect_err("a link is not a system").code, "not_found");
        assert!(outside.path().join("precious.txt").is_file());
    }

    #[test]
    fn files_are_read_from_the_allow_list_with_their_content_types() {
        let (dir, library) = library("lib-files");
        write_system(dir.path(), "brand", "Brand", 1);
        for (rel, type_) in [
            ("system.html", "text/html; charset=utf-8"),
            ("tokens.css", "text/css; charset=utf-8"),
            ("thumbnail.svg", "image/svg+xml"),
            ("logo.svg", "image/svg+xml"),
            ("fonts/inter-400.woff2", "font/woff2"),
        ] {
            let (bytes, content_type) = library.file("brand", rel).expect(rel);
            assert_eq!(content_type, type_, "{rel}");
            assert_eq!(bytes, std::fs::read(dir.path().join("brand").join(rel)).expect(rel));
        }
        assert_eq!(library.file("brand", "logo.png").expect_err("no such logo").code, "not_found");
        assert_eq!(library.file("missing", "system.html").expect_err("no system").code, "not_found");
    }

    #[test]
    fn file_refuses_every_path_outside_the_allow_list() {
        let (dir, library) = library("lib-files-safe");
        write_system(dir.path(), "brand", "Brand", 1);
        write_system(dir.path(), "other", "Other", 2);
        std::fs::create_dir_all(dir.path().join("brand/versions/1")).expect("versions");
        std::fs::write(dir.path().join("brand/versions/1/system.html"), "old").expect("version");
        std::fs::write(dir.path().join("brand/fonts/.hidden"), "x").expect("hidden");
        std::fs::create_dir_all(dir.path().join("brand/fonts/deep")).expect("nested");
        std::fs::write(dir.path().join("brand/fonts/deep/f.woff2"), "x").expect("nested font");
        for bad in [
            "",
            "/",
            "/etc/passwd",
            "../other/meta.json",
            "..",
            "fonts/../meta.json",
            "fonts/../../other/system.html",
            "./system.html",
            "fonts/./inter-400.woff2",
            "meta.json",
            "versions/1/system.html",
            "fonts",
            "fonts/",
            "fonts/deep/f.woff2",
            "fonts/.hidden",
            "fonts//inter-400.woff2",
            "system.html/",
            "system.html/..",
            "..\\other\\meta.json",
            "fonts\\inter-400.woff2",
            "C:/Windows/win.ini",
            "C:\\Windows\\win.ini",
            "system.html:stream",
            "fonts/inter-400.woff2:stream",
            "logo.",
            "logo.sv/g",
            "logo.svg.bak",
            "logo",
            "Logo.svg",
            "system.html\0",
            "fonts/a\nb",
        ] {
            let err = library.file("brand", bad).expect_err(bad);
            assert!(matches!(err.code, "invalid_request" | "not_found"), "{bad:?} gave {err:?}");
        }
        for bad_id in ["../other", "other/..", "", "BRAND", "brand/.."] {
            assert_eq!(library.file(bad_id, "system.html").expect_err(bad_id).code, "invalid_request", "{bad_id:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn file_never_follows_a_link_out_of_the_system() {
        let (dir, library) = library("lib-files-link");
        let outside = Dir::new("lib-files-outside");
        std::fs::write(outside.path().join("secret.woff2"), "secret").expect("file");
        std::fs::write(outside.path().join("logo.svg"), "secret").expect("file");
        write_system(dir.path(), "brand", "Brand", 1);
        write_system(dir.path(), "other", "Other", 2);
        let brand = dir.path().join("brand");
        // A link to a file outside, a link to a sibling system's file, a linked fonts folder.
        std::os::unix::fs::symlink(outside.path().join("secret.woff2"), brand.join("fonts/leak.woff2")).expect("symlink");
        std::os::unix::fs::symlink(dir.path().join("other/system.html"), brand.join("fonts/sibling.woff2")).expect("symlink");
        std::fs::remove_file(brand.join("logo.svg")).expect("remove logo");
        std::os::unix::fs::symlink(outside.path().join("logo.svg"), brand.join("logo.svg")).expect("symlink");
        for rel in ["fonts/leak.woff2", "fonts/sibling.woff2", "logo.svg"] {
            assert_eq!(library.file("brand", rel).expect_err(rel).code, "not_found", "{rel}");
        }
        std::fs::remove_dir_all(brand.join("fonts")).expect("remove fonts");
        std::os::unix::fs::symlink(outside.path(), brand.join("fonts")).expect("symlink");
        assert_eq!(library.file("brand", "fonts/secret.woff2").expect_err("linked folder").code, "not_found");
        // A system folder that is itself a link is not a system at all.
        std::os::unix::fs::symlink(outside.path(), dir.path().join("alias")).expect("symlink");
        assert_eq!(library.file("alias", "logo.svg").expect_err("linked system").code, "not_found");
    }

    #[test]
    fn manifest_is_found_whatever_the_attribute_order_quotes_and_case() {
        let json = r#"{"version":3,"fonts":[]}"#;
        let cases = [
            format!("<script type=\"application/json\" id=\"openvids-design-manifest\">{json}</script>"),
            format!("<script id=\"openvids-design-manifest\" type=\"application/json\">{json}</script>"),
            format!("<script id='openvids-design-manifest' type='application/json'>\n  {json}\n</script>"),
            format!("<SCRIPT TYPE=\"application/json\" ID=\"openvids-design-manifest\">{json}</SCRIPT >"),
            format!("<script type=application/json id=openvids-design-manifest>{json}</script>"),
            format!("<style>a{{}}</style><script>var x = 1;</script><script id=\"other\">{{}}</script><script id=\"openvids-design-manifest\">{json}</script>"),
        ];
        for html in cases {
            let manifest = extract_manifest(&html).unwrap_or_else(|| panic!("no manifest in {html}"));
            assert_eq!(manifest["version"], 3, "{html}");
        }
        assert_eq!(extract_manifest(MANIFEST_HTML).expect("manifest")["transitions"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn manifest_is_none_when_absent_or_unusable() {
        for html in [
            "",
            "<html><body>no scripts</body></html>",
            "<script>{\"version\":1}</script>",
            "<script id=\"openvids-design-manifest\">{ not json</script>",
            "<script id=\"openvids-design-manifest\">{\"version\":1}",
            "<script id=\"openvids-design-manifest\"",
            "<scripts id=\"openvids-design-manifest\">{}</scripts>",
            "<p id=\"openvids-design-manifest\">{\"version\":1}</p>",
        ] {
            assert_eq!(extract_manifest(html), None, "{html:?}");
        }
        // The first block that does not parse does not hide a later good one.
        let two = "<script id=\"openvids-design-manifest\">oops</script><script id=\"openvids-design-manifest\">{\"version\":2}</script>";
        assert_eq!(extract_manifest(two).expect("second block")["version"], 2);
    }

    #[test]
    fn detail_adds_fonts_transitions_and_the_version_count() {
        let (dir, library) = library("lib-detail");
        write_system(dir.path(), "brand", "Brand", 1);
        for version in ["1", "2", "3", "not-a-version"] {
            std::fs::create_dir_all(dir.path().join("brand/versions").join(version)).expect("version");
        }
        std::fs::write(dir.path().join("brand/versions/stray-file"), "x").expect("stray");
        let detail = library.detail("brand").expect("detail");
        assert_eq!(detail.summary.id, "brand");
        assert_eq!((detail.transitions, detail.versions), (2, 3));
        assert_eq!(
            detail.fonts,
            [
                DesignFontInfo { family: "Inter".into(), role: "display".into(), source: "google".into(), portable: true, license_name: Some("SIL OFL 1.1".into()), guess: false },
                DesignFontInfo { family: "Helvetica".into(), role: "body".into(), source: "system".into(), portable: false, license_name: None, guess: true },
            ]
        );
        let wire = serde_json::to_value(&detail).expect("json");
        assert_eq!(wire["id"], "brand");
        assert_eq!(wire["displayFont"], "Inter");
        assert_eq!(wire["source"], json!({ "kind": "manual", "ref": "somewhere" }));
        assert_eq!((wire["transitions"].clone(), wire["versions"].clone()), (json!(2), json!(3)));
        assert_eq!(wire["fonts"][1]["licenseName"], Value::Null);
        assert!(wire.get("schema").is_none() && wire.get("futureField").is_none());
    }

    #[test]
    fn detail_survives_a_system_html_without_a_manifest() {
        let (dir, library) = library("lib-detail-bare");
        write_system(dir.path(), "brand", "Brand", 1);
        std::fs::write(dir.path().join("brand/system.html"), "<html></html>").expect("system.html");
        let detail = library.detail("brand").expect("detail");
        assert_eq!((detail.fonts.len(), detail.transitions, detail.versions), (0, 0, 1));
        assert_eq!(library.detail("missing").expect_err("missing").status(), 404);
    }
}
