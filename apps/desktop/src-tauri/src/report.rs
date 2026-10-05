//! In-app bug reports: everything except the HTTP routes (`home_report`).
//!
//! A report is an explicit user action and carries, in this exact order of
//! construction: what the user typed (description, optional steps/email),
//! optional screenshots the user chose, the tail of the shell log
//! (`logfile`, redacted here before it is sent), and diagnostics (version,
//! macOS version, arch, UI language, the FFmpeg version the CLI doctor
//! reports and — when the agent runtime happens to be up — the provider and
//! model names the user selected; never a key). It is sent to OpenVids'
//! report endpoint (`DEFAULT_BASE_URL`; env `OPENVIDS_REPORTS_URL` overrides).
//! Text and screenshots become a public GitHub issue; logs and email
//! never do. Because the user pressed "Send", the telemetry preference and
//! `DO_NOT_TRACK` do not apply to this module.
//!
//! Draft state lives in `<app data dir>/report-draft/`: `draft.json` plus one
//! file per screenshot (png/jpeg/webp, checked by magic bytes, at most 5 of
//! at most 8 MB). The reporter id (`<app data dir>/reporter-id`) is a random
//! UUID v4 created on the first send and is separate from telemetry's
//! installation id; it is sent with every report so one device's reports can
//! be linked to each other, and is never shared with statistics.
//!
//! Uploads run on the caller's thread — a per-connection thread of the home
//! server, so the accept loop is never held — and may legitimately take up to
//! ~90 s (status check + challenge + upload).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use flate2::write::GzEncoder;
use flate2::Compression;
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::{i18n, logfile, prefs, sidecar};

/// The report window's label (and the capability-less webview).
const WINDOW_LABEL: &str = "report";
/// Where reports go; `OPENVIDS_REPORTS_URL` replaces it (the base, no trailing slash).
const DEFAULT_BASE_URL: &str = "https://openvids.ai/api/reports";
const REPORTER_ID_FILE: &str = "reporter-id";
const DRAFT_DIR: &str = "report-draft";
const DRAFT_FILE: &str = "draft.json";
const MAX_SCREENSHOTS: usize = 5;
const MAX_SCREENSHOT_BYTES: u64 = 8 * 1024 * 1024;
/// The upload's own limit (`home_routes` reads bigger bodies only for the
/// raw-screenshot route; this is the account's total, logs included).
const MAX_LOGS_BYTES: usize = 2 * 1024 * 1024;
const SHORT_TIMEOUT: Duration = Duration::from_secs(10);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(90);
const FFMPEG_LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
const AGENT_SETTINGS_TIMEOUT: Duration = Duration::from_secs(2);
/// A challenge harder than this is refused rather than searched for hours.
const MAX_DIFFICULTY: u32 = 28;
/// The challenge search gives up after this.
const POW_DEADLINE: Duration = Duration::from_secs(25);
const VERSION: &str = env!("CARGO_PKG_VERSION");

// ── Shell state ─────────────────────────────────────────────────────────────

struct ReportShell {
    app: tauri::AppHandle,
    /// `<app data dir>`: the reporter id file lives here.
    root: PathBuf,
    /// `<app data dir>/report-draft`.
    draft_dir: PathBuf,
    /// The home server's origin, for the window URL.
    home_origin: String,
}

static SHELL: OnceLock<ReportShell> = OnceLock::new();

/// Called once from `setup`, after the home server knows its origin.
pub fn init(app: &tauri::AppHandle, home_origin: &str) {
    let root = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("openvids-desktop"));
    let _ = std::fs::create_dir_all(&root);
    let _ = SHELL.set(ReportShell {
        app: app.clone(),
        draft_dir: root.join(DRAFT_DIR),
        root,
        home_origin: home_origin.to_string(),
    });
}

fn shell() -> Option<&'static ReportShell> {
    SHELL.get()
}

/// The context the user last opened the report window from
/// (`projects` | `studio` | `menu`); the window remembers it and a submit
/// without one uses it.
static CONTEXT: Mutex<Option<String>> = Mutex::new(None);

fn normalize_context(context: Option<&str>) -> String {
    match context {
        Some("projects") => "projects",
        Some("studio") => "studio",
        _ => "menu",
    }
    .to_string()
}

fn current_context() -> String {
    CONTEXT
        .lock()
        .ok()
        .and_then(|c| c.clone())
        .unwrap_or_else(|| "menu".to_string())
}

/// The context a submit uses: the body's when given, else what the window
/// remembered, else the menu.
pub fn submit_context(context: Option<&str>) -> String {
    if context.is_some() {
        normalize_context(context)
    } else {
        current_context()
    }
}

// ── The report window ──────────────────────────────────────────────────────

/// Open the report window (or bring it forward), remembering `context`.
pub fn open_window(context: &str) {
    if let Ok(mut slot) = CONTEXT.lock() {
        *slot = Some(normalize_context(Some(context)));
    }
    let Some(shell) = shell() else {
        return;
    };
    let handle = shell.app.clone();
    // The caller may be a home-server route thread; window creation belongs
    // on the main thread (from the main thread this runs inline).
    let _ = shell.app.run_on_main_thread(move || open_on_main(&handle));
}

fn open_on_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Some(shell) = shell() else {
        return;
    };
    let preferences = prefs::load(&prefs::prefs_path());
    let language = prefs::language(&preferences);
    let url = format!(
        "{}/report?theme={}&density={}&language={}&context={}",
        shell.home_origin,
        sidecar::urlencode(prefs::theme(&preferences)),
        sidecar::urlencode(prefs::density(&preferences)),
        sidecar::urlencode(language),
        sidecar::urlencode(&current_context()),
    );
    let Ok(url) = url.parse::<tauri::Url>() else {
        logfile::shell(&format!("report window: invalid URL {url}"));
        return;
    };
    // Deliberately not modal and with no parent: the user keeps editing while
    // the window is open, moves it anywhere and takes screenshots. The page
    // drops files itself, so Tauri's drag-drop handler stays off. Native
    // (not overlay) title bar: the page needs no drag-region capability.
    let built =
        tauri::WebviewWindowBuilder::new(app, WINDOW_LABEL, tauri::WebviewUrl::External(url))
            .title(i18n::t("report.window.title"))
            .inner_size(520.0, 680.0)
            .min_inner_size(440.0, 520.0)
            .resizable(true)
            .theme(super::window_theme(&preferences))
            .disable_drag_drop_handler()
            .build();
    match built {
        Ok(_) => logfile::shell("report window opened"),
        Err(error) => {
            logfile::shell(&format!("could not open the report window: {error}"));
            eprintln!("[shell] could not open the report window: {error}");
        }
    }
}

/// `POST /api/report/pin`: keep the window above other windows (or not).
pub fn set_pinned(pinned: bool) {
    if let Some(app) = shell().map(|s| &s.app) {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let _ = window.set_always_on_top(pinned);
        }
    }
}

/// The report page's boot object (`home_routes` injects it as `OV_BOOT`):
/// the resolved theme, the resolved language and the raw preference, so the
/// first paint needs no extra request.
pub fn boot_json() -> Value {
    let preferences = prefs::load(&prefs::prefs_path());
    let theme = match shell().map(|s| &s.app) {
        Some(app) => super::resolved_theme(app),
        None => prefs::theme(&preferences),
    };
    json!({
        "theme": theme,
        "language": i18n::active(),
        "languagePreference": prefs::language(&preferences),
        // Region capture shells out to macOS's `screencapture`; elsewhere
        // the page does not offer it.
        "canCapture": cfg!(target_os = "macos"),
    })
}

// ── The draft and its screenshots ──────────────────────────────────────────

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct Draft {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub steps: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub screenshots: Vec<Screenshot>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Screenshot {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    /// The file inside the draft directory.
    #[serde(default)]
    pub file: String,
}

impl Screenshot {
    pub fn json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "size": self.size,
            "mime": self.mime,
        })
    }
}

impl Draft {
    fn load(dir: &Path) -> Draft {
        let stored: Draft = std::fs::read_to_string(dir.join(DRAFT_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        // A screenshot file the user deleted by hand is not part of the draft.
        let mut draft = stored;
        draft
            .screenshots
            .retain(|shot| !shot.file.is_empty() && dir.join(&shot.file).is_file());
        draft
    }

    fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let tmp = dir.join(format!(".{DRAFT_FILE}.{}.tmp", std::process::id()));
        std::fs::write(&tmp, format!("{text}\n"))?;
        std::fs::rename(&tmp, dir.join(DRAFT_FILE)).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    }

    pub fn json(&self) -> Value {
        json!({
            "description": self.description,
            "steps": self.steps,
            "email": self.email,
            "screenshots": self.screenshots.iter().map(Screenshot::json).collect::<Vec<_>>(),
        })
    }

    /// What the server accepts (contract 2): a 10..8000-character description,
    /// at most 4000 characters of steps, at most 200 characters of email.
    fn validate(&self) -> Result<(), String> {
        let description = self.description.trim().chars().count();
        if description < 10 {
            return Err("The description needs at least 10 characters.".into());
        }
        if description > 8000 {
            return Err("The description is longer than 8000 characters.".into());
        }
        if self.steps.chars().count() > 4000 {
            return Err("The steps are longer than 4000 characters.".into());
        }
        if self.email.chars().count() > 200 {
            return Err("The email address is longer than 200 characters.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddError {
    TooMany,
    TooLarge,
    UnsupportedType,
    Io,
}

impl AddError {
    pub fn status(self) -> u16 {
        match self {
            AddError::TooMany => 409,
            AddError::TooLarge => 413,
            AddError::UnsupportedType => 400,
            AddError::Io => 500,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            AddError::TooMany => "too_many",
            AddError::TooLarge => "too_large",
            AddError::UnsupportedType => "unsupported_type",
            AddError::Io => "server",
        }
    }
}

/// `GET /api/report/draft`.
pub fn draft_json() -> Value {
    match shell() {
        Some(shell) => Draft::load(&shell.draft_dir).json(),
        None => Draft::default().json(),
    }
}

/// `PUT /api/report/draft`: replace the three text fields, keep screenshots.
pub fn draft_update(body: &[u8]) -> Result<(), String> {
    let Some(shell) = shell() else {
        return Err("the app is still starting".into());
    };
    let value: Value =
        serde_json::from_slice(body).map_err(|_| "the request body is not JSON".to_string())?;
    let mut draft = Draft::load(&shell.draft_dir);
    for (key, field) in [
        ("description", &mut draft.description),
        ("steps", &mut draft.steps),
        ("email", &mut draft.email),
    ] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            *field = text.to_string();
        }
    }
    draft
        .save(&shell.draft_dir)
        .map_err(|e| format!("could not save the draft: {e}"))
}

/// `POST /api/report/screenshots`: validate and store one raw image.
pub fn screenshot_upload(name: Option<&str>, bytes: &[u8]) -> Result<Screenshot, AddError> {
    let Some(shell) = shell() else {
        return Err(AddError::Io);
    };
    let mut draft = Draft::load(&shell.draft_dir);
    add_image(&shell.draft_dir, &mut draft, name.unwrap_or(""), bytes)
}

/// `POST /api/report/screenshots/capture`.
pub enum CaptureOutcome {
    Added(Screenshot),
    Cancelled,
    Rejected(AddError),
}

/// `screencapture -i -x` (interactive region/window, no sound). The report
/// window is hidden first when asked, so it never covers the target.
pub fn screenshot_capture(hide_window: bool) -> CaptureOutcome {
    let Some(shell) = shell() else {
        return CaptureOutcome::Rejected(AddError::Io);
    };
    let draft = Draft::load(&shell.draft_dir);
    if draft.screenshots.len() >= MAX_SCREENSHOTS {
        return CaptureOutcome::Rejected(AddError::TooMany);
    }
    if !cfg!(target_os = "macos") {
        return CaptureOutcome::Rejected(AddError::UnsupportedType);
    }
    let window = shell.app.get_webview_window(WINDOW_LABEL);
    if hide_window {
        if let Some(window) = &window {
            let _ = window.hide();
        }
        // Give AppKit a moment to actually take the window off screen; the
        // interactive overlay must not capture our own window.
        std::thread::sleep(Duration::from_millis(250));
    }
    let file = std::env::temp_dir().join(format!(
        "openvids-report-{}-{}.png",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    ));
    let _ = std::fs::remove_file(&file);
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-i")
        .arg("-x")
        .arg(&file)
        .status();
    if hide_window {
        if let Some(window) = &window {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    match status {
        Err(error) => {
            let _ = std::fs::remove_file(&file);
            logfile::shell(&format!("screencapture could not run: {error}"));
            CaptureOutcome::Rejected(AddError::Io)
        }
        Ok(_) => {
            let bytes = std::fs::read(&file).unwrap_or_default();
            let _ = std::fs::remove_file(&file);
            if bytes.is_empty() {
                return CaptureOutcome::Cancelled;
            }
            let mut draft = Draft::load(&shell.draft_dir);
            match add_image(&shell.draft_dir, &mut draft, "Screenshot.png", &bytes) {
                Ok(shot) => CaptureOutcome::Added(shot),
                Err(error) => CaptureOutcome::Rejected(error),
            }
        }
    }
}

pub struct Picked {
    pub added: Vec<Screenshot>,
    pub rejected: Vec<Value>,
}

/// `POST /api/report/screenshots/pick`: the native image picker, multiple
/// files. Files that do not fit are reported per name, never silently lost.
pub fn screenshot_pick() -> Picked {
    let mut picked = Picked {
        added: Vec::new(),
        rejected: Vec::new(),
    };
    let Some(shell) = shell() else {
        return picked;
    };
    let chosen = rfd::FileDialog::new()
        .set_title(i18n::t("dialog.reportPick.title"))
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .pick_files()
        .unwrap_or_default();
    let mut draft = Draft::load(&shell.draft_dir);
    for path in chosen {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Screenshot".to_string());
        let too_large = std::fs::metadata(&path)
            .map(|m| m.len() > MAX_SCREENSHOT_BYTES)
            .unwrap_or(false);
        if too_large {
            picked
                .rejected
                .push(json!({ "name": name, "error": "too_large" }));
            continue;
        }
        match std::fs::read(&path) {
            // A file that cannot be read is not a usable image.
            Err(_) => picked
                .rejected
                .push(json!({ "name": name, "error": "unsupported_type" })),
            Ok(bytes) => match add_image(&shell.draft_dir, &mut draft, &name, &bytes) {
                Ok(shot) => picked.added.push(shot),
                Err(error) => picked
                    .rejected
                    .push(json!({ "name": name, "error": error.code() })),
            },
        }
    }
    picked
}

/// `GET /api/report/screenshots/<id>`: the stored bytes and their mime.
pub fn screenshot_bytes(id: &str) -> Option<(String, Vec<u8>)> {
    let shell = shell()?;
    if !valid_id(id) {
        return None;
    }
    let draft = Draft::load(&shell.draft_dir);
    let shot = draft.screenshots.iter().find(|s| s.id == id)?;
    let bytes = std::fs::read(shell.draft_dir.join(&shot.file)).ok()?;
    Some((shot.mime.clone(), bytes))
}

/// `DELETE /api/report/screenshots/<id>`.
pub fn screenshot_remove(id: &str) {
    let Some(shell) = shell() else {
        return;
    };
    if !valid_id(id) {
        return;
    }
    let mut draft = Draft::load(&shell.draft_dir);
    let removed = draft.screenshots.iter().find(|shot| shot.id == id).cloned();
    if let Some(shot) = removed {
        draft.screenshots.retain(|s| s.id != id);
        let _ = std::fs::remove_file(shell.draft_dir.join(&shot.file));
        let _ = draft.save(&shell.draft_dir);
    }
}

/// A stored image that could not be validated is refused with the reason the
/// page shows (`too_many` | `too_large` | `unsupported_type` | `server`).
fn add_image(
    dir: &Path,
    draft: &mut Draft,
    name: &str,
    bytes: &[u8],
) -> Result<Screenshot, AddError> {
    if draft.screenshots.len() >= MAX_SCREENSHOTS {
        return Err(AddError::TooMany);
    }
    if bytes.len() as u64 > MAX_SCREENSHOT_BYTES {
        return Err(AddError::TooLarge);
    }
    let (mime, extension) = sniff_image(bytes).ok_or(AddError::UnsupportedType)?;
    std::fs::create_dir_all(dir).map_err(|_| AddError::Io)?;
    let id = new_screenshot_id();
    let file = format!("{id}.{extension}");
    std::fs::write(dir.join(&file), bytes).map_err(|_| AddError::Io)?;
    let shot = Screenshot {
        id,
        name: sanitize_name(name, extension),
        size: bytes.len() as u64,
        mime: mime.to_string(),
        file,
    };
    let mut next = draft.clone();
    next.screenshots.push(shot.clone());
    if next.save(dir).is_err() {
        let _ = std::fs::remove_file(dir.join(&shot.file));
        return Err(AddError::Io);
    }
    *draft = next;
    Ok(shot)
}

/// `png`, `jpeg` or `webp` from the first bytes — the declared content type
/// is never trusted. Anything else is not an image we accept.
fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some(("image/png", "png"));
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(("image/jpeg", "jpg"));
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(("image/webp", "webp"));
    }
    None
}

/// A screenshot id: `s` plus random hex, safe as a file name and as a URL
/// path segment, unique within a draft.
fn new_screenshot_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("os randomness for a screenshot id");
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("s{hex}")
}

fn valid_id(id: &str) -> bool {
    let rest = id.strip_prefix('s').unwrap_or("");
    (1..=16).contains(&rest.len()) && rest.chars().all(|c| c.is_ascii_hexdigit())
}

/// The name the user (or the picker) gave: no path, no quotes, no control
/// characters, bounded; a usable default when nothing survives.
fn sanitize_name(raw: &str, extension: &str) -> String {
    let decoded = super::home_routes::percent_decode(raw);
    let tail = decoded
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&decoded)
        .trim()
        .trim_matches('"');
    let clean: String = tail
        .chars()
        .filter(|c| !c.is_control() && *c != '"')
        .take(120)
        .collect();
    if clean.is_empty() {
        format!("Screenshot.{extension}")
    } else {
        clean
    }
}

// ── Reporter id ────────────────────────────────────────────────────────────

/// The random UUID v4 in `<app data dir>/reporter-id`, created on first use.
/// Deliberately a different file (and value) from telemetry's installation
/// id: the two must not be joinable by accident.
fn reporter_id(root: &Path) -> std::io::Result<String> {
    let path = root.join(REPORTER_ID_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        let text = text.trim();
        if is_uuid(text) {
            return Ok(text.to_string());
        }
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let id = format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    );
    std::fs::create_dir_all(root)?;
    let tmp = root.join(format!(".{REPORTER_ID_FILE}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, format!("{id}\n"))?;
    std::fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(id)
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

// ── Challenge ──────────────────────────────────────────────────────────

/// `SHA-256(salt + ":" + nonce)` must have at least `difficulty` leading zero
/// bits; the nonce is decimal ASCII. The search runs on every core.
pub fn solve_pow(salt: &str, difficulty: u32) -> Option<String> {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8);
    let stop = AtomicBool::new(false);
    let found: Mutex<Option<String>> = Mutex::new(None);
    let deadline = Instant::now() + POW_DEADLINE;
    std::thread::scope(|scope| {
        for worker in 0..workers {
            let stop = &stop;
            let found = &found;
            scope.spawn(move || {
                let nonce = search_nonce(
                    salt,
                    difficulty,
                    worker as u64,
                    workers as u64,
                    stop,
                    deadline,
                );
                if let Some(nonce) = nonce {
                    if let Ok(mut slot) = found.lock() {
                        if slot.is_none() {
                            *slot = Some(nonce.to_string());
                        }
                    }
                    stop.store(true, Ordering::Relaxed);
                }
            });
        }
    });
    found.into_inner().ok().flatten()
}

/// The first nonce in `start, start+step, …` meeting `difficulty`. Each
/// worker scans one residue class; the search ends on the first hit
/// anywhere, at the deadline, or when another worker found one.
fn search_nonce(
    salt: &str,
    difficulty: u32,
    mut counter: u64,
    step: u64,
    stop: &AtomicBool,
    deadline: Instant,
) -> Option<u64> {
    let mut since_clock_check = 0u64;
    loop {
        if stop.load(Ordering::Relaxed) {
            return None;
        }
        // Checking the clock on every hash would cost more than the hashes.
        since_clock_check += 1;
        if since_clock_check >= 4096 {
            since_clock_check = 0;
            if Instant::now() > deadline {
                return None;
            }
        }
        if hash_meets(salt, &counter.to_string(), difficulty) {
            return Some(counter);
        }
        counter = counter.checked_add(step)?;
    }
}

fn hash_meets(salt: &str, nonce: &str, difficulty: u32) -> bool {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(nonce.as_bytes());
    let digest = hasher.finalize();
    leading_zero_bits(digest.as_slice()) >= difficulty
}

/// How many of the digest's most significant bits are zero, counted per bit
/// (0x00 0x0F is 12, not 9).
fn leading_zero_bits(bytes: &[u8]) -> u32 {
    let mut bits = 0;
    for byte in bytes {
        if *byte == 0 {
            bits += 8;
        } else {
            bits += byte.leading_zeros();
            break;
        }
    }
    bits
}

// ── Redaction ──────────────────────────────────────────────────────────────

struct Redactor {
    rules: Vec<(Regex, &'static str)>,
}

static REDACTOR: OnceLock<Redactor> = OnceLock::new();

fn redactor() -> &'static Redactor {
    REDACTOR.get_or_init(|| {
        let patterns: &[(&str, &str)] = &[
            // Auth headers and token-shaped strings first, then individual
            // vendors, then JSON-ish assignments, then emails.
            (r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}", "Bearer ***"),
            (r"sk-[A-Za-z0-9_-]{8,}", "sk-***"),
            (r"github_pat_[A-Za-z0-9_]{8,}", "github_pat_***"),
            (r"gh[pousr]_[A-Za-z0-9]{8,}", "gh*_***"),
            (r"xox[abpr]-[A-Za-z0-9-]{8,}", "xox-***"),
            (r"AIza[0-9A-Za-z_-]{10,}", "AIza***"),
            (
                r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{4,})?",
                "***",
            ),
            (
                // `authorization` is deliberately absent: a bare `Bearer`
                // value would match here and eat the header name's own
                // redaction, while `Bearer <token>` is already handled above.
                r#"(?i)(\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password)\b"?\s*[:=]\s*"?)([^"\s,;}\]]{4,})"#,
                "${1}***",
            ),
            (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[email]"),
        ];
        Redactor {
            rules: patterns
                .iter()
                .map(|(pattern, replacement)| {
                    (
                        Regex::new(pattern).expect("a static redaction pattern"),
                        *replacement,
                    )
                })
                .collect(),
        }
    })
}

/// A pattern for every spelling of the home directory a log line can carry:
/// either path separator (a JSON- or Debug-escaped backslash is two of them),
/// any character as its `%XX` form, and any letter case (the filesystems the
/// app runs on are case-insensitive by default). `None` for an empty or
/// root-only home, which would match every slash in the log.
fn home_pattern(home: &str) -> Option<Regex> {
    let trimmed = home.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None;
    }
    let mut pattern = String::from("(?i)");
    let mut utf8 = [0u8; 4];
    for ch in trimmed.chars() {
        if ch == '/' || ch == '\\' {
            pattern.push_str(r"(?:/|\\{1,2}|%2F|%5C)");
            continue;
        }
        let encoded: String = ch
            .encode_utf8(&mut utf8)
            .bytes()
            .map(|byte| format!("%{byte:02X}"))
            .collect();
        pattern.push_str("(?:");
        pattern.push_str(&regex::escape(&ch.to_string()));
        pattern.push('|');
        pattern.push_str(&encoded);
        pattern.push(')');
    }
    Regex::new(&pattern).ok()
}

/// The log text as it may leave the machine: API keys, bearer tokens, JWTs,
/// key/token/secret/password values, email addresses and the user's home
/// directory (as `~`, in every escaped, slashed, encoded or re-cased form)
/// are all removed here, before anything leaves the machine.
pub fn redact(text: &str, home: &str) -> String {
    let mut out = match home_pattern(home) {
        Some(pattern) => pattern.replace_all(text, "~").into_owned(),
        None => text.to_string(),
    };
    for (rule, replacement) in &redactor().rules {
        out = rule.replace_all(&out, *replacement).into_owned();
    }
    out
}

// ── Diagnostics ────────────────────────────────────────────────────────────

/// The `diagnostics` object of the report meta: version, OS, arch, language,
/// FFmpeg (via the CLI's own lookup) and — when the agent runtime is already
/// up — the providers and models the user selected. Names only, never keys.
fn diagnostics() -> Value {
    let mut out = json!({
        "appVersion": VERSION,
        "os": std::env::consts::OS,
        "osVersion": os_version(),
        "arch": std::env::consts::ARCH,
        "language": i18n::active(),
        "ffmpeg": ffmpeg_version(),
    });
    if let Some((providers, models)) = agent_selection() {
        out["providers"] = json!(providers);
        out["models"] = models;
    }
    out
}

fn os_version() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let output = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The FFmpeg version the shell's own check reports (`hyperframes doctor
/// --tools`, the same lookup the System check uses), or `None` when FFmpeg
/// is not installed or the answer did not come back in time.
fn ffmpeg_version() -> Option<String> {
    let output = super::cli_runner::run(&["doctor", "--tools"], FFMPEG_LOOKUP_TIMEOUT).ok()?;
    let value = super::cli_runner::last_json_line(&output)?;
    let ffmpeg = value.get("tools")?.get("ffmpeg")?;
    if ffmpeg.get("found").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    ffmpeg
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Providers and models from `GET /v1/settings`, but only when the agent
/// runtime is already running: diagnostics never start it. `None` (the field
/// is then omitted) when it is down, slow or unreadable.
fn agent_selection() -> Option<(Vec<String>, Value)> {
    let bytes = super::agent_proxy::settings_if_running(AGENT_SETTINGS_TIMEOUT)?;
    let settings: Value = serde_json::from_slice(&bytes).ok()?;
    let mut providers: Vec<String> = Vec::new();
    let mut models = serde_json::Map::new();
    let mut remember = |role: &str, selection: Option<(String, String)>| {
        if let Some((provider, label)) = selection {
            if !providers.contains(&provider) {
                providers.push(provider);
            }
            models.insert(role.to_string(), json!(label));
        }
    };
    remember("director", selection_of(&settings["director"]["model"]));
    for role in ["editor", "vision", "motion", "research", "audio"] {
        remember(role, selection_of(&settings["specialists"][role]["model"]));
    }
    remember("jev", selection_of(&settings["jev"]));
    providers.sort();
    (!providers.is_empty()).then(|| (providers, Value::Object(models)))
}

/// One `{provider, modelId}` selection (a `ModelSelection` or Jev's fields).
fn selection_of(value: &Value) -> Option<(String, String)> {
    let provider = value.get("provider")?.as_str()?.to_string();
    let model = value.get("modelId")?.as_str()?;
    Some((provider.clone(), format!("{provider}/{model}")))
}

// ── Upload ─────────────────────────────────────────────────────────────────

/// `POST /api/report/submit`: status → challenge → multipart
/// upload. Returns the HTTP status and JSON body the page gets; the draft is
/// cleared on success only.
pub fn submit(context: Option<&str>) -> (u16, Value) {
    let Some(shell) = shell() else {
        return failure(502, "network", "OpenVids is still starting.");
    };
    submit_to(&shell.draft_dir, &shell.root, &base_url(), context)
}

/// The submit path with its inputs named, so a test can point it at a
/// loopback server and a scratch directory.
fn submit_to(draft_dir: &Path, root: &Path, base: &str, context: Option<&str>) -> (u16, Value) {
    let draft = Draft::load(draft_dir);
    if let Err(message) = draft.validate() {
        return failure(400, "invalid_request", &message);
    }
    let reporter = match reporter_id(root) {
        Ok(id) => id,
        Err(error) => {
            logfile::shell(&format!("report: could not store the reporter id: {error}"));
            return failure(502, "server", "The reporter id could not be stored.");
        }
    };
    let context = submit_context(context);
    let short = agent(SHORT_TIMEOUT);

    // Ask the service whether it takes reports before asking for a challenge.
    let status_url = format!("{base}/status");
    let (code, body) = match send(short.get(&status_url).call()) {
        Ok(pair) => pair,
        Err(error) => return network_error("could not reach the report service", &error),
    };
    match code {
        200 if body["enabled"].as_bool() == Some(false) => {
            return failure(503, "disabled", "Bug reports are temporarily disabled.");
        }
        200 => {}
        503 => return failure(503, "disabled", "Bug reports are temporarily disabled."),
        _ => {
            return failure(
                502,
                "server",
                &format!("The report service answered {code} to its status check."),
            )
        }
    }

    let challenge_url = format!("{base}/challenge");
    let request = json!({ "reporterId": reporter });
    let (code, body) = match send(
        short
            .post(&challenge_url)
            .content_type("application/json")
            .send(request.to_string()),
    ) {
        Ok(pair) => pair,
        Err(error) => return network_error("could not reach the report service", &error),
    };
    match code {
        200 => {}
        429 => {
            return failure_retry(
                429,
                "rate_limited",
                "Too many reports from this device.",
                body["retryAfter"].as_u64().or(Some(60)),
            )
        }
        503 => return failure(503, "disabled", "Bug reports are temporarily disabled."),
        _ => {
            return failure(
                502,
                "server",
                &format!("The report service answered {code} to the challenge."),
            )
        }
    }
    let Some(challenge_id) = body["challengeId"].as_str().map(str::to_string) else {
        return failure(502, "server", "The challenge was unreadable.");
    };
    let Some(salt) = body["salt"].as_str().map(str::to_string) else {
        return failure(502, "server", "The challenge was unreadable.");
    };
    let difficulty = match body["difficulty"].as_u64() {
        // A challenge without a difficulty gets a default; an absurd one is
        // refused rather than searched for hours.
        None => 20,
        Some(value) if value <= u64::from(MAX_DIFFICULTY) => value as u32,
        Some(_) => return failure(502, "server", "The challenge was too hard to solve."),
    };
    let Some(nonce) = solve_pow(&salt, difficulty) else {
        return failure(502, "server", "The challenge could not be solved.");
    };

    let meta = report_meta(&draft, &challenge_id, &nonce, &reporter, &context);
    let mut parts = vec![Part {
        name: "meta",
        filename: None,
        content_type: "application/json",
        bytes: meta.to_string().into_bytes(),
    }];
    let home = prefs::home_dir().to_string_lossy().into_owned();
    let logs = redact(&logfile::tail(), &home);
    if !logs.trim().is_empty() {
        if let Some(gzipped) = gzip(&logs) {
            parts.push(Part {
                name: "logs",
                filename: Some("openvids.log.gz".to_string()),
                content_type: "application/gzip",
                bytes: gzipped,
            });
        }
    }
    for shot in &draft.screenshots {
        if let Ok(bytes) = std::fs::read(draft_dir.join(&shot.file)) {
            parts.push(Part {
                name: "screenshot",
                filename: Some(shot.name.clone()),
                content_type: mime_of(&shot.mime),
                bytes,
            });
        }
    }
    let boundary = multipart_boundary();
    let body = multipart_body(&boundary, &parts);
    let upload = agent(UPLOAD_TIMEOUT);
    let response = upload
        .post(base)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .send(body);
    let (code, body) = match send(response) {
        Ok(pair) => pair,
        Err(error) => return network_error("the upload failed", &error),
    };
    match code {
        200 if matches!(
            body["status"].as_str(),
            Some("published") | Some("received")
        ) =>
        {
            clear_draft(draft_dir);
            logfile::shell(&format!(
                "report sent: {}",
                body["status"].as_str().unwrap_or("?")
            ));
            (200, body)
        }
        400 => failure(
            400,
            "invalid_request",
            body["message"]
                .as_str()
                .unwrap_or("The report was rejected as invalid."),
        ),
        403 => failure(
            502,
            "server",
            "The challenge was rejected; please try again.",
        ),
        413 => failure(413, "too_large", "The report is too large to send."),
        429 => failure_retry(
            429,
            "rate_limited",
            body["message"].as_str().unwrap_or("Too many reports."),
            body["retryAfter"].as_u64().or(Some(60)),
        ),
        503 => failure(503, "disabled", "Bug reports are temporarily disabled."),
        _ if code >= 500 => failure(
            502,
            "server",
            &format!("The report service answered {code}."),
        ),
        _ => failure(
            502,
            "server",
            &format!("The report service answered {code}."),
        ),
    }
}

fn report_meta(
    draft: &Draft,
    challenge: &str,
    nonce: &str,
    reporter: &str,
    context: &str,
) -> Value {
    let mut meta = json!({
        "challengeId": challenge,
        "nonce": nonce,
        "reporterId": reporter,
        "description": draft.description.trim(),
        "context": context,
        "diagnostics": diagnostics(),
    });
    if !draft.steps.trim().is_empty() {
        meta["steps"] = json!(draft.steps);
    }
    if !draft.email.trim().is_empty() {
        meta["email"] = json!(draft.email.trim());
    }
    meta
}

fn clear_draft(dir: &Path) {
    let draft = Draft::load(dir);
    for shot in &draft.screenshots {
        let _ = std::fs::remove_file(dir.join(&shot.file));
    }
    let _ = Draft::default().save(dir);
}

/// The base URL, `OPENVIDS_REPORTS_URL` first (no trailing slash).
pub fn base_url() -> String {
    std::env::var("OPENVIDS_REPORTS_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .max_redirects(0)
        .user_agent(format!(
            "OpenVids/{VERSION} ({}; {})",
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
        .build()
        .into()
}

fn send(
    result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> Result<(u16, Value), String> {
    match result {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let text = response.body_mut().read_to_string().unwrap_or_default();
            Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn network_error(what: &str, error: &str) -> (u16, Value) {
    logfile::shell(&format!("report: {what}: {error}"));
    failure(
        502,
        "network",
        &format!("{what}. Check the internet connection."),
    )
}

fn failure(status: u16, code: &str, message: &str) -> (u16, Value) {
    failure_retry(status, code, message, None)
}

/// A failure body; `retryAfter` only rides along when the server sent one.
fn failure_retry(status: u16, code: &str, message: &str, retry_after: Option<u64>) -> (u16, Value) {
    let mut body = json!({ "error": code, "message": message });
    if let Some(seconds) = retry_after {
        body["retryAfter"] = json!(seconds);
    }
    (status, body)
}

struct Part {
    name: &'static str,
    filename: Option<String>,
    content_type: &'static str,
    bytes: Vec<u8>,
}

/// The multipart body, framed by hand: ureq 3 (with the features this crate
/// builds) has no multipart writer, and the shape is five lines of RFC 7578.
fn multipart_body(boundary: &str, parts: &[Part]) -> Vec<u8> {
    let mut out = Vec::new();
    for part in parts {
        out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match &part.filename {
            Some(name) => out.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n",
                    part.name, name
                )
                .as_bytes(),
            ),
            None => out.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{}\"\r\n", part.name).as_bytes(),
            ),
        }
        out.extend_from_slice(format!("Content-Type: {}\r\n\r\n", part.content_type).as_bytes());
        out.extend_from_slice(&part.bytes);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    out
}

fn multipart_boundary() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("os randomness for the multipart boundary");
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("----openvids-{hex}")
}

fn gzip(text: &str) -> Option<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(text.as_bytes()).ok()?;
    let bytes = encoder.finish().ok()?;
    (bytes.len() <= MAX_LOGS_BYTES).then_some(bytes)
}

/// A stored screenshot's mime as a `&'static str` (the part table and the
/// response header need one). Values are magic-checked at store time; an
/// impossible unknown falls back to `image/png`.
pub fn mime_of(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "image/jpeg",
        "image/webp" => "image/webp",
        _ => "image/png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "openvids-report-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn png(bytes: usize) -> Vec<u8> {
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        out.resize(bytes.max(8), 0);
        out
    }

    #[test]
    fn leading_zero_bits_count_bits_at_byte_boundaries() {
        assert_eq!(leading_zero_bits(&[0x80]), 0);
        assert_eq!(leading_zero_bits(&[0x7f]), 1);
        assert_eq!(leading_zero_bits(&[0x01]), 7);
        assert_eq!(leading_zero_bits(&[0x00, 0xff]), 8);
        assert_eq!(leading_zero_bits(&[0x00, 0x0f]), 12);
        assert_eq!(leading_zero_bits(&[0x00, 0x00, 0x7f]), 17);
        assert_eq!(leading_zero_bits(&[0x00, 0x00, 0x00, 0x00]), 32);
    }

    #[test]
    fn the_pow_solver_finds_a_decimal_nonce_meeting_the_difficulty() {
        // The harder case keeps the solver fast enough on a laptop.
        for (salt, difficulty) in [("test-salt", 14u32), ("another", 20)] {
            let nonce = solve_pow(salt, difficulty).expect("a nonce");
            assert!(
                nonce.chars().all(|c| c.is_ascii_digit()),
                "nonce {nonce:?} must be decimal ASCII"
            );
            assert!(
                hash_meets(salt, &nonce, difficulty),
                "nonce {nonce} does not meet difficulty {difficulty}"
            );
        }
    }

    #[test]
    fn a_sequential_search_returns_the_first_valid_nonce() {
        // The worker's own search, with the stride of one worker: the result
        // is the smallest valid nonce, so the solver cannot skip or loop.
        let nonce = search_nonce(
            "deterministic",
            12,
            0,
            1,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(30),
        )
        .expect("a nonce within 30 s at difficulty 12");
        for candidate in 0..nonce {
            assert!(
                !hash_meets("deterministic", &candidate.to_string(), 12),
                "{candidate} is smaller than {nonce} and already valid"
            );
        }
        assert!(hash_meets("deterministic", &nonce.to_string(), 12));
    }

    #[test]
    fn a_search_past_its_deadline_gives_up() {
        let stop = AtomicBool::new(false);
        assert_eq!(
            search_nonce(
                "x",
                64,
                0,
                1,
                &stop,
                Instant::now() - Duration::from_millis(1)
            ),
            None
        );
        assert_eq!(
            search_nonce("x", 64, 0, 1, &AtomicBool::new(true), Instant::now()),
            None
        );
    }

    #[test]
    fn multipart_framing_is_exact_and_binary_safe() {
        let parts = [
            Part {
                name: "meta",
                filename: None,
                content_type: "application/json",
                bytes: br#"{"a":1}"#.to_vec(),
            },
            Part {
                name: "screenshot",
                filename: Some("Screenshot.png".to_string()),
                content_type: "image/png",
                bytes: vec![0x00, 0xff, 0x0d, 0x0a],
            },
            Part {
                name: "screenshot",
                filename: Some("second.jpg".to_string()),
                content_type: "image/jpeg",
                bytes: b"jpeg".to_vec(),
            },
        ];
        let body = multipart_body("BOUND", &parts);
        let expected: Vec<u8> = [
            b"--BOUND\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n{\"a\":1}\r\n".to_vec(),
            b"--BOUND\r\nContent-Disposition: form-data; name=\"screenshot\"; filename=\"Screenshot.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec(),
            vec![0x00, 0xff, 0x0d, 0x0a],
            b"\r\n--BOUND\r\nContent-Disposition: form-data; name=\"screenshot\"; filename=\"second.jpg\"\r\nContent-Type: image/jpeg\r\n\r\njpeg\r\n--BOUND--\r\n".to_vec(),
        ]
        .concat();
        assert_eq!(body, expected);
    }

    #[test]
    fn image_types_come_from_magic_bytes_not_the_declared_type() {
        assert_eq!(multipart_body("B", &[]), b"--B--\r\n".to_vec());
        assert_eq!(sniff_image(&png(8)), Some(("image/png", "png")));
        assert_eq!(
            sniff_image(&[0xff, 0xd8, 0xff, 0, 0]),
            Some(("image/jpeg", "jpg"))
        );
        let mut webp = b"RIFF\0\0\0\0WEBP".to_vec();
        webp.resize(20, 0);
        assert_eq!(sniff_image(&webp), Some(("image/webp", "webp")));
        assert_eq!(sniff_image(b"not an image"), None);
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WAVE"), None);
    }

    #[test]
    fn draft_limits_reject_the_sixth_oversized_and_wrong_magic_screenshot() {
        let dir = temp_dir("limits");
        let mut draft = Draft::default();
        for _ in 0..MAX_SCREENSHOTS {
            add_image(&dir, &mut draft, "shot.png", &png(64)).expect("within the limit");
        }
        assert_eq!(draft.screenshots.len(), MAX_SCREENSHOTS);
        assert_eq!(
            add_image(&dir, &mut draft, "sixth.png", &png(64)),
            Err(AddError::TooMany)
        );
        assert_eq!(draft.screenshots.len(), MAX_SCREENSHOTS);

        let mut single = Draft::default();
        let oversized = vec![0u8; MAX_SCREENSHOT_BYTES as usize + 1];
        assert_eq!(
            add_image(&dir, &mut single, "big.png", &oversized),
            Err(AddError::TooLarge)
        );
        assert_eq!(
            add_image(&dir, &mut single, "fake.png", b"%PDF-1.7 not an image"),
            Err(AddError::UnsupportedType)
        );
        assert!(single.screenshots.is_empty());
        // The draft index round-trips through disk, and deleting a file by
        // hand drops the entry.
        let saved = Draft::load(&dir);
        assert_eq!(saved.screenshots.len(), MAX_SCREENSHOTS);
        std::fs::remove_file(dir.join(&saved.screenshots[0].file)).unwrap();
        assert_eq!(Draft::load(&dir).screenshots.len(), MAX_SCREENSHOTS - 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn screenshot_names_are_sanitized() {
        assert_eq!(sanitize_name("", "png"), "Screenshot.png");
        assert_eq!(sanitize_name("shot one.PNG", "png"), "shot one.PNG");
        assert_eq!(sanitize_name("../escape.png", "png"), "escape.png");
        assert_eq!(sanitize_name("/tmp/a/\"quoted\".png", "png"), "quoted.png");
        assert_eq!(sanitize_name(&"x".repeat(300), "png"), "x".repeat(120));
    }

    #[test]
    fn redaction_covers_keys_tokens_jwts_fields_emails_and_the_home_dir() {
        let home = "/Users/Test User";
        let log = concat!(
            "[sidecar] 2026-10-03T10:00:00.000Z using key sk-abcdefghijklmnopqrstuv\n",
            "[sidecar] 2026-10-03T10:00:01.000Z anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n",
            "[shell] 2026-10-03T10:00:02.000Z gh token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n",
            "[shell] 2026-10-03T10:00:03.000Z fine-grained github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n",
            "[agent] 2026-10-03T10:00:04.000Z slack xoxb-123456789012-abcdefghijkl\n",
            "[agent] 2026-10-03T10:00:05.000Z google AIzaSyA1234567890abcdefghijklmnopqrs\n",
            "[shell] 2026-10-03T10:00:06.000Z Authorization: Bearer abcdefghijklmnopqrstuvwxyz\n",
            "[sidecar] 2026-10-03T10:00:07.000Z jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\n",
            "[shell] 2026-10-03T10:00:08.000Z {\"apiKey\":\"abcd1234efgh\",\"token\":\"t-12345678\"} password=hunter2secret\n",
            "[shell] 2026-10-03T10:00:09.000Z wrote /Users/Test User/Documents/project/index.html\n",
            "[shell] 2026-10-03T10:00:10.000Z from user@example.com to https://openvids.ai\n",
        );
        let redacted = redact(log, home);
        for secret in [
            "sk-abcdefghijklmnopqrstuv",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
            "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            "xoxb-123456789012-abcdefghijkl",
            "AIzaSyA1234567890abcdefghijklmnopqrs",
            "abcdefghijklmnopqrstuvwxyz",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            "abcd1234efgh",
            "t-12345678",
            "hunter2secret",
            "user@example.com",
            "/Users/Test User",
        ] {
            assert!(!redacted.contains(secret), "{secret} survived: {redacted}");
        }
        assert!(redacted.contains("Bearer ***"), "{redacted}");
        assert!(redacted.contains("\"apiKey\":\"***\""), "{redacted}");
        assert!(redacted.contains("password=***"), "{redacted}");
        assert!(
            redacted.contains("~/Documents/project/index.html"),
            "{redacted}"
        );
        assert!(redacted.contains("[email]"), "{redacted}");
        // Markdown links and prose keep their shape.
        assert!(redacted.contains("https://openvids.ai"), "{redacted}");
    }

    #[test]
    fn redaction_removes_every_spelling_of_the_home_dir() {
        let windows = r"C:\Users\Alice Smith";
        for line in [
            r"opened C:\Users\Alice Smith\Videos\demo",
            r#"{"projectDir":"C:\\Users\\Alice Smith\\Videos"}"#,
            r#"Debug "C:\\Users\\Alice Smith\\Videos""#,
            "opened C:/Users/Alice Smith/Videos",
            "file:///C:/Users/Alice%20Smith/Videos/demo.mp4",
            r"lower c:\users\alice smith\videos",
            "encoded C%3A%5CUsers%5CAlice%20Smith%5CVideos",
            r"verbatim \\?\C:\Users\Alice Smith\Videos",
        ] {
            let redacted = redact(line, windows);
            assert!(
                !redacted.to_lowercase().contains("alice"),
                "the user name survived in {line}: {redacted}"
            );
            assert!(redacted.contains('~'), "{redacted}");
        }
        let posix = "/Users/alice";
        for line in [
            "%2FUsers%2Falice%2Fproject",
            "file:///Users/al%69ce/x",
            "/users/ALICE/x",
            "/Users/alice/x",
        ] {
            let redacted = redact(line, posix);
            assert!(
                !redacted.to_lowercase().contains("alice") && !redacted.contains("%69"),
                "the user name survived in {line}: {redacted}"
            );
        }
        assert_eq!(redact("/Users/alice/x", posix), "~/x");
        assert_eq!(redact("/a/b/c", "/"), "/a/b/c", "a root home must not eat every slash");
    }

    #[test]
    fn redaction_leaves_ordinary_log_lines_alone() {
        let home = "/Users/Test";
        for line in [
            "[shell] 2026-10-03T10:00:00.000Z home server on http://127.0.0.1:57035",
            "[sidecar] 2026-10-03T10:00:00.000Z max_tokens=4096 and the token was missing",
            "[agent] 2026-10-03T10:00:00.000Z model anthropic/claude-sonnet-4 (thinking: high)",
            "[shell] 2026-10-03T10:00:00.000Z /tmp/openvids untouched",
        ] {
            assert_eq!(redact(line, home), line);
        }
    }

    #[test]
    fn reporter_ids_are_stable_across_reads_and_never_the_installation_id() {
        let dir = temp_dir("reporter-id");
        let first = reporter_id(&dir).unwrap();
        assert!(is_uuid(&first));
        assert_eq!(first.as_bytes()[14], b'4', "{first}");
        assert_eq!(reporter_id(&dir).unwrap(), first);
        // A damaged file is replaced, not trusted.
        std::fs::write(dir.join(REPORTER_ID_FILE), "not a uuid").unwrap();
        let replaced = reporter_id(&dir).unwrap();
        assert!(is_uuid(&replaced) && replaced != first);
        assert!(!dir.join("installation-id").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_draft_validation_matches_the_server_contract() {
        let mut draft = Draft {
            description: "short".into(),
            ..Draft::default()
        };
        assert!(draft.validate().is_err(), "fewer than 10 characters");
        draft.description = "x".repeat(8001);
        assert!(draft.validate().is_err(), "more than 8000 characters");
        draft.description = "This is a real description.".into();
        draft.email = "a".repeat(201);
        assert!(draft.validate().is_err(), "more than 200 email characters");
        draft.email = "user@example.com".into();
        draft.steps = "y".repeat(4001);
        assert!(draft.validate().is_err(), "more than 4000 step characters");
        draft.steps = "Open the app, then close it.".into();
        assert!(draft.validate().is_ok());
    }

    #[test]
    fn the_shell_strings_exist_in_every_catalog() {
        for code in crate::locales::LOCALE_CODES {
            let catalog = crate::locales::locale_json(code).expect("a listed catalog");
            for key in [
                "menu.help.title",
                "menu.help.reportProblem",
                "report.window.title",
                "dialog.reportPick.title",
            ] {
                assert!(
                    catalog.contains(&format!("\"{key}\"")),
                    "{key} is missing from the {code} catalog"
                );
            }
        }
    }

    #[test]
    fn the_base_url_prefers_the_environment_override() {
        // The environment is process-wide; read once and restore.
        let previous = std::env::var("OPENVIDS_REPORTS_URL").ok();
        std::env::set_var("OPENVIDS_REPORTS_URL", "http://127.0.0.1:9/api/reports/");
        assert_eq!(base_url(), "http://127.0.0.1:9/api/reports");
        std::env::set_var("OPENVIDS_REPORTS_URL", "   ");
        assert_eq!(base_url(), DEFAULT_BASE_URL);
        match previous {
            Some(value) => std::env::set_var("OPENVIDS_REPORTS_URL", value),
            None => std::env::remove_var("OPENVIDS_REPORTS_URL"),
        }
    }

    /// A tiny loopback HTTPS-less server: reads one request, hands it to
    /// `answer`, writes the response. Kept alive until the test binary exits
    /// (the same shape telemetry's receiver uses).
    struct Wire {
        url: String,
        requests: std::sync::Arc<Mutex<Vec<(String, Vec<u8>)>>>,
    }

    fn wire(answer: impl Fn(&str, &[u8]) -> (u16, String) + Send + Sync + 'static) -> Wire {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                let end = loop {
                    match std::io::Read::read(&mut stream, &mut buf) {
                        Ok(0) | Err(_) => break None,
                        Ok(n) => {
                            raw.extend_from_slice(&buf[..n]);
                            if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                                break Some(end + 4);
                            }
                        }
                    }
                };
                let Some(end) = end else { continue };
                let head = String::from_utf8_lossy(&raw[..end]).to_string();
                let length = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                let mut body = raw[end..].to_vec();
                while body.len() < length {
                    match std::io::Read::read(&mut stream, &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => body.extend_from_slice(&buf[..n]),
                    }
                }
                let path = head
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                let method = head
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().next())
                    .unwrap_or("GET")
                    .to_string();
                let key = if method == "POST" && path == "/api/reports" {
                    "upload".to_string()
                } else {
                    path.clone()
                };
                seen.lock().unwrap().push((key, body.clone()));
                let (status, payload) = answer(&path, &body);
                let response = format!(
                    "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
                let _ = std::io::Write::flush(&mut stream);
            }
        });
        Wire {
            url: format!("http://127.0.0.1:{port}/api/reports"),
            requests,
        }
    }

    impl Wire {
        fn request(&self, key: &str) -> Option<Vec<u8>> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .find(|(path, _)| path == key)
                .map(|(_, body)| body.clone())
        }
    }

    /// The bytes of one multipart part, located by its `name="…"` header and
    /// ending at the next boundary (a boundary is always the fixed prefix plus
    /// random hex, so image bytes cannot fake one).
    fn multipart_part(body: &[u8], marker: &[u8]) -> Option<Vec<u8>> {
        let find = |haystack: &[u8], needle: &[u8]| {
            haystack
                .windows(needle.len())
                .position(|window| window == needle)
        };
        let name = find(body, marker)?;
        let header_end = find(&body[name..], b"\r\n\r\n")? + name + 4;
        let terminator = find(&body[header_end..], b"\r\n------openvids-")? + header_end;
        Some(body[header_end..terminator].to_vec())
    }

    #[test]
    fn a_submit_walks_status_challenge_pow_and_the_multipart_upload() {
        let wire = wire(|path, _| {
            match path {
            "/api/reports/status" => (200, r#"{"enabled":true}"#.to_string()),
            "/api/reports/challenge" => (
                200,
                r#"{"challengeId":"c-1","salt":"abc","difficulty":8,"expiresAt":"2026-10-03T12:10:00Z"}"#
                    .to_string(),
            ),
            _ => (
                200,
                r#"{"status":"published","reportId":"R-7","issueNumber":12,"issueUrl":"https://github.com/bazodev/open-vids/issues/12"}"#
                    .to_string(),
            ),
        }
        });
        let dir = temp_dir("submit-draft");
        let root = temp_dir("submit-root");
        // A log directory with a line the report must carry (redacted).
        let logs = temp_dir("submit-logs");
        let home = prefs::home_dir().to_string_lossy().into_owned();
        std::fs::write(
            logs.join("openvids.log"),
            format!("[shell] 2026-10-03T10:00:00.000Z started key sk-abcdefghijklmnopqrstuv at {home}/Documents/project\n"),
        )
        .unwrap();
        logfile::init(logs.clone());

        let mut draft = Draft {
            description: "The export button crashed the app.".into(),
            steps: "Open a project and press Export.".into(),
            email: "user@example.com".into(),
            ..Draft::default()
        };
        let image = png(64);
        add_image(&dir, &mut draft, "Screenshot.png", &image).unwrap();
        draft.save(&dir).unwrap();

        let (status, body) = submit_to(&dir, &root, &wire.url, Some("studio"));
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["status"], "published");
        assert_eq!(body["issueNumber"], 12);

        // The challenge carried the reporter id stored in `root`.
        let challenge = String::from_utf8(wire.request("/api/reports/challenge").unwrap()).unwrap();
        let reporter = std::fs::read_to_string(root.join(REPORTER_ID_FILE)).unwrap();
        assert!(is_uuid(reporter.trim()), "{reporter:?}");
        assert!(challenge.contains(reporter.trim()), "{challenge}");

        // The upload is one multipart body: meta JSON, gzipped redacted logs
        // and the screenshot, exactly as the contract pins them.
        let upload = wire
            .request("upload")
            .expect("the upload reached the server");
        let meta: Value = serde_json::from_slice(
            &multipart_part(&upload, b"name=\"meta\"").expect("a meta part"),
        )
        .expect("the meta part parses as JSON");
        assert_eq!(meta["context"], "studio");
        assert_eq!(meta["challengeId"], "c-1");
        assert_eq!(meta["reporterId"], reporter.trim());
        assert_eq!(meta["description"], "The export button crashed the app.");
        assert_eq!(meta["steps"], "Open a project and press Export.");
        assert_eq!(meta["email"], "user@example.com");
        assert_eq!(meta["diagnostics"]["appVersion"], VERSION);
        assert!(meta["diagnostics"]["language"].is_string());
        let nonce = meta["nonce"].as_str().expect("a nonce");
        assert!(nonce.chars().all(|c| c.is_ascii_digit()));
        assert!(hash_meets("abc", nonce, 8), "nonce {nonce} is not valid");

        let gz = multipart_part(&upload, b"filename=\"openvids.log.gz\"").expect("a logs part");
        assert_eq!(&gz[..2], &[0x1f, 0x8b], "gzip magic");
        let mut text = String::new();
        std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(gz.as_slice()), &mut text)
            .expect("the logs part gunzips");
        assert!(text.contains("started key"), "{text}");
        assert!(!text.contains("sk-abcdefghijklmnopqrstuv"), "{text}");
        assert!(text.contains("~/Documents/project"), "{text}");
        assert!(!text.contains(&home), "{text}");

        assert_eq!(
            multipart_part(&upload, b"filename=\"Screenshot.png\"").expect("a screenshot part"),
            image,
            "screenshot bytes survive the framing"
        );

        // Success clears the draft: no screenshots, no image files left.
        let cleared = Draft::load(&dir);
        assert!(cleared.screenshots.is_empty());
        assert_eq!(cleared.description, "");
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            1,
            "only draft.json remains"
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&logs);
    }

    #[test]
    fn a_rate_limited_or_disabled_service_is_reported_without_uploading() {
        let limited = wire(|path, _| match path {
            "/api/reports/status" => (200, r#"{"enabled":true}"#.to_string()),
            _ => (
                429,
                r#"{"error":"rate_limited","retryAfter":42}"#.to_string(),
            ),
        });
        let dir = temp_dir("submit-limited");
        let root = temp_dir("submit-limited-root");
        Draft {
            description: "Something is broken here.".into(),
            ..Draft::default()
        }
        .save(&dir)
        .unwrap();
        let (status, body) = submit_to(&dir, &root, &limited.url, None);
        assert_eq!(status, 429, "{body}");
        assert_eq!(body["error"], "rate_limited");
        assert_eq!(body["retryAfter"], 42);
        assert!(limited.request("upload").is_none(), "nothing was uploaded");
        assert!(Draft::load(&dir).description.starts_with("Something"));

        let disabled = wire(|_, _| (200, r#"{"enabled":false}"#.to_string()));
        let (status, body) = submit_to(&dir, &root, &disabled.url, None);
        assert_eq!(status, 503, "{body}");
        assert_eq!(body["error"], "disabled");
        assert!(disabled.request("upload").is_none());
        // The status check comes before a challenge is asked for.
        assert!(disabled.request("/api/reports/challenge").is_none());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_report_meta_carries_the_contract_fields() {
        let draft = Draft {
            description: "  The app crashed on export.  ".into(),
            steps: "Open a project and export.".into(),
            email: "user@example.com".into(),
            ..Draft::default()
        };
        let meta = report_meta(
            &draft,
            "c-1",
            "12345",
            "0b6a6c4e-2f1d-4b8e-9c3a-5d7e8f9a0b1c",
            "studio",
        );
        assert_eq!(meta["challengeId"], "c-1");
        assert_eq!(meta["nonce"], "12345");
        assert_eq!(meta["description"], "The app crashed on export.");
        assert_eq!(meta["steps"], "Open a project and export.");
        assert_eq!(meta["email"], "user@example.com");
        assert_eq!(meta["context"], "studio");
        assert_eq!(meta["diagnostics"]["appVersion"], VERSION);
        assert!(meta["diagnostics"]["language"].is_string());
        let minimal = report_meta(&Draft::default(), "c", "1", "r", "menu");
        assert!(minimal.get("steps").is_none());
        assert!(minimal.get("email").is_none());
    }
}
