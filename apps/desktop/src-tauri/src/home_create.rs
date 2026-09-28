//! Create-project handling for the home screen (`POST /api/create`).
//!
//! The template lookup order is: `OPENVids_TEST_TEMPLATES` (tests only) →
//! the production staged copy (`runtime/hyperframes/templates`, supplied by
//! the caller in `lib.rs`) → the dev checkout
//! (`packages/cli/src/templates`). See `create.rs` for what the scaffold
//! writes and what it deliberately skips from the CLI's interactive `init`.

use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use super::home_routes::{begin_open, respond, HomeInner};

pub fn handle_create(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let params = match parse_create(body) {
        Ok(params) => params,
        Err(error) => {
            let payload = serde_json::json!({ "error": error }).to_string();
            respond(stream, 400, "application/json", payload.as_bytes());
            return;
        }
    };
    let staged = std::env::var("OPENVids_TEST_TEMPLATES")
        .ok()
        .map(PathBuf::from)
        .or_else(production_templates_dir);
    let Some(index) = super::create::blank_template_index(staged.as_deref()) else {
        respond(
            stream,
            500,
            "application/json",
            br#"{"error":"project template unavailable"}"#,
        );
        return;
    };
    match super::create::scaffold(&index, &params) {
        Ok(dest) => {
            let name = params.name.clone();
            begin_open(state, name, dest);
            respond(stream, 200, "application/json", br#"{"opening":true}"#);
        }
        Err(err) => {
            let payload = serde_json::json!({ "error": err.to_string() }).to_string();
            respond(stream, 400, "application/json", payload.as_bytes());
        }
    }
}

fn parse_create(body: &[u8]) -> Result<super::create::CreateParams, String> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "invalid request body".to_string())?;
    let parent = value
        .get("parent")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "choose a location first".to_string())?;
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "give the project a name".to_string())?
        .to_string();
    let fps = value
        .get("fps")
        .and_then(|v| v.as_str())
        .unwrap_or("30")
        .to_string();
    let width = value
        .get("width")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| "pick a resolution".to_string())?;
    let height = value
        .get("height")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| "pick a resolution".to_string())?;
    let duration = value
        .get("duration")
        .and_then(|v| v.as_f64())
        .unwrap_or(10.0);
    Ok(super::create::CreateParams {
        parent: PathBuf::from(parent),
        name,
        fps,
        width,
        height,
        duration,
    })
}

/// Production's staged template dir. The real path is only known at runtime
/// (from the bundled resources in `lib.rs`), so a write-once cell — not a
/// `LazyLock` with a fixed initializer — is the right shape here.
static STAGED_TEMPLATES: OnceLock<PathBuf> = OnceLock::new();

/// Remember the staged template dir for this process (called once at startup
/// in production; never in dev or tests, which resolve the checkout instead).
pub fn set_staged_templates(dir: PathBuf) {
    let _ = STAGED_TEMPLATES.set(dir);
}

fn production_templates_dir() -> Option<PathBuf> {
    STAGED_TEMPLATES.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(json: &str) -> Vec<u8> {
        json.as_bytes().to_vec()
    }

    #[test]
    fn parse_accepts_a_full_form() {
        let params = parse_create(&body(
            r#"{"parent":"/tmp/x","name":"my-video","fps":"24","width":1080,"height":1920,"duration":12}"#,
        ))
        .unwrap();
        assert_eq!(params.name, "my-video");
        assert_eq!(params.fps, "24");
        assert_eq!((params.width, params.height), (1080, 1920));
        assert_eq!(params.duration, 12.0);
    }

    #[test]
    fn parse_rejects_an_empty_name_or_size() {
        assert!(parse_create(&body(
            r#"{"parent":"/tmp/x","name":"","width":8,"height":8}"#
        ))
        .is_err());
        assert!(parse_create(&body(
            r#"{"parent":"/tmp/x","name":"ok","width":0,"height":8}"#
        ))
        .is_ok());
        // Zero sizes pass the JSON shape but fail in `scaffold` validation.
        let params = parse_create(&body(
            r#"{"parent":"/tmp/x","name":"ok","width":0,"height":8}"#,
        ))
        .unwrap();
        assert_eq!(params.width, 0);
    }

    #[test]
    fn parse_requires_a_parent() {
        assert!(parse_create(&body(r#"{"name":"ok","width":8,"height":8}"#)).is_err());
    }
}
