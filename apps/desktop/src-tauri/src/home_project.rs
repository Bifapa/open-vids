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
//! `NsFileManager` backend (`trashItemAtURL`) and drops the recent.
//! NsFileManager — not the crate's default Finder AppleScript, which shells
//! out to `osascript` and hangs without a GUI session — is load-bearing here;
//! verified live against the running app (see README Security notes).

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::home_routes::{json_field, respond, HomeInner, OpenPhase};
#[cfg(target_os = "macos")]
use trash::macos::TrashContextExtMacos;

pub fn handle_rename(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let id = json_field(body, "id").unwrap_or_default();
    let new_name = json_field(body, "new_name").unwrap_or_default();
    if !super::project::is_valid_project_id(&new_name) {
        let payload =
            serde_json::json!({ "error": format!("{new_name:?} is not a usable folder name") });
        respond(
            stream,
            400,
            "application/json",
            payload.to_string().as_bytes(),
        );
        return;
    }
    let outcome = state.lock().ok().and_then(|inner| {
        let entry = inner.recents.find_by_id(&id)?.clone();
        if matches!(inner.open_phase, OpenPhase::Opening { .. }) {
            return Some(Err(
                "a project is opening — try again in a moment".to_string()
            ));
        }
        // The folder name IS the Studio id, so the open project cannot move
        // out from under the running server (`#project/<id>` names it).
        // `current_id` is set when an open completes and cleared by
        // Show All Projects; the transient Opening phase above covers the
        // window between request and completion.
        if inner.current_id.as_deref() == Some(id.as_str()) {
            return Some(Err(
                "that project is open — use Show All Projects first".to_string()
            ));
        }
        let new_dir = entry.dir.parent()?.join(&new_name);
        if new_dir.exists() {
            return Some(Err(format!("{} already exists", new_dir.display())));
        }
        match std::fs::rename(&entry.dir, &new_dir) {
            Ok(()) => {
                update_meta_name(&new_dir, &new_name);
                // Dev serves projects through symlinks in the Studio data
                // dir; drop the stale one so it does not dangle at the old
                // id. Re-opening the renamed project re-links the new id.
                remove_dev_link(&entry.dir);
                Some(Ok((id.clone(), new_name.clone(), new_dir)))
            }
            Err(err) => Some(Err(format!("could not rename the folder: {err}"))),
        }
    });
    match outcome {
        Some(Ok((old, new, dir))) => {
            let renamed = state
                .lock()
                .ok()
                .map(|mut inner| inner.recents.rename(&old, &new, &dir))
                .unwrap_or(false);
            if renamed {
                respond(stream, 200, "application/json", br#"{"ok":true}"#);
            } else {
                respond(
                    stream,
                    409,
                    "application/json",
                    br#"{"error":"another project already uses that name"}"#,
                );
            }
        }
        Some(Err(error)) => {
            let payload = serde_json::json!({ "error": error }).to_string();
            respond(stream, 400, "application/json", payload.as_bytes());
        }
        None => respond(
            stream,
            404,
            "application/json",
            br#"{"error":"unknown project"}"#,
        ),
    }
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

pub fn handle_trash(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let id = json_field(body, "id").unwrap_or_default();
    let dir = state
        .lock()
        .ok()
        .and_then(|inner| inner.recents.find_by_id(&id).map(|e| e.dir.clone()));
    let Some(dir) = dir else {
        respond(
            stream,
            404,
            "application/json",
            br#"{"error":"unknown project"}"#,
        );
        return;
    };
    // macOS: NsFileManager, not the crate's default Finder AppleScript. The
    // Finder path shells out to `osascript` and hangs without a GUI session
    // to answer it (observed: the request never returns under `tauri dev`),
    // while `trashItemAtURL` is synchronous and needs no extra permissions.
    // Trade-off: no Finder "Put Back" undo entry. Other platforms keep the
    // crate default.
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
                inner.recents.remove(&id);
            }
            respond(stream, 200, "application/json", br#"{"ok":true}"#);
        }
        Err(err) => {
            let payload = serde_json::json!({ "error": format!("could not move the folder to Trash: {err}") });
            respond(
                stream,
                500,
                "application/json",
                payload.to_string().as_bytes(),
            );
        }
    }
}
