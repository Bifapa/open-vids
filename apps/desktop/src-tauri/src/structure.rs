//! What counts as a HyperFrames project folder, and reading its dimensions.
//!
//! The rule mirrors what Studio and the CLI actually enforce:
//! - `packages/studio/src/utils/projectRouting.ts` (`isValidProjectId`) and
//!   `packages/studio/vite.adapter.ts` (`listProjects`): the folder name is a
//!   single path segment and the folder holds `index.html` (or
//!   `<name>.html`).
//! - `packages/cli/src/utils/project.ts` (`resolveProjectOrThrow`): an
//!   existing directory with `index.html` (unless `--composition` names
//!   another entry — the desktop always opens the directory itself, so
//!   `index.html` is required).
//!
//! Marker files (`hyperframes.json` / `meta.json` / `project.json`, see
//! `packages/core/src/projectRule.ts`) are what `init` writes, but Studio
//! opens folders without them, so they are not required here.

use std::path::Path;

use super::project::{validate, Project, ProjectError};

use super::coded_error::CodedError;

/// Why a folder is not openable as a project.
#[derive(Debug)]
pub enum StructureError {
    Project(ProjectError),
    MissingIndex,
    NoComposition,
}

impl std::fmt::Display for StructureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Project(err) => write!(f, "{err}"),
            Self::MissingIndex => write!(
                f,
                "no index.html found — this folder is not a HyperFrames project"
            ),
            Self::NoComposition => write!(
                f,
                "index.html has no composition (it needs a data-composition-id element)"
            ),
        }
    }
}

impl StructureError {
    /// The same sentence as `Display`, with the code and params the page translates it by.
    pub fn coded(&self) -> CodedError {
        match self {
            Self::Project(err) => err.coded(),
            Self::MissingIndex => CodedError::plain("missing_index", self.to_string()),
            Self::NoComposition => CodedError::plain("no_composition", self.to_string()),
        }
    }
}

impl std::error::Error for StructureError {}

/// Validate the directory *and* its HyperFrames structure.
pub fn validate_structure(dir: &Path) -> Result<Project, StructureError> {
    let project = validate(dir).map_err(StructureError::Project)?;
    let index = project.dir.join("index.html");
    if !index.is_file() {
        return Err(StructureError::MissingIndex);
    }
    match std::fs::read_to_string(&index) {
        Ok(html) => {
            if !is_composition_source(&html) {
                return Err(StructureError::NoComposition);
            }
        }
        Err(_) => return Err(StructureError::MissingIndex),
    }
    Ok(project)
}

/// The composition-source test, restated from
/// `packages/studio-server/src/helpers/hfIdPersist.ts` (`isCompositionSource`).
/// Studio's own project listing (`routes/projects.ts`) counts an HTML file as
/// a composition when it carries `data-composition-id`.
pub fn is_composition_source(html: &str) -> bool {
    html.contains("data-composition-id")
}

/// Composition dimensions from the root element, for card placeholders.
/// Falls back to 1920×1080 when absent or unparsable.
pub fn composition_dimensions(html: &str) -> (u32, u32) {
    (attr_u32(html, "data-width"), attr_u32(html, "data-height"))
        .pipe(|(w, h)| (w.unwrap_or(1920), h.unwrap_or(1080)))
}

fn attr_u32(html: &str, attr: &str) -> Option<u32> {
    html.find(attr).and_then(|i| {
        let rest = &html[i + attr.len()..];
        let rest = rest.trim_start_matches(['=', ' ', '\t', '\n', '\r']);
        let quote = rest.as_bytes().first()?;
        if *quote != b'"' && *quote != b'\'' {
            return None;
        }
        let rest = &rest[1..];
        let end = rest.find(*quote as char)?;
        rest[..end].trim().parse::<u32>().ok()
    })
}

trait Pipe: Sized {
    fn pipe<R>(self, f: impl FnOnce(Self) -> R) -> R {
        f(self)
    }
}

impl<T> Pipe for T {}

/// patch the root composition's fps (`data-fps`).
/// Returns None when no composition root was found.
pub fn set_composition_fps(html: &str, fps: &str) -> Option<String> {
    set_root_attr(html, "data-fps", &fps.replace('"', ""))
}

/// Patch the root composition's duration (`data-duration`).
pub fn set_composition_duration(html: &str, seconds: f64) -> Option<String> {
    set_root_attr(html, "data-duration", &format!("{seconds}"))
}

/// Patch the stage dimensions (data-width/data-height, inline body CSS,
/// viewport meta). Custom W×H arrives here after the form validated it.
pub fn set_composition_dimensions(html: &str, width: u32, height: u32) -> Option<String> {
    let mut out = set_root_attr(html, "data-width", &width.to_string())?;
    out = set_root_attr(&out, "data-height", &height.to_string())?;
    out = replace_body_css_dim(&out, width, height);
    out = replace_viewport_meta(&out, width, height);
    Some(out)
}

fn set_root_attr(html: &str, attr: &str, value: &str) -> Option<String> {
    let marker = "data-composition-id";
    let start = html.find(marker)?;
    let tag_start = html[..start].rfind('<')?;
    let after = &html[start..];
    let rel_end = after.find('>')?;
    let tag_end = start + rel_end;
    let mut tag = html[tag_start..=tag_end].to_string();
    if let Some(pos) = find_attr(&tag, attr) {
        let (vs, ve) = attr_value_range(&tag, pos, attr)?;
        tag.replace_range(vs..ve, &format!("\"{value}\""));
    } else {
        tag.insert_str(tag.len() - 1, &format!(" {attr}=\"{value}\""));
    }
    let mut out = html.to_string();
    out.replace_range(tag_start..=tag_end, &tag);
    Some(out)
}

fn find_attr(tag: &str, attr: &str) -> Option<usize> {
    let mut search = 0;
    while let Some(pos) = tag[search..].find(attr) {
        let abs = search + pos;
        let before = abs == 0 || !tag[..abs].ends_with(|c: char| c.is_alphanumeric() || c == '-');
        let after_ok = tag[abs + attr.len()..]
            .chars()
            .next()
            .map(|c| c == '=' || c.is_whitespace())
            .unwrap_or(false);
        if before && after_ok {
            return Some(abs);
        }
        search = abs + attr.len();
    }
    None
}

fn attr_value_range(tag: &str, pos: usize, attr: &str) -> Option<(usize, usize)> {
    let mut i = pos + attr.len();
    let bytes = tag.as_bytes();
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t' || bytes[i] == b'=') {
        i += 1;
    }
    let q = *bytes.get(i)?;
    if q != b'"' && q != b'\'' {
        return None;
    }
    let close = tag[i + 1..].find(q as char)?;
    Some((i, i + 1 + close + 1))
}

fn replace_body_css_dim(html: &str, width: u32, height: u32) -> String {
    // Handles `width: 1920px … height: 1080px` in either order inside the
    // inline `html, body` CSS the templates ship. Unknown shapes are left
    // untouched — dimensions still apply via data-width/data-height.
    let mut out = html.to_string();
    let patterns: [(&str, &str); 2] = [("width:", "height:"), ("height:", "width:")];
    for (first, second) in patterns {
        if let (Some(a), Some(b)) = (out.find(first), out.find(second)) {
            let (wpos, hpos) = if first == "width:" { (a, b) } else { (b, a) };
            if let (Some((ws, we)), Some((hs, he))) =
                (css_px_range(&out, wpos), css_px_range(&out, hpos))
            {
                // Replace the later range first so the earlier offsets hold.
                if hs > ws {
                    out.replace_range(hs..he, &height.to_string());
                    out.replace_range(ws..we, &width.to_string());
                } else {
                    out.replace_range(ws..we, &width.to_string());
                    out.replace_range(hs..he, &height.to_string());
                }
                break;
            }
        }
    }
    out
}

fn css_px_range(text: &str, label_at: usize) -> Option<(usize, usize)> {
    let after = &text[label_at..];
    let num_start = after.find(|c: char| c.is_ascii_digit())?;
    let abs = label_at + num_start;
    let mut end = abs;
    while end < text.len() && text.as_bytes()[end].is_ascii_digit() {
        end += 1;
    }
    if text[end..].starts_with("px") {
        Some((abs, end))
    } else {
        None
    }
}

fn replace_viewport_meta(html: &str, width: u32, height: u32) -> String {
    if let Some(pos) = html.find("name=\"viewport\"") {
        let tag_start = html[..pos].rfind('<').unwrap_or(0);
        let after = &html[pos..];
        if let Some(rel_end) = after.find('>') {
            let tag_end = pos + rel_end;
            let mut tag = html[tag_start..=tag_end].to_string();
            tag = replace_meta_dim(&tag, "width", width);
            tag = replace_meta_dim(&tag, "height", height);
            let mut out = html.to_string();
            out.replace_range(tag_start..=tag_end, &tag);
            return out;
        }
    }
    html.to_string()
}

fn replace_meta_dim(tag: &str, dim: &str, value: u32) -> String {
    // Matches `width=1920` / `width = 1920` inside the content attribute.
    let mut out = tag.to_string();
    let mut search = 0;
    while let Some(pos) = out[search..].find(dim) {
        let abs = search + pos;
        let mut i = abs + dim.len();
        let bytes = out.as_bytes();
        while i < bytes.len() && bytes[i] == b' ' {
            i += 1;
        }
        if bytes.get(i) != Some(&b'=') {
            search = abs + dim.len();
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i] == b' ' {
            i += 1;
        }
        let mut end = i;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > i {
            out.replace_range(i..end, &value.to_string());
            break;
        }
        search = abs + dim.len();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMP: &str = r#"<!doctype html><html><body><div id="root" data-composition-id="main" data-start="0" data-duration="10" data-width="1920" data-height="1080"></div></body></html>"#;

    #[test]
    fn rejects_folders_without_index() {
        let dir = std::env::temp_dir().join("openvids-noidx");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(matches!(
            validate_structure(&dir),
            Err(StructureError::MissingIndex)
        ));
    }

    #[test]
    fn rejects_index_without_a_composition() {
        let dir = std::env::temp_dir().join("openvids-nocomp");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<html><body>hello</body></html>").unwrap();
        assert!(matches!(
            validate_structure(&dir),
            Err(StructureError::NoComposition)
        ));
    }

    #[test]
    fn accepts_a_real_composition() {
        let dir = std::env::temp_dir().join("openvids-ok");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), COMP).unwrap();
        let project = validate_structure(&dir).unwrap();
        assert_eq!(project.id, "openvids-ok");
    }

    #[test]
    fn reads_dimensions_with_fallback() {
        assert_eq!(composition_dimensions(COMP), (1920, 1080));
        assert_eq!(composition_dimensions("<html></html>"), (1920, 1080));
    }

    #[test]
    fn sets_fps_and_dimensions() {
        let with_fps = set_composition_fps(COMP, "24").unwrap();
        assert!(with_fps.contains("data-fps=\"24\""));
        let twice = set_composition_fps(&with_fps, "60").unwrap();
        assert!(twice.contains("data-fps=\"60\""));
        assert!(!twice.contains("data-fps=\"24\""));
        let sized = set_composition_dimensions(COMP, 1080, 1920).unwrap();
        assert!(sized.contains("data-width=\"1080\""));
        assert!(sized.contains("data-height=\"1920\""));
        let (w, h) = composition_dimensions(&sized);
        assert_eq!((w, h), (1080, 1920));
        let timed = set_composition_duration(COMP, 15.0).unwrap();
        assert!(timed.contains("data-duration=\"15\""));
    }
}
