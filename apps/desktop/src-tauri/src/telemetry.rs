//! Anonymous usage statistics: how many people use OpenVids, on which
//! version and system. Sent by this module only: Studio, the Studio server,
//! the agent runtime and the CLI never send statistics.
//!
//! ## What is sent
//!
//! One small JSON `POST` per event, nothing else:
//!
//! - `app_start` at launch (and when the user turns statistics back on);
//! - `heartbeat` every 5 minutes while the app is open;
//! - `app_end` on a normal quit (a 1 s budget, never holding the quit up;
//!   a crash or SIGKILL simply sends none);
//! - `telemetry_disabled` once, when the user turns statistics off. It carries
//!   no installation id, and nothing is sent after it.
//!
//! Every event carries the UI language and `data` with exactly `version`,
//! `os`, `arch` and `active` (whether the main window has focus); every event
//! but `telemetry_disabled` carries the installation id, a random UUID v4 kept
//! in `<app dir>/installation-id` and created on the first real send. File
//! names, paths, project content, chat or prompt text, URLs, provider keys and
//! error messages are never sent. A new field needs the README's "Usage
//! statistics" section updated with it.
//!
//! ## When nothing is sent
//!
//! - `telemetry.enabled` is `false` in the preferences (Settings › General);
//! - `DO_NOT_TRACK=1` or `OPENVIDS_TELEMETRY=0` is set;
//! - a debug build (`bun run desktop:dev`), unless `OPENVIDS_TELEMETRY_URL`
//!   names an address (it replaces the endpoint, e.g. a local receiver for
//!   testing).
//!
//! The preference is re-read from the file (`preferences_changed`, called by
//! the preferences watcher in `lib.rs`), so turning it off in Studio counts the
//! same as on the Projects page. Requests run on a background thread with
//! short timeouts; any failure is dropped: no retry, no queue on disk, nothing
//! shown to the user.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Manager;

use crate::{i18n, prefs};

const DEFAULT_URL: &str = "https://analytics.openvids.ai/api/send";
/// Umami's "OpenVids Desktop" site. Not a secret: it only names the site.
const WEBSITE_ID: &str = "fd14d201-a374-456b-a581-fd0cb8f1c53a";
const HOSTNAME: &str = "app.openvids.ai";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const ID_FILE: &str = "installation-id";
/// Every event is a row on the server: not more often than this.
const HEARTBEAT: Duration = Duration::from_secs(5 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `app_end` may take, and so how long it can hold the quit up.
const END_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Event {
    AppStart,
    Heartbeat,
    AppEnd,
    Disabled,
}

impl Event {
    fn name(self) -> &'static str {
        match self {
            Self::AppStart => "app_start",
            Self::Heartbeat => "heartbeat",
            Self::AppEnd => "app_end",
            Self::Disabled => "telemetry_disabled",
        }
    }

    /// The opt-out is the one event that is not tied to the installation.
    fn carries_id(self) -> bool {
        self != Self::Disabled
    }
}

/// Where statistics go, or why they are off. `env` reads an environment
/// variable. `DO_NOT_TRACK` and `OPENVIDS_TELEMETRY=0` win over everything,
/// the address override included.
fn endpoint(env: impl Fn(&str) -> Option<String>, debug: bool) -> Result<String, &'static str> {
    let set = |name: &str| {
        env(name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let off = |value: &str| {
        value == "0" || value.eq_ignore_ascii_case("false") || value.eq_ignore_ascii_case("off")
    };
    if set("DO_NOT_TRACK").is_some_and(|value| !off(&value)) {
        return Err("DO_NOT_TRACK is set");
    }
    if set("OPENVIDS_TELEMETRY").is_some_and(|value| off(&value)) {
        return Err("OPENVIDS_TELEMETRY=0");
    }
    if let Some(url) = set("OPENVIDS_TELEMETRY_URL") {
        return Ok(url);
    }
    if debug {
        return Err("debug build");
    }
    Ok(DEFAULT_URL.to_string())
}

/// The request body Umami's `/api/send` takes. `id` is left out of
/// `telemetry_disabled` whatever the caller passes.
fn body(event: Event, id: Option<&str>, language: &str, active: bool) -> Value {
    let mut payload = json!({
        "website": WEBSITE_ID,
        "hostname": HOSTNAME,
        "language": language,
        "url": "/app",
        "title": "OpenVids",
        "name": event.name(),
        "data": {
            "version": VERSION,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "active": active,
        },
    });
    if let Some(id) = id.filter(|_| event.carries_id()) {
        payload["id"] = json!(id);
    }
    json!({ "type": "event", "payload": payload })
}

/// What a fresh read of the preference sends: the opt-out when it was just
/// turned off, a new start when it was turned back on.
fn on_preference(was: bool, now: bool) -> Option<Event> {
    match (was, now) {
        (true, false) => Some(Event::Disabled),
        (false, true) => Some(Event::AppStart),
        _ => None,
    }
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn new_uuid() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os randomness for the installation id");
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The installation id in `dir`, created (atomically) when there is none yet
/// or the file does not hold one.
fn installation_id(dir: &Path) -> std::io::Result<String> {
    let path = dir.join(ID_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if is_uuid(text.trim()) {
            return Ok(text.trim().to_string());
        }
    }
    let id = new_uuid();
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{ID_FILE}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, format!("{id}\n"))?;
    std::fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(id)
}

struct Client {
    url: String,
    agent: ureq::Agent,
    /// Where the installation id lives (`prefs::app_dir()` in the app).
    dir: PathBuf,
    /// Read or created on the first send that needs it, then kept.
    id: Mutex<Option<String>>,
}

impl Client {
    fn new(url: String, dir: PathBuf) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(REQUEST_TIMEOUT))
            .http_status_as_error(false)
            .max_redirects(0)
            .user_agent(format!(
                "OpenVids/{VERSION} ({}; {})",
                std::env::consts::OS,
                std::env::consts::ARCH
            ))
            .build();
        Self {
            url,
            agent: config.into(),
            dir,
            id: Mutex::new(None),
        }
    }

    fn id(&self) -> Option<String> {
        let mut id = self.id.lock().unwrap_or_else(|e| e.into_inner());
        if id.is_none() {
            *id = installation_id(&self.dir).ok();
        }
        id.clone()
    }

    /// One request; whatever happens to it is ignored. An event that needs
    /// the installation id is skipped when the id cannot be stored, so an
    /// unwritable app directory never counts as a new installation per launch.
    fn send(&self, event: Event, active: bool) {
        let id = if event.carries_id() {
            match self.id() {
                Some(id) => Some(id),
                None => return,
            }
        } else {
            None
        };
        let body = body(event, id.as_deref(), i18n::active(), active).to_string();
        let request = self.agent.post(&self.url).content_type("application/json");
        let request = if event == Event::AppEnd {
            request.config().timeout_global(Some(END_TIMEOUT)).build()
        } else {
            request
        };
        let _ = request.send(body);
    }
}

/// The sending loop: `app_start` now (when on), a `heartbeat` every `every`
/// while on, and a transition event whenever `signals` brings a changed
/// preference. Ends when the sender side is dropped; sends nothing once
/// `ended` is set (`app_end` went out).
fn run(
    client: &Client,
    signals: Receiver<bool>,
    mut enabled: bool,
    every: Duration,
    ended: &AtomicBool,
    active: impl Fn() -> bool,
) {
    let send = |event: Event| {
        if !ended.load(Ordering::SeqCst) {
            client.send(event, active());
        }
    };
    if enabled {
        send(Event::AppStart);
    }
    let mut next_beat = Instant::now() + every;
    loop {
        match signals.recv_timeout(next_beat.saturating_duration_since(Instant::now())) {
            Ok(now) => {
                let event = on_preference(enabled, now);
                enabled = now;
                if let Some(event) = event {
                    send(event);
                    next_beat = Instant::now() + every;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if enabled {
                    send(Event::Heartbeat);
                }
                next_beat = Instant::now() + every;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

struct Telemetry {
    client: Client,
    signals: Sender<bool>,
    ended: AtomicBool,
}

static TELEMETRY: OnceLock<Telemetry> = OnceLock::new();

/// Whether the main window has focus. Off the main thread this waits for the
/// event loop; on it, Tauri answers inline.
fn main_window_active(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
}

/// Start sending, unless the environment or the build turns statistics off
/// (then nothing here ever runs, the preference notwithstanding). Called once
/// from `setup`, after the main window exists.
pub fn start(app: &tauri::AppHandle, debug: bool) {
    let url = match endpoint(|name| std::env::var(name).ok(), debug) {
        Ok(url) => url,
        Err(reason) => {
            eprintln!("[openvids] usage statistics off: {reason}");
            return;
        }
    };
    let (signals, received) = mpsc::channel();
    let telemetry = TELEMETRY.get_or_init(|| Telemetry {
        client: Client::new(url, prefs::app_dir()),
        signals,
        ended: AtomicBool::new(false),
    });
    let app = app.clone();
    std::thread::spawn(move || {
        let enabled = prefs::telemetry_enabled(&prefs::load(&prefs::prefs_path()));
        run(
            &telemetry.client,
            received,
            enabled,
            HEARTBEAT,
            &telemetry.ended,
            || main_window_active(&app),
        );
    });
}

/// The preferences file was read again (whoever wrote it): pass the choice to
/// the sending loop, which acts on a change only.
pub fn preferences_changed(preferences: &Value) {
    if let Some(telemetry) = TELEMETRY.get() {
        let _ = telemetry
            .signals
            .send(prefs::telemetry_enabled(preferences));
    }
}

/// An `app_end` on its way; `wait` gives it what is left of its budget.
pub struct PendingEnd(Option<Receiver<()>>);

impl PendingEnd {
    pub fn wait(self) {
        if let Some(done) = self.0 {
            let _ = done.recv_timeout(END_TIMEOUT);
        }
    }
}

/// Send `app_end` (once, when statistics are on) on a worker, so the rest of
/// the shutdown runs meanwhile; the caller waits on the result last.
pub fn app_end(app: &tauri::AppHandle) -> PendingEnd {
    let Some(telemetry) = TELEMETRY.get() else {
        return PendingEnd(None);
    };
    if telemetry.ended.swap(true, Ordering::SeqCst)
        || !prefs::telemetry_enabled(&prefs::load(&prefs::prefs_path()))
    {
        return PendingEnd(None);
    }
    let active = main_window_active(app);
    let (done, wait) = mpsc::channel();
    std::thread::spawn(move || {
        telemetry.client.send(Event::AppEnd, active);
        let _ = done.send(());
    });
    PendingEnd(Some(wait))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("openvids-telemetry-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// A loopback receiver answering 200 to every request and handing over
    /// each request's User-Agent and JSON body.
    fn receiver() -> (String, Receiver<(String, Value)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/send", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let (mut length, mut agent) = (0usize, String::new());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("user-agent:") {
                        agent = line["user-agent:".len()..].trim().to_string();
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                );
                let _ = tx.send((agent, serde_json::from_slice(&bytes).unwrap()));
            }
        });
        (url, rx)
    }

    fn names(rx: &Receiver<(String, Value)>) -> Vec<String> {
        rx.try_iter()
            .map(|(_, body)| body["payload"]["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn the_body_is_umamis_event_with_exactly_the_documented_fields() {
        let id = "0b6a6c4e-2f1d-4b8e-9c3a-5d7e8f9a0b1c";
        assert_eq!(
            body(Event::AppStart, Some(id), "ru", true),
            json!({
                "type": "event",
                "payload": {
                    "website": WEBSITE_ID,
                    "hostname": "app.openvids.ai",
                    "language": "ru",
                    "url": "/app",
                    "title": "OpenVids",
                    "name": "app_start",
                    "id": id,
                    "data": {
                        "version": VERSION,
                        "os": std::env::consts::OS,
                        "arch": std::env::consts::ARCH,
                        "active": true
                    }
                }
            })
        );
        assert_eq!(
            body(Event::Heartbeat, Some(id), "en", false)["payload"]["name"],
            "heartbeat"
        );
        assert_eq!(
            body(Event::AppEnd, Some(id), "en", false)["payload"]["name"],
            "app_end"
        );
    }

    #[test]
    fn the_opt_out_never_carries_the_installation_id() {
        let sent = body(
            Event::Disabled,
            Some("0b6a6c4e-2f1d-4b8e-9c3a-5d7e8f9a0b1c"),
            "en",
            true,
        );
        assert_eq!(sent["payload"]["name"], "telemetry_disabled");
        assert!(sent["payload"].get("id").is_none());
        assert_eq!(sent["payload"]["data"]["version"], VERSION);
    }

    #[test]
    fn the_environment_and_the_build_decide_whether_anything_is_sent() {
        fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
            move |name| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.to_string())
            }
        }
        let local = "http://127.0.0.1:9/api/send";
        assert_eq!(endpoint(env(&[]), false), Ok(DEFAULT_URL.to_string()));
        assert_eq!(endpoint(env(&[]), true), Err("debug build"));
        assert_eq!(
            endpoint(env(&[("OPENVIDS_TELEMETRY_URL", local)]), true),
            Ok(local.into())
        );
        assert_eq!(
            endpoint(env(&[("OPENVIDS_TELEMETRY_URL", local)]), false),
            Ok(local.into())
        );
        assert_eq!(
            endpoint(env(&[("OPENVIDS_TELEMETRY_URL", " ")]), true),
            Err("debug build")
        );
        // DO_NOT_TRACK wins over the address override, in any build.
        for value in ["1", "true", "yes"] {
            let pairs = [("DO_NOT_TRACK", value), ("OPENVIDS_TELEMETRY_URL", local)];
            assert_eq!(
                endpoint(env(&pairs), false),
                Err("DO_NOT_TRACK is set"),
                "{value}"
            );
            assert_eq!(
                endpoint(env(&pairs), true),
                Err("DO_NOT_TRACK is set"),
                "{value}"
            );
        }
        assert_eq!(
            endpoint(env(&[("DO_NOT_TRACK", "0")]), false),
            Ok(DEFAULT_URL.into())
        );
        assert_eq!(
            endpoint(env(&[("DO_NOT_TRACK", "")]), false),
            Ok(DEFAULT_URL.into())
        );
        assert_eq!(
            endpoint(
                env(&[
                    ("OPENVIDS_TELEMETRY", "0"),
                    ("OPENVIDS_TELEMETRY_URL", local)
                ]),
                true
            ),
            Err("OPENVIDS_TELEMETRY=0")
        );
        assert_eq!(
            endpoint(env(&[("OPENVIDS_TELEMETRY", "false")]), false),
            Err("OPENVIDS_TELEMETRY=0")
        );
        assert_eq!(
            endpoint(env(&[("OPENVIDS_TELEMETRY", "1")]), false),
            Ok(DEFAULT_URL.into())
        );
    }

    #[test]
    fn only_a_change_of_the_preference_sends_and_off_sends_the_opt_out() {
        assert_eq!(on_preference(true, false), Some(Event::Disabled));
        assert_eq!(on_preference(false, true), Some(Event::AppStart));
        assert_eq!(on_preference(true, true), None);
        assert_eq!(on_preference(false, false), None);
    }

    #[test]
    fn the_installation_id_is_created_by_the_first_send_that_needs_it() {
        let dir = tmp("id");
        let (url, rx) = receiver();
        let client = Client::new(url.clone(), dir.clone());
        // The opt-out goes out without an id, and creates none.
        client.send(Event::Disabled, false);
        let (agent, sent) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(sent["payload"].get("id").is_none());
        assert!(
            agent.starts_with(&format!("OpenVids/{VERSION} (")),
            "{agent}"
        );
        assert!(!dir.join(ID_FILE).exists());
        // The first event that names the installation creates it: a UUID v4.
        client.send(Event::AppStart, true);
        let (_, sent) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let stored = std::fs::read_to_string(dir.join(ID_FILE)).unwrap();
        let id = sent["payload"]["id"].as_str().unwrap().to_string();
        assert_eq!(stored.trim(), id);
        assert!(is_uuid(&id) && id.as_bytes()[14] == b'4', "{id}");
        assert!(
            matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'),
            "{id}"
        );
        assert_eq!(sent["payload"]["data"]["active"], true);
        // Kept across sends and launches; a damaged file is replaced.
        Client::new(url.clone(), dir.clone()).send(Event::Heartbeat, false);
        let (_, sent) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(sent["payload"]["id"], id.as_str());
        std::fs::write(dir.join(ID_FILE), "not-an-id").unwrap();
        Client::new(url, dir.clone()).send(Event::Heartbeat, false);
        let (_, sent) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let replaced = sent["payload"]["id"].as_str().unwrap();
        assert!(is_uuid(replaced) && replaced != id);
        assert_eq!(
            std::fs::read_to_string(dir.join(ID_FILE)).unwrap().trim(),
            replaced
        );
    }

    #[test]
    fn the_loop_follows_the_preference_and_stops_after_the_end() {
        let dir = tmp("loop");
        let (url, rx) = receiver();
        let client = Client::new(url, dir.clone());
        let ended = AtomicBool::new(false);
        let (signals, received) = mpsc::channel();
        // One heartbeat lands 400 ms after a start, the next at 800 ms: each
        // check sits 200 ms from both.
        let every = Duration::from_millis(400);
        // Assertions run after the scope, so a failure cannot leave the loop
        // waiting on a sender that is never dropped.
        let seen = std::thread::scope(|scope| {
            scope.spawn(|| run(&client, received, true, every, &ended, || true));
            let wait = |ms| std::thread::sleep(Duration::from_millis(ms));
            let mut seen = Vec::new();
            wait(600);
            seen.push(names(&rx));
            // Off: the opt-out once, then silence, heartbeats included.
            signals.send(false).unwrap();
            signals.send(false).unwrap();
            wait(1000);
            seen.push(names(&rx));
            // On again: a new start, then heartbeats.
            signals.send(true).unwrap();
            wait(600);
            seen.push(names(&rx));
            // After app_end nothing more leaves.
            ended.store(true, Ordering::SeqCst);
            signals.send(false).unwrap();
            wait(600);
            seen.push(names(&rx));
            drop(signals);
            seen
        });
        assert_eq!(
            seen,
            [
                vec!["app_start", "heartbeat"],
                vec!["telemetry_disabled"],
                vec!["app_start", "heartbeat"],
                vec![],
            ]
        );
        // Started disabled: nothing at all, and no id file.
        let dir = tmp("loop-off");
        let (url, rx) = receiver();
        let client = Client::new(url, dir.clone());
        let ended = AtomicBool::new(false);
        let (signals, received) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| run(&client, received, false, every, &ended, || true));
            std::thread::sleep(Duration::from_millis(1000));
            signals.send(false).unwrap();
            std::thread::sleep(Duration::from_millis(100));
            drop(signals);
        });
        assert!(names(&rx).is_empty());
        assert!(!dir.join(ID_FILE).exists());
    }
}
