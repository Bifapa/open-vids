//! `/internal/*` on the home server: what the Studio sidecars ask the shell.
//!
//! A sidecar knows one project folder. To let an agent chat attach the user's
//! OTHER projects (`#` in the composer) it asks the shell, which owns the
//! recents list, over loopback server-to-server HTTP:
//!
//! - `GET /internal/projects` → `{ "projects": [{ "key", "name", "openedAt" }] }`
//!   (`openedAt` epoch ms, most recent first, only folders that still exist).
//! - `GET /internal/projects/<key>` → `{ "key", "name", "dir" }`, or 404.
//!
//! `key` is `RecentEntry::key()`; a request names a project by key only, never
//! by path. `dir` is for the sidecar's own filesystem reads and never reaches a
//! browser: the sidecar resolves it behind its own routes.
//!
//! Auth is a per-launch secret ([`InternalSecret`]), distinct from the home
//! page token: the shell hands it to every sidecar it spawns in
//! `OPENVIDS_HOME_SECRET` (with the origin in `OPENVIDS_HOME_URL`), the sidecar
//! sends it as `x-openvids-secret`. These routes accept ONLY that secret (the
//! page token opens nothing here, and the secret opens no `/api/*` route), and
//! a request that carries an `Origin` header is refused: a browser always sends
//! one on cross-origin requests, a Node `fetch` never does. No CORS headers are
//! ever written. `home_routes::serve_one` hands every `/internal` path
//! (decoded once, like every other check) to [`serve`] before any other rule.
//!
//! In `desktop:dev` the Studio server is Vite, started by Tauri's
//! `beforeDevCommand` before this process exists, so it cannot inherit the env:
//! [`write_dev_link`] drops `{url, secret}` into a file that script points
//! Vite at (`OPENVIDS_HOME_FILE`).

use std::net::TcpStream;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::coded_error::CodedError;
use super::home_api::{method_not_allowed, respond_error, respond_json, route_not_found, unknown_project};
use super::home_auth::{constant_time_eq, origin_allowed, Head};
use super::home_routes::HomeInner;
use super::recents::RecentEntry;

/// The request header carrying the per-launch secret.
pub const SECRET_HEADER: &str = "x-openvids-secret";

/// Sidecar env: origin of the home server (`http://127.0.0.1:<port>`).
pub const HOME_URL_ENV: &str = "OPENVIDS_HOME_URL";
/// Sidecar env: the per-launch secret for `/internal/*`.
pub const HOME_SECRET_ENV: &str = "OPENVIDS_HOME_SECRET";

/// A minted per-launch secret: 256 bits from the OS CSPRNG, hex.
#[derive(Clone)]
pub struct InternalSecret(String);

// Never prints the value: a stray `{:?}` must not put it in a log.
impl std::fmt::Debug for InternalSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("InternalSecret(..)")
    }
}

impl InternalSecret {
    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("os randomness for the internal secret");
        Self(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }

    pub fn value(&self) -> &str {
        &self.0
    }

    fn matches(&self, provided: Option<&str>) -> bool {
        provided.is_some_and(|value| constant_time_eq(self.0.as_bytes(), value.as_bytes()))
    }
}

/// How a sidecar reaches this server: its origin and the secret.
#[derive(Debug, Clone)]
pub struct HomeLink {
    url: String,
    secret: InternalSecret,
}

impl HomeLink {
    pub fn new(url: &str, secret: InternalSecret) -> Self {
        Self {
            url: url.to_string(),
            secret,
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn secret(&self) -> &InternalSecret {
        &self.secret
    }

    /// The env a Studio sidecar is spawned with.
    pub fn env(&self) -> [(&'static str, &str); 2] {
        [(HOME_URL_ENV, &self.url), (HOME_SECRET_ENV, self.secret.value())]
    }
}

/// Whether `path` (already percent-decoded) belongs to this module.
pub fn owns(path: &str) -> bool {
    path == "/internal" || path.starts_with("/internal/")
}

/// Answer one `/internal/*` request. Order matters: the browser guard and the
/// Host scope first (cheap, reveal nothing), then the secret, and only then
/// does the path or method matter.
pub fn serve(
    stream: &mut TcpStream,
    state: &Arc<Mutex<HomeInner>>,
    secret: &InternalSecret,
    head: &Head,
    port: u16,
) {
    if head.header("origin").is_some() || !origin_allowed(head, port) {
        return refuse(stream, 403, "forbidden");
    }
    if !secret.matches(head.header(SECRET_HEADER)) {
        return refuse(stream, 401, "unauthorized");
    }
    if !head.method.eq_ignore_ascii_case("GET") {
        return respond_error(stream, 405, &method_not_allowed());
    }
    let existing = existing_projects(state);
    if head.path == "/internal/projects" {
        let projects: Vec<_> = existing
            .iter()
            .map(|e| json!({ "key": e.key(), "name": e.id, "openedAt": e.last_opened.saturating_mul(1000) }))
            .collect();
        return respond_json(stream, 200, &json!({ "projects": projects }));
    }
    match head.path.strip_prefix("/internal/projects/") {
        Some(key) if is_key(key) => match existing.iter().find(|e| e.key() == key) {
            Some(entry) => respond_json(
                stream,
                200,
                &json!({ "key": key, "name": entry.id, "dir": entry.dir.to_string_lossy() }),
            ),
            None => respond_error(stream, 404, &unknown_project()),
        },
        Some(_) => respond_error(stream, 404, &unknown_project()),
        None => respond_error(stream, 404, &route_not_found()),
    }
}

/// A bare status line body: a refusal tells the caller nothing else.
fn refuse(stream: &mut TcpStream, status: u16, text: &'static str) {
    let err: CodedError = CodedError::plain(text, text);
    respond_error(stream, status, &err);
}

/// The recents whose folder still exists, most recently opened first.
fn existing_projects(state: &Arc<Mutex<HomeInner>>) -> Vec<RecentEntry> {
    let mut entries: Vec<RecentEntry> = state
        .lock()
        .map(|inner| inner.recents.entries().iter().filter(|e| e.dir.is_dir()).cloned().collect())
        .unwrap_or_default();
    entries.sort_by_key(|e| std::cmp::Reverse(e.last_opened));
    entries
}

/// `RecentEntry::key()` shape: 16 lowercase hex characters.
fn is_key(key: &str) -> bool {
    key.len() == 16 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `desktop:dev` handoff: write `{url, secret}` to `path` (owner-only, replaced
/// atomically) for the Vite dev server that was started before the shell.
pub fn write_dev_link(path: &Path, link: &HomeLink) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = json!({ "url": link.url(), "secret": link.secret().value() }).to_string();
    let staged = path.with_extension("json.tmp");
    write_private(&staged, body.as_bytes())?;
    std::fs::rename(&staged, path)
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home::HomeServer;
    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::time::Duration;

    fn base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openvids-internal-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spawn(name: &str) -> (HomeServer, String, PathBuf) {
        let dir = base(name);
        let server = HomeServer::bind(dir.join("recents.json"), dir.join("thumbs")).unwrap();
        let origin = server.origin();
        (server, origin, dir)
    }

    /// One raw request: (status, body, full response head).
    fn call(origin: &str, path: &str, headers: &[(&str, &str)]) -> (u16, String, String) {
        let addr = origin.trim_start_matches("http://");
        let mut req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
        for (name, value) in headers {
            req.push_str(&format!("{name}: {value}\r\n"));
        }
        req.push_str("\r\n");
        let mut stream = TcpStream::connect(addr).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
        stream.write_all(req.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.read_to_end(&mut out).unwrap();
        let text = String::from_utf8_lossy(&out).into_owned();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let code = head.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
        (code, body.to_string(), head.to_string())
    }

    fn project(root: &Path, name: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn json_of(body: &str) -> serde_json::Value {
        serde_json::from_str(body).unwrap_or_else(|e| panic!("{e}: {body}"))
    }

    #[test]
    fn secret_is_256_bits_of_hex_and_never_repeats() {
        let a = InternalSecret::generate();
        let b = InternalSecret::generate();
        assert_eq!(a.value().len(), 64);
        assert!(a.value().bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a.value(), b.value());
        assert!(a.matches(Some(a.value())));
        assert!(!a.matches(Some(b.value())));
        assert!(!a.matches(None));
        assert!(!a.matches(Some("")));
        assert!(!a.matches(Some(&a.value()[..63])));
    }

    #[test]
    fn only_the_secret_opens_the_internal_routes() {
        let (server, origin, dir) = spawn("auth");
        server.record_open(&project(&dir, "alpha"));
        let secret = server.internal_secret().value().to_string();
        let token = server.token_for_test();
        let key = json_of(&call(&origin, "/internal/projects", &[(SECRET_HEADER, &secret)]).1)["projects"][0]["key"]
            .as_str()
            .unwrap()
            .to_string();

        for path in ["/internal/projects".to_string(), format!("/internal/projects/{key}")] {
            let (code, body, _) = call(&origin, &path, &[(SECRET_HEADER, &secret)]);
            assert_eq!(code, 200, "{path}");
            assert!(body.contains("alpha"));

            // No secret, a wrong one, the page token in either header, or an empty value: 401, nothing revealed.
            for headers in [
                vec![],
                vec![(SECRET_HEADER, "nope")],
                vec![(SECRET_HEADER, ""), ("x-openvids-token", token.as_str())],
                vec![(SECRET_HEADER, token.as_str())],
                vec![("x-openvids-token", token.as_str())],
            ] {
                let (code, body, _) = call(&origin, &path, &headers);
                assert_eq!(code, 401, "{path} {headers:?}");
                assert!(!body.contains("alpha") && !body.contains(&key), "{body}");
            }

            // A browser (any Origin, even this server's own) never gets in, with or without the secret.
            for page in ["https://evil.example", "null", origin.as_str()] {
                for headers in [
                    vec![("Origin", page), (SECRET_HEADER, secret.as_str())],
                    vec![("Origin", page)],
                ] {
                    let (code, body, head) = call(&origin, &path, &headers);
                    assert_eq!(code, 403, "{path} {headers:?}");
                    assert!(!body.contains("alpha"));
                    assert!(!head.to_lowercase().contains("access-control-"), "{head}");
                }
            }
        }
    }

    #[test]
    fn a_foreign_host_name_is_refused_even_with_the_secret() {
        let (server, origin, _) = spawn("rebind");
        let secret = server.internal_secret().value().to_string();
        let (code, _, _) = call(&origin, "/internal/projects", &[("Host", "evil.example"), (SECRET_HEADER, &secret)]);
        assert_eq!(code, 403);
    }

    #[test]
    fn the_secret_opens_nothing_outside_internal_and_the_token_nothing_inside() {
        let (server, origin, dir) = spawn("scope");
        server.record_open(&project(&dir, "alpha"));
        let secret = server.internal_secret().value().to_string();
        let token = server.token_for_test();
        assert_ne!(secret, token);
        let page = call(&origin, "/", &[]).1;
        assert!(!page.contains(&secret), "the page must never embed the secret");

        for path in ["/api/recents", "/api/preferences", "/%61pi/recents"] {
            let (code, body, _) = call(&origin, path, &[(SECRET_HEADER, &secret)]);
            assert_eq!(code, 403, "{path}");
            assert!(!body.contains("alpha"));
            // The page token still works there, so the 403 above is about the secret.
            assert_eq!(call(&origin, path, &[("x-openvids-token", &token)]).0, 200, "{path}");
        }
        assert_eq!(call(&origin, "/internal/projects", &[("x-openvids-token", &token)]).0, 401);
    }

    #[test]
    fn encoded_spellings_get_the_same_decision() {
        let (server, origin, dir) = spawn("encoded");
        server.record_open(&project(&dir, "alpha"));
        let secret = server.internal_secret().value().to_string();
        let token = server.token_for_test();
        for path in [
            "/%69nternal/projects",
            "/internal%2Fprojects",
            "/internal/%70rojects",
            "/%69nternal%2f%70rojects",
        ] {
            assert_eq!(call(&origin, path, &[]).0, 401, "{path}");
            assert_eq!(call(&origin, path, &[("x-openvids-token", &token)]).0, 401, "{path}");
            assert_eq!(call(&origin, path, &[("Origin", "https://evil.example"), (SECRET_HEADER, &secret)]).0, 403, "{path}");
            let (code, body, _) = call(&origin, path, &[(SECRET_HEADER, &secret)]);
            assert_eq!(code, 200, "{path}");
            assert!(body.contains("alpha"));
        }
        // Another case is not this route: it is no `/internal` at all and serves nothing.
        let (code, body, _) = call(&origin, "/Internal/projects", &[(SECRET_HEADER, &secret)]);
        assert_eq!(code, 404);
        assert!(!body.contains("alpha"));
    }

    #[test]
    fn unknown_malformed_and_path_shaped_keys_are_404_never_a_lookup_by_path() {
        let (server, origin, dir) = spawn("keys");
        let alpha = project(&dir, "alpha");
        server.record_open(&alpha);
        let secret = server.internal_secret().value().to_string();
        let auth = [(SECRET_HEADER, secret.as_str())];

        for key in [
            "0123456789abcdef",
            "ABCDEF0123456789",
            "short",
            "0123456789abcdef0",
            "",
            "..",
            "%2e%2e%2f%2e%2e",
            &alpha.to_string_lossy(),
            &alpha.to_string_lossy().replace('/', "%2f"),
        ] {
            let (code, body, _) = call(&origin, &format!("/internal/projects/{key}"), &auth);
            assert_eq!(code, 404, "{key:?}");
            assert!(!body.contains("alpha"), "{key:?}: {body}");
        }
        assert_eq!(call(&origin, "/internal/projects/x/y", &auth).0, 404);
        assert_eq!(call(&origin, "/internal/other", &auth).0, 404);
        assert_eq!(call(&origin, "/internal/other", &[]).0, 401, "an unknown path reveals nothing without the secret");
    }

    #[test]
    fn a_key_resolves_to_name_and_dir_and_a_vanished_folder_to_404() {
        let (server, origin, dir) = spawn("resolve");
        let alpha = project(&dir, "alpha");
        server.record_open(&alpha);
        let secret = server.internal_secret().value().to_string();
        let auth = [(SECRET_HEADER, secret.as_str())];

        let listed = json_of(&call(&origin, "/internal/projects", &auth).1);
        let key = listed["projects"][0]["key"].as_str().unwrap().to_string();
        assert_eq!(key.len(), 16);
        let (code, body, head) = call(&origin, &format!("/internal/projects/{key}"), &auth);
        assert_eq!(code, 200);
        assert!(head.contains("Cache-Control: no-store"), "{head}");
        let found = json_of(&body);
        assert_eq!(found["key"], key.as_str());
        assert_eq!(found["name"], "alpha");
        // Recents keep the canonical folder (`/var` is `/private/var` on macOS).
        let canonical = std::fs::canonicalize(&alpha).unwrap();
        assert_eq!(found["dir"], canonical.to_string_lossy().as_ref());

        std::fs::remove_dir_all(&alpha).unwrap();
        assert_eq!(call(&origin, &format!("/internal/projects/{key}"), &auth).0, 404);
    }

    #[test]
    fn the_list_is_most_recent_first_without_vanished_folders_and_in_epoch_ms() {
        let (server, origin, dir) = spawn("list");
        let old = project(&dir, "old");
        let gone = project(&dir, "gone");
        let fresh = project(&dir, "fresh");
        server.record_open(&old);
        server.record_open(&gone);
        server.record_open(&fresh);
        server.set_last_opened_for_test(&old, 1_000);
        server.set_last_opened_for_test(&gone, 2_000);
        server.set_last_opened_for_test(&fresh, 3_000);
        std::fs::remove_dir_all(&gone).unwrap();
        let secret = server.internal_secret().value().to_string();

        let (code, body, head) = call(&origin, "/internal/projects", &[(SECRET_HEADER, &secret)]);
        assert_eq!(code, 200);
        assert!(head.contains("Cache-Control: no-store"), "{head}");
        assert!(head.contains("application/json"), "{head}");
        let projects = json_of(&body)["projects"].as_array().unwrap().clone();
        let seen: Vec<(&str, u64)> = projects
            .iter()
            .map(|p| (p["name"].as_str().unwrap(), p["openedAt"].as_u64().unwrap()))
            .collect();
        assert_eq!(seen, vec![("fresh", 3_000_000), ("old", 1_000_000)]);
        for p in &projects {
            assert!(is_key(p["key"].as_str().unwrap()));
            assert!(p.get("dir").is_none(), "the list never carries paths");
        }
    }

    #[test]
    fn internal_routes_answer_get_only() {
        let (server, origin, _) = spawn("method");
        let secret = server.internal_secret().value().to_string();
        let addr = origin.trim_start_matches("http://");
        let send = |secret_line: &str| {
            let req = format!(
                "POST /internal/projects HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 2\r\nConnection: close\r\n{secret_line}\r\n{{}}"
            );
            let mut stream = TcpStream::connect(addr).unwrap();
            stream.write_all(req.as_bytes()).unwrap();
            let mut out = String::new();
            stream.read_to_string(&mut out).unwrap();
            out.split_whitespace().nth(1).unwrap_or("0").to_string()
        };
        assert_eq!(send(""), "401");
        assert_eq!(send(&format!("{SECRET_HEADER}: {secret}\r\n")), "405");
    }

    #[test]
    fn dev_link_holds_url_and_secret_for_the_owner_only() {
        let dir = base("link");
        let path = dir.join("data").join("home-link.json");
        let first = HomeLink::new("http://127.0.0.1:4321", InternalSecret::generate());
        write_dev_link(&path, &first).unwrap();
        let again = HomeLink::new("http://127.0.0.1:4322", InternalSecret::generate());
        write_dev_link(&path, &again).unwrap();
        let written = json_of(&std::fs::read_to_string(&path).unwrap());
        assert_eq!(written["url"], "http://127.0.0.1:4322");
        assert_eq!(written["secret"], again.secret().value());
        assert!(!path.with_extension("json.tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
}
