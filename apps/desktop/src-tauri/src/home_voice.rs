//! The Projects page's voiceover routes (Settings › Voice, beta): the subset of Studio's `/api/voice/*` routes
//! (`packages/studio-server/src/routes/voice.ts`) that only touch the files `voice_settings` owns. Synthesis, key
//! checks and the voice catalog stay in Studio's server: the shell makes no network call. All of them are `/api/`
//! routes, so the per-launch token guards them (the sample audio is fetched with it and played from a blob).
//!
//! - `GET    /api/voice/providers` → `{ providers: VoiceProviderInfo[] }`
//! - `PUT    /api/voice/providers/<id> {model?, baseUrl?, voice?, agentRules?}` → `{ provider }`
//! - `PUT    /api/voice/providers/<id>/api-key {key}` → `{ provider }` (`hasKey` is now true)
//! - `DELETE /api/voice/providers/<id>/api-key` → `{ provider }` (`hasKey` false again)
//! - `GET    /api/voice/presets` → `{ presets }`
//! - `PATCH  /api/voice/presets/<id> {name}` → `{ preset }`
//! - `DELETE /api/voice/presets/<id>` → `{ ok: true }`
//! - `GET    /api/voice/audio/<hash>` → the cached sample (64 lowercase hex characters, else 404)
//!
//! Errors are `{ "error": { "code", "message" } }` with the status Studio uses (`invalid_request` 400,
//! `not_found` 404).

use std::net::TcpStream;

use serde_json::{json, Value};

use super::home_api::respond_json;
use super::home_routes::respond_with_headers;
use super::voice_settings::{
    parse_api_key, parse_preset_name, parse_provider_update, VoiceError, VoiceStore,
};

const PROVIDERS_PREFIX: &str = "/api/voice/providers/";
const PRESETS_PREFIX: &str = "/api/voice/presets/";
const AUDIO_PREFIX: &str = "/api/voice/audio/";

/// Whether `path` belongs to this module (`home_routes` hands it over).
pub fn owns(path: &str) -> bool {
    path == "/api/voice/providers"
        || path == "/api/voice/presets"
        || path.starts_with(PROVIDERS_PREFIX)
        || path.starts_with(PRESETS_PREFIX)
        || path.starts_with(AUDIO_PREFIX)
}

/// One request this module serves, with the path segments it names.
#[derive(Debug, PartialEq, Eq)]
enum Route<'a> {
    ListProviders,
    UpdateProvider(&'a str),
    SetKey(&'a str),
    RemoveKey(&'a str),
    ListPresets,
    RenamePreset(&'a str),
    DeletePreset(&'a str),
    Audio(&'a str),
}

/// One path segment: not empty and without a `/` (Studio's router does not match those either).
fn segment(text: &str) -> Option<&str> {
    Some(text).filter(|id| !id.is_empty() && !id.contains('/'))
}

fn route<'a>(method: &str, path: &'a str) -> Option<Route<'a>> {
    if let Some(rest) = path.strip_prefix(PROVIDERS_PREFIX) {
        if let Some(id) = rest.strip_suffix("/api-key").and_then(segment) {
            return match method {
                "PUT" => Some(Route::SetKey(id)),
                "DELETE" => Some(Route::RemoveKey(id)),
                _ => None,
            };
        }
        return (method == "PUT")
            .then(|| segment(rest).map(Route::UpdateProvider))
            .flatten();
    }
    if let Some(rest) = path.strip_prefix(PRESETS_PREFIX) {
        let id = segment(rest)?;
        return match method {
            "PATCH" => Some(Route::RenamePreset(id)),
            "DELETE" => Some(Route::DeletePreset(id)),
            _ => None,
        };
    }
    if let Some(rest) = path.strip_prefix(AUDIO_PREFIX) {
        return (method == "GET")
            .then(|| segment(rest).map(Route::Audio))
            .flatten();
    }
    match (method, path) {
        ("GET", "/api/voice/providers") => Some(Route::ListProviders),
        ("GET", "/api/voice/presets") => Some(Route::ListPresets),
        _ => None,
    }
}

/// What a request answers with: JSON, or the bytes of a cached sample.
#[derive(Debug, PartialEq)]
enum Reply {
    Json(u16, Value),
    Audio(&'static str, Vec<u8>),
}

fn refusal(err: &VoiceError) -> Reply {
    Reply::Json(
        err.status(),
        json!({ "error": { "code": err.code, "message": err.message } }),
    )
}

fn not_found() -> Reply {
    refusal(&VoiceError {
        code: "not_found",
        message: "not found".into(),
    })
}

/// A request body as JSON; anything unreadable is `null`, which every parser refuses.
fn body_json(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

fn provider_reply(result: Result<super::voice_settings::ProviderInfo, VoiceError>) -> Reply {
    match result.map(|provider| serde_json::to_value(provider).map(|p| json!({ "provider": p }))) {
        Ok(Ok(value)) => Reply::Json(200, value),
        Ok(Err(err)) => refusal(&VoiceError {
            code: "io_error",
            message: err.to_string(),
        }),
        Err(err) => refusal(&err),
    }
}

fn dispatch(store: &VoiceStore, route: Route<'_>, body: &[u8]) -> Reply {
    match route {
        Route::ListProviders => match serde_json::to_value(store.providers()) {
            Ok(providers) => Reply::Json(200, json!({ "providers": providers })),
            Err(err) => refusal(&VoiceError {
                code: "io_error",
                message: err.to_string(),
            }),
        },
        Route::UpdateProvider(id) => provider_reply(
            parse_provider_update(&body_json(body)).and_then(|update| store.update_provider(id, &update)),
        ),
        Route::SetKey(id) => {
            provider_reply(parse_api_key(&body_json(body)).and_then(|key| store.set_api_key(id, &key)))
        }
        Route::RemoveKey(id) => provider_reply(store.remove_api_key(id)),
        Route::ListPresets => Reply::Json(200, json!({ "presets": store.presets() })),
        Route::RenamePreset(id) => {
            match parse_preset_name(&body_json(body)).and_then(|name| store.rename_preset(id, &name)) {
                Ok(preset) => Reply::Json(200, json!({ "preset": preset })),
                Err(err) => refusal(&err),
            }
        }
        Route::DeletePreset(id) => match store.delete_preset(id) {
            Ok(()) => Reply::Json(200, json!({ "ok": true })),
            Err(err) => refusal(&err),
        },
        Route::Audio(hash) => match store.audio(hash) {
            Some((mime, bytes)) => Reply::Audio(mime, bytes),
            None => not_found(),
        },
    }
}

/// Handle one request for which `owns(path)` holds.
pub fn handle(stream: &mut TcpStream, method: &str, path: &str, body: &[u8]) {
    let reply = match route(method, path) {
        Some(route) => dispatch(&VoiceStore::open(), route, body),
        None => not_found(),
    };
    match reply {
        Reply::Json(status, value) => respond_json(stream, status, &value),
        // Named by the hash of its request, so it never changes under that name.
        Reply::Audio(mime, bytes) => respond_with_headers(
            stream,
            200,
            mime,
            &bytes,
            "Cache-Control: private, max-age=31536000, immutable\r\n",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openvids-home-voice-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn call(store: &VoiceStore, method: &str, path: &str, body: Value) -> Reply {
        assert!(owns(path), "{path}");
        match route(method, path) {
            Some(route) => dispatch(store, route, body.to_string().as_bytes()),
            None => not_found(),
        }
    }

    fn json_of(reply: Reply) -> (u16, Value) {
        match reply {
            Reply::Json(status, value) => (status, value),
            Reply::Audio(..) => panic!("expected JSON"),
        }
    }

    #[test]
    fn owns_only_the_voice_routes() {
        for path in [
            "/api/voice/providers",
            "/api/voice/presets",
            "/api/voice/providers/openai",
            "/api/voice/providers/openai/api-key",
            "/api/voice/presets/p1",
            "/api/voice/audio/abc",
        ] {
            assert!(owns(path), "{path}");
        }
        for path in [
            "/api/voice",
            "/api/voices",
            "/api/voice/providersx",
            "/api/research/policy",
            "/api/voice/sample",
        ] {
            assert!(!owns(path), "{path}");
        }
    }

    #[test]
    fn routes_name_exactly_one_segment_and_one_method() {
        assert_eq!(route("GET", "/api/voice/providers"), Some(Route::ListProviders));
        assert_eq!(
            route("PUT", "/api/voice/providers/custom"),
            Some(Route::UpdateProvider("custom"))
        );
        assert_eq!(
            route("PUT", "/api/voice/providers/openai/api-key"),
            Some(Route::SetKey("openai"))
        );
        assert_eq!(
            route("DELETE", "/api/voice/providers/openai/api-key"),
            Some(Route::RemoveKey("openai"))
        );
        assert_eq!(route("GET", "/api/voice/presets"), Some(Route::ListPresets));
        assert_eq!(
            route("PATCH", "/api/voice/presets/p1"),
            Some(Route::RenamePreset("p1"))
        );
        assert_eq!(
            route("DELETE", "/api/voice/presets/p1"),
            Some(Route::DeletePreset("p1"))
        );
        assert_eq!(route("GET", "/api/voice/audio/abc"), Some(Route::Audio("abc")));
        for (method, path) in [
            ("POST", "/api/voice/providers"),
            ("DELETE", "/api/voice/providers/openai"),
            ("GET", "/api/voice/providers/openai"),
            ("GET", "/api/voice/providers/openai/api-key"),
            ("PUT", "/api/voice/providers/"),
            ("PUT", "/api/voice/providers//api-key"),
            ("PUT", "/api/voice/providers/a/b"),
            ("PUT", "/api/voice/providers/a/b/api-key"),
            ("PUT", "/api/voice/providers/openai/api-keys"),
            ("POST", "/api/voice/presets"),
            ("PUT", "/api/voice/presets/p1"),
            ("PATCH", "/api/voice/presets/"),
            ("DELETE", "/api/voice/presets/a/b"),
            ("POST", "/api/voice/audio/abc"),
            ("GET", "/api/voice/audio/"),
            ("GET", "/api/voice/audio/a/b"),
        ] {
            assert_eq!(route(method, path), None, "{method} {path}");
        }
    }

    #[test]
    fn a_key_goes_in_through_the_route_and_never_comes_out() {
        let dir = dir("key");
        let store = VoiceStore::new(&dir);
        let secret = "sk-route-SECRET-42";
        let (status, saved) = json_of(call(
            &store,
            "PUT",
            "/api/voice/providers/openai/api-key",
            json!({ "key": secret }),
        ));
        assert_eq!(status, 200);
        assert_eq!(saved["provider"]["hasKey"], true);
        assert_eq!(saved["provider"]["configured"], true);
        let mut answers = vec![saved.to_string()];
        answers.push(
            json_of(call(&store, "GET", "/api/voice/providers", Value::Null))
                .1
                .to_string(),
        );
        answers.push(
            json_of(call(
                &store,
                "PUT",
                "/api/voice/providers/openai",
                json!({ "model": "tts-1", "agentRules": "slow" }),
            ))
            .1
            .to_string(),
        );
        // Refusals do not echo it either.
        answers.push(
            json_of(call(
                &store,
                "PUT",
                "/api/voice/providers/openai/api-key",
                json!({ "key": format!("{secret} two words") }),
            ))
            .1
            .to_string(),
        );
        answers.push(
            json_of(call(
                &store,
                "PUT",
                "/api/voice/providers/nope/api-key",
                json!({ "key": secret }),
            ))
            .1
            .to_string(),
        );
        for answer in &answers {
            assert!(!answer.contains(secret), "{answer}");
        }
        let (status, refused) = json_of(call(
            &store,
            "PUT",
            "/api/voice/providers/openai/api-key",
            json!({ "key": "two words" }),
        ));
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (400, json!("invalid_request"))
        );
        let (status, missing) = json_of(call(
            &store,
            "PUT",
            "/api/voice/providers/nope/api-key",
            json!({ "key": "k" }),
        ));
        assert_eq!(
            (status, missing["error"]["code"].clone()),
            (404, json!("not_found"))
        );

        let (_, listed) = json_of(call(&store, "GET", "/api/voice/providers", Value::Null));
        let openai = listed["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "openai")
            .unwrap()
            .clone();
        assert_eq!(
            (openai["model"].clone(), openai["hasKey"].clone()),
            (json!("tts-1"), json!(true))
        );
        assert_eq!(listed["providers"].as_array().unwrap().len(), 5);

        let (status, forgotten) = json_of(call(
            &store,
            "DELETE",
            "/api/voice/providers/openai/api-key",
            Value::Null,
        ));
        assert_eq!(
            (status, forgotten["provider"]["hasKey"].clone()),
            (200, json!(false))
        );
    }

    #[test]
    fn provider_updates_are_validated_like_studio_validates_them() {
        let store = VoiceStore::new(&dir("update"));
        for body in [
            json!({ "baseUrl": "ftp://x" }),
            json!({ "baseUrl": "https://u:p@x.example" }),
            json!({ "model": 5 }),
            json!([]),
        ] {
            let (status, reply) = json_of(call(&store, "PUT", "/api/voice/providers/custom", body.clone()));
            assert_eq!(
                (status, reply["error"]["code"].clone()),
                (400, json!("invalid_request")),
                "{body}"
            );
        }
        let (status, reply) = json_of(call(
            &store,
            "PUT",
            "/api/voice/providers/gemini",
            json!({ "baseUrl": "http://127.0.0.1:9" }),
        ));
        assert_eq!(
            (status, reply["error"]["code"].clone()),
            (400, json!("invalid_request"))
        );
        let (status, reply) = json_of(call(
            &store,
            "PUT",
            "/api/voice/providers/custom",
            json!({ "baseUrl": "http://127.0.0.1:8880/v1", "model": "kokoro" }),
        ));
        assert_eq!(
            (status, reply["provider"]["configured"].clone()),
            (200, json!(true))
        );
        // An unreadable body is refused, not treated as "no change".
        let reply = dispatch(&store, Route::UpdateProvider("custom"), b"{ nope");
        assert_eq!(json_of(reply).0, 400);
    }

    #[test]
    fn presets_are_renamed_and_deleted_through_the_routes() {
        let dir = dir("presets");
        let store = VoiceStore::new(&dir);
        std::fs::write(
            dir.join("presets.json"),
            json!({ "schema": "openvids.voice-presets/1", "presets": [{ "id": "p1", "name": "Narrator", "updatedAt": 1 }] }).to_string(),
        )
        .unwrap();
        assert_eq!(
            json_of(call(&store, "GET", "/api/voice/presets", Value::Null)).1["presets"][0]["name"],
            "Narrator"
        );
        let (status, renamed) = json_of(call(
            &store,
            "PATCH",
            "/api/voice/presets/p1",
            json!({ "name": " Calm " }),
        ));
        assert_eq!((status, renamed["preset"]["name"].clone()), (200, json!("Calm")));
        assert_eq!(
            json_of(call(
                &store,
                "PATCH",
                "/api/voice/presets/p1",
                json!({ "name": "" })
            ))
            .0,
            400
        );
        assert_eq!(
            json_of(call(
                &store,
                "PATCH",
                "/api/voice/presets/zz",
                json!({ "name": "x" })
            ))
            .0,
            404
        );
        assert_eq!(
            json_of(call(&store, "DELETE", "/api/voice/presets/p1", Value::Null)),
            (200, json!({ "ok": true }))
        );
        assert_eq!(
            json_of(call(&store, "DELETE", "/api/voice/presets/p1", Value::Null)).0,
            404
        );
        assert_eq!(
            json_of(call(&store, "GET", "/api/voice/presets", Value::Null)).1,
            json!({ "presets": [] })
        );
    }

    #[test]
    fn audio_answers_the_cache_entry_and_refuses_a_bad_hash() {
        let dir = dir("audio");
        let store = VoiceStore::new(&dir);
        let hash = "0a".repeat(32);
        std::fs::create_dir_all(dir.join("cache")).unwrap();
        std::fs::write(dir.join("cache").join(format!("{hash}.wav")), b"RIFF").unwrap();
        std::fs::write(dir.join("cache").join(format!("{hash}.json")), "{}").unwrap();
        assert_eq!(
            call(&store, "GET", &format!("/api/voice/audio/{hash}"), Value::Null),
            Reply::Audio("audio/wav", b"RIFF".to_vec())
        );
        for bad in ["nope", "..", &hash[1..], &hash.to_uppercase()] {
            let (status, reply) = json_of(call(
                &store,
                "GET",
                &format!("/api/voice/audio/{bad}"),
                Value::Null,
            ));
            assert_eq!(
                (status, reply["error"]["code"].clone()),
                (404, json!("not_found")),
                "{bad}"
            );
        }
    }
}
