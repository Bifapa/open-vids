//! The cross-process write lock of the design-system library (`<root>/.lock`).
//!
//! The Studio sidecars write the library through `packages/studio-server`, the Projects page writes it from here
//! (rename, delete, the new-project snapshot reads it consistently), and both can run at once, so both take the
//! same lock. This is a port of `packages/studio-server/src/history/ownerLock.ts`, byte for byte where the files
//! are concerned:
//!
//! - the lock file holds `<pid>` or `<pid> <start key>` (no newline), the start key being the start of the process
//!   that wrote it, so a later process can tell a reused pid from the real owner;
//! - it is taken by writing a draft file aside and hard-linking it to the lock name (a reader never sees a lock
//!   without its pid; of two claimants only one link succeeds);
//! - a dead owner's lock is removed under a second lock, `<lock>.evict`, with the owner re-read before removal, so
//!   a lock that changed hands meanwhile survives;
//! - a lock that holds no readable pid reads as dead.
//!
//! The start key of a process is what TypeScript computes: on Linux `<boot id>:<starttime>` from `/proc`, on
//! macOS and the other Unixes `ps -o lstart=` (TZ pinned to UTC). On Windows this side cannot compute the key
//! TypeScript uses (PowerShell, `win-ms:<ms>`), so it writes `<pid>` alone, and for a lock whose key it cannot
//! compare a live pid counts as the owner: a busy library is better than two writers, and a live process's lock is
//! never evicted.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(50);
/// Windows start keys are epoch milliseconds, `win-ms:<ms>`; two of them name the same start within this many
/// milliseconds (`sameStart` in `ownerLock.ts`).
const WINDOWS_START_PREFIX: &str = "win-ms:";
const WINDOWS_START_TOLERANCE_MS: i64 = 10_000;

#[derive(Debug)]
pub enum LockError {
    /// A live process holds the lock (its pid, when it names one).
    Busy(Option<u32>),
    Io(std::io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy(Some(pid)) => write!(f, "the design library is in use by another process (pid {pid})"),
            Self::Busy(None) => write!(f, "the design library is in use by another process"),
            Self::Io(err) => write!(f, "the design library lock failed: {err}"),
        }
    }
}

impl std::error::Error for LockError {}

impl From<std::io::Error> for LockError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

/// Who a lock file names: a pid (`None` when the file holds none, so it reads as dead) and the start of the
/// process that wrote it, when it could tell.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Owner {
    pid: Option<u32>,
    start: Option<String>,
}

/// Held until dropped; the release removes the lock only while it still names this process.
#[derive(Debug)]
pub struct LibraryLock {
    file: PathBuf,
}

impl Drop for LibraryLock {
    fn drop(&mut self) {
        release_own(&self.file);
    }
}

/// Takes the lock `file`, waiting up to `wait` for a live owner to let go and taking over a dead owner's lock.
pub fn acquire(file: &Path, wait: Duration) -> Result<LibraryLock, LockError> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let deadline = Instant::now() + wait;
    let start = own_start();
    let mut starts: HashMap<u32, Option<String>> = HashMap::new();
    loop {
        if claim(file, start)? {
            return Ok(LibraryLock { file: file.to_path_buf() });
        }
        let Some(owner) = owner_of(file)? else { continue };
        if !holds(&owner, &mut starts) && evict_dead_owner(file, &mut starts, start)? {
            continue;
        }
        if Instant::now() >= deadline {
            return Err(LockError::Busy(owner.pid));
        }
        std::thread::sleep(POLL);
    }
}

/// This process's own start key, read once. (`OnceLock`, not `LazyLock`: the crate's declared MSRV, 1.77, predates
/// `LazyLock`, and clippy's `incompatible_msrv` fails the build.)
fn own_start() -> Option<&'static str> {
    static START: OnceLock<Option<String>> = OnceLock::new();
    START.get_or_init(|| process_start_key(std::process::id())).as_deref()
}

/// The start of the process `pid`; `None` when it does not exist, cannot be queried or the platform gives no way
/// to tell.
fn process_start_key(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The command name sits in parentheses and may hold spaces; field 22 (starttime) is the 20th after it.
        let after = stat.get(stat.rfind(')')? + 2..)?;
        let ticks = after.split(' ').nth(19).filter(|field| !field.is_empty())?;
        let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
        Some(format!("{}:{ticks}", boot.trim()))
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        // TZ is pinned so a changed time zone never changes what the same process reports.
        let output = std::process::Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .env("TZ", "UTC")
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (output.status.success() && !text.is_empty()).then_some(text)
    }
    #[cfg(windows)]
    {
        let _ = pid;
        None
    }
}

/// Whether two start keys name the same process start.
fn same_start(a: &str, b: &str) -> bool {
    match (windows_start_ms(a), windows_start_ms(b)) {
        (Some(a), Some(b)) => (a - b).abs() <= WINDOWS_START_TOLERANCE_MS,
        _ => a == b,
    }
}

fn windows_start_ms(key: &str) -> Option<i64> {
    key.strip_prefix(WINDOWS_START_PREFIX)?.parse().ok()
}

/// The owner in `file`; `None` when there is no file.
fn owner_of(file: &Path) -> std::io::Result<Option<Owner>> {
    match std::fs::read(file) {
        Ok(bytes) => Ok(Some(parse_owner(&String::from_utf8_lossy(&bytes)))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// `^(\d+)(?: (.+))?$` (the whole text): anything else holds no pid.
fn parse_owner(text: &str) -> Owner {
    let none = Owner { pid: None, start: None };
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return none;
    }
    let (pid, rest) = text.split_at(digits);
    // A pid too large for the OS reads as dead (TypeScript: a pid `kill` cannot signal).
    let pid = pid.parse::<u32>().ok();
    match rest.strip_prefix(' ') {
        Some(start) if !start.is_empty() => Owner { pid, start: Some(start.to_string()) },
        None if rest.is_empty() => Owner { pid, start: None },
        _ => none,
    }
}

/// Whether the process that wrote the lock still runs. A pid alone is not enough: the lock survives a hard kill
/// or a reboot, and the pid may since belong to any other process, which would hold the library shut for as long
/// as it lives. So the pid must also have started when the lock's writer did. A live process whose start cannot
/// be told counts as the owner.
fn holds(owner: &Owner, starts: &mut HashMap<u32, Option<String>>) -> bool {
    let Some(pid) = owner.pid else { return false };
    if !crate::proc::is_alive(pid) {
        return false;
    }
    let Some(written) = owner.start.as_deref() else { return true };
    let now = if pid == std::process::id() {
        own_start().map(str::to_string)
    } else {
        starts.entry(pid).or_insert_with(|| process_start_key(pid)).clone()
    };
    match now {
        None => true,
        Some(now) => same_start(&now, written),
    }
}

/// 16 random hex digits, for draft and staging names. A failed draw only makes a name less unique; the callers
/// also put the pid in, which keeps them distinct from other processes.
pub fn random_hex() -> String {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn draft_name(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_os_string();
    name.push(format!("-{}-{}.tmp", std::process::id(), random_hex()));
    PathBuf::from(name)
}

/// Takes `file` if nobody holds it: written aside and linked in. False when it exists.
fn claim(file: &Path, start: Option<&str>) -> std::io::Result<bool> {
    let draft = draft_name(file);
    let content = match start {
        Some(start) => format!("{} {start}", std::process::id()),
        None => std::process::id().to_string(),
    };
    std::fs::write(&draft, content)?;
    let linked = std::fs::hard_link(&draft, file);
    let _ = std::fs::remove_file(&draft);
    match linked {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(err),
    }
}

/// Removes `file` only while it names this process, so a release never takes a later owner's lock.
fn release_own(file: &Path) {
    if let Ok(Some(owner)) = owner_of(file) {
        if owner.pid == Some(std::process::id()) {
            let _ = std::fs::remove_file(file);
        }
    }
}

/// Removes a dead owner's lock under an evict lock, re-reading the owner, so a live owner's lock survives. False
/// when another evictor holds the evict lock (a dead one's is cleared).
fn evict_dead_owner(
    file: &Path,
    starts: &mut HashMap<u32, Option<String>>,
    start: Option<&str>,
) -> std::io::Result<bool> {
    let mut evictor = file.as_os_str().to_os_string();
    evictor.push(".evict");
    let evictor = PathBuf::from(evictor);
    if !claim(&evictor, start)? {
        remove_if_dead(&evictor, owner_of(&evictor)?, starts)?;
        return Ok(false);
    }
    let result = owner_of(file).and_then(|owner| remove_if_dead(file, owner, starts));
    release_own(&evictor);
    result.map(|()| true)
}

fn remove_if_dead(
    lock: &Path,
    owner: Option<Owner>,
    starts: &mut HashMap<u32, Option<String>>,
) -> std::io::Result<()> {
    let Some(owner) = owner else { return Ok(()) };
    if holds(&owner, starts) {
        return Ok(());
    }
    if owner_of(lock)?.as_ref() == Some(&owner) {
        let _ = std::fs::remove_file(lock);
    }
    Ok(())
}

/// A tiny scratch directory (the crate has no `tempfile` dependency), shared by the design modules' tests.
#[cfg(test)]
pub(crate) mod scratch {
    use std::path::{Path, PathBuf};

    pub struct Dir(PathBuf);

    impl Dir {
        pub fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("ov-{label}-{}-{}", std::process::id(), super::random_hex()));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock_path(dir: &tempdir::Dir) -> PathBuf {
        dir.path().join(".lock")
    }

    use super::scratch as tempdir;

    /// The pid of a process that has exited.
    fn dead_pid() -> u32 {
        #[cfg(windows)]
        let mut command = std::process::Command::new("cmd");
        #[cfg(windows)]
        command.args(["/C", "exit 0"]);
        #[cfg(not(windows))]
        let mut command = std::process::Command::new("true");
        let mut child = command.spawn().expect("a short-lived process");
        let pid = child.id();
        child.wait().expect("it exits");
        pid
    }

    #[test]
    fn parses_the_lock_formats_of_both_sides() {
        let owner = |pid: u32, start: Option<&str>| Owner { pid: Some(pid), start: start.map(str::to_string) };
        assert_eq!(parse_owner("123"), owner(123, None));
        assert_eq!(parse_owner("123 Mon Oct  6 14:02:29 2026"), owner(123, Some("Mon Oct  6 14:02:29 2026")));
        assert_eq!(parse_owner("9 abc:77"), owner(9, Some("abc:77")));
        for garbage in ["", "abc", " 12", "12 ", "12x", "12\n"] {
            assert_eq!(parse_owner(garbage).pid, None, "{garbage:?} holds no pid");
        }
        assert_eq!(parse_owner("99999999999999999999").pid, None);
    }

    #[test]
    fn windows_starts_compare_with_a_tolerance_and_others_exactly() {
        assert!(same_start("win-ms:1000000", "win-ms:1005000"));
        assert!(!same_start("win-ms:1000000", "win-ms:1020000"));
        assert!(same_start("Mon Oct  6 14:02:29 2026", "Mon Oct  6 14:02:29 2026"));
        assert!(!same_start("Mon Oct  6 14:02:29 2026", "Mon Oct  6 14:02:30 2026"));
        assert!(!same_start("win-ms:1000000", "Mon Oct  6 14:02:29 2026"));
    }

    #[cfg(unix)]
    #[test]
    fn this_process_has_a_start_key() {
        let key = process_start_key(std::process::id()).expect("a start key on this platform");
        assert_eq!(Some(key.as_str()), own_start());
    }

    #[test]
    fn a_free_lock_is_taken_and_released_and_leaves_no_drafts() {
        let dir = tempdir::Dir::new("lock-free");
        let file = lock_path(&dir);
        let guard = acquire(&file, Duration::from_millis(100)).expect("free lock");
        let written = std::fs::read_to_string(&file).expect("lock file");
        assert!(written.starts_with(&std::process::id().to_string()), "{written:?}");
        drop(guard);
        assert!(!file.exists());
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).expect("dir").flatten().collect();
        assert!(leftovers.is_empty(), "drafts left behind: {leftovers:?}");
    }

    #[test]
    fn a_live_owner_makes_a_second_writer_fail_after_its_wait() {
        let dir = tempdir::Dir::new("lock-live");
        let file = lock_path(&dir);
        let _held = acquire(&file, Duration::from_millis(100)).expect("free lock");
        let started = Instant::now();
        let second = acquire(&file, Duration::from_millis(200));
        assert!(matches!(second, Err(LockError::Busy(Some(pid))) if pid == std::process::id()), "{second:?}");
        assert!(started.elapsed() >= Duration::from_millis(200), "waited out its time");
        assert!(file.exists(), "a live owner's lock stays");
    }

    #[test]
    fn a_waiting_writer_gets_the_lock_when_the_owner_lets_go() {
        let dir = tempdir::Dir::new("lock-wait");
        let file = lock_path(&dir);
        let held = acquire(&file, Duration::from_millis(100)).expect("free lock");
        let waiter = {
            let file = file.clone();
            std::thread::spawn(move || acquire(&file, Duration::from_secs(5)).map(|_| ()))
        };
        std::thread::sleep(Duration::from_millis(150));
        drop(held);
        waiter.join().expect("thread").expect("the waiter got the lock");
    }

    #[test]
    fn a_dead_owners_lock_is_evicted() {
        let dir = tempdir::Dir::new("lock-dead");
        let file = lock_path(&dir);
        let pid = dead_pid();
        std::fs::write(&file, pid.to_string()).expect("stale lock");
        let guard = acquire(&file, Duration::from_millis(200)).expect("a dead owner's lock is taken over");
        assert!(std::fs::read_to_string(&file).expect("lock").starts_with(&std::process::id().to_string()));
        drop(guard);
        assert!(!file.exists());
    }

    #[test]
    fn a_lock_without_a_pid_or_with_a_dead_evictor_does_not_block() {
        let dir = tempdir::Dir::new("lock-garbage");
        let file = lock_path(&dir);
        std::fs::write(&file, "not a pid").expect("garbage lock");
        std::fs::write(dir.path().join(".lock.evict"), dead_pid().to_string()).expect("stale evict lock");
        let guard = acquire(&file, Duration::from_millis(500)).expect("garbage reads as dead");
        drop(guard);
        assert!(!file.exists());
    }

    #[cfg(unix)]
    mod with_other_processes {
        use super::*;

        struct Sleeper(std::process::Child);

        impl Sleeper {
            fn new() -> Self {
                Self(
                    std::process::Command::new("sleep")
                        .arg("30")
                        .spawn()
                        .expect("a long-lived process"),
                )
            }
        }

        impl Drop for Sleeper {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        #[test]
        fn a_live_foreign_owner_holds_with_or_without_a_start_key() {
            let sleeper = Sleeper::new();
            let pid = sleeper.0.id();
            let key = process_start_key(pid).expect("start key of a live process");
            for content in [pid.to_string(), format!("{pid} {key}")] {
                let dir = tempdir::Dir::new("lock-foreign");
                let file = lock_path(&dir);
                std::fs::write(&file, &content).expect("foreign lock");
                let result = acquire(&file, Duration::from_millis(150));
                assert!(matches!(result, Err(LockError::Busy(Some(p))) if p == pid), "{content:?}: {result:?}");
                assert_eq!(std::fs::read_to_string(&file).expect("lock"), content, "never evicted");
            }
        }

        #[test]
        fn a_reused_pid_with_a_different_start_is_evicted() {
            let sleeper = Sleeper::new();
            let dir = tempdir::Dir::new("lock-reused");
            let file = lock_path(&dir);
            std::fs::write(&file, format!("{} some other start", sleeper.0.id())).expect("stale lock");
            let guard = acquire(&file, Duration::from_millis(500)).expect("a reused pid does not hold");
            drop(guard);
            assert!(!file.exists());
        }
    }
}
