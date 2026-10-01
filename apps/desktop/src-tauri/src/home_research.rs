//! The Projects page's Asset Search policy routes: the same routes Studio's
//! server serves under `/api/research/*` (`routes/research.ts`), over the same
//! `~/.openvids/research/policy.json` (see `research_policy`). All of them are
//! `/api/` routes, so the per-launch token guards them.
//!
//! - `GET    /api/research/policy` → the policy
//! - `PUT    /api/research/policy {mode?, websites?: {readLinkedPages}}` → the policy
//! - `POST   /api/research/sources {name, domains, kinds?, homepage?, licenseNote?}` → the policy
//! - `PATCH  /api/research/sources/<id> {enabled?, name?, domains?, kinds?, licenseNote?}` → the policy
//! - `DELETE /api/research/sources/<id>` → the policy
//! - `POST   /api/research/sources/restore` → the policy
//!
//! Errors are `{ "error": { "code", "message" } }` with the status Studio uses
//! (`invalid_request`/`unknown_source` 400, `conflict` 409).

use std::net::TcpStream;

use serde_json::{json, Value};

use super::home_api::respond_json;
use super::research_policy::{
    parse_add_source, parse_policy_update, parse_update_source, PolicyError, PolicyStore, PolicyView,
};

const SOURCES_PREFIX: &str = "/api/research/sources/";

/// Whether `path` belongs to this module (`home_routes` hands it over).
pub fn owns(path: &str) -> bool {
    path == "/api/research/policy" || path == "/api/research/sources" || path.starts_with(SOURCES_PREFIX)
}

/// A request body as JSON; anything unreadable is `null`, which every parser
/// refuses the way Studio refuses an unreadable body.
fn body_json(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

fn answer(stream: &mut TcpStream, result: Result<PolicyView, PolicyError>) {
    match result {
        Ok(policy) => match serde_json::to_value(&policy) {
            Ok(value) => respond_json(stream, 200, &value),
            Err(err) => fail(stream, &PolicyError {
                code: "io_error",
                message: err.to_string(),
            }),
        },
        Err(err) => fail(stream, &err),
    }
}

fn fail(stream: &mut TcpStream, err: &PolicyError) {
    respond_json(
        stream,
        err.status(),
        &json!({ "error": { "code": err.code, "message": err.message } }),
    );
}

/// The id of `/api/research/sources/<id>`; `None` for an empty one or one
/// with a `/` (Studio's router does not match those either).
fn source_id(path: &str) -> Option<&str> {
    path.strip_prefix(SOURCES_PREFIX)
        .filter(|id| !id.is_empty() && !id.contains('/'))
}

/// Handle one request for which `owns(path)` holds.
pub fn handle(stream: &mut TcpStream, method: &str, path: &str, body: &[u8]) {
    let store = PolicyStore::open();
    match (method, path) {
        ("GET", "/api/research/policy") => answer(stream, Ok(store.get())),
        ("PUT", "/api/research/policy") => answer(
            stream,
            parse_policy_update(&body_json(body)).and_then(|update| store.update_policy(&update)),
        ),
        ("POST", "/api/research/sources") => answer(
            stream,
            parse_add_source(&body_json(body)).and_then(|request| store.add_source(&request)),
        ),
        ("POST", "/api/research/sources/restore") => answer(stream, store.restore_built_ins()),
        ("PATCH", p) if source_id(p).is_some() => {
            let id = source_id(p).unwrap_or_default();
            answer(
                stream,
                parse_update_source(&body_json(body)).and_then(|request| store.update_source(id, &request)),
            )
        }
        ("DELETE", p) if source_id(p).is_some() => {
            answer(stream, store.remove_source(source_id(p).unwrap_or_default()))
        }
        _ => respond_json(stream, 404, &json!({ "error": "not found" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owns_only_the_policy_routes() {
        assert!(owns("/api/research/policy"));
        assert!(owns("/api/research/sources"));
        assert!(owns("/api/research/sources/restore"));
        assert!(owns("/api/research/sources/src-1a2b3c4d"));
        assert!(!owns("/api/research"));
        assert!(!owns("/api/research/policyx"));
        assert!(!owns("/api/agent/models"));
    }

    #[test]
    fn source_ids_are_one_path_segment() {
        assert_eq!(source_id("/api/research/sources/openverse"), Some("openverse"));
        assert_eq!(source_id("/api/research/sources/"), None);
        assert_eq!(source_id("/api/research/sources/a/b"), None);
        assert_eq!(source_id("/api/research/sources"), None);
    }
}
