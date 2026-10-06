//! Home-screen HTTP plumbing: request reading, routing, static assets.
//!
//! `home.rs` owns the listener lifetime; this module owns everything that
//! happens per connection. Pages, assets and locales (open, no token):
//!
//! - `GET /` — the Projects page (token + boot state injected).
//! - `GET /settings` — the Settings window document (framed by the page).
//! - `GET /assets/<file>` — the page's CSS / JS / SVG (compiled in).
//! - `GET /locales/index.json`, `GET /locales/<code>.json` — the locale
//!   catalog (`locales/` at the repo root, compiled in; 404 for unknown
//!   codes). Both pages also get the catalog injected, so the first paint
//!   is already translated.
//! - `GET /thumb/<file>` — cached thumbnail bytes.
//!
//! API (`/api/*`, token required — see `home_auth`):
//!
//! - `GET /api/recents` — recents + `missing`, duration, clip count.
//! - `GET /api/open-state` — what the background open is doing.
//! - `POST /api/open {id, workspace?}` — open a recent.
//! - `POST /api/pick-open` — native folder picker → validation → open.
//! - `POST /api/pick-parent` — native folder picker for a location.
//! - `POST /api/open-external {url}` — open an `https://` URL in the default browser.
//! - `POST /api/create` — scaffold a project, then open it.
//! - `POST /api/name-status` — does `<parent>/<name>` already have content.
//! - `POST /api/rename`, `/api/trash`, `/api/remove`, `/api/recents/restore`,
//!   `/api/duplicate`, `/api/reveal`, `/api/locate` — project actions.
//! - `GET /api/locations` — candidate parent folders.
//! - `GET|PUT /api/preferences` — the shared app preferences file.
//! - `POST /api/files/pick`, `/api/files/dropped` — files for the composer.
//! - `POST /api/start/name`, `/api/start` — start a project from the composer.
//! - `GET /api/agent/models`, `POST /api/agent/project-title`,
//!   `GET|PUT /api/agent/settings` — agent runtime.
//! - `/api/agent/providers…` (keys, in-app sign-in start/sign-out),
//!   `/api/agent/oauth/logins/<id>[/input|/cancel]` (sign-in poll, answer,
//!   cancel), `POST /api/agent/jev/{api-key,test}` — more agent-runtime
//!   pass-throughs (`home_agent`).
//! - `/api/research/{policy,sources…}` — the global Asset Search policy
//!   (`home_research`).
//! - `GET /api/system/check`, `/api/system/install/chrome[/cancel]` — the
//!   first-run System check and the Chrome installer (`home_system`).
//! - `GET /api/update/status`, `POST /api/update/check`, `POST /api/update/install`
//!   — the in-app update (`home_update`, `updater`).
//! - `GET /api/menu/about` — the About sheet strings (name, version, site;
//!   the same values the native About dialog shows).
//! - `POST /api/menu/:action` — one title-bar app menu action through the
//!   shared `menu_action` (`lib.rs`), for pages with no Tauri IPC. Only the
//!   `MENU_ACTIONS` ids run; anything else 404s.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::coded_error::CodedError;
use super::home_api::{self, respond_error, respond_json};
use super::home_auth::{self, Head, HomeToken, TOKEN_HEADER};
use super::recents::RecentsStore;
use super::structure::validate_structure;
const PAGE: &str = include_str!("home_page/index.html");
const SETTINGS_PAGE: &str = include_str!("home_page/settings.html");
const REPORT_PAGE: &str = include_str!("home_page/report.html");
const TOKEN_PLACEHOLDER: &str = "__OPENVids_TOKEN__";
const BOOT_PLACEHOLDER: &str = "\"__OV_BOOT__\"";
const LOCALES_PLACEHOLDER: &str = "\"__OV_LOCALES__\"";
const BODY_LIMIT: usize = 64 * 1024;
/// The raw-screenshot upload is the one route that legitimately carries an
/// image (8 MB) plus framing; no other route reads more than `BODY_LIMIT`.
const SCREENSHOT_BODY_LIMIT: usize = 9 * 1024 * 1024;

/// What the background open is doing (polled by the page's loading state).
#[derive(Debug, Clone, Default)]
pub enum OpenPhase {
    #[default]
    Idle,
    Opening {
        label: String,
    },
    Failed {
        label: String,
        error: CodedError,
    },
}

/// Runs the real project open. The second argument is the Studio workspace
/// to activate (`openvidsWorkspace`), when the open asks for one.
pub type Opener = Arc<dyn Fn(PathBuf, Option<String>) + Send + Sync>;
pub type PrefsListener = Arc<dyn Fn(&serde_json::Value) + Send + Sync>;

/// Shared mutable home state behind the listener thread.
pub struct HomeInner {
    pub recents: RecentsStore,
    pub thumbs_dir: PathBuf,
    pub open_phase: OpenPhase,
    pub opener: Option<Opener>,
    /// Id of the project currently loaded in the Studio window, if any.
    /// Set when an open completes, cleared by Show All Projects.
    pub current_id: Option<String>,
    /// What `studio_menu_grant` compares the request `Origin` against:
    /// the Studio sidecar origin the window currently shows, if any. Set by
    /// lib.rs whenever it navigates to (or away from) a project, so Studio's
    /// token-less menu requests only pass while they come from the live Studio
    /// server. Never used for routing or navigation decisions.
    pub studio_origin: Option<String>,
    /// Skip the launch intro on the next page load: the window is coming
    /// back from a project, or a project is opening at launch.
    pub skip_intro: bool,
    /// Told about every preferences change made through the page.
    pub prefs_listener: Option<PrefsListener>,
    /// Help › Welcome to OpenVids… was chosen while a project was showing: the
    /// next load of the page opens the onboarding (read once, see `serve_page`).
    pub pending_onboarding: bool,
}

impl HomeInner {
    pub fn load(recents_path: PathBuf, thumbs_dir: PathBuf) -> std::io::Result<Self> {
        let _ = std::fs::create_dir_all(&thumbs_dir);
        Ok(Self {
            recents: RecentsStore::load(&recents_path),
            thumbs_dir,
            open_phase: OpenPhase::Idle,
            opener: None,
            current_id: None,
            studio_origin: None,
            skip_intro: false,
            prefs_listener: None,
            pending_onboarding: false,
        })
    }
}

/// Stable cached-thumbnail file name for a project folder.
pub fn thumb_name_for(dir: &Path, ext: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    dir.to_string_lossy().hash(&mut hasher);
    format!("{:016x}.{ext}", hasher.finish())
}

pub fn serve_one(mut stream: TcpStream, state: &Arc<Mutex<HomeInner>>, token: &str, port: u16) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    // Start/duplicate copy files and pickers wait on the user: no write
    // deadline short enough to cut those responses off.
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let request = read_request(&mut stream);
    let Some((head, body)) = request else {
        respond(&mut stream, 400, "text/plain", b"bad request");
        return;
    };
    let studio = studio_menu_grant(
        super::window_frame(),
        &head,
        &studio_origins_for(state),
        port,
    );
    if !home_auth::origin_allowed(&head, port) && studio.is_none() {
        respond(&mut stream, 403, "text/plain", b"foreign origin");
        return;
    }
    if home_auth::requires_token(&head.method, &head.path)
        && studio.is_none()
        && !HomeToken::matches(&HomeToken::from_value(token), head.header(TOKEN_HEADER))
    {
        respond(&mut stream, 403, "text/plain", b"bad token");
        return;
    }
    if let Some(grant) = studio.as_ref().filter(|grant| grant.preflight_method.is_some()) {
        let allow_headers = head.header("access-control-request-headers").is_some();
        respond_preflight(&mut stream, grant, allow_headers);
        return;
    }
    route(
        stream,
        state,
        token,
        &head,
        &body,
        studio.as_ref().map(|grant| grant.origin.as_str()),
    );
}

// ── Request reading ─────────────────────────────────────────────────────────

/// Parse a request head with its path percent-decoded exactly once. Routing,
/// the body limit and the token requirement all read this one path: a check
/// on the raw path would let `/%61pi/...` or `/api%2F...` reach an `/api`
/// handler without the token. A `%2F` decodes to `/` here, so it cannot hide
/// a separator from the checks either; the decoded text is never decoded again.
fn parse_head(raw: &str) -> Option<Head> {
    let mut head = Head::parse(raw)?;
    head.path = percent_decode(&head.path);
    Some(head)
}

fn read_request(stream: &mut TcpStream) -> Option<(Head, Vec<u8>)> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
        if let Some(end) = find_header_end(&raw) {
            let head_text = String::from_utf8_lossy(&raw[..end]).into_owned();
            let head = parse_head(&head_text)?;
            let content_len = head
                .header("content-length")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(0)
                .min(body_limit(&head));
            let mut body = raw[end..].to_vec();
            while body.len() < content_len {
                let n = stream.read(&mut buf).ok()?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&buf[..n]);
            }
            body.truncate(content_len);
            return Some((head, body));
        }
        if raw.len() > 16 * 1024 {
            return None;
        }
    }
    None
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// How much of the body to buffer for this request. Everything stays at the
/// 64 KiB default except the one route that uploads a whole image.
fn body_limit(head: &Head) -> usize {
    let upload = head.method.eq_ignore_ascii_case("POST") && head.path == "/api/report/screenshots";
    if upload {
        SCREENSHOT_BODY_LIMIT
    } else {
        BODY_LIMIT
    }
}

// ── Routing ─────────────────────────────────────────────────────────────────

fn route(
    mut stream: TcpStream,
    state: &Arc<Mutex<HomeInner>>,
    token: &str,
    head: &Head,
    body: &[u8],
    cors_origin: Option<&str>,
) {
    // `head.path` is already decoded (`parse_head`); never decode it again.
    let path = &head.path;
    let method = head.method.to_ascii_uppercase();
    let s = &mut stream;
    match (method.as_str(), path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => serve_page(s, state, token),
        ("GET", "/settings") => serve_settings_page(s, token),
        ("GET", "/report") => serve_report_page(s, token),
        ("GET", p) if p.starts_with("/assets/") => serve_asset(s, &p["/assets/".len()..]),
        ("GET", "/locales/index.json") => respond(
            s,
            200,
            "application/json; charset=utf-8",
            super::locales::INDEX_JSON.as_bytes(),
        ),
        ("GET", p) if p.starts_with("/locales/") => serve_locale(s, &p["/locales/".len()..]),
        ("GET", p) if p.starts_with("/thumb/") => serve_thumb(s, state, p),
        ("GET", "/api/recents") => home_api::serve_recents(s, state),
        // Token-free like the pages and assets: plain `fetch` from the page, no secret to leak.
        ("GET", "/api/menu/about") => serve_menu_about(s, cors_origin),
        ("GET", "/api/open-state") => serve_open_state(s, state),
        ("GET", "/api/locations") => home_api::serve_locations(s, state),
        ("GET", "/api/preferences") => home_api::serve_prefs(s),
        ("PUT", "/api/preferences") => home_api::handle_prefs_update(s, state, body),
        ("GET", "/api/agent/models") => home_api::proxy_agent(s, "GET", "/v1/models", None),
        ("POST", "/api/agent/project-title") => {
            home_api::proxy_agent(s, "POST", "/v1/project-title", Some(body))
        }
        ("GET", "/api/agent/settings") => home_api::proxy_agent(s, "GET", "/v1/settings", None),
        ("PUT", "/api/agent/settings") => {
            home_api::proxy_agent(s, "PATCH", "/v1/settings", Some(body))
        }
        ("GET", "/api/agent/providers") => home_api::proxy_agent(s, "GET", "/v1/providers", None),
        ("POST", "/api/agent/providers/refresh") => {
            home_api::proxy_agent(s, "POST", "/v1/providers/refresh", Some(body))
        }
        (_, p) if p.starts_with("/api/agent/providers/") => {
            super::home_agent::handle_provider_route(s, &method, p, body)
        }
        (_, p) if super::home_agent::owns_oauth_login(p) => {
            super::home_agent::handle_oauth_login_route(s, &method, p, body)
        }
        ("POST", "/api/agent/jev/api-key") => {
            home_api::proxy_agent(s, "POST", "/v1/settings/jev/api-key", Some(body))
        }
        ("POST", "/api/agent/jev/test") => {
            home_api::proxy_agent(s, "POST", "/v1/settings/jev/test", Some(body))
        }
        (_, p) if super::home_research::owns(p) => {
            super::home_research::handle(s, &method, p, body)
        }
        (_, p) if super::home_report::owns(p) => {
            super::home_report::handle(s, &method, p, body, head)
        }
        (_, p) if super::home_system::owns(p) => super::home_system::handle(s, &method, p),
        (_, p) if super::home_update::owns(p) => super::home_update::handle(s, &method, p, body),
        (_, p) if super::home_fork::owns(p) => super::home_fork::handle(s, state, &method, p, body),
        ("POST", "/api/open-external") => home_api::handle_open_external(s, body),
        ("POST", "/api/pick-open") => handle_pick_open(s, state),
        ("POST", "/api/pick-parent") => handle_pick_parent(s),
        ("POST", "/api/create") => super::home_create::handle_create(s, state, body),
        ("POST", "/api/name-status") => home_api::handle_name_status(s, body),
        ("POST", "/api/open") => handle_open(s, state, body),
        ("POST", "/api/rename") => super::home_project::handle_rename(s, state, body),
        ("POST", "/api/remove") => home_api::handle_remove(s, state, body),
        ("POST", "/api/recents/restore") => home_api::handle_restore(s, state, body),
        ("POST", "/api/trash") => super::home_project::handle_trash(s, state, body),
        ("POST", "/api/duplicate") => home_api::handle_duplicate(s, state, body),
        ("POST", "/api/reveal") => home_api::handle_reveal(s, state, body),
        ("POST", "/api/locate") => home_api::handle_locate(s, state, body),
        ("POST", "/api/files/pick") => home_api::handle_pick_files(s),
        ("POST", "/api/files/dropped") => home_api::handle_dropped(s, body),
        ("POST", "/api/start/name") => home_api::handle_start_name(s, state, body),
        ("POST", "/api/start") => home_api::handle_start(s, state, body),
        (_, p) if p.starts_with("/api/menu/") => handle_menu_action(s, &method, p, cors_origin),
        _ => respond(s, 404, "text/plain", b"not found"),
    }
}

/// Run one title-bar app menu action through the same `menu_action` the
/// hidden native menu uses, so the two cannot drift apart. `POST` only
/// (a GET must never quit the app); unknown actions 404 so a stale page
/// cannot trigger something new.
fn handle_menu_action(stream: &mut TcpStream, method: &str, path: &str, cors_origin: Option<&str>) {
    let action = path.trim_start_matches("/api/menu/");
    if method != "POST"
        || action.is_empty()
        || action.contains('/')
        || !super::MENU_ACTIONS.contains(&action)
    {
        respond_menu(stream, 404, "text/plain", b"not found", cors_origin);
        return;
    }
    match super::menu_app() {
        Some(app) => {
            super::menu_action(&app, action);
            respond_menu(stream, 200, "application/json", br#"{"ok":true}"#, cors_origin);
        }
        None => respond_menu(stream, 503, "text/plain", b"app not ready", cors_origin),
    }
}

/// What a Studio page may ask of this server across origins. Granted once per request by
/// [`studio_menu_grant`]; `origin` is the exact `Origin` to echo back.
struct StudioMenuGrant {
    origin: String,
    /// Set for a CORS preflight: the method it announced (the endpoint's own).
    preflight_method: Option<&'static str>,
}

/// The actions Studio's title-bar menu posts to this server from its own origin on the Windows custom frame
/// (the other entries of that menu are in-page navigation or the window IPC). Not the full `MENU_ACTIONS`:
/// quit, reload, show_home and open_settings never cross origins without the home token.
const STUDIO_MENU_POSTS: [&str; 3] = ["open_project", "welcome", "check_updates"];

/// Studio is another loopback origin, so its `fetch` to this server is cross-origin. Only the title-bar menu's
/// own requests are let through, token-free and with a CORS grant — and only when every condition holds:
///
/// - the window really is the Windows custom frame (`frame == "custom"`; a query string never grants anything),
/// - `Host` names this server and `Origin` is the Studio origin the window currently shows,
/// - the request is `POST /api/menu/{open_project,welcome,check_updates}`, `GET /api/menu/about`, or the
///   `OPTIONS` preflight of exactly one of them (requested method = that endpoint's method, requested headers
///   only `content-type`).
///
/// Anything else — another action, a stale or missing `Origin`, a foreign `Host`, the system or macOS frame —
/// gets no grant, so it is judged by the ordinary same-origin and token rules (403 for a foreign origin).
fn studio_menu_grant(
    frame: &str,
    head: &Head,
    studio_origins: &[String],
    port: u16,
) -> Option<StudioMenuGrant> {
    if !cfg!(windows) || frame != "custom" || !home_auth::host_is_this_server(head, port) {
        return None;
    }
    let origin = head.header("origin")?.trim().to_lowercase();
    if !studio_origins.contains(&origin) || !home_auth::origin_allowed_studio_origin(&origin, port) {
        return None;
    }
    let endpoint_method = match head.path.strip_prefix("/api/menu/")? {
        "about" => "GET",
        action if STUDIO_MENU_POSTS.contains(&action) => "POST",
        _ => return None,
    };
    if head.method.eq_ignore_ascii_case(endpoint_method) {
        return Some(StudioMenuGrant { origin, preflight_method: None });
    }
    if head.method.eq_ignore_ascii_case("OPTIONS") {
        if head.header("access-control-request-method").map(str::trim) != Some(endpoint_method) {
            return None;
        }
        if let Some(requested) = head.header("access-control-request-headers") {
            if !requested.split(',').all(|name| name.trim().eq_ignore_ascii_case("content-type")) {
                return None;
            }
        }
        return Some(StudioMenuGrant { origin, preflight_method: Some(endpoint_method) });
    }
    None
}

/// The `Origin` values Studio may currently send: the live sidecar origin
/// plus the `localhost` spelling of the same port, so the check survives the
/// host alias the browser normalises to.
fn studio_origins_for(state: &Arc<Mutex<HomeInner>>) -> Vec<String> {
    let Some(origin) = state.lock().ok().and_then(|inner| inner.studio_origin.clone()) else {
        return Vec::new();
    };
    let mut origins = vec![origin.to_lowercase()];
    if let Some(rest) = origins[0].strip_prefix("http://127.0.0.1:") {
        origins.push(format!("http://localhost:{rest}"));
    } else if let Some(rest) = origins[0].strip_prefix("http://localhost:") {
        origins.push(format!("http://127.0.0.1:{rest}"));
    }
    origins
}

/// What the pages show in their About sheet: the same name, version and site
/// the native About dialog shows (`AboutMetadata` in `build_menu`), read from
/// one place instead of two. GET is safe here: it only reads strings.
fn serve_menu_about(stream: &mut TcpStream, cors_origin: Option<&str>) {
    let about = serde_json::json!({
        "name": "OpenVids",
        "version": env!("CARGO_PKG_VERSION"),
        "website": "https://openvids.ai",
        "websiteLabel": "openvids.ai",
        "comment": super::i18n::t("menu.app.aboutComment"),
        "credits": super::i18n::t("menu.app.aboutCredits"),
    });
    respond_menu(stream, 200, "application/json", about.to_string().as_bytes(), cors_origin);
}

/// The page, with the token and the boot state (intro flag + preferences)
/// it needs before first paint.
fn serve_page(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, token: &str) {
    let (skip_intro, open_onboarding) = state
        .lock()
        .ok()
        .map(|mut inner| {
            let opening = matches!(inner.open_phase, OpenPhase::Opening { .. });
            let skip = inner.skip_intro || opening;
            inner.skip_intro = false;
            (skip, std::mem::take(&mut inner.pending_onboarding))
        })
        .unwrap_or((true, false));
    let prefs = super::prefs::load(&super::prefs::prefs_path());
    let boot = serde_json::json!({
        "intro": !skip_intro,
        "openOnboarding": open_onboarding,
        "prefs": prefs,
        "locales": boot_locales(&prefs),
        "version": env!("CARGO_PKG_VERSION"),
        "frame": super::window_frame(),
        "channel": super::channel::build_channel(),
        "betaFeatures": super::channel::beta_features_enabled(),
    });
    // `<` cannot close the inline script: JSON-escape it.
    let boot = boot.to_string().replace('<', "\\u003c");
    let page = PAGE
        .replace(TOKEN_PLACEHOLDER, token)
        .replace(BOOT_PLACEHOLDER, &boot);
    respond(stream, 200, "text/html; charset=utf-8", page.as_bytes());
}

/// The Settings window document, with the token and the locale catalog its
/// first paint needs (`window.OV_LOCALES`). Same `locales` object as `boot`.
fn serve_settings_page(stream: &mut TcpStream, token: &str) {
    let prefs = super::prefs::load(&super::prefs::prefs_path());
    // `<` cannot close the inline script: JSON-escape it.
    let locales = boot_locales(&prefs).to_string().replace('<', "\\u003c");
    let page = SETTINGS_PAGE
        .replace(TOKEN_PLACEHOLDER, token)
        .replace(LOCALES_PLACEHOLDER, &locales);
    respond(stream, 200, "text/html; charset=utf-8", page.as_bytes());
}

/// The report window document: token, the locale catalog and the boot object
/// (`OV_BOOT`: resolved theme, resolved language, raw preference). Rendered
/// from Rust because the window has no query string to inherit from the page
/// underneath it.
fn serve_report_page(stream: &mut TcpStream, token: &str) {
    let page = render_report_page(token);
    respond(stream, 200, "text/html; charset=utf-8", page.as_bytes());
}

fn render_report_page(token: &str) -> String {
    let prefs = super::prefs::load(&super::prefs::prefs_path());
    // `<` cannot close the inline script: JSON-escape it.
    let locales = boot_locales(&prefs).to_string().replace('<', "\\u003c");
    let boot = super::report::boot_json()
        .to_string()
        .replace('<', "\\u003c");
    REPORT_PAGE
        .replace(TOKEN_PLACEHOLDER, token)
        .replace(LOCALES_PLACEHOLDER, &locales)
        .replace(BOOT_PLACEHOLDER, &boot)
}

/// What the pages get injected so the first paint is already translated:
/// the language list plus `en` and the preferred locale's messages.
fn boot_locales(prefs: &serde_json::Value) -> serde_json::Value {
    let language = super::prefs::language(prefs);
    let code = if language == "system" {
        "en"
    } else {
        language
    };
    serde_json::json!({
        "index": super::locales::index_value(),
        "messages": super::locales::boot_messages(code),
    })
}

/// One compiled locale file: `GET /locales/<code>.json`. Anything that is
/// not a plain `<code>.json` file name is a 404, never a filesystem read.
fn serve_locale(stream: &mut TcpStream, name: &str) {
    let code = name.strip_suffix(".json").unwrap_or_default();
    let ok = name.ends_with(".json")
        && !code.is_empty()
        && !code.contains('/')
        && !code.contains('\\')
        && !code.contains("..")
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    match ok.then(|| super::locales::locale_json(code)).flatten() {
        Some(body) => respond(stream, 200, "application/json; charset=utf-8", body.as_bytes()),
        None => respond(stream, 404, "text/plain", b"no such locale"),
    }
}

fn asset(name: &str) -> Option<(&'static str, &'static [u8])> {
    const CSS: &str = "text/css; charset=utf-8";
    const JS: &str = "text/javascript; charset=utf-8";
    const SVG: &str = "image/svg+xml";
    Some(match name {
        "ov.css" => (CSS, include_bytes!("home_page/ov.css")),
        "home.css" => (CSS, include_bytes!("home_page/home.css")),
        "composer.css" => (CSS, include_bytes!("home_page/composer.css")),
        "settings.css" => (CSS, include_bytes!("home_page/settings.css")),
        "report.css" => (CSS, include_bytes!("home_page/report.css")),
        "shared.js" => (JS, include_bytes!("home_page/shared.js")),
        "i18n.js" => (JS, include_bytes!("home_page/i18n.js")),
        "home.js" => (JS, include_bytes!("home_page/home.js")),
        "sheets.js" => (JS, include_bytes!("home_page/sheets.js")),
        "composer.js" => (JS, include_bytes!("home_page/composer.js")),
        "settings-core.js" => (JS, include_bytes!("home_page/settings-core.js")),
        "settings-general.js" => (JS, include_bytes!("home_page/settings-general.js")),
        "settings-agents.js" => (JS, include_bytes!("home_page/settings-agents.js")),
        "settings-providers.js" => (JS, include_bytes!("home_page/settings-providers.js")),
        "settings-signin.js" => (JS, include_bytes!("home_page/settings-signin.js")),
        "settings-jev.js" => (JS, include_bytes!("home_page/settings-jev.js")),
        "settings-assets.js" => (JS, include_bytes!("home_page/settings-assets.js")),
        "settings-execution.js" => (JS, include_bytes!("home_page/settings-execution.js")),
        "settings.js" => (JS, include_bytes!("home_page/settings.js")),
        "report.js" => (JS, include_bytes!("home_page/report.js")),
        "onboarding.css" => (CSS, include_bytes!("home_page/onboarding.css")),
        "onboarding.js" => (JS, include_bytes!("home_page/onboarding.js")),
        "onboarding-welcome.js" => (JS, include_bytes!("home_page/onboarding-welcome.js")),
        "onboarding-appearance.js" => (JS, include_bytes!("home_page/onboarding-appearance.js")),
        "onboarding-models.js" => (JS, include_bytes!("home_page/onboarding-models.js")),
        "onboarding-system.js" => (JS, include_bytes!("home_page/onboarding-system.js")),
        "onboarding-project.js" => (JS, include_bytes!("home_page/onboarding-project.js")),
        "mark-loader.svg" => (SVG, include_bytes!("home_page/mark-loader.svg")),
        "mark-loader-light.svg" => (SVG, include_bytes!("home_page/mark-loader-light.svg")),
        "logo-intro.svg" => (SVG, include_bytes!("home_page/logo-intro.svg")),
        "logo-intro-light.svg" => (SVG, include_bytes!("home_page/logo-intro-light.svg")),
        _ => return None,
    })
}

fn serve_asset(stream: &mut TcpStream, name: &str) {
    match asset(name) {
        Some((content_type, bytes)) => respond(stream, 200, content_type, bytes),
        None => respond(stream, 404, "text/plain", b"no such asset"),
    }
}

/// Mark an open as started and hand it to the opener (lib.rs).
pub fn begin_open(
    state: &Arc<Mutex<HomeInner>>,
    id: String,
    dir: PathBuf,
    workspace: Option<String>,
) {
    let opener = state.lock().ok().and_then(|mut inner| {
        inner.open_phase = OpenPhase::Opening { label: id.clone() };
        inner.opener.clone()
    });
    if let Some(opener) = opener {
        opener(dir, workspace);
    }
}

fn serve_thumb(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, path: &str) {
    let name = path.trim_start_matches("/thumb/");
    if !is_safe_thumb_name(name) {
        respond(stream, 400, "text/plain", b"bad thumbnail name");
        return;
    }
    let bytes = state
        .lock()
        .ok()
        .and_then(|inner| std::fs::read(inner.thumbs_dir.join(name)).ok());
    match bytes {
        Some(bytes) => respond(stream, 200, content_type_for(name), &bytes),
        None => respond(stream, 404, "text/plain", b"no thumbnail yet"),
    }
}

fn serve_open_state(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>) {
    let payload = state.lock().ok().map(|inner| match &inner.open_phase {
        OpenPhase::Idle => serde_json::json!({ "phase": "idle" }),
        OpenPhase::Opening { label } => serde_json::json!({ "phase": "opening", "label": label }),
        OpenPhase::Failed { label, error } => {
            let mut body = error.body();
            body["phase"] = serde_json::json!("failed");
            body["label"] = serde_json::json!(label);
            body
        }
    });
    match payload {
        Some(json) => respond_json(stream, 200, &json),
        None => respond(stream, 500, "text/plain", b"state poisoned"),
    }
}

fn handle_pick_open(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>) {
    match rfd::FileDialog::new()
        .set_title(super::i18n::t("dialog.openProject.title"))
        .pick_folder()
    {
        None => respond(stream, 200, "application/json", br#"{"cancelled":true}"#),
        Some(dir) => match validate_structure(&dir) {
            Ok(project) => {
                begin_open(state, project.id.clone(), project.dir.clone(), None);
                respond(
                    stream,
                    200,
                    "application/json",
                    br#"{"cancelled":false,"opening":true}"#,
                );
            }
            Err(err) => {
                let mut body = home_api::not_a_project_error(&dir, &err).body();
                body["invalid"] = serde_json::json!(true);
                body["path"] = serde_json::json!(super::prefs::abbreviate_home(&dir));
                respond_json(stream, 400, &body);
            }
        },
    }
}

fn handle_pick_parent(stream: &mut TcpStream) {
    match rfd::FileDialog::new()
        .set_title(super::i18n::t("dialog.chooseLocation.title"))
        .pick_folder()
    {
        None => respond(stream, 200, "application/json", br#"{"cancelled":true}"#),
        Some(parent) => respond_json(
            stream,
            200,
            &serde_json::json!({
                "parent": parent.to_string_lossy(),
                "path": super::prefs::abbreviate_home(&parent),
            }),
        ),
    }
}

fn handle_open(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let id = json_field(body, "id");
    let workspace = json_field(body, "workspace")
        .filter(|w| super::prefs::WORKSPACES.contains(&w.as_str()));
    let found = state.lock().ok().and_then(|inner| {
        inner
            .recents
            .find_by_key(&id.clone().unwrap_or_default())
            .cloned()
    });
    match (id, found) {
        (Some(_), Some(entry)) => {
            if !entry.dir.is_dir() {
                respond_error(stream, 410, &home_api::folder_missing_remove(&entry.dir));
            } else {
                match validate_structure(&entry.dir) {
                    Ok(project) => {
                        begin_open(state, project.id.clone(), project.dir.clone(), workspace);
                        respond(stream, 200, "application/json", br#"{"opening":true}"#);
                    }
                    Err(err) => respond_error(stream, 400, &err.coded()),
                }
            }
        }
        _ => respond_error(stream, 404, &home_api::unknown_project()),
    }
}

pub fn json_field(body: &[u8], key: &str) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()?
        .get(key)?
        .as_str()
        .map(|s| s.to_string())
}

fn is_safe_thumb_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && (name.ends_with(".jpg") || name.ends_with(".png"))
        && !name.contains("..")
}

fn content_type_for(name: &str) -> &'static str {
    if name.ends_with(".png") {
        "image/png"
    } else {
        "image/jpeg"
    }
}

pub(crate) fn percent_decode(path: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(path.len());
    let mut bytes = path.as_bytes().iter();
    while let Some(&b) = bytes.next() {
        if b == b'%' {
            let hi = bytes.next().copied().unwrap_or(b'0');
            let lo = bytes.next().copied().unwrap_or(b'0');
            let hex = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
            out.push(hex(hi) * 16 + hex(lo));
        } else {
            out.push(b);
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn status_line(code: u16) -> &'static str {
    match code {
        200 => "HTTP/1.1 200 OK",
        201 => "HTTP/1.1 201 Created",
        202 => "HTTP/1.1 202 Accepted",
        204 => "HTTP/1.1 204 No Content",
        400 => "HTTP/1.1 400 Bad Request",
        401 => "HTTP/1.1 401 Unauthorized",
        403 => "HTTP/1.1 403 Forbidden",
        404 => "HTTP/1.1 404 Not Found",
        405 => "HTTP/1.1 405 Method Not Allowed",
        408 => "HTTP/1.1 408 Request Timeout",
        409 => "HTTP/1.1 409 Conflict",
        410 => "HTTP/1.1 410 Gone",
        413 => "HTTP/1.1 413 Payload Too Large",
        415 => "HTTP/1.1 415 Unsupported Media Type",
        422 => "HTTP/1.1 422 Unprocessable Entity",
        429 => "HTTP/1.1 429 Too Many Requests",
        501 => "HTTP/1.1 501 Not Implemented",
        502 => "HTTP/1.1 502 Bad Gateway",
        503 => "HTTP/1.1 503 Service Unavailable",
        504 => "HTTP/1.1 504 Gateway Timeout",
        _ => "HTTP/1.1 500 Internal Server Error",
    }
}

pub fn respond(stream: &mut TcpStream, code: u16, content_type: &'static str, body: &[u8]) {
    write_response(stream, code, content_type, body, "");
}

/// Headers that keep a Home document out of a foreign page's frame: the
/// Projects page frames Settings from the same origin, nothing else frames it.
fn frame_guard(content_type: &str) -> &'static str {
    if content_type.starts_with("text/html") {
        "Content-Security-Policy: frame-ancestors 'self'\r\nX-Frame-Options: SAMEORIGIN\r\n"
    } else {
        ""
    }
}

fn response_head(code: u16, content_type: &str, body_len: usize, extra_headers: &str) -> String {
    format!(
        "{}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{}{}Connection: close\r\n\r\n",
        status_line(code),
        content_type,
        body_len,
        frame_guard(content_type),
        extra_headers
    )
}

/// The one HTTP serializer. `extra_headers` is zero or more complete `Name: value\r\n` lines.
fn write_response(
    stream: &mut TcpStream,
    code: u16,
    content_type: &'static str,
    body: &[u8],
    extra_headers: &str,
) {
    let head = response_head(code, content_type, body.len(), extra_headers);
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

/// `respond` for the title-bar menu endpoints: when `cors_origin` is a Studio origin that
/// `studio_menu_grant` approved, the answer lets exactly that origin read it. Never `*`, never credentials.
fn respond_menu(
    stream: &mut TcpStream,
    code: u16,
    content_type: &'static str,
    body: &[u8],
    cors_origin: Option<&str>,
) {
    let headers = cors_origin
        .map(|origin| format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"))
        .unwrap_or_default();
    write_response(stream, code, content_type, body, &headers);
}

/// The 204 answer to an approved preflight.
fn respond_preflight(stream: &mut TcpStream, grant: &StudioMenuGrant, allow_headers: bool) {
    let mut headers = format!(
        "Access-Control-Allow-Origin: {}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: {}\r\n",
        grant.origin,
        grant.preflight_method.unwrap_or("POST")
    );
    if allow_headers {
        headers.push_str("Access-Control-Allow-Headers: content-type\r\n");
    }
    write_response(stream, 204, "text/plain", b"", &headers);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_screenshot_upload_gets_the_large_body_limit() {
        let head = |method: &str, path: &str| {
            parse_head(&format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n"))
                .expect("a parsable request head")
        };
        assert_eq!(
            body_limit(&head("POST", "/api/report/screenshots")),
            SCREENSHOT_BODY_LIMIT
        );
        assert_eq!(
            body_limit(&head("POST", "/api/%72eport/screenshots")),
            SCREENSHOT_BODY_LIMIT,
            "the decoded path decides, as it does when routing"
        );
        for (method, path) in [
            ("POST", "/api/report/submit"),
            ("POST", "/api/report/draft"),
            ("GET", "/api/report/screenshots"),
            ("POST", "/api/preferences"),
            ("POST", "/"),
        ] {
            assert_eq!(
                body_limit(&head(method, path)),
                BODY_LIMIT,
                "{method} {path}"
            );
        }
    }

    /// The token requirement is decided on the same path the router
    /// dispatches on, so an encoded spelling of an `/api` route cannot skip it.
    #[test]
    fn encoded_spellings_of_api_routes_still_require_the_token() {
        let target = |method: &str, path: &str| {
            let head = parse_head(&format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n"))
                .expect("a parsable request head");
            (home_auth::requires_token(&head.method, &head.path), head.path)
        };
        for (raw, decoded) in [
            ("/api/recents", "/api/recents"),
            ("/%61pi/recents", "/api/recents"),
            ("/%61%70%69/recents", "/api/recents"),
            ("/api%2Frecents", "/api/recents"),
            ("/api%2frecents", "/api/recents"),
            ("/api/agent%2Fmodels?x=1", "/api/agent/models"),
        ] {
            let (needs_token, path) = target("GET", raw);
            assert_eq!(path, decoded, "{raw}");
            assert!(needs_token, "{raw} must need the token");
        }
        // The decoded text is the final word: a double-encoded spelling is
        // not decoded again, so it never reaches an `/api` handler.
        let (needs_token, path) = target("GET", "/%2561pi/recents");
        assert_eq!(path, "/%61pi/recents");
        assert!(!needs_token);
        // Pages and assets stay open.
        assert!(!target("GET", "/").0);
        assert!(!target("GET", "/%61ssets/home.js").0);
    }

    #[test]
    fn html_documents_refuse_foreign_frames_and_other_types_are_untouched() {
        let html = response_head(200, "text/html; charset=utf-8", 5, "");
        assert!(html.contains("Content-Security-Policy: frame-ancestors 'self'\r\n"), "{html}");
        assert!(html.contains("X-Frame-Options: SAMEORIGIN\r\n"), "{html}");
        let json = response_head(200, "application/json", 5, "");
        assert!(!json.contains("frame-ancestors") && !json.contains("X-Frame-Options"), "{json}");
    }

    #[test]
    fn the_report_page_is_rendered_with_token_locales_and_boot_state() {
        let page = render_report_page("token-123");
        for placeholder in ["__OPENVids_TOKEN__", "__OV_LOCALES__", "__OV_BOOT__"] {
            assert!(
                !page.contains(placeholder),
                "{placeholder} left in the page"
            );
        }
        assert!(page.contains("token-123"));
        assert!(page.contains("window.OV_LOCALES = {"), "{page}");
        let boot = page
            .split("window.OV_BOOT = ")
            .nth(1)
            .and_then(|rest| rest.split(";\n").next())
            .expect("the boot assignment");
        let boot: serde_json::Value = serde_json::from_str(boot).expect("OV_BOOT parses as JSON");
        assert!(boot["theme"].is_string(), "{boot}");
        assert!(boot["language"].is_string(), "{boot}");
        assert!(boot["languagePreference"].is_string(), "{boot}");
    }

    #[test]
    fn percent_decoding_keeps_utf8() {
        assert_eq!(percent_decode("/thumb/a%20b.jpg"), "/thumb/a b.jpg");
        assert_eq!(percent_decode("/x/%E2%80%94"), "/x/—");
    }

    #[test]
    fn every_asset_the_page_links_is_compiled_in() {
        for page in [PAGE, SETTINGS_PAGE, REPORT_PAGE] {
            for chunk in page.split("/assets/").skip(1) {
                let name: String = chunk
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
                    .collect();
                assert!(asset(&name).is_some(), "missing asset {name}");
            }
        }
    }

    #[test]
    fn locales_catalog_is_embedded_and_looks_up_by_code() {
        assert!(super::super::locales::LOCALE_CODES.contains(&"en"));
        let en = super::super::locales::locale_json("en").expect("en is listed");
        assert!(en.contains("settings.language.label"));
        assert!(super::super::locales::locale_json("xx").is_none());
        assert!(super::super::locales::locale_json("../prefs").is_none());
        let index: serde_json::Value =
            serde_json::from_str(super::super::locales::INDEX_JSON).expect("index parses");
        assert_eq!(
            index.as_array().map(Vec::len),
            Some(super::super::locales::LOCALE_CODES.len())
        );
        assert!(asset("i18n.js").is_some());
    }

    #[test]
    fn a_studio_menu_grant_needs_the_windows_custom_frame() {
        let studio = "http://127.0.0.1:5210".to_string();
        let head = Head {
            method: "POST".into(),
            path: "/api/menu/open_project".into(),
            headers: [("host", "127.0.0.1:5199"), ("origin", studio.as_str())]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        };
        let origins = [studio.clone()];
        // macOS ("overlay") and the Windows system-frame fallback never grant, whatever else matches.
        for frame in ["overlay", "system", "", "Custom", "custom "] {
            assert!(studio_menu_grant(frame, &head, &origins, 5199).is_none(), "frame {frame:?}");
        }
        // The custom frame grants on Windows builds only.
        assert_eq!(studio_menu_grant("custom", &head, &origins, 5199).is_some(), cfg!(windows));
        // And never for an origin that is not the live Studio one.
        assert!(studio_menu_grant("custom", &head, &[], 5199).is_none());
    }
}
