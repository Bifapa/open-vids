//! The "Install with Homebrew" button for FFmpeg: one job that runs
//! `brew install ffmpeg` (the formula provides `ffprobe` too). OpenVids does not
//! download FFmpeg builds itself; Homebrew is the only supported installer.
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

use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::time::Duration;

use serde_json::json;

use super::cli_runner;
use super::coded_error::CodedError;
use super::install_job::{one_line, ExitAction, InstallJob, InstallState, Installer, Stream};

/// What the UI says before and while this runs.
pub const INSTALL_COMMAND: &str = "brew install ffmpeg";
pub const INSTALL_NOTE: &str =
    "Runs `brew install ffmpeg`. It may install many dependency packages and take several minutes.";
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
        let mut command = Command::new(&brew);
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
            // no controlling terminal, so nothing can prompt on /dev/tty.
            unsafe {
                command.pre_exec(|| {
                    libc::setsid();
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

/// `brew install ffmpeg` can take many minutes (dependencies, bottles, sometimes
/// builds from source).
static JOB: InstallJob = InstallJob::new(&BrewInstaller, Duration::from_secs(60 * 60));

pub fn state() -> InstallState {
    JOB.state()
}

pub fn start() -> InstallState {
    JOB.start()
}

pub fn cancel() -> InstallState {
    JOB.cancel()
}

pub fn shutdown() {
    JOB.shutdown()
}

#[cfg(test)]
pub fn reset() {
    JOB.reset()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_runner::tests::with_fake_cli;
    use crate::install_job::test_support::{process_alive, wait_for, wait_until_gone};
    use std::sync::Mutex;

    static FAKE_BREW_LOCK: Mutex<()> = Mutex::new(());

    const CLI_FOUND: &str = r#"echo '{"tools":{"ffmpeg":{"found":true,"path":"/opt/homebrew/bin/ffmpeg","version":"9.0.2"},"ffprobe":{"found":true,"path":"/opt/homebrew/bin/ffprobe"},"chrome":{"found":false}}}'"#;
    const CLI_MISSING: &str = r#"echo '{"tools":{"ffmpeg":{"found":false},"ffprobe":{"found":false},"chrome":{"found":false}}}'"#;

    /// Runs `body` with a fake `brew` (a script run by the shell, via `#!/bin/sh`)
    /// and a fake CLI answering the verification.
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
            let brew = dir.join("bin").join("brew");
            std::fs::write(&brew, format!("#!/bin/sh\n{brew_script}")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&brew, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            std::env::set_var("OPENVIDS_BREW_PATH", &brew);
            JOB.reset();
            let out = body(&dir);
            std::env::remove_var("OPENVIDS_BREW_PATH");
            let _ = std::fs::remove_dir_all(&dir);
            out
        })
    }

    fn status(code: i32) -> ExitStatus {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            ExitStatus::from_raw(code << 8)
        }
        #[cfg(not(unix))]
        {
            let _ = code;
            unimplemented!()
        }
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
        let script = format!(
            r#"
env > '{probe}'
echo "args: $*" >> '{probe}'
(: < /dev/tty) 2>/dev/null && echo HAS_TTY >> '{probe}' || echo NO_TTY >> '{probe}'
read -r answer && echo "STDIN_DATA" >> '{probe}' || echo "STDIN_CLOSED" >> '{probe}'
echo "==> Fetching ffmpeg"
sleep 1
echo "==> Pouring ffmpeg--9.0.2.arm64.bottle.tar.gz"
sleep 1
echo "done" >&2
"#,
            probe = dir_probe.display()
        );
        with_fake_brew(&script, CLI_FOUND, |_| {
            let first = start();
            assert_eq!(first.phase, "installing");
            let mid = wait_for(&JOB, "a streamed line", |s| {
                s.detail.as_deref() == Some("Fetching ffmpeg")
            });
            assert_eq!(mid.phase, "installing");
            // A second start while it runs joins it.
            let generation = JOB.generation();
            assert!(start().is_active());
            assert_eq!(JOB.generation(), generation);
            wait_for(&JOB, "the next line", |s| {
                s.detail.as_deref() == Some("Pouring ffmpeg--9.0.2.arm64.bottle.tar.gz")
            });
            let done = wait_for(&JOB, "done", |s| s.phase == "done");
            assert_eq!(done.path.as_deref(), Some("/opt/homebrew/bin/ffmpeg"));
            assert_eq!(done.detail, None);
            assert_eq!(done.error, None);
            wait_for(&JOB, "reaped", |_| JOB.pid().is_none());
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
            "echo '==> Fetching ffmpeg'\necho 'Warning: noise' >&2\necho 'Error: ffmpeg: disk full' >&2\nexit 1\n",
            CLI_FOUND,
            |_| {
                start();
                let s = wait_for(&JOB, "failed", |s| s.phase == "failed");
                assert_eq!(s.error.as_deref(), Some("Error: ffmpeg: disk full"));
                assert_eq!(s.detail, None);
            },
        );
    }

    #[test]
    fn needing_sudo_or_a_prompt_fails_clearly_and_never_hangs() {
        let started = std::time::Instant::now();
        with_fake_brew(
            "echo 'sudo: a terminal is required to read the password; either use ssh or the -S option' >&2\nexit 1\n",
            CLI_FOUND,
            |_| {
                start();
                let s = wait_for(&JOB, "failed", |s| s.phase == "failed");
                assert!(s.error.unwrap().contains("Run `brew install ffmpeg` in Terminal"));
            },
        );
        // A brew that waits for input gets EOF immediately and gives up.
        with_fake_brew(
            "printf 'Press RETURN to continue: ' >&2\nread -r answer || { echo 'Error: no input available' >&2; exit 1; }\necho unexpectedly-read >&2\n",
            CLI_FOUND,
            |_| {
                start();
                let s = wait_for(&JOB, "failed", |s| s.phase == "failed");
                assert!(s.error.is_some());
            },
        );
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn a_stale_looking_failure_retries_once_with_auto_update_allowed() {
        let probe = std::env::temp_dir().join(format!("openvids-brew-attempts-{}", std::process::id()));
        let _ = std::fs::remove_file(&probe);
        let script = format!(
            r#"
echo "NO_AUTO_UPDATE=${{HOMEBREW_NO_AUTO_UPDATE:-unset}}" >> '{probe}'
if [ -n "$HOMEBREW_NO_AUTO_UPDATE" ]; then
  echo 'Error: No available formula with the name "ffmpeg"' >&2
  exit 1
fi
echo '==> Updating Homebrew'
"#,
            probe = probe.display()
        );
        with_fake_brew(&script, CLI_FOUND, |_| {
            start();
            let done = wait_for(&JOB, "done after the retry", |s| s.phase == "done");
            assert_eq!(done.path.as_deref(), Some("/opt/homebrew/bin/ffmpeg"));
        });
        let attempts = std::fs::read_to_string(&probe).unwrap();
        let _ = std::fs::remove_file(&probe);
        assert_eq!(attempts.lines().collect::<Vec<_>>(), vec!["NO_AUTO_UPDATE=1", "NO_AUTO_UPDATE=unset"]);

        // A failure that is not about stale metadata is not retried.
        let counter = std::env::temp_dir().join(format!("openvids-brew-count-{}", std::process::id()));
        let _ = std::fs::remove_file(&counter);
        let script = format!("echo run >> '{}'\necho 'Error: disk full' >&2\nexit 1\n", counter.display());
        with_fake_brew(&script, CLI_FOUND, |_| {
            start();
            wait_for(&JOB, "failed", |s| s.phase == "failed");
        });
        assert_eq!(std::fs::read_to_string(&counter).unwrap().lines().count(), 1);
        let _ = std::fs::remove_file(&counter);
    }

    #[test]
    fn a_retry_that_fails_again_is_one_failure() {
        with_fake_brew(
            "echo 'Error: No available formula with the name \"ffmpeg\"' >&2\nexit 1\n",
            CLI_FOUND,
            |_| {
                start();
                let s = wait_for(&JOB, "failed", |s| s.phase == "failed");
                assert!(s.error.unwrap().contains("No available formula"));
            },
        );
    }

    #[test]
    fn brew_succeeding_without_ffmpeg_findable_afterwards_is_a_failure() {
        with_fake_brew("echo '==> Pouring'\n", CLI_MISSING, |_| {
            start();
            let s = wait_for(&JOB, "failed", |s| s.phase == "failed");
            assert!(s.error.unwrap().contains("not found afterwards"));
        });
    }

    #[test]
    fn cancel_kills_brew_and_everything_it_started_and_stays_cancelled() {
        let pid_file = std::env::temp_dir().join(format!("openvids-brew-sleeper-{}", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let script = format!(
            "sleep 60 &\necho $! > '{}'\necho '==> Downloading x264'\nsleep 60\n",
            pid_file.display()
        );
        with_fake_brew(&script, CLI_FOUND, |_| {
            start();
            wait_for(&JOB, "downloading line", |s| s.detail.as_deref() == Some("Downloading x264"));
            let pid = JOB.pid().expect("a running job has a pid");
            let sleeper: u32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
            assert!(process_alive(pid) && process_alive(sleeper));
            assert_eq!(cancel().phase, "cancelled");
            wait_for(&JOB, "reaped", |_| JOB.pid().is_none());
            assert!(!process_alive(pid));
            wait_until_gone(sleeper);
            assert_eq!(state().phase, "cancelled");
            assert_eq!(cancel().phase, "cancelled");
        });
        let _ = std::fs::remove_file(&pid_file);
    }

    #[test]
    fn cancel_escalates_for_a_brew_that_ignores_sigterm() {
        with_fake_brew("trap '' TERM\necho '==> Building'\nwhile true; do sleep 1; done\n", CLI_FOUND, |_| {
            start();
            wait_for(&JOB, "running", |s| s.detail.as_deref() == Some("Building"));
            let pid = JOB.pid().unwrap();
            cancel();
            wait_for(&JOB, "killed after the grace period", |_| JOB.pid().is_none());
            assert!(!process_alive(pid));
        });
    }

    #[test]
    fn without_homebrew_start_is_a_clear_failure_and_nothing_runs() {
        let _cli = crate::cli_runner::tests::FAKE_CLI_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _guard = FAKE_BREW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("OPENVIDS_BREW_PATH", "/definitely/not/brew");
        JOB.reset();
        let s = start();
        std::env::remove_var("OPENVIDS_BREW_PATH");
        assert_eq!(s.phase, "failed");
        let error = s.error.unwrap();
        assert!(error.contains("Homebrew was not found") && error.contains("https://brew.sh"), "{error}");
    }

    #[test]
    fn shutdown_stops_a_running_install() {
        with_fake_brew("echo '==> Fetching'\nsleep 60\n", CLI_FOUND, |_| {
            start();
            wait_for(&JOB, "running", |s| s.detail.as_deref() == Some("Fetching"));
            let pid = JOB.pid().unwrap();
            shutdown();
            wait_until_gone(pid);
            assert_eq!(state().phase, "cancelled");
        });
    }
}
