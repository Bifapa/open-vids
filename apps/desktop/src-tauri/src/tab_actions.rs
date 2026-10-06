//! What activating, closing and cycling project tabs does to the app state
//! and the window's webviews, and the two questions the shell asks first (a
//! busy tab being closed, opening beyond the soft limit).
//!
//! The state is locked only for the bookkeeping. Showing and hiding webviews,
//! the native dialogs and the teardown of a closed project's server all run
//! after the lock is released: a dialog waits on the user and a teardown waits
//! out a SIGTERM grace, while the main-thread hooks (navigation, menus, quit)
//! take the same lock.

use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use super::tab_webviews;
use super::tabs::{ActivateError, CloseOutcome, Surface, TabActions};
use super::updater::Activity;
use super::{i18n, AppState};

/// Hand the home server the tab list and the Studio origins for the pages
/// (what `GET /api/tabs` answers, what Studio's token-less requests are checked
/// against). Called with the state lock held after every change, so the pages
/// never read a list that disagrees with the windows.
pub fn publish_state(state: &AppState) {
    state
        .home
        .publish_tabs(state.tabs.view(state.multi), state.tabs.origins());
}

/// Publish and tell the pages to refetch (tabs mode only: the strips live there).
pub fn publish(app: &AppHandle) {
    let multi = app
        .try_state::<Mutex<AppState>>()
        .and_then(|state| {
            state.lock().ok().map(|state| {
                publish_state(&state);
                state.multi
            })
        })
        .unwrap_or(false);
    if multi {
        tab_webviews::notify_tabs_changed(app);
    }
}

/// Show the Projects page (`HOME`) or the open project `key`.
pub fn activate(app: &AppHandle, key: &str) -> Result<(), ActivateError> {
    let state = app.try_state::<Mutex<AppState>>().ok_or(ActivateError::Unknown)?;
    let label = {
        let mut state = state.lock().map_err(|_| ActivateError::Unknown)?;
        if !state.multi {
            return Err(ActivateError::Unknown);
        }
        state.tabs.activate(key)?;
        let label = state
            .tabs
            .active()
            .and_then(|active| state.tabs.child_label(active))
            .map(str::to_string);
        publish_state(&state);
        label
    };
    tab_webviews::show(app, label.as_deref());
    tab_webviews::notify_tabs_changed(app);
    Ok(())
}

/// Close the tab `key`, asking first when a render or an agent turn is still
/// running in it. Blocks on that question, so never call it on the main thread
/// or under a lock.
pub fn close(app: &AppHandle, key: &str) -> CloseOutcome {
    let Some(state) = app.try_state::<Mutex<AppState>>() else {
        return CloseOutcome::Unknown;
    };
    let scope = {
        let Ok(state) = state.lock() else {
            return CloseOutcome::Unknown;
        };
        if !state.multi || !state.tabs.has(key) {
            return CloseOutcome::Unknown;
        }
        state
            .tabs
            .open_project(key)
            .map(|open| (open.origin.clone(), open.project.id.clone()))
    };
    // A tab still opening has nothing to lose: closing it cancels the open.
    if let Some((origin, id)) = scope {
        let busy = super::updater::activity_of(&origin, &id).filter(Activity::busy);
        if let Some(activity) = busy {
            if !confirm_close_busy(&id, &activity) {
                return CloseOutcome::Cancelled;
            }
        }
    }
    let (closed, active_label) = {
        let Ok(mut state) = state.lock() else {
            return CloseOutcome::Unknown;
        };
        let Some(closed) = state.tabs.close(key) else {
            return CloseOutcome::Unknown;
        };
        let label = state.tabs.child_label(&closed.active).map(str::to_string);
        publish_state(&state);
        (closed, label)
    };
    if let Some(open) = closed.open {
        if let Surface::Child(label) = &open.surface {
            tab_webviews::close_child(app, label);
        }
        // The teardown waits out the SIGTERM grace: off this thread.
        std::thread::spawn(move || drop(open));
    }
    tab_webviews::show(app, active_label.as_deref());
    tab_webviews::notify_tabs_changed(app);
    CloseOutcome::Closed
}

/// ⌘W: close the project tab on screen; on the Projects page it closes the window.
pub fn close_active(app: &AppHandle) {
    let active = app.try_state::<Mutex<AppState>>().and_then(|state| {
        state
            .lock()
            .ok()
            .and_then(|state| state.multi.then(|| state.tabs.active().map(str::to_string)))
    });
    match active {
        Some(Some(key)) => {
            let app = app.clone();
            // The question may be on screen for a while.
            std::thread::spawn(move || {
                close(&app, &key);
            });
        }
        _ => {
            if let Some(window) = tab_webviews::main_window(app) {
                let _ = window.close();
            }
        }
    }
}

/// Ctrl+Tab / Ctrl+Shift+Tab: the next or previous open tab, through the Projects page.
pub fn cycle(app: &AppHandle, forward: bool) {
    let next = app.try_state::<Mutex<AppState>>().and_then(|state| {
        state
            .lock()
            .ok()
            .and_then(|state| state.multi.then(|| state.tabs.cycle(forward)))
    });
    if let Some(next) = next {
        let _ = activate(app, &next);
    }
}

fn confirm_close_busy(name: &str, activity: &Activity) -> bool {
    let close = i18n::t("dialog.tabs.closeBusy.close");
    let message = if activity.agent_turn && activity.renders > 0 {
        "dialog.tabs.closeBusy.messageBoth"
    } else if activity.agent_turn {
        "dialog.tabs.closeBusy.messageTurn"
    } else {
        "dialog.tabs.closeBusy.messageRender"
    };
    let answer = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title(i18n::t("dialog.tabs.closeBusy.title"))
        .set_description(i18n::t_with(message, &[("name", name)]))
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            close.clone(),
            i18n::t("dialog.tabs.closeBusy.cancel"),
        ))
        .show();
    answer == rfd::MessageDialogResult::Custom(close)
}

/// Opening beyond the soft limit: every project brings its own editor server,
/// Chrome and agent runtime, so ask before the next one.
pub fn confirm_open_beyond_limit(open: usize) -> bool {
    let open_anyway = i18n::t("dialog.tabs.limit.open");
    let answer = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title(i18n::t("dialog.tabs.limit.title"))
        .set_description(i18n::t_with(
            "dialog.tabs.limit.message",
            &[("count", &open.to_string())],
        ))
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            open_anyway.clone(),
            i18n::t("dialog.tabs.limit.cancel"),
        ))
        .show();
    answer == rfd::MessageDialogResult::Custom(open_anyway)
}

/// The home server's way into the window (`POST /api/tabs/*`).
pub struct ShellTabs {
    pub app: AppHandle,
}

impl TabActions for ShellTabs {
    fn activate(&self, key: &str) -> Result<(), ActivateError> {
        activate(&self.app, key)
    }

    fn close(&self, key: &str) -> CloseOutcome {
        close(&self.app, key)
    }
}
