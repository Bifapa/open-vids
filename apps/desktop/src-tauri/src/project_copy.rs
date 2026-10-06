//! Copying a project folder: what Duplicate and Fork share.
//!
//! - The copy is built in a temporary sibling folder (`.openvids-fork-<16 hex>`, marked with the pid of the process
//!   building it) and renamed to its final name as the last step, so the Projects page never lists a half-copied
//!   project and a crash leaves only that folder behind. `sweep_leftovers` removes such folders at the next start.
//! - The final name is claimed by the rename itself (`rename_noreplace` refuses an existing target), so two copies
//!   racing for `X fork` never share a name.
//! - Derived state is not copied (`is_excluded`): renders, caches, locks, the usage journal, the project history
//!   id and the agent's one-shot files. The user's own material is: assets, design snapshot, story, provenance,
//!   analysis, accepted QA findings and the chats.
//! - Chats are copied together with `.hyperframes/agent/fork.json` (`{ "forkedAt": <epoch ms> }`): the agent runtime
//!   hides "Revert this turn" for turns older than it, because their history entries stay in the original's
//!   history (the copy gets a history of its own, empty).
//! - Lineage lives in `meta.json`: a stable `uid` (given to a project lazily, when it is first forked) and, on a
//!   fork, `forkedFrom: { uid, name, dir, at }`. Every copy gets a new `uid`, a fresh `createdAt` and its own name.
//! - `prepared-assets` is excluded: it holds animated GIFs re-encoded to WebM (named by a hash of the GIF and the
//!   loop settings) and downloaded remote GIFs. Only the in-memory preview/render HTML refers to them
//!   (`prepareAnimatedGifInputs` rewrites `<img src="x.gif">` there); the project's own HTML keeps the GIF, so
//!   they are rebuilt on demand.

use std::path::{Path, PathBuf};
use std::time::Duration;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::{json, Map, Value};

use super::intake;
use super::updater::Activity;

/// What is being made: a plain copy, or a fork that records where it came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Duplicate,
    Fork,
}

impl Kind {
    /// Finder's pattern: `X copy`, `X copy 2`, … and `X fork`, `X fork 2`, …
    fn suffix(self) -> &'static str {
        match self {
            Kind::Duplicate => "copy",
            Kind::Fork => "fork",
        }
    }
}

/// Bytes copied so far and expected, and the request to stop. Shared between the copying thread and whoever
/// reports it.
#[derive(Debug, Default)]
pub struct Progress {
    done: AtomicU64,
    total: AtomicU64,
    cancel: AtomicBool,
}

impl Progress {
    pub fn snapshot(&self) -> (u64, u64) {
        (self.done.load(Ordering::Relaxed), self.total.load(Ordering::Relaxed))
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

#[derive(Debug)]
pub enum CopyError {
    Cancelled,
    Io(std::io::Error),
}

impl std::fmt::Display for CopyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => f.write_str("cancelled"),
            Self::Io(err) => err.fmt(f),
        }
    }
}

impl From<std::io::Error> for CopyError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

/// A finished copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Copied {
    pub name: String,
    pub dir: PathBuf,
    pub uid: String,
}

// ── What is left out ────────────────────────────────────────────────────────

/// Name of the folder a copy is built in; the 16 hex digits are random.
const TEMP_PREFIX: &str = ".openvids-fork-";
/// Inside the temporary folder, from its creation until the rename has published it: who is building it (pid and
/// start). It is removed from the final folder afterwards; one a crash left there is never copied (`is_excluded`).
const TEMP_MARKER: &str = ".openvids-fork.json";
/// A temporary folder without a marker is younger than the copier's first write or a crash cut it short; it is swept
/// only once it is this old, so a copy that is just starting (here or in another OpenVids process) is never taken.
const MARKERLESS_GRACE: Duration = Duration::from_secs(10 * 60);
/// The fork marker the agent runtime reads (`packages/agent-runtime/src/store/forkMarker.ts`).
const FORK_MARKER: &str = ".hyperframes/agent/fork.json";

/// Whether `rel` (relative to the project root) is derived state a copy leaves out.
pub fn is_excluded(rel: &Path) -> bool {
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let Some(name) = parts.last() else {
        return false;
    };
    if parts.len() == 1 && name == TEMP_MARKER {
        return true;
    }
    // Rendered output and the transcode cache sit at the root; the render engine's scratch and locks anywhere.
    if matches!(parts[0].as_str(), "renders" | ".transcode-cache")
        || name.ends_with(".lock.os")
        || (name.starts_with('.') && name.contains(".hf-transaction-"))
    {
        return true;
    }
    let joined = parts.join("/");
    if matches!(
        joined.as_str(),
        ".hyperframes/agent/intake.json"
            | ".hyperframes/agent/usage.jsonl"
            | ".hyperframes/history-id"
            | ".hyperframes/history-turn.json"
            | ".hyperframes/history-turns.json"
            | ".hyperframes/research/cache"
            | ".hyperframes/qa/frames"
            | ".hyperframes/qa/reports"
            | ".hyperframes/preview"
            | ".hyperframes/backup"
            | ".hyperframes/prepared-assets"
    ) {
        return true;
    }
    // The agent's ownership lease and its claim/evict files.
    parts.len() == 3 && parts[0] == ".hyperframes" && parts[1] == "agent" && name.starts_with("owner.pid")
}

/// One entry of the tree being walked.
enum Item {
    Dir,
    File(u64),
    Symlink,
}

/// Walk `from` (a folder inside the project at `root`), calling `f` for every kept entry before its children.
/// Unix keeps a symlink as a link. On Windows every symlink, junction and other reparse point is left out: such an
/// entry can point anywhere (a junction to an ancestor makes the walk cycle; one to another folder would copy that
/// folder's files into the copy), so none is followed, resolved or materialized — the copy holds only what
/// physically lives in the project.
fn walk(
    from: &Path,
    root: &Path,
    f: &mut dyn FnMut(&Path, &Path, Item) -> std::io::Result<()>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let rel = src.strip_prefix(root).unwrap_or(&src).to_path_buf();
        if is_excluded(&rel) {
            continue;
        }
        let kind = entry.file_type()?;
        // `DirEntry::metadata` does not follow links on Windows, so this sees the entry itself.
        #[cfg(windows)]
        if crate::platform::is_link_like(&entry.metadata()?) {
            continue;
        }
        if kind.is_symlink() {
            f(&src, &rel, Item::Symlink)?;
        } else if kind.is_dir() {
            f(&src, &rel, Item::Dir)?;
            walk(&src, root, f)?;
        } else {
            f(&src, &rel, Item::File(entry.metadata()?.len()))?;
        }
    }
    Ok(())
}

/// The bytes of the files a copy of `root` would write.
fn measure(root: &Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    walk(root, root, &mut |_, _, item| {
        if let Item::File(len) = item {
            total += len;
        }
        Ok(())
    })?;
    Ok(total)
}

/// Copy the project at `root` into `to` (created). Stops with `Interrupted` once `progress` is cancelled.
fn copy_tree(root: &Path, to: &Path, progress: &Progress) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    walk(root, root, &mut |src, rel, item| {
        if progress.cancelled() {
            return Err(std::io::ErrorKind::Interrupted.into());
        }
        let dst = to.join(rel);
        match item {
            Item::Dir => std::fs::create_dir_all(&dst)?,
            Item::Symlink => copy_symlink(src, &dst)?,
            Item::File(len) => {
                // Clones on APFS (copy-on-write): copying GBs of footage is instant.
                std::fs::copy(src, &dst)?;
                progress.done.fetch_add(len, Ordering::Relaxed);
            }
        }
        Ok(())
    })
}

/// Copy one symlink entry of a copied project as a link (Unix; Windows never reaches this).
fn copy_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(std::fs::read_link(src)?, dst)
    }
    #[cfg(not(unix))]
    {
        let _ = (src, dst);
        Ok(())
    }
}

// ── meta.json: identity and lineage ─────────────────────────────────────────

fn read_json_object(path: &Path) -> Option<Map<String, Value>> {
    match serde_json::from_slice::<Value>(&std::fs::read(path).ok()?).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Through a temporary file and a rename, so a reader or a crash never sees half of it.
fn write_json_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    let draft = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&draft, format!("{text}\n"))?;
    std::fs::rename(&draft, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&draft);
    })
}

/// A random UUID (v4 layout).
fn new_uid() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes = (nanos ^ (u128::from(std::process::id()) << 96)).to_le_bytes();
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

fn folder_name(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The project's `uid`, minted and saved on first use. A `meta.json` that cannot be read as an object is never
/// overwritten: the project then has no uid (`None`) and a fork of it records no `forkedFrom.uid`.
pub fn ensure_uid(dir: &Path) -> std::io::Result<Option<String>> {
    let path = dir.join("meta.json");
    if !path.exists() {
        let uid = new_uid();
        let name = folder_name(dir);
        write_json_atomic(&path, &json!({ "id": name, "name": name, "uid": uid }))?;
        return Ok(Some(uid));
    }
    let Some(mut map) = read_json_object(&path) else {
        return Ok(None);
    };
    if let Some(uid) = map.get("uid").and_then(Value::as_str).filter(|u| !u.is_empty()) {
        return Ok(Some(uid.to_string()));
    }
    let uid = new_uid();
    map.insert("uid".into(), json!(uid));
    write_json_atomic(&path, &Value::Object(map))?;
    Ok(Some(uid))
}

/// Where a fork came from, as written into its `meta.json`.
#[derive(Debug, Clone)]
struct Origin {
    uid: Option<String>,
    name: String,
    dir: String,
}

/// Give the copy in `dir` its own identity: name, `uid`, `createdAt`, lineage and `package.json` name.
/// Safe to repeat (the name may change when a racing copy took it).
fn stamp(dir: &Path, name: &str, uid: &str, origin: Option<&Origin>) -> std::io::Result<()> {
    let now = super::create::now_iso();
    let path = dir.join("meta.json");
    // A copy whose meta.json is missing or unreadable gets a fresh one: the copy is ours to write.
    let mut map = read_json_object(&path).unwrap_or_default();
    map.insert("id".into(), json!(name));
    map.insert("name".into(), json!(name));
    map.insert("uid".into(), json!(uid));
    map.insert("createdAt".into(), json!(now));
    match origin {
        Some(origin) => {
            map.insert(
                "forkedFrom".into(),
                json!({ "uid": origin.uid, "name": origin.name, "dir": origin.dir, "at": now }),
            );
        }
        None => {
            map.remove("forkedFrom");
        }
    }
    write_json_atomic(&path, &Value::Object(map))?;
    let package = dir.join("package.json");
    if let Some(mut map) = read_json_object(&package) {
        if map.get("name").is_some_and(Value::is_string) {
            map.insert("name".into(), json!(super::create::to_package_name(name)));
            write_json_atomic(&package, &Value::Object(map))?;
        }
    }
    Ok(())
}

/// The name of the project this one was forked from, for the card's "Fork of X" label.
pub fn forked_from_name(dir: &Path) -> Option<String> {
    let map = read_json_object(&dir.join("meta.json"))?;
    let name = map.get("forkedFrom")?.get("name")?.as_str()?;
    (!name.is_empty()).then(|| name.to_string())
}

fn write_fork_marker(dir: &Path) -> std::io::Result<()> {
    let path = dir.join(FORK_MARKER);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    write_json_atomic(&path, &json!({ "forkedAt": at }))
}

// ── Building the copy ───────────────────────────────────────────────────────

fn temp_name() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        bytes = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
            .to_le_bytes();
    }
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{TEMP_PREFIX}{hex}")
}

fn is_temp_name(name: &str) -> bool {
    name.strip_prefix(TEMP_PREFIX)
        .is_some_and(|rest| rest.len() == 16 && rest.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Rename `from` to `to` unless `to` exists (`AlreadyExists`): the rename itself is the claim on the name.
#[cfg(target_os = "macos")]
fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(std::io::Error::other);
    let (from, to) = (c(from)?, c(to)?);
    // SAFETY: both are valid NUL-terminated paths that outlive the call.
    let rc = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Windows refuses to rename a folder onto an existing one; elsewhere the check is all there is.
#[cfg(not(target_os = "macos"))]
fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    if to.exists() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    std::fs::rename(from, to)
}

/// `X copy`, `X copy 2`, … / `X fork`, … : the first name nothing in `parent` has.
fn free_name(name: &str, kind: Kind, parent: &Path) -> String {
    intake::unique_name(&format!("{name} {}", kind.suffix()), |n| parent.join(n).exists())
}

/// Copy the project at `src` next to itself as a duplicate or a fork. Blocking; `progress` reports it and can stop
/// it. On any failure or cancel nothing is left behind except what a crash could (see `sweep_leftovers`).
pub fn copy_project(src: &Path, kind: Kind, progress: &Progress) -> Result<Copied, CopyError> {
    let parent = src
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "the project has no parent folder"))?;
    let source_name = folder_name(src);
    let origin = match kind {
        Kind::Fork => Some(Origin {
            uid: ensure_uid(src)?,
            name: source_name.clone(),
            dir: src.to_string_lossy().into_owned(),
        }),
        Kind::Duplicate => None,
    };
    let total = measure(src)?;
    progress.total.store(total, Ordering::Relaxed);
    progress.done.store(0, Ordering::Relaxed);

    let temp = parent.join(temp_name());
    std::fs::create_dir(&temp)?;
    let built = build(src, &temp, parent, &source_name, kind, origin.as_ref(), progress);
    if built.is_err() {
        let _ = std::fs::remove_dir_all(&temp);
    }
    built
}

fn build(
    src: &Path,
    temp: &Path,
    parent: &Path,
    source_name: &str,
    kind: Kind,
    origin: Option<&Origin>,
    progress: &Progress,
) -> Result<Copied, CopyError> {
    std::fs::write(
        temp.join(TEMP_MARKER),
        json!({
            "pid": std::process::id(),
            "start": super::proc::start_key(std::process::id()),
            "source": src.to_string_lossy(),
        })
        .to_string(),
    )?;
    copy_tree(src, temp, progress).map_err(|err| {
        if progress.cancelled() {
            CopyError::Cancelled
        } else {
            CopyError::Io(err)
        }
    })?;
    if progress.cancelled() {
        return Err(CopyError::Cancelled);
    }
    write_fork_marker(temp)?;
    let uid = new_uid();
    // The marker stays until the rename has published the folder: a sweep must never see the finished copy as
    // abandoned.
    for _ in 0..1000 {
        let name = free_name(source_name, kind, parent);
        stamp(temp, &name, &uid, origin)?;
        let dest = parent.join(&name);
        match rename_noreplace(temp, &dest) {
            Ok(()) => {
                // Best effort: a marker that stays is inert (it is not copied, and the folder is no temp name).
                let _ = std::fs::remove_file(dest.join(TEMP_MARKER));
                return Ok(Copied { name, dir: dest, uid });
            }
            // Another copy took the name between the check and the rename: pick the next one.
            Err(_) if dest.exists() => continue,
            Err(err) => return Err(err.into()),
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "no free name for the copy").into())
}

/// Remove copies a crash left behind: `.openvids-fork-<hex>` folders in `parents` whose builder is gone (a marker
/// naming a process that no longer runs; a folder with no marker only once it is older than [`MARKERLESS_GRACE`]).
/// A folder another running process is still building stays. Returns how many were removed.
pub fn sweep_leftovers(parents: &[PathBuf]) -> usize {
    sweep(parents, MARKERLESS_GRACE)
}

/// Whether the marker's process (pid and, when recorded, the start it had) still runs.
fn builder_runs(marker: &Map<String, Value>) -> bool {
    let Some(pid) = marker.get("pid").and_then(Value::as_u64).and_then(|pid| u32::try_from(pid).ok()) else {
        return false;
    };
    if !super::proc::is_alive(pid) {
        return false;
    }
    match (marker.get("start").and_then(Value::as_str), super::proc::start_key(pid)) {
        // A pid that now belongs to another process (reused after a crash or reboot) is not the builder.
        (Some(recorded), Some(now)) => super::proc::same_start(&now, recorded),
        _ => true,
    }
}

fn sweep(parents: &[PathBuf], markerless_grace: Duration) -> usize {
    let mut removed = 0;
    let mut seen: Vec<&PathBuf> = Vec::new();
    for parent in parents {
        if seen.contains(&parent) {
            continue;
        }
        seen.push(parent);
        let Ok(entries) = std::fs::read_dir(parent) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            if !is_temp_name(&name) || !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let abandoned = match read_json_object(&path.join(TEMP_MARKER)) {
                Some(marker) => !builder_runs(&marker),
                None => entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age >= markerless_grace),
            };
            if abandoned && std::fs::remove_dir_all(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

// ── Refusing while the agent works ──────────────────────────────────────────

/// Why a project cannot be copied right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    /// An agent turn is running in the project.
    AgentTurn,
    /// Another live process serves the project's chats (its pid) and cannot be asked whether a turn runs.
    ServedElsewhere(u32),
}

/// How this app has the source project.
pub enum Open {
    /// Not open in this app.
    No,
    /// Open here, with what its Studio server says it is doing (`None`: it did not answer — a server that cannot
    /// be reached has nothing running).
    Yes(Option<Activity>),
}

/// The live process holding the agent's ownership lease (`.hyperframes/agent/owner.pid`, written by
/// `takeProjectOwnership`: `<pid>` or `<pid> <start>`). A lease survives a hard kill, so a live pid alone proves
/// nothing: it must also have started when the lease's writer did (`processLock.ts` `holds`). A lease whose process
/// is gone, was replaced by an unrelated one that reuses the pid, or cannot be read is stale; a live process whose
/// start cannot be told counts as the holder.
fn lease_holder(dir: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(dir.join(".hyperframes/agent/owner.pid")).ok()?;
    let text = text.trim_end_matches(['\r', '\n']);
    let (pid, start) = match text.split_once(' ') {
        Some((pid, start)) if !start.is_empty() => (pid, Some(start)),
        Some(_) => return None,
        None => (text, None),
    };
    let pid: u32 = pid.parse().ok()?;
    if !super::proc::is_alive(pid) {
        return None;
    }
    match (start, super::proc::start_key(pid)) {
        (Some(recorded), Some(now)) if !super::proc::same_start(&now, recorded) => None,
        _ => Some(pid),
    }
}

/// The agent's work in the project makes a copy unsafe: a turn writes files and history while the copy reads them.
/// A project open in this app is asked directly (its Studio server knows about turns); one that another process
/// serves cannot be, so the live lease alone refuses it.
pub fn busy(dir: &Path, open: Open) -> Option<Busy> {
    match open {
        Open::Yes(activity) => activity.filter(|a| a.agent_turn).map(|_| Busy::AgentTurn),
        Open::No => lease_holder(dir).map(Busy::ServedElsewhere),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc;

    fn scratch(label: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("openvids-copy-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn write(path: PathBuf, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read_json(path: PathBuf) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    /// A project with everything a copy must keep and everything it must leave out.
    fn project(base: &Path) -> PathBuf {
        let src = base.join("Talk");
        for (rel, text) in [
            ("index.html", "<html></html>"),
            ("assets/a.mov", "frames"),
            ("design/system.html", "<html></html>"),
            ("meta.json", r#"{"id":"Talk","name":"Talk","createdAt":"2020-01-01T00:00:00Z"}"#),
            ("package.json", r#"{"name":"talk","private":true}"#),
            (".hyperframes/provenance.json", "{}"),
            (".hyperframes/ranges.json", "{}"),
            (".hyperframes/story/graph.json", "{}"),
            (".hyperframes/story/sync.json", "{}"),
            (".hyperframes/analysis/sources/a.json", "{}"),
            (".hyperframes/qa/accepted.json", "[]"),
            (".hyperframes/hf-ids-stamped.json", "{}"),
            (".hyperframes/agent/chats/c1/events.jsonl", "{}\n"),
            (".hyperframes/agent/chats.json", "{}"),
            // Left out:
            ("renders/out.mp4", "r"),
            (".transcode-cache/x.mp4", "t"),
            (".hyperframes/agent/usage.jsonl", "{}\n"),
            (".hyperframes/agent/owner.pid", "1"),
            (".hyperframes/agent/intake.json", "{}"),
            (".hyperframes/history-id", "id"),
            (".hyperframes/history-turn.json", "{}"),
            (".hyperframes/history-turns.json", "{}"),
            (".hyperframes/research/cache/a.json", "{}"),
            (".hyperframes/qa/frames/f.jpg", "j"),
            (".hyperframes/qa/reports/r.json", "{}"),
            (".hyperframes/preview/p.html", "<html>"),
            (".hyperframes/backup/b", "b"),
            (".hyperframes/prepared-assets/gif/g.webm", "w"),
            ("assets/clip.lock.os", "l"),
            ("assets/.clip.mp4.hf-transaction-abc123/part", "p"),
        ] {
            write(src.join(rel), text);
        }
        src
    }

    const LEFT_OUT: [&str; 15] = [
        "renders",
        ".transcode-cache",
        ".hyperframes/agent/usage.jsonl",
        ".hyperframes/agent/owner.pid",
        ".hyperframes/agent/intake.json",
        ".hyperframes/history-id",
        ".hyperframes/history-turn.json",
        ".hyperframes/history-turns.json",
        ".hyperframes/research/cache",
        ".hyperframes/qa/frames",
        ".hyperframes/qa/reports",
        ".hyperframes/preview",
        ".hyperframes/backup",
        ".hyperframes/prepared-assets",
        "assets/clip.lock.os",
    ];

    #[test]
    fn a_copy_keeps_the_users_material_and_leaves_out_derived_state() {
        let base = scratch("keep");
        let src = project(&base);
        let copied = copy_project(&src, Kind::Fork, &Progress::default()).unwrap();
        let dst = &copied.dir;
        for kept in [
            "index.html",
            "assets/a.mov",
            "design/system.html",
            ".hyperframes/provenance.json",
            ".hyperframes/ranges.json",
            ".hyperframes/story/graph.json",
            ".hyperframes/story/sync.json",
            ".hyperframes/analysis/sources/a.json",
            ".hyperframes/qa/accepted.json",
            ".hyperframes/hf-ids-stamped.json",
            ".hyperframes/agent/chats/c1/events.jsonl",
            ".hyperframes/agent/chats.json",
        ] {
            assert!(dst.join(kept).is_file(), "{kept} is copied");
        }
        for left_out in LEFT_OUT {
            assert!(!dst.join(left_out).exists(), "{left_out} is not copied");
        }
        assert!(
            !dst.join("assets/.clip.mp4.hf-transaction-abc123").exists(),
            "a render transaction folder is not copied"
        );
        // The original keeps everything it had.
        for left_out in LEFT_OUT {
            assert!(src.join(left_out).exists(), "{left_out} stays in the original");
        }
        assert_eq!(std::fs::read(src.join("assets/a.mov")).unwrap(), b"frames");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_fork_records_where_it_came_from_and_starts_its_own_life() {
        let base = scratch("lineage");
        let src = project(&base);
        let copied = copy_project(&src, Kind::Fork, &Progress::default()).unwrap();
        assert_eq!(copied.name, "Talk fork");
        assert_eq!(copied.dir, base.join("Talk fork"));

        // The original got its uid lazily and is otherwise as it was.
        let original = read_json(src.join("meta.json"));
        let uid = original["uid"].as_str().unwrap().to_string();
        assert_eq!(original["createdAt"], "2020-01-01T00:00:00Z");
        assert_eq!(original["name"], "Talk");
        assert_eq!(ensure_uid(&src).unwrap().as_deref(), Some(uid.as_str()), "the uid is stable");

        let meta = read_json(copied.dir.join("meta.json"));
        assert_eq!(meta["id"], "Talk fork");
        assert_eq!(meta["name"], "Talk fork");
        assert_eq!(meta["uid"], json!(copied.uid));
        assert_ne!(copied.uid, uid, "a fork has an identity of its own");
        assert_ne!(meta["createdAt"], "2020-01-01T00:00:00Z");
        assert_eq!(meta["forkedFrom"]["uid"], json!(uid));
        assert_eq!(meta["forkedFrom"]["name"], "Talk");
        assert_eq!(meta["forkedFrom"]["dir"], json!(src.to_string_lossy()));
        assert!(meta["forkedFrom"]["at"].is_string());
        assert_eq!(read_json(copied.dir.join("package.json"))["name"], "talk-fork");
        assert_eq!(read_json(src.join("package.json"))["name"], "talk");
        assert_eq!(forked_from_name(&copied.dir).as_deref(), Some("Talk"));
        assert_eq!(forked_from_name(&src), None);

        // A fork of the fork points at the fork, not at the root.
        let second = copy_project(&copied.dir, Kind::Fork, &Progress::default()).unwrap();
        assert_eq!(second.name, "Talk fork fork");
        let meta = read_json(second.dir.join("meta.json"));
        assert_eq!(meta["forkedFrom"]["name"], "Talk fork");
        assert_eq!(meta["forkedFrom"]["uid"], json!(copied.uid));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_duplicate_gets_a_new_uid_and_no_lineage() {
        let base = scratch("dup-meta");
        let src = project(&base);
        let forked = copy_project(&src, Kind::Fork, &Progress::default()).unwrap();
        let copied = copy_project(&forked.dir, Kind::Duplicate, &Progress::default()).unwrap();
        assert_eq!(copied.name, "Talk fork copy");
        let meta = read_json(copied.dir.join("meta.json"));
        assert_eq!(meta["uid"], json!(copied.uid));
        assert_ne!(copied.uid, forked.uid);
        assert!(meta.get("forkedFrom").is_none(), "a plain copy is not a fork");
        assert_eq!(meta["name"], "Talk fork copy");
        // The source of a duplicate is not touched at all.
        assert!(read_json(forked.dir.join("meta.json")).get("forkedFrom").is_some());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_project_without_meta_json_still_forks_with_lineage() {
        let base = scratch("no-meta");
        let src = base.join("Bare");
        write(src.join("index.html"), "x");
        let copied = copy_project(&src, Kind::Fork, &Progress::default()).unwrap();
        let meta = read_json(copied.dir.join("meta.json"));
        assert_eq!(meta["forkedFrom"]["uid"], read_json(src.join("meta.json"))["uid"]);
        assert!(!copied.dir.join("package.json").exists(), "no package.json is invented");

        // An unreadable meta.json is never overwritten in the original.
        let broken = base.join("Broken");
        write(broken.join("index.html"), "x");
        write(broken.join("meta.json"), "{ not json");
        let copied = copy_project(&broken, Kind::Fork, &Progress::default()).unwrap();
        assert_eq!(std::fs::read_to_string(broken.join("meta.json")).unwrap(), "{ not json");
        let meta = read_json(copied.dir.join("meta.json"));
        assert_eq!(meta["name"], "Broken fork");
        assert!(meta["forkedFrom"]["uid"].is_null());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_fork_marker_says_when_and_the_history_starts_empty() {
        let base = scratch("marker");
        let src = project(&base);
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let copied = copy_project(&src, Kind::Fork, &Progress::default()).unwrap();
        let marker = read_json(copied.dir.join(".hyperframes/agent/fork.json"));
        assert!(marker["forkedAt"].as_u64().unwrap() >= before);
        assert!(!src.join(".hyperframes/agent/fork.json").exists(), "the original has no marker");
        assert!(!copied.dir.join(TEMP_MARKER).exists(), "the builder's marker is gone once the copy is published");
        // A marker a crash left in a project is not copied into its forks.
        write(src.join(TEMP_MARKER), "{}");
        let again = copy_project(&src, Kind::Duplicate, &Progress::default()).unwrap();
        assert!(!again.dir.join(TEMP_MARKER).exists());
        std::fs::remove_file(src.join(TEMP_MARKER)).unwrap();
        // No history id: Studio mints the fork's own, so the original's undo entries are not shared.
        assert!(!copied.dir.join(".hyperframes/history-id").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_names_follow_finder_and_never_reuse_a_taken_one() {
        let base = scratch("names");
        std::fs::create_dir_all(base.join("Talk copy")).unwrap();
        assert_eq!(free_name("Talk", Kind::Duplicate, &base), "Talk copy 2");
        assert_eq!(free_name("Other", Kind::Duplicate, &base), "Other copy");
        assert_eq!(free_name("Talk", Kind::Fork, &base), "Talk fork");

        let src = project(&base);
        let first = copy_project(&src, Kind::Fork, &Progress::default()).unwrap();
        let second = copy_project(&src, Kind::Fork, &Progress::default()).unwrap();
        assert_eq!((first.name.as_str(), second.name.as_str()), ("Talk fork", "Talk fork 2"));
        assert_eq!(read_json(second.dir.join("meta.json"))["name"], "Talk fork 2");
        // The rename refuses a taken name instead of replacing it.
        let spare = base.join("spare");
        std::fs::create_dir_all(&spare).unwrap();
        let err = rename_noreplace(&spare, &first.dir).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(first.dir.join("index.html").is_file(), "the taken folder is untouched");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn progress_counts_the_bytes_that_are_copied() {
        let base = scratch("progress");
        let src = project(&base);
        let progress = Progress::default();
        copy_project(&src, Kind::Duplicate, &progress).unwrap();
        let (done, total) = progress.snapshot();
        assert_eq!(done, total);
        // Left-out files do not count: only the kept ones are expected.
        let expected: u64 = [
            "<html></html>",
            "frames",
            "<html></html>",
            r#"{"id":"Talk","name":"Talk","createdAt":"2020-01-01T00:00:00Z"}"#,
            r#"{"name":"talk","private":true}"#,
            "{}",
            "{}",
            "{}",
            "{}",
            "{}",
            "[]",
            "{}",
            "{}\n",
            "{}",
        ]
        .iter()
        .map(|s| s.len() as u64)
        .sum();
        assert_eq!(total, expected);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_cancelled_copy_leaves_nothing_behind() {
        let base = scratch("cancel");
        let src = project(&base);
        let progress = Progress::default();
        progress.cancel();
        assert!(matches!(copy_project(&src, Kind::Fork, &progress), Err(CopyError::Cancelled)));
        let names: Vec<String> = std::fs::read_dir(&base)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["Talk"], "no temporary folder and no half-made project");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_crash_leftover_is_swept_at_the_next_start_and_a_live_build_is_not() {
        let base = scratch("sweep");
        let dead_pid = {
            // A pid that is certainly not running: a child that has exited and been reaped.
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("--list")
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let pid = child.id();
            child.wait().unwrap();
            pid
        };
        let marker = |pid: u32| json!({ "pid": pid, "source": "x" }).to_string();
        // The builder crashed mid-copy.
        write(base.join(".openvids-fork-00000000000000aa").join(TEMP_MARKER), &marker(dead_pid));
        write(base.join(".openvids-fork-00000000000000aa/index.html"), "half");
        // No marker yet: a copy that is just starting, here or in another process (or one a crash cut at its very
        // start).
        write(base.join(".openvids-fork-00000000000000bb/index.html"), "starting");
        // The builder's pid now belongs to an unrelated process (reused after a crash or a reboot).
        let me = std::process::id();
        let own_start = proc::start_key(me).expect("this process has a start");
        let stale = if own_start.starts_with("win-ms:") { "win-ms:1000".to_string() } else { format!("{own_start} earlier") };
        write(
            base.join(".openvids-fork-00000000000000ee").join(TEMP_MARKER),
            &json!({ "pid": me, "start": stale, "source": "x" }).to_string(),
        );
        write(base.join(".openvids-fork-00000000000000ee/index.html"), "half");
        // Another running process is still building this one.
        write(
            base.join(".openvids-fork-00000000000000cc").join(TEMP_MARKER),
            &json!({ "pid": me, "start": own_start, "source": "x" }).to_string(),
        );
        // Another running process, from before the start was recorded.
        write(base.join(".openvids-fork-00000000000000ff").join(TEMP_MARKER), &marker(me));
        // Not ours: a user's folders that merely look similar.
        write(base.join(".openvids-fork-notahex/index.html"), "mine");
        write(base.join(".openvids-fork-00000000000000dd.bak/index.html"), "mine");
        write(base.join("Talk/index.html"), "mine");

        assert_eq!(sweep_leftovers(&[base.clone(), base.clone()]), 2);
        assert!(!base.join(".openvids-fork-00000000000000aa").exists(), "a dead builder's copy goes");
        assert!(!base.join(".openvids-fork-00000000000000ee").exists(), "a reused pid is not the builder");
        assert!(base.join(".openvids-fork-00000000000000bb").exists(), "a young markerless copy stays");
        assert!(base.join(".openvids-fork-00000000000000cc").exists(), "a live build stays");
        assert!(base.join(".openvids-fork-00000000000000ff").exists(), "a live build without a start stays");
        // Once it is old enough nobody is about to write a marker into it.
        assert_eq!(sweep(std::slice::from_ref(&base), Duration::ZERO), 1);
        assert!(!base.join(".openvids-fork-00000000000000bb").exists());
        assert!(base.join(".openvids-fork-00000000000000cc").exists());
        assert!(base.join(".openvids-fork-notahex/index.html").is_file());
        assert!(base.join(".openvids-fork-00000000000000dd.bak/index.html").is_file());
        assert!(base.join("Talk/index.html").is_file());
        assert_eq!(sweep_leftovers(&[base.join("missing")]), 0, "a missing parent is fine");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_copy_is_refused_while_an_agent_turn_runs() {
        let base = scratch("busy");
        let src = base.join("Talk");
        write(src.join("index.html"), "x");
        let turn = Activity { renders: 0, agent_turn: true };
        let idle = Activity { renders: 2, agent_turn: false };

        // Open in this app: its own Studio server answers.
        assert_eq!(busy(&src, Open::Yes(Some(turn))), Some(Busy::AgentTurn));
        assert_eq!(busy(&src, Open::Yes(Some(idle))), None, "a render alone does not block: renders/ is left out");
        assert_eq!(busy(&src, Open::Yes(None)), None, "an unreachable server has nothing running");

        // Not open here: nobody serves it, or a dead process's lease is left over.
        assert_eq!(busy(&src, Open::No), None);
        write(src.join(".hyperframes/agent/owner.pid"), "not a pid");
        assert_eq!(busy(&src, Open::No), None);
        // A live process holds the lease: it may be mid-turn and cannot be asked.
        let me = std::process::id();
        let lease = src.join(".hyperframes/agent/owner.pid");
        let start = proc::start_key(me).expect("this process has a start");
        write(lease.clone(), &format!("{me} {start}"));
        assert_eq!(busy(&src, Open::No), Some(Busy::ServedElsewhere(me)), "pid and start match");
        write(lease.clone(), &me.to_string());
        assert_eq!(busy(&src, Open::No), Some(Busy::ServedElsewhere(me)), "a lease without a start: the pid decides");
        // The lease outlived its writer (hard kill) and an unrelated process took the pid: not a holder.
        let stale = if start.starts_with("win-ms:") { "win-ms:1000".to_string() } else { format!("{start} earlier") };
        write(lease.clone(), &format!("{me} {stale}"));
        assert_eq!(busy(&src, Open::No), None, "a reused pid does not block a copy");
        write(lease.clone(), &format!("{me} "));
        assert_eq!(busy(&src, Open::No), None, "an unreadable lease is stale");
        // The app's own server answers for itself; the lease its runtime holds is no reason to refuse.
        assert_eq!(busy(&src, Open::Yes(Some(idle))), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn a_copy_keeps_symlinks_as_links() {
        let base = scratch("link");
        let src = base.join("p");
        write(src.join("assets/real.mov"), "frames");
        write(src.join("index.html"), "x");
        std::os::unix::fs::symlink(src.join("assets/real.mov"), src.join("assets/link.mov")).unwrap();
        // A dangling link is kept too, without failing the copy.
        std::os::unix::fs::symlink("gone.mov", src.join("assets/gone.mov")).unwrap();
        let copied = copy_project(&src, Kind::Duplicate, &Progress::default()).unwrap();
        assert!(copied.dir.join("assets/real.mov").is_file());
        assert!(std::fs::symlink_metadata(copied.dir.join("assets/link.mov")).unwrap().is_symlink());
        assert!(std::fs::symlink_metadata(copied.dir.join("assets/gone.mov")).unwrap().is_symlink());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// `cmd /c mklink /J`: a junction needs neither Developer Mode nor elevation.
    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J {link:?} {target:?}");
    }

    #[test]
    #[cfg(windows)]
    fn a_copy_skips_junctions_to_other_folders_and_to_an_ancestor() {
        let base = scratch("junction");
        let outside = base.join("outside");
        let src = base.join("p");
        write(outside.join("secret.txt"), "not part of the project");
        write(src.join("index.html"), "x");
        write(src.join("assets/clip.mov"), "frames");
        junction(&src.join("assets").join("outside-link"), &outside);
        // A cycle: a junction inside the project that points at the project itself.
        junction(&src.join("assets").join("loop"), &src);

        let copied = copy_project(&src, Kind::Duplicate, &Progress::default()).unwrap();
        let dst = copied.dir;

        assert_eq!(std::fs::read(dst.join("index.html")).unwrap(), b"x");
        assert_eq!(std::fs::read(dst.join("assets/clip.mov")).unwrap(), b"frames");
        assert!(std::fs::symlink_metadata(dst.join("assets/outside-link")).is_err(), "the link is not copied");
        assert!(std::fs::symlink_metadata(dst.join("assets/loop")).is_err(), "the cycle is not copied");
        // The external bytes are nowhere in the copy.
        let mut stack = vec![dst.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                assert_ne!(path.file_name().and_then(|n| n.to_str()), Some("secret.txt"), "{path:?}");
                if entry.file_type().unwrap().is_dir() {
                    stack.push(path);
                }
            }
        }
        // The sources are intact (removing a junction must not touch what it points at).
        assert!(outside.join("secret.txt").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }
}
