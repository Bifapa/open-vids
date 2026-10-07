//! `/api/tabs*`: the data the pages' tab strips draw and the actions they ask for.
//!
//! - `GET /api/tabs` — `{ active, limit, tabs: [{ key, name, state }] }`.
//! - `POST /api/tabs/activate {key}` — show the Projects page (`"home"`) or an open project.
//! - `POST /api/tabs/close {key}` — close a project's tab (asks first when it is busy).
//! - `POST /api/tabs/fork {key}` — fork an open project tab's project (`home_fork`, same job and refusals as
//!   `POST /api/fork`) and show the Projects page, which follows the copy and opens the fork as a new tab.
//!   Answers `{ ok, fork }`; 404 `tab_unknown` (no open tab) / `unknown_project` (not in Recent).
//!
//! The Projects page calls them with the home token. A Studio page is another
//! loopback origin without the token: `home_routes::studio_grant` lets exactly
//! these four endpoints through to the live Studio origins (see
//! [`endpoint_method`]), nothing else of this server.

use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use super::coded_error::CodedError;
use super::home_api::unknown_project;
use super::home_routes::{json_field, respond_cors, HomeInner};
use super::tabs::{ActivateError, CloseOutcome, TabActions, HOME};

pub fn owns(path: &str) -> bool {
    path == "/api/tabs" || path.starts_with("/api/tabs/")
}

/// The method each tab endpoint answers; `None` for any other path. What a
/// Studio page's token-less grant may reach, with its preflight.
pub fn endpoint_method(path: &str) -> Option<&'static str> {
    match path {
        "/api/tabs" => Some("GET"),
        "/api/tabs/activate" | "/api/tabs/close" | "/api/tabs/fork" => Some("POST"),
        _ => None,
    }
}

pub fn handle(
    stream: &mut TcpStream,
    state: &Arc<Mutex<HomeInner>>,
    method: &str,
    path: &str,
    body: &[u8],
    cors_origin: Option<&str>,
) {
    let view = state.lock().ok().map(|inner| inner.tabs.clone());
    let Some(view) = view else {
        reply(stream, 500, &CodedError::plain("state_poisoned", "state poisoned").body(), cors_origin);
        return;
    };
    if endpoint_method(path) != Some(method) {
        reply(stream, 404, &serde_json::json!({ "error": "not found" }), cors_origin);
        return;
    }
    if method == "GET" {
        reply(stream, 200, &serde_json::json!(view), cors_origin);
        return;
    }
    let key = json_field(body, "key").unwrap_or_default();
    let actions = state.lock().ok().and_then(|inner| inner.tab_actions.clone());
    let Some(actions) = actions else {
        let error = CodedError::plain("tabs_not_ready", "the window is not ready");
        reply(stream, 503, &error.body(), cors_origin);
        return;
    };
    // The actions run without the home lock: closing waits on a native dialog.
    match path {
        "/api/tabs/activate" => match actions.activate(&key) {
            Ok(()) => reply(stream, 200, &serde_json::json!({ "ok": true }), cors_origin),
            Err(ActivateError::Unknown) => {
                let error = CodedError::plain("tab_unknown", "that tab is not open");
                reply(stream, 404, &error.body(), cors_origin);
            }
            Err(ActivateError::Opening) => {
                let error = CodedError::plain("tab_opening", "that project is still opening");
                reply(stream, 409, &error.body(), cors_origin);
            }
        },
        "/api/tabs/fork" => fork(stream, state, actions.as_ref(), &key, cors_origin),
        _ => match actions.close(&key) {
            CloseOutcome::Closed => reply(stream, 200, &serde_json::json!({ "closed": true }), cors_origin),
            CloseOutcome::Cancelled => reply(
                stream,
                200,
                &serde_json::json!({ "closed": false, "cancelled": true }),
                cors_origin,
            ),
            CloseOutcome::Unknown => {
                let error = CodedError::plain("tab_unknown", "that tab is not open");
                reply(stream, 404, &error.body(), cors_origin);
            }
        },
    }
}

/// Start the fork of the open tab `key` and bring the Projects page, which shows its progress, to the front.
fn fork(
    stream: &mut TcpStream,
    state: &Arc<Mutex<HomeInner>>,
    actions: &dyn TabActions,
    key: &str,
    cors_origin: Option<&str>,
) {
    let Some(dir) = actions.project_dir(key) else {
        let error = CodedError::plain("tab_unknown", "that tab is not open");
        return reply(stream, 404, &error.body(), cors_origin);
    };
    let entry = state.lock().ok().and_then(|inner| inner.recents.find_by_dir(&dir).cloned());
    let Some(entry) = entry else {
        return reply(stream, 404, &unknown_project().body(), cors_origin);
    };
    match super::home_fork::start(state, entry) {
        Ok(fork) => {
            // The copy runs whatever the window shows; a failed switch only leaves the progress unseen here.
            let _ = actions.activate(HOME);
            reply(stream, 200, &serde_json::json!({ "ok": true, "fork": fork }), cors_origin);
        }
        Err((status, error)) => reply(stream, status, &error.body(), cors_origin),
    }
}

fn reply(stream: &mut TcpStream, code: u16, body: &serde_json::Value, cors_origin: Option<&str>) {
    respond_cors(stream, code, "application/json", body.to_string().as_bytes(), cors_origin);
}
