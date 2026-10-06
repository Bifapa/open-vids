//! Rename / trash handling for the home screen.
//!
//! Rename moves the folder on disk and updates the recents entry. Studio's
//! project id IS the folder name (`project.rs`, mirroring
//! `isValidProjectId` in `packages/studio/src/utils/projectRouting.ts`), so:
//! - the new name is validated with the same id rule,
//! - collisions with an existing path or another recent are refused,
//! - renaming is refused while an open is in flight (the running server's
//!   `#project/<id>` URL names the old folder).
//!
//! HyperFrames also keeps a separate display name in `meta.json`
//! (`{id, name}`, written by `init` in `packages/cli/src/commands/init.ts`).
//! It is updated alongside the folder so the two never disagree; projects
//! without a `meta.json` are unaffected.
//!
//! Trash moves the folder to the OS Trash via the `trash` crate's
//! `NsFileManager` backend (`trashItemAtURL`) on macOS and the crate default
//! elsewhere — on Windows that is the Recycle Bin via `IFileOperation`
//! (verified in the `trash` 5.x sources, `src/windows.rs`) — and drops the
//! recent. NsFileManager — not the crate's default Finder AppleScript, which
//! shells out to `osascript` and hangs without a GUI session — is load-bearing
//! on macOS; verified live against the running app (see README Security
//! notes).
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::coded_error::CodedError;
use super::home_api::{recent_json, respond_error, respond_json, unknown_project};
use super::home_routes::{json_field, respond, HomeInner};
#[cfg(target_os = "macos")]
use trash::macos::TrashContextExtMacos;

pub fn handle_rename(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let key = json_field(body, "id").unwrap_or_default();
    let new_name = json_field(body, "new_name").unwrap_or_default();
    if !super::project::is_valid_project_id(&new_name) {
        respond_error(
            stream,
            400,
            &CodedError::new(
                "rename_name_unusable",
                format!("{new_name:?} is not a usable folder name"),
                serde_json::json!({ "name": new_name }),
            ),
        );
        return;
    }
    let outcome = state
        .lock()
        .ok()
        .and_then(|mut inner| rename_recent(&mut inner, &key, &new_name));
    match outcome {
        Some(Ok(project)) => {
            respond_json(stream, 200, &serde_json::json!({ "ok": true, "project": project }));
        }
        Some(Err(RenameRefusal::Taken)) => respond_error(
            stream,
            409,
            &CodedError::plain("rename_name_taken", "another project already uses that name"),
        ),
        Some(Err(RenameRefusal::Failed(error))) => respond_error(stream, 400, &error),
        None => respond_error(stream, 404, &unknown_project()),
    }
}

/// Why a rename did not happen.
enum RenameRefusal {
    /// Another recent already lives at the new path.
    Taken,
    Failed(CodedError),
}

/// Rename the folder of the recent `key` and its entry, under the caller's
/// one hold of the home state. Every refusal comes before the folder moves:
/// moving it first and then finding the recents entry's new path taken would
/// leave the folder renamed and the entry pointing at a path that is gone.
/// `None` is an unknown project.
fn rename_recent(
    inner: &mut HomeInner,
    key: &str,
    new_name: &str,
) -> Option<Result<serde_json::Value, RenameRefusal>> {
    let entry = inner.recents.find_by_key(key)?.clone();
    if inner.is_opening(key) {
        return Some(Err(RenameRefusal::Failed(CodedError::plain(
            "project_opening_busy",
            "a project is opening — try again in a moment",
        ))));
    }
    // The folder name IS the Studio id, so an open project cannot move out
    // from under its running server (`#project/<id>` names it). The tab list
    // covers every project the window has open, and also one whose server is
    // still starting.
    if inner.is_open(key) {
        return Some(Err(RenameRefusal::Failed(project_in_use(inner))));
    }
    let new_dir = entry.dir.parent()?.join(new_name);
    // On a case-insensitive filesystem (APFS and NTFS defaults) a case-only
    // rename ("demo" → "Demo") resolves to the project's own folder: that is
    // the same folder, not a collision.
    if new_dir.exists() && !is_same_folder(&entry.dir, &new_dir) {
        return Some(Err(RenameRefusal::Failed(CodedError::new(
            "rename_target_exists",
            format!("{} already exists", new_dir.display()),
            serde_json::json!({ "path": new_dir.display().to_string() }),
        ))));
    }
    // A listed recent at the new path (a folder that has since gone missing)
    // counts as taken even though nothing is on disk there.
    if inner.recents.rename_collides(key, &new_dir) {
        return Some(Err(RenameRefusal::Taken));
    }
    if let Err(err) = std::fs::rename(&entry.dir, &new_dir) {
        return Some(Err(RenameRefusal::Failed(CodedError::new(
            "rename_failed",
            format!("could not rename the folder: {err}"),
            serde_json::json!({ "detail": err.to_string() }),
        ))));
    }
    update_meta_name(&new_dir, new_name);
    // Dev serves projects through symlinks in the Studio data
    // dir; drop the stale one so it does not dangle at the old
    // id. Re-opening the renamed project re-links the new id.
    remove_dev_link(&entry.dir);
    // The collision was ruled out above under this same hold.
    inner.recents.rename(key, new_name, &new_dir);
    inner
        .recents
        .find_by_dir(&new_dir)
        .map(|entry| Ok(recent_json(entry)))
}

/// Whether two spellings reach the same folder on disk.
fn is_same_folder(a: &Path, b: &Path) -> bool {
    super::platform::same_path(
        &super::platform::canonical_stable(a),
        &super::platform::canonical_stable(b),
    )
}

fn update_meta_name(dir: &Path, name: &str) {
    let path = dir.join("meta.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return;
    };
    if !value.is_object() {
        return;
    }
    value["id"] = serde_json::Value::String(name.to_string());
    value["name"] = serde_json::Value::String(name.to_string());
    if let Ok(out) = serde_json::to_string_pretty(&value) {
        let _ = std::fs::write(path, format!("{out}\n"));
    }
}

/// Remove the dev-mode symlink for `old_dir` from Studio's data dir, if it
/// points at `old_dir`. Dev serves projects through
/// `packages/studio/data/projects/<id>` symlinks (`register_dev_project` in
/// lib.rs mirrors the CLI's `linkProjectIntoStudioData`); after a rename
/// the old id would otherwise dangle at a moved-away path.
fn remove_dev_link(old_dir: &Path) {
    let Some(name) = old_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
    else {
        return;
    };
    let link = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("studio")
        .join("data")
        .join("projects")
        .join(&name);
    if std::fs::read_link(&link).ok().as_deref() == Some(old_dir) {
        let _ = std::fs::remove_file(&link);
    }
}

/// The refusal for changing a project that is open: in single-project mode it is
/// closed by going back to the Projects page, with tabs by closing its tab.
fn project_in_use(inner: &HomeInner) -> CodedError {
    if inner.tabs.enabled {
        CodedError::plain("project_in_use_tab", "that project is open — close its tab first")
    } else {
        CodedError::plain("project_in_use", "that project is open — use Show All Projects first")
    }
}

pub fn handle_trash(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let key = json_field(body, "id").unwrap_or_default();
    let (dir, refusal) = state.lock().ok().map_or((None, None), |inner| {
        let dir = inner.recents.find_by_key(&key).map(|e| e.dir.clone());
        let refusal = (dir.is_some() && inner.is_open(&key)).then(|| project_in_use(&inner));
        (dir, refusal)
    });
    let Some(dir) = dir else {
        respond_error(stream, 404, &unknown_project());
        return;
    };
    // Moving a project to the Trash under its own running server would leave
    // the tab on a folder that is gone.
    if let Some(error) = refusal {
        respond_error(stream, 400, &error);
        return;
    }
    // macOS: NsFileManager, not the crate's default Finder AppleScript. The
    // Finder path shells out to `osascript` and hangs without a GUI session
    // to answer it (observed: the request never returns under `tauri dev`),
    // while `trashItemAtURL` is synchronous and needs no extra permissions.
    // Trade-off: no Finder "Put Back" undo entry. Other platforms keep the
    // crate default (Recycle Bin via `IFileOperation` on Windows).
    #[cfg(target_os = "macos")]
    let trash_result: Result<(), trash::Error> = {
        let mut ctx = trash::TrashContext::new();
        ctx.set_delete_method(trash::macos::DeleteMethod::NsFileManager);
        ctx.delete(&dir)
    };
    #[cfg(not(target_os = "macos"))]
    let trash_result: Result<(), trash::Error> = trash::delete(&dir);
    match trash_result {
        Ok(()) => {
            if let Ok(mut inner) = state.lock() {
                inner.recents.remove(&key);
            }
            respond(stream, 200, "application/json", br#"{"ok":true}"#);
        }
        Err(err) => respond_error(
            stream,
            500,
            &CodedError::new(
                "trash_failed",
                format!("could not move the folder to Trash: {err}"),
                serde_json::json!({ "detail": err.to_string() }),
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openvids-rename-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        // The recents store keeps canonical paths (macOS temp dirs sit behind a symlink).
        super::super::platform::canonical_stable(&dir)
    }

    fn home(base: &Path) -> HomeInner {
        HomeInner::load(base.join("recents.json"), base.join("thumbs")).expect("home state")
    }

    #[test]
    fn a_rename_onto_a_listed_but_missing_recent_is_refused_before_the_folder_moves() {
        let base = temp_dir("collision");
        let bar = base.join("bar");
        std::fs::create_dir_all(&bar).expect("project folder");
        // `foo` is listed in recents but its folder is gone.
        let foo = base.join("foo");
        let mut inner = home(&base);
        inner.recents.record("bar", &bar, None, None);
        inner.recents.record("foo", &foo, None, None);
        let key = inner.recents.find_by_dir(&bar).expect("bar is listed").key();

        let outcome = rename_recent(&mut inner, &key, "foo");
        assert!(matches!(outcome, Some(Err(RenameRefusal::Taken))));
        assert!(bar.is_dir(), "the folder must not have been renamed");
        assert!(!foo.exists());
        assert_eq!(
            inner.recents.find_by_key(&key).map(|entry| entry.dir.clone()),
            Some(bar),
            "the entry still points at the folder"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_rename_moves_the_folder_and_its_entry_together() {
        let base = temp_dir("ok");
        let bar = base.join("bar");
        std::fs::create_dir_all(&bar).expect("project folder");
        let mut inner = home(&base);
        inner.recents.record("bar", &bar, None, None);
        let key = inner.recents.find_by_dir(&bar).expect("bar is listed").key();

        let renamed = base.join("baz");
        let outcome = rename_recent(&mut inner, &key, "baz");
        assert!(matches!(outcome, Some(Ok(_))));
        assert!(renamed.is_dir());
        assert!(!bar.exists());
        assert!(inner.recents.find_by_dir(&renamed).is_some_and(|entry| entry.id == "baz"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_case_only_rename_is_not_a_collision() {
        let base = temp_dir("case");
        let bar = base.join("bar");
        std::fs::create_dir_all(&bar).expect("project folder");
        let case_insensitive = base.join("BAR").exists();
        let mut inner = home(&base);
        inner.recents.record("bar", &bar, None, None);
        let key = inner.recents.find_by_dir(&bar).expect("bar is listed").key();

        if case_insensitive {
            assert!(is_same_folder(&bar, &base.join("BAR")));
            let outcome = rename_recent(&mut inner, &key, "BAR");
            assert!(matches!(outcome, Some(Ok(_))), "a case-only rename must go through");
            let names: Vec<String> = std::fs::read_dir(&base)
                .expect("base")
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            assert!(names.contains(&"BAR".to_string()), "{names:?}");
        } else {
            // A distinct folder that merely differs in case is still refused.
            std::fs::create_dir_all(base.join("BAR")).expect("second folder");
            assert!(!is_same_folder(&bar, &base.join("BAR")));
            assert!(matches!(
                rename_recent(&mut inner, &key, "BAR"),
                Some(Err(RenameRefusal::Failed(_)))
            ));
        }
        // Another folder is never "the same".
        let other = base.join("other");
        std::fs::create_dir_all(&other).expect("other folder");
        assert!(!is_same_folder(&base.join("bar"), &other));
        let _ = std::fs::remove_dir_all(&base);
    }
}
