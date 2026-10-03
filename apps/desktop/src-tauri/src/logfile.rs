//! Persistent shell log: `<app log dir>/openvids.log` (macOS:
//! `~/Library/Logs/<bundle id>/`).
//!
//! One process-wide writer, fed through a channel so no caller ever blocks on
//! disk (the UI thread, the event loop and the sidecar's stdout readers all
//! log). Lines are prefixed with the source — `[shell]` for the shell's own
//! diagnostics, `[sidecar]` for the Studio backend's piped stdout/stderr,
//! `[agent]` for the agent runtime's — plus an ISO-8601 UTC timestamp, so a
//! pasted excerpt says who said what when. Everything is still printed to
//! stderr by the caller as before: `bun run desktop:dev` users read it there.
//!
//! Rotation: `openvids.log` grows to 5 MB, then becomes `openvids.log.1`
//! (`openvids.log.1` becomes `.2`, `.2` is dropped): three files, at most
//! 15 MB. IO errors are ignored — a full disk must never affect the app.
//!
//! The bug reporter (`report.rs`) reads the tail through [`tail`] and redacts
//! it client-side before anything leaves the machine.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const FILE: &str = "openvids.log";
/// Rotate when the next line would push the file past this.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// How much of the log [`tail`] returns: one report's worth.
pub const TAIL_BYTES: usize = 1024 * 1024;

/// Who wrote a line. The prefix stored in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tag {
    Shell,
    Sidecar,
    Agent,
}

impl Tag {
    fn as_str(self) -> &'static str {
        match self {
            Tag::Shell => "shell",
            Tag::Sidecar => "sidecar",
            Tag::Agent => "agent",
        }
    }
}

struct Entry {
    tag: Tag,
    at: SystemTime,
    text: String,
}

static SENDER: OnceLock<Sender<Entry>> = OnceLock::new();
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Start the writer thread for `dir` (created if missing). Called once from
/// `setup`; later calls are ignored. A failure only means nothing is written
/// to a file — callers' stderr output is unaffected.
pub fn init(dir: PathBuf) {
    if SENDER.get().is_some() {
        return;
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let (tx, rx) = channel();
    if SENDER.set(tx).is_err() {
        return;
    }
    let _ = LOG_DIR.set(dir.clone());
    let _ = std::thread::Builder::new()
        .name("openvids-log".into())
        .spawn(move || run(&dir, rx));
}

/// One shell diagnostic line.
pub fn shell(message: &str) {
    log(Tag::Shell, message);
}

/// One line of the Studio sidecar's piped output.
pub fn sidecar(message: &str) {
    log(Tag::Sidecar, message);
}

/// One line of the agent runtime's piped output.
pub fn agent(message: &str) {
    log(Tag::Agent, message);
}

fn log(tag: Tag, message: &str) {
    let Some(sender) = SENDER.get() else {
        return;
    };
    let at = SystemTime::now();
    // One call can carry a multi-line error; every stored line gets its own
    // prefix so the file stays greppable and the tail is self-describing.
    for text in message.split('\n') {
        let text = text.trim_end_matches('\r');
        if text.is_empty() {
            continue;
        }
        let _ = sender.send(Entry {
            tag,
            at,
            text: text.to_string(),
        });
    }
}

fn run(dir: &Path, rx: Receiver<Entry>) {
    let mut writer = Writer::new(dir.join(FILE), MAX_FILE_BYTES);
    loop {
        let Ok(first) = rx.recv() else {
            break;
        };
        let mut batch = String::new();
        batch.push_str(&line(first.tag, first.at, &first.text));
        while let Ok(next) = rx.try_recv() {
            batch.push_str(&line(next.tag, next.at, &next.text));
        }
        let _ = writer.append(&batch);
    }
    let _ = writer.flush();
}

fn line(tag: Tag, at: SystemTime, text: &str) -> String {
    format!("[{}] {} {}\n", tag.as_str(), iso_timestamp(at), text)
}

/// `2026-10-03T12:34:56.789Z` — UTC, so excerpts from different machines sort.
fn iso_timestamp(at: SystemTime) -> String {
    let since_epoch = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since_epoch.as_secs() as i64;
    let millis = since_epoch.subsec_millis();
    let days = secs.div_euclid(86_400);
    let second_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        second_of_day / 3600,
        (second_of_day % 3600) / 60,
        second_of_day % 60
    )
}

/// Days since the Unix epoch → (year, month, day). Howard Hinnant's
/// `civil_from_days`, the standard branch-light conversion.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if month <= 2 { y + 1 } else { y }, month, day)
}

/// The newest `TAIL_BYTES` of the log, oldest first, cut at a line boundary:
/// all of `openvids.log`, plus as much of `openvids.log.1` as it takes to
/// reach the limit. Empty when nothing was ever written.
pub fn tail() -> String {
    match LOG_DIR.get() {
        Some(dir) => tail_from(dir, TAIL_BYTES),
        None => String::new(),
    }
}

fn tail_from(dir: &Path, limit: usize) -> String {
    let current = read_tail(&dir.join(FILE), limit);
    if current.len() >= limit {
        return current;
    }
    let older = read_tail(&dir.join(format!("{FILE}.1")), limit - current.len());
    if older.is_empty() {
        return current;
    }
    format!("{older}{current}")
}

/// The last `limit` bytes of `path`, dropped back to the first line start.
fn read_tail(path: &Path, limit: usize) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    if bytes.len() <= limit {
        return String::from_utf8_lossy(&bytes).into_owned();
    }
    let start = bytes.len() - limit;
    let begin = bytes[start..]
        .iter()
        .position(|b| *b == b'\n')
        .map(|i| start + i + 1)
        .unwrap_or(start);
    String::from_utf8_lossy(&bytes[begin..]).into_owned()
}

/// The size-rotating file behind the writer thread. An unopenable file just
/// drops every line: logging must never affect the app.
struct Writer {
    path: PathBuf,
    file: Option<BufWriter<File>>,
    size: u64,
    max: u64,
}

impl Writer {
    fn new(path: PathBuf, max: u64) -> Self {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self {
            file: open_append(&path).map(BufWriter::new),
            path,
            size,
            max,
        }
    }

    fn append(&mut self, text: &str) -> std::io::Result<()> {
        if self.size > 0 && self.size + text.len() as u64 > self.max {
            self.rotate();
        }
        let Some(file) = self.file.as_mut() else {
            return Ok(());
        };
        file.write_all(text.as_bytes())?;
        self.size += text.len() as u64;
        file.flush()
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self.file.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }

    /// `openvids.log` → `.1` → `.2`, dropping the oldest. Best effort: a
    /// failed rename (a Windows lock, a full disk) just keeps appending to
    /// the current file, which is what matters.
    fn rotate(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
        let base = self
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| FILE.to_string());
        let dir = self.path.with_file_name("");
        let _ = std::fs::remove_file(dir.join(format!("{base}.2")));
        let _ = std::fs::rename(dir.join(format!("{base}.1")), dir.join(format!("{base}.2")));
        if std::fs::rename(&self.path, dir.join(format!("{base}.1"))).is_ok() {
            self.file = open_append(&self.path).map(BufWriter::new);
            self.size = 0;
        } else {
            self.size = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        }
    }
}

fn open_append(path: &Path) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("openvids-logfile-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn timestamps_are_iso_utc_with_milliseconds() {
        assert_eq!(iso_timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_timestamp(UNIX_EPOCH + std::time::Duration::from_millis(1_753_000_000_123)),
            "2025-07-20T08:26:40.123Z"
        );
        // A leap day, so the civil-date conversion is pinned somewhere real.
        assert_eq!(
            iso_timestamp(UNIX_EPOCH + std::time::Duration::from_secs(1_582_934_400)),
            "2020-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn rotation_keeps_three_files_and_drops_the_oldest() {
        let dir = temp_dir("rotate");
        let path = dir.join(FILE);
        let mut writer = Writer::new(path.clone(), 200);
        for i in 0..40 {
            writer
                .append(&line(
                    Tag::Shell,
                    UNIX_EPOCH,
                    &format!("line {i} padded to some length"),
                ))
                .unwrap();
        }
        assert!(path.is_file(), "the live file is back after rotation");
        assert!(dir.join(format!("{FILE}.1")).is_file());
        assert!(dir.join(format!("{FILE}.2")).is_file());
        assert!(
            !dir.join(format!("{FILE}.3")).exists(),
            "three files in total, no more"
        );
        // The live file holds the newest lines; the oldest are gone.
        let live = std::fs::read_to_string(&path).unwrap();
        assert!(live.contains("line 39"));
        let oldest = std::fs::read_to_string(dir.join(format!("{FILE}.2"))).unwrap();
        assert!(!oldest.contains("line 0"), "{oldest}");
        assert!(
            std::fs::metadata(&path).unwrap().len() <= 200,
            "the boundary is honoured: one line may overshoot, the file may not"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_reads_the_current_file_and_falls_back_to_the_previous_one() {
        let dir = temp_dir("tail");
        // Two lines per file so a small limit has something to keep and
        // something to drop.
        std::fs::write(dir.join(FILE), "first line\nsecond line\n").unwrap();
        std::fs::write(dir.join(format!("{FILE}.1")), "older one\nolder two\n").unwrap();
        assert_eq!(
            tail_from(&dir, TAIL_BYTES),
            "older one\nolder two\nfirst line\nsecond line\n"
        );
        // A limit landing mid-file keeps only complete lines.
        assert_eq!(read_tail(&dir.join(FILE), 17), "second line\n");
        // A limit bigger than the live file pulls the tail of `.1` in first.
        assert_eq!(tail_from(&dir, 34), "older two\nfirst line\nsecond line\n");
        // Nothing on disk: nothing to attach.
        assert_eq!(tail_from(&dir.join("missing"), TAIL_BYTES), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_writer_thread_appends_to_the_log_file_inside_the_directory() {
        let dir = temp_dir("run");
        let (tx, rx) = channel();
        tx.send(Entry {
            tag: Tag::Shell,
            at: UNIX_EPOCH,
            text: "started".into(),
        })
        .unwrap();
        drop(tx);
        run(&dir, rx);
        assert_eq!(
            std::fs::read_to_string(dir.join(FILE)).unwrap(),
            "[shell] 1970-01-01T00:00:00.000Z started\n"
        );
        assert_eq!(tail_from(&dir, TAIL_BYTES), "[shell] 1970-01-01T00:00:00.000Z started\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
