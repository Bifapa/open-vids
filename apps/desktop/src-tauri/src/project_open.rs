//! Opening a project: start its Studio server, give it a page and commit it to
//! the app state.
//!
//! The embedded server is single-project by construction — `createStudioServer`
//! takes one `projectDir` — so every open project has a sidecar of its own, on
//! its own loopback origin. With project tabs (`AppState::multi`) the page is a
//! child webview next to the others and nothing else is touched; without them
//! the window shows one project at a time, and opening another stops the first
//! (which also stops the previous process group's Chrome instances from
//! lingering). The home server is untouched either way: it keeps serving the
//! Projects page for the way back.
//!
//! `AppState` is locked only for short reads and the final commit, never
//! across the teardown of a previous server or the start of the new one (see
//! `tabs::OpenGate`).

use std::path::Path;
use std::sync::Mutex;

use tauri::Manager;

use super::coded_error::CodedError;
use super::home_routes::OpenPhase;
use super::tab_webviews::{self, ChildSpec};
use super::tabs::{OpenProject, Surface, SOFT_LIMIT};
use super::{
    channel, logfile, platform, prefs, recents, resource_root, sidecar, structure, tab_actions,
    thumbnails, window_frame, AppState, Mode,
};

/// What an open of a project that already has a tab does.
enum Existing {
    /// Nothing yet: a new open.
    No,
    /// Its server is up: the open is just a focus of that tab.
    Open,
    /// Its server is still starting: the open under way finishes the job.
    Starting,
}

/// Bring the window to a project. `Ok(None)` means nothing was left to show:
/// the project's tab was only focused, a newer open of it took over, or the
/// user declined to open another past the soft limit. Every failure is
/// published for the Projects page (the project's open phase) before it is
/// returned.
pub fn open_project(
    app: &tauri::AppHandle,
    dir: std::path::PathBuf,
    workspace: Option<String>,
) -> Result<Option<String>, CodedError> {
    let key = recents::project_key(&dir);
    let mut began: Option<u64> = None;
    let result = open_inner(app, &key, &dir, workspace, &mut began);
    match result {
        Err(error) => {
            if fail_open(app, &key, began, &super::open_label(&dir), &error) {
                Err(error)
            } else {
                // A newer open owns the phase now.
                Ok(None)
            }
        }
        ok => ok,
    }
}

fn open_inner(
    app: &tauri::AppHandle,
    key: &str,
    dir: &Path,
    workspace: Option<String>,
    began: &mut Option<u64>,
) -> Result<Option<String>, CodedError> {
    let project = structure::validate_structure(dir).map_err(|e| e.coded())?;
    // Resolved before locking the state: the window lookup may need the
    // main thread. The raw `language` preference goes along so Studio can
    // pick the language before preferences load (it resolves `system` itself).
    let theme = super::resolved_theme(app);
    let language = prefs::language(&prefs::load(&prefs::prefs_path())).to_string();
    let poisoned = || CodedError::plain("app_state_poisoned", "app state is poisoned");
    let app_state = app.state::<Mutex<AppState>>();

    let (mode, multi, home_origin, home_link, existing, tab_count, clashes) = {
        let state = app_state.lock().map_err(|_| poisoned())?;
        let existing = if state.tabs.open_project(key).is_some() {
            Existing::Open
        } else if state.tabs.is_opening(key) {
            Existing::Starting
        } else {
            Existing::No
        };
        (
            state.mode,
            state.multi,
            state.home_origin.clone(),
            state.home.link(),
            existing,
            state.tabs.tab_count(),
            state.tabs.name_taken_by_other(key, &project.id),
        )
    };
    if multi {
        match existing {
            Existing::Open => {
                // Reopening focuses the tab it already has.
                tab_actions::activate(app, key)
                    .map_err(|_| CodedError::plain("tab_unknown", "that tab is not open"))?;
                clear_phase(app, key);
                return Ok(None);
            }
            Existing::Starting => return Ok(None),
            Existing::No => {}
        }
        // Each open project runs its own server, Chrome and agent runtime.
        if tab_count >= SOFT_LIMIT && !tab_actions::confirm_open_beyond_limit(tab_count) {
            clear_phase(app, key);
            return Ok(None);
        }
        // Dev serves every project from one Vite server by symlinked folder
        // name: two folders of the same name would show one project twice.
        if mode == Mode::Dev && clashes {
            return Err(CodedError::new(
                "project_name_clash",
                format!("another open project is also called {:?}", project.id),
                serde_json::json!({ "name": project.id }),
            ));
        }
    }
    // Everything that can fail before anything is replaced is resolved first,
    // so such a failure leaves the window on a working project.
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
        // Without tabs the window shows one project: the previous server goes
        // first (the new one must be able to bind, and the old Chrome
        // instances must go with it). The home server stays up.
        let previous = if multi { Vec::new() } else { state.tabs.take_all() };
        let generation = state.tabs.begin(key, &project.id);
        tab_actions::publish_state(&state);
        (generation, previous)
    };
    *began = Some(generation);
    // The opening tab shows in the strips.
    if multi {
        tab_webviews::notify_tabs_changed(app);
    }
    // The teardown waits out the SIGTERM grace: not under the lock.
    drop(previous);

    let (studio_origin, studio) = match (mode, production) {
        (Mode::Prod, Some((launcher, bun, cli))) => {
            let logger: std::sync::Arc<dyn Fn(&str) + Send + Sync> =
                std::sync::Arc::new(|line| {
                    eprintln!("{line}");
                    logfile::sidecar(line);
                });
            let started = sidecar::start(&launcher, &bun, &cli, &project.dir, &home_link, logger)
                .map_err(|error| error.coded())?;
            (started.origin(), Some(started))
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
            super::register_dev_project(&projects_dir, &project.dir, &project.id).map_err(|e| {
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
        channel::beta_features_enabled(),
        multi.then_some(key),
    );
    // With tabs the project's page is its own webview, created now so a failed
    // creation still leaves the state untouched. It comes up on top and shown;
    // the others are hidden once the project is committed.
    let surface = if multi {
        let url = target.parse::<tauri::Url>().map_err(|e| {
            CodedError::new(
                "invalid_url",
                format!("built an invalid URL {target:?}: {e}"),
                serde_json::json!({ "url": target, "detail": e.to_string() }),
            )
        })?;
        tab_webviews::create_child(
            app,
            ChildSpec {
                key: key.to_string(),
                url,
                origin: studio_origin.clone(),
                home_origin,
                background: super::window_background(app),
            },
        )?;
        Surface::Child(tab_webviews::child_label(key))
    } else {
        Surface::Main
    };

    let open = OpenProject {
        project: project.clone(),
        origin: studio_origin,
        url: target.clone(),
        _studio: studio,
        surface: surface.clone(),
    };
    let committed = {
        let mut state = app_state.lock().map_err(|_| poisoned())?;
        match state.tabs.commit(key, generation, open) {
            Ok(replaced) => {
                state.home.record_open(&project.dir);
                if multi {
                    let _ = state.tabs.activate(key);
                }
                tab_actions::publish_state(&state);
                Ok(replaced)
            }
            Err(open) => {
                if !state.tabs.has(key) {
                    // Its tab was closed while the server started: nothing owns the phase.
                    state.home.clear_open(key);
                }
                Err(open)
            }
        }
    };
    let replaced = match committed {
        Ok(replaced) => replaced,
        Err(open) => {
            // A newer open of this project owns it now, or its tab was closed:
            // this one's page and server go.
            if let Surface::Child(label) = &open.surface {
                tab_webviews::close_child(app, label);
            }
            drop(open);
            return Ok(None);
        }
    };
    drop(replaced);

    match &surface {
        Surface::Child(label) => {
            tab_webviews::show(app, Some(label));
            tab_webviews::notify_tabs_changed(app);
        }
        Surface::Main => {
            let url = target.parse::<tauri::Url>().map_err(|e| {
                CodedError::new(
                    "invalid_url",
                    format!("built an invalid URL {target:?}: {e}"),
                    serde_json::json!({ "url": target, "detail": e.to_string() }),
                )
            })?;
            main_webview_navigate(app, url)?;
        }
    }
    // A fresh composition has no cached thumbnail yet. Refresh it in the
    // background once the Studio server answers, then cache the bytes the
    // home page serves. Best-effort: failures just keep the placeholder.
    thumbnails::refresh_thumbnail_async(app, project.dir.clone(), project.id.clone());
    Ok(Some(target))
}

fn main_webview_navigate(app: &tauri::AppHandle, url: tauri::Url) -> Result<(), CodedError> {
    tab_webviews::main_webview(app)
        .ok_or_else(|| CodedError::plain("main_window_gone", "the main window is gone"))?
        .navigate(url)
        .map_err(|e| {
            CodedError::new(
                "navigate_failed",
                e.to_string(),
                serde_json::json!({ "detail": e.to_string() }),
            )
        })
}

/// The open of `key` is over without anything to report.
fn clear_phase(app: &tauri::AppHandle, key: &str) {
    if let Some(state) = app.try_state::<Mutex<AppState>>() {
        if let Ok(state) = state.lock() {
            state.home.clear_open(key);
        }
    }
}

/// An open failed: its tab goes (a project that was already open keeps its
/// own), and the failure is published for the Projects page, before it can load
/// again. Without tabs the previous project is already gone, so the window
/// would stay on a dead backend: it goes back to the Projects page, which shows
/// the failure. `false` when a newer open of the project took over meanwhile and
/// owns the phase.
fn fail_open(
    app: &tauri::AppHandle,
    key: &str,
    began: Option<u64>,
    label: &str,
    error: &CodedError,
) -> bool {
    let Some(state) = app.try_state::<Mutex<AppState>>() else {
        return true;
    };
    let multi = {
        let Ok(mut state) = state.lock() else {
            return true;
        };
        if let Some(generation) = began {
            if !state.tabs.is_current(key, generation) {
                return false;
            }
            state.tabs.abandon(key, generation);
        }
        state.home.set_open_phase(
            key,
            OpenPhase::Failed {
                label: label.to_string(),
                error: error.clone(),
            },
        );
        tab_actions::publish_state(&state);
        state.multi
    };
    if multi {
        tab_webviews::notify_tabs_changed(app);
    } else if !super::window_is_on_home(app) {
        super::show_home(app);
    }
    true
}
