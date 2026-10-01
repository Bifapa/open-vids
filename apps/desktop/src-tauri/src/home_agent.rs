//! The Projects page's pass-through routes to the home agent runtime
//! (`agent_proxy`), beyond models and the global agent settings
//! (those two sit in `home_routes`).
//!
//! | page route (`/api/agent/…`, token-gated)  | runtime route                          |
//! |--------------------------------------------|----------------------------------------|
//! | `GET  providers`                           | `GET  /v1/providers`                   |
//! | `POST providers/refresh`                   | `POST /v1/providers/refresh`           |
//! | `GET  providers/<id>/models`               | `GET  /v1/providers/<id>/models`       |
//! | `POST providers/<id>/api-key`              | `POST /v1/providers/<id>/api-key`      |
//! | `POST providers/<id>/oauth/login`          | `POST /v1/providers/<id>/oauth/login`  |
//! | `POST providers/<id>/oauth/logout`         | `POST /v1/providers/<id>/oauth/logout` |
//! | `GET  oauth/logins/<login>`                | `GET  /v1/oauth/logins/<login>`        |
//! | `POST oauth/logins/<login>/input`          | `POST /v1/oauth/logins/<login>/input`  |
//! | `POST oauth/logins/<login>/cancel`         | `POST /v1/oauth/logins/<login>/cancel` |
//! | `POST jev/api-key`                         | `POST /v1/settings/jev/api-key`        |
//! | `POST jev/test`                            | `POST /v1/settings/jev/test`           |
//!
//! Body and status of the runtime's answer go back unchanged. The `<id>` and
//! `<login>` that land in the forwarded path are validated first
//! (`valid_provider_id`, `valid_login_id`).
//!
//! The in-app sign-in routes are start + poll, never held open: `oauth/login`
//! answers within the runtime's first-state wait (8 s at most), the poll,
//! input, cancel (3 s grace for the runtime to close its callback listener) and
//! logout routes answer at once, so the proxy's 30 s read timeout is ample.
//! The page polls `oauth/logins/<login>` until a final state.
//!
//! Secrets: the `api-key` routes carry API keys, and `oauth/logins/<login>/input`
//! a pasted authorization code, in their request bodies. Nothing in this path
//! logs a body — not the proxy, not the error answers below (their messages
//! never include request data).

use std::net::TcpStream;

use super::coded_error::CodedError;
use super::home_api::{method_not_allowed, proxy_agent, respond_error, route_not_found};

/// Longest provider id the page may name. Real ids are short slugs
/// (`anthropic`, `openai-codex`, …).
const MAX_PROVIDER_ID_LEN: usize = 64;

/// `[A-Za-z0-9._-]`, 1–64 characters, starting with a letter or digit (so
/// `.` and `..` can never reach the forwarded path).
pub fn valid_provider_id(id: &str) -> bool {
    id.len() <= MAX_PROVIDER_ID_LEN
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// What a `/api/agent/providers/<…>` request turned into.
#[derive(Debug, PartialEq, Eq)]
pub enum ProviderRoute {
    /// Forward `method` to this runtime path.
    Forward { method: &'static str, path: String },
    /// A known route with an id that is not allowed.
    BadId,
    /// A known route, the wrong HTTP method.
    WrongMethod,
    /// Not a provider route at all.
    Unknown,
}

const PROVIDERS_PREFIX: &str = "/api/agent/providers/";

/// Map `/api/agent/providers/<id>/{models,api-key,oauth/login,oauth/logout}`.
/// (`/api/agent/providers` and `/api/agent/providers/refresh` are fixed routes
/// in `home_routes`.) `path` is already percent-decoded, so an id that smuggles
/// `/` or `..` shows up here as such and fails the check.
pub fn map_provider_route(method: &str, path: &str) -> ProviderRoute {
    let Some(rest) = path.strip_prefix(PROVIDERS_PREFIX) else {
        return ProviderRoute::Unknown;
    };
    let (id, suffix, wanted) = if let Some(id) = rest.strip_suffix("/models") {
        (id, "models", "GET")
    } else if let Some(id) = rest.strip_suffix("/api-key") {
        (id, "api-key", "POST")
    } else if let Some(id) = rest.strip_suffix("/oauth/login") {
        (id, "oauth/login", "POST")
    } else if let Some(id) = rest.strip_suffix("/oauth/logout") {
        (id, "oauth/logout", "POST")
    } else {
        return ProviderRoute::Unknown;
    };
    if !valid_provider_id(id) {
        return ProviderRoute::BadId;
    }
    if !method.eq_ignore_ascii_case(wanted) {
        return ProviderRoute::WrongMethod;
    }
    ProviderRoute::Forward {
        method: wanted,
        path: format!("/v1/providers/{id}/{suffix}"),
    }
}

/// Handle a request under `/api/agent/providers/`.
pub fn handle_provider_route(stream: &mut TcpStream, method: &str, path: &str, body: &[u8]) {
    respond_mapped(
        stream,
        map_provider_route(method, path),
        body,
        CodedError::plain("invalid_provider_id", "invalid provider id"),
    );
}

fn respond_mapped(stream: &mut TcpStream, route: ProviderRoute, body: &[u8], bad_id: CodedError) {
    match route {
        ProviderRoute::Forward { method, path } => {
            let body = (method == "POST").then_some(body);
            proxy_agent(stream, method, &path, body)
        }
        ProviderRoute::BadId => respond_error(stream, 400, &bad_id),
        ProviderRoute::WrongMethod => respond_error(stream, 405, &method_not_allowed()),
        ProviderRoute::Unknown => respond_error(stream, 404, &route_not_found()),
    }
}

/// Longest sign-in id the page may name; the runtime issues 32 hex characters.
const MAX_LOGIN_ID_LEN: usize = 64;
const MIN_LOGIN_ID_LEN: usize = 8;

/// `[A-Za-z0-9_-]`, 8–64 characters: what the runtime's `isOAuthLoginId` accepts, so
/// nothing that is not an id (a slash, `..`, a query) reaches the forwarded path.
pub fn valid_login_id(id: &str) -> bool {
    (MIN_LOGIN_ID_LEN..=MAX_LOGIN_ID_LEN).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

const OAUTH_LOGINS_PREFIX: &str = "/api/agent/oauth/logins/";

/// Whether a path belongs to the sign-in poll/answer/cancel routes.
pub fn owns_oauth_login(path: &str) -> bool {
    path.starts_with(OAUTH_LOGINS_PREFIX)
}

/// Map `/api/agent/oauth/logins/<login>` (GET) and its `/input` and `/cancel`
/// (POST). Reuses [`ProviderRoute`]: a bad id is `BadId`, a wrong method is
/// `WrongMethod`, any other shape `Unknown`.
pub fn map_oauth_login_route(method: &str, path: &str) -> ProviderRoute {
    let Some(rest) = path.strip_prefix(OAUTH_LOGINS_PREFIX) else {
        return ProviderRoute::Unknown;
    };
    let (id, suffix, wanted) = if let Some(id) = rest.strip_suffix("/input") {
        (id, "/input", "POST")
    } else if let Some(id) = rest.strip_suffix("/cancel") {
        (id, "/cancel", "POST")
    } else {
        (rest, "", "GET")
    };
    if !valid_login_id(id) {
        return ProviderRoute::BadId;
    }
    if !method.eq_ignore_ascii_case(wanted) {
        return ProviderRoute::WrongMethod;
    }
    ProviderRoute::Forward {
        method: wanted,
        path: format!("/v1/oauth/logins/{id}{suffix}"),
    }
}

/// Handle a request under `/api/agent/oauth/logins/`.
pub fn handle_oauth_login_route(stream: &mut TcpStream, method: &str, path: &str, body: &[u8]) {
    respond_mapped(
        stream,
        map_oauth_login_route(method, path),
        body,
        CodedError::plain("invalid_login_id", "invalid sign-in id"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_a_conservative_charset() {
        for ok in [
            "anthropic",
            "openai-codex",
            "github_copilot",
            "a.b-c_d",
            "A1",
            "x",
        ] {
            assert!(valid_provider_id(ok), "{ok}");
        }
        let long = "a".repeat(MAX_PROVIDER_ID_LEN);
        assert!(valid_provider_id(&long));
        for bad in [
            "", ".", "..", ".hidden", "-lead", "a/b", "a\\b", "../x", "a b", "a%2fb", "a?b", "a#b",
            "é", "a\0b", "a\nb",
        ] {
            assert!(!valid_provider_id(bad), "{bad:?}");
        }
        assert!(!valid_provider_id(&"a".repeat(MAX_PROVIDER_ID_LEN + 1)));
    }

    fn forward(method: &'static str, path: &str) -> ProviderRoute {
        ProviderRoute::Forward {
            method,
            path: path.to_string(),
        }
    }

    #[test]
    fn provider_paths_map_to_the_runtime() {
        assert_eq!(
            map_provider_route("GET", "/api/agent/providers/anthropic/models"),
            forward("GET", "/v1/providers/anthropic/models")
        );
        assert_eq!(
            map_provider_route("POST", "/api/agent/providers/openai-codex/api-key"),
            forward("POST", "/v1/providers/openai-codex/api-key")
        );
        assert_eq!(
            map_provider_route("post", "/api/agent/providers/a.b/api-key"),
            forward("POST", "/v1/providers/a.b/api-key")
        );
    }

    #[test]
    fn bad_ids_are_refused_before_a_path_is_built() {
        for path in [
            "/api/agent/providers//models",
            "/api/agent/providers/../models",
            "/api/agent/providers/a/b/models",
            "/api/agent/providers/a b/api-key",
            "/api/agent/providers/../../settings/api-key",
            "/api/agent/providers/%2e%2e/models",
            "/api/agent/providers/a?x=1/models",
        ] {
            assert_eq!(
                map_provider_route("POST", path),
                ProviderRoute::BadId,
                "{path}"
            );
            assert_eq!(
                map_provider_route("GET", path),
                ProviderRoute::BadId,
                "{path}"
            );
        }
        let long = format!("/api/agent/providers/{}/models", "a".repeat(65));
        assert_eq!(map_provider_route("GET", &long), ProviderRoute::BadId);
    }

    #[test]
    fn methods_and_unknown_suffixes_are_not_forwarded() {
        assert_eq!(
            map_provider_route("POST", "/api/agent/providers/anthropic/models"),
            ProviderRoute::WrongMethod
        );
        assert_eq!(
            map_provider_route("GET", "/api/agent/providers/anthropic/api-key"),
            ProviderRoute::WrongMethod
        );
        assert_eq!(
            map_provider_route("GET", "/api/agent/providers/anthropic"),
            ProviderRoute::Unknown
        );
        assert_eq!(
            map_provider_route("GET", "/api/agent/providers/anthropic/other"),
            ProviderRoute::Unknown
        );
        assert_eq!(
            map_provider_route("GET", "/api/agent/models"),
            ProviderRoute::Unknown
        );
    }

    #[test]
    fn sign_in_provider_routes_map_to_the_runtime() {
        assert_eq!(
            map_provider_route("POST", "/api/agent/providers/anthropic/oauth/login"),
            forward("POST", "/v1/providers/anthropic/oauth/login")
        );
        assert_eq!(
            map_provider_route("post", "/api/agent/providers/openai-codex/oauth/logout"),
            forward("POST", "/v1/providers/openai-codex/oauth/logout")
        );
        // A sign-in is started or removed with POST only.
        assert_eq!(
            map_provider_route("GET", "/api/agent/providers/anthropic/oauth/login"),
            ProviderRoute::WrongMethod
        );
        assert_eq!(
            map_provider_route("GET", "/api/agent/providers/anthropic/oauth/logout"),
            ProviderRoute::WrongMethod
        );
        // Not a route.
        assert_eq!(
            map_provider_route("POST", "/api/agent/providers/anthropic/oauth"),
            ProviderRoute::Unknown
        );
        assert_eq!(
            map_provider_route("POST", "/api/agent/providers/anthropic/oauth/login/x"),
            ProviderRoute::Unknown
        );
    }

    #[test]
    fn sign_in_provider_routes_refuse_bad_ids_before_a_path_is_built() {
        for path in [
            "/api/agent/providers//oauth/login",
            "/api/agent/providers/../oauth/login",
            "/api/agent/providers/a/b/oauth/login",
            "/api/agent/providers/a b/oauth/logout",
            "/api/agent/providers/..%2f../oauth/login",
            "/api/agent/providers/a?x=1/oauth/login",
            "/api/agent/providers/oauth/oauth/logout/oauth/login",
        ] {
            let route = map_provider_route("POST", path);
            assert!(
                matches!(route, ProviderRoute::BadId | ProviderRoute::Unknown),
                "{path}: {route:?}"
            );
            assert!(!matches!(route, ProviderRoute::Forward { .. }), "{path}");
        }
        let long = format!("/api/agent/providers/{}/oauth/login", "a".repeat(65));
        assert_eq!(map_provider_route("POST", &long), ProviderRoute::BadId);
    }

    #[test]
    fn login_ids_are_the_runtimes_charset() {
        for ok in [
            "0123456789abcdef0123456789abcdef",
            "abcdefgh",
            "A_b-c-d-e-f",
            &"a".repeat(MAX_LOGIN_ID_LEN),
        ] {
            assert!(valid_login_id(ok), "{ok}");
        }
        for bad in [
            "",
            "short",
            "a/b/c/d/e/f",
            "../../x-x-x-x",
            "a b c d e f g",
            "abcdefgh?x=1",
            "abcdefgh#frag",
            "abcdefgh\n",
            "ébcdefgh",
            &"a".repeat(MAX_LOGIN_ID_LEN + 1),
        ] {
            assert!(!valid_login_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn sign_in_poll_answer_and_cancel_map_to_the_runtime() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            map_oauth_login_route("GET", &format!("/api/agent/oauth/logins/{id}")),
            forward("GET", &format!("/v1/oauth/logins/{id}"))
        );
        assert_eq!(
            map_oauth_login_route("POST", &format!("/api/agent/oauth/logins/{id}/input")),
            forward("POST", &format!("/v1/oauth/logins/{id}/input"))
        );
        assert_eq!(
            map_oauth_login_route("post", &format!("/api/agent/oauth/logins/{id}/cancel")),
            forward("POST", &format!("/v1/oauth/logins/{id}/cancel"))
        );
        assert!(owns_oauth_login("/api/agent/oauth/logins/x"));
        assert!(!owns_oauth_login("/api/agent/oauth"));
        assert!(!owns_oauth_login("/api/agent/providers/oauth/logins/x"));
    }

    #[test]
    fn sign_in_poll_routes_refuse_wrong_methods_and_bad_ids() {
        let id = "0123456789abcdef0123456789abcdef";
        for (method, suffix) in [
            ("POST", ""),
            ("GET", "/input"),
            ("GET", "/cancel"),
            ("DELETE", ""),
        ] {
            assert_eq!(
                map_oauth_login_route(method, &format!("/api/agent/oauth/logins/{id}{suffix}")),
                ProviderRoute::WrongMethod,
                "{method} {suffix}"
            );
        }
        for path in [
            "/api/agent/oauth/logins/",
            "/api/agent/oauth/logins//input",
            "/api/agent/oauth/logins/short",
            "/api/agent/oauth/logins/../../settings",
            "/api/agent/oauth/logins/a/b/c/d/e/f/g/h/input",
            "/api/agent/oauth/logins/0123456789abcdef?x=1",
            "/api/agent/oauth/logins/0123456789abcdef/input/more",
        ] {
            for method in ["GET", "POST"] {
                assert_eq!(
                    map_oauth_login_route(method, path),
                    ProviderRoute::BadId,
                    "{method} {path}"
                );
            }
        }
        assert_eq!(
            map_oauth_login_route("GET", "/api/agent/models"),
            ProviderRoute::Unknown
        );
    }
}
