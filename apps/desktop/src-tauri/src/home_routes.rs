//! Home-screen HTTP plumbing: request reading, routing, thumbnails.
//!
//! `home.rs` owns the listener lifetime; this module owns everything that
//! happens per connection:
//!
//! - `GET /` — the home page (token injected into the script).
//! - `GET /api/recents` — recents with `missing` flags for gone folders.
//! - `POST /api/pick-open` — native folder picker → validation → open.
//! - `POST /api/pick-parent` — native folder picker for the create form.
//! - `POST /api/create` — scaffold a project, then open it.
//! - `POST /api/open` — open a recent by id.
//! - `POST /api/rename` — rename the folder on disk + update recents.
//! - `POST /api/remove` — drop a recent.
//! - `POST /api/trash` — move the folder to the OS Trash + drop the recent.
//! - `GET /api/open-state` — what the background open is doing.
//! - `GET /thumb/<file>` — cached thumbnail bytes.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::home_auth::{self, Head, HomeToken, TOKEN_HEADER};
use super::recents::{RecentEntry, RecentsStore};
use super::structure::validate_structure;

const PAGE: &str = include_str!("home.html");
const TOKEN_PLACEHOLDER: &str = "__OPENVids_TOKEN__";
const BODY_LIMIT: usize = 64 * 1024;

/// What the background open is doing (polled by the page's loading overlay).
#[derive(Debug, Clone, Default)]
pub enum OpenPhase {
    #[default]
    Idle,
    Opening {
        label: String,
    },
    Failed {
        label: String,
        error: String,
    },
}

pub type Opener = Arc<dyn Fn(PathBuf) + Send + Sync>;

/// Shared mutable home state behind the listener thread.
pub struct HomeInner {
    pub recents: RecentsStore,
    pub thumbs_dir: PathBuf,
    pub open_phase: OpenPhase,
    pub opener: Option<Opener>,
    /// Id of the project currently loaded in the Studio window, if any.
    /// Set when an open completes, cleared by Show All Projects.
    pub current_id: Option<String>,
}

impl HomeInner {
    pub fn load(recents_path: PathBuf, thumbs_dir: PathBuf) -> std::io::Result<Self> {
        let _ = std::fs::create_dir_all(&thumbs_dir);
        Ok(Self {
            recents: RecentsStore::load(&recents_path),
            thumbs_dir,
            open_phase: OpenPhase::Idle,
            opener: None,
            current_id: None,
        })
    }
}

pub fn serve_one(mut stream: TcpStream, state: &Arc<Mutex<HomeInner>>, token: &str, port: u16) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let request = read_request(&mut stream);
    let Some((head, raw_target, body)) = request else {
        respond(&mut stream, 400, "text/plain", b"bad request");
        return;
    };
    if !home_auth::origin_allowed(&head, port) {
        respond(&mut stream, 403, "text/plain", b"foreign origin");
        return;
    }
    if home_auth::requires_token(&head.method, &head.path)
        && !HomeToken::matches(&HomeToken::from_value(token), head.header(TOKEN_HEADER))
    {
        respond(&mut stream, 403, "text/plain", b"bad token");
        return;
    }
    route(stream, state, token, &head, &raw_target, &body);
}

// ── Request reading ─────────────────────────────────────────────────────────

fn read_request(stream: &mut TcpStream) -> Option<(Head, String, Vec<u8>)> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
        if let Some(end) = find_header_end(&raw) {
            let head_text = String::from_utf8_lossy(&raw[..end]).into_owned();
            let head = Head::parse(&head_text)?;
            let raw_target = request_target(&head_text);
            let content_len = head
                .header("content-length")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(0)
                .min(BODY_LIMIT);
            let mut body = raw[end..].to_vec();
            while body.len() < content_len {
                let n = stream.read(&mut buf).ok()?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&buf[..n]);
            }
            body.truncate(content_len);
            return Some((head, raw_target, body));
        }
        if raw.len() > 16 * 1024 {
            return None;
        }
    }
    None
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

fn request_target(head_text: &str) -> String {
    head_text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_string()
}

// ── Routing ─────────────────────────────────────────────────────────────────

fn route(
    mut stream: TcpStream,
    state: &Arc<Mutex<HomeInner>>,
    token: &str,
    head: &Head,
    raw_target: &str,
    body: &[u8],
) {
    let path = percent_decode(&head.path);
    if head.method.eq_ignore_ascii_case("GET") && (path == "/" || path == "/index.html") {
        let page = PAGE.replace(TOKEN_PLACEHOLDER, token);
        respond(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            page.as_bytes(),
        );
        return;
    }
    if head.method.eq_ignore_ascii_case("GET") && path.starts_with("/thumb/") {
        serve_thumb(&mut stream, state, &path);
        return;
    }
    if head.method.eq_ignore_ascii_case("GET") && path == "/api/recents" {
        serve_recents(&mut stream, state);
        return;
    }
    if head.method.eq_ignore_ascii_case("GET") && path == "/api/open-state" {
        serve_open_state(&mut stream, state);
        return;
    }
    if path == "/api/pick-open" && head.method.eq_ignore_ascii_case("POST") {
        handle_pick_open(&mut stream, state);
        return;
    }
    if path == "/api/pick-parent" && head.method.eq_ignore_ascii_case("POST") {
        handle_pick_parent(&mut stream);
        return;
    }
    if path == "/api/create" && head.method.eq_ignore_ascii_case("POST") {
        super::home_create::handle_create(&mut stream, state, body);
        return;
    }
    if path == "/api/open" && head.method.eq_ignore_ascii_case("POST") {
        handle_open(&mut stream, state, body);
        return;
    }
    if path == "/api/rename" && head.method.eq_ignore_ascii_case("POST") {
        super::home_project::handle_rename(&mut stream, state, body);
        return;
    }
    if path == "/api/remove" && head.method.eq_ignore_ascii_case("POST") {
        let id = json_field(body, "id").unwrap_or_default();
        let removed = state
            .lock()
            .ok()
            .map(|mut inner| inner.recents.remove(&id))
            .unwrap_or(false);
        if removed {
            respond(&mut stream, 200, "application/json", br#"{"ok":true}"#);
        } else {
            respond(
                &mut stream,
                404,
                "application/json",
                br#"{"error":"unknown project"}"#,
            );
        }
        return;
    }
    if path == "/api/trash" && head.method.eq_ignore_ascii_case("POST") {
        super::home_project::handle_trash(&mut stream, state, body);
        return;
    }
    let _ = raw_target;
    respond(&mut stream, 404, "text/plain", b"not found");
}

pub fn begin_open(state: &Arc<Mutex<HomeInner>>, id: String, dir: PathBuf) {
    let opener = state.lock().ok().and_then(|mut inner| {
        inner.open_phase = OpenPhase::Opening { label: id.clone() };
        inner.opener.clone()
    });
    if let Some(opener) = opener {
        opener(dir);
    }
}

fn serve_thumb(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, path: &str) {
    let name = path.trim_start_matches("/thumb/");
    if !is_safe_thumb_name(name) {
        respond(stream, 400, "text/plain", b"bad thumbnail name");
        return;
    }
    let bytes = state
        .lock()
        .ok()
        .and_then(|inner| std::fs::read(inner.thumbs_dir.join(name)).ok());
    match bytes {
        Some(bytes) => respond(stream, 200, content_type_for(name), &bytes),
        None => respond(stream, 404, "text/plain", b"no thumbnail yet"),
    }
}

fn serve_recents(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>) {
    let payload = state.lock().ok().map(|inner| {
        let recents: Vec<serde_json::Value> = inner
            .recents
            .entries()
            .iter()
            .map(|e: &RecentEntry| {
                serde_json::json!({
                    "id": e.id,
                    "dir": e.dir.to_string_lossy(),
                    "last_opened": e.last_opened,
                    "thumb": e.thumb,
                    "width": e.width,
                    "height": e.height,
                    "missing": !e.dir.is_dir(),
                })
            })
            .collect();
        serde_json::json!({ "recents": recents }).to_string()
    });
    match payload {
        Some(json) => respond(stream, 200, "application/json", json.as_bytes()),
        None => respond(stream, 500, "text/plain", b"state poisoned"),
    }
}

fn serve_open_state(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>) {
    let payload = state.lock().ok().map(|inner| match &inner.open_phase {
        OpenPhase::Idle => serde_json::json!({ "phase": "idle" }).to_string(),
        OpenPhase::Opening { label } => {
            serde_json::json!({ "phase": "opening", "label": label }).to_string()
        }
        OpenPhase::Failed { label, error } => {
            serde_json::json!({ "phase": "failed", "label": label, "error": error }).to_string()
        }
    });
    match payload {
        Some(json) => respond(stream, 200, "application/json", json.as_bytes()),
        None => respond(stream, 500, "text/plain", b"state poisoned"),
    }
}

fn handle_pick_open(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>) {
    match rfd::FileDialog::new()
        .set_title("Open HyperFrames Project Folder")
        .pick_folder()
    {
        None => respond(stream, 200, "application/json", br#"{"cancelled":true}"#),
        Some(dir) => match validate_structure(&dir) {
            Ok(project) => {
                begin_open(state, project.id.clone(), project.dir.clone());
                respond(
                    stream,
                    200,
                    "application/json",
                    br#"{"cancelled":false,"opening":true}"#,
                );
            }
            Err(err) => {
                let payload = serde_json::json!({ "error": err.to_string() }).to_string();
                respond(stream, 400, "application/json", payload.as_bytes());
            }
        },
    }
}

fn handle_pick_parent(stream: &mut TcpStream) {
    match rfd::FileDialog::new()
        .set_title("Choose Where to Create the Project")
        .pick_folder()
    {
        None => respond(stream, 200, "application/json", br#"{"cancelled":true}"#),
        Some(parent) => {
            let payload = serde_json::json!({ "parent": parent.to_string_lossy() });
            respond(
                stream,
                200,
                "application/json",
                payload.to_string().as_bytes(),
            );
        }
    }
}

fn handle_open(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let id = json_field(body, "id");
    let found = state.lock().ok().and_then(|inner| {
        inner
            .recents
            .find_by_id(&id.clone().unwrap_or_default())
            .cloned()
    });
    match (id, found) {
        (Some(_), Some(entry)) => {
            if !entry.dir.is_dir() {
                let payload = serde_json::json!({
                    "error": format!("{} no longer exists — remove it from recents", entry.dir.display())
                });
                respond(
                    stream,
                    410,
                    "application/json",
                    payload.to_string().as_bytes(),
                );
            } else {
                match validate_structure(&entry.dir) {
                    Ok(project) => {
                        begin_open(state, project.id.clone(), project.dir.clone());
                        respond(stream, 200, "application/json", br#"{"opening":true}"#);
                    }
                    Err(err) => {
                        let payload = serde_json::json!({ "error": err.to_string() }).to_string();
                        respond(stream, 400, "application/json", payload.as_bytes());
                    }
                }
            }
        }
        _ => respond(
            stream,
            404,
            "application/json",
            br#"{"error":"unknown project"}"#,
        ),
    }
}

pub fn json_field(body: &[u8], key: &str) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()?
        .get(key)?
        .as_str()
        .map(|s| s.to_string())
}

fn is_safe_thumb_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && (name.ends_with(".jpg") || name.ends_with(".png"))
        && !name.contains("..")
}

fn content_type_for(name: &str) -> &'static str {
    if name.ends_with(".png") {
        "image/png"
    } else {
        "image/jpeg"
    }
}

fn percent_decode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut bytes = path.as_bytes().iter();
    while let Some(&b) = bytes.next() {
        if b == b'%' {
            let hi = bytes.next().copied().unwrap_or(b'0');
            let lo = bytes.next().copied().unwrap_or(b'0');
            let hex = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
            out.push((hex(hi) * 16 + hex(lo)) as char);
        } else {
            out.push(b as char);
        }
    }
    out
}

fn status_line(code: u16) -> &'static str {
    match code {
        200 => "HTTP/1.1 200 OK",
        400 => "HTTP/1.1 400 Bad Request",
        403 => "HTTP/1.1 403 Forbidden",
        404 => "HTTP/1.1 404 Not Found",
        409 => "HTTP/1.1 409 Conflict",
        410 => "HTTP/1.1 410 Gone",
        500 => "HTTP/1.1 500 Internal Server Error",
        _ => "HTTP/1.1 500 Internal Server Error",
    }
}

pub fn respond(stream: &mut TcpStream, code: u16, content_type: &'static str, body: &[u8]) {
    let head = format!(
        "{}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status_line(code),
        content_type,
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}
