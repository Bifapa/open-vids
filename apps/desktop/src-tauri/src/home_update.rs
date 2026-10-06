//! The update routes (`/api/update/*`, token-gated like every `/api/` route).
//! The work is `updater`'s; these only translate HTTP.
//!
//! - `GET /api/update/status` — `{currentVersion, phase, …}` (see `updater::UpdateState`).
//! - `POST /api/update/check` — start a check (or join the one under way); answers the state.
//!   Which releases it looks at follows `updates.channel` (stable, or beta = stable and
//!   beta manifests, the newer wins): the Settings switch saves the preference, then asks for
//!   a check.
//! - `POST /api/update/install {force?}` — download, verify, install, restart; answers the
//!   state. 409 `update_not_available` when there is nothing to install, 409 `update_busy`
//!   (`params: {renders, agentTurn}`) when the open project is rendering or running an agent
//!   turn and `force` is not set. Both 409 bodies carry the state as `status`.

use std::net::TcpStream;

use serde_json::Value;

use super::home_api::{method_not_allowed, respond_error, respond_json, route_not_found};
use super::updater;

pub fn owns(path: &str) -> bool {
    path.starts_with("/api/update/")
}

/// `{"force": true}`; anything else (no body, other JSON) is `false`.
fn wants_force(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("force").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// Handle one request for which `owns(path)` holds.
pub fn handle(stream: &mut TcpStream, method: &str, path: &str, body: &[u8]) {
    match (method, path) {
        ("GET", "/api/update/status") => respond_json(stream, 200, &updater::state().to_json()),
        ("POST", "/api/update/check") => respond_json(stream, 200, &updater::check().to_json()),
        ("POST", "/api/update/install") => match updater::install(wants_force(body)) {
            Ok(state) => respond_json(stream, 200, &state.to_json()),
            Err(refusal) => {
                let mut answer = refusal.error().body();
                answer["status"] = updater::state().to_json();
                respond_json(stream, 409, &answer);
            }
        },
        (_, "/api/update/status" | "/api/update/check" | "/api/update/install") => {
            respond_error(stream, 405, &method_not_allowed())
        }
        _ => respond_error(stream, 404, &route_not_found()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_true_forces() {
        assert!(wants_force(br#"{"force":true}"#));
        assert!(!wants_force(br#"{"force":"yes"}"#));
        assert!(!wants_force(b"{}"));
        assert!(!wants_force(b""));
    }
}
