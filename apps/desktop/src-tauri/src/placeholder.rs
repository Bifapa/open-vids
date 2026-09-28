//! The screen shown before a project is open.
//!
//! A Tauri webview can only load a URL, and the production Studio is served by
//! the sidecar — which needs a project to serve. Rather than invent a UI, this
//! is a deliberately minimal loopback listener that answers every request with
//! one page telling the user which menu item to use. Dropping it when a project
//! opens costs a single navigation.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const PAGE: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenVids</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0d0f14;
        color: #eef2f7;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      main { max-width: 30rem; padding: 0 2rem; text-align: center; }
      h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 0.75rem; }
      p { color: #aab3c2; line-height: 1.6; margin: 0 0 1.25rem; }
      kbd {
        display: inline-block;
        padding: 0.2rem 0.55rem;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-bottom-width: 2px;
        border-radius: 0.4rem;
        background: #151923;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.9rem;
      }
      .hint { font-size: 0.85rem; color: #6d7686; margin-top: 2rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>No project open</h1>
      <p>Choose a HyperFrames project folder to start editing. It should contain an <code>index.html</code> composition.</p>
      <p><kbd>File</kbd> &nbsp;→&nbsp; <kbd>Open Project Folder…</kbd> &nbsp;(<kbd>⌘O</kbd>)</p>
      <p class="hint">OpenVids serves HyperFrames Studio from a local process on 127.0.0.1. It stops when OpenVids quits.</p>
    </main>
  </body>
</html>
"#;

/// A one-page loopback listener that stops when dropped.
pub struct PlaceholderServer {
    port: u16,
    stop: Arc<AtomicBool>,
    accept: std::net::TcpListener,
}

impl PlaceholderServer {
    pub fn bind() -> std::io::Result<Self> {
        let accept = TcpListener::bind(("127.0.0.1", 0))?;
        let port = accept.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);

        let shared = accept.try_clone()?;
        thread::spawn(move || {
            for stream in shared.incoming() {
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                match stream {
                    Ok(stream) => respond(stream),
                    // One bad client must not take the page down.
                    Err(_) => continue,
                }
            }
        });

        Ok(Self { port, stop, accept })
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for PlaceholderServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Unblock the blocking accept() so the thread can observe the flag.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        let _ = self.accept.set_nonblocking(true);
    }
}

fn respond(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    // Read only the head: the body, if any, is irrelevant to a page that
    // answers the same way to everything.
    let mut head = [0_u8; 2048];
    let _ = stream.read(&mut head);

    let body = format!("{PAGE}");
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}
