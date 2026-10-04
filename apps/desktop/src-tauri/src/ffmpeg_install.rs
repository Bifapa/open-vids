//! The "Install FFmpeg" button: macOS runs `brew install ffmpeg` (the formula
//! provides `ffprobe` too); Windows downloads the official release-essentials
//! build into `~/.openvids/ffmpeg` and points every child process at it.
//! Download happens only after an explicit click, never on its own.
//!
//! How brew is run, deliberately:
//!
//! - directly (absolute path, argument array, no shell), in its own session
//!   (`setsid`): no controlling terminal, so nothing can open `/dev/tty` to ask
//!   for a password, and stdin is closed. With `NONINTERACTIVE=1` brew fails
//!   instead of prompting; a failure that smells like "needs sudo / a terminal"
//!   is reported as "run it in Terminal".
//! - a sane environment for a GUI-launched app: PATH with brew's own bin and
//!   sbin first, HOME and the user's `HOMEBREW_*`/proxy settings inherited,
//!   `HOMEBREW_NO_ENV_HINTS`, `HOMEBREW_NO_ANALYTICS`, no colour, no emoji.
//! - **auto-update policy**: the first run sets `HOMEBREW_NO_AUTO_UPDATE=1`,
//!   the second (only after a failure that looks like stale formula metadata:
//!   "No available formula", a 404, a failed download or a checksum mismatch)
//!   lets brew update itself first. Skipping the update makes the usual install
//!   much faster and keeps it from touching anything but ffmpeg and its missing
//!   dependencies; the retry covers a very stale Homebrew without making every
//!   user pay for an update. `HOMEBREW_NO_INSTALL_UPGRADE` and
//!   `HOMEBREW_NO_INSTALL_CLEANUP` keep it from upgrading or cleaning up the
//!   user's other packages as a side effect.
//! - a cancelled, failed or timed-out install is left to Homebrew's own cleanup:
//!   OpenVids deletes none of brew's files.
//!
//! brew prints no byte progress, so the state carries `detail`, the current
//! (sanitised, one-line, bounded) line of its output.
//!
//! Homebrew is looked for in `$OPENVIDS_BREW_PATH` (tests), `/opt/homebrew/bin/brew`
//! (Apple Silicon), `/usr/local/bin/brew` (Intel), then PATH, on macOS only.
use std::borrow::Cow;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::time::Duration;

use serde_json::json;
use sha2::{Digest, Sha256};

use super::cli_runner;
use super::coded_error::CodedError;
use super::install_job::{one_line, ExitAction, InstallJob, InstallState, Installer, Stream};
use super::prefs;

/// What the UI says before and while this runs.
pub const INSTALL_COMMAND: &str = "brew install ffmpeg";
pub const INSTALL_NOTE: &str =
    "Runs `brew install ffmpeg`. It may install many dependency packages and take several minutes.";

/// The single build Windows downloads: release essentials, linked from
/// ffmpeg.org's download page. It carries every codec the renderer needs
/// (libx264/libx265, libvpx-vp9, libaom, libmp3lame, libopus, libvorbis,
/// native AAC, prores_ks) and the zscale+tonemap filters for HDR work.
pub const WINDOWS_BUILD_VERSION: &str = "9.0.2";
pub const WINDOWS_BUILD_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip";
/// SHA-256 of that exact archive, pinned in this binary (taken from the publisher's `.sha256` file and checked
/// against the downloaded bytes). A download is trusted because it hashes to this value, never because of a
/// checksum fetched from the same server; bumping the version means bumping both after checking the new file.
pub const WINDOWS_BUILD_SHA256: &str = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba";
/// Hosts a download may come from: the fixed https allow-list.
pub const WINDOWS_BUILD_HOSTS: &[&str] = &["www.gyan.dev"];
pub const BREW_URL: &str = "https://brew.sh";
const DETAIL_CHARS: usize = 160;
const REASON_CHARS: usize = 220;

/// The brew executable, if Homebrew is installed.
pub fn find_brew() -> Option<PathBuf> {
    if let Some(over) = std::env::var_os("OPENVIDS_BREW_PATH").filter(|v| !v.is_empty()) {
        let path = PathBuf::from(over);
        return path.is_file().then_some(path);
    }
    if !cfg!(target_os = "macos") {
        return None;
    }
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .iter()
        .map(PathBuf::from)
        .chain(
            std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).map(|d| d.join("brew")).collect::<Vec<_>>())
                .unwrap_or_default(),
        )
        .find(|p| p.is_file())
}

/// One printable line out of a raw line of brew output: ANSI escapes and control
/// characters gone, only the last `\r` segment (progress bars redraw one line),
/// the `==>` marker dropped, whitespace collapsed, bounded. `None` for lines
/// with no words in them (`#####  42.0%`, blank lines).
pub fn sanitize_line(raw: &str) -> Option<String> {
    let last = raw.rsplit('\r').find(|s| !s.trim().is_empty()).unwrap_or("");
    let mut text = String::with_capacity(last.len());
    let mut chars = last.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ params final-byte (0x40-0x7E); anything else after ESC is dropped with it.
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else if !c.is_control() {
            text.push(c);
        } else if c == '\t' {
            text.push(' ');
        }
    }
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let line = collapsed.strip_prefix("==>").unwrap_or(&collapsed).trim();
    if !line.chars().any(char::is_alphabetic) {
        return None;
    }
    Some(line.chars().take(DETAIL_CHARS).collect())
}

/// Failure text that means "this needs an administrator or a terminal".
fn needs_terminal(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["sudo", "password", "terminal is required", "no tty", "interactive", "administrator"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Failure text that looks like stale formula metadata, worth one retry with an update.
fn looks_stale(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["no available formula", "404", "failed to download", "sha256 mismatch", "checksum"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// The one-line reason for a failed run from the stderr tail. Brew's own line has no code: it is not our text.
pub fn failure_reason(tail: &[String], status: &ExitStatus) -> CodedError {
    let joined = tail.join("\n");
    if needs_terminal(&joined) {
        return CodedError::new(
            "brew_needs_terminal",
            format!("Homebrew needs administrator access or a Terminal. Run `{INSTALL_COMMAND}` in Terminal."),
            json!({ "command": INSTALL_COMMAND }),
        );
    }
    let lines: Vec<String> = tail.iter().filter_map(|l| sanitize_line(l)).collect();
    let reason = lines
        .iter()
        .rev()
        .find(|l| l.starts_with("Error:"))
        .or_else(|| lines.last());
    match reason {
        Some(line) => CodedError::uncoded(one_line(line, REASON_CHARS)),
        None => CodedError::new(
            "brew_failed",
            format!("`{INSTALL_COMMAND}` failed ({status})"),
            json!({ "command": INSTALL_COMMAND, "status": status.to_string() }),
        ),
    }
}

/// Homebrew is not installed: where to get it and what to run afterwards.
pub fn homebrew_missing() -> CodedError {
    CodedError::new(
        "homebrew_missing",
        format!("Homebrew was not found. Install it from {BREW_URL}, then run `{INSTALL_COMMAND}`."),
        json!({ "url": BREW_URL, "command": INSTALL_COMMAND }),
    )
}

struct BrewInstaller;

impl BrewInstaller {
    fn environment(brew: &Path, attempt: u32) -> Vec<(String, String)> {
        let bin = brew.parent().unwrap_or_else(|| Path::new("/usr/bin"));
        let sbin = bin.parent().map(|p| p.join("sbin")).unwrap_or_else(|| bin.to_path_buf());
        let inherited = std::env::var("PATH").unwrap_or_default();
        let path = format!(
            "{}:{}:/usr/bin:/bin:/usr/sbin:/sbin{}{}",
            bin.display(),
            sbin.display(),
            if inherited.is_empty() { "" } else { ":" },
            inherited
        );
        let mut env = vec![
            ("PATH", path.as_str()),
            ("NONINTERACTIVE", "1"),
            ("HOMEBREW_NO_ENV_HINTS", "1"),
            ("HOMEBREW_NO_ANALYTICS", "1"),
            ("HOMEBREW_NO_INSTALL_UPGRADE", "1"),
            ("HOMEBREW_NO_INSTALL_CLEANUP", "1"),
            ("HOMEBREW_NO_EMOJI", "1"),
            ("HOMEBREW_NO_COLOR", "1"),
            ("NO_COLOR", "1"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect::<Vec<_>>();
        if attempt == 0 {
            env.push(("HOMEBREW_NO_AUTO_UPDATE".into(), "1".into()));
        }
        env
    }
}

impl Installer for BrewInstaller {
    fn command(&self, attempt: u32) -> Result<Command, CodedError> {
        let brew = find_brew().ok_or_else(homebrew_missing)?;
        // Tests point `OPENVIDS_BREW_PATH` at a `.mjs` script: run it on the
        // same runtime the fake CLI uses, with the brew path as argv[1].
        // A real brew stays a direct spawn with no shell in between.
        let mut command = if brew.extension().and_then(|e| e.to_str()) == Some("mjs") {
            let mut fake = Command::new(crate::platform::BUN_BIN);
            fake.arg(&brew);
            fake
        } else {
            Command::new(&brew)
        };
        command.args(["install", "ffmpeg"]);
        for (key, value) in Self::environment(&brew, attempt) {
            command.env(key, value);
        }
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // SAFETY: setsid is async-signal-safe and the only call in the hook.
            // A new session is its own process group (killpg works on it) and has
            // no controlling terminal, so nothing can prompt on /dev/tty. A failed
            // setsid must fail the spawn: Homebrew would otherwise run attached
            // to our terminal (and outside the group `cancel` signals).
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        Ok(command)
    }

    fn started(&self) -> InstallState {
        let mut state = InstallState::of("installing");
        state.detail = Some("Starting Homebrew".into());
        state
    }

    fn on_line(&self, state: &mut InstallState, _stream: Stream, line: &str) {
        if let Some(detail) = sanitize_line(line) {
            state.detail = Some(detail);
        }
    }

    fn on_exit(
        &self,
        state: &mut InstallState,
        status: &ExitStatus,
        stderr_tail: &[String],
        attempt: u32,
    ) -> ExitAction {
        if status.success() {
            return ExitAction::Verify;
        }
        if attempt == 0 && looks_stale(&stderr_tail.join("\n")) {
            state.detail = Some("Updating Homebrew and trying again".into());
            return ExitAction::Retry;
        }
        *state = InstallState::failed_with(&failure_reason(stderr_tail, status));
        ExitAction::Finished
    }

    /// brew said it worked: the tools must now be findable (a fresh CLI process
    /// looks, so the page's next System check sees them too).
    fn verify(&self) -> Result<Option<String>, CodedError> {
        let Ok(out) = cli_runner::run(&["doctor", "--tools"], Duration::from_secs(10)) else {
            // No CLI to ask: Homebrew's success is all there is.
            return Ok(None);
        };
        let Some(tools) = cli_runner::last_json_line(&out).and_then(|v| v.get("tools").cloned()) else {
            return Ok(None);
        };
        let found = |name: &str| tools.get(name).and_then(|t| t.get("found")).and_then(|f| f.as_bool()) == Some(true);
        if !found("ffmpeg") {
            return Err(CodedError::plain(
                "ffmpeg_not_found_after",
                "Homebrew finished, but ffmpeg was not found afterwards.",
            ));
        }
        Ok(tools
            .get("ffmpeg")
            .and_then(|t| t.get("path"))
            .and_then(|p| p.as_str())
            .map(str::to_string))
    }
}

/// The Windows half: download the official release-essentials build into
/// `~/.openvids/ffmpeg`, verified against the publisher's SHA-256. Driven
/// in-process by a worker thread (there is no child to supervise), with byte
/// progress in the state like the Chrome installer.
struct DownloadInstaller;

/// State for one active download: the job it reports to, the generation it
/// must still own when it finishes, its byte progress, and the flag cancel
/// flips to stop the fetch loops.
struct DownloadRun {
    job: &'static InstallJob,
    generation: u64,
    progress: std::sync::Arc<DownloadProgress>,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl DownloadInstaller {
    /// Run the blocking download on a worker, then land the outcome in the
    /// slot when this generation still owns it. A cancelled or superseded
    /// run leaves the slot alone.
    fn run(run: DownloadRun) {
        let outcome = download_and_install(&run.progress, &run.cancelled);
        run.job.with_slot(|slot| {
            if slot.generation != run.generation || !slot.state.is_active() {
                return;
            }
            slot.pid = None;
            slot.state = match outcome {
                Ok(path) => {
                    let mut done = InstallState::of("done");
                    done.path = Some(path);
                    done
                }
                Err(error) if error.code == Some("ffmpeg_cancelled") => InstallState::of("cancelled"),
                Err(error) => InstallState::failed_with(&error),
            };
        });
    }
}

impl Installer for DownloadInstaller {
    fn command(&self, _attempt: u32) -> Result<Command, CodedError> {
        // `InstallJob::spawn` is bypassed below; this must never run.
        Err(CodedError::plain("ffmpeg_unexpected", "the FFmpeg download takes no command"))
    }

    fn started(&self) -> InstallState {
        InstallState::of("downloading")
    }

    fn on_line(&self, _state: &mut InstallState, _stream: Stream, _line: &str) {}

    fn on_exit(
        &self,
        state: &mut InstallState,
        _status: &ExitStatus,
        _stderr_tail: &[String],
        _attempt: u32,
    ) -> ExitAction {
        let _ = state;
        ExitAction::Finished
    }

    fn verify(&self) -> Result<Option<String>, CodedError> {
        // The download returns its path directly; nothing to verify.
        Ok(None)
    }
}

/// Where the Windows build lives after a download: `~/.openvids/ffmpeg`.
/// The home comes from `prefs::home_dir()` (the Windows-correct home), and
/// `OPENVIDS_FFMPEG_DIR` overrides it in tests only.
pub fn managed_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OPENVIDS_FFMPEG_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    prefs::home_dir().join(".openvids").join("ffmpeg")
}

/// The installed executables when a downloaded build is in place.
/// `ffprobe.exe` ships in the same build; a half-installed directory (only
/// one of the two) counts as missing so the button repairs it.
pub fn managed_ffmpeg() -> Option<PathBuf> {
    let dir = managed_dir();
    let ffmpeg = dir.join("ffmpeg.exe");
    let ffprobe = dir.join("ffprobe.exe");
    (ffmpeg.is_file() && ffprobe.is_file()).then_some(ffmpeg)
}

/// The installed ffprobe, same rule as [`managed_ffmpeg`].
pub fn managed_ffprobe() -> Option<PathBuf> {
    let dir = managed_dir();
    let ffprobe = dir.join("ffprobe.exe");
    let ffmpeg = dir.join("ffmpeg.exe");
    (ffmpeg.is_file() && ffprobe.is_file()).then_some(ffprobe)
}

/// The environment every child (sidecar, CLI, agent runtime) is spawned with:
/// `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` pointing at the
/// downloaded build when one is installed, and a `PATH` that can find
/// ffmpeg/ffprobe. Computed at each spawn, so a download that finishes
/// mid-session takes effect the next time a project opens without a restart.
/// Explicit user overrides in the environment win: they are left untouched.
pub fn managed_env() -> Vec<(String, String)> {
    // A caller-set override names a file the user chose; keep it even when
    // it points nowhere (the CLI reports it as missing, not as ours).
    let ffmpeg_var = std::env::var_os("HYPERFRAMES_FFMPEG_PATH").filter(|v| !v.is_empty());
    let ffprobe_var = std::env::var_os("HYPERFRAMES_FFPROBE_PATH").filter(|v| !v.is_empty());
    let mut env = Vec::new();
    if ffmpeg_var.is_none() {
        if let Some(ffmpeg) = managed_ffmpeg() {
            env.push(("HYPERFRAMES_FFMPEG_PATH".to_string(), ffmpeg.to_string_lossy().into_owned()));
        }
    }
    if ffprobe_var.is_none() {
        if let Some(ffprobe) = managed_ffprobe() {
            env.push(("HYPERFRAMES_FFPROBE_PATH".to_string(), ffprobe.to_string_lossy().into_owned()));
        }
    }
    // Tools that look ffmpeg up by name (the agents' `read` of a video frame)
    // only see PATH. An app opened from Finder gets launchd's bare
    // `/usr/bin:/bin:/usr/sbin:/sbin`, without Homebrew, and the Windows
    // download lives outside PATH: put both where a lookup finds them.
    let mut prepend = Vec::new();
    if managed_ffmpeg().is_some() {
        prepend.push(managed_dir());
    }
    #[cfg(not(windows))]
    let append: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin"]
        .into_iter()
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .collect();
    #[cfg(windows)]
    let append: Vec<PathBuf> = Vec::new();
    if let Some(path) = child_path(std::env::var_os("PATH"), &prepend, &append) {
        env.push(("PATH".to_string(), path.to_string_lossy().into_owned()));
    }
    env
}

/// `inherited` with `prepend` in front and `append` behind it, each directory
/// added only when the inherited PATH does not already list it. None when
/// nothing would change, so the child simply inherits PATH.
fn child_path(
    inherited: Option<std::ffi::OsString>,
    prepend: &[PathBuf],
    append: &[PathBuf],
) -> Option<std::ffi::OsString> {
    let current: Vec<PathBuf> = inherited
        .as_deref()
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    let missing = |dir: &&PathBuf| !current.iter().any(|known| known == *dir);
    let front: Vec<PathBuf> = prepend.iter().filter(missing).cloned().collect();
    let back: Vec<PathBuf> = append.iter().filter(missing).cloned().collect();
    if front.is_empty() && back.is_empty() {
        return None;
    }
    std::env::join_paths(front.into_iter().chain(current).chain(back)).ok()
}

/// Where the build comes from and the SHA-256 it must have. Production: the pinned constants, borrowed — the
/// trust anchor is this binary, so no environment variable or network response can change it. Test builds only
/// may point the download at a loopback server (`OPENVIDS_FFMPEG_URL`) with the fixture's digest
/// (`OPENVIDS_FFMPEG_SHA256`, hex).
fn download_source() -> Result<(Cow<'static, str>, Cow<'static, str>), CodedError> {
    // The pinned URL carries the pinned version; refuse to drift apart.
    debug_assert!(WINDOWS_BUILD_URL.contains(WINDOWS_BUILD_VERSION));
    #[cfg(test)]
    if let Some(url) = std::env::var("OPENVIDS_FFMPEG_URL").ok().filter(|v| !v.is_empty()) {
        check_url(&url)?;
        let sha256 = std::env::var("OPENVIDS_FFMPEG_SHA256").unwrap_or_default();
        return Ok((Cow::Owned(url), Cow::Owned(sha256)));
    }
    check_url(WINDOWS_BUILD_URL)?;
    Ok((Cow::Borrowed(WINDOWS_BUILD_URL), Cow::Borrowed(WINDOWS_BUILD_SHA256)))
}

/// https on the allow-list; test builds also take a loopback URL (the local download server).
fn check_url(raw: &str) -> Result<(), CodedError> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| CodedError::plain("ffmpeg_bad_url", format!("the FFmpeg download address is not valid: {e}")))?;
    if cfg!(test) && is_loopback_url(&parsed) {
        return Ok(());
    }
    if parsed.scheme() != "https" {
        return Err(CodedError::plain(
            "ffmpeg_bad_url",
            "the FFmpeg download address must be https.",
        ));
    }
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    if !WINDOWS_BUILD_HOSTS.iter().any(|h| host == *h) {
        return Err(CodedError::plain(
            "ffmpeg_bad_url",
            "the FFmpeg download address is not on the allowed hosts.",
        ));
    }
    Ok(())
}

/// Loopback hosts (and `.localhost`) for the test download server.
/// `url::Url` has no `is_loopback()`; match by name instead. IPv6 loopback
/// arrives as "::1" without brackets from `host_str()`.
fn is_loopback_url(parsed: &url::Url) -> bool {
    match parsed.host_str().unwrap_or_default().to_lowercase().as_str() {
        "localhost" | "127.0.0.1" | "::1" => true,
        host => host.ends_with(".localhost"),
    }
}

/// SHA-256 of bytes in hex, lowercase.
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Compare the downloaded bytes with the expected hex digest and refuse on any mismatch.
fn verify_checksum(archive: &[u8], expected: &str) -> Result<(), CodedError> {
    let expected = expected.trim().to_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CodedError::plain(
            "ffmpeg_bad_checksum",
            "the FFmpeg checksum was not a SHA-256 hash.",
        ));
    }
    let actual = sha256_hex(archive);
    if actual != expected {
        return Err(CodedError::plain(
            "ffmpeg_checksum_mismatch",
            "the FFmpeg download did not match its published checksum, so it was discarded.",
        ));
    }
    Ok(())
}

/// Pick `ffmpeg.exe`/`ffprobe.exe` out of the build zip, safely: entry paths
/// must collapse inside the destination (`enclosed_name` rejects `..` and
/// absolute paths, and the extra `starts_with` is the belt), only regular
/// files land, and only the two executables plus the license/README text are
/// kept. Returns the installed binary names.
fn extract_build(archive: &[u8], dest: &Path) -> Result<Vec<String>, CodedError> {
    let fail = |detail: &str| CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {detail}"));
    let mut zip = zip::ZipArchive::new(io::Cursor::new(archive)).map_err(|e| fail(&e.to_string()))?;
    let mut kept = Vec::new();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| fail(&e.to_string()))?;
        if entry.is_dir() {
            continue;
        }
        let Some(safe) = entry.enclosed_name() else {
            return Err(fail("an entry pointed outside the archive"));
        };
        let name = safe.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_lowercase();
        let keep = matches!(name.as_str(), "ffmpeg.exe" | "ffprobe.exe")
            || name == "license" || name == "license.txt" || name == "readme.txt";
        if !keep {
            continue;
        }
        // Belt after `enclosed_name`: a name like `a/../../x` that survived
        // must still land inside `dest`.
        let out = dest.join(&safe);
        if !out.starts_with(dest) {
            return Err(fail("an entry pointed outside the archive"));
        }
        if name == "ffmpeg.exe" || name == "ffprobe.exe" {
            kept.push(name.clone());
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| fail(&e.to_string()))?;
        }
        let mut file = std::fs::File::create(&out).map_err(|e| fail(&e.to_string()))?;
        io::copy(&mut entry, &mut file).map_err(|e| fail(&e.to_string()))?;
    }
    if !kept.contains(&"ffmpeg.exe".to_string()) || !kept.contains(&"ffprobe.exe".to_string()) {
        return Err(fail("ffmpeg.exe or ffprobe.exe was missing"));
    }
    kept.sort();
    kept.dedup();
    Ok(kept)
}

/// `CodedError` for a failure while unpacking or swapping a download.
fn extract_failed(detail: impl std::fmt::Display) -> CodedError {
    CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {detail}"))
}

/// A real directory: not a file, and not a symlink, junction or other reparse point. Recovery and cleanup never
/// follow a link, so a planted `ffmpeg-*.bak` cannot make them move or delete something elsewhere.
fn is_plain_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !crate::platform::is_link_like(&meta))
}

/// A usable managed install: both executables, as `managed_ffmpeg` requires.
fn is_complete_install(dir: &Path) -> bool {
    is_plain_dir(dir) && dir.join("ffmpeg.exe").is_file() && dir.join("ffprobe.exe").is_file()
}

/// The lock file beside the managed dir. Closing the handle (or the process dying) releases the OS lock, so a
/// stale file never blocks anything; the file itself is never deleted.
fn managed_lock_path() -> PathBuf {
    managed_dir().with_extension("lock")
}

/// Take the exclusive install lock without waiting. `Ok(None)`: another process holds it. Held for a whole
/// download-and-swap by `download_and_install`, and for a recovery pass by `recover_managed_install`, so neither
/// can touch the other's temp dir or backup.
fn try_managed_install_lock() -> io::Result<Option<std::fs::File>> {
    let path = managed_lock_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    // Windows: an exclusive handle (no sharing at all) is the lock; opening it again while any handle is open fails
    // with ERROR_SHARING_VIOLATION (32) or ERROR_LOCK_VIOLATION (33).
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = match options.open(&path) {
        Ok(file) => file,
        #[cfg(windows)]
        Err(error) if matches!(error.raw_os_error(), Some(32 | 33)) => return Ok(None),
        Err(error) => return Err(error),
    };
    // Unix: an advisory flock on the open file description. (`File::try_lock` is newer than the crate's MSRV.)
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: `flock` on a descriptor `file` owns and keeps open for the call.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == -1 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::WouldBlock { Ok(None) } else { Err(error) };
        }
    }
    Ok(Some(file))
}

/// The install lock, or the error a second download gets while another install runs.
fn acquire_install_lock() -> Result<std::fs::File, CodedError> {
    match try_managed_install_lock() {
        Ok(Some(lock)) => Ok(lock),
        Ok(None) => Err(extract_failed("Another FFmpeg installation is in progress.")),
        Err(error) => Err(extract_failed(error)),
    }
}

/// Put the managed dir back in a consistent state after an install was killed between its two renames
/// (managed → `ffmpeg-<nanos>.bak`, then `ffmpeg-<nanos>.tmp` → managed). The directories live next to the
/// managed dir; only our own `ffmpeg-*` names inside that parent are ever touched, and never through a link.
/// Caller holds the install lock.
///
/// 1. No usable managed dir (missing, or not a directory): restore the newest *complete* backup (both
///    executables). A refused rename keeps every backup and fails, so the caller stops instead of replacing.
/// 2. A complete managed dir makes every backup garbage; an incomplete one keeps them (a later verified install
///    replaces it through the ordinary swap).
/// 3. Working `.tmp` dirs are always garbage under the lock.
fn sweep_stale_temp_dirs() -> Result<(), CodedError> {
    let dest = managed_dir();
    let Some(parent) = dest.parent() else {
        return Ok(());
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Ok(());
    };
    let mut temps = Vec::new();
    let mut backups: Vec<(u128, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_plain_dir(&path) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix("ffmpeg-") else {
            continue;
        };
        if rest.ends_with(".tmp") {
            temps.push(path);
        } else if let Some(stamp) = rest.strip_suffix(".bak").and_then(|stamp| stamp.parse::<u128>().ok()) {
            backups.push((stamp, path));
        }
    }
    if !is_plain_dir(&dest) {
        backups.sort_by_key(|(stamp, _)| std::cmp::Reverse(*stamp));
        let newest = backups.iter().map(|(_, path)| path).find(|path| is_complete_install(path)).cloned();
        if let Some(newest) = newest {
            std::fs::rename(&newest, &dest).map_err(|error| {
                CodedError::plain(
                    "ffmpeg_extract_failed",
                    format!("could not restore the previous FFmpeg install: {error}"),
                )
            })?;
            backups.retain(|(_, path)| *path != newest);
        }
    }
    if is_complete_install(&dest) {
        for (_, path) in &backups {
            let _ = std::fs::remove_dir_all(path);
        }
    }
    for path in temps {
        let _ = std::fs::remove_dir_all(path);
    }
    Ok(())
}

/// Startup recovery (Windows setup, before any sidecar starts): finish or undo an install that a crash or a
/// Task Manager kill interrupted. Does nothing, and creates nothing, when there is no leftover; does nothing at
/// all while another process holds the install lock (its working dirs are not ours to touch).
pub(crate) fn recover_managed_install() -> Result<(), CodedError> {
    let dest = managed_dir();
    let has_leftovers = dest
        .parent()
        .and_then(|parent| std::fs::read_dir(parent).ok())
        .is_some_and(|entries| {
            entries.flatten().any(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.starts_with("ffmpeg-") && (name.ends_with(".tmp") || name.ends_with(".bak"))
            })
        });
    if !has_leftovers {
        return Ok(());
    }
    match try_managed_install_lock().map_err(extract_failed)? {
        Some(_lock) => sweep_stale_temp_dirs(),
        None => Ok(()),
    }
}

/// The single blocking flow a Windows download runs, under the install lock from the first recovery step to the
/// last cleanup: restore/sweep leftovers, fetch the pinned archive, refuse it unless its SHA-256 is the one
/// embedded in this binary, extract `ffmpeg.exe`/`ffprobe.exe` plus license/README text into a temp dir, then
/// swap it in. `progress` mirrors byte counts into the slot; `cancelled` flips when the job is cancelled or
/// times out.
fn download_and_install(
    progress: &DownloadProgress,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<String, CodedError> {
    let _lock = acquire_install_lock()?;
    sweep_stale_temp_dirs()?;
    let (url, sha256) = download_source()?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30 * 60)))
        .http_status_as_error(false)
        .user_agent(format!("OpenVids/{} ({}; {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH))
        .build()
        .into();
    let archive = fetch_bytes(&agent, &url, progress, cancelled)?;
    verify_checksum(&archive, &sha256)?;
    install_archive(&archive)?;
    managed_ffmpeg()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| CodedError::plain("ffmpeg_not_found_after", "the FFmpeg download finished, but ffmpeg.exe was not found afterwards."))
}

/// How long the archive may deliver no byte before the download gives up. A stalled connection otherwise blocks
/// the worker (and the install lock it holds) until the 30-minute call timeout, and Cancel cannot interrupt a
/// blocked read.
const DOWNLOAD_IDLE_TIMEOUT: Duration =
    if cfg!(test) { Duration::from_secs(2) } else { Duration::from_secs(60) };

/// GET the archive with byte progress. Capped at 1 GiB. The body is read on a helper thread and handed over in
/// chunks: this thread wakes every second, so a cancel is seen at once and a connection that goes quiet for
/// [`DOWNLOAD_IDLE_TIMEOUT`] fails the install instead of hanging it. A helper still blocked in a read when this
/// returns ends with its connection; it holds no lock and its next chunk goes nowhere.
fn fetch_bytes(
    agent: &ureq::Agent,
    url: &str,
    progress: &DownloadProgress,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<Vec<u8>, CodedError> {
    use std::io::Read;
    use std::sync::{atomic::Ordering, mpsc};
    let response = agent.get(url).call().map_err(download_error)?;
    if !(200..300).contains(&response.status().as_u16()) {
        return Err(CodedError::plain("ffmpeg_download_failed", format!("the FFmpeg download failed (HTTP {})", response.status())));
    }
    let total = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).filter(|t| *t > 0);
    progress.set_total(total);
    let mut body = response.into_body().into_with_config().limit(1024 * 1024 * 1024).reader();
    let (sender, receiver) = mpsc::sync_channel::<io::Result<Vec<u8>>>(8);
    std::thread::spawn(move || loop {
        let mut chunk = vec![0u8; 64 * 1024];
        match body.read(&mut chunk) {
            Ok(0) => {
                let _ = sender.send(Ok(Vec::new()));
                return;
            }
            Ok(n) => {
                chunk.truncate(n);
                if sender.send(Ok(chunk)).is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = sender.send(Err(error));
                return;
            }
        }
    });
    let mut archive = Vec::new();
    let mut last_byte = std::time::Instant::now();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CodedError::plain("ffmpeg_cancelled", "the FFmpeg download was cancelled."));
        }
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(chunk)) if chunk.is_empty() => break,
            Ok(Ok(chunk)) => {
                archive.extend_from_slice(&chunk);
                progress.add_downloaded(chunk.len() as u64);
                last_byte = std::time::Instant::now();
            }
            Ok(Err(e)) => return Err(CodedError::plain("ffmpeg_download_failed", format!("the FFmpeg download failed: {e}"))),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last_byte.elapsed() >= DOWNLOAD_IDLE_TIMEOUT {
                    return Err(CodedError::plain(
                        "ffmpeg_download_timeout",
                        "the FFmpeg download stalled: no data arrived for a minute.",
                    ));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(CodedError::plain("ffmpeg_download_failed", "the FFmpeg download ended unexpectedly."));
            }
        }
    }
    Ok(archive)
}

/// A ureq failure as our error: timeouts name the timeout, the rest stays short.
fn download_error(error: ureq::Error) -> CodedError {
    match error {
        ureq::Error::Timeout(_) => CodedError::plain("ffmpeg_download_timeout", "the FFmpeg download timed out."),
        _ => CodedError::plain("ffmpeg_download_failed", format!("the FFmpeg download failed: {error}")),
    }
}

/// Extract into `<managed>/ffmpeg-<nanos>.tmp`, then rename over `<managed>`.
/// The rename is the commit point: a kill before it leaves the previous
/// install (or nothing) in place, and the temp dir is swept next start.
fn install_archive(archive: &[u8]) -> Result<(), CodedError> {
    let dest = managed_dir();
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let temp = dest.with_file_name(format!("ffmpeg-{nanos}.tmp"));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp)
        .map_err(|e| CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {e}")))?;
    let result = extract_build(archive, &temp).and_then(|_| {
        flatten_build(&temp).map_err(|e| CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {e}")))
    });
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(error);
    }
    // Windows cannot rename over a non-empty dir: move the old one aside,
    // rename the temp in, and drop the backup. A kill between leaves either
    // the old install or a `.bak` the next sweep removes — never half files.
    let backup = dest.with_file_name(format!("ffmpeg-{nanos}.bak"));
    let _ = std::fs::remove_dir_all(&backup);
    if dest.exists() {
        if let Err(e) = std::fs::rename(&dest, &backup) {
            let _ = std::fs::remove_dir_all(&temp);
            return Err(CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {e}")));
        }
    }
    if let Err(e) = std::fs::rename(&temp, &dest) {
        // Put the old install back when the commit fails.
        if backup.exists() {
            let _ = std::fs::rename(&backup, &dest);
        }
        let _ = std::fs::remove_dir_all(&temp);
        return Err(CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {e}")));
    }
    let _ = std::fs::remove_dir_all(&backup);
    Ok(())
}

/// Move `ffmpeg.exe`/`ffprobe.exe` (and license/README text) from wherever
/// the zip put them (`bin/`, the top level) to the temp root, dropping the
/// rest. Matching is case-insensitive; only our own temp dir is walked.
fn flatten_build(temp: &Path) -> io::Result<()> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut stack = vec![temp.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let lower = name.to_lowercase();
                if matches!(lower.as_str(), "ffmpeg.exe" | "ffprobe.exe" | "license" | "license.txt" | "readme.txt") {
                    found.push(path);
                }
            }
        }
    }
    for path in found {
        let name = path.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "an archive entry had no name"))?;
        let target = temp.join(name);
        if path != target {
            if target.exists() {
                let _ = std::fs::remove_file(&target);
            }
            std::fs::rename(&path, &target)?;
        }
    }
    // Drop everything but the flattened files.
    for entry in std::fs::read_dir(temp)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            let lower = name.to_lowercase();
            if !matches!(lower.as_str(), "ffmpeg.exe" | "ffprobe.exe" | "license" | "license.txt" | "readme.txt") {
                std::fs::remove_file(&path)?;
            }
        }
    }
    Ok(())
}

/// Byte progress of the Windows download, shared with the job state.
#[derive(Debug, Default)]
struct DownloadProgress {
    downloaded: std::sync::atomic::AtomicU64,
    total: std::sync::atomic::AtomicU64,
}

impl DownloadProgress {
    fn new() -> Self {
        Self::default()
    }
    fn add_downloaded(&self, n: u64) {
        self.downloaded.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
    }
    fn set_total(&self, total: Option<u64>) {
        self.total.store(total.unwrap_or(0), std::sync::atomic::Ordering::Relaxed);
    }
    fn snapshot(&self) -> (u64, Option<u64>) {
        let downloaded = self.downloaded.load(std::sync::atomic::Ordering::Relaxed);
        let total = self.total.load(std::sync::atomic::Ordering::Relaxed);
        (downloaded, (total > 0).then_some(total))
    }
}

/// `brew install ffmpeg` can take many minutes (dependencies, bottles, sometimes
/// builds from source). The Windows download is ~115 MB; half an hour is
/// generous even on a bad connection.
static BREW_JOB: InstallJob = InstallJob::new(&BrewInstaller, Duration::from_secs(60 * 60));
static DOWNLOAD_JOB: InstallJob = InstallJob::new(&DownloadInstaller, Duration::from_secs(30 * 60));

/// The job this platform installs with. One slot per tool: macOS keeps the
/// brew slot, Windows the download slot; each platform only ever touches its own.
fn job() -> &'static InstallJob {
    if cfg!(windows) { &DOWNLOAD_JOB } else { &BREW_JOB }
}

/// Cancel flag the active download's fetch loops poll. The slot carries no
/// child pid for an in-process download, so cancel/timeout flip this instead.
#[allow(clippy::incompatible_msrv)]
static DOWNLOAD_CANCEL: std::sync::LazyLock<std::sync::Arc<std::sync::atomic::AtomicBool>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)));

fn download_cancel_flag() -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    std::sync::Arc::clone(&DOWNLOAD_CANCEL)
}

/// Start the download on a worker and mirror its progress into the
/// `DOWNLOAD_JOB` slot. Joins a running job; a finished one stays until the
/// next start. Cancellation flips the flag the fetch loops poll.
fn start_download() -> InstallState {
    use std::sync::atomic::Ordering;
    let job: &'static InstallJob = &DOWNLOAD_JOB;
    let already = job.with_slot(|slot| {
        if slot.state.is_active() {
            return Ok(slot.state.clone());
        }
        slot.generation += 1;
        let generation = slot.generation;
        slot.tail.clear();
        slot.pid = None;
        slot.state = DownloadInstaller.started();
        Err(generation)
    });
    let generation = match already {
        Ok(running) => return running,
        Err(generation) => generation,
    };
    let cancelled = download_cancel_flag();
    cancelled.store(false, Ordering::Relaxed);
    let progress = std::sync::Arc::new(DownloadProgress::new());
    let progress_tick = progress.clone();
    let cancelled_tick = cancelled.clone();
    std::thread::spawn(move || {
        // Mirror byte counts while the worker downloads.
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let alive = job.with_slot(|slot| slot.generation == generation && slot.state.is_active());
            if !alive {
                break;
            }
            let (downloaded, total) = progress_tick.snapshot();
            let done = job.with_slot(|slot| {
                if slot.generation != generation || !slot.state.is_active() {
                    return true;
                }
                slot.state.phase = if total.map(|t| downloaded >= t).unwrap_or(false) { "installing" } else { "downloading" };
                slot.state.downloaded = Some(downloaded);
                slot.state.total = total;
                false
            });
            if done || cancelled_tick.load(Ordering::Relaxed) {
                break;
            }
        }
    });
    let run = DownloadRun { job, generation, progress, cancelled: cancelled.clone() };
    std::thread::spawn(move || DownloadInstaller::run(run));
    // The watchdog: fail a download that outlives the timeout.
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(30 * 60);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let active = job.with_slot(|slot| slot.generation == generation && slot.state.is_active());
            if !active {
                return;
            }
            if std::time::Instant::now() >= deadline {
                job.with_slot(|slot| {
                    if slot.generation == generation && slot.state.is_active() {
                        slot.state = InstallState::failed_with(&CodedError::new(
                            "install_timeout",
                            "the install took longer than 30 minutes and was stopped",
                            serde_json::json!({ "minutes": 30 }),
                        ));
                    }
                });
                download_cancel_flag().store(true, Ordering::Relaxed);
                return;
            }
        }
    });
    job.state()
}

pub fn state() -> InstallState {
    job().state()
}

pub fn start() -> InstallState {
    if cfg!(windows) {
        return start_download();
    }
    BREW_JOB.start()
}

pub fn cancel() -> InstallState {
    if cfg!(windows) {
        let job = &DOWNLOAD_JOB;
        let now = job.state();
        if !now.is_active() {
            return now;
        }
        download_cancel_flag().store(true, std::sync::atomic::Ordering::Relaxed);
        job.with_slot(|slot| {
            if slot.state.is_active() {
                slot.state = InstallState::of("cancelled");
            }
        });
        return job.state();
    }
    BREW_JOB.cancel()
}

pub fn shutdown() {
    if cfg!(windows) {
        download_cancel_flag().store(true, std::sync::atomic::Ordering::Relaxed);
        DOWNLOAD_JOB.with_slot(|slot| {
            if slot.state.is_active() {
                slot.state = InstallState::of("cancelled");
            }
        });
        return;
    }
    BREW_JOB.shutdown();
}

#[cfg(test)]
pub fn reset() {
    if cfg!(windows) {
        download_cancel_flag().store(true, std::sync::atomic::Ordering::Relaxed);
    }
    BREW_JOB.reset();
    DOWNLOAD_JOB.reset();
}
/// Serializes every test that touches the FFmpeg env overrides
/// (`OPENVIDS_FFMPEG_DIR`, `OPENVIDS_FFMPEG_URL`, `OPENVIDS_FFMPEG_SHA256_URL`,
/// `HYPERFRAMES_*_PATH`): they are process-wide, so parallel tests would
/// otherwise read each other's values.
#[cfg(test)]
pub(crate) static FFMPEG_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_runner::tests::with_fake_cli;
    use crate::install_job::test_support::{process_alive, wait_for, wait_until_gone};
    use std::sync::Mutex;

    static FAKE_BREW_LOCK: Mutex<()> = Mutex::new(());

    // Bun scripts: the fake CLI (and the fake brew below) run on `bun`, which
    // is on PATH in dev/test on both platforms. `sh` scripts cannot run on
    // Windows, and `.cmd` cannot express the branching the tests need.
    #[cfg(unix)]
    const CLI_FOUND: &str = r#"console.log('{"tools":{"ffmpeg":{"found":true,"path":"/opt/homebrew/bin/ffmpeg","version":"9.0.2"},"ffprobe":{"found":true,"path":"/opt/homebrew/bin/ffprobe"},"chrome":{"found":false}}}')"#;
    #[cfg(windows)]
    const CLI_FOUND: &str = r#"console.log(JSON.stringify({tools:{ffmpeg:{found:true,path:"C:\\ffmpeg\\ffmpeg.exe",version:"9.0.2"},ffprobe:{found:true,path:"C:\\ffmpeg\\ffprobe.exe"},chrome:{found:false}}}))"#;
    #[cfg(unix)]
    const CLI_MISSING: &str = r#"console.log('{"tools":{"ffmpeg":{"found":false},"ffprobe":{"found":false},"chrome":{"found":false}}}')"#;
    #[cfg(windows)]
    const CLI_MISSING: &str = r#"console.log(JSON.stringify({tools:{ffmpeg:{found:false},ffprobe:{found:false},chrome:{found:false}}}))"#;

    /// Runs `body` with a fake `brew` (a bun script: argv branching works on
    /// both platforms) and a fake CLI answering the verification.
    fn with_fake_brew<T>(brew_script: &str, cli_script: &str, body: impl FnOnce(&Path) -> T) -> T {
        with_fake_cli(cli_script, || {
            let _guard = FAKE_BREW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let dir = std::env::temp_dir().join(format!(
                "openvids-fake-brew-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(dir.join("bin")).unwrap();
            let brew = dir.join("bin").join("brew.mjs");
            std::fs::write(&brew, brew_script).unwrap();
            std::env::set_var("OPENVIDS_BREW_PATH", &brew);
            // The user's own HOMEBREW_* settings reach brew on purpose; the fake brews model a user
            // without them (CI runners set HOMEBREW_NO_AUTO_UPDATE globally).
            let user_no_auto_update = std::env::var_os("HOMEBREW_NO_AUTO_UPDATE");
            std::env::remove_var("HOMEBREW_NO_AUTO_UPDATE");
            BREW_JOB.reset();
            let out = body(&dir);
            if let Some(value) = user_no_auto_update {
                std::env::set_var("HOMEBREW_NO_AUTO_UPDATE", value);
            }
            std::env::remove_var("OPENVIDS_BREW_PATH");
            let _ = std::fs::remove_dir_all(&dir);
            out
        })
    }

    #[cfg(unix)]
    fn status(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn status(code: u32) -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code)
    }

    #[test]
    fn output_lines_are_sanitised_into_one_bounded_line() {
        assert_eq!(sanitize_line("==> Downloading https://ghcr.io/v2/homebrew/core/x264/blobs").unwrap(), "Downloading https://ghcr.io/v2/homebrew/core/x264/blobs");
        assert_eq!(sanitize_line("\u{1b}[34m==>\u{1b}[0m \u{1b}[1mPouring ffmpeg--9.0.2.arm64.bottle.tar.gz\u{1b}[0m").unwrap(), "Pouring ffmpeg--9.0.2.arm64.bottle.tar.gz");
        // Progress bars redraw one line with \r: only the last redraw counts.
        assert_eq!(sanitize_line("Fetching x264\r######## 12.0%\rFetching x265").unwrap(), "Fetching x265");
        assert_eq!(sanitize_line("a\u{7}b\u{0}c\tfoo   bar").unwrap(), "abc foo bar");
        assert!(sanitize_line("######################## 100.0%").is_none());
        assert!(sanitize_line("   \r  ").is_none());
        assert!(sanitize_line("").is_none());
        let long = sanitize_line(&"x".repeat(1000)).unwrap();
        assert_eq!(long.chars().count(), DETAIL_CHARS);
        // Never more than one line, whatever it is fed.
        assert!(!sanitize_line("one\ntwo").unwrap().contains('\n'));
    }

    #[test]
    fn failures_get_a_one_line_reason_from_the_stderr_tail() {
        let tail = |lines: &[&str]| lines.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        assert_eq!(
            failure_reason(&tail(&["Warning: x", "Error: ffmpeg: no bottle available!"]), &status(1)).message,
            "Error: ffmpeg: no bottle available!"
        );
        assert_eq!(
            failure_reason(&tail(&["Error: boom", "trailing note"]), &status(1)).message,
            "Error: boom"
        );
        assert_eq!(failure_reason(&tail(&["just text"]), &status(1)).message, "just text");
        assert_eq!(failure_reason(&tail(&["just text"]), &status(1)).code, None);
        let failed = failure_reason(&[], &status(2));
        assert!(failed.message.contains("brew install ffmpeg"));
        assert_eq!(failed.code, Some("brew_failed"));
        for needs in [
            "sudo: a terminal is required to read the password",
            "Error: Need sudo access on macOS",
            "Please enter your password",
        ] {
            let reason = failure_reason(&tail(&[needs]), &status(1));
            assert!(reason.message.contains("Run `brew install ffmpeg` in Terminal"), "{}", reason.message);
            assert_eq!(reason.code, Some("brew_needs_terminal"));
        }
        assert!(looks_stale("Error: No available formula with the name \"ffmpeg\""));
        assert!(looks_stale("curl: (22) The requested URL returned error: 404"));
        assert!(!looks_stale("Error: disk full"));
    }

    #[test]
    fn brew_is_found_through_the_override_only_when_it_exists() {
        let _cli = crate::cli_runner::tests::FAKE_CLI_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _guard = FAKE_BREW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("OPENVIDS_BREW_PATH", "/definitely/not/brew");
        assert!(find_brew().is_none(), "an override that points nowhere is not a fallback to the system brew");
        std::env::remove_var("OPENVIDS_BREW_PATH");
    }

    #[test]
    fn a_successful_install_streams_detail_then_is_done_and_the_environment_is_sane() {
        let dir_probe = std::env::temp_dir().join(format!("openvids-brew-env-{}", std::process::id()));
        let probe_escaped = dir_probe.display().to_string().replace('\\', "\\\\");
        let mut script = format!(
            "const {{writeFileSync, readFileSync}} = await import('node:fs');\nconst p = '{p}';\nwriteFileSync(p, Object.entries(process.env).map(([k,v]) => k + '=' + v).join('\\n') + '\\nargs: ' + process.argv.slice(2).join(' ') + '\\n');\n",
            p = probe_escaped,
        );
        script.push_str("try { readFileSync('/dev/tty'); writeFileSync(p, '\\nHAS_TTY', {flag:'a'}); } catch { writeFileSync(p, '\\nNO_TTY', {flag:'a'}); }\n");
        // Reads stdin to EOF before the marker: a stdin left attached would block here and fail the test.
        script.push_str("for await (const _ of process.stdin) {}\nwriteFileSync(p, '\\nSTDIN_CLOSED', {flag:'a'});\n");
        script.push_str("console.log('==> Fetching ffmpeg');\nawait Bun.sleep(1000);\nconsole.log('==> Pouring ffmpeg--9.0.2.arm64.bottle.tar.gz');\nawait Bun.sleep(1000);\nconsole.error('done');\n");
        with_fake_brew(&script, CLI_FOUND, |_| {
            // Drive the brew slot directly: on Windows `start()` enters the
            // download slot, so the brew flow is unreachable through it.
            let first = BREW_JOB.start();
            assert_eq!(first.phase, "installing");
            let mid = wait_for(&BREW_JOB, "a streamed line", |s| {
                s.detail.as_deref() == Some("Fetching ffmpeg")
            });
            assert_eq!(mid.phase, "installing");
            // A second start while it runs joins it.
            let generation = BREW_JOB.generation();
            assert!(BREW_JOB.start().is_active());
            assert_eq!(BREW_JOB.generation(), generation);
            wait_for(&BREW_JOB, "the next line", |s| {
                s.detail.as_deref() == Some("Pouring ffmpeg--9.0.2.arm64.bottle.tar.gz")
            });
            let done = wait_for(&BREW_JOB, "done", |s| s.phase == "done");
            #[cfg(unix)]
            assert_eq!(done.path.as_deref(), Some("/opt/homebrew/bin/ffmpeg"));
            #[cfg(windows)]
            assert_eq!(done.path.as_deref(), Some("C:\\ffmpeg\\ffmpeg.exe"));
            assert_eq!(done.detail, None);
            assert_eq!(done.error, None);
            wait_for(&BREW_JOB, "reaped", |_| BREW_JOB.pid().is_none());
        });
        let seen = std::fs::read_to_string(&dir_probe).unwrap();
        let _ = std::fs::remove_file(&dir_probe);
        assert!(seen.contains("args: install ffmpeg"), "{seen}");
        for var in [
            "NONINTERACTIVE=1",
            "HOMEBREW_NO_ENV_HINTS=1",
            "HOMEBREW_NO_AUTO_UPDATE=1",
            "HOMEBREW_NO_INSTALL_UPGRADE=1",
            "HOMEBREW_NO_INSTALL_CLEANUP=1",
            "HOMEBREW_NO_ANALYTICS=1",
        ] {
            assert!(seen.lines().any(|l| l == var), "{var} missing in:\n{seen}");
        }
        let path_line = seen.lines().find(|l| l.starts_with("PATH=")).unwrap();
        assert!(path_line.contains("/bin:") && path_line.contains("/sbin") && path_line.contains(":/usr/bin:/bin"), "{path_line}");
        assert!(seen.contains("NO_TTY"), "brew has no controlling terminal");
        assert!(seen.contains("STDIN_CLOSED"), "stdin is closed, so nothing can wait on a prompt");
    }

    #[test]
    fn a_non_zero_exit_fails_with_the_reason_from_stderr() {
        with_fake_brew(
            "console.log('==> Fetching ffmpeg');\nconsole.error('Warning: noise');\nconsole.error('Error: ffmpeg: disk full');\nprocess.exit(1);\n",
            CLI_FOUND,
            |_| {
                BREW_JOB.start();
                let s = wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
                assert_eq!(s.error.as_deref(), Some("Error: ffmpeg: disk full"));
                assert_eq!(s.detail, None);
            },
        );
    }

    #[test]
    fn needing_sudo_or_a_prompt_fails_clearly_and_never_hangs() {
        let started = std::time::Instant::now();
        with_fake_brew(
            "console.error('sudo: a terminal is required to read the password; either use ssh or the -S option');\nprocess.exit(1);\n",
            CLI_FOUND,
            |_| {
                BREW_JOB.start();
                let s = wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
                assert!(s.error.unwrap().contains("Run `brew install ffmpeg` in Terminal"));
            },
        );
        // A brew that waits for input gets EOF immediately and gives up.
        // `Promise.race` with a timeout keeps the test fast even if the
        // runtime holds stdin open without EOF on some platform.
        with_fake_brew(
            "process.stderr.write('Press RETURN to continue: ');\nconst chunks = [];\nawait Promise.race([ (async () => { for await (const c of process.stdin) chunks.push(c); })(), Bun.sleep(2000) ]);\nconsole.error('Error: no input available');\nprocess.exit(1);\n",
            CLI_FOUND,
            |_| {
                BREW_JOB.start();
                let s = wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
                assert!(s.error.is_some());
            },
        );
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn a_stale_looking_failure_retries_once_with_auto_update_allowed() {
        let probe = std::env::temp_dir().join(format!("openvids-brew-attempts-{}", std::process::id()));
        let _ = std::fs::remove_file(&probe);
        let probe_escaped = probe.display().to_string().replace('\\', "\\\\");
        let mut script = format!(
            "const {{appendFileSync}} = await import('node:fs');\nappendFileSync('{p}', 'NO_AUTO_UPDATE=' + (process.env.HOMEBREW_NO_AUTO_UPDATE || 'unset') + '\\n');\n",
            p = probe_escaped,
        );
        script.push_str("if (process.env.HOMEBREW_NO_AUTO_UPDATE) { console.error('Error: No available formula with the name \"ffmpeg\"'); process.exit(1); }\n");
        script.push_str("console.log('==> Updating Homebrew');\n");
        with_fake_brew(&script, CLI_FOUND, |_| {
            BREW_JOB.start();
            let done = wait_for(&BREW_JOB, "done after the retry", |s| s.phase == "done");
            #[cfg(unix)]
            assert_eq!(done.path.as_deref(), Some("/opt/homebrew/bin/ffmpeg"));
            #[cfg(windows)]
            assert_eq!(done.path.as_deref(), Some("C:\\ffmpeg\\ffmpeg.exe"));
        });
        let attempts = std::fs::read_to_string(&probe).unwrap();
        let _ = std::fs::remove_file(&probe);
        assert_eq!(attempts.lines().collect::<Vec<_>>(), vec!["NO_AUTO_UPDATE=1", "NO_AUTO_UPDATE=unset"]);

        // A failure that is not about stale metadata is not retried.
        let counter = std::env::temp_dir().join(format!("openvids-brew-count-{}", std::process::id()));
        let _ = std::fs::remove_file(&counter);
        let counter_escaped = counter.display().to_string().replace('\\', "\\\\");
        let script = format!(
            "const {{appendFileSync}} = await import('node:fs');\nappendFileSync('{p}', 'run\\n');\nconsole.error('Error: disk full');\nprocess.exit(1);\n",
            p = counter_escaped,
        );
        with_fake_brew(&script, CLI_FOUND, |_| {
            BREW_JOB.start();
            wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
        });
        assert_eq!(std::fs::read_to_string(&counter).unwrap().lines().count(), 1);
        let _ = std::fs::remove_file(&counter);
    }

    #[test]
    fn a_retry_that_fails_again_is_one_failure() {
        with_fake_brew(
            "console.error('Error: No available formula with the name \"ffmpeg\"');\nprocess.exit(1);\n",
            CLI_FOUND,
            |_| {
                BREW_JOB.start();
                let s = wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
                assert!(s.error.unwrap().contains("No available formula"));
            },
        );
    }


    #[test]
    fn brew_succeeding_without_ffmpeg_findable_afterwards_is_a_failure() {
        with_fake_brew("console.log('==> Pouring');\n", CLI_MISSING, |_| {
            BREW_JOB.start();
            let s = wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
            assert!(s.error.unwrap().contains("not found afterwards"));
        });
    }

    #[test]
    fn cancel_kills_brew_and_everything_it_started_and_stays_cancelled() {
        let pid_file = std::env::temp_dir().join(format!("openvids-brew-sleeper-{}", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let pid_escaped = pid_file.display().to_string().replace('\\', "\\\\");
        let mut script = format!(
            "const {{writeFileSync}} = await import('node:fs');\nconst p = '{p}';\n",
            p = pid_escaped,
        );
        script.push_str("const {spawn} = await import('node:child_process');\n");
        script.push_str("const sleeper = spawn(process.execPath, ['-e', 'await new Promise(() => {});'], {stdio: 'ignore'});\n");
        script.push_str("writeFileSync(p, String(sleeper.pid));\n");
        script.push_str("console.log('==> Downloading x264');\nawait new Promise(() => {});\n");
        with_fake_brew(&script, CLI_FOUND, |_| {
            BREW_JOB.start();
            wait_for(&BREW_JOB, "downloading line", |s| s.detail.as_deref() == Some("Downloading x264"));
            let pid = BREW_JOB.pid().expect("a running job has a pid");
            let sleeper: u32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
            assert!(process_alive(pid) && process_alive(sleeper));
            assert_eq!(BREW_JOB.cancel().phase, "cancelled");
            wait_for(&BREW_JOB, "reaped", |_| BREW_JOB.pid().is_none());
            assert!(!process_alive(pid));
            wait_until_gone(sleeper);
            assert_eq!(BREW_JOB.state().phase, "cancelled");
            assert_eq!(BREW_JOB.cancel().phase, "cancelled");
        });
        let _ = std::fs::remove_file(&pid_file);
    }

    #[test]
    #[cfg(unix)]
    fn cancel_escalates_for_a_brew_that_ignores_sigterm() {
        let ignores_term = "process.on('SIGTERM', () => {});\nconsole.log('==> Building');\nsetInterval(() => {}, 1000);\n";
        with_fake_brew(ignores_term, CLI_FOUND, |_| {
            BREW_JOB.start();
            wait_for(&BREW_JOB, "running", |s| s.detail.as_deref() == Some("Building"));
            let pid = BREW_JOB.pid().unwrap();
            BREW_JOB.cancel();
            wait_for(&BREW_JOB, "killed after the grace period", |_| BREW_JOB.pid().is_none());
            assert!(!process_alive(pid));
        });
    }

    #[test]
    #[cfg(unix)]
    fn without_homebrew_start_is_a_clear_failure_and_nothing_runs() {
        let _cli = crate::cli_runner::tests::FAKE_CLI_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _guard = FAKE_BREW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("OPENVIDS_BREW_PATH", "/definitely/not/brew");
        BREW_JOB.reset();
        let s = BREW_JOB.start();
        std::env::remove_var("OPENVIDS_BREW_PATH");
        assert_eq!(s.phase, "failed");
        let error = s.error.unwrap();
        assert!(error.contains("Homebrew was not found") && error.contains("https://brew.sh"), "{error}");
    }

    #[test]
    fn shutdown_stops_a_running_install() {
        with_fake_brew("console.log('==> Fetching');\nawait new Promise(() => {});\n", CLI_FOUND, |_| {
            BREW_JOB.start();
            wait_for(&BREW_JOB, "running", |s| s.detail.as_deref() == Some("Fetching"));
            let pid = BREW_JOB.pid().unwrap();
            BREW_JOB.shutdown();
            wait_until_gone(pid);
            assert_eq!(BREW_JOB.state().phase, "cancelled");
        });
    }

    /// A tiny zip holding one `content` file at `path`, for the pure helpers.
    fn tiny_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        let mut out = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(&mut out);
        let options = zip::write::SimpleFileOptions::default();
        for (path, content) in entries {
            writer.start_file(*path, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
        out.into_inner()
    }

    /// A managed dir in a fresh private parent, so recovery and sweeps only ever see this test's siblings.
    fn with_managed_dir<T>(body: impl FnOnce() -> T) -> T {
        let _lock = FFMPEG_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!(
            "openvids-managed-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var("OPENVIDS_FFMPEG_DIR", root.join("ffmpeg"));
        let out = body();
        std::env::remove_var("OPENVIDS_FFMPEG_DIR");
        let _ = std::fs::remove_dir_all(&root);
        out
    }

    /// A complete managed install (both executables, `content` in each) at `dir`.
    fn write_install(dir: &Path, content: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("ffmpeg.exe"), content).unwrap();
        std::fs::write(dir.join("ffprobe.exe"), content).unwrap();
    }

    /// A directory link (symlink on Unix, a junction on Windows: no privilege needed). False when it cannot be made.
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .stdout(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        }
    }

    #[test]
    fn checksums_match_byte_for_byte() {
        let bytes = b"fake archive bytes";
        let hex = sha256_hex(bytes);
        assert_eq!(hex.len(), 64);
        verify_checksum(bytes, &hex).unwrap();
        verify_checksum(bytes, &hex.to_uppercase()).unwrap();
        let bad = verify_checksum(bytes, &"0".repeat(64)).unwrap_err();
        assert_eq!(bad.code, Some("ffmpeg_checksum_mismatch"));
        let unreadable = verify_checksum(bytes, "not a hash").unwrap_err();
        assert_eq!(unreadable.code, Some("ffmpeg_bad_checksum"));
    }

    #[test]
    fn zip_slip_entries_are_refused() {
        let evil = tiny_zip(&[("../../evil.exe", "x"), ("bin/ffmpeg.exe", "f"), ("bin/ffprobe.exe", "p")]);
        let dest = std::env::temp_dir().join(format!("openvids-slip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(&dest).unwrap();
        let err = extract_build(&evil, &dest).unwrap_err();
        assert_eq!(err.code, Some("ffmpeg_extract_failed"));
        let _ = std::fs::remove_dir_all(&dest);
        // Only the two executables (plus license text) land; the rest is dropped.
        let mixed = tiny_zip(&[("bin/ffmpeg.exe", "f"), ("bin/ffprobe.exe", "p"), ("bin/other.dll", "d"), ("LICENSE", "l")]);
        let dest2 = std::env::temp_dir().join(format!("openvids-kept-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest2);
        std::fs::create_dir_all(&dest2).unwrap();
        let kept = extract_build(&mixed, &dest2).unwrap();
        assert!(kept.contains(&"ffmpeg.exe".to_string()) && kept.contains(&"ffprobe.exe".to_string()));
        flatten_build(&dest2).unwrap();
        assert!(dest2.join("ffmpeg.exe").is_file() && dest2.join("ffprobe.exe").is_file());
        assert!(!dest2.join("bin/other.dll").exists());
        let _ = std::fs::remove_dir_all(&dest2);
    }

    #[test]
    fn installs_are_atomic_and_stale_temps_are_swept() {
        with_managed_dir(|| {
            let first = tiny_zip(&[("bin/ffmpeg.exe", "one"), ("bin/ffprobe.exe", "one"), ("LICENSE", "l")]);
            install_archive(&first).unwrap();
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"one");
            // A bad archive never touches the live install.
            assert!(install_archive(b"not a zip").is_err());
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"one");
            let second = tiny_zip(&[("ffmpeg.exe", "two"), ("ffprobe.exe", "two")]);
            install_archive(&second).unwrap();
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"two");
            // Stale temp/backup dirs from a killed download are swept on the next run.
            // They live next to the managed dir, not inside it.
            let parent = managed_dir().parent().map(Path::to_path_buf).unwrap();
            std::fs::create_dir_all(parent.join("ffmpeg-1.tmp")).unwrap();
            std::fs::create_dir_all(parent.join("ffmpeg-2.bak")).unwrap();
            std::fs::create_dir_all(parent.join("ffmpeg-keep")).unwrap();
            sweep_stale_temp_dirs().unwrap();
            assert!(!parent.join("ffmpeg-1.tmp").exists());
            assert!(!parent.join("ffmpeg-2.bak").exists());
            assert!(parent.join("ffmpeg-keep").exists());
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"two");
        });
    }

    #[test]
    fn a_first_install_creates_the_missing_parent_and_takes_the_lock_there() {
        with_managed_dir(|| {
            let parent = managed_dir().parent().map(Path::to_path_buf).unwrap();
            std::fs::remove_dir_all(&parent).unwrap();
            assert!(!parent.exists());
            let lock = try_managed_install_lock().unwrap().expect("nobody holds it");
            assert!(parent.is_dir() && managed_dir().with_extension("lock").is_file());
            // Held: a second taker is told so, not given an error or the lock.
            assert!(try_managed_install_lock().unwrap().is_none());
            drop(lock);
            assert!(try_managed_install_lock().unwrap().is_some(), "dropping the guard releases the lock");
            install_archive(&tiny_zip(&[("ffmpeg.exe", "f"), ("ffprobe.exe", "p")])).unwrap();
            assert!(managed_ffmpeg().is_some());
        });
    }

    #[test]
    fn a_missing_install_is_restored_from_the_newest_complete_backup() {
        with_managed_dir(|| {
            let parent = managed_dir().parent().map(Path::to_path_buf).unwrap();
            write_install(&parent.join("ffmpeg-100.bak"), "old");
            write_install(&parent.join("ffmpeg-300.bak"), "newest");
            write_install(&parent.join("ffmpeg-200.bak"), "newer");
            // A newer but incomplete backup must not win over a complete one.
            std::fs::create_dir_all(parent.join("ffmpeg-400.bak")).unwrap();
            std::fs::write(parent.join("ffmpeg-400.bak").join("ffmpeg.exe"), "half").unwrap();
            std::fs::create_dir_all(parent.join("ffmpeg-500.tmp")).unwrap();
            assert!(!managed_dir().exists());

            sweep_stale_temp_dirs().unwrap();

            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"newest");
            assert!(managed_ffmpeg().is_some() && managed_ffprobe().is_some());
            assert!(!parent.join("ffmpeg-300.bak").exists(), "the restored backup was moved");
            assert!(!parent.join("ffmpeg-500.tmp").exists());
        });
    }

    #[test]
    fn a_complete_install_makes_every_backup_garbage() {
        with_managed_dir(|| {
            let parent = managed_dir().parent().map(Path::to_path_buf).unwrap();
            write_install(&managed_dir(), "live");
            write_install(&parent.join("ffmpeg-1.bak"), "stale");
            sweep_stale_temp_dirs().unwrap();
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"live");
            assert!(!parent.join("ffmpeg-1.bak").exists());
        });
    }

    #[test]
    fn an_incomplete_install_keeps_its_backups_and_a_new_install_replaces_it() {
        with_managed_dir(|| {
            let parent = managed_dir().parent().map(Path::to_path_buf).unwrap();
            std::fs::create_dir_all(managed_dir()).unwrap();
            std::fs::write(managed_dir().join("ffmpeg.exe"), "half").unwrap();
            write_install(&parent.join("ffmpeg-1.bak"), "backup");
            sweep_stale_temp_dirs().unwrap();
            assert!(parent.join("ffmpeg-1.bak").join("ffprobe.exe").is_file(), "the only complete copy is kept");
            assert!(managed_ffmpeg().is_none());
            // The ordinary verified install flow replaces the broken directory.
            install_archive(&tiny_zip(&[("ffmpeg.exe", "new"), ("ffprobe.exe", "new")])).unwrap();
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"new");
            assert!(parent.join("ffmpeg-1.bak").exists(), "install_archive removes only its own backup");
        });
    }

    /// Makes renaming `backup` into its parent fail, the way an open handle from a virus scanner or a read-only
    /// parent does. The returned guard undoes it. `None` when this machine cannot be made to refuse (running as root).
    fn block_rename_of(backup: &Path) -> Option<Box<dyn std::any::Any>> {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_SHARE_READ only: a directory with such a handle open below it cannot be moved.
            let held = std::fs::OpenOptions::new().read(true).share_mode(1).open(backup.join("ffmpeg.exe")).ok()?;
            Some(Box::new(held))
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            struct Restore(PathBuf, std::fs::Permissions);
            impl Drop for Restore {
                fn drop(&mut self) {
                    let _ = std::fs::set_permissions(&self.0, self.1.clone());
                }
            }
            let parent = backup.parent()?.to_path_buf();
            let original = std::fs::metadata(&parent).ok()?.permissions();
            std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o555)).ok()?;
            let guard = Restore(parent.clone(), original);
            // Root ignores the mode: then nothing can be made to fail here.
            if std::fs::create_dir(parent.join("probe")).is_ok() {
                let _ = std::fs::remove_dir(parent.join("probe"));
                return None;
            }
            Some(Box::new(guard))
        }
    }

    #[test]
    fn a_refused_restore_keeps_the_backup_and_stops_the_replacement() {
        with_managed_dir(|| {
            let parent = managed_dir().parent().map(Path::to_path_buf).unwrap();
            let backup = parent.join("ffmpeg-1.bak");
            write_install(&backup, "only copy");
            let blocker = block_rename_of(&backup);
            // Only a root user on Unix can escape being blocked.
            assert!(!cfg!(windows) || blocker.is_some(), "an open handle must be possible on Windows");
            let Some(_blocker) = blocker else {
                return;
            };
            let error = sweep_stale_temp_dirs().unwrap_err();
            assert_eq!(error.code, Some("ffmpeg_extract_failed"));
            assert!(error.message.contains("restore"), "{error}");
            assert!(backup.join("ffmpeg.exe").is_file() && backup.join("ffprobe.exe").is_file());
            assert!(!managed_dir().exists());
        });
    }

    #[test]
    fn a_reparse_point_is_never_followed_by_the_sweep() {
        with_managed_dir(|| {
            let parent = managed_dir().parent().map(Path::to_path_buf).unwrap();
            let outside = parent.join("outside");
            write_install(&outside, "precious");
            // `ffmpeg-7.bak` is a link to a directory holding a complete-looking install.
            if !make_dir_link(&outside, &parent.join("ffmpeg-7.bak")) {
                return; // symlinks need privileges that this machine does not grant
            }
            sweep_stale_temp_dirs().unwrap();
            assert!(outside.join("ffmpeg.exe").is_file(), "the link target is untouched");
            assert!(!managed_dir().exists(), "a link is not a backup to restore");
        });
    }

    #[test]
    fn a_corrupt_download_never_disturbs_the_previous_install() {
        with_managed_dir(|| {
            write_install(&managed_dir(), "kept");
            let corrupt = b"these bytes are not the pinned build";
            let error = verify_checksum(corrupt, WINDOWS_BUILD_SHA256).unwrap_err();
            assert_eq!(error.code, Some("ffmpeg_checksum_mismatch"));
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"kept");
            // And an archive that passes the digest but is not a zip is refused before the swap.
            assert!(install_archive(corrupt).is_err());
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"kept");
        });
    }

    /// Runs in a separate process (see `startup_recovery_leaves_a_running_install_alone`): holds the install lock,
    /// keeps a working `.tmp`, tells its parent, and exits when stdin closes.
    #[test]
    #[ignore = "helper process for startup_recovery_leaves_a_running_install_alone"]
    fn lock_holder_process() {
        use std::io::{Read, Write};
        if std::env::var_os("OPENVIDS_TEST_LOCK_HOLDER").is_none() {
            return;
        }
        let _lock = try_managed_install_lock().unwrap().expect("the helper takes the free lock");
        let parent = managed_dir().parent().map(Path::to_path_buf).unwrap();
        std::fs::create_dir_all(parent.join("ffmpeg-42.tmp")).unwrap();
        std::fs::write(parent.join("ffmpeg-42.tmp").join("ffmpeg.exe"), "being written").unwrap();
        println!("HOLDING");
        std::io::stdout().flush().unwrap();
        let mut sink = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut sink);
    }

    #[test]
    fn startup_recovery_leaves_a_running_install_alone() {
        use std::io::{BufRead, BufReader};
        with_managed_dir(|| {
            let parent = managed_dir().parent().map(Path::to_path_buf).unwrap();
            write_install(&parent.join("ffmpeg-9.bak"), "backup");
            let mut holder = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "ffmpeg_install::tests::lock_holder_process", "--ignored", "--nocapture"])
                .env("OPENVIDS_TEST_LOCK_HOLDER", "1")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let mut lines = BufReader::new(holder.stdout.take().unwrap()).lines();
            loop {
                match lines.next() {
                    Some(Ok(line)) if line.trim() == "HOLDING" => break,
                    Some(Ok(_)) => continue,
                    other => panic!("the helper never took the lock: {other:?}"),
                }
            }

            // The holder's install is invisible to recovery: no restore, no cleanup.
            recover_managed_install().unwrap();
            assert!(parent.join("ffmpeg-42.tmp").join("ffmpeg.exe").is_file());
            assert!(parent.join("ffmpeg-9.bak").join("ffmpeg.exe").is_file());
            assert!(!managed_dir().exists());
            // A download started now is told to wait, and changes nothing either.
            let busy = acquire_install_lock().unwrap_err();
            assert_eq!(busy.code, Some("ffmpeg_extract_failed"));
            assert!(busy.message.contains("Another FFmpeg installation is in progress."), "{busy}");

            // The holder dies; its OS lock goes with it and the marker file does not block anything.
            holder.stdin.take();
            holder.wait().unwrap();
            recover_managed_install().unwrap();
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"backup");
            assert!(!parent.join("ffmpeg-42.tmp").exists());
            assert!(managed_dir().with_extension("lock").is_file(), "the lock file itself is never deleted");
        });
    }

    /// A server that sends the headers and 100 body bytes of a larger file, then goes quiet with the socket open.
    fn stalling_server() -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut head = [0u8; 4096];
                    let _ = stream.read(&mut head);
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n");
                    let _ = stream.write_all(&[0u8; 100]);
                    let _ = stream.flush();
                    // Quiet, not closed: what a stalled CDN connection looks like. Long enough for both cases below.
                    std::thread::sleep(Duration::from_secs(20));
                });
            }
        });
        format!("http://127.0.0.1:{port}/ffmpeg.zip")
    }

    #[test]
    fn a_stalled_download_fails_and_a_cancel_is_prompt_while_the_install_lock_is_released() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        let url = stalling_server();

        // No byte for the idle timeout (shortened in test builds): the download fails by itself.
        let progress = DownloadProgress::new();
        let started = std::time::Instant::now();
        let error = fetch_bytes(&agent, &url, &progress, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(error.code, Some("ffmpeg_download_timeout"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
        assert_eq!(progress.snapshot().0, 100, "what arrived before the stall was counted");

        // A cancel is seen within a tick although the read is blocked.
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::Relaxed);
        });
        let started = std::time::Instant::now();
        let error = fetch_bytes(&agent, &url, &DownloadProgress::new(), &cancelled).unwrap_err();
        assert_eq!(error.code, Some("ffmpeg_cancelled"));
        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());

        // And the install lock a flow like download_and_install holds is free again once it returns.
        with_managed_dir(|| {
            let guard = acquire_install_lock().unwrap();
            drop(guard);
            assert!(try_managed_install_lock().unwrap().is_some());
        });
    }

    #[test]
    fn download_sources_only_allow_the_pinned_host_or_loopback() {
        let _lock = FFMPEG_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("OPENVIDS_FFMPEG_URL", "http://evil.example/ffmpeg.zip");
        assert!(download_source().is_err());
        std::env::set_var("OPENVIDS_FFMPEG_URL", "https://evil.example/ffmpeg.zip");
        assert!(download_source().is_err());
        std::env::set_var("OPENVIDS_FFMPEG_URL", "http://127.0.0.1:9/ffmpeg.zip");
        std::env::set_var("OPENVIDS_FFMPEG_SHA256", "ab".repeat(32));
        let (url, sha) = download_source().unwrap();
        assert_eq!((&*url, &*sha), ("http://127.0.0.1:9/ffmpeg.zip", "ab".repeat(32).as_str()));
        std::env::remove_var("OPENVIDS_FFMPEG_URL");
        std::env::remove_var("OPENVIDS_FFMPEG_SHA256");
        let (url, sha) = download_source().unwrap();
        assert!(matches!((&url, &sha), (Cow::Borrowed(_), Cow::Borrowed(_))), "the pinned pair is not copied");
        assert_eq!((&*url, &*sha), (WINDOWS_BUILD_URL, WINDOWS_BUILD_SHA256));
        // The pinned URL carries the pinned build version.
        assert!(url.contains(WINDOWS_BUILD_VERSION));
        assert_eq!(WINDOWS_BUILD_SHA256.len(), 64);
    }

    #[test]
    fn managed_env_points_children_at_the_download_until_the_user_overrides() {
        with_managed_dir(|| {
            assert!(!managed_env().iter().any(|(k, _)| k.starts_with("HYPERFRAMES_")));
            std::fs::create_dir_all(managed_dir()).unwrap();
            std::fs::write(managed_dir().join("ffmpeg.exe"), "f").unwrap();
            std::fs::write(managed_dir().join("ffprobe.exe"), "p").unwrap();
            let env = managed_env();
            assert!(env.iter().any(|(k, v)| k == "HYPERFRAMES_FFMPEG_PATH" && v.ends_with("ffmpeg.exe")));
            assert!(env.iter().any(|(k, v)| k == "HYPERFRAMES_FFPROBE_PATH" && v.ends_with("ffprobe.exe")));
            // Tools that look ffmpeg up by name find the download first.
            let path = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone()).unwrap();
            assert_eq!(std::env::split_paths(&path).next(), Some(managed_dir()));
            std::env::set_var("HYPERFRAMES_FFMPEG_PATH", "C:\\user\\ffmpeg.exe");
            let env = managed_env();
            assert!(!env.iter().any(|(k, _)| k == "HYPERFRAMES_FFMPEG_PATH"));
            assert!(env.iter().any(|(k, _)| k == "HYPERFRAMES_FFPROBE_PATH"));
            std::env::remove_var("HYPERFRAMES_FFMPEG_PATH");
        });
    }

    #[test]
    fn child_path_adds_only_the_missing_tool_dirs_around_the_inherited_path() {
        let bin = |name: &str| std::env::temp_dir().join(name);
        let inherited = std::env::join_paths([bin("usr-bin"), bin("homebrew-bin")]).unwrap();
        let path = child_path(Some(inherited.clone()), &[bin("managed")], &[bin("homebrew-bin"), bin("local-bin")])
            .unwrap();
        assert_eq!(
            std::env::split_paths(&path).collect::<Vec<_>>(),
            vec![bin("managed"), bin("usr-bin"), bin("homebrew-bin"), bin("local-bin")]
        );
        // Everything already listed: the child keeps inheriting PATH as is.
        assert_eq!(child_path(Some(inherited), &[], &[bin("usr-bin")]), None);
        // A bare launchd environment with no PATH at all still gets the tool dirs.
        let path = child_path(None, &[], &[bin("homebrew-bin")]).unwrap();
        assert_eq!(std::env::split_paths(&path).collect::<Vec<_>>(), vec![bin("homebrew-bin")]);
    }
}
