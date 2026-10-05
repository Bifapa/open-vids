//! Recently-opened projects, persisted as JSON in the app data dir.
//!
//! The file is `{app_data_dir}/recents.json`: a list of `{id, dir,
//! last_opened, thumb, width, height}` entries, most-recent first,
//! deduplicated by canonical path. The home page renders it; every
//! successful project open records into it.
//!
//! `id` is the Studio project id, i.e. the folder name, so two projects in
//! different parents can share it. The Projects page therefore addresses a
//! recent by [`RecentEntry::key`], a stable hash of its full directory path;
//! the key is derived, never stored, so older `recents.json` files load as-is.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// One project on the home screen.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct RecentEntry {
    /// Studio project id: the folder name. Not unique across recents; address
    /// a recent by [`RecentEntry::key`].
    pub id: String,
    /// Absolute project directory.
    pub dir: PathBuf,
    /// Seconds since the Unix epoch of the last open.
    pub last_opened: u64,
    /// Cached thumbnail file name inside the thumbnails dir, if fetched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    /// Composition dimensions, when known (used for the card placeholder).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

impl RecentEntry {
    /// The handle the Projects page uses for this recent: 16 hex chars of the
    /// SHA-256 of the directory path, unique per folder (on Windows the hash
    /// ignores case and separator style, matching [`same_dir`]).
    pub fn key(&self) -> String {
        dir_key(&self.dir)
    }
}

/// The persisted list. All mutations keep it deduped (by canonical path)
/// and sorted most-recent-first.
#[derive(Debug, Default)]
pub struct RecentsStore {
    path: PathBuf,
    entries: Vec<RecentEntry>,
}

impl RecentsStore {
    pub fn load(path: &Path) -> Self {
        let entries = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<RecentEntry>>(&bytes).ok())
            .unwrap_or_default();
        let mut store = Self {
            path: path.to_path_buf(),
            entries,
        };
        store.compact();
        store
    }

    pub fn entries(&self) -> &[RecentEntry] {
        &self.entries
    }

    pub fn find_by_key(&self, key: &str) -> Option<&RecentEntry> {
        self.entries.iter().find(|e| e.key() == key)
    }

    pub fn find_by_dir(&self, dir: &Path) -> Option<&RecentEntry> {
        self.entries.iter().find(|e| same_dir(&e.dir, dir))
    }

    fn save(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(&self.entries) {
            let _ = std::fs::write(&self.path, bytes);
        }
    }

    fn compact(&mut self) {
        let mut seen: Vec<PathBuf> = Vec::new();
        self.entries.retain(|e| {
            let key = canonical_key(&e.dir);
            if seen.iter().any(|s| super::platform::same_path(s, &key)) {
                return false;
            }
            seen.push(key);
            true
        });
        self.entries
            .sort_by_key(|e| std::cmp::Reverse(e.last_opened));
    }

    /// Record an open: move the entry to the front, updating metadata.
    /// A previously cached thumbnail survives the re-record.
    pub fn record(&mut self, id: &str, dir: &Path, width: Option<u32>, height: Option<u32>) {
        let thumb = self
            .entries
            .iter()
            .find(|e| same_dir(&e.dir, dir))
            .and_then(|e| e.thumb.clone());
        self.entries.retain(|e| !same_dir(&e.dir, dir));
        self.entries.insert(
            0,
            RecentEntry {
                id: id.to_string(),
                dir: key_as_path(dir),
                last_opened: now_secs(),
                thumb,
                width,
                height,
            },
        );
        self.save();
    }

    /// Update dimensions/thumbnail for an already-listed directory.
    pub fn update_meta(
        &mut self,
        dir: &Path,
        thumb: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
    ) {
        if let Some(entry) = self.entries.iter_mut().find(|e| same_dir(&e.dir, dir)) {
            if thumb.is_some() {
                entry.thumb = thumb;
            }
            if width.is_some() {
                entry.width = width;
            }
            if height.is_some() {
                entry.height = height;
            }
            self.save();
        }
    }

    /// Whether another entry (not `key`) already lives at `new_dir`. A rename
    /// that would collide must be refused before anything moves on disk.
    pub fn rename_collides(&self, key: &str, new_dir: &Path) -> bool {
        self.entries
            .iter()
            .any(|e| e.key() != key && same_dir(&e.dir, new_dir))
    }

    /// Returns false when another entry already lives at `new_dir` or `key` is unknown.
    pub fn rename(&mut self, key: &str, new_id: &str, new_dir: &Path) -> bool {
        if self.rename_collides(key, new_dir) {
            return false;
        }
        if let Some(entry) = self.entries.iter_mut().find(|e| e.key() == key) {
            entry.id = new_id.to_string();
            entry.dir = new_dir.to_path_buf();
            entry.last_opened = now_secs();
            self.entries
                .sort_by_key(|e| std::cmp::Reverse(e.last_opened));
            self.save();
            return true;
        }
        false
    }

    /// Drop an entry by key. Returns false when absent.
    pub fn remove(&mut self, key: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.key() != key);
        if self.entries.len() != before {
            self.save();
            return true;
        }
        false
    }

    /// Drop an entry by key and hand it back with its position, so the caller
    /// can offer Undo (`restore`).
    pub fn take(&mut self, key: &str) -> Option<(usize, RecentEntry)> {
        let index = self.entries.iter().position(|e| e.key() == key)?;
        let entry = self.entries.remove(index);
        self.save();
        Some((index, entry))
    }

    /// Put a taken entry back (Undo of Remove from Recent). Its timestamp is
    /// kept, so it lands where it was; a later record of the same folder wins.
    pub fn restore(&mut self, entry: RecentEntry) {
        if self.entries.iter().any(|e| same_dir(&e.dir, &entry.dir)) {
            return;
        }
        self.entries.push(entry);
        self.entries
            .sort_by_key(|e| std::cmp::Reverse(e.last_opened));
        self.save();
    }

    /// Point a (missing) entry at the folder the user located. Any other entry
    /// for that folder is merged into it. Returns false when `key` is unknown.
    pub fn relink(&mut self, key: &str, new_id: &str, new_dir: &Path) -> bool {
        let Some(index) = self.entries.iter().position(|e| e.key() == key) else {
            return false;
        };
        let mut entry = self.entries.remove(index);
        self.entries.retain(|e| !same_dir(&e.dir, new_dir));
        entry.id = new_id.to_string();
        entry.dir = canonical_key(new_dir);
        let at = index.min(self.entries.len());
        self.entries.insert(at, entry);
        self.save();
        true
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn canonical_key(dir: &Path) -> PathBuf {
    super::platform::canonical_stable(dir)
}

/// Hash of a directory path for [`RecentEntry::key`]. Windows paths are folded
/// the way `same_path` compares them so one folder never gets two keys.
fn dir_key(dir: &Path) -> String {
    let text = dir.as_os_str().to_string_lossy();
    #[cfg(windows)]
    let text = text.replace('/', "\\").to_lowercase();
    let digest = Sha256::digest(text.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

fn key_as_path(dir: &Path) -> PathBuf {
    canonical_key(dir)
}

/// Whether two stored dirs name the same folder. On Windows the filesystem is
/// case-insensitive, so `C:\Work\X` and `c:\work\x` dedupe to one recent.
fn same_dir(a: &Path, b: &Path) -> bool {
    super::platform::same_path(&canonical_key(a), &canonical_key(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openvids-recents-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn proj(base: &Path, name: &str) -> PathBuf {
        let dir = base.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        super::super::platform::canonical_stable(&dir)
    }

    #[test]
    fn record_sorts_most_recent_first() {
        let base = tmp("sort");
        let store_path = base.join("recents.json");
        let mut store = RecentsStore::load(&store_path);
        store.record("a", &proj(&base, "a"), None, None);
        std::thread::sleep(std::time::Duration::from_secs(1));
        store.record("b", &proj(&base, "b"), None, None);
        assert_eq!(store.entries()[0].id, "b");
        // Reload persists the order.
        let reloaded = RecentsStore::load(&store_path);
        assert_eq!(reloaded.entries()[0].id, "b");
    }

    #[test]
    fn record_dedupes_by_canonical_path() {
        let base = tmp("dedupe");
        let store_path = base.join("recents.json");
        let mut store = RecentsStore::load(&store_path);
        let dir = proj(&base, "a");
        store.record("a", &dir, None, None);
        store.record("a-renamed", &dir, Some(1080), Some(1920));
        assert_eq!(store.entries().len(), 1);
        assert_eq!(store.entries()[0].id, "a-renamed");
        assert_eq!(store.entries()[0].width, Some(1080));
    }

    #[test]
    #[cfg(windows)]
    fn record_dedupes_case_variants_of_the_same_folder() {
        let base = tmp("case");
        let store_path = base.join("recents.json");
        let mut store = RecentsStore::load(&store_path);
        let dir = proj(&base, "Project");
        store.record("a", &dir, None, None);
        let upper = PathBuf::from(dir.to_string_lossy().to_uppercase());
        store.record("b", &upper, None, None);
        assert_eq!(store.entries().len(), 1);
        assert_eq!(store.entries()[0].id, "b");
    }

    #[test]
    fn rename_refuses_collisions_and_updates() {
        let base = tmp("rename");
        let store_path = base.join("recents.json");
        let mut store = RecentsStore::load(&store_path);
        let a = proj(&base, "a");
        let b = proj(&base, "b");
        store.record("a", &a, None, None);
        store.record("b", &b, None, None);
        let key_a = store.find_by_dir(&a).unwrap().key();
        assert!(!store.rename(&key_a, "b", &b));
        let new_dir = base.join("c");
        assert!(store.rename(&key_a, "c", &new_dir));
        assert!(store.find_by_dir(&new_dir).is_some_and(|e| e.id == "c"));
        assert!(store.find_by_key(&key_a).is_none());
    }

    #[test]
    fn same_folder_name_in_different_parents_gets_different_keys_and_actions_hit_the_right_one() {
        let base = tmp("same-name");
        let store_path = base.join("recents.json");
        let mut store = RecentsStore::load(&store_path);
        let older = proj(&base.join("movies"), "demo");
        let newer = proj(&base.join("desktop"), "demo");
        store.record("demo", &older, None, None);
        store.entries[0].last_opened = 10;
        store.record("demo", &newer, None, None);
        assert_eq!(store.entries().len(), 2);
        let key_older = store.find_by_dir(&older).unwrap().key();
        let key_newer = store.find_by_dir(&newer).unwrap().key();
        assert_ne!(key_older, key_newer);
        assert_eq!(store.find_by_key(&key_older).unwrap().dir, older);
        assert_eq!(store.find_by_key(&key_newer).unwrap().dir, newer);

        // Renaming the older one next to its siblings leaves the other alone.
        let renamed = older.with_file_name("demo2");
        assert!(store.rename(&key_older, "demo2", &renamed));
        assert_eq!(store.find_by_key(&key_newer).unwrap().dir, newer);

        // Taking the newer one never takes the other.
        let (_, taken) = store.take(&key_newer).unwrap();
        assert_eq!(taken.dir, newer);
        assert_eq!(store.entries().len(), 1);
        assert_eq!(store.entries()[0].dir, renamed);
    }

    #[test]
    fn an_entry_saved_by_an_older_build_loads_and_is_addressable() {
        let base = tmp("legacy");
        let store_path = base.join("recents.json");
        let dir = proj(&base, "old");
        let legacy = format!(
            r#"[{{"id":"old","dir":{},"last_opened":5}}]"#,
            serde_json::to_string(&dir).unwrap()
        );
        std::fs::write(&store_path, legacy).unwrap();
        let store = RecentsStore::load(&store_path);
        let key = store.entries()[0].key();
        assert_eq!(store.find_by_key(&key).unwrap().id, "old");
    }

    #[test]
    fn remove_drops_only_the_named_entry() {
        let base = tmp("remove");
        let store_path = base.join("recents.json");
        let mut store = RecentsStore::load(&store_path);
        store.record("a", &proj(&base, "a"), None, None);
        store.record("b", &proj(&base, "b"), None, None);
        let key_a = store.find_by_dir(&base.join("a")).unwrap().key();
        assert!(!store.remove("missing"));
        assert!(store.remove(&key_a));
        assert_eq!(store.entries().len(), 1);
        assert_eq!(store.entries()[0].id, "b");
    }

    #[test]
    fn take_then_restore_puts_the_entry_back_in_place() {
        let base = tmp("restore");
        let store_path = base.join("recents.json");
        let mut store = RecentsStore::load(&store_path);
        store.record("a", &proj(&base, "a"), None, None);
        store.entries[0].last_opened = 10;
        store.record("b", &proj(&base, "b"), None, None);
        store.entries[0].last_opened = 30;
        store.record("c", &proj(&base, "c"), None, None);
        store.entries[0].last_opened = 20;
        store.entries.sort_by_key(|e| std::cmp::Reverse(e.last_opened));
        let key_c = store.find_by_dir(&base.join("c")).unwrap().key();
        let (index, entry) = store.take(&key_c).unwrap();
        assert_eq!(index, 1);
        assert!(store.find_by_key(&key_c).is_none());
        store.restore(entry.clone());
        let ids: Vec<_> = store.entries().iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["b", "c", "a"]);
        // Restoring twice never duplicates the folder.
        store.restore(entry);
        assert_eq!(store.entries().len(), 3);
    }

    #[test]
    fn relink_points_the_entry_at_the_located_folder_and_merges_duplicates() {
        let base = tmp("relink");
        let store_path = base.join("recents.json");
        let mut store = RecentsStore::load(&store_path);
        let gone = base.join("gone");
        store.record("gone", &gone, None, None);
        let found = proj(&base, "found");
        store.record("found", &found, None, None);
        let key_gone = store.find_by_dir(&gone).unwrap().key();
        assert!(store.relink(&key_gone, "found", &found));
        assert_eq!(store.entries().len(), 1);
        assert_eq!(store.entries()[0].dir, found);
        assert!(!store.relink("nope", "x", &found));
    }

    #[test]
    fn corrupt_file_loads_empty_without_panicking() {
        let base = tmp("corrupt");
        let store_path = base.join("recents.json");
        std::fs::write(&store_path, b"not json{{").unwrap();
        let store = RecentsStore::load(&store_path);
        assert!(store.entries().is_empty());
    }
}
