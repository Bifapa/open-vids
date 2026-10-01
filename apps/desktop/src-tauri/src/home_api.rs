//! The Projects page's API beyond open/create/rename/trash (those live in
//! `home_routes`, `home_create`, `home_project`): preferences, project
//! metadata, duplicate / reveal / locate, recents undo, files for the start
//! composer (native picker, OS drops, metadata), the start-from-chat create,
//! and the agent-runtime proxy. Every route here sits under `/api/`, so the
//! per-launch token guards all of them (`home_auth::requires_token`).

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::home_routes::{begin_open, respond, thumb_name_for, HomeInner};
use super::recents::RecentEntry;
use super::structure::validate_structure;
use super::{intake, prefs, project_meta};

pub fn respond_json(stream: &mut TcpStream, code: u16, value: &Value) {
    respond(stream, code, "application/json", value.to_string().as_bytes());
}

fn error(stream: &mut TcpStream, code: u16, message: impl Into<String>) {
    respond_json(stream, code, &json!({ "error": message.into() }));
}

fn body_json(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

// ── Recents ─────────────────────────────────────────────────────────────────

/// One recent as the page renders it, with on-disk metadata.
pub fn recent_json(entry: &RecentEntry) -> Value {
    let missing = !entry.dir.is_dir();
    let meta = if missing {
        None
    } else {
        project_meta::for_project(&entry.dir)
    };
    json!({
        "id": entry.id,
        "name": entry.id,
        "dir": entry.dir.to_string_lossy(),
        "path": prefs::abbreviate_home(&entry.dir),
        "last_opened": entry.last_opened,
        "thumb": entry.thumb,
        "width": entry.width,
        "height": entry.height,
        "missing": missing,
        "duration": meta.map(|m| m.duration),
        "clips": meta.map(|m| m.clips),
    })
}

pub fn serve_recents(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>) {
    let entries: Option<Vec<RecentEntry>> = state.lock().ok().map(|i| i.recents.entries().to_vec());
    match entries {
        Some(entries) => {
            let recents: Vec<Value> = entries.iter().map(recent_json).collect();
            respond_json(stream, 200, &json!({ "recents": recents }));
        }
        None => error(stream, 500, "state poisoned"),
    }
}

/// `POST /api/remove {id}` → `{ok, index, entry}`; the page keeps the entry
/// for Undo (`POST /api/recents/restore {entry}`).
pub fn handle_remove(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let id = str_field(&body_json(body), "id").unwrap_or_default().to_string();
    let taken = state.lock().ok().and_then(|mut i| i.recents.take(&id));
    match taken {
        Some((index, entry)) => respond_json(
            stream,
            200,
            &json!({ "ok": true, "index": index, "entry": entry }),
        ),
        None => error(stream, 404, "unknown project"),
    }
}

pub fn handle_restore(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let entry = body_json(body)
        .get("entry")
        .cloned()
        .and_then(|v| serde_json::from_value::<RecentEntry>(v).ok());
    match (entry, state.lock()) {
        (Some(entry), Ok(mut inner)) => {
            inner.recents.restore(entry);
            respond_json(stream, 200, &json!({ "ok": true }));
        }
        _ => error(stream, 400, "nothing to restore"),
    }
}

fn find(state: &Arc<Mutex<HomeInner>>, id: &str) -> Option<RecentEntry> {
    state
        .lock()
        .ok()
        .and_then(|inner| inner.recents.find_by_id(id).cloned())
}

/// `POST /api/reveal {id}` — show the folder in Finder.
pub fn handle_reveal(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let id = str_field(&body_json(body), "id").unwrap_or_default().to_string();
    let Some(entry) = find(state, &id) else {
        return error(stream, 404, "unknown project");
    };
    if !entry.dir.exists() {
        return error(stream, 410, format!("{} no longer exists", entry.dir.display()));
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&entry.dir)
        .status();
    #[cfg(not(target_os = "macos"))]
    let result = std::process::Command::new("xdg-open")
        .arg(entry.dir.parent().unwrap_or(&entry.dir))
        .status();
    match result {
        Ok(status) if status.success() => respond_json(stream, 200, &json!({ "ok": true })),
        Ok(status) => error(stream, 500, format!("Finder could not reveal the folder ({status})")),
        Err(err) => error(stream, 500, format!("Finder could not reveal the folder: {err}")),
    }
}

// ── External links ───────────────────────────────────────────────────────────

/// Longest address the page may ask to open.
const MAX_EXTERNAL_URL_LEN: usize = 4096;

/// The one kind of address `POST /api/open-external` opens: a plain `https://`
/// URL with a host and no embedded credentials. The webview has no IPC and a
/// link or `window.open` from the loopback page never reaches the default
/// browser, so the page asks the shell; everything else (`file:`, `javascript:`,
/// `http:`, custom schemes, `-flag` lookalikes) is refused here.
pub fn parse_external_url(raw: &str) -> Result<url::Url, &'static str> {
    if raw.is_empty() || raw.len() > MAX_EXTERNAL_URL_LEN || raw.chars().any(char::is_control) {
        return Err("not a valid address");
    }
    let parsed = url::Url::parse(raw).map_err(|_| "not a valid address")?;
    if parsed.scheme() != "https" {
        return Err("only https addresses can be opened");
    }
    if parsed.host_str().map_or(true, str::is_empty) {
        return Err("the address has no host");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("the address must not carry credentials");
    }
    Ok(parsed)
}

/// `POST /api/open-external {url}` → open an `https://` URL in the user's
/// default browser. The URL is passed as one argument to `open` / `xdg-open`
/// (no shell), in its normalised serialisation.
/// Hand a checked address ([`parse_external_url`]) to the default browser.
pub fn open_external(url: &url::Url) -> std::io::Result<std::process::ExitStatus> {
    #[cfg(target_os = "macos")]
    let opener = "/usr/bin/open";
    #[cfg(not(target_os = "macos"))]
    let opener = "xdg-open";
    std::process::Command::new(opener).arg(url.as_str()).status()
}

pub fn handle_open_external(stream: &mut TcpStream, body: &[u8]) {
    let raw = str_field(&body_json(body), "url").unwrap_or_default().to_string();
    let url = match parse_external_url(&raw) {
        Ok(url) => url,
        Err(why) => return error(stream, 400, why),
    };
    match open_external(&url) {
        Ok(status) if status.success() => respond_json(stream, 200, &json!({ "ok": true })),
        Ok(status) => error(stream, 500, format!("The browser could not be opened ({status})")),
        Err(err) => error(stream, 500, format!("The browser could not be opened: {err}")),
    }
}

/// Names a duplicate may take: `X copy`, `X copy 2`, … (Finder's pattern).
fn duplicate_name(name: &str, parent: &Path) -> String {
    intake::unique_name(&format!("{name} copy"), |n| parent.join(n).exists())
}

/// Directories and files a duplicate leaves out: rendered output, caches
/// rebuilt on demand, and the one-shot intake hand-off.
fn skip_in_duplicate(rel: &Path) -> bool {
    let first = rel.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned());
    matches!(first.as_deref(), Some("renders") | Some(".transcode-cache"))
        || rel == Path::new(".hyperframes/agent/intake.json")
}

fn copy_tree(from: &Path, to: &Path, root: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let rel = src.strip_prefix(root).unwrap_or(&src);
        if skip_in_duplicate(rel) {
            continue;
        }
        let dst = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(std::fs::read_link(&src)?, &dst)?;
        } else if kind.is_dir() {
            copy_tree(&src, &dst, root)?;
        } else {
            // Clones on APFS (copy-on-write): duplicating GBs of footage is instant.
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

fn set_meta_name(dir: &Path, name: &str) {
    let path = dir.join("meta.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    if let Some(map) = value.as_object_mut() {
        map.insert("id".into(), json!(name));
        map.insert("name".into(), json!(name));
        if let Ok(out) = serde_json::to_string_pretty(&value) {
            let _ = std::fs::write(path, format!("{out}\n"));
        }
    }
}

/// `POST /api/duplicate {id}` → the new recent (opened "now", so it leads).
pub fn handle_duplicate(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let id = str_field(&body_json(body), "id").unwrap_or_default().to_string();
    let Some(entry) = find(state, &id) else {
        return error(stream, 404, "unknown project");
    };
    if !entry.dir.is_dir() {
        return error(stream, 410, format!("{} no longer exists", entry.dir.display()));
    }
    let Some(parent) = entry.dir.parent().map(Path::to_path_buf) else {
        return error(stream, 400, "the project has no parent folder");
    };
    let name = duplicate_name(&entry.id, &parent);
    let dest = parent.join(&name);
    if let Err(err) = copy_tree(&entry.dir, &dest, &entry.dir) {
        let _ = std::fs::remove_dir_all(&dest);
        return error(stream, 500, format!("could not duplicate the project: {err}"));
    }
    set_meta_name(&dest, &name);
    let recorded = state.lock().ok().map(|mut inner| {
        inner.recents.record(&name, &dest, entry.width, entry.height);
        if let Some(thumb) = &entry.thumb {
            let ext = Path::new(thumb)
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_else(|| "jpg".into());
            let new_thumb = thumb_name_for(&dest, &ext);
            if std::fs::copy(inner.thumbs_dir.join(thumb), inner.thumbs_dir.join(&new_thumb)).is_ok() {
                inner.recents.update_meta(&dest, Some(new_thumb), None, None);
            }
        }
        inner.recents.find_by_id(&name).cloned()
    });
    match recorded.flatten() {
        Some(entry) => respond_json(stream, 200, &json!({ "ok": true, "project": recent_json(&entry) })),
        None => error(stream, 500, "the duplicate was created but could not be listed"),
    }
}

/// `POST /api/locate {id}` — native folder picker, then re-link the recent.
pub fn handle_locate(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let id = str_field(&body_json(body), "id").unwrap_or_default().to_string();
    let Some(entry) = find(state, &id) else {
        return error(stream, 404, "unknown project");
    };
    let mut dialog = rfd::FileDialog::new().set_title(format!("Locate “{}”", entry.id));
    if let Some(parent) = entry.dir.ancestors().skip(1).find(|p| p.is_dir()) {
        dialog = dialog.set_directory(parent);
    }
    let Some(picked) = dialog.pick_folder() else {
        return respond_json(stream, 200, &json!({ "cancelled": true }));
    };
    let project = match validate_structure(&picked) {
        Ok(project) => project,
        Err(err) => return error(stream, 400, not_a_project_message(&picked, &err.to_string())),
    };
    let relinked = state.lock().ok().map(|mut inner| {
        inner.recents.relink(&id, &project.id, &project.dir);
        inner.recents.find_by_id(&project.id).cloned()
    });
    match relinked.flatten() {
        Some(entry) => respond_json(stream, 200, &json!({ "ok": true, "project": recent_json(&entry) })),
        None => error(stream, 500, "could not update recents"),
    }
}

pub fn not_a_project_message(dir: &Path, detail: &str) -> String {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.display().to_string());
    if detail.contains("index.html") || detail.contains("composition") {
        format!("Not an OpenVids project — index.html with data-composition-id is missing in {name}.")
    } else {
        format!("{name} can’t be opened: {detail}")
    }
}

// ── Preferences ─────────────────────────────────────────────────────────────

pub fn serve_prefs(stream: &mut TcpStream) {
    respond_json(stream, 200, &prefs::load(&prefs::prefs_path()));
}

pub fn handle_prefs_update(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let patch = body_json(body);
    match prefs::update(&prefs::prefs_path(), &patch) {
        Ok(next) => {
            let listener = state.lock().ok().and_then(|i| i.prefs_listener.clone());
            if let Some(listener) = listener {
                listener(&next);
            }
            respond_json(stream, 200, &next);
        }
        Err(err) => error(stream, 400, format!("could not save preferences: {err}")),
    }
}

/// `GET /api/locations` — where new projects can go: the default location,
/// the usual folders, and the parents of recent projects.
pub fn serve_locations(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>) {
    let p = prefs::load(&prefs::prefs_path());
    let default = prefs::new_project(&p).location;
    let home = prefs::home_dir();
    let mut dirs: Vec<PathBuf> = vec![default.clone(), home.join("Desktop"), home.join("Documents")];
    if let Ok(inner) = state.lock() {
        for entry in inner.recents.entries() {
            if let Some(parent) = entry.dir.parent() {
                if parent.is_dir() && !dirs.iter().any(|d| d == parent) && dirs.len() < 6 {
                    dirs.push(parent.to_path_buf());
                }
            }
        }
    }
    let list: Vec<Value> = dirs
        .iter()
        .filter(|d| *d == &default || d.is_dir())
        .map(|d| json!({ "dir": d.to_string_lossy(), "path": prefs::abbreviate_home(d) }))
        .collect();
    respond_json(
        stream,
        200,
        &json!({ "locations": list, "default": default.to_string_lossy(), "home": home.to_string_lossy() }),
    );
}

/// `POST /api/name-status {parent, name}` — whether the New Project sheet's
/// folder already exists with content (inline validation).
pub fn handle_name_status(stream: &mut TcpStream, body: &[u8]) {
    let value = body_json(body);
    let parent = str_field(&value, "parent").map(prefs::expand_tilde);
    let name = str_field(&value, "name").unwrap_or_default();
    let exists = parent
        .map(|p| p.join(name))
        .filter(|_| super::project::is_valid_project_id(name))
        .map(|dest| {
            std::fs::read_dir(&dest)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(dest.exists())
        })
        .unwrap_or(false);
    respond_json(stream, 200, &json!({ "exists": exists }));
}

// ── Files for the start composer ────────────────────────────────────────────

fn ffprobe() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    dirs.into_iter().map(|d| d.join("ffprobe")).find(|p| p.is_file())
}

/// Media duration in seconds via ffprobe, best-effort (missing tool → None).
fn probe_duration(path: &Path) -> Option<f64> {
    let tool = ffprobe()?;
    let mut child = std::process::Command::new(tool)
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(30))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    use std::io::Read;
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    out.trim().parse::<f64>().ok().filter(|d| d.is_finite() && *d > 0.0)
}

/// `{path, name, size, kind, duration?}` for regular files; folders and
/// unreadable paths are reported by name in `skipped`.
fn describe(paths: &[PathBuf]) -> Value {
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    for path in paths {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() && path.is_absolute() => {
                let kind = intake::chip_kind(&name);
                let duration = if kind == "video" || kind == "audio" {
                    probe_duration(path)
                } else {
                    None
                };
                files.push(json!({
                    "path": path.to_string_lossy(),
                    "name": name,
                    "size": meta.len(),
                    "kind": kind,
                    "duration": duration,
                }));
            }
            _ => skipped.push(name),
        }
    }
    json!({ "files": files, "skipped": skipped })
}

/// `POST /api/files/pick` — the native multi-file picker.
pub fn handle_pick_files(stream: &mut TcpStream) {
    match rfd::FileDialog::new()
        .set_title("Add Files to the New Project")
        .pick_files()
    {
        None => respond_json(stream, 200, &json!({ "cancelled": true, "files": [], "skipped": [] })),
        Some(paths) => respond_json(stream, 200, &describe(&paths)),
    }
}

/// `POST /api/files/dropped {names}` — the real paths of an OS file drop,
/// read from the drag pasteboard (see `drop_paths`).
pub fn handle_dropped(stream: &mut TcpStream, body: &[u8]) {
    let names: Vec<String> = body_json(body)
        .get("names")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let paths = super::drop_paths::match_dropped(&names, super::drop_paths::drag_pasteboard_paths());
    let mut out = describe(&paths);
    let found: Vec<String> = paths
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    let unresolved: Vec<&String> = names.iter().filter(|n| !found.contains(n)).collect();
    out["unresolved"] = json!(unresolved);
    respond_json(stream, 200, &out);
}

// ── Start a new project from the composer ───────────────────────────────────

fn start_location(value: &Value) -> PathBuf {
    str_field(value, "location")
        .filter(|s| !s.trim().is_empty())
        .map(prefs::expand_tilde)
        .unwrap_or_else(|| prefs::new_project(&prefs::load(&prefs::prefs_path())).location)
}

fn file_names(value: &Value) -> Vec<String> {
    value
        .get("files")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|f| f.as_str().or_else(|| str_field(f, "name")).or_else(|| str_field(f, "path")))
                .map(|s| {
                    Path::new(s)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn taken_in(state: &Arc<Mutex<HomeInner>>, parent: &Path) -> impl Fn(&str) -> bool {
    let recent_dirs: Vec<PathBuf> = state
        .lock()
        .ok()
        .map(|i| i.recents.entries().iter().map(|e| e.dir.clone()).collect())
        .unwrap_or_default();
    let canonical_parent = parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf());
    let parent = parent.to_path_buf();
    move |name: &str| {
        parent.join(name).exists()
            || recent_dirs
                .iter()
                .any(|d| d == &canonical_parent.join(name) || d == &parent.join(name))
    }
}

/// `POST /api/start/name {prompt, files, location}` → the folder Start would create.
pub fn handle_start_name(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let value = body_json(body);
    let location = start_location(&value);
    let base = intake::derive_name(str_field(&value, "prompt").unwrap_or(""), &file_names(&value));
    let name = intake::unique_name(&base, taken_in(state, &location));
    let dir = location.join(&name);
    respond_json(
        stream,
        200,
        &json!({ "name": name, "dir": dir.to_string_lossy(), "path": prefs::abbreviate_home(&dir) }),
    );
}

const INTENTS: [&str; 3] = ["plan", "edit", "ask"];

/// `POST /api/start` — create the project, import the files, write the intake
/// and open it in the Media workspace.
pub fn handle_start(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let value = body_json(body);
    let prompt = str_field(&value, "prompt").unwrap_or("").trim().to_string();
    let sources: Vec<PathBuf> = value
        .get("files")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(PathBuf::from).collect())
        .unwrap_or_default();
    if prompt.is_empty() && sources.is_empty() {
        return error(stream, 400, "Describe the video or add files first.");
    }
    if let Some(bad) = sources.iter().find(|p| !p.is_absolute() || !p.is_file()) {
        return error(stream, 400, format!("{} is not a readable file", bad.display()));
    }
    let intent = str_field(&value, "intent")
        .filter(|i| INTENTS.contains(i))
        .unwrap_or("edit");
    let width = value.get("width").and_then(Value::as_u64).unwrap_or(1920) as u32;
    let height = value.get("height").and_then(Value::as_u64).unwrap_or(1080) as u32;
    let location = start_location(&value);
    if let Err(err) = std::fs::create_dir_all(&location) {
        return error(stream, 400, format!("could not use {}: {err}", location.display()));
    }
    let base = intake::derive_name(&prompt, &file_names(&value));
    let name = intake::unique_name(&base, taken_in(state, &location));
    let p = prefs::load(&prefs::prefs_path());
    let params = super::create::CreateParams {
        parent: location.clone(),
        name: name.clone(),
        fps: prefs::new_project(&p).fps.to_string(),
        width,
        height,
        duration: 10.0,
    };
    let dest = match super::home_create::scaffold_blank(&params) {
        Ok(dest) => dest,
        Err(err) => return error(stream, 400, err),
    };
    let imported = match intake::import_files(&dest, &sources) {
        Ok(imported) => imported,
        Err(err) => return error(stream, 500, err),
    };
    let files: Vec<Value> = imported
        .iter()
        .map(|f| json!({ "path": f.rel_path, "name": f.name, "size": f.size, "kind": f.kind }))
        .collect();
    let agents: Vec<Value> = value
        .get("agents")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|v| v.as_str().map(|s| SPECIALISTS.contains(&s)).unwrap_or(false))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let mut document = json!({
        "version": 1,
        "prompt": prompt,
        "intent": intent,
        "model": value.get("model").filter(|m| m.get("provider").is_some() && m.get("modelId").is_some()).cloned().unwrap_or(Value::Null),
        "thinking": value.get("thinking").filter(|t| t.is_string()).cloned().unwrap_or(Value::Null),
        "agents": agents,
        "files": files,
        "createdAt": super::create::now_iso(),
    });
    if let Some(overrides) = value.get("agentOverrides").filter(|v| v.is_object()) {
        document["agentOverrides"] = overrides.clone();
    }
    if let Err(err) = intake::write_intake(&dest, &document) {
        return error(stream, 500, format!("could not write the intake: {err}"));
    }
    let id = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(name.clone());
    begin_open(state, id, dest.clone(), Some("media".to_string()));
    respond_json(
        stream,
        200,
        &json!({ "opening": true, "name": name, "dir": dest.to_string_lossy(), "path": prefs::abbreviate_home(&dest) }),
    );
}

pub const SPECIALISTS: [&str; 5] = ["editor", "vision", "motion", "research", "audio"];

// ── Agent runtime proxy ─────────────────────────────────────────────────────

pub fn proxy_agent(stream: &mut TcpStream, method: &str, runtime_path: &str, body: Option<&[u8]>) {
    match super::agent_proxy::forward(method, runtime_path, body) {
        Ok((status, payload)) => respond(stream, status, "application/json", &payload),
        Err(message) => error(stream, 503, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_https_addresses_are_opened() {
        for ok in [
            "https://claude.ai/oauth/authorize?client_id=x&state=y",
            "https://github.com/login/device",
            "HTTPS://Example.com/a b",
            "https://localhost:1455/auth",
        ] {
            let url = parse_external_url(ok).expect(ok);
            assert_eq!(url.scheme(), "https", "{ok}");
        }
        for bad in [
            "",
            "http://example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "ftp://example.com",
            "vscode://open",
            "-a Calculator",
            "--help",
            "example.com",
            "//example.com",
            "https://",
            "https://user:pw@example.com",
            "https://user@example.com",
            "https://exa\nmple.com",
            "https://example.com/\u{0}",
        ] {
            assert!(parse_external_url(bad).is_err(), "{bad:?}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_EXTERNAL_URL_LEN));
        assert!(parse_external_url(&long).is_err());
    }

    #[test]
    fn the_opened_address_is_the_normalised_https_url() {
        let url = parse_external_url("https://Example.com/a b?x=1").unwrap();
        assert!(url.as_str().starts_with("https://example.com/"));
        assert!(!url.as_str().starts_with('-'));
    }

    #[test]
    fn duplicate_names_follow_finder() {
        let base = std::env::temp_dir().join(format!("openvids-dup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("Talk copy")).unwrap();
        assert_eq!(duplicate_name("Talk", &base), "Talk copy 2");
        assert_eq!(duplicate_name("Other", &base), "Other copy");
    }

    #[test]
    fn duplicate_skips_renders_caches_and_the_intake() {
        let base = std::env::temp_dir().join(format!("openvids-dup-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("p");
        std::fs::create_dir_all(src.join("renders")).unwrap();
        std::fs::create_dir_all(src.join("assets")).unwrap();
        std::fs::create_dir_all(src.join(".hyperframes/agent")).unwrap();
        std::fs::write(src.join("index.html"), "x").unwrap();
        std::fs::write(src.join("assets/a.mov"), "m").unwrap();
        std::fs::write(src.join("renders/out.mp4"), "r").unwrap();
        std::fs::write(src.join(".hyperframes/agent/intake.json"), "{}").unwrap();
        std::fs::write(src.join(".hyperframes/agent/chats.json"), "{}").unwrap();
        let dst = base.join("p copy");
        copy_tree(&src, &dst, &src).unwrap();
        assert!(dst.join("index.html").is_file());
        assert!(dst.join("assets/a.mov").is_file());
        assert!(dst.join(".hyperframes/agent/chats.json").is_file());
        assert!(!dst.join("renders").exists());
        assert!(!dst.join(".hyperframes/agent/intake.json").exists());
    }

    #[test]
    fn not_a_project_message_matches_the_prototype_wording() {
        assert_eq!(
            not_a_project_message(Path::new("/x/Footage Dump"), "no index.html found"),
            "Not an OpenVids project — index.html with data-composition-id is missing in Footage Dump."
        );
    }
}
