//! Per-launch token + origin protection for the home server.
//!
//! Any loopback HTTP API lets local pages (and any visited website that
//! guesses the port) trigger folder pickers and deletes. Two mitigations:
//! - A 128-bit token minted per launch, injected into the served HTML and
//!   required (as `X-OpenVids-Token`) on every non-GET or `/api` request.
//!   GETs for `/`, thumbnails and static assets stay open so the page and
//!   its images load with plain `<img>` tags.
//! - `Host`/`Origin` allowlisting: the Host must be `127.0.0.1:<port>` (or
//!   `localhost:<port>`), and a present `Origin` must match the server's
//!   own origin. A foreign website's `fetch()` carries its own Origin and
//!   fails this check even if it guessed the token-less GETs.

use std::collections::HashMap;

/// The request header carrying the per-launch token.
pub const TOKEN_HEADER: &str = "x-openvids-token";

/// A minted per-launch token.
#[derive(Debug, Clone)]
pub struct HomeToken(String);

impl HomeToken {
    pub fn generate() -> Self {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).expect("os randomness for the home token");
        Self(bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
    }

    #[cfg(test)]
    pub fn for_test() -> Self {
        Self("test-token".to_string())
    }

    pub fn value(&self) -> &str {
        &self.0
    }

    pub fn matches(&self, provided: Option<&str>) -> bool {
        match provided {
            Some(value) => constant_time_eq(self.0.as_bytes(), value.as_bytes()),
            None => false,
        }
    }

    /// Re-wrap a known-good value (the server comparing a presented token).
    pub fn from_value(value: &str) -> Self {
        Self(value.to_string())
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// A parsed HTTP request head: method, path, headers.
#[derive(Debug)]
pub struct Head {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
}

impl Head {
    pub fn parse(raw: &str) -> Option<Self> {
        let mut lines = raw.lines();
        let request_line = lines.next()?;
        let mut parts = request_line.split_whitespace();
        let method = parts.next()?.to_string();
        let target = parts.next()?;
        // Strip any query string for routing; callers needing params parse them.
        let path = target.split('?').next().unwrap_or("/").to_string();
        let mut headers = HashMap::new();
        for line in lines {
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_lowercase(), value.trim().to_string());
            }
        }
        Some(Self {
            method,
            path,
            headers,
        })
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_lowercase()).map(String::as_str)
    }
}

/// Whether this request needs the token: every `/api` request plus any
/// mutating method. Plain page/asset/thumbnail GETs stay open.
///
/// One deliberate exception: `POST /api/report/open`, which the Studio
/// sidecar's page calls (it has no token — it is a different loopback origin)
/// to open or focus the bug-report window. It only opens a window: no data in
/// or out. `origin_allowed` still demands a loopback origin for it, so a
/// visited website cannot reach even this route.
pub fn requires_token(method: &str, path: &str) -> bool {
    if is_report_open(method, path) {
        return false;
    }
    if path.starts_with("/api/") {
        return true;
    }
    !method.eq_ignore_ascii_case("GET") && !method.eq_ignore_ascii_case("HEAD")
}

fn is_report_open(method: &str, path: &str) -> bool {
    method.eq_ignore_ascii_case("POST") && path == "/api/report/open"
}

/// An `http://127.0.0.1:<port>` or `http://localhost:<port>` origin — any
/// port, because the Studio sidecar runs on its own.
fn loopback_origin(origin: &str) -> bool {
    url::Url::parse(origin)
        .map(|url| {
            url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
                && url.port().is_some()
        })
        .unwrap_or(false)
}

/// Check `Host`/`Origin` scoping for `port`.
///
/// - Host must name this server (`127.0.0.1:<port>` or `localhost:<port>`).
///   Missing Host (HTTP/1.0 clients, curl smoke tests) is allowed through —
///   the token still guards mutations.
/// - A present Origin must equal the server's own origin. Plain navigations
///   and `<img>` loads send no Origin and pass.
/// - The one exception is `POST /api/report/open`: its Origin may be any
///   loopback origin (the Studio sidecar's page calls it cross-port).
pub fn origin_allowed(head: &Head, port: u16) -> bool {
    if let Some(host) = head.header("host") {
        let host = host.trim().to_lowercase();
        let ok = host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}");
        if !ok {
            return false;
        }
    }
    if let Some(origin) = head.header("origin") {
        let origin = origin.trim().to_lowercase();
        if is_report_open(&head.method, &head.path) {
            return loopback_origin(&origin);
        }
        let local = [
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
        ];
        if !local.contains(&origin) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(method: &str, path: &str, headers: &[(&str, &str)]) -> Head {
        Head {
            method: method.to_string(),
            path: path.to_string(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_lowercase(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn token_must_match_exactly() {
        let token = HomeToken::for_test();
        assert!(token.matches(Some("test-token")));
        assert!(!token.matches(Some("wrong")));
        assert!(!token.matches(None));
        // Uniqueness of real tokens.
        assert_ne!(HomeToken::generate().value(), HomeToken::generate().value());
    }

    #[test]
    fn api_gets_need_the_token_but_page_loads_do_not() {
        assert!(requires_token("GET", "/api/recents"));
        assert!(requires_token("POST", "/api/open"));
        assert!(requires_token("DELETE", "/api/whatever"));
        assert!(!requires_token("GET", "/"));
        assert!(!requires_token("GET", "/thumb/abc.jpg"));
    }

    #[test]
    fn only_the_report_open_route_is_exempt_from_the_token() {
        assert!(!requires_token("POST", "/api/report/open"));
        assert!(
            requires_token("GET", "/api/report/open"),
            "the method matters"
        );
        assert!(requires_token("POST", "/api/report/submit"));
        assert!(requires_token("POST", "/api/report/draft"));
        assert!(requires_token("POST", "/api/report/open/x"));
    }

    #[test]
    fn the_report_open_exemption_accepts_loopback_origins_only() {
        let port = 5199;
        let studio = "http://127.0.0.1:5333";
        assert!(origin_allowed(
            &head(
                "POST",
                "/api/report/open",
                &[("host", "127.0.0.1:5199"), ("origin", studio)]
            ),
            port
        ));
        assert!(origin_allowed(
            &head(
                "POST",
                "/api/report/open",
                &[
                    ("host", "localhost:5199"),
                    ("origin", "http://localhost:8080")
                ]
            ),
            port
        ));
        // A foreign website cannot open the window...
        for origin in ["https://evil.com", "http://127.0.0.1.evil.com", "null"] {
            assert!(
                !origin_allowed(
                    &head(
                        "POST",
                        "/api/report/open",
                        &[("host", "127.0.0.1:5199"), ("origin", origin)]
                    ),
                    port
                ),
                "{origin} must be rejected"
            );
        }
        // ...and the exemption does not leak into any other route.
        assert!(!origin_allowed(
            &head(
                "POST",
                "/api/report/submit",
                &[("host", "127.0.0.1:5199"), ("origin", studio)]
            ),
            port
        ));
        assert!(!origin_allowed(
            &head(
                "GET",
                "/api/report/open",
                &[("host", "127.0.0.1:5199"), ("origin", studio)]
            ),
            port
        ));
        // A foreign Host is always refused.
        assert!(!origin_allowed(
            &head(
                "POST",
                "/api/report/open",
                &[("host", "evil.com"), ("origin", studio)]
            ),
            port
        ));
    }

    #[test]
    fn foreign_hosts_and_origins_are_rejected() {
        let port = 5199;
        assert!(origin_allowed(
            &head("GET", "/", &[("host", "127.0.0.1:5199")]),
            port
        ));
        assert!(origin_allowed(
            &head("GET", "/", &[("host", "localhost:5199")]),
            port
        ));
        assert!(!origin_allowed(
            &head("GET", "/", &[("host", "evil.com")]),
            port
        ));
        assert!(!origin_allowed(
            &head(
                "GET",
                "/",
                &[("host", "127.0.0.1:5199"), ("origin", "http://evil.com")]
            ),
            port
        ));
        assert!(origin_allowed(
            &head(
                "GET",
                "/",
                &[
                    ("host", "127.0.0.1:5199"),
                    ("origin", "http://127.0.0.1:5199")
                ]
            ),
            port
        ));
        // No headers at all (curl, HTTP/1.0): allowed, token still applies.
        assert!(origin_allowed(&head("GET", "/", &[]), port));
    }

    #[test]
    fn request_line_parsing() {
        let raw =
            "POST /api/open?x=1 HTTP/1.1\r\nHost: 127.0.0.1:5\r\nX-OpenVids-Token: abc\r\n\r\n";
        let head = Head::parse(raw).unwrap();
        assert_eq!(head.method, "POST");
        assert_eq!(head.path, "/api/open");
        assert_eq!(head.header("X-OpenVids-Token"), Some("abc"));
    }
}
