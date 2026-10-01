//! "Start a new project" from the Projects page: name derivation, file import
//! and the intake hand-off to Studio.
//!
//! Contract (shared with the Chat slice): the home creates the project, copies
//! the chosen files into `<project>/assets/` and writes
//! `<project>/.hyperframes/agent/intake.json`:
//!
//! ```json
//! { "version": 1, "prompt": "…", "intent": "plan"|"edit"|"ask",
//!   "model": {"provider","modelId"}|null, "thinking": "<effort>"|null,
//!   "agents": ["editor", …], "agentOverrides": { … },
//!   "files": [{ "path": "assets/a.mov", "name": "a.mov", "size": 1, "kind": "video" }],
//!   "createdAt": "<ISO>" }
//! ```
//!
//! Studio claims (reads once and deletes) it at boot and starts the chat turn.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::coded_error::CodedError;

/// Characters a folder name may not contain (Studio's project-id rule).
fn is_bad_name_char(c: char) -> bool {
    matches!(c, ':' | '/' | '\\') || (c as u32) < 0x20 || c as u32 == 0x7f
}

const STOP_WORDS: [&str; 15] = [
    "a", "an", "the", "from", "of", "with", "to", "and", "or", "in", "on", "for", "at", "by", "into",
];
const MAX_NAME: usize = 32;
const MEDIA_EXTS: [&str; 22] = [
    "mp4", "mov", "m4v", "webm", "mkv", "avi", "wav", "mp3", "m4a", "aac", "aif", "aiff", "flac",
    "ogg", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff",
];

/// The project folder name for a prompt + files, as the prototype derives it:
/// the prompt's first non-empty line → its first clause → at most 32
/// characters cut at a word boundary → trailing stop words dropped; without a
/// usable prompt, the first media file's base name; else "Untitled Project".
pub fn derive_name(prompt: &str, file_names: &[String]) -> String {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let clause: String = line
        .split(['.', ',', ';', ':', '—', '!', '?'])
        .next()
        .unwrap_or("")
        .chars()
        .map(|c| if is_bad_name_char(c) { ' ' } else { c })
        .collect();
    let words: Vec<&str> = clause.split_whitespace().collect();
    let mut kept: Vec<String> = Vec::new();
    for word in &words {
        let candidate = if kept.is_empty() {
            word.to_string()
        } else {
            format!("{} {word}", kept.join(" "))
        };
        if candidate.chars().count() > MAX_NAME {
            break;
        }
        kept.push(word.to_string());
    }
    if kept.is_empty() {
        if let Some(first) = words.first() {
            kept.push(first.chars().take(MAX_NAME).collect());
        }
    }
    while kept.len() > 1
        && kept
            .last()
            .map(|w| STOP_WORDS.contains(&w.to_lowercase().as_str()))
            .unwrap_or(false)
    {
        kept.pop();
    }
    let mut name = kept.join(" ").trim_start_matches(['.', ' ']).trim().to_string();
    if name.is_empty() {
        if let Some(file) = file_names.iter().find(|f| is_media_name(f)) {
            let base = match file.rfind('.') {
                Some(dot) if dot > 0 => &file[..dot],
                _ => file.as_str(),
            };
            let cleaned: String = base
                .chars()
                .map(|c| if is_bad_name_char(c) { ' ' } else { c })
                .collect();
            name = cleaned
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .trim_start_matches(['.', ' '])
                .chars()
                .take(MAX_NAME)
                .collect::<String>()
                .trim()
                .to_string();
        }
    }
    if name.is_empty() {
        "Untitled Project".to_string()
    } else {
        name
    }
}

fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_media_name(name: &str) -> bool {
    MEDIA_EXTS.contains(&extension(name).as_str())
}

/// `name`, or `name 2`, `name 3`, … — the first that `taken` does not claim.
pub fn unique_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{name} {n}");
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// The composer's chip kinds (icon + tooltip) for a file name.
pub fn chip_kind(name: &str) -> &'static str {
    match extension(name).as_str() {
        "mp4" | "mov" | "m4v" | "webm" | "mkv" | "avi" => "video",
        "wav" | "mp3" | "m4a" | "aac" | "aif" | "aiff" | "flac" | "ogg" => "audio",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "svg" | "tif" | "tiff" => "image",
        "srt" | "vtt" => "subtitle",
        "txt" | "md" | "pdf" | "doc" | "docx" | "rtf" | "fdx" => "document",
        "ttf" | "otf" | "woff" | "woff2" => "font",
        _ => "file",
    }
}

/// The intake contract's kinds: video | audio | image | font | other.
pub fn intake_kind(name: &str) -> &'static str {
    match chip_kind(name) {
        k @ ("video" | "audio" | "image" | "font") => k,
        _ => "other",
    }
}

/// Copy `source` into `dir` without overwriting: `a.mov`, then `a (2).mov`, …
/// (the naming Studio's own upload uses). Returns the written file name.
pub fn copy_without_overwrite(source: &Path, dir: &Path) -> std::io::Result<String> {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let dot = name.find('.').filter(|&i| i > 0 && !name.starts_with('.'));
    let (base, ext) = match dot {
        Some(i) => (&name[..i], &name[i..]),
        None => (name.as_str(), ""),
    };
    let mut candidate = name.clone();
    let mut n = 2;
    while dir.join(&candidate).exists() || std::fs::symlink_metadata(dir.join(&candidate)).is_ok() {
        candidate = format!("{base} ({n}){ext}");
        n += 1;
    }
    // std::fs::copy clones on APFS (copy-on-write), so same-volume imports of
    // multi-GB footage are instant.
    std::fs::copy(source, dir.join(&candidate))?;
    Ok(candidate)
}

#[derive(Debug, Clone)]
pub struct ImportedFile {
    pub rel_path: String,
    pub name: String,
    pub size: u64,
    pub kind: &'static str,
}

/// Copy every source file into `<project>/assets/`.
pub fn import_files(project: &Path, sources: &[PathBuf]) -> Result<Vec<ImportedFile>, CodedError> {
    let assets = project.join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| {
        CodedError::new(
            "assets_create_failed",
            format!("could not create assets/: {e}"),
            json!({ "detail": e.to_string() }),
        )
    })?;
    let mut out = Vec::new();
    for source in sources {
        let written = copy_without_overwrite(source, &assets).map_err(|e| {
            CodedError::new(
                "file_copy_failed",
                format!("could not copy {}: {e}", source.display()),
                json!({ "path": source.display().to_string(), "detail": e.to_string() }),
            )
        })?;
        let size = std::fs::metadata(assets.join(&written))
            .map(|m| m.len())
            .unwrap_or(0);
        out.push(ImportedFile {
            rel_path: format!("assets/{written}"),
            kind: intake_kind(&written),
            name: written,
            size,
        });
    }
    Ok(out)
}

/// Write `<project>/.hyperframes/agent/intake.json` atomically.
pub fn write_intake(project: &Path, intake: &serde_json::Value) -> std::io::Result<PathBuf> {
    let dir = project.join(".hyperframes").join("agent");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("intake.json");
    let tmp = dir.join(".intake.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(intake)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn name_is_the_first_clause_cut_at_a_word_boundary() {
        assert_eq!(
            derive_name(
                "Cut a 60-second teaser from the interview. Open on the city b-roll.",
                &[]
            ),
            "Cut a 60-second teaser"
        );
        assert_eq!(
            derive_name("\n\n  Make a recap: highlights only\nsecond line", &[]),
            "Make a recap"
        );
        // 32-char cap at a word boundary, then trailing stop words drop.
        assert_eq!(
            derive_name("Build a product teaser with music and motion titles", &[]),
            "Build a product teaser"
        );
    }

    #[test]
    fn name_strips_reserved_characters_and_leading_dots() {
        assert_eq!(derive_name("hidden/name\\with:colons", &[]), "hidden name");
        // A leading "." ends the first clause before it starts, as in the prototype.
        assert_eq!(derive_name("..hidden", &[]), "Untitled Project");
        assert_eq!(derive_name(" .x ,y", &[]), "Untitled Project");
        assert_eq!(derive_name("supercalifragilisticexpialidocious-and-more", &[]).chars().count(), 32);
    }

    #[test]
    fn name_falls_back_to_the_first_media_file_then_untitled() {
        assert_eq!(
            derive_name("  ", &names(&["script.pdf", "interview-a-cam.mov"])),
            "interview-a-cam"
        );
        assert_eq!(derive_name("", &names(&["notes.txt"])), "Untitled Project");
        assert_eq!(derive_name("!!!", &[]), "Untitled Project");
    }

    #[test]
    fn unique_name_appends_the_first_free_number() {
        let taken = ["Teaser", "Teaser 2", "Teaser 3"];
        assert_eq!(unique_name("Teaser", |n| taken.contains(&n)), "Teaser 4");
        assert_eq!(unique_name("Other", |n| taken.contains(&n)), "Other");
    }

    #[test]
    fn kinds_map_to_the_intake_contract() {
        assert_eq!(intake_kind("A.MOV"), "video");
        assert_eq!(intake_kind("bed.wav"), "audio");
        assert_eq!(intake_kind("logo.svg"), "image");
        assert_eq!(intake_kind("Inter.woff2"), "font");
        assert_eq!(intake_kind("script.pdf"), "other");
        assert_eq!(chip_kind("script.pdf"), "document");
        assert_eq!(chip_kind("captions.srt"), "subtitle");
    }

    #[test]
    fn import_never_overwrites_and_writes_the_intake() {
        let base = std::env::temp_dir().join(format!("openvids-intake-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        let project = base.join("project");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(project.join("assets")).unwrap();
        std::fs::write(src.join("clip.final.mov"), b"12345").unwrap();
        std::fs::write(project.join("assets").join("clip.final.mov"), b"old").unwrap();
        let imported = import_files(&project, &[src.join("clip.final.mov")]).unwrap();
        assert_eq!(imported[0].rel_path, "assets/clip (2).final.mov");
        assert_eq!(imported[0].size, 5);
        assert_eq!(imported[0].kind, "video");
        assert_eq!(std::fs::read(project.join("assets/clip.final.mov")).unwrap(), b"old");

        let path = write_intake(&project, &serde_json::json!({"version": 1})).unwrap();
        assert_eq!(path, project.join(".hyperframes/agent/intake.json"));
        assert!(!project.join(".hyperframes/agent/.intake.json.tmp").exists());
    }
}
