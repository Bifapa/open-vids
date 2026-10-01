//! Per-project numbers for the Projects page: duration and clip count.
//!
//! Both come from the project's `index.html`, the file Studio edits:
//! - duration: the root composition's `data-duration` (seconds); when it is
//!   absent, the furthest `data-start + data-duration` end of any timed element;
//! - clips: elements whose `class` carries the `clip` token — the HyperFrames
//!   convention for timeline clips (see the root AGENTS.md).
//!
//! Parsing is a small tag scanner, not a DOM: it only needs start tags and
//! their attributes. Results are cached per file, keyed by the file's size and
//! modification time, so the home page can ask on every load.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProjectMeta {
    pub duration: f64,
    pub clips: u32,
}

/// Start tags of `html` as attribute lists (name lowercased, value raw).
fn start_tags(html: &str) -> Vec<Vec<(String, String)>> {
    let bytes = html.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = html[i..].find('<') {
        let start = i + rel;
        let rest = &html[start..];
        if rest.starts_with("<!--") {
            i = rest.find("-->").map(|e| start + e + 3).unwrap_or(bytes.len());
            continue;
        }
        let next = bytes.get(start + 1).copied().unwrap_or(b' ');
        if !next.is_ascii_alphabetic() {
            i = start + 1;
            continue;
        }
        // Find the closing '>' outside quotes.
        let mut j = start + 1;
        let mut quote: Option<u8> = None;
        while j < bytes.len() {
            let b = bytes[j];
            match quote {
                Some(q) if b == q => quote = None,
                Some(_) => {}
                None if b == b'"' || b == b'\'' => quote = Some(b),
                None if b == b'>' => break,
                None => {}
            }
            j += 1;
        }
        let tag = &html[start + 1..j.min(bytes.len())];
        let name_end = tag
            .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .unwrap_or(tag.len());
        let name = tag[..name_end].to_ascii_lowercase();
        out.push(parse_attrs(&tag[name_end..]));
        i = j.saturating_add(1);
        // Raw-text elements: skip their bodies so markup inside scripts or
        // styles is never mistaken for clips.
        if name == "script" || name == "style" {
            let close = format!("</{name}");
            i = html[i.min(html.len())..]
                .to_ascii_lowercase()
                .find(&close)
                .map(|e| i + e)
                .unwrap_or(bytes.len());
        }
        if i >= bytes.len() {
            break;
        }
    }
    out
}

fn parse_attrs(raw: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == '/') {
            i += 1;
        }
        let name_start = i;
        while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '=' && chars[i] != '/' {
            i += 1;
        }
        if name_start == i {
            i += 1;
            continue;
        }
        let name: String = chars[name_start..i].iter().collect::<String>().to_ascii_lowercase();
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < chars.len() && chars[i] == '=' {
            i += 1;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            if i < chars.len() && (chars[i] == '"' || chars[i] == '\'') {
                let q = chars[i];
                i += 1;
                let vs = i;
                while i < chars.len() && chars[i] != q {
                    i += 1;
                }
                value = chars[vs..i.min(chars.len())].iter().collect();
                i += 1;
            } else {
                let vs = i;
                while i < chars.len() && !chars[i].is_whitespace() {
                    i += 1;
                }
                value = chars[vs..i].iter().collect();
            }
        }
        attrs.push((name, value));
    }
    attrs
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

fn seconds(value: Option<&str>) -> Option<f64> {
    value
        .and_then(|v| v.trim().trim_end_matches('s').parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
}

pub fn parse(html: &str) -> ProjectMeta {
    let mut root_duration: Option<f64> = None;
    let mut furthest_end = 0.0_f64;
    let mut clips = 0u32;
    for attrs in start_tags(html) {
        if root_duration.is_none() && attr(&attrs, "data-composition-id").is_some() {
            root_duration = seconds(attr(&attrs, "data-duration"));
            continue;
        }
        if attr(&attrs, "class")
            .map(|c| c.split_whitespace().any(|t| t == "clip"))
            .unwrap_or(false)
        {
            clips += 1;
        }
        if let (Some(start), Some(dur)) = (
            seconds(attr(&attrs, "data-start")),
            seconds(attr(&attrs, "data-duration")),
        ) {
            furthest_end = furthest_end.max(start + dur);
        }
    }
    ProjectMeta {
        duration: root_duration.filter(|d| *d > 0.0).unwrap_or(furthest_end),
        clips,
    }
}

type CacheKey = (u64, Option<SystemTime>);
static CACHE: Mutex<Option<HashMap<PathBuf, (CacheKey, ProjectMeta)>>> = Mutex::new(None);

/// Metadata for the project in `dir`, from cache when `index.html` has not
/// changed. None when the project has no readable `index.html`.
pub fn for_project(dir: &Path) -> Option<ProjectMeta> {
    let index = dir.join("index.html");
    let info = std::fs::metadata(&index).ok()?;
    let key = (info.len(), info.modified().ok());
    if let Ok(guard) = CACHE.lock() {
        if let Some((cached_key, meta)) = guard.as_ref().and_then(|m| m.get(&index)) {
            if *cached_key == key {
                return Some(*meta);
            }
        }
    }
    let meta = parse(&std::fs::read_to_string(&index).ok()?);
    if let Ok(mut guard) = CACHE.lock() {
        guard.get_or_insert_with(HashMap::new).insert(index, (key, meta));
    }
    Some(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_root_duration_and_counts_clip_tokens_only() {
        let html = r#"<!doctype html><html><body>
          <div id="root" data-composition-id="main" data-start="0" data-duration="28" data-width="1920">
            <video class="clip" data-start="0" data-duration="5" src="a.mp4"></video>
            <img class='media clip' data-start=4 data-duration=3>
            <div class="clipboard caption" data-start="2" data-duration="40"></div>
            <!-- <div class="clip"></div> -->
            <audio class="clip bed" data-start="0" data-duration="28"></audio>
          </div>
          <script>const tpl = '<div class="clip"></div>';</script>
        </body></html>"#;
        let meta = parse(html);
        assert_eq!(meta.clips, 3);
        assert_eq!(meta.duration, 28.0);
    }

    #[test]
    fn falls_back_to_the_furthest_clip_end_without_a_root_duration() {
        let html = r#"<div data-composition-id="main">
            <div class="clip" data-start="2.5" data-duration="4"></div>
            <div class="clip" data-start="10" data-duration="1.25"></div></div>"#;
        let meta = parse(html);
        assert_eq!(meta.duration, 11.25);
        assert_eq!(meta.clips, 2);
    }

    #[test]
    fn quoted_angle_brackets_do_not_end_a_tag() {
        let html = r#"<div data-composition-id="x" data-label="a > b" data-duration="9"></div><p class="clip">"#;
        let meta = parse(html);
        assert_eq!(meta.duration, 9.0);
        assert_eq!(meta.clips, 1);
    }

    #[test]
    fn cache_follows_file_changes() {
        let dir = std::env::temp_dir().join(format!("openvids-meta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), r#"<div data-composition-id="m" data-duration="3"></div>"#).unwrap();
        assert_eq!(for_project(&dir).unwrap().duration, 3.0);
        std::fs::write(
            dir.join("index.html"),
            r#"<div data-composition-id="m" data-duration="12"></div><i class="clip"></i>"#,
        )
        .unwrap();
        let meta = for_project(&dir).unwrap();
        assert_eq!((meta.duration, meta.clips), (12.0, 1));
        assert!(for_project(&dir.join("nope")).is_none());
    }
}
