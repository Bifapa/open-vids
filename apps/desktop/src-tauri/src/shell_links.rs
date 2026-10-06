//! What the main window's webview may do with links and downloads.
//!
//! The webview has no IPC, so everything a page asks of the OS passes through
//! the two hooks the window builder installs (`lib.rs`): `on_new_window`
//! (`target="_blank"`, `window.open`) and `on_download` (`<a download>`, blob
//! and attachment responses). Without a download hook wry cancels every
//! download, and the window must never navigate itself to a foreign page, so
//! this module decides what each request becomes:
//!
//! - `https:` and non-loopback `http:` addresses and plain `mailto:` links go
//!   to the default browser / mail client.
//! - A link to a render file on the Studio server (the render-QA row, chat
//!   Markdown) is opened by that server in the OS default player, the same
//!   request Studio's own Render panel makes (`openRender.ts`).
//! - Any other loopback address, `file:`, `javascript:` and custom schemes are
//!   dropped.
//! - A download is saved to the user's Downloads folder (wry picks the file
//!   name and never overwrites) when it comes from the Projects page or the
//!   Studio server, and the saved file is shown in the file manager, the only
//!   feedback a shell without IPC can give.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use url::{Host, Url};

use super::{home_api, log_line, normalize_origin};

/// Longest address a page may ask to open.
const MAX_LINK_LEN: usize = 4096;
/// The only `mailto:` query fields honoured: everything else (an `attach`
/// field, say) could make a mail client read a local file.
const MAILTO_FIELDS: [&str; 4] = ["subject", "body", "cc", "bcc"];

/// What a link opened by the page becomes.
#[derive(Debug, PartialEq, Eq)]
pub enum LinkAction {
    /// Hand the address to the default browser / mail client.
    Browser(Url),
    /// Ask the Studio server at `origin` to open a render of `project`.
    /// `project` and `file` are the still percent-encoded path segments.
    RenderFile {
        origin: String,
        project: String,
        file: String,
    },
    /// Do nothing.
    Ignore,
}

/// Decide what the link `raw` becomes. `studio_origins` are the origins of the
/// Studio servers the page that opened it may ask to open a render (its own
/// project's; the window's when the page is not a project's).
pub fn classify_link(raw: &str, studio_origins: &[String]) -> LinkAction {
    if raw.is_empty() || raw.len() > MAX_LINK_LEN || raw.chars().any(char::is_control) {
        return LinkAction::Ignore;
    }
    let Ok(url) = Url::parse(raw) else {
        return LinkAction::Ignore;
    };
    match url.scheme() {
        "https" => external(url),
        "http" if is_loopback(&url) => render_file_link(&url, studio_origins),
        "http" => external(url),
        "mailto" => mail(url),
        _ => LinkAction::Ignore,
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// A web address for the default browser: a host, no embedded credentials.
fn external(url: Url) -> LinkAction {
    if url.host_str().is_none_or(str::is_empty) || !url.username().is_empty() || url.password().is_some() {
        return LinkAction::Ignore;
    }
    LinkAction::Browser(url)
}

/// A `mailto:` link naming a recipient and carrying nothing but the plain
/// message fields.
fn mail(url: Url) -> LinkAction {
    let named = url
        .query_pairs()
        .any(|(key, value)| key.eq_ignore_ascii_case("to") && !value.is_empty());
    if url.path().is_empty() && !named {
        return LinkAction::Ignore;
    }
    let plain = url.query_pairs().all(|(key, _)| {
        let key = key.to_ascii_lowercase();
        key == "to" || MAILTO_FIELDS.contains(&key.as_str())
    });
    if plain {
        LinkAction::Browser(url)
    } else {
        LinkAction::Ignore
    }
}

/// `/api/projects/<id>/renders/file/<name>` on one of the Studio servers
/// given: the URL a render's own link carries.
fn render_file_link(url: &Url, studio_origins: &[String]) -> LinkAction {
    let origin = normalize_origin(url);
    if !studio_origins.contains(&origin) {
        return LinkAction::Ignore;
    }
    let segments: Vec<&str> = url.path_segments().map(Iterator::collect).unwrap_or_default();
    let ["api", "projects", project, "renders", "file", file] = segments.as_slice() else {
        return LinkAction::Ignore;
    };
    let usable = |segment: &str| !segment.is_empty() && segment != "." && segment != "..";
    if !usable(project) || !usable(file) {
        return LinkAction::Ignore;
    }
    LinkAction::RenderFile {
        origin,
        project: (*project).to_string(),
        file: (*file).to_string(),
    }
}

/// Ask the Studio server at `origin` to open a render in the OS default
/// player (`POST /api/projects/:id/renders/:file/open`). Returns the HTTP
/// status the server answered with.
pub fn open_render_file(origin: &str, project: &str, file: &str) -> std::io::Result<u16> {
    let invalid = |why: &str| std::io::Error::new(std::io::ErrorKind::InvalidInput, why.to_string());
    let url = Url::parse(origin).map_err(|_| invalid("bad origin"))?;
    let host = url.host_str().ok_or_else(|| invalid("no host"))?;
    let port = url.port().ok_or_else(|| invalid("no port"))?;
    let mut stream = TcpStream::connect((host, port))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let request = format!(
        "POST /api/projects/{project}/renders/{file}/open HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes())?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer)?;
    let head = String::from_utf8_lossy(&answer[..answer.len().min(32)]).into_owned();
    head.split_whitespace()
        .nth(1)
        .and_then(|status| status.parse().ok())
        .ok_or_else(|| std::io::Error::other("no HTTP status in the answer"))
}

/// Run what `classify_link` decided, off the calling (UI) thread.
pub fn run_link_action(action: LinkAction) {
    match action {
        LinkAction::Browser(url) => {
            std::thread::spawn(move || {
                if let Err(err) = home_api::open_external(&url) {
                    log_line(&format!("could not open the browser: {err}"));
                }
            });
        }
        LinkAction::RenderFile { origin, project, file } => {
            std::thread::spawn(move || match open_render_file(&origin, &project, &file) {
                Ok(200) => {}
                Ok(status) => log_line(&format!("the render could not be opened (status {status})")),
                Err(err) => log_line(&format!("could not open the render: {err}")),
            });
        }
        LinkAction::Ignore => {}
    }
}

// ── Downloads ────────────────────────────────────────────────────────────────

/// Where each accepted download goes, until it finishes: a queue per URL,
/// because the same render or blob URL can be downloaded again before the
/// first one ends. macOS reports no path when a download finishes, so the one
/// chosen at the start is kept.
type PendingDownloads = HashMap<String, VecDeque<PathBuf>>;
static PENDING_DOWNLOADS: Mutex<Option<PendingDownloads>> = Mutex::new(None);

/// Whether a download may start: only what the Projects page or the Studio
/// server the window shows serves (their own address, or a `blob:` URL made by
/// one of their pages), so a page loaded from anywhere else cannot write files.
pub fn download_allowed(url: &Url, trusted_origins: &[String]) -> bool {
    let trusted = |origin: String| trusted_origins.iter().any(|known| *known == origin);
    match url.scheme() {
        "http" => trusted(normalize_origin(url)),
        "blob" => Url::parse(url.path())
            .ok()
            .is_some_and(|inner| inner.scheme() == "http" && trusted(normalize_origin(&inner))),
        _ => false,
    }
}

/// A download was requested; `destination` is where wry will save it.
pub fn download_requested(url: &Url, destination: &Path, trusted_origins: &[String]) -> bool {
    if !download_allowed(url, trusted_origins) {
        log_line("refused a download from an untrusted page");
        return false;
    }
    if let Ok(mut pending) = PENDING_DOWNLOADS.lock() {
        remember_download(
            pending.get_or_insert_with(PendingDownloads::new),
            url.as_str(),
            destination.to_path_buf(),
        );
    }
    true
}

fn remember_download(pending: &mut PendingDownloads, url: &str, destination: PathBuf) {
    pending.entry(url.to_string()).or_default().push_back(destination);
}

/// The oldest destination still waiting for `url`; the entry goes with its
/// last destination.
fn settle_download(pending: &mut PendingDownloads, url: &str) -> Option<PathBuf> {
    let queue = pending.get_mut(url)?;
    let destination = queue.pop_front();
    if queue.is_empty() {
        pending.remove(url);
    }
    destination
}

/// A download ended. A saved file is shown in the file manager. The event's
/// own path wins when the platform reports one; the queued destination is
/// consumed either way, so a repeated download of one URL stays in step.
pub fn download_finished(url: &Url, path: Option<PathBuf>, success: bool) {
    let chosen = PENDING_DOWNLOADS
        .lock()
        .ok()
        .and_then(|mut pending| pending.as_mut().and_then(|map| settle_download(map, url.as_str())));
    if !success {
        log_line("a download failed");
        return;
    }
    let Some(file) = path.or(chosen) else {
        return;
    };
    log_line(&format!("saved a download to {}", file.display()));
    std::thread::spawn(move || match home_api::reveal_in_file_manager(&file) {
        Ok(status) if home_api::reveal_succeeded(&status) => {}
        Ok(status) => log_line(&format!("could not show the download ({status})")),
        Err(err) => log_line(&format!("could not show the download: {err}")),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const STUDIO: &str = "http://127.0.0.1:5210";

    fn studio() -> Vec<String> {
        vec![STUDIO.to_string()]
    }

    fn browser(raw: &str) -> bool {
        matches!(classify_link(raw, &studio()), LinkAction::Browser(_))
    }

    #[test]
    fn web_and_mail_links_go_to_the_default_apps() {
        assert!(browser("https://example.com/a?b=c#d"));
        assert!(browser("http://example.com/docs"));
        assert!(browser("mailto:team@example.com"));
        assert!(browser("mailto:team@example.com?subject=Hi%20there&body=Hello"));
        assert!(browser("mailto:?to=team@example.com&subject=Hi"));
    }

    #[test]
    fn unsafe_or_foreign_links_are_dropped() {
        for raw in [
            "",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "ftp://example.com/x",
            "tauri://localhost/",
            "https://user:pass@example.com/",
            "https://",
            "mailto:",
            "mailto:team@example.com?attach=/etc/passwd",
            "https://example.com/\u{7}bell",
        ] {
            assert_eq!(classify_link(raw, &studio()), LinkAction::Ignore, "{raw:?}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_LINK_LEN));
        assert_eq!(classify_link(&long, &studio()), LinkAction::Ignore);
    }

    #[test]
    fn a_render_link_on_the_studio_server_is_opened_by_that_server() {
        assert_eq!(
            classify_link(
                "http://127.0.0.1:5210/api/projects/my%20video/renders/file/out%201.mp4?x=1",
                &studio()
            ),
            LinkAction::RenderFile {
                origin: STUDIO.to_string(),
                project: "my%20video".to_string(),
                file: "out%201.mp4".to_string(),
            }
        );
    }

    #[test]
    fn other_loopback_addresses_are_never_opened() {
        for raw in [
            // Another port on loopback, and the right port with another path.
            "http://127.0.0.1:5211/api/projects/p/renders/file/a.mp4",
            "http://127.0.0.1:5210/api/projects/p/renders/a.mp4/open",
            "http://127.0.0.1:5210/api/projects/p/renders/file/a.mp4/extra",
            "http://127.0.0.1:5210/api/projects/p/renders/file/..",
            "http://127.0.0.1:5210/api/projects/../renders/file/a.mp4",
            "http://localhost:3000/",
            "http://[::1]:5210/",
        ] {
            assert_eq!(classify_link(raw, &studio()), LinkAction::Ignore, "{raw}");
        }
        // No Studio server on screen: even its path pattern opens nothing.
        assert_eq!(
            classify_link("http://127.0.0.1:5210/api/projects/p/renders/file/a.mp4", &[]),
            LinkAction::Ignore
        );
    }

    #[test]
    fn each_open_project_server_opens_its_own_renders() {
        let both = vec![STUDIO.to_string(), "http://127.0.0.1:5211".to_string()];
        for origin in &both {
            assert_eq!(
                classify_link(&format!("{origin}/api/projects/p/renders/file/a.mp4"), &both),
                LinkAction::RenderFile {
                    origin: origin.clone(),
                    project: "p".to_string(),
                    file: "a.mp4".to_string(),
                }
            );
        }
    }

    fn origins() -> Vec<String> {
        vec!["http://127.0.0.1:5190".to_string(), STUDIO.to_string()]
    }

    fn parse(raw: &str) -> Url {
        Url::parse(raw).expect("a test URL")
    }

    #[test]
    fn downloads_start_only_from_the_shells_own_pages() {
        let origins = origins();
        for raw in [
            "http://127.0.0.1:5210/api/projects/p/renders/file/a.mp4",
            "http://127.0.0.1:5190/anything",
            "blob:http://127.0.0.1:5210/6f1c9a52-0c1e-4d2f-9a53-8f5b6c1d7e90",
        ] {
            assert!(download_allowed(&parse(raw), &origins), "{raw}");
        }
        for raw in [
            "http://127.0.0.1:6000/a.bin",
            "https://example.com/a.bin",
            "blob:https://example.com/6f1c9a52",
            "blob:http://127.0.0.1:6000/6f1c9a52",
            "data:text/plain;base64,aGk=",
            "file:///etc/passwd",
        ] {
            assert!(!download_allowed(&parse(raw), &origins), "{raw}");
        }
        assert!(!download_allowed(&parse("http://127.0.0.1:5210/a"), &[]));
    }

    #[test]
    fn an_accepted_download_remembers_its_destination_until_it_finishes() {
        let url = parse("http://127.0.0.1:5210/api/projects/p/renders/file/pending-test.mp4");
        assert!(download_requested(&url, Path::new("/tmp/pending-test.mp4"), &origins()));
        let pending = PENDING_DOWNLOADS
            .lock()
            .expect("lock")
            .as_ref()
            .and_then(|map| map.get(url.as_str()).and_then(|queue| queue.front().cloned()));
        assert_eq!(pending, Some(PathBuf::from("/tmp/pending-test.mp4")));
        // A failed download forgets it and reveals nothing.
        download_finished(&url, None, false);
        assert!(PENDING_DOWNLOADS
            .lock()
            .expect("lock")
            .as_ref()
            .is_none_or(|map| !map.contains_key(url.as_str())));
        // A refused one is never remembered.
        let foreign = parse("https://example.com/pending-test.bin");
        assert!(!download_requested(&foreign, Path::new("/tmp/x"), &origins()));
        assert!(PENDING_DOWNLOADS
            .lock()
            .expect("lock")
            .as_ref()
            .is_none_or(|map| !map.contains_key(foreign.as_str())));
    }

    #[test]
    fn two_downloads_of_one_url_finish_in_the_order_they_started() {
        let mut pending = PendingDownloads::new();
        remember_download(&mut pending, "blob:a", PathBuf::from("/tmp/one.mp4"));
        remember_download(&mut pending, "blob:a", PathBuf::from("/tmp/two.mp4"));
        remember_download(&mut pending, "blob:b", PathBuf::from("/tmp/other.mp4"));
        assert_eq!(settle_download(&mut pending, "blob:a"), Some(PathBuf::from("/tmp/one.mp4")));
        assert_eq!(settle_download(&mut pending, "blob:a"), Some(PathBuf::from("/tmp/two.mp4")));
        assert_eq!(settle_download(&mut pending, "blob:a"), None);
        assert!(!pending.contains_key("blob:a"), "an empty queue leaves no entry");
        assert_eq!(settle_download(&mut pending, "blob:b"), Some(PathBuf::from("/tmp/other.mp4")));
    }

    #[test]
    fn the_open_render_request_names_the_servers_open_route() {
        use std::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = vec![0u8; 1024];
            let n = stream.read(&mut request).expect("read");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .expect("write");
            String::from_utf8_lossy(&request[..n]).into_owned()
        });
        let status = open_render_file(&format!("http://127.0.0.1:{port}"), "my%20video", "out.mp4")
            .expect("the request completes");
        assert_eq!(status, 200);
        let request = server.join().expect("join");
        assert!(
            request.starts_with("POST /api/projects/my%20video/renders/out.mp4/open HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(request.contains(&format!("Host: 127.0.0.1:{port}\r\n")), "{request}");
    }
}
