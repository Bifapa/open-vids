//! The report window's API (`/api/report/*`, contract 2): draft, screenshots,
//! pin, submit, open. Token-protected like every other `/api` route except
//! `POST /api/report/open`, which `home_auth` lets through from loopback
//! origins because the Studio sidecar has no token (it only opens a window).
//!
//! The heavy lifting lives in `report`; this module is the thin HTTP shell.

use std::net::TcpStream;

use serde_json::{json, Value};

use super::home_api::respond_json;
use super::home_auth::Head;
use super::home_routes::{json_field, respond};
use super::report;

/// Everything this module answers, for `home_routes::route`.
pub fn owns(path: &str) -> bool {
    path == "/api/report" || path.starts_with("/api/report/")
}

pub fn handle(stream: &mut TcpStream, method: &str, path: &str, body: &[u8], head: &Head) {
    match (method, path) {
        ("GET", "/api/report/draft") => respond_json(stream, 200, &report::draft_json()),
        ("PUT", "/api/report/draft") => match report::draft_update(body) {
            Ok(()) => respond(stream, 204, "text/plain", b""),
            Err(message) => respond_json(
                stream,
                400,
                &json!({ "error": "invalid_request", "message": message }),
            ),
        },
        ("POST", "/api/report/screenshots") => upload(stream, head, body),
        ("POST", "/api/report/screenshots/capture") => capture(stream, body),
        ("POST", "/api/report/screenshots/pick") => pick(stream),
        ("POST", "/api/report/pin") => {
            let pinned = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|value| value.get("alwaysOnTop").and_then(Value::as_bool))
                .unwrap_or(false);
            report::set_pinned(pinned);
            respond(stream, 204, "text/plain", b"");
        }
        ("POST", "/api/report/submit") => match report::submit(submit_context(body).as_deref()) {
            (status, body) => respond_json(stream, status, &body),
        },
        ("POST", "/api/report/open") => {
            let context = json_field(body, "context")
                .filter(|c| matches!(c.as_str(), "projects" | "studio" | "menu"))
                .unwrap_or_else(|| "menu".to_string());
            report::open_window(&context);
            respond(stream, 204, "text/plain", b"");
        }
        ("GET", p) if p.starts_with("/api/report/screenshots/") => {
            let id = p.trim_start_matches("/api/report/screenshots/");
            match report::screenshot_bytes(id) {
                Some((mime, bytes)) => respond(stream, 200, report::mime_of(&mime), &bytes),
                None => respond(stream, 404, "text/plain", b"no such screenshot"),
            }
        }
        ("DELETE", p) if p.starts_with("/api/report/screenshots/") => {
            report::screenshot_remove(p.trim_start_matches("/api/report/screenshots/"));
            respond(stream, 204, "text/plain", b"");
        }
        _ => respond(stream, 404, "text/plain", b"not found"),
    }
}

fn submit_context(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("context")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

/// The raw image upload: the body is the image, the name rides in a header.
fn upload(stream: &mut TcpStream, head: &Head, body: &[u8]) {
    match report::screenshot_upload(head.header("x-file-name"), body) {
        Ok(shot) => respond_json(stream, 200, &shot.json()),
        Err(error) => respond_json(stream, error.status(), &json!({ "error": error.code() })),
    }
}

/// `POST /api/report/screenshots/capture`: `screencapture -i -x`.
fn capture(stream: &mut TcpStream, body: &[u8]) {
    let hide = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| value.get("hideWindow").and_then(Value::as_bool))
        .unwrap_or(true);
    match report::screenshot_capture(hide) {
        report::CaptureOutcome::Added(shot) => respond_json(stream, 200, &shot.json()),
        report::CaptureOutcome::Cancelled => {
            respond_json(stream, 200, &json!({ "cancelled": true }))
        }
        report::CaptureOutcome::Rejected(error) => {
            respond_json(stream, error.status(), &json!({ "error": error.code() }))
        }
    }
}

/// `POST /api/report/screenshots/pick`: the native picker.
fn pick(stream: &mut TcpStream) {
    let picked = report::screenshot_pick();
    respond_json(
        stream,
        200,
        &json!({
            "added": picked.added.iter().map(report::Screenshot::json).collect::<Vec<_>>(),
            "rejected": picked.rejected,
        }),
    )
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::path::PathBuf;
    use std::time::Duration;

    use crate::home::HomeServer;

    fn base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "openvids-home-report-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// One request through the real home server, with the headers as given.
    fn raw(origin: &str, request: &str) -> (u16, Vec<u8>) {
        let addr = origin.trim_start_matches("http://");
        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.read_to_end(&mut out).unwrap();
        let head_end = out
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .unwrap_or(out.len());
        let code = String::from_utf8_lossy(&out[..head_end])
            .split_whitespace()
            .nth(1)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        (code, out[head_end + 4..].to_vec())
    }

    #[test]
    fn the_report_window_route_is_the_one_loopback_call_without_a_token() {
        let dir = base("routes");
        let server = HomeServer::bind(dir.join("recents.json"), dir.join("thumbs")).unwrap();
        let origin = server.origin();
        let host = origin.trim_start_matches("http://");

        // The Studio sidecar's page: a different loopback origin, no token.
        let (code, _) = raw(
            &origin,
            &format!(
                "POST /api/report/open HTTP/1.1\r\nHost: {host}\r\nOrigin: http://127.0.0.1:5333\r\nContent-Type: text/plain\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{{\"context\":\"studio\"}}"
            ),
        );
        assert_eq!(code, 204);

        // The same call from a visited website is refused.
        let (code, _) = raw(
            &origin,
            &format!(
                "POST /api/report/open HTTP/1.1\r\nHost: {host}\r\nOrigin: https://evil.example\r\nContent-Type: text/plain\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{{\"context\":\"studio\"}}"
            ),
        );
        assert_eq!(code, 403);

        // Every other report route still needs the token.
        let (code, _) = raw(
            &origin,
            &format!(
                "GET /api/report/draft HTTP/1.1\r\nHost: {host}\r\nOrigin: http://127.0.0.1:5333\r\nConnection: close\r\n\r\n"
            ),
        );
        assert_eq!(code, 403, "the draft GET");
        let (code, _) = raw(
            &origin,
            &format!(
                "POST /api/report/submit HTTP/1.1\r\nHost: {host}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            ),
        );
        assert_eq!(code, 403, "the submit POST");

        // The page itself needs no token (the token is injected into it).
        let (code, body) = raw(
            &origin,
            &format!("GET /report HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
        );
        assert_eq!(code, 200);
        let page = String::from_utf8_lossy(&body).into_owned();
        assert!(page.contains(&format!(
            "window.OV_TOKEN = \"{}\"",
            server.token_for_test()
        )));
        assert!(!page.contains("__OV_BOOT__"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
