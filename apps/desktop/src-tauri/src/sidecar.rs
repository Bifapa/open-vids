//! The production Studio backend: `hyperframes preview` in embedded mode.
//!
//! This deliberately reuses the CLI's own embedded server rather than
//! reimplementing it. `createStudioServer()` serves the prebuilt Studio SPA and
//! mounts the Studio API on the same listener, so the composition iframe stays
//! same-origin with the editor without any bridge — the property the editor
//! needs for its `contentDocument` access.
//!
//! The CLI prints a machine-readable lifecycle line on stdout
//! (`preview --json`), which carries the port it actually bound. Rust reads that
//! line, then polls the HTTP API until the server answers, because a bound
//! socket is not the same thing as a server ready to serve.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;

use super::coded_error::CodedError;

/// How long to wait for the CLI to report the port it bound.
const PORT_REPORT_TIMEOUT: Duration = Duration::from_secs(45);
/// How long to wait for the bound port to actually serve the Studio API.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// How long the Studio runtime gets to shut down cleanly before SIGKILL.
const TERM_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug)]
pub enum SidecarError {
    Spawn(std::io::Error),
    NoPortReport(String),
    BadLifecycle(String),
    NotReady(String),
    Spawned(String),
}

impl std::fmt::Display for SidecarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(err) => write!(f, "could not start the Studio runtime: {err}"),
            Self::NoPortReport(last) => write!(
                f,
                "the Studio runtime did not report a port within {:?}: {last}",
                PORT_REPORT_TIMEOUT
            ),
            Self::BadLifecycle(detail) => {
                write!(
                    f,
                    "the Studio runtime reported an unusable lifecycle line: {detail}"
                )
            }
            Self::NotReady(last) => write!(
                f,
                "the Studio runtime bound port {last} but never served /api/projects"
            ),
            Self::Spawned(detail) => {
                write!(f, "the Studio runtime exited during startup: {detail}")
            }
        }
    }
}

impl SidecarError {
    /// The same sentence as `Display`, with the code and params the page translates it by.
    pub fn coded(&self) -> CodedError {
        let message = self.to_string();
        match self {
            Self::Spawn(err) => {
                CodedError::new("studio_start_failed", message, json!({ "detail": err.to_string() }))
            }
            Self::NoPortReport(last) => CodedError::new(
                "studio_no_port",
                message,
                json!({ "seconds": PORT_REPORT_TIMEOUT.as_secs(), "detail": last }),
            ),
            Self::BadLifecycle(detail) => {
                CodedError::new("studio_bad_lifecycle", message, json!({ "detail": detail }))
            }
            Self::NotReady(port) => CodedError::new("studio_not_ready", message, json!({ "port": port })),
            Self::Spawned(detail) => CodedError::new("studio_exited", message, json!({ "detail": detail })),
        }
    }
}

impl std::error::Error for SidecarError {}

/// A running Studio backend plus the loopback URL the webview must load.
///
/// Dropping this kills the whole process group, so every exit path — window
/// close, Cmd+Q, a panic on the main thread — reaps the runtime rather than
/// leaving an orphaned server holding a port.
pub struct StudioServer {
    child: Option<Child>,
    pub port: u16,
    pub host: String,
}

impl StudioServer {
    pub fn origin(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    /// The exit status, once the process has ended.
    fn exited(&mut self) -> Option<std::process::ExitStatus> {
        self.child
            .as_mut()
            .and_then(|child| child.try_wait().ok().flatten())
    }
}

/// The Studio deep link for a project (dev server or this sidecar).
///
/// The embedded server is single-project and resolves the project id from
/// the directory name, so the fragment is the only thing that can name it.
/// The query carries what the desktop tells Studio (contract 2): `openvidsHome`
/// (where the Projects page lives, for the header's back button),
/// `openvidsTheme` (the resolved theme for first paint), `openvidsLanguage`
/// (the raw `language` preference — `system` or a locale code — which Studio
/// resolves itself) and, when the open asks for one, `openvidsWorkspace`. On
/// Windows without the system frame it also carries `openvidsFrame=custom`
/// (or `=system` under the `OPENVIDS_SYSTEM_FRAME=1` fallback), so the Studio
/// header knows which titlebar chrome to draw; on macOS the parameter is
/// absent and the header keeps its traffic-light inset. With beta features on
/// (`channel::beta_features_enabled`) it ends with `openvidsChannel=beta`;
/// stable builds omit it. A query survives View
/// \> Reload (it outlives hash rewrites) and the prod Hono server ignores it
/// via its SPA fallback.
#[allow(clippy::too_many_arguments)]
pub fn studio_url(
    studio_origin: &str,
    project_id: &str,
    home_origin: &str,
    theme: &str,
    language: &str,
    workspace: Option<&str>,
    frame: &str,
    beta: bool,
) -> String {
    let mut query = format!(
        "openvidsHome={}&openvidsTheme={}&openvidsLanguage={}",
        urlencode(home_origin),
        urlencode(theme),
        urlencode(language)
    );
    if let Some(workspace) = workspace {
        query.push_str(&format!("&openvidsWorkspace={}", urlencode(workspace)));
    }
    // The overlay frame is the default (macOS): no parameter, so existing
    // links and tests stay byte-identical. Any other frame kind is explicit.
    if frame != "overlay" {
        query.push_str(&format!("&openvidsFrame={}", urlencode(frame)));
    }
    if beta {
        query.push_str("&openvidsChannel=beta");
    }
    format!("{studio_origin}/?{query}#project/{}", urlencode(project_id))
}

impl Drop for StudioServer {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            terminate(&mut child);
        }
    }
}

/// Percent-encode the characters Studio's `isValidProjectId` lets through but
/// that would otherwise change the meaning of a URL path or fragment.
pub fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Reap the sidecar's whole tree when the app shuts down.
///
/// This is the normal teardown path, and it works: measured in the ad-hoc-signed
/// `OpenVids.app`, `libc::killpg(pgid, SIGTERM)` returns 0 and the full
/// graceful-then-fatal sequence runs. An earlier version of this comment said
/// the call returned `EPERM`; that was measured before `--foreground` was
/// added, when the CLI re-exec'd itself detached, so the pid the app held was
/// not the group it then signalled. With `--foreground` the child is the CLI
/// itself, inside the group this process created.
///
/// It cannot cover the cases where OpenVids' own code never runs — a
/// `SIGKILL`, a crash, a logout — because then nothing gets to call this. That
/// is what `sidecar/serve.mjs` (unix) and the kill-on-close Job Object
/// (`crate::proc`, Windows) are for; see "Teardown" in the README.
fn terminate(child: &mut Child) {
    crate::proc::terminate(child, TERM_GRACE);
}

/// Reserve a loopback port from the OS and hand it back.
///
/// The Studio runtime takes a starting port and scans upward from it; it does
/// not accept port 0. Binding an ephemeral port and immediately releasing it is
/// the closest approximation, and the runtime's own scan covers the race.
fn reserve_loopback_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn lifecycle_port(line: &str) -> Result<u16, SidecarError> {
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|err| SidecarError::BadLifecycle(format!("{err}: {line}")))?;
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let detail = value
            .get("error")
            .map(|e| e.to_string())
            .unwrap_or_else(|| line.to_string());
        return Err(SidecarError::BadLifecycle(detail));
    }
    value
        .get("result")
        .and_then(|r| r.get("port"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .ok_or_else(|| SidecarError::BadLifecycle(format!("no result.port in {line}")))
}

/// Ask the bound port for the cheapest proof that the Studio API is live.
fn probe_ready(port: u16) -> std::io::Result<bool> {
    let addr: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidInput, err))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.write_all(
        b"GET /api/projects HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAccept: application/json\r\n\r\n",
    )?;
    let mut reader = BufReader::new(stream);
    let mut status = String::new();
    reader.read_line(&mut status)?;
    Ok(status.contains(" 200"))
}

/// Start the embedded Studio server for `project_dir` and wait until it serves.
///
/// `bun` and `cli.js` are both app resources; nothing here refers to the
/// monorepo, so the built .app is self-contained.
pub fn start(
    launcher: &Path,
    bun: &Path,
    cli: &Path,
    project_dir: &Path,
    log: Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<StudioServer, SidecarError> {
    let port = reserve_loopback_port().map_err(SidecarError::Spawn)?;

    let mut command = Command::new(bun);
    command
        // The runtime is the shipped tree; a module that fails to resolve must
        // fail, not be fetched from npm (Bun auto-installs without this flag).
        .arg("--no-install")
        .arg(launcher)
        .arg(cli)
        .arg("preview")
        // `--json` turns the human summary into one machine-readable line on
        // stdout; `--no-open` keeps the Tauri window the only browser.
        .arg("--json")
        .arg("--no-open")
        // Without `--foreground`, the CLI reads a non-TTY stdin as "run this in
        // the background": it re-execs itself detached and the original process
        // exits, so nothing is left for the launcher to supervise and a server
        // survives the app. `--foreground` keeps it attached, which is what the
        // launcher watches.
        .arg("--foreground")
        .arg("--port")
        .arg(port.to_string())
        .arg(project_dir)
        .current_dir(cli.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Project folders are untrusted input: the sidecar serves its bundled
    // Studio and never a `@hyperframes/studio` found next to a project.
    command.env("OPENVIDS_EMBEDDED_STUDIO", "1");
    for (key, value) in super::ffmpeg_install::managed_env() {
        command.env(key, value);
    }

    // Own supervision scope, so terminate() stops the CLI and every browser
    // it spawned in one shot (process group on unix, Job Object on Windows).
    crate::proc::configure(&mut command);

    launch(command, log, PORT_REPORT_TIMEOUT, READY_TIMEOUT)
}

/// Spawn `command` (already configured for supervision) and wait until it
/// reports a port and serves. The child belongs to the returned
/// `StudioServer` from the moment it exists, so every failure return drops it
/// and `StudioServer::drop` terminates its whole tree: a runtime that never
/// became ready must not keep running (holding a port and any browser it
/// started) after the caller has reported the failure.
fn launch(
    mut command: Command,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    report_timeout: Duration,
    ready_timeout: Duration,
) -> Result<StudioServer, SidecarError> {
    let child = command.spawn().map_err(SidecarError::Spawn)?;
    crate::proc::track(&child);
    let mut server = StudioServer {
        child: Some(child),
        port: 0,
        host: "127.0.0.1".to_string(),
    };
    let (stdout, stderr) = match server.child.as_mut() {
        Some(child) => (child.stdout.take(), child.stderr.take()),
        None => (None, None),
    };

    if let Some(stderr) = stderr {
        // Surface runtime diagnostics in the app's own log instead of dropping
        // them on a pipe nobody reads.
        let log = Arc::clone(&log);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log(&format!("[studio] {line}"));
            }
        });
    }

    let (tx, rx) = mpsc::channel::<String>();
    if let Some(stdout) = stdout {
        // The reader owns the pipe for the child's whole life: every line is
        // logged, and only the startup wait gets a copy. Once `launch` stops
        // listening, lines still drain (a closed read end would break the
        // child's later writes) and keep reaching the log.
        thread::spawn(move || {
            let mut waiter = Some(tx);
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log(&format!("[studio] {line}"));
                if let Some(sender) = &waiter {
                    if sender.send(line).is_err() {
                        waiter = None;
                    }
                }
            }
        });
    }

    let mut last_line = String::new();
    let report_deadline = Instant::now() + report_timeout;
    let bound_port = loop {
        if Instant::now() >= report_deadline {
            return Err(SidecarError::NoPortReport(last_line));
        }
        match rx.recv_timeout(READY_POLL_INTERVAL) {
            Ok(line) => {
                if line.trim().is_empty() {
                    continue;
                }
                last_line = line.clone();
                if let Ok(port) = lifecycle_port(&line) {
                    break port;
                }
                // Anything on stdout before the lifecycle line is noise, not a
                // failure: keep waiting for the real report.
            }
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                if let Some(status) = server.exited() {
                    return Err(SidecarError::Spawned(format!(
                        "exit {status} before reporting a port; last output: {last_line}"
                    )));
                }
            }
        }
    };
    server.port = bound_port;

    // A bound socket is not a ready server. Poll the API itself.
    let deadline = Instant::now() + ready_timeout;
    let mut last_error = String::new();
    while Instant::now() < deadline {
        if let Some(status) = server.exited() {
            return Err(SidecarError::Spawned(format!(
                "exit {status} before serving; last output: {last_line}"
            )));
        }
        match probe_ready(bound_port) {
            Ok(true) => return Ok(server),
            Ok(false) => last_error = format!("port {bound_port} answered with a non-200 status"),
            Err(err) => last_error = format!("port {bound_port}: {err}"),
        }
        thread::sleep(READY_POLL_INTERVAL);
    }
    Err(SidecarError::NotReady(last_error))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A stand-in runtime: records its pid, runs `body`, then stays alive.
    fn fake_runtime(dir: &Path, body: &str) -> (Command, PathBuf) {
        let pid_file = dir.join("pid");
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(format!("echo $$ > '{}'; {body}; exec sleep 30", pid_file.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::proc::configure(&mut command);
        (command, pid_file)
    }

    fn quiet() -> Arc<dyn Fn(&str) + Send + Sync> {
        Arc::new(|_| {})
    }

    fn alive(pid_file: &Path) -> bool {
        let pid: libc::pid_t = std::fs::read_to_string(pid_file)
            .expect("the fake runtime wrote its pid")
            .trim()
            .parse()
            .expect("a pid");
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openvids-sidecar-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn a_runtime_that_never_reports_a_port_is_terminated() {
        let dir = temp_dir("no-port");
        let (command, pid_file) = fake_runtime(&dir, "true");
        let result = launch(command, quiet(), Duration::from_millis(700), Duration::from_secs(5));
        assert!(matches!(result, Err(SidecarError::NoPortReport(_))));
        assert!(!alive(&pid_file), "the runtime must not outlive the failed start");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_runtime_that_binds_but_never_serves_is_terminated() {
        let dir = temp_dir("not-ready");
        let closed_port = reserve_loopback_port().expect("a free port");
        let report = format!("echo '{{\"ok\":true,\"result\":{{\"port\":{closed_port}}}}}'");
        let (command, pid_file) = fake_runtime(&dir, &report);
        let result = launch(command, quiet(), Duration::from_secs(5), Duration::from_millis(700));
        assert!(matches!(result, Err(SidecarError::NotReady(_))));
        assert!(!alive(&pid_file), "the runtime must not outlive the failed start");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_runtime_that_exits_early_reports_its_last_output() {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("echo boom; exit 3")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::proc::configure(&mut command);
        match launch(command, quiet(), Duration::from_secs(5), Duration::from_secs(5)) {
            Err(SidecarError::Spawned(detail)) => assert!(detail.contains("boom"), "{detail}"),
            Err(other) => panic!("expected an early-exit error, got {other}"),
            Ok(_) => panic!("expected an early-exit error"),
        }
    }

    #[test]
    fn stdout_written_after_startup_still_reaches_the_log() {
        let dir = temp_dir("late-stdout");
        // A stand-in Studio API: answers every request with 200.
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 512];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
        });
        let body = format!(
            "echo '{{\"ok\":true,\"result\":{{\"port\":{port}}}}}'; sleep 1; echo late-render-diagnostic"
        );
        let (command, pid_file) = fake_runtime(&dir, &body);
        let lines = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&lines);
        let log: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line| {
            if let Ok(mut lines) = sink.lock() {
                lines.push(line.to_string());
            }
        });
        let server = launch(command, log, Duration::from_secs(5), Duration::from_secs(5))
            .unwrap_or_else(|err| panic!("the stand-in runtime should start: {err}"));
        let deadline = Instant::now() + Duration::from_secs(5);
        let seen = loop {
            let found = lines
                .lock()
                .map(|l| l.iter().any(|line| line.contains("late-render-diagnostic")))
                .unwrap_or(false);
            if found || Instant::now() >= deadline {
                break found;
            }
            thread::sleep(Duration::from_millis(50));
        };
        drop(server);
        assert!(seen, "stdout after the lifecycle line must be logged");
        assert!(!alive(&pid_file));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
