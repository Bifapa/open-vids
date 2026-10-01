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
//! Move its own window, nothing more. There is no `withGlobalTauri`; the
//! capability in `capabilities/main.json` grants the loopback pages (remote
//! origins as far as Tauri is concerned) only window dragging and the
//! double-click zoom, for their `data-tauri-drag-region` titlebars under the
//! overlay title bar. Every file read, write, upload and delete goes through
//! the home or Studio HTTP API, which run with full OS access, so the webview
//! needs no filesystem, shell or process capability.

mod agent_proxy;
mod chrome_install;
mod cli_runner;
mod create;
mod drop_paths;
mod ffmpeg_install;
mod home;
mod home_agent;
mod home_api;
mod home_auth;
mod home_create;
mod home_project;
mod home_research;
mod home_routes;
mod home_system;
mod install_job;
mod intake;
mod prefs;
mod project;
mod project_meta;
mod recents;
mod research_policy;
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
fn open_project(
    app: &tauri::AppHandle,
    dir: PathBuf,
    workspace: Option<String>,
) -> Result<String, String> {
    let project = structure::validate_structure(&dir).map_err(|e| e.to_string())?;
    // Resolved before locking the state: the window lookup may need the
    // main thread.
    let theme = resolved_theme(app);

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
                sidecar::studio_url(
                    &origin,
                    &project.id,
                    &state.home_origin,
                    theme,
                    workspace.as_deref(),
                )
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
                let url = sidecar::studio_url(
                    &started.origin(),
                    &project.id,
                    &state.home_origin,
                    theme,
                    workspace.as_deref(),
                );
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
            website: Some("https://openvids.ai".into()),
            website_label: Some("openvids.ai".into()),
            credits: Some(
                "openvids.ai\nBuilt on HyperFrames by HeyGen, used under the Apache License 2.0."
                    .into(),
            ),
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

    // Help › Welcome to OpenVids… reopens the first-run onboarding (see
    // `show_onboarding`). The id is what `set_help_menu` finds again in `setup`.
    let welcome = MenuItem::with_id(app, "welcome", "Welcome to OpenVids…", true, None::<&str>)?;
    let help = Submenu::with_id_and_items(app, "help", "Help", true, &[&welcome])?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

// ── Entry point ──────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "open_project" {
                // On the Projects page, ⌘O is the page's own Open Project…
                // (its invalid-folder sheet and opening state); the menu
                // accelerator consumes the key, so hand it over by script.
                if window_is_on_home(app) {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("window.ovHome && window.ovHome.openProject()");
                    }
                } else {
                    pick_and_open(app);
                }
            }
            if event.id().as_ref() == "show_home" {
                show_home(app);
            }
            if event.id().as_ref() == "welcome" {
                show_onboarding(app);
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
                    agent_proxy::set_production_launch(
                        root.join("bun"),
                        root.join("agent-runtime").join("main.ts"),
                    );
                    cli_runner::set_production_launch(
                        root.join("bun"),
                        root.join("serve.mjs"),
                        root.join("hyperframes").join("cli.js"),
                    );
                }
            }
            home.set_opener(home_opener(handle.clone()));
            let theme_handle = handle.clone();
            home.set_prefs_listener(std::sync::Arc::new(move |prefs| {
                if let Some(window) = theme_handle.get_webview_window("main") {
                    let _ = window.set_theme(window_theme(prefs));
                }
            }));
            let preferences = prefs::load(&prefs::prefs_path());
            // What opens at launch: a project named on the command line, else
            // the last project when Settings › On launch says so. Marked as
            // opening before the window loads, so the page skips its intro.
            let launch_project = requested_project().or_else(|| {
                prefs::reopen_last(&preferences)
                    .then(|| home.last_project())
                    .flatten()
            });
            if launch_project.is_some() {
                home.set_open_phase(OpenPhase::Opening {
                    label: String::new(),
                });
            }

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
            let mut window = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                .title("OpenVids")
                .inner_size(1600.0, 1000.0)
                .min_inner_size(1100.0, 700.0)
                .theme(window_theme(&preferences));
            // Overlay titlebar (contract 8): the traffic lights float over the
            // pages' own 52 px titlebar at its 20 px inset, vertically centred
            // (AppKit offsets the y inset by its own title-bar metrics: 28
            // puts the 12 px lights at y = 20, measured in the running window).
            // Pages mark drag areas with `data-tauri-drag-region`; the
            // capability grants only window dragging (and double-click zoom).
            #[cfg(target_os = "macos")]
            {
                window = window
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(20.0, 28.0));
            }
            window
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
                // `target="_blank"` links and `window.open` from Studio or
                // the home page (source homepages, license links, provider
                // sign-in pages): never a second app window. A plain https
                // address goes to the default browser, anything else is dropped.
                .on_new_window(|url, _features| {
                    if let Ok(url) = home_api::parse_external_url(url.as_str()) {
                        std::thread::spawn(move || {
                            if let Err(err) = home_api::open_external(&url) {
                                eprintln!("[shell] could not open the browser: {err}");
                            }
                        });
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
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

            #[cfg(target_os = "macos")]
            set_help_menu(&handle);

            if let Some(dir) = launch_project {
                open_project_async(&handle, dir, None);
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
                agent_proxy::shutdown();
                chrome_install::shutdown();
                ffmpeg_install::shutdown();
            }
        });
}

/// Open a project off the setup path, reporting failure to the log.
/// The sidecar start blocks on a port handshake and a readiness poll, so it
/// runs on a blocking worker rather than the async runtime's event loop.
/// The home page's loading overlay polls `/api/open-state` while this runs;
/// failures there surface as an inline toast, not a stuck spinner.
fn open_project_async(app: &tauri::AppHandle, dir: PathBuf, workspace: Option<String>) {
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
        match open_project(&handle, dir, workspace) {
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

fn home_opener(app: tauri::AppHandle) -> home_routes::Opener {
    std::sync::Arc::new(move |dir, workspace| open_project_async(&app, dir, workspace))
}

/// The native window theme for the preferences: fixed for Dark / Light,
/// following macOS for Match system.
fn window_theme(preferences: &serde_json::Value) -> Option<tauri::Theme> {
    match prefs::theme(preferences) {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    }
}

/// `dark` or `light` for Studio's first paint (`openvidsTheme`): the
/// preference, or for Match system the appearance macOS reports now.
fn resolved_theme(app: &tauri::AppHandle) -> &'static str {
    match prefs::theme(&prefs::load(&prefs::prefs_path())) {
        "light" => "light",
        "dark" => "dark",
        _ => match app.get_webview_window("main").map(|w| w.theme()) {
            Some(Ok(tauri::Theme::Light)) => "light",
            _ => "dark",
        },
    }
}

/// Whether the main window currently shows the Projects page.
fn window_is_on_home(app: &tauri::AppHandle) -> bool {
    let home = {
        let app_state = app.state::<Mutex<AppState>>();
        let Ok(state) = app_state.lock() else {
            return false;
        };
        state.home_origin.clone()
    };
    app.get_webview_window("main")
        .and_then(|w| w.url().ok())
        .map(|url| normalize_origin(&url) == home)
        .unwrap_or(false)
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

/// Help › Welcome to OpenVids…: open the first-run onboarding on the Projects
/// page.
///
/// - On the Projects page: the page's own script opens it
///   (`window.ovHome.openOnboarding()`), handed over by `eval` exactly like
///   ⌘O hands `openProject()` to the page.
/// - Showing a project: the window goes back to the Projects page (the same
///   navigation Show All Projects does, with the same cleanup) and the next
///   load of that page opens the onboarding: the request is stored in the home
///   state and handed to the page in its boot state (`OV_BOOT.openOnboarding`,
///   read once). Nothing is evaluated into a page that is still loading.
fn show_onboarding(app: &tauri::AppHandle) {
    if window_is_on_home(app) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(
                "window.ovHome && window.ovHome.openOnboarding && window.ovHome.openOnboarding()",
            );
        }
        return;
    }
    if let Some(state) = app.try_state::<Mutex<AppState>>() {
        if let Ok(state) = state.lock() {
            state.home.request_onboarding();
        }
    }
    show_home(app);
}

/// Tell macOS which submenu is Help (it adds the menu search field to it).
#[cfg(target_os = "macos")]
fn set_help_menu(app: &tauri::AppHandle) {
    use tauri::menu::MenuItemKind;
    if let Some(MenuItemKind::Submenu(help)) = app.menu().and_then(|menu| menu.get("help")) {
        let _ = help.set_as_help_menu_for_nsapp();
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
            .set_title("Open Project")
            .pick_folder();
        if let Some(dir) = picked {
            open_project_async(&handle, dir, None);
        }
    });
}

#[cfg(test)]
mod back_navigation_tests {
    use super::*;

    #[test]
    fn studio_url_carries_home_theme_and_workspace_before_the_hash() {
        let home = "http://127.0.0.1:57035";
        let studio_origin = "http://127.0.0.1:5210";
        assert_eq!(
            sidecar::studio_url(studio_origin, "my video", home, "dark", None),
            "http://127.0.0.1:5210/?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&openvidsTheme=dark#project/my%20video"
        );
        assert_eq!(
            sidecar::studio_url(studio_origin, "v", home, "light", Some("media")),
            "http://127.0.0.1:5210/?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&openvidsTheme=light&openvidsWorkspace=media#project/v"
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
