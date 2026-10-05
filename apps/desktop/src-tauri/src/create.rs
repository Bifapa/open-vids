//! Scaffolding a new HyperFrames project from the home screen.
//!
//! This reuses the CLI's own template and conventions rather than
//! hand-rolling a second template:
//! - The base HTML is the CLI's bundled `blank` template
//!   (`packages/cli/src/templates/blank/index.html`, staged in production
//!   at `runtime/hyperframes/templates/blank/index.html`). It carries the
//!   root composition (`data-composition-id="main"`) that
//!   `structure::is_composition_source` requires.
//! - Dimensions/fps/duration are patched the way
//!   `applyResolutionPreset` in `packages/cli/src/commands/init.ts` does
//!   (data-width/data-height, inline body CSS, viewport meta) plus a
//!   `data-fps` root attribute (the attribute `core/runtime` honors and
//!   `render` defaults to — see `packages/cli/src/utils/compositionFps.ts`).
//! - `meta.json` (`{id, name, createdAt}`), `hyperframes.json` (registry
//!   paths, via the same shape `createProjectConfig` writes in
//!   `packages/cli/src/utils/projectConfig.ts`) and a script-less
//!   `package.json` are stamped beside it.
//!
//! What the CLI's interactive `init` does that this deliberately skips:
//! video/audio ingest + whisper transcription, registry example install,
//! Tailwind injection, and the global AI-skills freshness check — none of
//! them fit a local folder-picker form, and none affect validity.

use std::path::{Path, PathBuf};

use super::project::is_valid_project_id;
use super::structure::{set_composition_dimensions, set_composition_duration, set_composition_fps};

use serde_json::json;

use super::coded_error::CodedError;

/// Parameters from the create-project form.
pub struct CreateParams {
    pub parent: PathBuf,
    pub name: String,
    pub fps: String,
    pub width: u32,
    pub height: u32,
    pub duration: f64,
}

#[derive(Debug)]
pub enum CreateError {
    BadName(String),
    NoParent(PathBuf),
    Exists(PathBuf),
    Io(String),
    NoTemplate(String),
    BadPatch(String),
}

impl std::fmt::Display for CreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadName(name) => write!(
                f,
                "{name:?} is not a usable folder name (single path segment, no : / \\ or control characters)"
            ),
            Self::NoParent(dir) => write!(f, "the location {dir:?} does not exist"),
            Self::Exists(dir) => write!(f, "{dir:?} already exists and is not empty"),
            Self::Io(detail) => write!(f, "could not write the project: {detail}"),
            Self::NoTemplate(detail) => write!(f, "project template unavailable: {detail}"),
            Self::BadPatch(detail) => write!(f, "could not configure the template: {detail}"),
        }
    }
}

impl CreateError {
    /// The same sentence as `Display`, with the code and params the page translates it by.
    pub fn coded(&self) -> CodedError {
        let message = self.to_string();
        match self {
            Self::BadName(name) => CodedError::new("folder_name_unusable", message, json!({ "name": name })),
            Self::NoParent(dir) => {
                CodedError::new("location_missing", message, json!({ "path": dir.display().to_string() }))
            }
            Self::Exists(dir) => {
                CodedError::new("folder_exists", message, json!({ "path": dir.display().to_string() }))
            }
            Self::Io(detail) => CodedError::new("project_write_failed", message, json!({ "detail": detail })),
            Self::NoTemplate(detail) => {
                CodedError::new("template_unavailable_detail", message, json!({ "detail": detail }))
            }
            Self::BadPatch(detail) => CodedError::new("template_patch_failed", message, json!({ "detail": detail })),
        }
    }
}

impl std::error::Error for CreateError {}

/// A scaffolded project folder and how this request came by it.
#[derive(Debug)]
pub struct Scaffolded {
    pub dir: PathBuf,
    /// `true` when this call made the folder; `false` when it filled a folder
    /// that already existed empty.
    pub created: bool,
}

impl Scaffolded {
    /// Undo this call's work: the whole folder when it made it, only the
    /// contents when it adopted an empty one.
    pub fn discard(&self) {
        if self.created {
            let _ = std::fs::remove_dir_all(&self.dir);
            return;
        }
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let _ = if path.is_dir() {
                    std::fs::remove_dir_all(&path)
                } else {
                    std::fs::remove_file(&path)
                };
            }
        }
    }
}

/// Scaffold the project. A failure after the folder was claimed removes what
/// this call put there; a folder somebody else filled is never touched.
pub fn scaffold(template_index: &Path, params: &CreateParams) -> Result<Scaffolded, CreateError> {
    if !is_valid_project_id(&params.name) {
        return Err(CreateError::BadName(params.name.clone()));
    }
    if !(1..=240).contains(&params.fps.parse::<u32>().unwrap_or(0)) {
        return Err(CreateError::BadName(format!("fps {}", params.fps)));
    }
    if params.width == 0 || params.height == 0 || params.width > 8192 || params.height > 8192 {
        return Err(CreateError::BadName(format!(
            "size {}x{}",
            params.width, params.height
        )));
    }
    if !(params.duration > 0.0 && params.duration <= 3600.0) {
        return Err(CreateError::BadName(format!(
            "duration {}",
            params.duration
        )));
    }
    if !params.parent.is_dir() {
        return Err(CreateError::NoParent(params.parent.clone()));
    }
    let dest = params.parent.join(&params.name);
    let created = if dest.exists() {
        let non_empty = std::fs::read_dir(&dest)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(true);
        if non_empty {
            return Err(CreateError::Exists(dest));
        }
        false
    } else {
        // Atomic claim: of two requests racing for one free name only one
        // creates the folder, the other sees `Exists` and touches nothing.
        match std::fs::create_dir(&dest) {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(CreateError::Exists(dest));
            }
            Err(e) => return Err(CreateError::Io(e.to_string())),
        }
    };
    let scaffolded = Scaffolded { dir: dest, created };
    match fill(template_index, params, &scaffolded.dir) {
        Ok(()) => Ok(scaffolded),
        Err(err) => {
            scaffolded.discard();
            Err(err)
        }
    }
}

fn fill(template_index: &Path, params: &CreateParams, dest: &Path) -> Result<(), CreateError> {
    let template = std::fs::read_to_string(template_index)
        .map_err(|e| CreateError::NoTemplate(format!("{}: {e}", template_index.display())))?;
    let mut html = set_composition_dimensions(&template, params.width, params.height)
        .ok_or_else(|| CreateError::BadPatch("template has no composition root".to_string()))?;
    html = set_composition_fps(&html, &params.fps)
        .ok_or_else(|| CreateError::BadPatch("template has no composition root".to_string()))?;
    html = set_composition_duration(&html, params.duration)
        .ok_or_else(|| CreateError::BadPatch("template has no composition root".to_string()))?;
    std::fs::write(dest.join("index.html"), html).map_err(|e| CreateError::Io(e.to_string()))?;

    let created_at = now_iso();
    std::fs::write(
        dest.join("meta.json"),
        format!(
            "{{\n  \"id\": {},\n  \"name\": {},\n  \"createdAt\": \"{created_at}\"\n}}\n",
            json_string(&params.name),
            json_string(&params.name),
        ),
    )
    .map_err(|e| CreateError::Io(e.to_string()))?;

    if !dest.join("hyperframes.json").exists() {
        std::fs::write(
            dest.join("hyperframes.json"),
            concat!(
                "{\n",
                "  \"paths\": {\n",
                "    \"blocks\": \"compositions\",\n",
                "    \"components\": \"compositions/components\",\n",
                "    \"assets\": \"assets\"\n",
                "  },\n",
                "  \"media\": {\n",
                "    \"autoProxy\": true\n",
                "  }\n",
                "}\n",
            ),
        )
        .map_err(|e| CreateError::Io(e.to_string()))?;
    }
    if !dest.join("package.json").exists() {
        std::fs::write(
            dest.join("package.json"),
            format!(
                concat!(
                    "{{\n",
                    "  \"name\": {},\n",
                    "  \"private\": true,\n",
                    "  \"type\": \"module\"\n",
                    "}}\n",
                ),
                json_string(&to_package_name(&params.name)),
            ),
        )
        .map_err(|e| CreateError::Io(e.to_string()))?;
    }

    // AI context files ship beside the blank template in `_shared`
    // (`packages/cli/src/templates/_shared/`); copy them when present.
    if let Some(shared) = template_index
        .parent()
        .and_then(|t| t.parent())
        .map(|d| d.join("_shared"))
    {
        for name in ["AGENTS.md", "CLAUDE.md"] {
            let src = shared.join(name);
            let dst = dest.join(name);
            if src.is_file() && !dst.exists() {
                if let Ok(bytes) = std::fs::read(&src) {
                    let _ = std::fs::write(dst, bytes);
                }
            }
        }
    }

    Ok(())
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("{value:?}"))
}

fn to_package_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while out.starts_with(['.', '_']) {
        out.remove(0);
    }
    if out.is_empty() {
        out.push_str("video");
    }
    out
}

/// The current time as ISO-8601 UTC with seconds precision. The CLI writes
/// `new Date().toISOString()`; without a date dependency, seconds are the
/// honest resolution.
pub fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_epoch_utc(now)
}

/// Days-from-civil algorithm (Howard Hinnant) for an epoch-seconds UTC date.
fn format_epoch_utc(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let time = secs % 86400;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    y += if m <= 2 { 1 } else { 0 };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

/// Locate the blank template's `index.html`.
///
/// Dev resolves through the checkout (`CARGO_MANIFEST_DIR`), production
/// through the bundled runtime's staged copy. `prod_templates` is the
/// `runtime/hyperframes/templates` directory when the app was built with
/// `bun run desktop:build`.
pub fn blank_template_index(prod_templates: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = prod_templates {
        let staged = dir.join("blank").join("index.html");
        if staged.is_file() {
            return Some(staged);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("cli")
        .join("src")
        .join("templates")
        .join("blank")
        .join("index.html");
    if dev.is_file() {
        return Some(dev);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::structure::{composition_dimensions, is_composition_source};

    fn template() -> PathBuf {
        blank_template_index(None).expect("repo template must exist for tests")
    }

    fn params(parent: &Path, name: &str) -> CreateParams {
        CreateParams {
            parent: parent.to_path_buf(),
            name: name.to_string(),
            fps: "24".to_string(),
            width: 1080,
            height: 1920,
            duration: 15.0,
        }
    }

    #[test]
    fn scaffolds_a_valid_project() {
        let base = std::env::temp_dir().join("openvids-create-ok");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let dest = scaffold(&template(), &params(&base, "my-video")).unwrap().dir;
        let html = std::fs::read_to_string(dest.join("index.html")).unwrap();
        assert!(is_composition_source(&html));
        assert_eq!(composition_dimensions(&html), (1080, 1920));
        assert!(html.contains("data-fps=\"24\""));
        assert!(html.contains("data-duration=\"15\""));
        assert!(dest.join("meta.json").is_file());
        assert!(dest.join("hyperframes.json").is_file());
        let package: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dest.join("package.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(package["name"], "my-video");
        // The OpenVids CLI is not on npm: no script may fetch it from there.
        assert!(package.get("scripts").is_none());
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dest.join("meta.json")).unwrap())
                .unwrap();
        assert_eq!(meta["id"], "my-video");
        // Idempotent into an empty dir, refused into a non-empty one.
        assert!(matches!(
            scaffold(&template(), &params(&base, "my-video")),
            Err(CreateError::Exists(_))
        ));
    }

    #[test]
    fn rejects_bad_names_and_sizes() {
        let base = std::env::temp_dir().join("openvids-create-bad");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        assert!(matches!(
            scaffold(&template(), &params(&base, "../evil")),
            Err(CreateError::BadName(_))
        ));
        let mut p = params(&base, "ok");
        p.width = 0;
        assert!(matches!(
            scaffold(&template(), &p),
            Err(CreateError::BadName(_))
        ));
        let mut p = params(&base, "ok");
        p.fps = "29.97".to_string();
        assert!(matches!(
            scaffold(&template(), &p),
            Err(CreateError::BadName(_))
        ));
    }

    #[test]
    fn reports_whether_it_created_or_adopted_the_folder() {
        let base = std::env::temp_dir().join(format!("openvids-create-claim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("adopted")).unwrap();
        let made = scaffold(&template(), &params(&base, "made")).unwrap();
        assert!(made.created);
        let adopted = scaffold(&template(), &params(&base, "adopted")).unwrap();
        assert!(!adopted.created);
        // Discard mirrors it: the made folder goes, the adopted one stays empty.
        made.discard();
        adopted.discard();
        assert!(!base.join("made").exists());
        assert_eq!(std::fs::read_dir(base.join("adopted")).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_failed_scaffold_removes_only_its_own_work() {
        let base = std::env::temp_dir().join(format!("openvids-create-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("adopted")).unwrap();
        let missing = base.join("no-such-template.html");
        assert!(matches!(
            scaffold(&missing, &params(&base, "fresh")),
            Err(CreateError::NoTemplate(_))
        ));
        assert!(!base.join("fresh").exists(), "a folder the call made is removed");
        assert!(matches!(
            scaffold(&missing, &params(&base, "adopted")),
            Err(CreateError::NoTemplate(_))
        ));
        assert!(base.join("adopted").is_dir(), "an adopted empty folder stays");

        // A folder another request already filled is never rolled back.
        std::fs::create_dir_all(base.join("taken")).unwrap();
        std::fs::write(base.join("taken/mine.txt"), b"x").unwrap();
        assert!(matches!(
            scaffold(&template(), &params(&base, "taken")),
            Err(CreateError::Exists(_))
        ));
        assert!(base.join("taken/mine.txt").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
