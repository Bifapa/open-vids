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
//! origins as far as Tauri is concerned) window dragging, the double-click
//! zoom and — on Windows, where the pages draw their own caption buttons —
//! minimize / toggle-maximize / close plus reading the maximized state, for
//! their `data-tauri-drag-region` titlebars. On macOS the overlay title bar
//! keeps the native traffic lights, so only dragging and the double-click
//! zoom are granted meaningfully there, but the one capability file covers
//! both platforms. Every file read, write, upload and delete goes through
//! the home or Studio HTTP API, which run with full OS access, so the webview
//! needs no filesystem, shell or process capability.

mod agent_proxy;
mod chrome_install;
mod cli_runner;
mod coded_error;
mod create;
mod drop_paths;
mod ffmpeg_install;
mod home;
mod home_agent;
mod home_api;
mod home_auth;
mod home_create;
mod home_project;
mod home_report;
mod home_research;
mod home_routes;
mod home_system;
mod home_update;
mod i18n;
mod install_job;
mod intake;
mod locales;
mod logfile;
mod platform;
mod prefs;
mod proc;
mod project;
mod project_meta;
mod recents;
mod report;
mod research_policy;
mod shell_links;
mod sidecar;
mod structure;
mod telemetry;
mod thumbnails;
mod updater;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use coded_error::CodedError;
use home::HomeServer;
use home_routes::OpenPhase;
use project::Project;
use sidecar::StudioServer;

/// The files that make up the bundled runtime. A directory holding all of them
/// is the payload root, wherever the app is installed. The bun entry follows
/// `platform::BUN_BIN` (`bun.exe` on Windows, `bun` elsewhere), matching what
/// `stage-runtime.mjs` stages and `tauri.prod*.conf.json` bundles.
const PAYLOAD: [&str; 3] = [platform::BUN_BIN, "serve.mjs", "hyperframes/cli.js"];

/// Which backend the window is pointed at.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Studio's Vite dev server, started by `beforeDevCommand`.
    Dev,
    /// The bundled sidecar's embedded server.
    Prod,
}

/// Bookkeeping for opening projects without holding `AppState` across the
/// slow part. A sidecar start waits on a port handshake and a readiness poll
/// (up to about 105 s) and a teardown waits out a SIGTERM grace; neither may
/// run under the lock the main-thread hooks (navigation, menus, quit) take.
/// An open therefore takes the previous server out, releases the lock, starts
/// the replacement, and commits only if no newer open began meanwhile.
#[derive(Debug, Default)]
struct OpenGate {
    generation: u64,
    /// The window has navigated to the committed Studio origin, so a
    /// navigation back to the home origin really leaves a project. Before
    /// that (the committed server is not on screen yet) a home navigation
    /// is a reload of the Projects page, not a close.
    studio_shown: bool,
}

impl OpenGate {
    /// A new open supersedes every open still in flight.
    fn begin(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }

    /// Drop every open still in flight: none of them is current any more.
    fn cancel_in_flight(&mut self) {
        self.generation += 1;
    }

    /// The window navigated to the committed Studio server.
    fn studio_navigated(&mut self) {
        self.studio_shown = true;
    }

    /// The window navigated to the home origin: whether that closes the
    /// project on screen (and so the server must go). A home navigation that
    /// is only a reload, or lands before the window ever showed the new
    /// server, closes nothing.
    fn home_navigated(&mut self) -> bool {
        std::mem::take(&mut self.studio_shown)
    }

    /// The server was taken out of the state for teardown.
    fn released(&mut self) {
        self.studio_shown = false;
    }
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
    gate: OpenGate,
}

impl AppState {
    /// Forget the open project and take its server out for teardown. The
    /// caller drops the server after releasing the lock: the teardown waits
    /// out the SIGTERM grace.
    fn release_studio(&mut self) -> Option<StudioServer> {
        self.project = None;
        self.studio_origin = None;
        self.home.clear_current();
        self.home.set_studio_origin(None);
        self.gate.released();
        self.studio.take()
    }

    /// Quit and update teardown: every open still starting its server is
    /// dropped (its server is terminated, the window is not navigated) and the
    /// Projects page stops showing "opening" for it.
    fn cancel_opens(&mut self) {
        self.gate.cancel_in_flight();
        self.home.set_open_phase(OpenPhase::Idle);
    }

    /// A navigation of the main window to the home origin: closes the open
    /// project only when the window was really showing it (see `OpenGate`).
    fn close_after_home_navigation(&mut self) -> Option<StudioServer> {
        if self.gate.home_navigated() {
            self.release_studio()
        } else {
            None
        }
    }

    /// A navigation of the main window to `origin` (`normalize_origin`).
    fn navigated(&mut self, origin: &str) -> Option<StudioServer> {
        if origin == self.home_origin {
            return self.close_after_home_navigation();
        }
        if self.studio_origin.as_deref() == Some(origin) {
            self.gate.studio_navigated();
        }
        None
    }
}

fn log_line(message: &str) {
    eprintln!("[openvids] {message}");
    logfile::shell(message);
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
///
/// `AppState` is locked only for short reads and the final commit, never
/// across the teardown of the previous server or the start of the new one
/// (see `OpenGate`). `Ok(None)` means a newer open took over while this one
/// started: its server was dropped and the window was left to the newer open.
fn open_project(
    app: &tauri::AppHandle,
    dir: PathBuf,
    workspace: Option<String>,
) -> Result<Option<String>, CodedError> {
    let project = structure::validate_structure(&dir).map_err(|e| e.coded())?;
    // Resolved before locking the state: the window lookup may need the
    // main thread. The raw `language` preference goes along so Studio can
    // pick the language before preferences load (it resolves `system` itself).
    let theme = resolved_theme(app);
    let language = prefs::language(&prefs::load(&prefs::prefs_path())).to_string();
    let poisoned = || CodedError::plain("app_state_poisoned", "app state is poisoned");
    let app_state = app.state::<Mutex<AppState>>();

    let (mode, home_origin) = {
        let state = app_state.lock().map_err(|_| poisoned())?;
        (state.mode, state.home_origin.clone())
    };
    // Everything that can fail before the old server goes away is resolved
    // first, so such a failure leaves the window on a working project.
    let production = match mode {
        Mode::Dev => None,
        Mode::Prod => {
            let root = resource_root(app)?;
            Some((
                root.join("serve.mjs"),
                root.join(platform::BUN_BIN),
                root.join("hyperframes").join("cli.js"),
            ))
        }
    };

    let (generation, previous) = {
        let mut state = app_state.lock().map_err(|_| poisoned())?;
        let generation = state.gate.begin();
        // Drop the previous server first: the new one must be able to
        // bind, and the old Chrome instances must go with it.
        // The home server stays up — only the Studio sidecar restarts.
        let previous = match mode {
            Mode::Dev => None,
            Mode::Prod => state.release_studio(),
        };
        (generation, previous)
    };
    // The teardown waits out the SIGTERM grace: not under the lock.
    drop(previous);

    let (studio_origin, studio) = match (mode, production) {
        (Mode::Prod, Some((launcher, bun, cli))) => {
            let logger: std::sync::Arc<dyn Fn(&str) + Send + Sync> =
                std::sync::Arc::new(|line| {
                    eprintln!("{line}");
                    logfile::sidecar(line);
                });
            match sidecar::start(&launcher, &bun, &cli, &project.dir, logger) {
                Ok(started) => (started.origin(), Some(started)),
                Err(error) => {
                    // The previous project is already gone, so the window
                    // would stay on a dead backend; show the failure on the
                    // Projects page instead.
                    let error = error.coded();
                    let current = app_state
                        .lock()
                        .map(|state| state.gate.is_current(generation))
                        .unwrap_or(true);
                    if !current {
                        // A newer open owns the window and the phase now.
                        return Ok(None);
                    }
                    abandon_open(app, &dir, &error);
                    return Err(error);
                }
            }
        }
        _ => {
            let state = app_state.lock().map_err(|_| poisoned())?;
            let origin = state
                .dev_origin
                .clone()
                .ok_or_else(|| CodedError::plain("dev_origin_unknown", "the dev server origin is unknown"))?;
            let projects_dir = state.dev_projects_dir.clone().ok_or_else(|| {
                CodedError::plain("dev_projects_unknown", "the dev projects directory is unknown")
            })?;
            drop(state);
            register_dev_project(&projects_dir, &project.dir, &project.id).map_err(|e| {
                CodedError::new(
                    "project_register_failed",
                    format!("could not register the project: {e}"),
                    serde_json::json!({ "detail": e.to_string() }),
                )
            })?;
            (origin, None)
        }
    };

    let target = sidecar::studio_url(
        &studio_origin,
        &project.id,
        &home_origin,
        theme,
        &language,
        workspace.as_deref(),
        window_frame(),
    );
    let replaced = {
        let mut state = app_state.lock().map_err(|_| poisoned())?;
        if !state.gate.is_current(generation) {
            // A newer open owns the window and the phase now.
            drop(state);
            drop(studio);
            return Ok(None);
        }
        state.project = Some(project.clone());
        state.studio_origin = Some(studio_origin.clone());
        let replaced = std::mem::replace(&mut state.studio, studio);
        state.home.record_open(&project.id, &project.dir);
        state.home.set_open_phase(OpenPhase::Idle);
        state.home.set_studio_origin(Some(studio_origin));
        replaced
    };
    drop(replaced);

    app.get_webview_window("main")
        .ok_or_else(|| CodedError::plain("main_window_gone", "the main window is gone"))?
        .navigate(target.parse::<tauri::Url>().map_err(|e| {
            CodedError::new(
                "invalid_url",
                format!("built an invalid URL {target:?}: {e}"),
                serde_json::json!({ "url": target, "detail": e.to_string() }),
            )
        })?)
        .map_err(|e| {
            CodedError::new(
                "navigate_failed",
                e.to_string(),
                serde_json::json!({ "detail": e.to_string() }),
            )
        })?;
    // A fresh composition has no cached thumbnail yet. Refresh it in the
    // background once the Studio server answers, then cache the bytes the
    // home page serves. Best-effort: failures just keep the placeholder.
    thumbnails::refresh_thumbnail_async(app, project.dir.clone(), project.id.clone());
    Ok(Some(target))
}

/// An open failed after the previous project's server was already stopped:
/// publish the failure for the Projects page and take the window there, so it
/// does not stay on a Studio page with no backend behind it. The failure is
/// published first, so the page it loads already shows it.
fn abandon_open(app: &tauri::AppHandle, dir: &Path, error: &CodedError) {
    if let Some(state) = app.try_state::<Mutex<AppState>>() {
        if let Ok(state) = state.lock() {
            state.home.set_open_phase(OpenPhase::Failed {
                label: open_label(dir),
                error: error.clone(),
            });
        }
    }
    if !window_is_on_home(app) {
        show_home(app);
    }
}

/// The Studio server origin the window shows, if a project is open.
fn studio_origin(app: &tauri::AppHandle) -> Option<String> {
    app.try_state::<Mutex<AppState>>()?
        .lock()
        .ok()?
        .studio_origin
        .clone()
}

/// The origins whose pages may start a download: the Projects page and the
/// Studio server the window shows.
fn trusted_origins(app: &tauri::AppHandle) -> Vec<String> {
    let Some(state) = app.try_state::<Mutex<AppState>>() else {
        return Vec::new();
    };
    let Ok(state) = state.lock() else {
        return Vec::new();
    };
    let mut origins = vec![state.home_origin.clone()];
    origins.extend(state.studio_origin.clone());
    origins
}

/// The name an open shows while it runs and when it fails.
fn open_label(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.display().to_string())
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
fn resource_root(app: &tauri::AppHandle) -> Result<PathBuf, CodedError> {
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
            // Tauri hands Windows paths over as `\\?\C:\…`; the JS runtimes
            // derive `import.meta.url`, `argv` and sibling paths from them.
            return Ok(platform::from_verbatim(root));
        }
    }
    let looked_in = candidates
        .iter()
        .map(|c| c.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(CodedError::new(
        "runtime_not_bundled",
        format!(
            "no bundled Studio runtime (looked for {PAYLOAD:?} in {looked_in}) — rebuild with `bun run desktop:build`"
        ),
        serde_json::json!({ "payload": format!("{PAYLOAD:?}"), "paths": looked_in }),
    ))
}

// ── Menu ─────────────────────────────────────────────────────────────────────

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(
        app,
        "open_project",
        i18n::t("menu.file.openProject"),
        true,
        Some("CmdOrCtrl+O"),
    )?;
    // ⌘⇧O: back to the Projects home screen. Chosen over ⌘⇧H because ⌘H is
    // Hide OpenVids on macOS and a ⇧ variant of it reads as "hide more".
    let home = MenuItem::with_id(
        app,
        "show_home",
        i18n::t("menu.file.showAllProjects"),
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;

    // Next to About, as on macOS: the update itself runs in Rust (`updater`).
    let check_updates = MenuItem::with_id(
        app,
        "check_updates",
        i18n::t("menu.app.checkForUpdates"),
        true,
        None::<&str>,
    )?;
    let edit = Submenu::with_items(
        app,
        i18n::t("menu.edit.title"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&i18n::t("menu.edit.undo")))?,
            &PredefinedMenuItem::redo(app, Some(&i18n::t("menu.edit.redo")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(&i18n::t("menu.edit.cut")))?,
            &PredefinedMenuItem::copy(app, Some(&i18n::t("menu.edit.copy")))?,
            &PredefinedMenuItem::paste(app, Some(&i18n::t("menu.edit.paste")))?,
            &PredefinedMenuItem::select_all(app, Some(&i18n::t("menu.edit.selectAll")))?,
        ],
    )?;

    let reload = MenuItem::with_id(
        app,
        "reload",
        i18n::t("menu.view.reload"),
        true,
        Some("CmdOrCtrl+R"),
    )?;
    let view = Submenu::with_items(app, i18n::t("menu.view.title"), true, &[&reload])?;

    let window = Submenu::with_items(
        app,
        i18n::t("menu.window.title"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&i18n::t("menu.window.minimize")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some(&i18n::t("menu.window.fullScreen")))?,
            &PredefinedMenuItem::close_window(app, Some(&i18n::t("menu.file.closeWindow")))?,
        ],
    )?;

    // Help › Welcome to OpenVids… reopens the first-run onboarding (see
    // `show_onboarding`). The id is what `set_help_menu` finds again in `setup`.
    let welcome = MenuItem::with_id(
        app,
        "welcome",
        i18n::t("menu.help.welcome"),
        true,
        None::<&str>,
    )?;
    // Help › Report a Problem…: the separate, non-blocking report window
    // (`report.rs`). The window itself talks plain HTTP to this app's home
    // server, so the menu only asks for it to be opened.
    let report_problem = MenuItem::with_id(
        app,
        "report_problem",
        i18n::t("menu.help.reportProblem"),
        true,
        None::<&str>,
    )?;

    #[cfg(target_os = "macos")]
    {
        let file = Submenu::with_items(
            app,
            i18n::t("menu.file.title"),
            true,
            &[
                &open,
                &home,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::close_window(app, Some(&i18n::t("menu.file.closeWindow")))?,
                &PredefinedMenuItem::quit(app, Some(&i18n::t("menu.app.quit")))?,
            ],
        )?;
        let about = PredefinedMenuItem::about(
            app,
            Some(&i18n::t("menu.app.about")),
            Some(AboutMetadata {
                name: Some("OpenVids".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                comments: Some(i18n::t("menu.app.aboutComment")),
                website: Some("https://openvids.ai".into()),
                website_label: Some("openvids.ai".into()),
                credits: Some(i18n::t("menu.app.aboutCredits")),
                ..Default::default()
            }),
        )?;
        let help = Submenu::with_id_and_items(
            app,
            "help",
            i18n::t("menu.help.title"),
            true,
            &[&welcome, &report_problem],
        )?;
        let app_menu = Submenu::with_items(
            app,
            i18n::t("menu.app.name"),
            true,
            &[
                &about,
                &check_updates,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some(&i18n::t("menu.app.hide")))?,
                &PredefinedMenuItem::hide_others(app, Some(&i18n::t("menu.app.hideOthers")))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, Some(&i18n::t("menu.app.quit")))?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
    }
    // Windows has no visible menu bar on the custom frame (the window is
    // frameless and muda's Win32 bar would need a caption to sit in), so the
    // native menu exists only for its Ctrl+ accelerators — which Tauri pumps
    // through `TranslateAcceleratorW` even with no bar attached — and as the
    // fallback surface under `OPENVIDS_SYSTEM_FRAME=1`. The OpenVids submenu
    // (Hide / Hide Others) is macOS-only; About / Check updates / Quit move
    // into File / Help the way Windows apps do. macOS keeps its menu above,
    // byte-identical.
    #[cfg(not(target_os = "macos"))]
    {
        let settings = MenuItem::with_id(
            app,
            "open_settings",
            i18n::t("menu.file.settings"),
            true,
            None::<&str>,
        )?;
        let file = Submenu::with_items(
            app,
            i18n::t("menu.file.title"),
            true,
            &[
                &open,
                &home,
                &settings,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::close_window(app, Some(&i18n::t("menu.file.closeWindow")))?,
                &PredefinedMenuItem::quit(app, Some(&i18n::t("menu.app.quit")))?,
            ],
        )?;
        let file_help_about = PredefinedMenuItem::about(
            app,
            Some(&i18n::t("menu.app.about")),
            Some(AboutMetadata {
                name: Some("OpenVids".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                comments: Some(i18n::t("menu.app.aboutComment")),
                website: Some("https://openvids.ai".into()),
                website_label: Some("openvids.ai".into()),
                credits: Some(i18n::t("menu.app.aboutCredits")),
                ..Default::default()
            }),
        )?;
        let help = Submenu::with_items(
            app,
            i18n::t("menu.help.title"),
            true,
            &[
                &welcome,
                &report_problem,
                &check_updates,
                &PredefinedMenuItem::separator(app)?,
                &file_help_about,
            ],
        )?;
        Menu::with_items(app, &[&file, &edit, &view, &window, &help])
    }
}

/// One app-menu action, shared by the hidden native menu (its accelerators)
/// and the title-bar app menu the pages draw on the Windows custom frame
/// (which reaches Rust through `POST /api/menu/:action`). The pages can only
/// ask for what the native menu already does, so the two cannot drift apart:
/// every new action lands here once, never in two handlers.
///
/// The returned bool says whether the action ran (false only when the
/// window is gone; unknown actions never reach here — the route 404s them).
pub(crate) fn menu_action(app: &tauri::AppHandle, id: &str) -> bool {
    match id {
        "open_project" => {
            // On the Projects page, ⌘O is the page's own Open Project…
            // (its invalid-folder sheet and opening state); the menu
            // accelerator consumes the key, so hand it over by script.
            if window_is_on_home(app) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.ovHome && window.ovHome.openProject()");
                } else {
                    return false;
                }
            } else {
                pick_and_open(app);
            }
        }
        "show_home" => show_home(app),
        "open_settings" => {
            // The in-page Ctrl+, chord is owned by the Projects page (see
            // home.js); in Studio the dialog is native to the page. This
            // menu item is the discoverable fallback for both.
            if window_is_on_home(app) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.ovHome && window.ovHome.openSettings()");
                } else {
                    return false;
                }
            }
        }
        "welcome" => show_onboarding(app),
        "report_problem" => report::open_window("menu"),
        "check_updates" => check_for_updates(app),
        "reload" => {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.reload() {
                    eprintln!("[openvids] could not reload the window: {error}");
                }
            } else {
                return false;
            }
        }
        "quit" => app.exit(0),
        _ => return false,
    }
    true
}

/// The actions the title-bar app menu may ask for (`POST /api/menu/:action`,
/// token-gated like every `/api/` route). About is page-side (the pages read
/// `GET /api/menu/about` and render their own sheet), so it is not
/// dispatched — listing it here would imply a Rust path that does not exist.
pub(crate) const MENU_ACTIONS: [&str; 7] = [
    "open_project",
    "show_home",
    "open_settings",
    "reload",
    "welcome",
    "check_updates",
    "quit",
];

/// Rebuild the native menu in the current language. macOS owns the menu bar
/// app-wide, so `AppHandle::set_menu` (which hops to the main thread) is the
/// right call on every platform; `Window::set_menu` is a documented no-op on
/// macOS. Best-effort: a failed rebuild keeps the previous menu.
fn apply_language(app: &tauri::AppHandle) {
    match build_menu(app) {
        Ok(menu) => {
            if let Err(error) = app.set_menu(menu) {
                log_line(&format!("could not apply the menu language: {error}"));
            }
            // `set_menu` re-attaches the Win32 bar; on the custom frame it
            // has no caption to sit in, so hide it again with `hide_menu`
            // (see the setup block: `remove_menu` would evict the menu from
            // the accelerator map and kill every native chord).
            #[cfg(windows)]
            {
                if window_frame() == "custom" {
                    if let Some(window) = app.get_webview_window("main") {
                        if let Err(error) = window.hide_menu() {
                            eprintln!("[openvids] could not hide the menu bar: {error}");
                        }
                    }
                }
            }
        }
        Err(error) => log_line(&format!("could not rebuild the menu: {error}")),
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        // Rust-only: no capability grants the webview its commands (see `updater`).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            menu_action(app, event.id().as_ref());
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let dev = cfg!(debug_assertions);
            // The persistent log starts first: everything below (and the
            // sidecar and agent runtimes later) writes through it.
            logfile::init(
                handle
                    .path()
                    .app_log_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("openvids-logs")),
            );
            // Every session opens with one line, so a bug report always
            // carries at least the version and platform it came from.
            logfile::shell(&format!(
                "OpenVids {} started ({} {}, {} build)",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH,
                if dev { "debug" } else { "release" }
            ));
            // Windows: finish or undo an FFmpeg install that a crash or a Task Manager kill interrupted, before any
            // sidecar starts. A failure only leaves the leftovers where they are; the next install retries.
            #[cfg(windows)]
            if let Err(error) = ffmpeg_install::recover_managed_install() {
                log_line(&format!("could not recover the FFmpeg install: {error}"));
            }

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
                        root.join(platform::BUN_BIN),
                        root.join("agent-runtime").join("main.ts"),
                    );
                    cli_runner::set_production_launch(
                        root.join(platform::BUN_BIN),
                        root.join("serve.mjs"),
                        root.join("hyperframes").join("cli.js"),
                    );
                }
            }
            home.set_opener(home_opener(handle.clone()));
            updater::init(&handle);
            if !dev {
                updater::schedule_auto_check();
            }
            // Language + theme follower for preference changes. The home page
            // calls this listener on `PUT /api/preferences`; the polling
            // watcher below calls it for Studio-side writes. The last resolved
            // language lives in memory only, so a restart re-reads the file.
            let last_lang = std::sync::Arc::new(Mutex::new(i18n::active().to_string()));
            let prefs_handle = handle.clone();
            let prefs_lang = last_lang.clone();
            home.set_prefs_listener(std::sync::Arc::new(move |prefs| {
                if let Some(window) = prefs_handle.get_webview_window("main") {
                    let _ = window.set_theme(window_theme(prefs));
                }
                paint_window_background(&prefs_handle);
                let code = {
                    let os: Vec<String> = sys_locale::get_locales().collect();
                    i18n::resolve_for_prefs(prefs, &os)
                };
                let mut last = prefs_lang.lock().unwrap_or_else(|e| e.into_inner());
                if *last != code {
                    *last = code;
                    apply_language(&prefs_handle);
                }
            }));
            // Studio writes the same preferences file through its own server,
            // so Rust is never told. Poll the file mtime; on change, re-read
            // and run the same listener the home page path runs — theme and
            // language then follow no matter which page saved. Recoverable by
            // design: a deleted or unreadable file just reads as defaults.
            let watch_handle = handle.clone();
            let watch_lang = last_lang.clone();
            std::thread::spawn(move || {
                let path = prefs::prefs_path();
                let mut known: Option<std::time::SystemTime> = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let current = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
                    if current == known {
                        continue;
                    }
                    known = current;
                    let next = prefs::load(&path);
                    telemetry::preferences_changed(&next);
                    let theme = window_theme(&next);
                    let os: Vec<String> = sys_locale::get_locales().collect();
                    let code = i18n::resolve_for_prefs(&next, &os);
                    let changed = {
                        let mut last = watch_lang.lock().unwrap_or_else(|e| e.into_inner());
                        if *last == code {
                            false
                        } else {
                            *last = code;
                            true
                        }
                    };
                    let moved = watch_handle.clone();
                    let _ = watch_handle.run_on_main_thread(move || {
                        if let Some(window) = moved.get_webview_window("main") {
                            let _ = window.set_theme(theme);
                        }
                        paint_window_background(&moved);
                        if changed {
                            apply_language(&moved);
                        }
                    });
                }
            });
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
                    gate: OpenGate::default(),
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
                    gate: OpenGate::default(),
                }
            };
            state.home_origin = state.home.origin();
            report::init(&handle, &state.home_origin);
            let initial_url = state.home_origin.clone();

            let _ = APP_FOR_HOME_CLEANUP.set(Mutex::new(Some(handle.clone())));

            app.manage(Mutex::new(state));

            let url: tauri::Url = initial_url
                .parse()
                .map_err(|e| format!("invalid window URL {initial_url:?}: {e}"))?;
            let mut window = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                .title("OpenVids")
                .inner_size(1600.0, 1000.0)
                .min_inner_size(1100.0, 700.0)
                .theme(window_theme(&preferences));
            // Overlay titlebar (macOS): the traffic lights float over the
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
            // Windows custom frame (`window_frame() == "custom"`): no system
            // decorations, so the pages' own titlebars (Projects header,
            // Studio header) are the caption, with minimize / maximize /
            // close on the right. `decorations(false)` keeps WS_CAPTION,
            // WS_MINIMIZEBOX, WS_MAXIMIZEBOX and WS_THICKFRAME on the HWND —
            // tao only hides the non-client paint — so edge resizing, the
            // native NCHITTEST border handler (`undecorated_resizing` in
            // tauri-runtime-wry), Win+arrow / screen-edge snap, the taskbar
            // minimize button and double-click-drag-region maximize all keep
            // working; `min_inner_size` above still clamps WM_GETMINMAXINFO.
            // `.shadow(true)` keeps the DWM drop shadow on the borderless
            // window (white 1 px border + rounded corners on Windows 11).
            // Snap Layouts (the hover-over-maximize flyout) belong to the
            // system caption buttons, so the custom buttons cannot show it;
            // Win+arrows and edge snap cover the same layouts, which the
            // issue accepts as enough. `tauri-plugin-decorum` was evaluated
            // and rejected: it injects its own caption overlay sized for a
            // local `tauri://` page and assumes GlobalTauri IPC, neither of
            // which holds for our loopback `http://127.0.0.1` pages with
            // `withGlobalTauri: false`.
            // `OPENVIDS_SYSTEM_FRAME=1` keeps `decorations(true)` as the
            // escape hatch (remote desktop, odd DWM themes): the OS draws
            // its own frame and the pages skip their buttons.
            #[cfg(windows)]
            {
                // Windows cascades a new window from the top-left at the fixed
                // 1600x1000: off-centre, and taller than the screen on a small
                // or high-DPI monitor. Start geometry comes from the primary
                // monitor's work area (the taskbar is already excluded) through
                // `platform::start_window_size` (3:2 at most, 1:1 at least, fixed
                // gaps), and the window is centred in that area. macOS places
                // and sizes its windows itself, unchanged.
                if let Ok(Some(monitor)) = handle.primary_monitor() {
                    let scale = monitor.scale_factor();
                    let area = monitor.work_area();
                    let (area_x, area_y) = (
                        f64::from(area.position.x) / scale,
                        f64::from(area.position.y) / scale,
                    );
                    let (area_w, area_h) = (
                        f64::from(area.size.width) / scale,
                        f64::from(area.size.height) / scale,
                    );
                    let (width, height) = platform::start_window_size(area_w, area_h);
                    window = window
                        .inner_size(width, height)
                        .min_inner_size(width.min(1100.0), height.min(700.0))
                        .position(
                            area_x + (area_w - width) / 2.0,
                            area_y + (area_h - height) / 2.0,
                        );
                } else {
                    window = window.center();
                }
                if window_frame() != "system" {
                    window = window.decorations(false).shadow(true);
                }
            }
            // Start-up flash (Windows): the window used to appear with the
            // native menu bar and a white webview for a few frames before the
            // Projects page painted. Start hidden (Windows only; macOS keeps
            // its behaviour exactly), do the menu/backdrop work below while
            // hidden, then reveal once the first page has loaded — with a
            // 1.5 s guard timer so a failing load can never leave an
            // invisible window. Both paths funnel through `show_main_window`,
            // which also focuses the window and is a no-op once visible.
            #[cfg(windows)]
            {
                window = window.visible(false);
            }
            let page_handle = handle.clone();
            window = window.on_page_load(move |_webview, payload| {
                use tauri::webview::PageLoadEvent;
                match payload.event() {
                    PageLoadEvent::Started => {
                        keep_main_window_on_app_pages(&page_handle, payload.url());
                    }
                    // Start-up flash (Windows): reveal the hidden window once
                    // the first page has loaded.
                    PageLoadEvent::Finished => {
                        #[cfg(windows)]
                        show_main_window(&page_handle);
                    }
                }
            });
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
                // on the navigation callback. Only a navigation away from the
                // Studio the window showed closes it: a reload of the Projects
                // page, or one that lands while an open is still running, does
                // not (`OpenGate`).
                // `target="_blank"` links and `window.open` from Studio or
                // the home page (source homepages, license links, provider
                // sign-in pages, chat Markdown, the render-QA row): never a
                // second app window and never a navigation of this one.
                // `shell_links` decides: web and mail addresses go to the
                // default apps, a render's own link to the Studio server's
                // open-in-player route, anything else is dropped.
                .on_new_window(|url, _features| {
                    let studio = app_handle_for_home_cleanup().and_then(|app| studio_origin(&app));
                    shell_links::run_link_action(shell_links::classify_link(url.as_str(), studio.as_deref()));
                    tauri::webview::NewWindowResponse::Deny
                })
                // Without a download handler the webview cancels every
                // `<a download>` (render Download, frame capture, a conflict
                // version): they save to Downloads and show the file.
                .on_download(|webview, event| match event {
                    tauri::webview::DownloadEvent::Requested { url, destination } => {
                        let origins = trusted_origins(webview.app_handle());
                        shell_links::download_requested(&url, destination, &origins)
                    }
                    tauri::webview::DownloadEvent::Finished { url, path, success } => {
                        shell_links::download_finished(&url, path, success);
                        true
                    }
                    _ => true,
                })
                // No top-level allow-list here, deliberately: wry 0.57's
                // navigation handler receives only the URL string, and on
                // macOS (WKNavigationDelegate) it fires for subframe loads as
                // well as the main frame, with no way to tell them apart. A
                // policy that denies unknown origins would also cancel every
                // external iframe a composition embeds. The top-level check
                // lives in the `on_page_load` hook above, which fires for the
                // main frame only. The webview holds no
                // IPC capability beyond window dragging, so a navigated-away
                // window cannot reach the shell.
                .on_navigation(move |url| {
                    let server = app_handle_for_home_cleanup()
                        .and_then(|app| note_main_navigation(&app, url));
                    if let Some(server) = server {
                        std::thread::spawn(move || drop(server));
                    }
                    true
                })
                .build()?;
            paint_window_background(&handle);
            // Windows custom frame: the app menu stays attached (its Ctrl+
            // accelerators pump through `TranslateAcceleratorW` off the
            // process-wide menu map in Tauri's `msg_hook`, with no bar
            // drawn) but the bar itself has no caption to sit in, so detach
            // it from the HWND with `hide_menu` (`SetMenu(null)` + redraw).
            // `hide_menu` — NOT `remove_menu`: removal also evicts the menu
            // from the map the accelerator hook reads, which would silently
            // kill every native menu chord. Hiding keeps the map, the
            // subclass proc and the accelerator table, so all chords keep
            // firing. Under `OPENVIDS_SYSTEM_FRAME=1` the bar stays: it is
            // the fallback surface.
            #[cfg(windows)]
            {
                if window_frame() == "custom" {
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Err(error) = window.hide_menu() {
                            eprintln!("[openvids] could not hide the menu bar: {error}");
                        }
                    }
                }
            }
            // The guard half of the hidden-start above (Windows only): even if
            // the first page never reports `Finished` (a failing load, a slow
            // loopback bind), the window must become visible — `show` + focus
            // after ~1.5 s, a no-op when the load event already revealed it.
            // Also the `OPENVIDS_SYSTEM_FRAME=1` path: same builder, same flag.
            #[cfg(windows)]
            {
                let guard_handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let moved = guard_handle.clone();
                    let _ = guard_handle.run_on_main_thread(move || {
                        show_main_window(&moved);
                    });
                });
            }
            // Anonymous usage statistics (`telemetry.rs`): off the setup path,
            // and never when the environment or a debug build says so.
            telemetry::start(&handle, dev);

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
            // Windows: closing the main window ends the app, also while the report window is still open (the
            // last-window-closed rule would otherwise leave the process, and the sidecars it owns, running).
            #[cfg(windows)]
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } = &event
            {
                if label == "main" {
                    app.exit(0);
                }
            }
            // `StudioServer::drop` already reaps the process group when the
            // state is dropped; this is the last chance to do it explicitly
            // while the child can still be waited on. The home server drops
            // with the state — it lives until this point, not until a
            // project opens. An update's restart takes this path too.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                // `app_end` goes out while the processes stop; its short
                // budget is all the wait it can add to the quit.
                let end = telemetry::app_end(app);
                stop_owned_processes(app);
                end.wait();
            }
        });
}

/// Stop every process the app owns: the Studio sidecar's group, the
/// project-less agent runtime and running installs. Quitting and installing
/// an update both take this path; calling it twice is harmless. The sidecar
/// is taken out of the state first and reaped without the lock held (its
/// teardown waits out the SIGTERM grace in `sidecar::terminate`).
fn stop_owned_processes(app: &tauri::AppHandle) {
    // Under one lock: an open still starting its sidecar can no longer
    // commit (it terminates what it started), and no server is left behind.
    let studio = app.try_state::<Mutex<AppState>>().and_then(|state| {
        state.lock().ok().and_then(|mut state| {
            state.cancel_opens();
            state.studio.take()
        })
    });
    drop(studio);
    agent_proxy::shutdown();
    chrome_install::shutdown();
    ffmpeg_install::shutdown();
}

/// Before an update replaces the bundle: close the open project the way Show
/// All Projects does (the window goes back to the Projects page, so an
/// install that fails leaves a working window), then stop everything the app
/// owns and wait for it, so nothing keeps running from the old bundle.
pub(crate) fn release_for_update(app: &tauri::AppHandle) {
    let server = take_closed_studio(app);
    if !window_is_on_home(app) {
        show_home(app);
    }
    drop(server);
    stop_owned_processes(app);
}

/// The Studio origin and id of the project the window shows, if any.
pub(crate) fn open_project_scope(app: &tauri::AppHandle) -> Option<(String, String)> {
    let app_state = app.try_state::<Mutex<AppState>>()?;
    let state = app_state.lock().ok()?;
    Some((state.studio_origin.clone()?, state.project.as_ref()?.id.clone()))
}

/// App menu › Check for Updates…: on the Projects page the check runs and
/// Settings › General shows it (handed to the page by `eval`, like ⌘O);
/// with a project open, native dialogs, so the project stays open.
fn check_for_updates(app: &tauri::AppHandle) {
    if window_is_on_home(app) {
        updater::check();
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(
                "window.ovHome && window.ovHome.checkForUpdates && window.ovHome.checkForUpdates()",
            );
        }
    } else {
        updater::menu_check();
    }
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
            state.home.set_open_phase(OpenPhase::Opening {
                label: open_label(&dir),
            });
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let label = open_label(&dir);
        match open_project(&handle, dir, workspace) {
            Ok(Some(url)) => log_line(&format!("opened {url}")),
            Ok(None) => log_line(&format!("opening {label} was superseded by a newer open")),
            Err(err) => {
                log_line(&format!("could not open the project: {err}"));
                if let Some(state) = handle.try_state::<Mutex<AppState>>() {
                    if let Ok(state) = state.lock() {
                        state.home.set_open_phase(OpenPhase::Failed { label, error: err });
                    }
                }
            }
        }
    });
}

fn home_opener(app: tauri::AppHandle) -> home_routes::Opener {
    std::sync::Arc::new(move |dir, workspace| open_project_async(&app, dir, workspace))
}

/// Which titlebar chrome the pages draw: `overlay` (macOS traffic lights),
/// `custom` (Windows frameless: the page draws minimize / maximize / close),
/// `system` (Windows fallback behind `OPENVIDS_SYSTEM_FRAME=1`: the OS draws
/// its own frame and the pages keep only their content, no caption buttons).
///
/// macOS is always `overlay`. On Windows the env var is the escape hatch for
/// a broken custom frame (remote desktop, odd DWM themes): the window keeps
/// `decorations(true)` there and the pages skip their buttons.
pub(crate) fn window_frame() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "overlay"
    }
    #[cfg(windows)]
    {
        if std::env::var_os("OPENVIDS_SYSTEM_FRAME")
            .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true") || v == "yes")
        {
            "system"
        } else {
            "custom"
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        "overlay"
    }
}

#[cfg(test)]
mod window_frame_tests {
    use super::window_frame;

    // The serial lock: these tests mutate the process environment, so they
    // must not run concurrently with each other.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_env(var: &str, value: Option<&str>, check: impl FnOnce()) {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prior = std::env::var_os(var);
        match value {
            Some(v) => std::env::set_var(var, v),
            None => std::env::remove_var(var),
        }
        check();
        match prior {
            Some(v) => std::env::set_var(var, v),
            None => std::env::remove_var(var),
        }
    }

    #[test]
    fn system_frame_fallback_is_opt_in() {
        with_env("OPENVIDS_SYSTEM_FRAME", None, || {
            if cfg!(windows) {
                assert_eq!(window_frame(), "custom");
            } else {
                assert_eq!(window_frame(), "overlay");
            }
        });
        with_env("OPENVIDS_SYSTEM_FRAME", Some("1"), || {
            if cfg!(windows) {
                assert_eq!(window_frame(), "system");
            } else {
                assert_eq!(window_frame(), "overlay");
            }
        });
        with_env("OPENVIDS_SYSTEM_FRAME", Some("true"), || {
            if cfg!(windows) {
                assert_eq!(window_frame(), "system");
            } else {
                assert_eq!(window_frame(), "overlay");
            }
        });
        // An empty or unrelated value is not opt-in.
        with_env("OPENVIDS_SYSTEM_FRAME", Some("0"), || {
            if cfg!(windows) {
                assert_eq!(window_frame(), "custom");
            } else {
                assert_eq!(window_frame(), "overlay");
            }
        });
    }
}

/// The native window theme for the preferences: fixed for Dark / Light,
/// following macOS for Match system. The report window (`report.rs`) uses it
/// too, so every shell window follows the same preference.
pub(crate) fn window_theme(preferences: &serde_json::Value) -> Option<tauri::Theme> {
    match prefs::theme(preferences) {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    }
}

/// `dark` or `light` for Studio's first paint (`openvidsTheme`) and for the
/// report page's boot state: the preference, or for Match system the
/// appearance macOS reports now.
pub(crate) fn resolved_theme(app: &tauri::AppHandle) -> &'static str {
    match prefs::theme(&prefs::load(&prefs::prefs_path())) {
        "light" => "light",
        "dark" => "dark",
        _ => match app.get_webview_window("main").map(|w| w.theme()) {
            Some(Ok(tauri::Theme::Light)) => "light",
            _ => "dark",
        },
    }
}

/// The window and webview backdrop, in the pages' own background colour
/// (`--bg-0` of `ov.css`, `--color-bg-0` of Studio's theme). A webview with no
/// document painted yet shows this instead of white: between the Projects
/// page and a project, and before either page's styles arrive.
fn paint_window_background(app: &tauri::AppHandle) {
    let color = match resolved_theme(app) {
        "light" => tauri::window::Color(252, 252, 253, 255),
        _ => tauri::window::Color(12, 13, 15, 255),
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_background_color(Some(color));
    }
}

/// Reveal the main window once, then give it focus. A no-op when the window
/// is already visible, so the page-load event and the guard timer below can
/// both call it without tracking who won. Windows only (the window starts
/// hidden there); macOS never hides it.
#[cfg(windows)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(true) {
            return;
        }
        let _ = window.show();
        let _ = window.set_focus();
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
                log_line(&format!("could not show the home screen: {error}"));
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

/// The handle `POST /api/menu/:action` dispatches through: the same handle
/// the `on_navigation` cleanup stashes in `setup`, reused so the route and
/// the native menu share one `menu_action` entry point.
pub(crate) fn menu_app() -> Option<tauri::AppHandle> {
    app_handle_for_home_cleanup()
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

/// Whether a top-level page of the main window may stay on screen: the blank
/// document, or a page of one of the app's own servers (Projects, the open
/// project's Studio).
fn top_level_allowed(url: &tauri::Url, trusted_origins: &[String]) -> bool {
    url.as_str() == "about:blank"
        || (url.scheme() == "http" && trusted_origins.contains(&normalize_origin(url)))
}

/// The main window committed a top-level document. A page that took the
/// window over (a composition setting `top.location`) would fill it with no
/// address bar, so anything outside the app's servers sends the window back to
/// the Projects page. Page-load events fire for the top-level document only
/// (WKNavigationDelegate `didCommitNavigation`, WebView2 `ContentLoading`), so
/// the external iframes a composition embeds are not affected, unlike
/// `on_navigation`.
fn keep_main_window_on_app_pages(app: &tauri::AppHandle, url: &tauri::Url) {
    let trusted = trusted_origins(app);
    // No state yet (start-up) says nothing about what is trusted.
    if trusted.is_empty() || top_level_allowed(url, &trusted) {
        return;
    }
    log_line("a page outside the app took over the window, showing the Projects page");
    let app = app.clone();
    std::thread::spawn(move || show_home(&app));
}

/// "Back to projects" for callers that close the project themselves (the
/// update path): forget the open project and hand the old sidecar to the
/// caller for teardown. The window's own navigations go through
/// `AppState::navigated`, which closes only a project the window showed.
fn take_closed_studio(app: &tauri::AppHandle) -> Option<StudioServer> {
    let app_state = app.state::<Mutex<AppState>>();
    let Ok(mut state) = app_state.lock() else {
        return None;
    };
    state.cancel_opens();
    state.release_studio()
}

/// The main window is navigating to `url`: keep the open-project state in
/// step, and return the server a navigation back to the Projects page closes.
fn note_main_navigation(app: &tauri::AppHandle, url: &tauri::Url) -> Option<StudioServer> {
    let state = app.try_state::<Mutex<AppState>>()?;
    let mut state = state.lock().ok()?;
    state.navigated(&normalize_origin(url))
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
            .set_title(i18n::t("dialog.openProject.title"))
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
    fn studio_url_carries_home_theme_language_and_workspace_before_the_hash() {
        let home = "http://127.0.0.1:57035";
        let studio_origin = "http://127.0.0.1:5210";
        assert_eq!(
            sidecar::studio_url(studio_origin, "my video", home, "dark", "system", None, "overlay"),
            "http://127.0.0.1:5210/?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&openvidsTheme=dark&openvidsLanguage=system#project/my%20video"
        );
        assert_eq!(
            sidecar::studio_url(studio_origin, "v", home, "light", "ru", Some("media"), "overlay"),
            "http://127.0.0.1:5210/?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&openvidsTheme=light&openvidsLanguage=ru&openvidsWorkspace=media#project/v"
        );
    }

    #[test]
    fn studio_url_appends_the_frame_hint_for_non_overlay_frames() {
        let home = "http://127.0.0.1:57035";
        let studio_origin = "http://127.0.0.1:5210";
        // macOS overlay: no parameter, links stay as they were.
        assert!(
            !sidecar::studio_url(studio_origin, "v", home, "dark", "system", None, "overlay")
                .contains("openvidsFrame")
        );
        // Windows custom frame: the Studio header draws caption buttons.
        assert_eq!(
            sidecar::studio_url(studio_origin, "v", home, "dark", "system", None, "custom"),
            "http://127.0.0.1:5210/?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&openvidsTheme=dark&openvidsLanguage=system&openvidsFrame=custom#project/v"
        );
        // Windows system-frame fallback: explicit too, so the pages skip
        // their buttons. The workspace still sorts before the frame hint.
        assert_eq!(
            sidecar::studio_url(studio_origin, "v", home, "dark", "system", Some("media"), "system"),
            "http://127.0.0.1:5210/?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&openvidsTheme=dark&openvidsLanguage=system&openvidsWorkspace=media&openvidsFrame=system#project/v"
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

    #[test]
    fn menu_actions_are_exactly_what_the_pages_may_ask_for() {
        // The route 404s anything outside this table, and the native menu
        // only carries these ids: adding an action means adding it here, in
        // `menu_action`, and in both pages' menus — never just one handler.
        assert_eq!(
            MENU_ACTIONS,
            [
                "open_project",
                "show_home",
                "open_settings",
                "reload",
                "welcome",
                "check_updates",
                "quit",
            ]
        );
    }
}

#[cfg(test)]
mod open_gate_tests {
    use super::OpenGate;

    #[test]
    fn a_newer_open_supersedes_the_one_in_flight() {
        let mut gate = OpenGate::default();
        let first = gate.begin();
        assert!(gate.is_current(first));
        let second = gate.begin();
        assert!(!gate.is_current(first), "the first open must not commit over the second");
        assert!(gate.is_current(second));
    }

    #[test]
    fn a_home_navigation_closes_only_a_studio_the_window_showed() {
        let mut gate = OpenGate::default();
        gate.begin();
        // The server is committed but the window has not reached it yet: a
        // reload of the Projects page landing now must not take it.
        assert!(!gate.home_navigated());
        gate.studio_navigated();
        // Back to the Projects page from the shown Studio closes it, once.
        assert!(gate.home_navigated());
        assert!(!gate.home_navigated(), "a second home load (a reload) closes nothing");
    }

    #[test]
    fn a_released_server_is_no_longer_shown() {
        let mut gate = OpenGate::default();
        gate.begin();
        gate.studio_navigated();
        gate.released();
        assert!(!gate.home_navigated());
    }

    #[test]
    fn cancelling_drops_the_open_in_flight_but_not_the_next_one() {
        let mut gate = OpenGate::default();
        let in_flight = gate.begin();
        gate.cancel_in_flight();
        assert!(!gate.is_current(in_flight), "a cancelled open must not commit");
        let next = gate.begin();
        assert!(gate.is_current(next));
    }
}

#[cfg(test)]
mod top_level_tests {
    use super::top_level_allowed;

    fn allowed(raw: &str) -> bool {
        let trusted = vec!["http://127.0.0.1:5210".to_string(), "http://127.0.0.1:5211".to_string()];
        top_level_allowed(&raw.parse().expect("url"), &trusted)
    }

    #[test]
    fn only_the_apps_own_pages_may_fill_the_window() {
        assert!(allowed("http://127.0.0.1:5210/"));
        assert!(allowed("http://127.0.0.1:5211/#/project/p?theme=dark"));
        assert!(allowed("about:blank"));
        for raw in [
            "https://example.com/",
            "http://127.0.0.1:9999/",
            "http://localhost:5210/",
            "https://127.0.0.1:5210/",
            "file:///etc/passwd",
            "data:text/html,hi",
        ] {
            assert!(!allowed(raw), "{raw}");
        }
    }
}
