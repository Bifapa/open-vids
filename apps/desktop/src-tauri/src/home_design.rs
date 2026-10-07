//! The Projects page's design-system routes, over the same library the Studio server serves under
//! `/api/design-systems/*` (see `design_library`).
//!
//! JSON, token-guarded like every `/api/` route:
//!
//! - `GET    /api/design-systems` → `{ systems: DesignSystemSummary[] }`, newest updated first
//! - `GET    /api/design-systems/:id` → the summary + `fonts` (`family`, `role`, `source`, `portable`,
//!   `licenseName` or null, `guess`) + `transitions` (a count) + `versions` (a count)
//! - `PATCH  /api/design-systems/:id {name}` → the summary (rename, no new version)
//! - `DELETE /api/design-systems/:id` → `{ ok: true }`
//!
//! Files, open `GET`s without the token (the `/thumb/<file>` precedent: a page loads them as `<img>` / `<iframe>`
//! `src` and cannot send the token header):
//!
//! - `/design-files/<id>/thumbnail.svg` — the card image,
//! - `/design-files/<id>/system.html` — the showcase (framed by the page),
//! - `/design-files/<id>/logo.<ext>` and `/design-files/<id>/fonts/<file>` — what `system.html` references.
//!
//! Nothing else is served (not `tokens.css`, `meta.json` or `versions/`), and only through
//! `DesignLibrary::file`'s strict relative-path rules. Every answer carries `Content-Security-Policy: sandbox
//! allow-same-origin; default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:` and
//! `X-Content-Type-Options: nosniff`: the page frames `system.html` with `sandbox="allow-same-origin"` (no
//! `allow-scripts`, so no script can ever run, in the frame or when a file is opened on its own) and the document
//! keeps this server's origin, so its font requests are same-origin and need no CORS. No answer carries an
//! `Access-Control-Allow-*` header, and a request from another origin is refused by `home_auth::origin_allowed`.
//!
//! Errors are `{ "error": { "code", "message" } }` with the status of `DesignError::status`.

use std::net::TcpStream;

use serde_json::{json, Value};

use super::design_library::{DesignError, DesignLibrary};
use super::home_api::respond_json;
use super::home_routes::{respond, respond_with_headers};

const PREFIX: &str = "/api/design-systems";
const FILES_PREFIX: &str = "/design-files/";
const SANDBOX_HEADERS: &str = "Content-Security-Policy: sandbox allow-same-origin; default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:\r\nX-Content-Type-Options: nosniff\r\n";

/// Whether `path` belongs to the JSON routes (`home_routes` hands it over).
pub fn owns(path: &str) -> bool {
    path == PREFIX || path.strip_prefix(PREFIX).is_some_and(|rest| rest.starts_with('/'))
}

/// Whether `path` belongs to the open file routes.
pub fn owns_files(path: &str) -> bool {
    path.starts_with(FILES_PREFIX)
}

/// What a JSON request asks for.
#[derive(Debug, PartialEq, Eq)]
enum Target<'a> {
    List,
    System(&'a str),
}

fn target(path: &str) -> Option<Target<'_>> {
    let rest = path.strip_prefix(PREFIX)?;
    if rest.is_empty() {
        return Some(Target::List);
    }
    let id = rest.strip_prefix('/')?;
    (!id.contains('/')).then_some(Target::System(id))
}

/// `(id, file)` of `/design-files/<id>/<file>` when the file is one the page may load: the showcase, the
/// thumbnail, the logo or a font.
fn served_file(path: &str) -> Option<(&str, &str)> {
    let (id, file) = path.strip_prefix(FILES_PREFIX)?.split_once('/')?;
    let served = matches!(file, "system.html" | "thumbnail.svg")
        || file.strip_prefix("logo.").is_some_and(|ext| !ext.is_empty())
        || file.strip_prefix("fonts/").is_some_and(|name| !name.is_empty());
    (!id.is_empty() && served).then_some((id, file))
}

fn body_json(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

fn fail(stream: &mut TcpStream, err: &DesignError) {
    respond_json(stream, err.status(), &json!({ "error": { "code": err.code, "message": err.message } }));
}

fn answer<T: serde::Serialize>(stream: &mut TcpStream, result: Result<T, DesignError>) {
    match result.and_then(|value| {
        serde_json::to_value(value)
            .map_err(|e| DesignError::new("unavailable", format!("could not encode the answer: {e}")))
    }) {
        Ok(value) => respond_json(stream, 200, &value),
        Err(err) => fail(stream, &err),
    }
}

/// Handle one JSON request for which `owns(path)` holds.
pub fn handle(stream: &mut TcpStream, method: &str, path: &str, body: &[u8]) {
    handle_in(&DesignLibrary::open(), stream, method, path, body);
}

fn handle_in(library: &DesignLibrary, stream: &mut TcpStream, method: &str, path: &str, body: &[u8]) {
    let Some(target) = target(path) else {
        return respond_json(stream, 404, &json!({ "error": { "code": "not_found", "message": "not found" } }));
    };
    match (method, target) {
        ("GET", Target::List) => respond_json(stream, 200, &json!({ "systems": library.list() })),
        ("GET", Target::System(id)) => answer(stream, library.detail(id)),
        ("PATCH", Target::System(id)) => {
            // A missing or non-text name is refused like an unusable one.
            let name = body_json(body).get("name").and_then(Value::as_str).map(str::to_string);
            answer(stream, library.rename(id, name.as_deref().unwrap_or_default()))
        }
        ("DELETE", Target::System(id)) => answer(stream, library.delete(id).map(|()| json!({ "ok": true }))),
        _ => respond(stream, 404, "text/plain", b"not found"),
    }
}

/// Serve one `GET /design-files/<id>/<file>` for which `owns_files(path)` holds.
pub fn serve_file(stream: &mut TcpStream, path: &str) {
    serve_file_in(&DesignLibrary::open(), stream, path);
}

fn serve_file_in(library: &DesignLibrary, stream: &mut TcpStream, path: &str) {
    let Some((id, file)) = served_file(path) else {
        return respond(stream, 404, "text/plain", b"not found");
    };
    match library.file(id, file) {
        Ok((bytes, content_type)) => respond_with_headers(stream, 200, content_type, &bytes, SANDBOX_HEADERS),
        Err(err) => fail(stream, &err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design_library::fixtures::write_system;
    use crate::design_lock::scratch::Dir;
    use std::io::{Read, Write};
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn owns_only_the_design_routes() {
        assert!(owns("/api/design-systems"));
        assert!(owns("/api/design-systems/brand"));
        assert!(!owns("/api/design-systemsx"));
        assert!(!owns("/api/design"));
        assert!(!owns("/design-systems"));
        assert!(owns_files("/design-files/brand/system.html"));
        assert!(!owns_files("/design-files"));
        assert!(!owns_files("/api/design-files/brand/system.html"));
    }

    #[test]
    fn json_targets_are_parsed_strictly() {
        assert_eq!(target("/api/design-systems"), Some(Target::List));
        assert_eq!(target("/api/design-systems/brand"), Some(Target::System("brand")));
        assert_eq!(target("/api/design-systems/"), Some(Target::System("")));
        for none in [
            "/api/design-systems/brand/thumbnail",
            "/api/design-systems/brand/files/system.html",
            "/api/design-systems/brand/",
            "/api/other",
        ] {
            assert_eq!(target(none), None, "{none}");
        }
    }

    #[test]
    fn only_the_showcase_thumbnail_logo_and_fonts_are_served() {
        for (path, id, file) in [
            ("/design-files/brand/system.html", "brand", "system.html"),
            ("/design-files/brand/thumbnail.svg", "brand", "thumbnail.svg"),
            ("/design-files/brand/logo.svg", "brand", "logo.svg"),
            ("/design-files/brand/fonts/a.woff2", "brand", "fonts/a.woff2"),
        ] {
            assert_eq!(served_file(path), Some((id, file)), "{path}");
        }
        for none in [
            "/design-files/brand/tokens.css",
            "/design-files/brand/meta.json",
            "/design-files/brand/versions/1/system.html",
            "/design-files/brand/logo.",
            "/design-files/brand/fonts/",
            "/design-files/brand/",
            "/design-files/brand",
            "/design-files//system.html",
            "/design-files/brand/thumbnail",
        ] {
            assert_eq!(served_file(none), None, "{none}");
        }
    }

    /// One request against a scratch library; `(status, head, body)`.
    fn request(library_dir: &Path, method: &str, path: &str, body: &[u8]) -> (u16, String, Vec<u8>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let library = DesignLibrary::at(library_dir.to_path_buf());
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        client.set_read_timeout(Some(Duration::from_secs(15))).expect("timeout");
        client.write_all(head.as_bytes()).expect("write head");
        client.write_all(body).expect("write body");
        let (mut server_side, _) = listener.accept().expect("accept");
        // The whole request is read before answering, or closing the socket would reset the client's read.
        let mut request = vec![0u8; head.len() + body.len()];
        server_side.read_exact(&mut request).expect("read the request");
        if owns_files(path) {
            serve_file_in(&library, &mut server_side, path);
        } else {
            handle_in(&library, &mut server_side, method, path, body);
        }
        drop(server_side);
        let mut out = Vec::new();
        client.read_to_end(&mut out).expect("read");
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").expect("a head");
        let head = String::from_utf8_lossy(&out[..split]).into_owned();
        let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).expect("a status");
        (status, head, out[split + 4..].to_vec())
    }

    fn json_of(body: &[u8]) -> Value {
        serde_json::from_slice(body).expect("json body")
    }

    #[test]
    fn the_json_routes_list_show_rename_and_delete() {
        let dir = Dir::new("home-design");
        let root = dir.path();
        write_system(root, "brand", "Brand Kit", 10);
        write_system(root, "newer", "Newer", 20);

        let (status, _, body) = request(root, "GET", "/api/design-systems", b"");
        assert_eq!(status, 200);
        let ids: Vec<String> = json_of(&body)["systems"]
            .as_array()
            .expect("systems")
            .iter()
            .map(|s| s["id"].as_str().expect("id").to_string())
            .collect();
        assert_eq!(ids, ["newer", "brand"]);

        let (status, _, body) = request(root, "GET", "/api/design-systems/brand", b"");
        let detail = json_of(&body);
        assert_eq!(
            (status, detail["name"].clone(), detail["transitions"].clone(), detail["versions"].clone()),
            (200, json!("Brand Kit"), json!(2), json!(1))
        );
        assert_eq!(
            detail["fonts"][0],
            json!({ "family": "Inter", "role": "display", "source": "google", "portable": true, "licenseName": "SIL OFL 1.1", "guess": false })
        );

        for (path, status, code) in [
            ("/api/design-systems/missing", 404, "not_found"),
            ("/api/design-systems/Bad_Id", 400, "invalid_request"),
            ("/api/design-systems/", 400, "invalid_request"),
        ] {
            let (got, _, body) = request(root, "GET", path, b"");
            assert_eq!((got, json_of(&body)["error"]["code"].clone()), (status, json!(code)), "{path}");
        }

        let (status, _, body) = request(root, "PATCH", "/api/design-systems/brand", br#"{"name":" Renamed "}"#);
        assert_eq!((status, json_of(&body)["name"].clone()), (200, json!("Renamed")));
        for bad in [&br#"{"name":""}"#[..], br#"{"name":5}"#, br#"{}"#, b"not json", br#"{"name":"a<b"}"#] {
            let (status, _, body) = request(root, "PATCH", "/api/design-systems/brand", bad);
            assert_eq!(
                (status, json_of(&body)["error"]["code"].clone()),
                (400, json!("invalid_request")),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
        let (status, _, body) = request(root, "PATCH", "/api/design-systems/nope", br#"{"name":"x"}"#);
        assert_eq!((status, json_of(&body)["error"]["code"].clone()), (404, json!("not_found")));

        let (status, _, body) = request(root, "DELETE", "/api/design-systems/brand", b"");
        assert_eq!((status, json_of(&body)), (200, json!({ "ok": true })));
        assert!(!root.join("brand").exists());
        let (status, _, _) = request(root, "DELETE", "/api/design-systems/brand", b"");
        assert_eq!(status, 404);
        let (status, _, _) = request(root, "PUT", "/api/design-systems/newer", b"{}");
        assert_eq!(status, 404, "the library is written by Studio, not here");
        assert!(root.join("newer/meta.json").is_file());
    }

    #[test]
    fn files_are_served_sandboxed_and_only_the_allowed_ones() {
        let dir = Dir::new("home-design-files");
        let root = dir.path();
        write_system(root, "brand", "Brand Kit", 10);

        let (status, head, body) = request(root, "GET", "/design-files/brand/thumbnail.svg", b"");
        assert_eq!(status, 200);
        assert!(head.contains("Content-Type: image/svg+xml"), "{head}");
        assert!(String::from_utf8_lossy(&body).starts_with("<svg"));

        let (status, head, body) = request(root, "GET", "/design-files/brand/system.html", b"");
        assert_eq!(status, 200);
        for header in [
            "Content-Type: text/html; charset=utf-8",
            "Content-Security-Policy: sandbox allow-same-origin; default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:",
            "X-Content-Type-Options: nosniff",
        ] {
            assert!(head.contains(header), "{header} missing in {head}");
        }
        // Fonts are same-origin requests of the framed page: no CORS grant on any answer.
        assert!(!head.to_ascii_lowercase().contains("access-control-"), "{head}");
        for (path, content_type) in [
            ("/design-files/brand/fonts/inter-400.woff2", "font/woff2"),
            ("/design-files/brand/logo.svg", "image/svg+xml"),
        ] {
            let (status, head, _) = request(root, "GET", path, b"");
            assert_eq!(status, 200, "{path}");
            assert!(head.contains(&format!("Content-Type: {content_type}")), "{head}");
            assert!(head.contains("X-Content-Type-Options: nosniff"), "{head}");
            assert!(!head.to_ascii_lowercase().contains("access-control-"), "{head}");
        }
        assert_eq!(body, std::fs::read(root.join("brand/system.html")).expect("file"));

        for (path, status) in [
            ("/design-files/brand/tokens.css", 404),
            ("/design-files/brand/meta.json", 404),
            ("/design-files/brand/fonts/..%2Fmeta.json", 400),
            ("/design-files/brand/fonts/../meta.json", 400),
            ("/design-files/brand/logo.png", 404),
            ("/design-files/missing/system.html", 404),
            ("/design-files/Bad_Id/system.html", 400),
            ("/design-files/../brand/system.html", 404),
        ] {
            let (got, _, _) = request(root, "GET", path, b"");
            assert_eq!(got, status, "{path}");
        }
    }
}
