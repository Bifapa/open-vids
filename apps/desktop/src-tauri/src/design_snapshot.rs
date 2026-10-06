//! Copying a library design system into a project (the snapshot) and linking it from a new project.
//!
//! `<project>/design/{system.html, tokens.css, logo.*, fonts/*, design.json}`, copied verbatim from the library's
//! top level (the thumbnail is not copied), `design.json` last: `{schema: "openvids.project-design/1", id,
//! version, name, attachedAt, createdAt, unknownLicenses, nonPortableFonts}` (the key order of `AttachedDesign`, 2-space
//! pretty JSON and a trailing newline: what the Studio server writes, byte for byte). The files are built in a
//! staging folder inside the project and swapped in as a whole, so a failure leaves the previous `design/` (or
//! none), never half of one, and nothing outside `design/` is written. [`DesignLibrary::attach_to_new_project`]
//! also links `design/tokens.css` from the new project's `index.html` (a fresh project has nothing to recolour):
//! compositions only pick the system up through that link.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::design_library::{
    allowed_segments, now_ms, write_atomic, AttachedDesign, DesignError, DesignLibrary, PROJECT_SCHEMA,
};
use super::design_lock;

const TOKENS_HREF: &str = "design/tokens.css";

// ── The project snapshot ────────────────────────────────────────────────────

impl DesignLibrary {
    /// The files of `id`'s top level that make a snapshot, as `(relative path, source)`: `system.html`,
    /// `tokens.css` (both required), then `logo.*` and `fonts/*`, each sorted. Links are not followed.
    fn snapshot_sources(&self, id: &str) -> Result<Vec<(String, PathBuf)>, DesignError> {
        let dir = self.existing_dir(id)?;
        let regular = |path: &Path| std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file());
        let mut sources = Vec::new();
        for required in ["system.html", "tokens.css"] {
            let path = dir.join(required);
            if !regular(&path) {
                return Err(DesignError::new(
                    "invalid_system",
                    format!("the design system {id:?} has no {required}"),
                ));
            }
            sources.push((required.to_string(), path));
        }
        let names_in = |folder: &Path| -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(folder)
                .map(|entries| entries.flatten().filter_map(|e| e.file_name().into_string().ok()).collect())
                .unwrap_or_default();
            names.sort();
            names
        };
        for name in names_in(&dir) {
            if allowed_segments(&name).is_some_and(|parts| name.starts_with("logo.") && parts.len() == 1) && regular(&dir.join(&name)) {
                sources.push((name.clone(), dir.join(&name)));
            }
        }
        let fonts = dir.join("fonts");
        if std::fs::symlink_metadata(&fonts).is_ok_and(|meta| meta.is_dir()) {
            for name in names_in(&fonts) {
                let rel = format!("fonts/{name}");
                if allowed_segments(&rel).is_some() && regular(&fonts.join(&name)) {
                    sources.push((rel, fonts.join(&name)));
                }
            }
        }
        Ok(sources)
    }

    /// Copies the system's current version into `<project>/design/` (layout in the module docs) and returns the
    /// `design.json` it wrote. The library is held under its lock while it is read, so a write in progress never
    /// shows through. On any failure the project is left as it was.
    pub fn snapshot_into(&self, project_dir: &Path, id: &str) -> Result<AttachedDesign, DesignError> {
        self.existing_dir(id)?;
        if !project_dir.is_dir() {
            return Err(DesignError::unavailable(
                "copy the design system",
                format!("{} is not a folder", project_dir.display()),
            ));
        }
        let design = project_dir.join("design");
        if std::fs::symlink_metadata(&design).is_ok_and(|meta| !meta.is_dir()) {
            return Err(DesignError::unavailable("copy the design system", "design exists and is not a folder"));
        }
        let _lock = self.lock()?;
        let summary = self.summary(id)?;
        if let Some(manifest) = self.read_manifest(id)? {
            let stored = manifest.get("version").and_then(Value::as_u64);
            if stored.is_some_and(|stored| stored != u64::from(summary.version)) {
                return Err(DesignError::new(
                    "conflict",
                    format!("the design system {id:?} is being updated; try again in a moment"),
                ));
            }
        }
        let sources = self.snapshot_sources(id)?;
        let record = AttachedDesign {
            schema: PROJECT_SCHEMA,
            id: summary.id,
            version: summary.version,
            name: summary.name,
            attached_at: now_ms(),
            created_at: summary.created_at,
            unknown_licenses: summary.unknown_licenses,
            non_portable_fonts: summary.non_portable_fonts,
        };
        // Staged under `.hyperframes/` like Studio's attach does, so the preview signature and the history never
        // see a half-built folder; the folder is removed again when this call made it and nothing else is in it.
        let work = project_dir.join(".hyperframes");
        let made_work = std::fs::symlink_metadata(&work).is_err();
        let tag = format!("{}-{}", std::process::id(), design_lock::random_hex());
        let stage = work.join(format!("design-staging-{tag}"));
        let aside = work.join(format!("design-previous-{tag}"));
        let staged = std::fs::create_dir_all(&work)
            .and_then(|()| stage_snapshot(&stage, &sources, &record))
            .and_then(|()| swap_in(&stage, &design, &aside));
        if staged.is_err() {
            let _ = std::fs::remove_dir_all(&stage);
        }
        if made_work {
            let _ = std::fs::remove_dir(&work);
        }
        staged.map_err(|e| DesignError::unavailable("copy the design system into the project", e))?;
        Ok(record)
    }

    /// The new-project flow: the snapshot, then the stylesheet link in the project's root `index.html`. When the
    /// snapshot fails nothing is written; when only the link fails the (complete) snapshot stays, as attaching
    /// from Studio would leave it.
    pub fn attach_to_new_project(&self, project_dir: &Path, id: &str) -> Result<AttachedDesign, DesignError> {
        let record = self.snapshot_into(project_dir, id)?;
        link_tokens(project_dir).map_err(|e| DesignError::unavailable("link design/tokens.css from index.html", e))?;
        Ok(record)
    }
}

/// Builds the snapshot in `stage`: the copied files, then `design.json` last.
fn stage_snapshot(stage: &Path, sources: &[(String, PathBuf)], record: &AttachedDesign) -> std::io::Result<()> {
    std::fs::create_dir(stage)?;
    for (rel, source) in sources {
        let target = stage.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(source, target)?;
    }
    let mut json = serde_json::to_string_pretty(record)?;
    json.push('\n');
    std::fs::write(stage.join("design.json"), json)
}

/// Replaces `<project>/design` by `stage` as a whole (the old one waits at `aside`); on failure the previous
/// `design/` is put back.
fn swap_in(stage: &Path, design: &Path, aside: &Path) -> std::io::Result<()> {
    let previous = match std::fs::symlink_metadata(design) {
        Ok(_) => {
            std::fs::rename(design, aside)?;
            Some(aside)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err),
    };
    if let Err(err) = std::fs::rename(stage, design) {
        if let Some(aside) = &previous {
            let _ = std::fs::rename(aside, design);
        }
        return Err(err);
    }
    if let Some(aside) = previous {
        let _ = std::fs::remove_dir_all(aside);
    }
    Ok(())
}

// ── The stylesheet link ─────────────────────────────────────────────────────

/// Whether some `<link>` of `html` already points at `design/tokens.css`.
fn links_tokens(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<link") {
        let open = from + found + "<link".len();
        let end = lower[open..].find('>').map_or(lower.len(), |len| open + len);
        if lower[open..end].contains(TOKENS_HREF) {
            return true;
        }
        from = end;
    }
    false
}

/// `html` with `<link rel="stylesheet" href="design/tokens.css">` as the last child of its `<head>`; `None` when
/// it already links that file or has no `<head>`.
fn with_tokens_link(html: &str) -> Option<String> {
    if links_tokens(html) {
        return None;
    }
    let close = html.to_ascii_lowercase().find("</head")?;
    let line_start = html[..close].rfind('\n').map_or(0, |at| at + 1);
    let indent: String = html[line_start..close].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
    let link = format!("<link rel=\"stylesheet\" href=\"{TOKENS_HREF}\" />");
    let mut out = String::with_capacity(html.len() + link.len() + indent.len() + 3);
    if html[line_start..close].trim().is_empty() {
        // `</head>` stands on its own line: the link takes a line of its own above it, one level deeper.
        out.push_str(&html[..line_start]);
        out.push_str(&format!("{indent}  {link}\n"));
        out.push_str(&html[line_start..]);
    } else {
        out.push_str(&html[..close]);
        out.push_str(&link);
        out.push_str(&html[close..]);
    }
    Some(out)
}

/// Links `design/tokens.css` from `<project>/index.html`. Idempotent: a template that already links it is left
/// alone. One without a `<head>` is an error (there is nowhere to put the link).
fn link_tokens(project_dir: &Path) -> std::io::Result<()> {
    let path = project_dir.join("index.html");
    let html = String::from_utf8(std::fs::read(&path)?)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "index.html is not UTF-8"))?;
    if links_tokens(&html) {
        return Ok(());
    }
    let linked = with_tokens_link(&html)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "index.html has no <head>"))?;
    write_atomic(&path, linked.as_bytes())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::design_library::fixtures::{write_system, MANIFEST_HTML};
    use crate::design_lock::scratch::Dir;
    use serde_json::json;

    /// The blank template's head, as `create.rs` stamps it.
    const BLANK: &str = "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <style>\n      body { margin: 0; }\n    </style>\n  </head>\n  <body></body>\n</html>\n";

    struct Fixture {
        library_dir: Dir,
        project_dir: Dir,
        library: DesignLibrary,
    }

    fn fixture(label: &str) -> Fixture {
        let library_dir = Dir::new(&format!("{label}-lib"));
        let project_dir = Dir::new(&format!("{label}-project"));
        write_system(library_dir.path(), "brand", "Brand Kit", 10);
        std::fs::write(project_dir.path().join("index.html"), BLANK).expect("index.html");
        std::fs::write(project_dir.path().join("meta.json"), "{\"id\":\"p\"}").expect("meta.json");
        let library = DesignLibrary::at(library_dir.path().to_path_buf());
        Fixture { library_dir, project_dir, library }
    }

    /// Every file under `dir`, relative with `/`, sorted.
    fn tree(dir: &Path) -> Vec<String> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir).expect("dir").flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
                if entry.path().is_dir() {
                    walk(&entry.path(), &format!("{name}/"), out);
                } else {
                    out.push(name);
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, "", &mut out);
        out
    }

    #[test]
    fn snapshot_copies_the_top_level_and_writes_design_json_last() {
        let f = fixture("snap-layout");
        let record = f.library.snapshot_into(f.project_dir.path(), "brand").expect("snapshot");
        let project = f.project_dir.path();
        assert_eq!(
            tree(project),
            [
                "design/design.json",
                "design/fonts/inter-400.woff2",
                "design/logo.svg",
                "design/system.html",
                "design/tokens.css",
                "index.html",
                "meta.json",
            ],
            "no thumbnail, no versions, no staging leftovers"
        );
        for rel in ["system.html", "tokens.css", "logo.svg", "fonts/inter-400.woff2"] {
            assert_eq!(
                std::fs::read(project.join("design").join(rel)).expect(rel),
                std::fs::read(f.library_dir.path().join("brand").join(rel)).expect(rel),
                "{rel} is copied verbatim"
            );
        }
        assert_eq!(std::fs::read(project.join("index.html")).expect("index"), BLANK.as_bytes(), "a snapshot alone edits no composition");

        assert_eq!((record.id.as_str(), record.version, record.name.as_str()), ("brand", 1, "Brand Kit"));
        assert!(record.attached_at > 1_700_000_000_000);
        let text = std::fs::read_to_string(project.join("design/design.json")).expect("design.json");
        let expected = format!(
            "{{\n  \"schema\": \"openvids.project-design/1\",\n  \"id\": \"brand\",\n  \"version\": 1,\n  \"name\": \"Brand Kit\",\n  \"attachedAt\": {},\n  \"createdAt\": 1000,\n  \"unknownLicenses\": [\n    \"logo\"\n  ],\n  \"nonPortableFonts\": [\n    \"Helvetica\"\n  ]\n}}\n",
            record.attached_at
        );
        assert_eq!(text, expected, "key order, 2-space pretty JSON, trailing newline");
        assert!(!f.library_dir.path().join(".lock").exists(), "the library lock is released");
    }

    #[test]
    fn snapshot_of_a_system_without_fonts_or_logo_writes_empty_lists() {
        let f = fixture("snap-bare");
        let brand = f.library_dir.path().join("brand");
        std::fs::remove_dir_all(brand.join("fonts")).expect("fonts");
        std::fs::remove_file(brand.join("logo.svg")).expect("logo");
        let mut meta = crate::design_library::fixtures::meta("brand", "Brand Kit", 10);
        meta["unknownLicenses"] = json!([]);
        meta["nonPortableFonts"] = json!([]);
        std::fs::write(brand.join("meta.json"), meta.to_string()).expect("meta");
        f.library.snapshot_into(f.project_dir.path(), "brand").expect("snapshot");
        assert_eq!(tree(&f.project_dir.path().join("design")), ["design.json", "system.html", "tokens.css"]);
        let text = std::fs::read_to_string(f.project_dir.path().join("design/design.json")).expect("design.json");
        assert!(text.contains("\"unknownLicenses\": [],\n  \"nonPortableFonts\": []\n}\n"), "{text}");
    }

    #[test]
    fn design_json_carries_the_library_entrys_created_at_after_attached_at() {
        let f = fixture("snap-created");
        // A system deleted and recreated under the same id has a new `createdAt`: the snapshot records which one it is of.
        let mut meta = crate::design_library::fixtures::meta("brand", "Brand Kit", 10);
        meta["createdAt"] = json!(1_777_000_000_123u64);
        std::fs::write(f.library_dir.path().join("brand/meta.json"), meta.to_string()).expect("meta");
        let record = f.library.snapshot_into(f.project_dir.path(), "brand").expect("snapshot");
        assert_eq!(record.created_at, 1_777_000_000_123);
        let text = std::fs::read_to_string(f.project_dir.path().join("design/design.json")).expect("design.json");
        let keys: Vec<&str> = text
            .lines()
            .filter(|line| line.starts_with("  \""))
            .filter_map(|line| line.trim_start().split('"').nth(1))
            .collect();
        assert_eq!(
            keys,
            ["schema", "id", "version", "name", "attachedAt", "createdAt", "unknownLicenses", "nonPortableFonts"],
            "the key order of the TypeScript writer (`attachedJson`)"
        );
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(parsed["createdAt"], 1_777_000_000_123u64);
    }

    #[test]
    fn snapshot_replaces_a_previous_design_folder_as_a_whole() {
        let f = fixture("snap-replace");
        let design = f.project_dir.path().join("design");
        std::fs::create_dir_all(design.join("fonts")).expect("old fonts");
        std::fs::write(design.join("fonts/old.woff2"), "old").expect("old font");
        std::fs::write(design.join("logo.png"), "old logo").expect("old logo");
        f.library.snapshot_into(f.project_dir.path(), "brand").expect("snapshot");
        assert_eq!(
            tree(&design),
            ["design.json", "fonts/inter-400.woff2", "logo.svg", "system.html", "tokens.css"],
            "the old snapshot's files are gone"
        );
        assert_eq!(tree(f.project_dir.path()).len(), 7, "no staging or previous folders left");
    }

    #[test]
    fn snapshot_refuses_what_is_not_a_complete_system() {
        let f = fixture("snap-refuse");
        let project = f.project_dir.path();
        let before = tree(project);
        for (id, code) in [("missing", "not_found"), ("../brand", "invalid_request"), ("", "invalid_request")] {
            assert_eq!(f.library.snapshot_into(project, id).expect_err(id).code, code, "{id:?}");
        }
        let brand = f.library_dir.path().join("brand");
        std::fs::remove_file(brand.join("tokens.css")).expect("tokens.css");
        let err = f.library.snapshot_into(project, "brand").expect_err("no tokens.css");
        assert_eq!((err.code, err.status()), ("invalid_system", 422), "{err}");
        assert_eq!(tree(project), before, "nothing was written");
        assert!(f.library.snapshot_into(&project.join("not-there"), "brand").is_err());
    }

    #[test]
    fn snapshot_refuses_a_manifest_of_another_version_than_the_entry() {
        let f = fixture("snap-version");
        let html = MANIFEST_HTML.replace("\"version\":1", "\"version\":2");
        std::fs::write(f.library_dir.path().join("brand/system.html"), html).expect("system.html");
        let err = f.library.snapshot_into(f.project_dir.path(), "brand").expect_err("out of sync");
        assert_eq!(err.code, "conflict");
        assert!(!f.project_dir.path().join("design").exists());
    }

    #[test]
    fn snapshot_never_replaces_a_design_file_outside_the_design_folder_contract() {
        let f = fixture("snap-file");
        let design = f.project_dir.path().join("design");
        std::fs::write(&design, "a file named design").expect("file");
        let err = f.library.snapshot_into(f.project_dir.path(), "brand").expect_err("design is a file");
        assert_eq!(err.code, "unavailable");
        assert_eq!(std::fs::read_to_string(&design).expect("file"), "a file named design");
        assert_eq!(tree(f.project_dir.path()), ["design", "index.html", "meta.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_leaves_no_partial_design_and_keeps_the_previous_one() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture("snap-fail");
        let unreadable = f.library_dir.path().join("brand/fonts/zzz-unreadable.woff2");
        std::fs::write(&unreadable, "x").expect("font");
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        if std::fs::read(&unreadable).is_ok() {
            // Running with rights that ignore file modes (root): the failure cannot be provoked.
            return;
        }
        let project = f.project_dir.path();

        let err = f.library.snapshot_into(project, "brand").expect_err("an unreadable font");
        assert_eq!(err.code, "unavailable");
        assert_eq!(tree(project), ["index.html", "meta.json"], "no design/, no staging folder");

        let design = project.join("design");
        std::fs::create_dir_all(&design).expect("previous design");
        std::fs::write(design.join("design.json"), "previous").expect("previous design.json");
        f.library.snapshot_into(project, "brand").expect_err("still failing");
        assert_eq!(tree(project), ["design/design.json", "index.html", "meta.json"]);
        assert_eq!(std::fs::read_to_string(design.join("design.json")).expect("previous"), "previous");
        assert!(!f.library_dir.path().join(".lock").exists(), "the lock is released on failure too");
    }

    #[test]
    fn the_stylesheet_link_goes_last_in_the_head_and_only_once() {
        let linked = with_tokens_link(BLANK).expect("linked");
        assert_eq!(
            linked,
            BLANK.replace(
                "    </style>\n  </head>",
                "    </style>\n    <link rel=\"stylesheet\" href=\"design/tokens.css\" />\n  </head>"
            )
        );
        assert_eq!(with_tokens_link(&linked), None, "idempotent");
        assert!(links_tokens(&linked));
        for already in [
            "<head><link rel=\"stylesheet\" href=\"design/tokens.css\"></head>",
            "<HEAD><LINK HREF='./design/tokens.css' REL=stylesheet></HEAD>",
            "<head><link href=\"design/tokens.css\"\n rel=\"stylesheet\" /></head>",
        ] {
            assert!(links_tokens(already), "{already}");
            assert_eq!(with_tokens_link(already), None);
        }
        // A link to another sheet does not count; a `<link>` tag-lookalike does not either.
        assert!(!links_tokens("<head><link rel=\"stylesheet\" href=\"style.css\"><linked></head>"));
        assert_eq!(
            with_tokens_link("<html><HEAD><title>x</title></HEAD><body/></html>").as_deref(),
            Some("<html><HEAD><title>x</title><link rel=\"stylesheet\" href=\"design/tokens.css\" /></HEAD><body/></html>")
        );
        assert_eq!(with_tokens_link("<html><body></body></html>"), None, "no head to put it in");
    }

    #[test]
    fn a_new_project_gets_the_snapshot_and_the_link() {
        let f = fixture("snap-new");
        let project = f.project_dir.path();
        f.library.attach_to_new_project(project, "brand").expect("attach");
        let index = std::fs::read_to_string(project.join("index.html")).expect("index");
        assert_eq!(index.matches("design/tokens.css").count(), 1);
        assert!(index.find("design/tokens.css") < index.find("</head>"));
        assert!(project.join("design/tokens.css").is_file());
        // Attaching again (a retry) neither duplicates the link nor fails.
        f.library.attach_to_new_project(project, "brand").expect("attach again");
        assert_eq!(std::fs::read_to_string(project.join("index.html")).expect("index"), index);
    }

    #[test]
    fn a_template_that_already_links_the_tokens_is_not_touched() {
        let f = fixture("snap-linked");
        let project = f.project_dir.path();
        let own = "<html><head><link rel=\"stylesheet\" href=\"design/tokens.css\"></head><body></body></html>";
        std::fs::write(project.join("index.html"), own).expect("index");
        f.library.attach_to_new_project(project, "brand").expect("attach");
        assert_eq!(std::fs::read_to_string(project.join("index.html")).expect("index"), own);
    }

    #[test]
    fn when_only_the_link_fails_the_complete_snapshot_stays() {
        let f = fixture("snap-nohead");
        let project = f.project_dir.path();
        std::fs::write(project.join("index.html"), "<div>no head</div>").expect("index");
        let err = f.library.attach_to_new_project(project, "brand").expect_err("no head");
        assert_eq!(err.code, "unavailable");
        assert!(project.join("design/design.json").is_file() && project.join("design/tokens.css").is_file());
        assert_eq!(std::fs::read_to_string(project.join("index.html")).expect("index"), "<div>no head</div>");
        std::fs::remove_file(project.join("index.html")).expect("remove");
        assert!(f.library.attach_to_new_project(project, "brand").is_err(), "a project without index.html cannot be linked");
    }
}
