//! The projects the shell has open, one slot per project key, and the tab
//! bookkeeping built on them.
//!
//! The key is `recents::project_key` (16 hex of the SHA-256 of the folder's
//! path): the folder name is not unique, the key is. Everything a project owns
//! lives in its slot — the open gate (so two projects open at once and a
//! second open of the same project supersedes only its own), the Studio
//! sidecar, the origin it serves and the webview showing it — so closing one
//! tab cannot touch another's server.
//!
//! The state is generic over the server it owns so the bookkeeping is tested
//! without starting a process; `lib.rs` instantiates it with `StudioServer`.
//! Nothing here locks, spawns or blocks: the caller holds the lock only for the
//! bookkeeping and tears servers down after releasing it.

use std::collections::HashMap;

use serde::Serialize;

use super::project::Project;

/// The id of the Projects page in the tab strip and in `activate`.
pub const HOME: &str = "home";

/// The soft limit of open projects: each sidecar brings its own Chrome and
/// agent runtime (about 500 MB once they start), so opening beyond this asks.
pub const SOFT_LIMIT: usize = 6;

/// Bookkeeping for opening one project without holding the app state across
/// the slow part. A sidecar start waits on a port handshake and a readiness
/// poll (up to about 105 s) and a teardown waits out a SIGTERM grace; neither
/// may run under the lock the main-thread hooks (navigation, menus, quit)
/// take. An open therefore takes what it replaces out, releases the lock,
/// starts the replacement, and commits only if no newer open of the same
/// project began meanwhile.
#[derive(Debug, Default)]
pub struct OpenGate {
    generation: u64,
    /// The window has navigated to the committed Studio origin, so a
    /// navigation back to the home origin really leaves a project. Before
    /// that (the committed server is not on screen yet) a home navigation
    /// is a reload of the Projects page, not a close. Single-project mode only:
    /// with tabs a project leaves by closing its tab.
    studio_shown: bool,
}

impl OpenGate {
    /// A new open (numbered by the caller, always higher than any before)
    /// supersedes every open of this project still in flight.
    fn begin(&mut self, generation: u64) {
        self.generation = generation;
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }

    /// The window navigated to the committed Studio server.
    pub fn studio_navigated(&mut self) {
        self.studio_shown = true;
    }

    /// The window navigated to the home origin: whether that closes the
    /// project on screen (and so the server must go). A home navigation that
    /// is only a reload, or lands before the window ever showed the new
    /// server, closes nothing.
    pub fn home_navigated(&mut self) -> bool {
        std::mem::take(&mut self.studio_shown)
    }
}

/// Where a project's page lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Surface {
    /// The window's own webview: single-project mode navigates it between the
    /// Projects page and Studio.
    Main,
    /// A child webview of the window with this label (tabs mode).
    Child(String),
}

/// A project that is open: its server, the origin it serves and its page.
pub struct OpenProject<S> {
    pub project: Project,
    pub origin: String,
    /// The address its page was opened at (what a page taken over by a
    /// foreign document is sent back to).
    pub url: String,
    /// What keeps the project's server alive: dropping it stops the server's
    /// whole process tree. `None` in dev, where one Vite server serves every
    /// project.
    pub _studio: Option<S>,
    pub surface: Surface,
}

struct Slot<S> {
    gate: OpenGate,
    open: Option<OpenProject<S>>,
    /// What the strip calls the project while it is still opening.
    name: String,
}

/// Why a tab could not be activated.
#[derive(Debug, PartialEq, Eq)]
pub enum ActivateError {
    Unknown,
    /// The sidecar is still starting: there is no page to show yet.
    Opening,
}

/// How a request to close a tab ended.
#[derive(Debug, PartialEq, Eq)]
pub enum CloseOutcome {
    Closed,
    /// The tab was busy and the user said no.
    Cancelled,
    Unknown,
}

/// What the pages' tab strips can ask the window to do (`POST /api/tabs/*`).
/// Installed by `lib.rs`; the home server only forwards. `close` may block on
/// a native confirmation, so it never runs under a lock.
pub trait TabActions: Send + Sync {
    fn activate(&self, key: &str) -> Result<(), ActivateError>;
    fn close(&self, key: &str) -> CloseOutcome;
}

/// Whose a failed open's failure is (`Tabs::fail`).
#[derive(Debug, PartialEq, Eq)]
pub enum FailedOpen {
    /// The open was still the project's newest: it reports the failure.
    Owned,
    /// Something newer took over. `slot_gone`: the project has no slot at all
    /// any more, so nothing else will end its "opening" phase.
    Superseded { slot_gone: bool },
}

/// What closing a tab left behind.
pub struct Closed<S> {
    /// The project's server and page, to tear down without the lock.
    pub open: Option<OpenProject<S>>,
    /// The tab that is active now (`HOME` or a project key).
    pub active: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TabState {
    Open,
    Opening,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TabInfo {
    pub key: String,
    pub name: String,
    pub state: TabState,
}

/// The tab list as the pages see it (`GET /api/tabs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TabsView {
    /// Whether the tab strip is drawn at all (the beta feature is on).
    pub enabled: bool,
    pub active: String,
    pub limit: usize,
    pub tabs: Vec<TabInfo>,
}

impl Default for TabsView {
    fn default() -> Self {
        Self {
            enabled: false,
            active: HOME.to_string(),
            limit: SOFT_LIMIT,
            tabs: Vec::new(),
        }
    }
}

pub struct Tabs<S> {
    slots: HashMap<String, Slot<S>>,
    /// Tab order: the order the projects were first opened in.
    order: Vec<String>,
    /// The project key shown, or `None` for the Projects page.
    active: Option<String>,
    /// The last open number handed out. One counter for every project, so a
    /// slot closed and begun again can never mistake an older open for its own.
    generation: u64,
}

impl<S> Default for Tabs<S> {
    fn default() -> Self {
        Self {
            slots: HashMap::new(),
            order: Vec::new(),
            active: None,
            generation: 0,
        }
    }
}

impl<S> Tabs<S> {
    /// An open of `key` begins (a tab appears, still opening, if the project
    /// has none yet). The returned generation is what `is_current` and
    /// `commit` check.
    pub fn begin(&mut self, key: &str, name: &str) -> u64 {
        if !self.slots.contains_key(key) {
            self.order.push(key.to_string());
        }
        self.generation += 1;
        let generation = self.generation;
        let slot = self.slots.entry(key.to_string()).or_insert_with(|| Slot {
            gate: OpenGate::default(),
            open: None,
            name: name.to_string(),
        });
        slot.gate.begin(generation);
        generation
    }

    /// Whether `generation` is still the newest open of `key`. False once the
    /// slot is gone (closed, or taken out by quit).
    pub fn is_current(&self, key: &str, generation: u64) -> bool {
        self.slots
            .get(key)
            .is_some_and(|slot| slot.gate.is_current(generation))
    }

    /// An open of a project that is not open yet failed: its tab goes away.
    /// A project that is open keeps its tab (a failed restart is the caller's
    /// to report).
    pub fn abandon(&mut self, key: &str, generation: u64) {
        let abandoned = self
            .slots
            .get(key)
            .is_some_and(|slot| slot.open.is_none() && slot.gate.is_current(generation));
        if abandoned {
            self.forget(key);
        }
    }

    /// An open of `key` ended in failure: whether that failure is this open's
    /// to report (its tab goes), or the open was superseded meanwhile. A
    /// superseded open owns nothing, but when its slot is gone with no newer
    /// open of the project (a single-project open took every slot, the tab was
    /// closed while it started) its "opening" phase has no owner either and
    /// the caller must clear it.
    pub fn fail(&mut self, key: &str, began: Option<u64>) -> FailedOpen {
        if let Some(generation) = began {
            if !self.is_current(key, generation) {
                return FailedOpen::Superseded {
                    slot_gone: !self.has(key),
                };
            }
            self.abandon(key, generation);
        }
        FailedOpen::Owned
    }

    /// Commit a started project. `Ok` hands back what it replaced (a restarted
    /// project's old server) for teardown; `Err` hands the project back when a
    /// newer open took over or the slot is gone, so the caller tears it down.
    pub fn commit(
        &mut self,
        key: &str,
        generation: u64,
        open: OpenProject<S>,
    ) -> Result<Option<OpenProject<S>>, OpenProject<S>> {
        match self.slots.get_mut(key) {
            Some(slot) if slot.gate.is_current(generation) => {
                slot.name = open.project.id.clone();
                Ok(slot.open.replace(open))
            }
            _ => Err(open),
        }
    }

    pub fn open_project(&self, key: &str) -> Option<&OpenProject<S>> {
        self.slots.get(key)?.open.as_ref()
    }

    /// Whether a sidecar start for `key` is under way (a slot with no server yet).
    pub fn is_opening(&self, key: &str) -> bool {
        self.slots.get(key).is_some_and(|slot| slot.open.is_none())
    }

    /// Whether a project other than `key` already holds the tab name `id`
    /// (the folder name): the dev server tells projects apart by it alone.
    pub fn name_taken_by_other(&self, key: &str, id: &str) -> bool {
        self.slots
            .iter()
            .any(|(other, slot)| other != key && slot.name == id)
    }

    pub fn has(&self, key: &str) -> bool {
        self.slots.contains_key(key)
    }

    /// Every tab, committed or opening.
    pub fn tab_count(&self) -> usize {
        self.order.len()
    }

    pub fn keys(&self) -> &[String] {
        &self.order
    }

    /// The origin and project id of the project key `key`, once open.
    pub fn origin_of(&self, key: &str) -> Option<&str> {
        self.open_project(key).map(|open| open.origin.as_str())
    }

    /// The webview label of the tab `key` lives in (tabs mode).
    pub fn child_label(&self, key: &str) -> Option<&str> {
        match &self.open_project(key)?.surface {
            Surface::Child(label) => Some(label.as_str()),
            Surface::Main => None,
        }
    }

    /// The key of the project whose Studio serves `origin` (single mode: the
    /// window's one project; dev serves every project from one origin, so it
    /// names the first of them).
    pub fn key_of_origin(&self, origin: &str) -> Option<&str> {
        self.order
            .iter()
            .find(|key| self.origin_of(key) == Some(origin))
            .map(String::as_str)
    }

    /// Every distinct origin the open projects serve (dev serves them all from
    /// one).
    pub fn origins(&self) -> Vec<String> {
        let mut origins: Vec<String> = Vec::new();
        for key in &self.order {
            if let Some(open) = self.open_project(key) {
                if !origins.contains(&open.origin) {
                    origins.push(open.origin.clone());
                }
            }
        }
        origins
    }

    /// The project key shown, `None` while the Projects page is.
    pub fn active(&self) -> Option<&str> {
        self.active.as_deref()
    }

    pub fn activate(&mut self, key: &str) -> Result<(), ActivateError> {
        if key == HOME {
            self.active = None;
            return Ok(());
        }
        match self.slots.get(key) {
            None => Err(ActivateError::Unknown),
            Some(slot) if slot.open.is_none() => Err(ActivateError::Opening),
            Some(_) => {
                self.active = Some(key.to_string());
                Ok(())
            }
        }
    }

    /// Close the tab `key`: its slot goes, every open of it still in flight is
    /// dropped, and when it was the active one the neighbour on its left (else
    /// on its right, else the Projects page) takes over.
    pub fn close(&mut self, key: &str) -> Option<Closed<S>> {
        let index = self.order.iter().position(|k| k == key)?;
        let was_active = self.active.as_deref() == Some(key);
        let slot = self.slots.remove(key)?;
        self.order.remove(index);
        if was_active {
            let next = self.neighbour(index);
            self.active = next;
        }
        Some(Closed {
            open: slot.open,
            active: self.active.clone().unwrap_or_else(|| HOME.to_string()),
        })
    }

    /// The open tab nearest to where `index` was, left first.
    fn neighbour(&self, index: usize) -> Option<String> {
        let open = |key: &&String| self.open_project(key).is_some();
        self.order[..index.min(self.order.len())]
            .iter()
            .rev()
            .find(open)
            .or_else(|| self.order[index.min(self.order.len())..].iter().find(open))
            .cloned()
    }

    /// The tab after (`forward`) or before the active one among the open tabs,
    /// wrapping through the Projects page.
    pub fn cycle(&self, forward: bool) -> String {
        let mut ring: Vec<&str> = vec![HOME];
        ring.extend(
            self.order
                .iter()
                .filter(|key| self.open_project(key).is_some())
                .map(String::as_str),
        );
        let here = ring
            .iter()
            .position(|key| Some(*key) == self.active.as_deref().or(Some(HOME)))
            .unwrap_or(0);
        let next = if forward {
            (here + 1) % ring.len()
        } else {
            (here + ring.len() - 1) % ring.len()
        };
        ring[next].to_string()
    }

    /// Take every project out for teardown (quit, update): nothing is left to
    /// commit into, and no open still in flight can.
    pub fn take_all(&mut self) -> Vec<OpenProject<S>> {
        self.order.clear();
        self.active = None;
        self.slots
            .drain()
            .filter_map(|(_, slot)| slot.open)
            .collect()
    }

    /// The window navigated to the committed Studio of `key` (single mode).
    pub fn studio_navigated(&mut self, key: &str) {
        if let Some(slot) = self.slots.get_mut(key) {
            slot.gate.studio_navigated();
        }
    }

    /// The window navigated to the home origin (single mode): the project it
    /// was really showing closes, once. A reload of the Projects page, or a
    /// home load before the window showed the new server, closes nothing.
    pub fn home_navigated(&mut self) -> Vec<OpenProject<S>> {
        let shown: Vec<String> = self
            .slots
            .iter_mut()
            .filter_map(|(key, slot)| slot.gate.home_navigated().then(|| key.clone()))
            .collect();
        shown
            .iter()
            .filter_map(|key| self.close(key))
            .filter_map(|closed| closed.open)
            .collect()
    }

    /// The tab list for the pages.
    pub fn view(&self, enabled: bool) -> TabsView {
        TabsView {
            enabled,
            active: self.active.clone().unwrap_or_else(|| HOME.to_string()),
            limit: SOFT_LIMIT,
            tabs: self
                .order
                .iter()
                .filter_map(|key| {
                    let slot = self.slots.get(key)?;
                    Some(TabInfo {
                        key: key.clone(),
                        name: slot.name.clone(),
                        state: if slot.open.is_some() {
                            TabState::Open
                        } else {
                            TabState::Opening
                        },
                    })
                })
                .collect(),
        }
    }

    fn forget(&mut self, key: &str) {
        self.slots.remove(key);
        self.order.retain(|k| k != key);
        if self.active.as_deref() == Some(key) {
            self.active = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    /// A stand-in server that counts how many of them were torn down.
    struct Server(Arc<AtomicUsize>);

    impl Drop for Server {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn project(id: &str) -> Project {
        Project {
            dir: PathBuf::from(format!("/work/{id}")),
            id: id.to_string(),
        }
    }

    fn open(id: &str, origin: &str, torn: &Arc<AtomicUsize>) -> OpenProject<Server> {
        OpenProject {
            project: project(id),
            origin: origin.to_string(),
            url: format!("{origin}/#project/{id}"),
            _studio: Some(Server(Arc::clone(torn))),
            surface: Surface::Child(format!("project-{id}")),
        }
    }

    /// Open `id` as key `id` and make it the active tab.
    fn opened(tabs: &mut Tabs<Server>, id: &str, torn: &Arc<AtomicUsize>) {
        let generation = tabs.begin(id, id);
        let port = 6000 + tabs.tab_count();
        let committed = tabs.commit(id, generation, open(id, &format!("http://127.0.0.1:{port}"), torn));
        assert!(matches!(committed, Ok(None)));
        tabs.activate(id).unwrap();
    }

    #[test]
    fn two_projects_open_side_by_side_and_each_keeps_its_own_server() {
        let torn = Arc::new(AtomicUsize::new(0));
        let mut tabs = Tabs::default();
        opened(&mut tabs, "a", &torn);
        opened(&mut tabs, "b", &torn);
        assert_eq!(tabs.tab_count(), 2);
        assert_eq!(tabs.origins().len(), 2);
        assert_eq!(tabs.active(), Some("b"));

        // Closing one tears down only its server.
        let closed = tabs.close("a").expect("a is open");
        drop(closed.open);
        assert_eq!(torn.load(Ordering::SeqCst), 1);
        assert!(tabs.open_project("b").is_some());
        assert_eq!(tabs.active(), Some("b"), "closing a background tab keeps the active one");
    }

    #[test]
    fn a_newer_open_of_the_same_project_supersedes_only_that_project() {
        let torn = Arc::new(AtomicUsize::new(0));
        let mut tabs: Tabs<Server> = Tabs::default();
        let first = tabs.begin("a", "a");
        let other = tabs.begin("b", "b");
        let second = tabs.begin("a", "a");
        assert!(!tabs.is_current("a", first), "the first open must not commit over the second");
        assert!(tabs.is_current("a", second));
        assert!(tabs.is_current("b", other), "another project's open is untouched");
        assert_eq!(tabs.tab_count(), 2, "one tab per project however many opens");

        // The superseded open is handed its project back to tear down.
        let stale = tabs.commit("a", first, open("a", "http://127.0.0.1:1", &torn));
        assert!(stale.is_err());
        drop(stale);
        assert_eq!(torn.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_failed_first_open_leaves_no_tab_but_a_failed_restart_keeps_the_project() {
        let torn = Arc::new(AtomicUsize::new(0));
        let mut tabs: Tabs<Server> = Tabs::default();
        let generation = tabs.begin("a", "a");
        assert!(tabs.is_opening("a"));
        tabs.abandon("a", generation);
        assert!(!tabs.has("a"));
        assert!(tabs.view(true).tabs.is_empty());

        opened(&mut tabs, "b", &torn);
        let restart = tabs.begin("b", "b");
        tabs.abandon("b", restart);
        assert!(tabs.open_project("b").is_some());
    }

    #[test]
    fn closing_the_active_tab_activates_its_left_neighbour_then_the_right_then_home() {
        let torn = Arc::new(AtomicUsize::new(0));
        let mut tabs = Tabs::default();
        for id in ["a", "b", "c"] {
            opened(&mut tabs, id, &torn);
        }
        tabs.activate("b").unwrap();
        assert_eq!(tabs.close("b").unwrap().active, "a");
        tabs.activate("a").unwrap();
        assert_eq!(tabs.close("a").unwrap().active, "c");
        assert_eq!(tabs.close("c").unwrap().active, HOME);
        assert_eq!(tabs.active(), None);
        assert!(tabs.close("c").is_none(), "an unknown tab closes nothing");
    }

    #[test]
    fn an_opening_tab_shows_in_the_strip_but_cannot_be_activated() {
        let torn = Arc::new(AtomicUsize::new(0));
        let mut tabs = Tabs::default();
        opened(&mut tabs, "a", &torn);
        tabs.begin("b", "b");
        assert_eq!(tabs.activate("b"), Err(ActivateError::Opening));
        assert_eq!(tabs.activate("zzz"), Err(ActivateError::Unknown));
        assert_eq!(tabs.activate(HOME), Ok(()));
        let view = tabs.view(true);
        assert_eq!(view.active, HOME);
        let states: Vec<_> = view.tabs.iter().map(|t| (t.key.as_str(), t.state)).collect();
        assert_eq!(states, [("a", TabState::Open), ("b", TabState::Opening)]);
        // The neighbour on close skips tabs that are still opening.
        tabs.activate("a").unwrap();
        assert_eq!(tabs.close("a").unwrap().active, HOME);
    }

    #[test]
    fn quitting_takes_every_server_and_stops_opens_in_flight_from_committing() {
        let torn = Arc::new(AtomicUsize::new(0));
        let mut tabs = Tabs::default();
        opened(&mut tabs, "a", &torn);
        opened(&mut tabs, "b", &torn);
        let starting = tabs.begin("c", "c");
        assert!(tabs.is_current("c", starting));
        let all = tabs.take_all();
        assert_eq!(all.len(), 2);
        drop(all);
        assert_eq!(torn.load(Ordering::SeqCst), 2);
        // The slot is gone: the open in flight cannot commit and tears its server down itself.
        let late = tabs.commit("c", starting, open("c", "http://127.0.0.1:9", &torn));
        assert!(late.is_err());
        assert_eq!(tabs.tab_count(), 0);
    }

    #[test]
    fn single_project_mode_closes_the_project_the_window_showed_when_it_goes_home() {
        let torn = Arc::new(AtomicUsize::new(0));
        let mut tabs = Tabs::default();
        opened(&mut tabs, "a", &torn);
        // The server is committed but the window has not reached it yet: a
        // reload of the Projects page landing now must not take it.
        assert!(tabs.home_navigated().is_empty());
        tabs.studio_navigated("a");
        let closed = tabs.home_navigated();
        assert_eq!(closed.len(), 1);
        assert!(tabs.home_navigated().is_empty(), "a second home load (a reload) closes nothing");
        assert!(!tabs.has("a"));
    }

    #[test]
    fn cycling_walks_the_open_tabs_through_the_projects_page() {
        let torn = Arc::new(AtomicUsize::new(0));
        let mut tabs = Tabs::default();
        opened(&mut tabs, "a", &torn);
        opened(&mut tabs, "b", &torn);
        tabs.begin("c", "c");
        assert_eq!(tabs.cycle(true), HOME, "after the last open tab comes the Projects page");
        tabs.activate(HOME).unwrap();
        assert_eq!(tabs.cycle(true), "a");
        assert_eq!(tabs.cycle(false), "b");
    }

    #[test]
    fn a_superseded_open_whose_slot_is_gone_must_clear_its_phase_but_one_with_a_newer_open_must_not() {
        let torn = Arc::new(AtomicUsize::new(0));
        // Single-project mode: B's open took every slot (A's included) while A's sidecar started.
        let mut tabs: Tabs<Server> = Tabs::default();
        let a = tabs.begin("a", "a");
        drop(tabs.take_all());
        tabs.begin("b", "b");
        assert_eq!(tabs.fail("a", Some(a)), FailedOpen::Superseded { slot_gone: true });
        assert!(tabs.has("b"), "the failure of A touches nothing of B");

        // A tab closed while it started: no slot, no newer open.
        let mut tabs: Tabs<Server> = Tabs::default();
        let c = tabs.begin("c", "c");
        let closed = tabs.close("c").expect("c has a tab");
        assert!(closed.open.is_none(), "an opening tab has no server to tear down");
        assert_eq!(tabs.fail("c", Some(c)), FailedOpen::Superseded { slot_gone: true });

        // A newer open of the same project owns the phase: the slot stays, so nothing is cleared.
        let mut tabs: Tabs<Server> = Tabs::default();
        let first = tabs.begin("d", "d");
        let second = tabs.begin("d", "d");
        assert_eq!(tabs.fail("d", Some(first)), FailedOpen::Superseded { slot_gone: false });
        assert!(tabs.is_current("d", second));

        // The newest open owns its failure: its tab goes; a project that was open keeps its own.
        assert_eq!(tabs.fail("d", Some(second)), FailedOpen::Owned);
        assert!(!tabs.has("d"));
        opened(&mut tabs, "e", &torn);
        let restart = tabs.begin("e", "e");
        assert_eq!(tabs.fail("e", Some(restart)), FailedOpen::Owned);
        assert!(tabs.open_project("e").is_some());
    }

    #[test]
    fn child_labels_map_back_to_their_project() {
        let torn = Arc::new(AtomicUsize::new(0));
        let mut tabs = Tabs::default();
        opened(&mut tabs, "a", &torn);
        opened(&mut tabs, "b", &torn);
        assert_eq!(tabs.child_label("b"), Some("project-b"));
        assert_eq!(tabs.child_label("a"), Some("project-a"));
        assert_eq!(tabs.child_label("zz"), None);
    }
}
