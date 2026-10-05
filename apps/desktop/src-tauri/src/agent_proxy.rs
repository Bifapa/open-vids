//! The agent runtime, for the Projects page (contract 7).
//!
//! The Projects page needs the model catalog and the global agent defaults
//! before any project — and so any Studio sidecar with its own agent gateway —
//! exists. The home server therefore owns a second, project-less instance of
//! the same runtime process (`packages/agent-runtime`), started lazily on the
//! first request and reused for the app's lifetime:
//!
//! - launched as `bun <entry>` with `OPENVIDS_AGENT_TOKEN` (fresh per launch,
//!   never sent to the webview), `OPENVIDS_AGENT_PORT=0` and
//!   `OPENVIDS_AGENT_PARENT_PID` (the runtime exits when this process dies);
//! - ready once it printed its `{"openvids-agent":"listening","port":N}` line
//!   and `GET /v1/health` answers;
//! - placed in its own supervision scope (`crate::proc`: process group on
//!   unix, Job Object on Windows) and killed with it on shutdown.
//!
//! Only the global routes are proxied (`/v1/models`, `/v1/settings`); they
//! need the bearer token and no project scope. Settings live in
//! `~/.openvids/agent/`, so both runtime instances read and write the same file.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;

use super::coded_error::CodedError;
use super::logfile;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);

/// Where and how to reach the running runtime. Cloned out of `RUNTIME` so a
/// request never runs under its lock; `id` tells a retry whether the runtime
/// it failed against is still the current one.
#[derive(Clone)]
struct Endpoint {
    id: u64,
    port: u16,
    token: String,
}

struct Running {
    child: Child,
    endpoint: Endpoint,
}

/// The runtime. Held only to read or replace the handle, never across a
/// start or a request.
static RUNTIME: Mutex<Option<Running>> = Mutex::new(None);
/// Serializes starts, so concurrent first requests spawn one runtime.
static START: Mutex<()> = Mutex::new(());
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static PROD_ENTRY: Mutex<Option<(PathBuf, PathBuf)>> = Mutex::new(None);

/// Production: the staged runtime (`Resources/agent-runtime/main.ts`) and bun.
pub fn set_production_launch(bun: PathBuf, entry: PathBuf) {
    if let Ok(mut slot) = PROD_ENTRY.lock() {
        *slot = Some((bun, entry));
    }
}

/// `(bun, entry)`: env overrides, else the staged production runtime, else
/// the workspace source (dev).
fn launch() -> Option<(PathBuf, PathBuf)> {
    let bun_override = std::env::var_os("OPENVIDS_AGENT_BUN").map(PathBuf::from);
    if let Some(entry) = std::env::var_os("OPENVIDS_AGENT_RUNTIME_ENTRY").map(PathBuf::from) {
        if entry.is_absolute() && entry.is_file() {
            return Some((bun_override.unwrap_or_else(|| PathBuf::from(crate::platform::BUN_BIN)), entry));
        }
    }
    if let Some((bun, entry)) = PROD_ENTRY.lock().ok().and_then(|s| s.clone()) {
        if entry.is_file() {
            return Some((bun_override.unwrap_or(bun), entry));
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("agent-runtime")
        .join("src")
        .join("main.ts");
    if dev.is_file() {
        return Some((bun_override.unwrap_or_else(|| PathBuf::from(crate::platform::BUN_BIN)), dev));
    }
    None
}

fn token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("os randomness for the agent token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn spawn() -> Result<Running, CodedError> {
    let (bun, entry) = launch()
        .ok_or_else(|| CodedError::plain("agent_not_installed", "the agent runtime is not installed"))?;
    let token = token();
    let mut command = Command::new(&bun);
    command
        // Never let Bun fetch a missing module from npm at runtime.
        .arg("--no-install")
        .arg(&entry)
        .current_dir(entry.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .env("OPENVIDS_AGENT_TOKEN", &token)
        .env("OPENVIDS_AGENT_PORT", "0")
        .env("OPENVIDS_AGENT_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in super::ffmpeg_install::managed_env() {
        command.env(key, value);
    }
    crate::proc::configure(&mut command);
    let mut child = command.spawn().map_err(|e| {
        CodedError::new(
            "agent_start_failed",
            format!("could not start the agent runtime ({}): {e}", bun.display()),
            json!({ "path": bun.display().to_string(), "detail": e.to_string() }),
        )
    })?;
    crate::proc::track(&child);
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[home-agent] {line}");
                logfile::agent(&line);
            }
        });
    }
    let (tx, rx) = mpsc::channel::<u16>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut reported = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if !reported {
                    if let Some(port) = lifecycle_port(&line) {
                        reported = true;
                        let _ = tx.send(port);
                        continue;
                    }
                }
                eprintln!("[home-agent] {line}");
                logfile::agent(&line);
            }
        });
    }
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let port = loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(CodedError::new(
                "agent_exited",
                format!("the agent runtime exited during startup ({status})"),
                json!({ "status": status.to_string() }),
            ));
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(port) => break port,
            Err(_) if Instant::now() < deadline => continue,
            Err(_) => {
                kill(&mut child);
                return Err(CodedError::plain("agent_start_timeout", "the agent runtime did not start in time"));
            }
        }
    };
    let running = Running {
        child,
        endpoint: Endpoint { id: 0, port, token },
    };
    while Instant::now() < deadline {
        if matches!(request(&running.endpoint, "GET", "/v1/health", None), Ok((200, _))) {
            return Ok(running);
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let mut running = running;
    kill(&mut running.child);
    Err(CodedError::plain("agent_unhealthy", "the agent runtime never became healthy"))
}

fn lifecycle_port(line: &str) -> Option<u16> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("openvids-agent")?.as_str()? != "listening" {
        return None;
    }
    u16::try_from(value.get("port")?.as_u64()?).ok().filter(|p| *p > 0)
}

/// The runtime gets 2 s to shut down cleanly before the fatal stop.
const KILL_GRACE: Duration = Duration::from_secs(2);

fn kill(child: &mut Child) {
    crate::proc::terminate(child, KILL_GRACE);
}

/// Stop the runtime (app exit). The runtime's parent-pid watch is the
/// backstop on unix when this never runs (SIGKILL, crash); on Windows the
/// kill-on-close Job Object is the backstop.
pub fn shutdown() {
    let running = RUNTIME.lock().ok().and_then(|mut slot| slot.take());
    if let Some(mut running) = running {
        kill(&mut running.child);
    }
}

/// How one request to the runtime failed.
#[derive(Debug)]
enum RequestError {
    /// The connection never opened: nothing reached the runtime.
    Connect(std::io::Error),
    /// Writing the request, waiting for the answer or reading it failed.
    Io(std::io::Error),
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(error) | Self::Io(error) => error.fmt(f),
        }
    }
}

impl From<std::io::Error> for RequestError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// One blocking HTTP/1.1 request to the runtime. Returns (status, body).
fn request(
    endpoint: &Endpoint,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<(u16, Vec<u8>), RequestError> {
    request_with_timeout(endpoint, method, path, body, REQUEST_TIMEOUT)
}

/// `GET /v1/settings` when the runtime is already up, `None` when it is not.
/// The bug reporter (`report.rs`) uses this to describe the user's providers
/// and models; it must never start the runtime just to do so, and must never
/// wait long.
pub fn settings_if_running(timeout: Duration) -> Option<Vec<u8>> {
    let endpoint = {
        let mut slot = RUNTIME.lock().ok()?;
        let running = slot.as_mut()?;
        if !matches!(running.child.try_wait(), Ok(None)) {
            return None;
        }
        running.endpoint.clone()
    };
    request_with_timeout(&endpoint, "GET", "/v1/settings", None, timeout)
        .ok()
        .filter(|(status, _)| *status == 200)
        .map(|(_, body)| body)
}

fn request_with_timeout(
    endpoint: &Endpoint,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    read_timeout: Duration,
) -> Result<(u16, Vec<u8>), RequestError> {
    let mut stream = TcpStream::connect(("127.0.0.1", endpoint.port)).map_err(RequestError::Connect)?;
    stream.set_read_timeout(Some(read_timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(10).min(read_timeout)))?;
    let body = body.unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        endpoint.port,
        endpoint.token,
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .ok_or_else(|| std::io::Error::other("malformed runtime response"))?;
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(502);
    let payload = if head.contains("transfer-encoding: chunked") {
        crate::thumbnails::decode_chunked(&raw[split..])
            .ok_or_else(|| std::io::Error::other("malformed chunked body"))?
    } else {
        raw[split..].to_vec()
    };
    Ok((status, payload))
}

/// Forward one request to the runtime, starting it first if needed. Errors
/// are user-facing strings.
pub fn forward(method: &str, path: &str, body: Option<&[u8]>) -> Result<(u16, Vec<u8>), CodedError> {
    forward_with_timeout(method, path, body, REQUEST_TIMEOUT)
}

/// How long one forwarded request may wait for the runtime's answer. Slow
/// routes (a model test, a provider refresh) legitimately take most of it.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Whether a failed request may be sent again to a replacement runtime. A
/// connection that never opened carried nothing, so any request is safe to
/// repeat. Once the request was on the wire only a read-only one is, and a
/// timeout never is: the runtime is still working on it (a model call can
/// take far longer than the timeout), and repeating it would repeat the work.
fn should_retry(method: &str, error: &RequestError) -> bool {
    match error {
        RequestError::Connect(_) => true,
        RequestError::Io(error) => {
            method.eq_ignore_ascii_case("GET")
                && !matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                )
        }
    }
}

fn is_timeout(error: &RequestError) -> bool {
    matches!(
        error,
        RequestError::Io(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            )
    )
}

/// How long the health probe after a timed-out request may take.
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// A request timed out. The runtime may just be busy with a long call (it
/// still answers `/v1/health`), or its event loop may be wedged, in which
/// case every later request would wait out the full timeout too. The
/// request is not repeated either way; a runtime that fails a short health
/// probe is stopped so the next request starts a fresh one.
fn discard_if_wedged(endpoint: &Endpoint, request_timeout: Duration) {
    let probe = request_timeout.min(HEALTH_PROBE_TIMEOUT);
    if matches!(request_with_timeout(endpoint, "GET", "/v1/health", None, probe), Ok((200, _))) {
        return;
    }
    eprintln!("[home-agent] the runtime stopped answering, restarting it");
    logfile::agent("the runtime stopped answering, restarting it");
    discard(endpoint);
}

fn forward_with_timeout(
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    timeout: Duration,
) -> Result<(u16, Vec<u8>), CodedError> {
    for attempt in 0..2 {
        // `RUNTIME` is only held to read or replace the handle: the request
        // itself runs without it, so one slow call never queues the others.
        let endpoint = ensure_running()?;
        match request_with_timeout(&endpoint, method, path, body, timeout) {
            Ok(result) => return Ok(result),
            Err(error) if attempt == 0 && should_retry(method, &error) => {
                eprintln!("[home-agent] request failed, restarting: {error}");
                logfile::agent(&format!("request failed, restarting: {error}"));
                discard(&endpoint);
            }
            Err(error) => {
                if is_timeout(&error) {
                    discard_if_wedged(&endpoint, timeout);
                }
                return Err(CodedError::new(
                    "agent_no_answer",
                    format!("the agent runtime did not answer: {error}"),
                    json!({ "detail": error.to_string() }),
                ))
            }
        }
    }
    Err(CodedError::plain("agent_unavailable", "the agent runtime is unavailable"))
}

/// The live runtime's endpoint, starting (or replacing a dead) runtime first.
/// Concurrent callers wait for one start, not for each other's requests.
fn ensure_running() -> Result<Endpoint, CodedError> {
    if let Some(endpoint) = endpoint_if_alive()? {
        return Ok(endpoint);
    }
    let _starting = START
        .lock()
        .map_err(|_| CodedError::plain("agent_state_poisoned", "agent runtime state poisoned"))?;
    // Another caller may have finished a start while this one waited.
    if let Some(endpoint) = endpoint_if_alive()? {
        return Ok(endpoint);
    }
    let mut running = spawn()?;
    running.endpoint.id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let endpoint = running.endpoint.clone();
    let previous = RUNTIME
        .lock()
        .map_err(|_| CodedError::plain("agent_state_poisoned", "agent runtime state poisoned"))?
        .replace(running);
    if let Some(mut previous) = previous {
        kill(&mut previous.child);
    }
    Ok(endpoint)
}

/// The endpoint of the running runtime, or `None` when there is none or it
/// has exited (the dead one is stopped and forgotten, outside the lock).
fn endpoint_if_alive() -> Result<Option<Endpoint>, CodedError> {
    let mut dead = {
        let mut slot = RUNTIME
            .lock()
            .map_err(|_| CodedError::plain("agent_state_poisoned", "agent runtime state poisoned"))?;
        let alive = slot
            .as_mut()
            .is_some_and(|running| matches!(running.child.try_wait(), Ok(None)));
        if alive {
            return Ok(slot.as_ref().map(|running| running.endpoint.clone()));
        }
        slot.take()
    };
    if let Some(dead) = dead.as_mut() {
        kill(&mut dead.child);
    }
    Ok(None)
}

/// Stop the runtime that answered `endpoint` badly, unless it has already
/// been replaced by a newer one (another request's retry got there first).
fn discard(endpoint: &Endpoint) {
    let stale = RUNTIME.lock().ok().and_then(|mut slot| {
        match slot.as_ref() {
            Some(running) if running.endpoint.id == endpoint.id => slot.take(),
            _ => None,
        }
    });
    if let Some(mut stale) = stale {
        kill(&mut stale.child);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_line_parsing() {
        assert_eq!(
            lifecycle_port(r#"{"openvids-agent":"listening","port":5123,"protocolVersion":2}"#),
            Some(5123)
        );
        assert_eq!(lifecycle_port(r#"{"openvids-agent":"starting","port":5123}"#), None);
        assert_eq!(lifecycle_port("plain log line"), None);
        assert_eq!(lifecycle_port(r#"{"openvids-agent":"listening","port":0}"#), None);
    }

    fn io_error(kind: std::io::ErrorKind) -> RequestError {
        RequestError::Io(std::io::Error::from(kind))
    }

    #[test]
    fn only_requests_that_never_left_or_are_read_only_are_retried() {
        let refused = RequestError::Connect(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert!(should_retry("POST", &refused));
        assert!(should_retry("GET", &refused));
        // On the wire: a write may have run, so only a read-only request repeats.
        let reset = io_error(std::io::ErrorKind::ConnectionReset);
        assert!(should_retry("GET", &reset));
        assert!(!should_retry("POST", &reset));
        assert!(!should_retry("PUT", &reset));
        // A timeout means the runtime is still working: never repeat or restart.
        for kind in [std::io::ErrorKind::TimedOut, std::io::ErrorKind::WouldBlock] {
            assert!(!should_retry("GET", &io_error(kind)));
            assert!(!should_retry("POST", &io_error(kind)));
        }
    }

    /// The tests below swap the process-wide runtime slot: one at a time.
    static SLOT_TESTS: Mutex<()> = Mutex::new(());

    /// A runtime that accepts connections and never answers `/v1/work`; it
    /// answers `/v1/health` only when `healthy`. Returns its endpoint and the
    /// thread holding the connections open.
    #[cfg(unix)]
    fn stalled_runtime(healthy: bool) -> (Endpoint, std::thread::JoinHandle<()>) {
        use std::net::TcpListener;

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let held = std::thread::spawn(move || {
            let mut open = Vec::new();
            while let Ok((mut stream, _)) = listener.accept() {
                let mut head = [0u8; 256];
                let n = stream.read(&mut head).unwrap_or(0);
                if healthy && head[..n].starts_with(b"GET /v1/health ") {
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    );
                } else {
                    open.push(stream);
                }
            }
        });
        let endpoint = Endpoint {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            port,
            token: "t".to_string(),
        };
        (endpoint, held)
    }

    #[cfg(unix)]
    fn install_runtime(endpoint: &Endpoint) {
        let mut command = Command::new("sleep");
        command.arg("30").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        crate::proc::configure(&mut command);
        let child = command.spawn().expect("spawn sleep");
        crate::proc::track(&child);
        *RUNTIME.lock().expect("lock") = Some(Running { child, endpoint: endpoint.clone() });
    }

    /// A slow request must neither queue the other callers nor cost a
    /// responsive runtime its life when it times out.
    #[cfg(unix)]
    #[test]
    fn a_slow_request_does_not_block_others_or_kill_a_responsive_runtime() {
        let _serial = SLOT_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let (endpoint, held) = stalled_runtime(true);
        install_runtime(&endpoint);

        let slow = std::thread::spawn(|| {
            forward_with_timeout("POST", "/v1/work", Some(b"{}"), Duration::from_millis(1500))
        });
        std::thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        assert!(settings_if_running(Duration::from_millis(200)).is_none());
        assert!(
            started.elapsed() < Duration::from_millis(1000),
            "the diagnostics read waited for the slow request: {:?}",
            started.elapsed()
        );

        let error = slow.join().expect("join").expect_err("the slow request times out");
        assert_eq!(error.code, Some("agent_no_answer"));
        let still_running = RUNTIME
            .lock()
            .expect("lock")
            .as_mut()
            .is_some_and(|running| matches!(running.child.try_wait(), Ok(None)));
        assert!(still_running, "a runtime that still answers health is not replaced");
        shutdown();
        assert!(RUNTIME.lock().expect("lock").is_none());
        drop(held);
    }

    /// A runtime that stops answering altogether is dropped after the timeout
    /// (the request itself is not repeated), so the next request starts a new one.
    #[cfg(unix)]
    #[test]
    fn a_wedged_runtime_is_discarded_after_a_timeout() {
        let _serial = SLOT_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let (endpoint, held) = stalled_runtime(false);
        install_runtime(&endpoint);

        let error = forward_with_timeout("POST", "/v1/work", Some(b"{}"), Duration::from_millis(800))
            .expect_err("the request times out");
        assert_eq!(error.code, Some("agent_no_answer"));
        assert!(
            RUNTIME.lock().expect("lock").is_none(),
            "a runtime that fails the health probe must be discarded"
        );
        drop(held);
    }
}
