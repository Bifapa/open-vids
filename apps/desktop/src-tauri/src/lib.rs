//! OpenVids — a Tauri shell around HyperFrames Studio.
//!
//! ## Why the webview points at a loopback origin
//!
//! Studio is a React SPA whose every API call is a root-relative `/api/...`
//! path, and the composition it edits lives in an iframe reached through
//! `contentDocument` / `contentWindow` (`packages/studio/AGENTS.md` calls this
//! out explicitly). The API is mounted in the same process that serves the
//! SPA — Vite middleware in development, a Hono server in production — so
//! "the document's origin" and "the API's origin" are the same thing by
//! construction.
//!
//! That is the whole design. Loading the SPA from a `tauri://` asset instead
//! would put the API on a different origin and break every `contentDocument`
//! read; a `postMessage` bridge would be a second, parallel editing path. So
//! the app runs the real server on 127.0.0.1 and navigates the window at it.
//!
//! ## Two modes, one webview
//!
//! * Development — the window loads Studio's Vite dev server. HMR, no sidecar,
//!   no bundling. `apps/desktop/scripts/serve-studio-dev.mjs` is Tauri's
//!   `beforeDevCommand`.
//! * Production — the window loads the embedded Studio server run by the
//!   bundled sidecar, which serves the prebuilt SPA *and* `/api` from one
//!   loopback port. Before a project is chosen it shows the Projects home
//!   screen, because the embedded server is single-project and cannot start
//!   without one.
//!
//! ## The home screen
//!
//! Both modes start on a Projects home page served by `home::HomeServer`, a
//! small loopback listener that lives for the whole app lifetime (never
//! dropped on project open, so File > Show All Projects is a plain
//! navigation back). It serves one self-contained document
//! (`home.html`, token injected per launch) plus a JSON API for
//! recents, folder picking (`rfd` in Rust), scaffolding, rename, remove and
//! Trash. See `home_routes.rs` for the endpoint list and `home_auth.rs` for
//! the token/origin protection.
//!
//! ## What the webview is allowed to do
//!
//! Nothing beyond the web platform. There is no `withGlobalTauri`, and the
//! capability in `capabilities/main.json` declares no `remote` block, so the
//! `http://127.0.0.1` document — a remote origin as far as Tauri is concerned —
//! is granted no IPC at all. Every file read, write, upload and delete already
//! goes through the Studio HTTP API, which runs in the sidecar with full OS
//! access, so the webview needs no filesystem, shell or process capability.

mod create;
mod home;
mod home_auth;
mod home_create;
mod home_project;
mod home_routes;
mod project;
mod recents;
mod sidecar;
mod structure;
mod thumbnails;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use home::HomeServer;
use home_routes::OpenPhase;
use project::Project;
use sidecar::StudioServer;

/// The files that make up the bundled runtime. A directory holding all of them
/// is the payload root, wherever the app is installed.
const PAYLOAD: [&str; 3] = ["bun", "serve.mjs", "hyperframes/cli.js"];

/// Which backend the window is pointed at.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Studio's Vite dev server, started by `beforeDevCommand`.
    Dev,
    /// The bundled sidecar's embedded server.
    Prod,
}

/// Everything the app owns for the lifetime of the process.
/// The sidecar is a `Child`, so it has to be reachable from the menu handler and
/// from shutdown. Dropping this state — on every exit path, including Cmd+Q —
/// gives the child one more chance to be reaped. See `sidecar::terminate` for
/// why that is a best-effort backstop rather than the guarantee, and
/// `sidecar/serve.mjs` for what actually enforces it.
/// The home server is also owned here and never dropped until exit: it serves
/// the Projects page in both modes, so "Show All Projects" always has
/// somewhere to navigate back to.
struct AppState {
    mode: Mode,
    project: Option<Project>,
    studio: Option<StudioServer>,
    home: HomeServer,
    home_origin: String,
    studio_origin: Option<String>,
    dev_origin: Option<String>,
    dev_projects_dir: Option<PathBuf>,
}

fn log_line(message: &str) {
    eprintln!("[openvids] {message}");
}

// ── Startup arguments ───────────────────────────────────────────────────────

/// The project to open at launch, if one was named.
/// Accepts a bare path argument and an `OPENVIDS_PROJECT` environment
/// variable, so both `OpenVids.app/Contents/MacOS/OpenVids ~/video` and
/// `OPENVIDS_PROJECT=~/video bun run desktop:dev` work.
fn requested_project() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("OPENVIDS_PROJECT") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    std::env::args()
        .skip(1)
        .map(PathBuf::from)
        .find(|arg| !arg.to_string_lossy().starts_with('-') && arg.exists())
}

// ── Dev-mode project registration ────────────────────────────────────────────

/// Symlink a directory into the Studio dev server's project list.
/// This is `linkProjectIntoStudioData()` from the HyperFrames CLI, done in
/// Rust. The dev server resolves projects by readdir-ing
/// `packages/studio/data/projects`, so a symlink is all that makes an
/// arbitrary directory visible to Studio's own project list — no frontend
/// change and no second project model.
#[cfg(unix)]
fn register_dev_project(projects_dir: &Path, dir: &Path, id: &str) -> std::io::Result<()> {
    use std::os::unix::fs::symlink;
    std::fs::create_dir_all(projects_dir)?;
    let link = projects_dir.join(id);
    if let Ok(existing) = std::fs::read_link(&link) {
        if existing == dir {
            return Ok(());
        }
        std::fs::remove_file(&link)?;
    }
    if link.exists() {
        // A real directory with that name: the user put it there, leave it.
        return Ok(());
    }
    symlink(dir, link)
}

#[cfg(not(unix))]
fn register_dev_project(_projects_dir: &Path, _dir: &Path, _id: &str) -> std::io::Result<()> {
    Ok(())
}

// ── Opening a project ────────────────────────────────────────────────────────

/// Bring the window to a project, restarting the sidecar if one is running.
/// The embedded server is single-project by construction — `createStudioServer`
/// takes one `projectDir` — so switching projects means a new sidecar rather
/// than a new request. Restarting is also what stops the previous process
/// group's Chrome instances from lingering. The home server is untouched: it
/// keeps serving the Projects page underneath for the way back.
fn open_project(app: &tauri::AppHandle, dir: PathBuf) -> Result<String, String> {
    let project = structure::validate_structure(&dir).map_err(|e| e.to_string())?;

    let target = {
        let app_state = app.state::<Mutex<AppState>>();
        let mut state = app_state
            .lock()
            .map_err(|_| "app state is poisoned".to_string())?;
        state.project = Some(project.clone());

        let url = match state.mode {
            Mode::Dev => {
                let origin = state
                    .dev_origin
                    .clone()
                    .ok_or_else(|| "the dev server origin is unknown".to_string())?;
                let projects_dir = state
                    .dev_projects_dir
                    .clone()
                    .ok_or_else(|| "the dev projects directory is unknown".to_string())?;
                register_dev_project(&projects_dir, &project.dir, &project.id)
                    .map_err(|e| format!("could not register the project: {e}"))?;
                state.studio_origin = Some(origin.clone());
                let home = sidecar::urlencode(&state.home_origin);
                format!("{origin}/?openvidsHome={home}#project/{}", project.id)
            }
            Mode::Prod => {
                let resource_root = resource_root(app)?;
                let bun = resource_root.join("bun");
                let launcher = resource_root.join("serve.mjs");
                let cli = resource_root.join("hyperframes").join("cli.js");
                // Drop the previous server first: the new one must be able to
                // bind, and the old Chrome instances must go with it.
                // The home server stays up — only the Studio sidecar restarts.
                state.studio = None;
                let logger: std::sync::Arc<dyn Fn(&str) + Send + Sync> =
                    std::sync::Arc::new(|line| eprintln!("{line}"));
                let started = sidecar::start(&launcher, &bun, &cli, &project.dir, logger)
                    .map_err(|e| e.to_string())?;
                let url = started.project_url(&project.id, &state.home_origin);
                state.studio_origin = Some(started.origin());
                state.studio = Some(started);
                url
            }
        };
        state.home.record_open(&project.id, &project.dir);
        state.home.set_open_phase(OpenPhase::Idle);
        url
    };

    app.get_webview_window("main")
        .ok_or_else(|| "the main window is gone".to_string())?
        .navigate(
            target
                .parse()
                .map_err(|e| format!("built an invalid URL {target:?}: {e}"))?,
        )
        .map_err(|e| e.to_string())?;
    // A fresh composition has no cached thumbnail yet. Refresh it in the
    // background once the Studio server answers, then cache the bytes the
    // home page serves. Best-effort: failures just keep the placeholder.
    thumbnails::refresh_thumbnail_async(app, project.dir.clone(), project.id.clone());
    Ok(target)
}

/// The directory holding the bundled runtime payload.
/// Dev never reaches this path — the sidecar only runs in a release build —
/// but a missing payload is reported as a clear build error rather than a
/// confusing spawn failure.
/// Every candidate is a location the *installed app* owns. There is deliberately
/// no `CARGO_MANIFEST_DIR/../runtime` fallback: a shipped app must never resolve
/// its runtime through a checkout that may not exist on the user's machine. A
/// `cargo run --release` build therefore finds nothing, and says so, rather than
/// silently working only on the machine that built it.
fn resource_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        // A macOS bundle keeps its resources in a *sibling* of the executable's
        // directory: Contents/MacOS/<exe> -> Contents/Resources. Name that
        // directory directly; walking ancestors alone never reaches it.
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("../Resources"));
            candidates.push(exe_dir.join("Resources"));
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir);
    }

    for root in &candidates {
        if PAYLOAD.iter().all(|name| root.join(name).is_file()) {
            return Ok(root.clone());
        }
    }
    Err(format!(
        "no bundled Studio runtime (looked for {PAYLOAD:?} in {}) — rebuild with `bun run desktop:build`",
        candidates
            .iter()
            .map(|c| c.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

// ── Menu ─────────────────────────────────────────────────────────────────────

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(
        app,
        "open_project",
        "Open Project Folder…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    // ⌘⇧O: back to the Projects home screen. Chosen over ⌘⇧H because ⌘H is
    // Hide OpenVids on macOS and a ⇧ variant of it reads as "hide more".
    let home = MenuItem::with_id(
        app,
        "show_home",
        "Show All Projects",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &open,
            &home,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("Close Window"))?,
            &PredefinedMenuItem::quit(app, Some("Quit OpenVids"))?,
        ],
    )?;

    let about = PredefinedMenuItem::about(
        app,
        Some("About OpenVids"),
        Some(AboutMetadata {
            name: Some("OpenVids".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            comments: Some("Agent-native desktop video editor".into()),
            credits: Some("Built on HyperFrames by HeyGen, used under the Apache License 2.0.".into()),
            ..Default::default()
        }),
    )?;
    let app_menu = Submenu::with_items(
        app,
        "OpenVids",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Hide OpenVids"))?,
            &PredefinedMenuItem::hide_others(app, Some("Hide Others"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit OpenVids"))?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Undo"))?,
            &PredefinedMenuItem::redo(app, Some("Redo"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Cut"))?,
            &PredefinedMenuItem::copy(app, Some("Copy"))?,
            &PredefinedMenuItem::paste(app, Some("Paste"))?,
            &PredefinedMenuItem::select_all(app, Some("Select All"))?,
        ],
    )?;

    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let view = Submenu::with_items(app, "View", true, &[&reload])?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("Minimize"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some("Enter Full Screen"))?,
            &PredefinedMenuItem::close_window(app, Some("Close Window"))?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

// ── Entry point ──────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "open_project" {
                pick_and_open(app);
            }
            if event.id().as_ref() == "show_home" {
                show_home(app);
            }
            if event.id().as_ref() == "reload" {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.reload() {
                        eprintln!("[openvids] could not reload the window: {error}");
                    }
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let dev = cfg!(debug_assertions);

            // The home server starts first: the window always opens on it,
            // and it outlives every project so "Show All Projects" is a
            // plain navigation back. A project named at launch
            // (OPENVIDS_PROJECT / bare arg) opens right after, off the
            // setup path so a slow sidecar never freezes the app.
            let (data_root, recents_path, thumbs_dir) = app_dirs(&handle);
            let _ = std::fs::create_dir_all(&data_root);
            let home = HomeServer::bind(recents_path, thumbs_dir)?;
            log_line(&format!("home server on {}", home.origin()));
            // Production serves the staged blank template for the create
            // form; dev resolves the checkout instead (see create.rs).
            if !dev {
                if let Ok(root) = resource_root(app.handle()) {
                    let staged = root.join("hyperframes").join("templates");
                    if staged.join("blank").join("index.html").is_file() {
                        home_create::set_staged_templates(staged);
                    }
                }
            }
            home.set_opener(home_opener(handle.clone()));

            let mut state = if dev {
                let origin = app
                    .config()
                    .build
                    .dev_url
                    .clone()
                    .map(|url| url.to_string().trim_end_matches('/').to_string())
                    .ok_or("devUrl is not configured")?;
                AppState {
                    mode: Mode::Dev,
                    project: None,
                    studio: None,
                    home,
                    home_origin: String::new(),
                    studio_origin: None,
                    dev_projects_dir: Some(studio_projects_dir()),
                    dev_origin: Some(origin),
                }
            } else {
                AppState {
                    mode: Mode::Prod,
                    project: None,
                    studio: None,
                    home,
                    home_origin: String::new(),
                    studio_origin: None,
                    dev_origin: None,
                    dev_projects_dir: None,
                }
            };
            state.home_origin = state.home.origin();
            let initial_url = state.home_origin.clone();

            let _ = APP_FOR_HOME_CLEANUP.set(Mutex::new(Some(handle.clone())));

            app.manage(Mutex::new(state));

            let url: tauri::Url = initial_url
                .parse()
                .map_err(|e| format!("invalid window URL {initial_url:?}: {e}"))?;
            let home_origin = initial_url.clone();
            WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                .title("OpenVids")
                .inner_size(1600.0, 1000.0)
                .min_inner_size(1100.0, 700.0)
                // Tauri otherwise swallows OS file drops and re-emits them as
                // its own drag-drop event. Studio imports assets through the
                // browser's own HTML5 drop (`e.dataTransfer.files` in
                // AssetsTab / FileTree / useStudioContextValue), so the handler
                // has to stay off or media import silently stops working.
                .disable_drag_drop_handler()
                .devtools(dev)
                // The in-Studio back button is a plain document navigation to
                // the home origin (the webview has no IPC by design). Allow it
                // and run the same cleanup the Show All Projects menu runs:
                // forget the project, idle the open phase, reap the sidecar.
                // The closure only parses the URL, locks the mutex briefly and
                // spawns a worker: the sidecar teardown (up to a 3 s SIGTERM
                // grace in `sidecar::terminate`) happens on that thread, never
                // on the navigation callback.
                .on_navigation(move |url| {
                    if normalize_origin(url) != home_origin {
                        return true;
                    }
                    let server =
                        app_handle_for_home_cleanup().and_then(|app| take_closed_studio(&app));
                    if let Some(server) = server {
                        std::thread::spawn(move || drop(server));
                    }
                    true
                })
                .build()?;

            if let Some(dir) = requested_project() {
                open_project_async(&handle, dir);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting OpenVids")
        .run(|app, event| {
            // `StudioServer::drop` already reaps the process group when the
            // state is dropped; this is the last chance to do it explicitly
            // while the child can still be waited on. The home server drops
            // with the state — it lives until this point, not until a
            // project opens.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(state) = app.try_state::<Mutex<AppState>>() {
                    if let Ok(mut state) = state.lock() {
                        state.studio = None;
                    }
                }
            }
        });
}

/// Open a project off the setup path, reporting failure to the log.
/// The sidecar start blocks on a port handshake and a readiness poll, so it
/// runs on a blocking worker rather than the async runtime's event loop.
/// The home page's loading overlay polls `/api/open-state` while this runs;
/// failures there surface as an inline toast, not a stuck spinner.
fn open_project_async(app: &tauri::AppHandle, dir: PathBuf) {
    let handle = app.clone();
    // Mark the phase before the blocking work starts so the home page —
    // which the window still shows — can report "opening" immediately.
    if let Some(state) = handle.try_state::<Mutex<AppState>>() {
        if let Ok(state) = state.lock() {
            let label = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| dir.display().to_string());
            state.home.set_open_phase(OpenPhase::Opening { label });
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let id = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        match open_project(&handle, dir) {
            Ok(url) => log_line(&format!("opened {url}")),
            Err(err) => {
                log_line(&format!("could not open the project: {err}"));
                if let Some(state) = handle.try_state::<Mutex<AppState>>() {
                    if let Ok(state) = state.lock() {
                        state.home.set_open_phase(OpenPhase::Failed {
                            label: id,
                            error: err,
                        });
                    }
                }
            }
        }
    });
}

fn home_opener(app: tauri::AppHandle) -> std::sync::Arc<dyn Fn(PathBuf) + Send + Sync> {
    std::sync::Arc::new(move |dir| open_project_async(&app, dir))
}

/// Back to the Projects home screen: navigate the window to the home server
/// that has been up all along. The `on_navigation` hook on the main window
/// runs the shared cleanup when that navigation lands, so the in-Studio back
/// button (a plain document navigation, no IPC) takes the same path.
fn show_home(app: &tauri::AppHandle) {
    let origin = {
        let app_state = app.state::<Mutex<AppState>>();
        let Ok(state) = app_state.lock() else {
            return;
        };
        state.home_origin.clone()
    };
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(url) = origin.parse() {
            if let Err(error) = window.navigate(url) {
                eprintln!("[openvids] could not show the home screen: {error}");
            }
        }
    }
}

/// The `on_navigation` closure gets the URL but no `AppHandle`, so the handle
/// is stashed here in `setup` before the window is built. Written once,
/// cloned on each home navigation — a plain static behind a lock is enough.
static APP_FOR_HOME_CLEANUP: std::sync::OnceLock<Mutex<Option<tauri::AppHandle>>> =
    std::sync::OnceLock::new();

fn app_handle_for_home_cleanup() -> Option<tauri::AppHandle> {
    APP_FOR_HOME_CLEANUP
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|guard| guard.clone())
}

/// `scheme://host:port` without path, query or fragment, so `/`, `/index.html`
/// and query-carrying landings on the same server all compare equal.
fn normalize_origin(url: &tauri::Url) -> String {
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or(""),
        port
    )
}

/// The shared half of "back to projects": forget the open project, idle the
/// open phase, and hand the old sidecar to the caller for teardown.
/// Called from the navigation hook on both the menu path and the in-Studio
/// back-button path, so the two cannot drift apart.
fn take_closed_studio(app: &tauri::AppHandle) -> Option<StudioServer> {
    let app_state = app.state::<Mutex<AppState>>();
    let Ok(mut state) = app_state.lock() else {
        return None;
    };
    state.project = None;
    state.studio_origin = None;
    state.home.clear_current();
    state.studio.take()
}

fn app_dirs(app: &tauri::AppHandle) -> (PathBuf, PathBuf, PathBuf) {
    let root = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("openvids-desktop"));
    (
        root.clone(),
        root.join("recents.json"),
        root.join("thumbnails"),
    )
}

fn studio_projects_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("studio")
        .join("data")
        .join("projects")
}

/// The native folder picker, off the main thread.
/// the one privileged action, and it belongs in Rust. The home page has its
/// own picker behind `/api/pick-open`; this keeps ⌘O working with the same
/// validation, recording and thumbnail refresh — and it records recents too.
fn pick_and_open(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let picked = rfd::FileDialog::new()
            .set_title("Open HyperFrames Project Folder")
            .pick_folder();
        if let Some(dir) = picked {
            open_project_async(&handle, dir);
        }
    });
}

#[cfg(test)]
mod back_navigation_tests {
    use super::*;

    #[test]
    fn studio_url_carries_the_home_origin_before_the_hash() {
        let home = "http://127.0.0.1:57035";
        let studio_origin = "http://127.0.0.1:5210";
        let built = crate::sidecar::project_url_for_test(studio_origin, "my-video", home);
        assert_eq!(
            built,
            "http://127.0.0.1:5210/?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035#project/my-video"
        );
    }

    #[test]
    fn home_navigation_matches_regardless_of_path_or_query() {
        for target in [
            "http://127.0.0.1:57035/",
            "http://127.0.0.1:57035/index.html",
            "http://127.0.0.1:57035/?openvidsHome=http%3A%2F%2Fx",
        ] {
            let url: tauri::Url = target.parse().expect("test URL parses");
            assert_eq!(normalize_origin(&url), "http://127.0.0.1:57035", "{target}");
        }
        let studio: tauri::Url = "http://127.0.0.1:5210/?openvidsHome=x#project/my-video"
            .parse()
            .expect("test URL parses");
        assert_eq!(normalize_origin(&studio), "http://127.0.0.1:5210");
    }

    #[test]
    fn query_encoding_round_trips_the_home_origin() {
        assert_eq!(
            sidecar::urlencode("http://127.0.0.1:57035"),
            "http%3A%2F%2F127.0.0.1%3A57035"
        );
    }
}
