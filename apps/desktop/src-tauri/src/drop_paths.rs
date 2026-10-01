//! Real file paths for an OS file drop on the Projects page.
//!
//! The window keeps Tauri's drag-drop handler off (`disable_drag_drop_handler`
//! in lib.rs): with it on, Tauri swallows every OS drop and Studio's HTML5
//! imports (`AssetsTab`, `FileTree`) and in-page drags stop working, and the
//! handler cannot be switched per page. So the webview handles the drop
//! itself, which gives the page `File` objects without paths.
//!
//! The paths are still on the macOS *drag* pasteboard (`NSPasteboardNameDrag`)
//! after the drop: AppKit only replaces it when the next drag starts. The home
//! page posts the dropped file names; this reads the pasteboard's file list
//! and returns the entries whose names match, so a stale pasteboard from an
//! earlier drag can never be mistaken for this drop. Nothing is streamed
//! through JavaScript — the files are copied from these paths on Start.

use std::path::PathBuf;

/// File paths currently on the drag pasteboard. `NSFilenamesPboardType` is
/// deprecated in favour of per-item file URLs, but Finder still writes it and
/// it is what wry's own drop handler reads.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub fn drag_pasteboard_paths() -> Vec<PathBuf> {
    use objc2_app_kit::{NSFilenamesPboardType, NSPasteboard, NSPasteboardNameDrag};
    use objc2_foundation::{NSArray, NSString};

    let mut out = Vec::new();
    // SAFETY: AppKit statics; reading a named pasteboard is thread-safe.
    let pasteboard = unsafe { NSPasteboard::pasteboardWithName(NSPasteboardNameDrag) };
    let wanted = unsafe { NSArray::from_slice(&[NSFilenamesPboardType]) };
    if pasteboard.availableTypeFromArray(&wanted).is_none() {
        return out;
    }
    let Some(list) = (unsafe { pasteboard.propertyListForType(NSFilenamesPboardType) }) else {
        return out;
    };
    let Ok(list) = list.downcast::<NSArray>() else {
        return out;
    };
    for item in list.iter() {
        if let Ok(path) = item.downcast::<NSString>() {
            out.push(PathBuf::from(path.to_string()));
        }
    }
    out
}

#[cfg(not(target_os = "macos"))]
pub fn drag_pasteboard_paths() -> Vec<PathBuf> {
    Vec::new()
}

/// Keep the pasteboard paths whose file names were dropped, in drop order.
/// Duplicate names map to distinct paths, each used once.
pub fn match_dropped(names: &[String], mut candidates: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for name in names {
        if let Some(i) = candidates.iter().position(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy() == name.as_str())
                .unwrap_or(false)
        }) {
            out.push(candidates.remove(i));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_dropped_names_are_returned_in_drop_order() {
        let candidates = vec![
            PathBuf::from("/a/one.mov"),
            PathBuf::from("/b/two.wav"),
            PathBuf::from("/c/one.mov"),
            PathBuf::from("/d/stale.txt"),
        ];
        let names = vec!["two.wav".to_string(), "one.mov".to_string(), "one.mov".to_string(), "missing.png".to_string()];
        assert_eq!(
            match_dropped(&names, candidates),
            vec![
                PathBuf::from("/b/two.wav"),
                PathBuf::from("/a/one.mov"),
                PathBuf::from("/c/one.mov")
            ]
        );
    }
}
