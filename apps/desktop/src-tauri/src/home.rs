//! The Projects home screen: a loopback server for the whole app lifetime.
//!
//! The webview has no Tauri IPC (no `withGlobalTauri`, empty capabilities,
//! no dialog/fs plugins — that stays), so the home page is a document served
//! by this listener with a small JSON API behind it (see `home_routes` for
//! the endpoint list).
//!
//! Protection: a per-launch token (`home_auth::HomeToken`) is injected into
//! the page and required on every `/api` request (see `home_auth`); Host and
//! Origin are scoped to this server. See "Security" in the README.
//!
//! Lifetime: the server lives in `AppState` for the whole process and is
//! never dropped on project open — "Show All Projects" navigates back to it
//! without restarting anything. Opening a project only swaps what the
//! window shows (dev) or restarts the Studio sidecar (prod).

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use super::home_auth::HomeToken;
use super::home_routes::{serve_one, thumb_name_for, HomeInner, OpenPhase, Opener, PrefsListener};

/// A loopback listener that serves the home page for the app's lifetime.
pub struct HomeServer {
    port: u16,
    #[allow(dead_code)]
    token: HomeToken,
    inner: Arc<Mutex<HomeInner>>,
    stop: Arc<AtomicBool>,
    accept: TcpListener,
}

impl HomeServer {
    pub fn bind(recents_path: PathBuf, thumbs_dir: PathBuf) -> std::io::Result<Self> {
        let inner = HomeInner::load(recents_path, thumbs_dir)?;
        let accept = TcpListener::bind(("127.0.0.1", 0))?;
        let port = accept.local_addr()?.port();
        let token = HomeToken::generate();
        let inner = Arc::new(Mutex::new(inner));
        let stop = Arc::new(AtomicBool::new(false));

        let shared = accept.try_clone()?;
        let state = Arc::clone(&inner);
        let flag = Arc::clone(&stop);
        let token_value = token.value().to_string();
        thread::spawn(move || {
            let _ = shared.set_nonblocking(false);
            for stream in shared.incoming() {
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                match stream {
                    Ok(stream) => {
                        let state = Arc::clone(&state);
                        let token_value = token_value.clone();
                        thread::spawn(move || {
                            serve_one(stream, &state, &token_value, port);
                        });
                    }
                    Err(_) => continue,
                }
            }
        });

        Ok(Self {
            port,
            token,
            inner,
            stop,
            accept,
        })
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The opener runs the real project open (dev navigate / prod sidecar).
    pub fn set_opener(&self, opener: Opener) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.opener = Some(opener);
        }
    }
    /// Record a successful open in recents (also used at launch for
    /// `OPENVIDS_PROJECT` so it appears on the home screen).
    /// A recorded open is complete, so the loading phase clears too.
    pub fn record_open(&self, id: &str, dir: &Path) {
        let dims = std::fs::read_to_string(dir.join("index.html"))
            .ok()
            .filter(|html| super::structure::is_composition_source(html))
            .map(|html| super::structure::composition_dimensions(&html));
        if let Ok(mut inner) = self.inner.lock() {
            inner
                .recents
                .record(id, dir, dims.map(|(w, _)| w), dims.map(|(_, h)| h));
            inner.current_id = Some(id.to_string());
            inner.open_phase = super::home_routes::OpenPhase::Idle;
        }
    }

    pub fn set_open_phase(&self, phase: OpenPhase) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.open_phase = phase;
        }
    }

    /// Forget the currently open project (the window navigated home). Only a
    /// real return from a project skips the launch intro on the next page
    /// load; the navigation hook also fires for the window's first load and
    /// for reloads of the Projects page, which keep the intro.
    pub fn clear_current(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.current_id.take().is_some() {
                inner.skip_intro = true;
            }
            inner.open_phase = OpenPhase::Idle;
        }
    }

    /// Told about preference changes saved through the page (window theme).
    pub fn set_prefs_listener(&self, listener: PrefsListener) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.prefs_listener = Some(listener);
        }
    }

    /// The most recently opened project that still exists, for
    /// "On launch: Reopen last project".
    pub fn last_project(&self) -> Option<PathBuf> {
        self.inner.lock().ok().and_then(|inner| {
            inner
                .recents
                .entries()
                .iter()
                .find(|e| e.dir.is_dir())
                .map(|e| e.dir.clone())
        })
    }

    /// Cache fetched thumbnail bytes for `dir` under a stable name and point
    /// the recent at it. Best-effort: failures only mean a placeholder card.
    pub fn cache_thumbnail(&self, dir: &Path, bytes: &[u8], ext: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            let name = thumb_name_for(dir, ext);
            if std::fs::write(inner.thumbs_dir.join(&name), bytes).is_ok() {
                inner.recents.update_meta(dir, Some(name), None, None);
            }
        }
    }

    #[cfg(test)]
    pub fn token_for_test(&self) -> String {
        self.token.value().to_string()
    }
}

impl Drop for HomeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        let _ = self.accept.set_nonblocking(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    const TOKEN_HEADER: &str = "x-openvids-token";

    fn base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openvids-home-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn repo_templates() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("packages")
            .join("cli")
            .join("src")
            .join("templates")
    }

    fn spawn(name: &str) -> (HomeServer, String) {
        // Same value in every test, so parallel `set_var` is benign.
        std::env::set_var("OPENVids_TEST_TEMPLATES", repo_templates());
        let dir = base(name);
        let server = HomeServer::bind(dir.join("recents.json"), dir.join("thumbs")).unwrap();
        let origin = server.origin();
        (server, origin)
    }

    fn intro_flag(origin: &str) -> bool {
        let (code, body) = get(origin, "/", None);
        assert_eq!(code, 200);
        String::from_utf8_lossy(&body).contains("\"intro\":true")
    }

    #[test]
    fn intro_plays_on_launch_and_reload_but_not_after_a_project() {
        let (server, origin) = spawn("intro");
        // The navigation hook runs for the first load and every reload too.
        server.clear_current();
        assert!(intro_flag(&origin), "cold load plays the intro");
        server.clear_current();
        assert!(intro_flag(&origin), "reloading Projects plays it again");

        let project = base("intro-project");
        server.record_open("intro-project", &project);
        server.clear_current();
        assert!(!intro_flag(&origin), "coming back from a project skips it");
        assert!(intro_flag(&origin), "the skip applies to that one load only");
    }

    fn raw(origin: &str, req: &str, body: Option<&[u8]>) -> (u16, Vec<u8>) {
        let addr = origin.trim_start_matches("http://");
        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        stream.write_all(req.as_bytes()).unwrap();
        if let Some(body) = body {
            stream.write_all(body).unwrap();
        }
        let mut out = Vec::new();
        stream.read_to_end(&mut out).unwrap();
        let code =
            String::from_utf8_lossy(&out[..out.iter().position(|&b| b == b'\r').unwrap_or(0)])
                .split_whitespace()
                .nth(1)
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);
        let body = out
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| out[i + 4..].to_vec())
            .unwrap_or_default();
        (code, body)
    }

    fn get(origin: &str, path: &str, token: Option<&str>) -> (u16, Vec<u8>) {
        let addr = origin.trim_start_matches("http://");
        let mut req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
        if let Some(token) = token {
            req.push_str(&format!("{TOKEN_HEADER}: {token}\r\n"));
        }
        req.push_str("\r\n");
        raw(origin, &req, None)
    }

    fn post(origin: &str, path: &str, token: Option<&str>, body: &[u8]) -> (u16, Vec<u8>) {
        let addr = origin.trim_start_matches("http://");
        let mut req = format!(
            "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n",
            body.len()
        );
        if let Some(token) = token {
            req.push_str(&format!("{TOKEN_HEADER}: {token}\r\n"));
        }
        req.push_str("\r\n");
        raw(origin, &req, Some(body))
    }

    #[test]
    fn page_embeds_the_token_and_api_needs_it() {
        let (server, origin) = spawn("page");
        let token = server.token_for_test();
        let (code, body) = get(&origin, "/", None);
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains(&token));
        let (code, _) = get(&origin, "/api/recents", None);
        assert_eq!(code, 403);
        let (code, _) = post(&origin, "/api/remove", None, br#"{"id":"x"}"#);
        assert_eq!(code, 403);
        let (code, body) = get(&origin, "/api/recents", Some(&token));
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains("recents"));
    }

    #[test]
    fn create_open_rename_remove_flow() {
        let (server, origin) = spawn("flow");
        let token = server.token_for_test();
        let parent = base("flow-parent");
        let body = serde_json::json!({
            "parent": parent.to_string_lossy(),
            "name": "my-video",
            "fps": "24",
            "width": 1080,
            "height": 1920,
            "duration": 12.0,
        });
        // No opener hook in tests: begin_open marks the phase, calls nothing.
        let (code, _) = post(
            &origin,
            "/api/create",
            Some(&token),
            body.to_string().as_bytes(),
        );
        assert_eq!(code, 200);
        let dest = parent.join("my-video");
        let html = std::fs::read_to_string(dest.join("index.html")).unwrap();
        assert!(html.contains("data-composition-id"));
        assert!(html.contains("data-width=\"1080\""));
        assert!(html.contains("data-fps=\"24\""));
        assert!(dest.join("meta.json").is_file());
        // A duplicate create is refused; an empty name never reaches disk.
        let (code, _) = post(
            &origin,
            "/api/create",
            Some(&token),
            body.to_string().as_bytes(),
        );
        assert_eq!(code, 400);
        let bad = serde_json::json!({"parent": parent.to_string_lossy(), "name": "", "width": 8, "height": 8});
        let (code, _) = post(
            &origin,
            "/api/create",
            Some(&token),
            bad.to_string().as_bytes(),
        );
        assert_eq!(code, 400);

        // The open marked the phase; recording happens on real opens in lib.rs.
        let (code, body) = get(&origin, "/api/open-state", Some(&token));
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains("opening"));
        let (code, _) = post(&origin, "/api/open", Some(&token), br#"{"id":"nope"}"#);
        assert_eq!(code, 404);
        // Record the open (sets the current-open guard), prove renaming
        // the open project is refused, then simulate Show All Projects and
        // rename for real.
        server.record_open("my-video", &dest);
        let (code, _) = post(
            &origin,
            "/api/rename",
            Some(&token),
            br#"{"id":"my-video","new_name":"blocked"}"#,
        );
        assert_eq!(code, 400);
        server.clear_current();

        // Rename moves the folder and keeps meta.json consistent.
        let (code, _) = post(
            &origin,
            "/api/rename",
            Some(&token),
            br#"{"id":"my-video","new_name":"renamed"}"#,
        );
        assert_eq!(code, 200);
        assert!(parent.join("renamed").join("index.html").is_file());
        assert!(!parent.join("my-video").exists());
        let meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(parent.join("renamed").join("meta.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta["name"], "renamed");
        // Invalid names and unknown ids are refused.
        let (code, _) = post(
            &origin,
            "/api/rename",
            Some(&token),
            br#"{"id":"renamed","new_name":"a/b"}"#,
        );
        assert_eq!(code, 400);
        let (code, _) = post(
            &origin,
            "/api/rename",
            Some(&token),
            br#"{"id":"missing","new_name":"x"}"#,
        );
        assert_eq!(code, 404);

        // A project whose index.html vanished no longer opens …
        std::fs::remove_file(parent.join("renamed").join("index.html")).unwrap();
        let (code, body) = post(&origin, "/api/open", Some(&token), br#"{"id":"renamed"}"#);
        assert_eq!(code, 400);
        assert!(
            String::from_utf8_lossy(&body).contains("index.html"),
            "unexpected: {}",
            String::from_utf8_lossy(&body)
        );
        // … but an empty folder is reported missing rather than openable.
        std::fs::remove_dir_all(parent.join("renamed")).unwrap();
        let (code, _) = get(&origin, "/api/recents", Some(&token));
        assert_eq!(code, 200);
        let (_, body) = get(&origin, "/api/recents", Some(&token));
        assert!(String::from_utf8_lossy(&body).contains("\"missing\":true"));
        let (code, _) = post(&origin, "/api/open", Some(&token), br#"{"id":"renamed"}"#);
        assert_eq!(code, 410);

        // Remove drops the entry; unknown ids and trash targets 404.
        let (code, _) = post(&origin, "/api/remove", Some(&token), br#"{"id":"renamed"}"#);
        assert_eq!(code, 200);
        let (code, _) = post(&origin, "/api/remove", Some(&token), br#"{"id":"renamed"}"#);
        assert_eq!(code, 404);
        let (code, _) = post(&origin, "/api/trash", Some(&token), br#"{"id":"renamed"}"#);
        assert_eq!(code, 404);
    }

    #[test]
    fn thumbnails_roundtrip_through_the_server() {
        let (server, origin) = spawn("thumbs");
        let token = server.token_for_test();
        let dir = base("thumbs-proj");
        std::fs::create_dir_all(&dir).unwrap();
        server.record_open("demo", &dir);
        server.cache_thumbnail(&dir, b"fake-jpeg-bytes", "jpg");
        let (_, body) = get(&origin, "/api/recents", Some(&token));
        assert!(
            String::from_utf8_lossy(&body).contains(".jpg"),
            "unexpected: {}",
            String::from_utf8_lossy(&body)
        );
        // Extract the thumb file name from the JSON payload.
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let thumb = value["recents"][0]["thumb"].as_str().unwrap().to_string();
        let (code, body) = get(&origin, &format!("/thumb/{thumb}"), None);
        assert_eq!(code, 200);
        assert_eq!(body, b"fake-jpeg-bytes");
        // Traversal attempts are refused without a token check getting in the way.
        let (code, _) = get(&origin, "/thumb/../home.rs", None);
        assert_eq!(code, 400);
        let (code, _) = get(&origin, "/thumb/missing.jpg", None);
        assert_eq!(code, 404);
    }
}
