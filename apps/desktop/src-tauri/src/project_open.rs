//! Opening a project: start its Studio server, give it a page and commit it to
//! the app state.
//!
//! The embedded server is single-project by construction — `createStudioServer`
//! takes one `projectDir` — so every open project has a sidecar of its own, on
//! its own loopback origin. The page is a child webview next to the others and
//! nothing else is touched; the home server keeps serving the Projects page.
//!
//! `AppState` is locked only for short reads and the final commit, never
//! across the start of the new server (see `tabs::Tabs::begin`).

use std::path::Path;
use std::sync::Mutex;

use tauri::Manager;

use super::coded_error::CodedError;
use super::tab_webviews::{self, ChildSpec};
use super::tabs::{DesignRequest, OpenProject, SOFT_LIMIT};
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
    design: Option<sidecar::DesignIntent>,
) -> Result<Option<String>, CodedError> {
    let key = recents::project_key(&dir);
    let mut began: Option<u64> = None;
    let result = open_inner(app, &key, &dir, workspace, design, &mut began);
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
    design: Option<sidecar::DesignIntent>,
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

    let (mode, home_origin, home_link, existing, tab_count, clashes) = {
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
            state.home_origin.clone(),
            state.home.link(),
            existing,
            state.tabs.tab_count(),
            state.tabs.name_taken_by_other(key, &project.id),
        )
    };
    match existing {
        Existing::Open => {
            // Reopening focuses the tab it already has; a design-system
            // creation asked for by the same open then starts in that page.
            tab_actions::activate(app, key)
                .map_err(|_| CodedError::plain("tab_unknown", "that tab is not open"))?;
            if let Some(design) = design {
                apply_design(app, key, design);
            }
            clear_phase(app, key);
            return Ok(None);
        }
        Existing::Starting => {
            // The open under way shows the project; the intent joins it at its commit.
            if let Some(design) = design {
                apply_design(app, key, design);
            }
            return Ok(None);
        }
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
    // Everything that can fail before anything is replaced is resolved first,
    // so such a failure leaves the window as it was.
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

    let begun = {
        let mut state = app_state.lock().map_err(|_| poisoned())?;
        // The checks above ran under another lock, with a native dialog and a
        // runtime lookup in between: another open of this project may have
        // begun, or finished, meanwhile. It owns the tab; this one has nothing
        // left to do (a finished one still wants focusing).
        if state.tabs.has(key) {
            Err(state.tabs.open_project(key).is_some())
        } else {
            let generation = state.tabs.begin(key, &project.id);
            tab_actions::publish_state(&state);
            Ok(generation)
        }
    };
    let generation = match begun {
        Ok(generation) => generation,
        Err(already_open) => {
            if already_open {
                let _ = tab_actions::activate(app, key);
                clear_phase(app, key);
            }
            if let Some(design) = design {
                apply_design(app, key, design);
            }
            return Ok(None);
        }
    };
    *began = Some(generation);
    // The opening tab shows in the strips.
    tab_webviews::notify_tabs_changed(app);

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
        key,
    );
    // The address the page is restored to when a foreign document takes it over:
    // without the open intent, which would otherwise be replayed.
    let base_target = target.clone();
    // The open intent (`openvidsDesign=create`, with its source) joins the query, after the channel.
    let target = sidecar::with_design_intent(target, design);
    // The project's page is its own webview, created now so a failed creation
    // still leaves the state untouched. It comes up on top and shown; the
    // others are hidden once the project is committed.
    let url = target.parse::<tauri::Url>().map_err(|e| {
        CodedError::new(
            "invalid_url",
            format!("built an invalid URL {target:?}: {e}"),
            serde_json::json!({ "url": target, "detail": e.to_string() }),
        )
    })?;
    let label = tab_webviews::child_label(key, generation);
    tab_webviews::create_child(
        app,
        ChildSpec {
            key: key.to_string(),
            label: label.clone(),
            url,
            origin: studio_origin.clone(),
            home_origin,
            background: super::window_background(app),
        },
    )?;

    let open = OpenProject {
        project: project.clone(),
        origin: studio_origin,
        url: base_target.clone(),
        _studio: studio,
        label: label.clone(),
    };
    let committed = {
        let mut state = app_state.lock().map_err(|_| poisoned())?;
        match state.tabs.commit(key, generation, open) {
            Ok(replaced) => {
                state.home.record_open(&project.dir);
                let _ = state.tabs.activate(key);
                // An intent that arrived while the server started.
                let pending = state.tabs.take_pending_design(key);
                tab_actions::publish_state(&state);
                Ok((replaced, pending))
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
        Ok(committed) => committed,
        Err(open) => {
            // A newer open of this project owns it now, or its tab was closed:
            // this one's page and server go.
            tab_webviews::close_child(app, &open.label);
            drop(open);
            return Ok(None);
        }
    };
    let (replaced, pending_design) = replaced;
    drop(replaced);

    tab_webviews::show(app, Some(&label));
    tab_webviews::notify_tabs_changed(app);
    if let Some(design) = pending_design {
        navigate_child(app, &label, &sidecar::with_design_intent(base_target, Some(design)));
    }
    // A fresh composition has no cached thumbnail yet. Refresh it in the
    // background once the Studio server answers, then cache the bytes the
    // home page serves. Best-effort: failures just keep the placeholder.
    thumbnails::refresh_thumbnail_async(app, project.dir.clone(), project.id.clone());
    Ok(Some(target))
}

/// An open intent for a project that already has a tab: an open tab's page is
/// navigated to the intent's address (Studio reads and strips it), a starting
/// one remembers it for its commit (`Tabs::request_design`). The state is
/// locked for the bookkeeping only; the navigation runs after.
fn apply_design(app: &tauri::AppHandle, key: &str, design: sidecar::DesignIntent) {
    let request = app.try_state::<Mutex<AppState>>().and_then(|state| {
        state
            .lock()
            .ok()
            .map(|mut state| state.tabs.request_design(key, design))
    });
    if let Some(DesignRequest::Navigate { label, url }) = request {
        navigate_child(app, &label, &url);
    }
}

/// Take a project's page to `url`; a failure only costs the intent (the page stays as it is).
fn navigate_child(app: &tauri::AppHandle, label: &str, url: &str) {
    let Ok(address) = url.parse::<tauri::Url>() else {
        super::log_line(&format!("could not build the project page's address {url:?}"));
        return;
    };
    if let Some(webview) = app.get_webview(label) {
        if let Err(error) = webview.navigate(address) {
            super::log_line(&format!("could not start the design flow in the project's page: {error}"));
        }
    }
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
/// again; the Projects tab is shown so the failure is seen (an open started
/// from a Studio menu would otherwise fail unseen). `false` when a newer open
/// of the project took over meanwhile and owns the phase.
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
    let owned = {
        let Ok(mut state) = state.lock() else {
            return true;
        };
        let outcome = state.tabs.fail(key, began);
        let owned = state.home.open_failed(key, &outcome, label, error);
        tab_actions::publish_state(&state);
        owned
    };
    if !owned {
        return false;
    }
    tab_webviews::notify_tabs_changed(app);
    let _ = tab_actions::activate(app, super::tabs::HOME);
    true
}
