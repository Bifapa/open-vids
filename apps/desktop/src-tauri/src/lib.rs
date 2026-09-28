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
//!   loopback port. Before a project is chosen it shows a placeholder page,
//!   because the embedded server is single-project and cannot start without
//!   one.
//!
//! ## What the webview is allowed to do
//!
//! Nothing beyond the web platform. There is no `withGlobalTauri`, and the
//! capability in `capabilities/main.json` declares no `remote` block, so the
//! `http://127.0.0.1` document — a remote origin as far as Tauri is concerned —
//! is granted no IPC at all. Every file read, write, upload and delete already
//! goes through the Studio HTTP API, which runs in the sidecar with full OS
//! access, so the webview needs no filesystem, shell or process capability.

mod placeholder;
mod project;
mod sidecar;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use placeholder::PlaceholderServer;
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
///
/// The sidecar is a `Child`, so it has to be reachable from the menu handler and
/// from shutdown. Dropping this state — on every exit path, including Cmd+Q —
/// gives the child one more chance to be reaped. See `sidecar::terminate` for
/// why that is a best-effort backstop rather than the guarantee, and
/// `sidecar/serve.mjs` for what actually enforces it.
struct AppState {
    mode: Mode,
    project: Option<Project>,
    studio: Option<StudioServer>,
    placeholder: Option<PlaceholderServer>,
    dev_origin: Option<String>,
    dev_projects_dir: Option<PathBuf>,
}

fn log_line(message: &str) {
    eprintln!("[openvids] {message}");
}

// ── Startup arguments ───────────────────────────────────────────────────────

/// The project to open at launch, if one was named.
///
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
///
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
///
/// The embedded server is single-project by construction — `createStudioServer`
/// takes one `projectDir` — so switching projects means a new sidecar rather
/// than a new request. Restarting is also what stops the previous process
/// group's Chrome instances from lingering.
fn open_project(app: &tauri::AppHandle, dir: PathBuf) -> Result<String, String> {
    let project = project::validate(&dir).map_err(|e| e.to_string())?;

    let target = {
        let app_state = app.state::<Mutex<AppState>>();
        let mut state = app_state
            .lock()
            .map_err(|_| "app state is poisoned".to_string())?;
        state.project = Some(project.clone());

        match state.mode {
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
                format!("{origin}/#project/{}", project.id)
            }
            Mode::Prod => {
                let resource_root = resource_root(app)?;
                let bun = resource_root.join("bun");
                let launcher = resource_root.join("serve.mjs");
                let cli = resource_root.join("hyperframes").join("cli.js");
                // Drop the previous server first: the new one must be able to
                // bind, and the old Chrome instances must go with it.
                state.studio = None;
                state.placeholder = None;
                let logger: std::sync::Arc<dyn Fn(&str) + Send + Sync> =
                    std::sync::Arc::new(|line| eprintln!("{line}"));
                let started =
                    sidecar::start(&launcher, &bun, &cli, &project.dir, logger)
                        .map_err(|e| e.to_string())?;
                let url = started.project_url(&project.id);
                state.studio = Some(started);
                url
            }
        }
    };

    app.get_webview_window("main")
        .ok_or_else(|| "the main window is gone".to_string())?
        .navigate(
            target
                .parse()
                .map_err(|e| format!("built an invalid URL {target:?}: {e}"))?,
        )
        .map_err(|e| e.to_string())?;
    Ok(target)
}

/// The directory holding the bundled runtime payload.
///
/// Dev never reaches this path — the sidecar only runs in a release build —
/// but a missing payload is reported as a clear build error rather than a
/// confusing spawn failure.
///
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
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &open,
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
            comments: Some("HyperFrames Studio on the desktop".into()),
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

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &PredefinedMenuItem::fullscreen(app, Some("Enter Full Screen"))?,
            &PredefinedMenuItem::minimize(app, Some("Minimize"))?,
        ],
    )?;

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

    Menu::with_items(app, &[&app_menu, &file, &view, &window])
}

// ── Entry point ──────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "open_project" {
                pick_and_open(app);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let dev = cfg!(debug_assertions);

            // The window is always created first so the user sees something
            // immediately: Studio in dev, a placeholder in production. A
            // project named at launch is opened right after, off the setup path
            // so a slow sidecar never freezes the app.
            let (state, initial_url) = if dev {
                let origin = app
                    .config()
                    .build
                    .dev_url
                    .clone()
                    .map(|url| url.to_string().trim_end_matches('/').to_string())
                    .ok_or("devUrl is not configured")?;
                (
                    AppState {
                        mode: Mode::Dev,
                        project: None,
                        studio: None,
                        placeholder: None,
                        dev_projects_dir: Some(studio_projects_dir()),
                        dev_origin: Some(origin.clone()),
                    },
                    origin,
                )
            } else {
                let placeholder = PlaceholderServer::bind()?;
                let url = placeholder.origin();
                (
                    AppState {
                        mode: Mode::Prod,
                        project: None,
                        studio: None,
                        placeholder: Some(placeholder),
                        dev_origin: None,
                        dev_projects_dir: None,
                    },
                    url,
                )
            };

            app.manage(Mutex::new(state));

            let url: tauri::Url = initial_url
                .parse()
                .map_err(|e| format!("invalid window URL {initial_url:?}: {e}"))?;
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
            // while the child can still be waited on.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(state) = app.try_state::<Mutex<AppState>>() {
                    if let Ok(mut state) = state.lock() {
                        state.studio = None;
                        state.placeholder = None;
                    }
                }
            }
        });
}

/// Open a project off the setup path, reporting failure to the log.
///
/// The sidecar start blocks on a port handshake and a readiness poll, so it
/// runs on a blocking worker rather than the async runtime's event loop.
fn open_project_async(app: &tauri::AppHandle, dir: PathBuf) {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || match open_project(&handle, dir) {
        Ok(url) => log_line(&format!("opened {url}")),
        Err(err) => log_line(&format!("could not open the project: {err}")),
    });
}

/// Where the Studio dev server looks for projects.
///
/// Resolved from `CARGO_MANIFEST_DIR` at compile time rather than the process
/// working directory, so it does not matter which terminal launches the app.
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
///
/// `rfd` is used rather than a Tauri dialog plugin on purpose: the plugin
/// would put a dialog capability in the bundle, and the point of this app is
/// that the webview gets no native capabilities at all. Picking a folder is
/// the one privileged action, and it belongs in Rust.
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
