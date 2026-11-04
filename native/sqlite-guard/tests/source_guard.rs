//! Native guarded reads against an independently running synthetic producer.
//! One test serializes all engine ownership; no private capture is opened.
use agent_insights_sqlite_guard::{ApprovedSource, GuardError, GuardedDatabase};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// Own a temporary database and a separate producer process, avoiding same-process POSIX lock interference.
struct Fixture {
    root: tempfile::TempDir,
    writer: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Fixture {
    /// Create a fictional database and wait for the producer's ready acknowledgement.
    fn new(wal: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut writer = Command::new("node")
            .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/writer.mjs"))
            .arg(root.path().join("source.db"))
            .arg(if wal { "wal" } else { "delete" })
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = writer.stdin.take().unwrap();
        let output = BufReader::new(writer.stdout.take().unwrap());
        let mut fixture = Self {
            root,
            writer,
            input,
            output,
        };
        assert_eq!(fixture.reply(), "ready");
        fixture
    }

    /// Return the only test-authorized main path.
    fn path(&self) -> PathBuf {
        self.root.path().join("source.db")
    }

    /// Read one bounded, fixed producer acknowledgement.
    fn reply(&mut self) -> String {
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        assert!(line.len() < 64 && !line.is_empty());
        line.trim().to_owned()
    }

    /// Issue only fixture-control commands, not SQL or captured content.
    fn command(&mut self, command: &str) -> String {
        writeln!(self.input, "{command}").unwrap();
        self.input.flush().unwrap();
        self.reply()
    }
}

impl Drop for Fixture {
    /// Stop and reap only this fixture's owned process before temporary files are removed.
    fn drop(&mut self) {
        if self
            .writer
            .try_wait()
            .expect("query fixture process state")
            .is_none()
        {
            self.writer.kill().expect("stop owned fixture process");
        }
        self.writer.wait().expect("reap owned fixture process");
    }
}

#[test]
fn guarded_source_contract() {
    for wal in [false, true] {
        let mut fixture = Fixture::new(wal);
        let before = std::fs::read(fixture.path()).unwrap();
        let wal_before =
            wal.then(|| std::fs::read(fixture.path().with_file_name("source.db-wal")).unwrap());
        let source = ApprovedSource::capture(&fixture.path()).unwrap();
        // This integration-test process has no other SQLite consumers; the writer is a different process.
        let mut database = unsafe { GuardedDatabase::open(source) }.unwrap();
        assert_eq!(
            database.scalar_i64(c"SELECT value FROM items WHERE id=1"),
            Ok(7)
        );
        if let Some(before) = &wal_before {
            assert_eq!(
                &std::fs::read(fixture.path().with_file_name("source.db-wal")).unwrap(),
                before
            );
        }
        if wal {
            assert_eq!(fixture.command("update"), "updated");
            assert_eq!(
                database.scalar_i64(c"SELECT value FROM items WHERE id=1"),
                Ok(7)
            );
            assert_eq!(database.source_changed(), Ok(true));
        }
        let wal_after_writer =
            wal.then(|| std::fs::read(fixture.path().with_file_name("source.db-wal")).unwrap());
        database.close().unwrap();
        assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
        if let Some(before) = wal_after_writer {
            assert_eq!(
                std::fs::read(fixture.path().with_file_name("source.db-wal")).unwrap(),
                before
            );
        }
    }
    let mut fixture = Fixture::new(true);
    let source = ApprovedSource::capture(&fixture.path()).unwrap();
    assert_eq!(fixture.command("close"), "closed");
    // Missing companions are explicit; no connection may recreate them.
    assert!(matches!(
        unsafe { GuardedDatabase::open(source) },
        Err(GuardError::SourceUnavailable)
    ));
    assert!(!fixture.path().with_file_name("source.db-wal").exists());
    assert!(!fixture.path().with_file_name("source.db-shm").exists());
    admission_and_query_failures();
    bounded_lock_wait();
    readonly_shm_without_producer_requires_recovery();
    #[cfg(unix)]
    unix_source_boundaries();
    #[cfg(windows)]
    windows_source_permissions();

    #[cfg(feature = "qualification-hooks")]
    {
        producer_shutdown_between_preflight_and_native_open();
        denied_mutations_stay_fatal();
        shared_memory_extents_are_not_extended();
        replacement_at_native_open_is_rejected();
    }
}

/// Close the real producer after preflight but before the guard's actual main-file open.
#[cfg(feature = "qualification-hooks")]
fn producer_shutdown_between_preflight_and_native_open() {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    let fixture = Arc::new(Mutex::new(Fixture::new(true)));
    let path = fixture.lock().unwrap().path();
    let ran = Arc::new(AtomicBool::new(false));
    let opens = Arc::new(Mutex::new(Vec::new()));
    let producer = fixture.clone();
    let triggered = ran.clone();
    let observed = opens.clone();
    let source = ApprovedSource::capture(&path)
        .unwrap()
        .with_open_barrier(move |selected| {
            observed
                .lock()
                .unwrap()
                .push(selected.file_name().unwrap().to_os_string());
            if selected.file_name().unwrap() == "source.db"
                && !triggered.swap(true, Ordering::SeqCst)
            {
                assert_eq!(producer.lock().unwrap().command("close"), "closed");
                assert!(GuardedDatabase::qualification_open_shm().is_err());
                assert!(!selected.with_file_name("source.db-shm").exists());
            }
        });
    // The test owns the quiescent reader engine; the producer is a separate process.
    let outcome = unsafe { GuardedDatabase::open(source) };
    assert!(matches!(outcome, Err(GuardError::SourceUnavailable)));
    assert!(ran.load(Ordering::SeqCst));
    assert!(
        opens
            .lock()
            .unwrap()
            .iter()
            .any(|name| name == "source.db-wal")
    );
    assert!(!path.with_file_name("source.db-wal").exists());
    assert!(!path.with_file_name("source.db-shm").exists());
}

/// Ignored native errors must not permit a later successful read or mutate source bytes.
#[cfg(feature = "qualification-hooks")]
fn denied_mutations_stay_fatal() {
    use agent_insights_sqlite_guard::QualificationOperation;
    for operation in [
        QualificationOperation::Write,
        QualificationOperation::Truncate,
        QualificationOperation::Delete,
        QualificationOperation::SizeHint,
    ] {
        let fixture = Fixture::new(false);
        let before = std::fs::read(fixture.path()).unwrap();
        let source = ApprovedSource::capture(&fixture.path()).unwrap();
        // Only this test owns the reader engine; the writer is a different process.
        let mut database = unsafe { GuardedDatabase::open(source) }.unwrap();
        database.qualification_deny(operation).unwrap();
        assert_eq!(
            database.scalar_i64(c"SELECT value FROM items"),
            Err(GuardError::PolicyViolation)
        );
        assert_eq!(database.close(), Err(GuardError::PolicyViolation));
        assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
    }
}

/// Invalid input and out-of-scope statements must fail without modifying source bytes.
fn admission_and_query_failures() {
    let fixture = Fixture::new(false);
    let before = std::fs::read(fixture.path()).unwrap();
    assert!(matches!(
        ApprovedSource::capture(std::path::Path::new("source.db")),
        Err(GuardError::InvalidInput)
    ));
    let source = ApprovedSource::capture(&fixture.path()).unwrap();
    // The test owns the reader engine exclusively.
    let mut database = unsafe { GuardedDatabase::open(source) }.unwrap();
    assert!(matches!(
        ApprovedSource::capture(&fixture.path()),
        Err(GuardError::InUse)
    ));
    for sql in [
        c"SELECT value FROM items; SELECT 1",
        c"UPDATE items SET value=9 RETURNING value",
        c"PRAGMA query_only=OFF",
    ] {
        assert_eq!(database.scalar_i64(sql), Err(GuardError::InvalidInput));
    }
    assert!(
        database
            .scalar_i64(c"ATTACH DATABASE 'unapproved.db' AS other")
            .is_err()
    );
    assert!(
        database
            .scalar_i64(c"SELECT load_extension('unapproved')")
            .is_err()
    );
    assert_eq!(
        database.scalar_i64(c"SELECT 9223372036854775807"),
        Ok(i64::MAX)
    );
    database.close().unwrap();
    assert_eq!(std::fs::read(fixture.path()).unwrap(), before);

    let journal = fixture.path().with_file_name("source.db-journal");
    std::fs::write(&journal, b"unfinished fixture journal").unwrap();
    assert!(matches!(
        ApprovedSource::capture(&fixture.path()),
        Err(GuardError::RecoveryRequired)
    ));
    std::fs::remove_file(journal).unwrap();
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(fixture.path())
        .unwrap();
    file.set_len(agent_insights_sqlite_guard::MAX_SOURCE_BYTES)
        .unwrap();
    assert!(ApprovedSource::capture(&fixture.path()).is_ok());
    file.set_len(agent_insights_sqlite_guard::MAX_SOURCE_BYTES + 1)
        .unwrap();
    assert!(matches!(
        ApprovedSource::capture(&fixture.path()),
        Err(GuardError::Limit)
    ));
    file.set_len(before.len() as u64).unwrap();
}

/// A separate writer's native lock must time out, not become an empty successful read.
fn bounded_lock_wait() {
    let mut fixture = Fixture::new(false);
    let source = ApprovedSource::capture(&fixture.path()).unwrap();
    assert_eq!(fixture.command("lock"), "locked");
    let began = std::time::Instant::now();
    // Only the producer process owns the conflicting SQLite lock.
    let result = unsafe { GuardedDatabase::open(source) };
    assert!(matches!(result, Err(GuardError::Busy)));
    assert!(began.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(fixture.command("unlock"), "unlocked");
    let source = ApprovedSource::capture(&fixture.path()).unwrap();
    // Failed setup must release all guard ownership before a retry.
    let database = unsafe { GuardedDatabase::open(source) }.unwrap();
    database.close().unwrap();
}

/// Exercise POSIX links, permissions and replacement without touching non-fixture data.
#[cfg(unix)]
fn unix_source_boundaries() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let fixture = Fixture::new(true);
    let link = fixture.path().with_file_name("linked.db");
    symlink(fixture.path(), &link).unwrap();
    assert!(matches!(
        ApprovedSource::capture(&link),
        Err(GuardError::SourceChanged)
    ));
    let source = ApprovedSource::capture(&fixture.path()).unwrap();
    let wal = fixture.path().with_file_name("source.db-wal");
    std::fs::set_permissions(&wal, std::fs::Permissions::from_mode(0o0)).unwrap();
    // Normal hosted/local users cannot open this existing WAL; there is no malformed-data fallback.
    let result = unsafe { GuardedDatabase::open(source) };
    std::fs::set_permissions(&wal, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(matches!(result, Err(GuardError::AccessDenied)));

    let source = ApprovedSource::capture(&fixture.path()).unwrap();
    let original = fixture.path().with_file_name("retained-original.db");
    std::fs::rename(fixture.path(), &original).unwrap();
    std::fs::write(fixture.path(), b"replacement").unwrap();
    assert!(matches!(
        unsafe { GuardedDatabase::open(source) },
        Err(GuardError::SourceChanged)
    ));
    std::fs::remove_file(fixture.path()).unwrap();
    std::fs::rename(original, fixture.path()).unwrap();
}

/// The real SHM mapping/resize paths must reject growth and retain the original length.
#[cfg(feature = "qualification-hooks")]
fn shared_memory_extents_are_not_extended() {
    for resize in [false, true] {
        let fixture = Fixture::new(true);
        let path = fixture.path().with_file_name("source.db-shm");
        let before = std::fs::metadata(&path).unwrap().len();
        let source = ApprovedSource::capture(&fixture.path()).unwrap();
        // The integration process owns only this guarded engine.
        let mut database = unsafe { GuardedDatabase::open(source) }.unwrap();
        assert!(database.qualification_shm_limit(resize).is_err());
        let expected = if resize {
            GuardError::RecoveryRequired
        } else {
            GuardError::Limit
        };
        assert_eq!(
            database.scalar_i64(c"SELECT value FROM items"),
            Err(expected)
        );
        assert_eq!(database.close(), Err(expected));
        assert_eq!(std::fs::metadata(path).unwrap().len(), before);
    }
}

/// Deny only read-data access on the owned WAL and restore that test ACL before teardown.
#[cfg(windows)]
fn windows_source_permissions() {
    let fixture = Fixture::new(true);
    let source = ApprovedSource::capture(&fixture.path()).unwrap();
    let wal = fixture.path().with_file_name("source.db-wal");
    let user = std::env::var("USERNAME").expect("Windows test account");
    let denied = Command::new("icacls")
        .arg(&wal)
        .arg("/deny")
        .arg(format!("{user}:(RD)"))
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(denied.success(), "Fixture ACL denial must be applied");
    // The test owns the quiescent reader; only the temporary WAL's ACL changed.
    let result = unsafe { GuardedDatabase::open(source) };
    let restored = Command::new("icacls")
        .arg(&wal)
        .arg("/remove:d")
        .arg(&user)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(restored.success(), "Fixture ACL must be restored");
    assert!(matches!(result, Err(GuardError::AccessDenied)));
}

/// Replacing the main file after metadata checks must fail the actual handle-identity check.
#[cfg(feature = "qualification-hooks")]
fn replacement_at_native_open_is_rejected() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let mut fixture = Fixture::new(false);
    let path = fixture.path();
    let source = ApprovedSource::capture(&path).unwrap();
    assert_eq!(fixture.command("close"), "closed");
    let ran = Arc::new(AtomicBool::new(false));
    let triggered = ran.clone();
    let source = source.with_open_barrier(move |selected| {
        if !triggered.swap(true, Ordering::SeqCst) {
            let original = selected.with_file_name("original.db");
            std::fs::rename(selected, &original).unwrap();
            std::fs::copy(original, selected).unwrap();
        }
    });
    // The producer has closed and the reader engine is exclusively owned.
    let result = unsafe { GuardedDatabase::open(source) };
    assert!(matches!(result, Err(GuardError::SourceChanged)));
    assert!(ran.load(Ordering::SeqCst));
}

/// Retained read-only SHM with no live DMS owner must not become a heap-index recovery fallback.
fn readonly_shm_without_producer_requires_recovery() {
    for undersized in [false, true] {
        let mut fixture = Fixture::new(true);
        fixture.writer.kill().unwrap();
        fixture.writer.wait().unwrap();
        let shm = fixture.path().with_file_name("source.db-shm");
        if undersized {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&shm)
                .unwrap()
                .set_len(1)
                .unwrap();
        }
        let source = ApprovedSource::capture(&fixture.path()).unwrap();
        let writable = std::fs::metadata(&shm).unwrap().permissions();
        #[cfg(unix)]
        let readonly = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::Permissions::from_mode(0o400)
        };
        #[cfg(windows)]
        let readonly = {
            let mut permissions = writable.clone();
            permissions.set_readonly(true);
            permissions
        };
        std::fs::set_permissions(&shm, readonly).unwrap();
        // The producer is dead and the reader engine is exclusively owned.
        let result = unsafe { GuardedDatabase::open(source) };
        std::fs::set_permissions(&shm, writable).unwrap();
        assert!(
            matches!(result, Err(GuardError::RecoveryRequired)),
            "Read-only SHM without a live producer must require recovery (undersized={undersized})"
        );
    }
}
