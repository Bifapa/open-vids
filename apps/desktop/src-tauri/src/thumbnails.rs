//! Background thumbnail refresh after a project opens.
//!
//! Studio's own route is `GET /api/projects/:id/thumbnail/index.html` (see
//! `packages/studio-server/src/routes/thumbnail.ts`); the bytes land in the
//! app-data thumbnails dir via `HomeServer::cache_thumbnail`.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

use super::AppState;

/// Fetch a fresh thumbnail from the running Studio server and cache it for
/// the home page. Studio's own route is
/// `GET /api/projects/:id/thumbnail/index.html` (see
/// `packages/studio-server/src/routes/thumbnail.ts`); the bytes land in the
/// app-data thumbnails dir via `HomeServer::cache_thumbnail`.
pub fn refresh_thumbnail_async(app: &tauri::AppHandle, dir: PathBuf, id: String) {
    let handle = app.clone();
    std::thread::spawn(move || {
        // Give the Studio server a head start: it was just spawned (prod) or
        // hot-reloading a new symlink (dev). If the project is not open by
        // then (its tab was closed), give up — the card placeholder covers
        // the gap; fetch_bytes retries the connection itself.
        std::thread::sleep(std::time::Duration::from_secs(2));
        let key = super::recents::project_key(&dir);
        let Some(origin) = handle.try_state::<Mutex<AppState>>().and_then(|s| {
            s.lock()
                .ok()
                .and_then(|s| s.tabs.origin_of(&key).map(str::to_string))
        }) else {
            return;
        };
        let url = format!(
            "{}/api/projects/{}/thumbnail/index.html?t=0.5&format=jpeg",
            origin,
            percent_encode(&id)
        );
        if let Some((bytes, ext)) = fetch_bytes(&url) {
            if let Some(state) = handle.try_state::<Mutex<AppState>>() {
                if let Ok(state) = state.lock() {
                    state.home.cache_thumbnail(&dir, &bytes, &ext);
                }
            }
        }
    });
}

fn percent_encode(value: &str) -> String {
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

/// Minimal blocking HTTP GET over a raw TCP stream (no new dependencies).
/// Returns the body plus a jpg/png extension guess from Content-Type.
/// Handles both `Content-Length` and `Transfer-Encoding: chunked` bodies —
/// Hono (the Studio server) uses chunked encoding for generated thumbnails.
fn fetch_bytes(url: &str) -> Option<(Vec<u8>, String)> {
    let (_, after) = url.split_once("://")?;
    let (authority, path) = after.split_once('/').unwrap_or((after, ""));
    let (host, port) = authority.split_once(':')?;
    let port: u16 = port.parse().ok()?;
    let addr = format!("127.0.0.1:{port}");
    if host != "127.0.0.1" && host != "localhost" {
        return None;
    }
    for _ in 0..30 {
        if let Ok(mut stream) = std::net::TcpStream::connect(&addr) {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
            let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(10)));
            let req = format!(
                "GET /{path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\nAccept: image/*\r\n\r\n"
            );
            use std::io::{Read, Write};
            if stream.write_all(req.as_bytes()).is_err() {
                return None;
            }
            let mut out = Vec::new();
            if stream.read_to_end(&mut out).is_err() {
                return None;
            }
            let split = out.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
            let head = String::from_utf8_lossy(&out[..split]).into_owned();
            let status = head.lines().next().unwrap_or("");
            if !status.contains(" 200") {
                return None;
            }
            let ext = if head.to_lowercase().contains("image/png") {
                "png"
            } else {
                "jpg"
            };
            let raw_body = &out[split..];
            let body = if head.to_lowercase().contains("transfer-encoding: chunked") {
                decode_chunked(raw_body)?
            } else {
                raw_body.to_vec()
            };
            return Some((body, ext.to_string()));
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    None
}

/// Decode a `Transfer-Encoding: chunked` body. Returns None on malformed
/// framing rather than garbage bytes.
pub(crate) fn decode_chunked(raw: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut pos = 0;
    loop {
        let line_end = raw[pos..]
            .windows(2)
            .position(|w| w == b"\r\n")
            .map(|i| pos + i)?;
        let line = std::str::from_utf8(&raw[pos..line_end]).ok()?;
        // Chunk extensions (`1a;foo=bar`) are legal; the size precedes `;`.
        let size_str = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_str, 16).ok()?;
        pos = line_end + 2;
        if size == 0 {
            break;
        }
        let end = pos.checked_add(size)?;
        if end > raw.len() {
            return None;
        }
        out.extend_from_slice(&raw[pos..end]);
        pos = end;
        // Each chunk is followed by CRLF.
        if raw.get(pos..pos + 2) != Some(b"\r\n") {
            return None;
        }
        pos += 2;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_chunked_bodies() {
        // Two chunks + terminator, with a chunk extension on the first.
        let raw = b"5;ext=1\r\nhello\r\n 6\r\n world\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(raw).unwrap(), b"hello world");
    }

    #[test]
    fn rejects_truncated_chunks() {
        assert!(decode_chunked(b"a\r\nshort\r\n0\r\n\r\n").is_none());
        assert!(decode_chunked(b"zz\r\n").is_none());
    }
}
