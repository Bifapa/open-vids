//! Fork: a project's copy with lineage, made in the background while the Projects page shows progress
//! (`/api/fork/*`, token-gated like every `/api/` route; a tab strip starts one through `POST /api/tabs/fork`,
//! `home_tabs`). The copying is `project_copy`'s; this is the job around it.
//!
//! - `POST /api/fork {id}` — start forking the recent `id` (the one already running for the same project is
//!   returned as it is). Answers `{ ok, fork }` with the job state; 404 `unknown_project`, 410 `folder_missing`,
//!   409 `copy_turn_running` / `copy_served_elsewhere` (the agent works in the project), 409 `fork_running` (a fork
//!   of another project is still being made).
//! - `GET /api/fork/state` — the job: `{ phase, id, name, done, total, project?, error?, code?, params? }` with
//!   `phase` one of `idle` · `copying` · `done` (`project` is the new recent, as `/api/recents` lists it) ·
//!   `failed` · `cancelled`. A finished job stays until the next start.
//! - `POST /api/fork/cancel` — stop the copy; the temporary folder goes, nothing is listed.
//!
//! One fork at a time: a copy is disk-bound, and a second one would only slow the first.

use std::net::TcpStream;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use parking_lot::{Mutex, MutexGuard};

use serde_json::{json, Value};

use super::coded_error::CodedError;
use super::home_api::{
    copy_refusal, find, folder_missing, method_not_allowed, record_copy, recent_json, respond_error, respond_json,
    route_not_found, unknown_project,
};
use super::home_routes::{json_field, HomeInner};
use super::project_copy::{self, CopyError, Kind, Progress};
use super::recents::RecentEntry;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Copying,
    Done,
    Failed,
    Cancelled,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Copying => "copying",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

struct Slot {
    phase: Phase,
    /// Bumped by every start, so a finished copy never writes over a newer job.
    generation: u64,
    /// The source's recent key and name.
    id: String,
    name: String,
    progress: Option<Arc<Progress>>,
    project: Option<Value>,
    error: Option<CodedError>,
}

pub struct ForkJob {
    slot: Mutex<Slot>,
}

impl ForkJob {
    pub const fn new() -> Self {
        Self {
            slot: Mutex::new(Slot {
                phase: Phase::Idle,
                generation: 0,
                id: String::new(),
                name: String::new(),
                progress: None,
                project: None,
                error: None,
            }),
        }
    }

    fn slot(&self) -> MutexGuard<'_, Slot> {
        self.slot.lock()
    }

    pub fn state_json(&self) -> Value {
        let slot = self.slot();
        let (done, total) = slot.progress.as_ref().map(|p| p.snapshot()).unwrap_or((0, 0));
        let mut body = json!({
            "phase": slot.phase.name(),
            "id": slot.id,
            "name": slot.name,
            "done": done,
            "total": total,
        });
        if let Some(project) = &slot.project {
            body["project"] = project.clone();
        }
        if let Some(err) = &slot.error {
            let error = err.body();
            body["error"] = error["error"].clone();
            if let Some(code) = error.get("code") {
                body["code"] = code.clone();
                body["params"] = error["params"].clone();
            }
        }
        body
    }

    /// Start forking `source`, or report the fork of the same project already under way.
    pub fn start(self: &Arc<Self>, state: &Arc<StdMutex<HomeInner>>, source: RecentEntry) -> Result<Value, CodedError> {
        if let Some(refusal) = copy_refusal(&source.dir, &source.id) {
            return Err(refusal);
        }
        let key = source.key();
        let progress = Arc::new(Progress::default());
        let generation = {
            let mut slot = self.slot();
            if slot.phase == Phase::Copying {
                if slot.id == key {
                    drop(slot);
                    return Ok(self.state_json());
                }
                return Err(CodedError::new(
                    "fork_running",
                    format!("“{}” is still being forked: wait for it to finish first", slot.name),
                    json!({ "name": slot.name }),
                ));
            }
            slot.generation += 1;
            slot.phase = Phase::Copying;
            slot.id = key;
            slot.name = source.id.clone();
            slot.progress = Some(progress.clone());
            slot.project = None;
            slot.error = None;
            slot.generation
        };
        let state = state.clone();
        let job = Arc::clone(self);
        std::thread::spawn(move || {
            let outcome = project_copy::copy_project(&source.dir, Kind::Fork, &progress);
            let finished = match outcome {
                Ok(copied) => match record_copy(&state, &source, &copied) {
                    Some(entry) => Ok(recent_json(&entry)),
                    None => Err(CodedError::plain(
                        "fork_not_listed",
                        "the fork was created but could not be listed",
                    )),
                },
                Err(CopyError::Cancelled) => Err(CodedError::plain("fork_cancelled", "cancelled")),
                Err(CopyError::Io(err)) => Err(CodedError::new(
                    "fork_failed",
                    format!("could not fork the project: {err}"),
                    json!({ "detail": err.to_string() }),
                )),
            };
            let mut slot = job.slot();
            if slot.generation != generation {
                return;
            }
            match finished {
                Ok(project) => {
                    slot.phase = Phase::Done;
                    slot.project = Some(project);
                }
                Err(err) if err.code == Some("fork_cancelled") => slot.phase = Phase::Cancelled,
                Err(err) => {
                    slot.phase = Phase::Failed;
                    slot.error = Some(err);
                }
            }
        });
        Ok(self.state_json())
    }

    /// Ask the running copy to stop; it ends `cancelled` as soon as it notices.
    pub fn cancel(&self) {
        if let Some(progress) = self.slot().progress.as_ref() {
            progress.cancel();
        }
    }
}

fn job() -> &'static Arc<ForkJob> {
    static JOB: OnceLock<Arc<ForkJob>> = OnceLock::new();
    JOB.get_or_init(|| Arc::new(ForkJob::new()))
}

pub fn owns(path: &str) -> bool {
    path.starts_with("/api/fork")
}

/// Start forking the recent `entry` (or report the fork of it already under way): the job's state, or the
/// status and error to answer.
pub fn start(state: &Arc<StdMutex<HomeInner>>, entry: RecentEntry) -> Result<Value, (u16, CodedError)> {
    if !entry.dir.is_dir() {
        return Err((410, folder_missing(&entry.dir)));
    }
    job().start(state, entry).map_err(|err| (409, err))
}

/// Handle one request for which `owns(path)` holds.
pub fn handle(stream: &mut TcpStream, state: &Arc<StdMutex<HomeInner>>, method: &str, path: &str, body: &[u8]) {
    match (method, path) {
        ("GET", "/api/fork/state") => respond_json(stream, 200, &job().state_json()),
        ("POST", "/api/fork/cancel") => {
            job().cancel();
            respond_json(stream, 200, &job().state_json());
        }
        ("POST", "/api/fork") => {
            let id = json_field(body, "id").unwrap_or_default();
            let Some(entry) = find(state, &id) else {
                return respond_error(stream, 404, &unknown_project());
            };
            match start(state, entry) {
                Ok(fork) => respond_json(stream, 200, &json!({ "ok": true, "fork": fork })),
                Err((status, err)) => respond_error(stream, status, &err),
            }
        }
        (_, "/api/fork" | "/api/fork/state" | "/api/fork/cancel") => {
            respond_error(stream, 405, &method_not_allowed())
        }
        _ => respond_error(stream, 404, &route_not_found()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    fn scratch(label: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("openvids-fork-job-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn project(base: &Path, name: &str) -> PathBuf {
        let dir = base.join(name);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<html></html>").unwrap();
        std::fs::write(dir.join("assets/a.mov"), "frames").unwrap();
        dir
    }

    fn home(base: &Path, projects: &[&Path]) -> Arc<StdMutex<HomeInner>> {
        let mut inner = HomeInner::load(base.join("recents.json"), base.join("thumbs")).unwrap();
        for dir in projects {
            let name = dir.file_name().unwrap().to_string_lossy().into_owned();
            inner.recents.record(&name, dir, None, None);
        }
        Arc::new(StdMutex::new(inner))
    }

    fn entry(state: &Arc<StdMutex<HomeInner>>, dir: &Path) -> RecentEntry {
        state.lock().unwrap().recents.find_by_dir(dir).cloned().unwrap()
    }

    fn wait_until_finished(job: &Arc<ForkJob>) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let state = job.state_json();
            if state["phase"] != "copying" {
                return state;
            }
            assert!(Instant::now() < deadline, "the fork never finished: {state}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_fork_runs_in_the_background_and_ends_listed_first_with_its_origin() {
        let base = scratch("done");
        let src = project(&base, "Talk");
        let state = home(&base, &[&src]);
        let job = Arc::new(ForkJob::new());
        assert_eq!(job.state_json()["phase"], "idle");

        let started = job.start(&state, entry(&state, &src)).unwrap();
        assert_eq!(started["name"], "Talk");
        let finished = wait_until_finished(&job);

        assert_eq!(finished["phase"], "done", "{finished}");
        assert_eq!(finished["done"], finished["total"]);
        // The project files, and the meta.json the fork gave the original (its uid) before copying.
        let meta_len = std::fs::metadata(src.join("meta.json")).unwrap().len();
        assert_eq!(finished["total"], "<html></html>".len() as u64 + "frames".len() as u64 + meta_len);
        let project = &finished["project"];
        assert_eq!(project["name"], "Talk fork");
        assert_eq!(project["forked_from"], "Talk");
        let fork_dir = crate::platform::canonical_stable(&base.join("Talk fork"));
        assert_eq!(project["dir"], fork_dir.to_string_lossy().as_ref());
        // Listed first in Recent, so the page can open it right away.
        let listed = state.lock().unwrap().recents.entries()[0].clone();
        assert_eq!(listed.key(), project["id"].as_str().unwrap());
        assert!(base.join("Talk fork/assets/a.mov").is_file());
        assert!(src.join("assets/a.mov").is_file(), "the original is intact");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_one_fork_runs_at_a_time_and_the_same_project_is_not_forked_twice() {
        let base = scratch("busy");
        let talk = project(&base, "Talk");
        let other = project(&base, "Other");
        let state = home(&base, &[&talk, &other]);
        let job = Arc::new(ForkJob::new());
        // A fork of Talk that is still going.
        {
            let mut slot = job.slot();
            slot.phase = Phase::Copying;
            slot.id = entry(&state, &talk).key();
            slot.name = "Talk".into();
        }
        let again = job.start(&state, entry(&state, &talk)).unwrap();
        assert_eq!(again["phase"], "copying", "the running fork is returned, none is added");
        let refused = job.start(&state, entry(&state, &other)).unwrap_err();
        assert_eq!(refused.code, Some("fork_running"));
        assert!(!base.join("Other fork").exists());
        assert!(!base.join("Talk fork").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_fork_is_refused_while_another_process_works_in_the_project() {
        let base = scratch("lease");
        let src = project(&base, "Talk");
        std::fs::create_dir_all(src.join(".hyperframes/agent")).unwrap();
        std::fs::write(src.join(".hyperframes/agent/owner.pid"), std::process::id().to_string()).unwrap();
        let state = home(&base, &[&src]);
        let job = Arc::new(ForkJob::new());
        let refused = job.start(&state, entry(&state, &src)).unwrap_err();
        assert_eq!(refused.code, Some("copy_served_elsewhere"));
        assert_eq!(job.state_json()["phase"], "idle", "a refusal starts nothing");
        let names: Vec<String> = std::fs::read_dir(&base).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.starts_with(".openvids-fork-") && !n.contains("fork")), "{names:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_failed_fork_reports_its_reason_and_leaves_nothing() {
        let base = scratch("failed");
        let src = project(&base, "Talk");
        let state = home(&base, &[&src]);
        let source = entry(&state, &src);
        // The folder vanishes between the click and the copy.
        std::fs::remove_dir_all(&src).unwrap();
        let job = Arc::new(ForkJob::new());
        job.start(&state, source).unwrap();
        let finished = wait_until_finished(&job);
        assert_eq!(finished["phase"], "failed");
        assert_eq!(finished["code"], "fork_failed");
        assert!(finished["error"].as_str().unwrap().starts_with("could not fork the project"));
        assert!(!base.join("Talk fork").exists());
        let temp: Vec<_> = std::fs::read_dir(&base)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".openvids-fork-"))
            .collect();
        assert!(temp.is_empty(), "no temporary folder stays");
        let _ = std::fs::remove_dir_all(&base);
    }
}
