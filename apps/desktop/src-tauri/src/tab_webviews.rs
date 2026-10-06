//! The window's webviews: the Projects page in the window's own webview
//! (`main`), and with project tabs one child webview per open project, all the
//! size of the window, one shown at a time.
//!
//! Tauri's `unstable` multiwebview feature is what makes a second webview in
//! one window possible (`Window::add_child`). Each project's page is its own
//! webview on its own Studio origin, so ids, `localStorage`, IndexedDB and the
//! SSE connection limit are per project. The tab strip is not drawn here: the
//! pages draw it from `GET /api/tabs` (`home_tabs.rs`); this module only shows
//! and hides webviews and tells the pages when the list changed.
//!
//! Once a window holds child webviews `get_webview_window("main")` no longer
//! answers (a "webview window" has exactly one webview), so every lookup of the
//! main window goes through [`main_window`] / [`main_webview`].

use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Manager, PhysicalPosition, Webview, WebviewUrl, Window};

use super::coded_error::CodedError;

/// The label of the window and of its own webview (the Projects page).
pub const MAIN: &str = "main";

/// What the pages listen for to refetch the tab list.
const TABS_CHANGED_JS: &str = "window.dispatchEvent(new CustomEvent('openvids-tabs-changed'))";

/// The shell's window, whether or not it holds child webviews.
pub fn main_window(app: &AppHandle) -> Option<Window> {
    app.get_window(MAIN)
}

/// The window's own webview: the Projects page (in single-project mode also
/// the project's Studio, which the window navigates to).
pub fn main_webview(app: &AppHandle) -> Option<Webview> {
    app.get_webview(MAIN)
}

/// The webview label of one open of the project `key` (`generation` is that
/// open's number): unique per open, so a superseded open's page, which may
/// still be closing, can never keep the current open from creating its own.
pub fn child_label(key: &str, generation: u64) -> String {
    format!("project-{key}-{generation}")
}

/// Whether a window of this size can hold a page. A minimized window reports
/// 0×0 on Windows; a page added then would get 0/0 = NaN auto-resize rates and
/// never lay out again.
pub fn has_area(size: tauri::PhysicalSize<u32>) -> bool {
    size.width > 0 && size.height > 0
}

/// What a project webview needs to be wired into the shell.
pub struct ChildSpec {
    pub key: String,
    /// The webview's label, from [`child_label`].
    pub label: String,
    pub url: tauri::Url,
    /// The Studio origin the page lives on (the only server its render links
    /// may ask to open a file).
    pub origin: String,
    pub home_origin: String,
    pub background: tauri::window::Color,
}

/// Add the project's webview on top of the window, full size, shown and
/// focused. The caller commits the project right after and hides the others
/// with [`show`]; a failed commit closes it again with [`close_child`].
pub fn create_child(app: &AppHandle, spec: ChildSpec) -> Result<Webview, CodedError> {
    let failed = |detail: String| {
        CodedError::new(
            "tab_webview_failed",
            format!("could not create the project's page: {detail}"),
            serde_json::json!({ "detail": detail }),
        )
    };
    let window = main_window(app).ok_or_else(|| failed("the main window is gone".to_string()))?;
    let mut size = window.inner_size().map_err(|e| failed(e.to_string()))?;
    if !has_area(size) {
        // Minimized (Windows reports 0×0): restore it, so the page is sized
        // against the real window and its auto-resize rates are finite.
        let _ = window.unminimize();
        size = window.inner_size().map_err(|e| failed(e.to_string()))?;
        if !has_area(size) {
            return Err(failed("the window has no size yet".to_string()));
        }
    }
    let label = spec.label.clone();

    let page_app = app.clone();
    let page_key = spec.key.clone();
    let link_origins = vec![spec.origin.clone()];
    let nav_app = app.clone();
    let home_origin = spec.home_origin.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(spec.url))
        .background_color(spec.background)
        // Studio imports assets through the browser's own HTML5 drop; Tauri's
        // drag-drop handler would swallow it (see the main window's builder).
        .disable_drag_drop_handler()
        .devtools(cfg!(debug_assertions))
        // The window grows and shrinks the page with it, hidden or shown.
        .auto_resize()
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) {
                super::keep_project_on_its_page(&page_app, &page_key, payload.url());
            }
        })
        // `target="_blank"` links and `window.open`: never a second window,
        // never a navigation (see `shell_links`). A render's own link goes to
        // this project's server only.
        .on_new_window(move |url, _features| {
            super::shell_links::run_link_action(super::shell_links::classify_link(
                url.as_str(),
                &link_origins,
            ));
            NewWindowResponse::Deny
        })
        .on_download(move |webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                let origins = super::trusted_origins(webview.app_handle());
                super::shell_links::download_requested(&url, destination, &origins)
            }
            DownloadEvent::Finished { url, path, success } => {
                super::shell_links::download_finished(&url, path, success);
                true
            }
            _ => true,
        })
        // The in-Studio back button is a plain navigation to the home origin.
        // With tabs it must not leave the project: the Projects tab shows
        // instead and this page stays where it is.
        .on_navigation(move |url| {
            if super::normalize_origin(url) == home_origin {
                let app = nav_app.clone();
                std::thread::spawn(move || {
                    if let Err(error) = super::tab_actions::activate(&app, super::tabs::HOME) {
                        super::log_line(&format!("could not show the Projects tab: {error:?}"));
                    }
                });
                return false;
            }
            true
        });
    window
        .add_child(builder, PhysicalPosition::new(0, 0), size)
        .map_err(|e| failed(e.to_string()))
}

/// Show the tab `label` names (a project's webview), or the Projects page when
/// `None`, hiding every other project webview, and give the shown page the
/// keyboard focus.
pub fn show(app: &AppHandle, label: Option<&str>) {
    let Some(window) = main_window(app) else {
        return;
    };
    let mut shown: Option<Webview> = None;
    for webview in window.webviews() {
        if webview.label() == MAIN {
            continue;
        }
        if Some(webview.label()) == label {
            let _ = webview.show();
            shown = Some(webview);
        } else {
            let _ = webview.hide();
        }
    }
    let target = shown.or_else(|| main_webview(app));
    if let Some(target) = target {
        let _ = target.set_focus();
    }
}

/// Close one project's webview (its tab was closed, or its commit failed).
pub fn close_child(app: &AppHandle, label: &str) {
    if label == MAIN {
        return;
    }
    if let Some(webview) = app.get_webview(label) {
        let _ = webview.close();
    }
}

/// The webview the user is looking at: the active tab's, else the Projects page.
pub fn active_webview(app: &AppHandle, label: Option<&str>) -> Option<Webview> {
    label
        .and_then(|label| app.get_webview(label))
        .or_else(|| main_webview(app))
}

/// Tell every page of the window the tab list changed, so the strips refetch
/// it now instead of at their next poll.
pub fn notify_tabs_changed(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    for webview in window.webviews() {
        let _ = webview.eval(TABS_CHANGED_JS);
    }
}
