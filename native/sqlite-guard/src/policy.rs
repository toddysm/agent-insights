//! Own one guarded connection and its process-global VFS hooks.
//! Mutations denied by callbacks stay fatal even when SQLite ignores their return code.

use crate::helper::wire::Cell;
use crate::{ApprovedSource, GuardError, inspect_native_abi, platform, source::Role};
use base64::{Engine, engine::general_purpose::STANDARD};
use libsqlite3_sys as ffi;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::io::Write;
use std::path::Path;
use std::ptr;
use std::sync::{
    Mutex, MutexGuard,
    atomic::{AtomicBool, AtomicPtr, Ordering},
};

mod io;

/// Arm the test-only VFS failure after the guard has opened the synthetic source.
#[cfg(test)]
pub(crate) fn fail_next_read() {
    io::fail_next_read();
}

static ENGINE: Mutex<()> = Mutex::new(());
static STATE: Mutex<Option<State>> = Mutex::new(None);
static BASE: AtomicPtr<ffi::sqlite3_vfs> = AtomicPtr::new(ptr::null_mut());
static POISONED: AtomicBool = AtomicBool::new(false);
const NAME: &CStr = c"agent-insights-read-only";

/// Test-only forbidden operations against actual native file methods.
#[cfg(feature = "qualification-hooks")]
pub enum QualificationOperation {
    /// Attempt a main-file write.
    Write,
    /// Attempt a main-file truncate.
    Truncate,
    /// Attempt source deletion.
    Delete,
    /// Attempt a preallocation/size hint.
    SizeHint,
}

/// One original OS callback retained until the guarded connection is closed.
struct SavedHook {
    name: &'static CStr,
    original: ffi::sqlite3_syscall_ptr,
}

/// No captured rows are retained here; state records authorization and sticky errors only.
struct State {
    source: ApprovedSource,
    handles: HashMap<usize, Role>,
    hooks: Vec<SavedHook>,
    failure: Option<GuardError>,
    io_error: Option<GuardError>,
}

/// Prevent transaction-time preflight opens from releasing process-owned POSIX locks.
pub(crate) fn exclusive() -> Result<MutexGuard<'static, ()>, GuardError> {
    admit_engine(&POISONED, || ENGINE.try_lock())
}

/// Check poison only after acquiring ownership, including failure during a competing owner's release.
fn admit_engine<'a>(
    poisoned: &AtomicBool,
    acquire: impl FnOnce() -> std::sync::TryLockResult<MutexGuard<'a, ()>>,
) -> Result<MutexGuard<'a, ()>, GuardError> {
    let owner = acquire().map_err(|error| match error {
        std::sync::TryLockError::WouldBlock => GuardError::InUse,
        std::sync::TryLockError::Poisoned(_) => GuardError::Cleanup,
    })?;
    if poisoned.load(Ordering::Acquire) {
        return Err(GuardError::Cleanup);
    }
    Ok(owner)
}

/// A failed callback probe may have left native sentinels installed; this engine cannot be reused.
fn poison_failed_probe<T>(
    result: Result<T, GuardError>,
    poisoned: &AtomicBool,
) -> Result<T, GuardError> {
    result.inspect_err(|_| poisoned.store(true, Ordering::Release))
}

/// Record a failed guard invariant; callers cannot recover by ignoring SQLite's result.
pub(crate) fn deny(error: GuardError) {
    if error == GuardError::Cleanup {
        POISONED.store(true, Ordering::Release);
    }
    if let Ok(mut state) = STATE.lock()
        && let Some(state) = state.as_mut()
    {
        if error == GuardError::Cleanup {
            state.failure = Some(error);
        } else {
            state.failure.get_or_insert(error);
        }
    }
}

/// Remember an OS access failure for a controlled SQLite error; safe native read-only retries may still succeed.
pub(crate) fn note_io(error: GuardError) {
    if let Ok(mut state) = STATE.lock()
        && let Some(state) = state.as_mut()
    {
        state.io_error = Some(error);
    }
}

/// Resolve an exact admitted filename before a native open; no content-derived path is admitted.
pub(crate) fn entry(path: &Path) -> Result<crate::source::Entry, GuardError> {
    if POISONED.load(Ordering::Acquire) {
        return Err(GuardError::Cleanup);
    }
    let state = STATE.lock().map_err(|_| GuardError::GuardUnavailable)?;
    let state = state.as_ref().ok_or(GuardError::GuardUnavailable)?;
    state
        .source
        .entry(path)
        .cloned()
        .ok_or(GuardError::PolicyViolation)
}

/// Run a qualification-only race barrier after admission but before the actual OS open.
pub(crate) fn before_open(_path: &Path) {
    #[cfg(feature = "qualification-hooks")]
    {
        let callback = STATE.lock().ok().and_then(|state| {
            state
                .as_ref()
                .and_then(|state| state.source.before_open.clone())
        });
        if let Some(callback) = callback {
            callback(_path);
        }
    }
}

/// Associate a successfully identity-checked OS handle with its permitted source role.
pub(crate) fn remember(handle: usize, role: Role) -> Result<(), GuardError> {
    let mut state = STATE.lock().map_err(|_| GuardError::GuardUnavailable)?;
    let state = state.as_mut().ok_or(GuardError::GuardUnavailable)?;
    state.handles.insert(handle, role);
    Ok(())
}

/// Remove a handle at native close; unknown internal handles have no source authorization to retain.
pub(crate) fn forget(handle: usize) {
    if let Ok(mut state) = STATE.lock()
        && let Some(state) = state.as_mut()
    {
        state.handles.remove(&handle);
    }
}

/// Validate actual handle identity, file length and writable-mapping role before mapping.
pub(crate) fn mapping(
    handle: usize,
    identity: &platform::Identity,
    size: u64,
    end: u64,
    writable: bool,
) -> Result<(), GuardError> {
    let state = STATE.lock().map_err(|_| GuardError::GuardUnavailable)?;
    let state = state.as_ref().ok_or(GuardError::GuardUnavailable)?;
    let role = state
        .handles
        .get(&handle)
        .ok_or(GuardError::PolicyViolation)?;
    let expected = state
        .source
        .entries
        .iter()
        .find(|entry| &entry.role == role)
        .ok_or(GuardError::PolicyViolation)?;
    if &expected.identity != identity {
        return Err(GuardError::SourceChanged);
    }
    if end > size || size > crate::MAX_SOURCE_BYTES {
        return Err(GuardError::Limit);
    }
    if writable && *role != Role::Shm {
        return Err(GuardError::PolicyViolation);
    }
    Ok(())
}

/// Return an installed callback's original address; no address is emitted in diagnostics.
pub(crate) fn original(name: &CStr) -> ffi::sqlite3_syscall_ptr {
    STATE.lock().ok().and_then(|state| {
        state.as_ref().and_then(|state| {
            state
                .hooks
                .iter()
                .find(|hook| hook.name == name)
                .and_then(|hook| hook.original)
        })
    })
}

/// Return the owned engine's original VFS; lifetime is bounded by the connection.
pub(crate) fn base() -> *mut ffi::sqlite3_vfs {
    BASE.load(Ordering::Acquire)
}

/// Recover a fixed failure before interpreting native result data.
fn check() -> Result<(), GuardError> {
    let state = STATE.lock().map_err(|_| GuardError::GuardUnavailable)?;
    state
        .as_ref()
        .ok_or(GuardError::GuardUnavailable)?
        .failure
        .map_or(Ok(()), Err)
}

/// Scope ordinary OS errors to one native call, without clearing sticky guard failures.
fn reset_io_error() -> Result<(), GuardError> {
    let mut state = STATE.lock().map_err(|_| GuardError::GuardUnavailable)?;
    state.as_mut().ok_or(GuardError::GuardUnavailable)?.io_error = None;
    Ok(())
}

/// Convert native errors without preserving SQLite's source-dependent messages.
fn sqlite_error(code: c_int) -> GuardError {
    if let Err(error) = check() {
        return error;
    }
    let io = STATE
        .lock()
        .ok()
        .and_then(|state| state.as_ref().and_then(|state| state.io_error));
    match code & 0xff {
        ffi::SQLITE_BUSY | ffi::SQLITE_LOCKED => GuardError::Busy,
        ffi::SQLITE_CANTOPEN => io.unwrap_or(GuardError::SourceUnavailable),
        ffi::SQLITE_IOERR => io.unwrap_or(GuardError::Io),
        ffi::SQLITE_PERM => io.unwrap_or(GuardError::AccessDenied),
        ffi::SQLITE_AUTH => GuardError::InvalidInput,
        ffi::SQLITE_READONLY => GuardError::RecoveryRequired,
        _ => GuardError::Data,
    }
}

/// Reject configuration changes during preparation, before PRAGMA side effects can run.
///
/// # Safety
/// SQLite supplies optional NUL-terminated authorizer arguments valid for this call.
unsafe extern "C" fn authorize(
    _context: *mut c_void,
    action: c_int,
    first: *const c_char,
    second: *const c_char,
    _database: *const c_char,
    _trigger: *const c_char,
) -> c_int {
    let allowed = match action {
        ffi::SQLITE_SELECT
        | ffi::SQLITE_READ
        | ffi::SQLITE_FUNCTION
        | ffi::SQLITE_RECURSIVE
        | ffi::SQLITE_TRANSACTION => true,
        ffi::SQLITE_PRAGMA if !first.is_null() => {
            let name = unsafe { CStr::from_ptr(first) }.to_bytes();
            if [b"table_list".as_slice(), b"table_xinfo"]
                .iter()
                .any(|allowed| name.eq_ignore_ascii_case(allowed))
            {
                return ffi::SQLITE_OK;
            }
            [
                b"query_only".as_slice(),
                b"trusted_schema",
                b"busy_timeout",
                b"user_version",
                b"data_version",
            ]
            .iter()
            .any(|allowed| name.eq_ignore_ascii_case(allowed))
                && second.is_null()
        }
        _ => false,
    };
    if allowed {
        ffi::SQLITE_OK
    } else {
        ffi::SQLITE_DENY
    }
}

/// Record the one fixed PRAGMA result; unknown shapes fail initialization rather than selecting a default mode.
///
/// # Safety
/// SQLite supplies valid row pointers; context points to the live `Option<bool>` passed by `uses_wal`.
unsafe extern "C" fn observe_journal_mode(
    context: *mut c_void,
    columns: c_int,
    values: *mut *mut c_char,
    _names: *mut *mut c_char,
) -> c_int {
    if context.is_null() || columns != 1 || values.is_null() || unsafe { *values }.is_null() {
        return 1;
    }
    let mode = unsafe { &mut *context.cast::<Option<bool>>() };
    if mode.is_some() {
        return 1;
    }
    *mode = match unsafe { CStr::from_ptr(*values) }.to_bytes() {
        b"wal" => Some(true),
        b"delete" | b"truncate" | b"persist" | b"memory" | b"off" => Some(false),
        _ => return 1,
    };
    0
}

/// A read-only connection with owned policy hooks. It cannot be sent across threads.
///
/// WAL reads share a connection-lifetime snapshot. Rollback-mode statements use
/// separate implicit snapshots so an idle connection does not block producer commits.
///
/// The application still owns source authorization, named query selection and
/// process-level cancellation. This core does not discover sources or restore a producer runtime.
pub struct GuardedDatabase {
    db: *mut ffi::sqlite3,
    wrapper: Box<ffi::sqlite3_vfs>,
    source: ApprovedSource,
    installed: bool,
    _exclusive: MutexGuard<'static, ()>,
}

impl GuardedDatabase {
    /// Arm one close error at a qualification barrier; the real test handle is released before failure is reported.
    ///
    /// Qualification builds only. Rejected-open cleanup must poison later engine admission.
    #[cfg(feature = "qualification-hooks")]
    pub fn qualification_fail_close() {
        platform::qualification_fail_close();
    }

    /// Inject a native unmap error during close; the test mapping is still released to allow fixture cleanup.
    ///
    /// Qualification builds only. Closing must fail and permanently poison this process's engine.
    #[cfg(feature = "qualification-hooks")]
    pub fn qualification_fail_unmap(&mut self) {
        platform::qualification_fail_unmap();
    }

    /// Attempt out-of-bounds SHM mapping or resize through the real native guard.
    ///
    /// Qualification-only: this does not add a protocol operation or release capability.
    #[cfg(feature = "qualification-hooks")]
    pub fn qualification_shm_limit(&mut self, resize: bool) -> Result<(), GuardError> {
        let handle = STATE
            .lock()
            .map_err(|_| GuardError::GuardUnavailable)?
            .as_ref()
            .ok_or(GuardError::GuardUnavailable)?
            .handles
            .iter()
            .find(|(_, role)| **role == Role::Shm)
            .map(|(handle, _)| *handle)
            .ok_or(GuardError::SourceUnavailable)?;
        platform::qualification_shm_limit(handle, resize)
    }

    /// Probe an internal SHM open without passing through ordinary VFS xOpen.
    ///
    /// Used only by deterministic qualification barriers. Release helpers must
    /// not enable `qualification-hooks`.
    #[cfg(feature = "qualification-hooks")]
    pub fn qualification_open_shm() -> Result<(), GuardError> {
        let path = STATE
            .lock()
            .map_err(|_| GuardError::GuardUnavailable)?
            .as_ref()
            .ok_or(GuardError::GuardUnavailable)?
            .source
            .entries
            .iter()
            .find(|entry| entry.role == Role::Shm)
            .ok_or(GuardError::SourceUnavailable)?
            .path
            .clone();
        platform::qualification_open_shm(&path)
    }

    /// Exercise a denied native operation and deliberately ignore its low-level result.
    ///
    /// A later read/close must still return the latched policy violation.
    #[cfg(feature = "qualification-hooks")]
    pub fn qualification_deny(
        &mut self,
        operation: QualificationOperation,
    ) -> Result<(), GuardError> {
        let mut file: *mut ffi::sqlite3_file = ptr::null_mut();
        let rc = unsafe {
            ffi::sqlite3_file_control(
                self.db,
                ptr::null(),
                ffi::SQLITE_FCNTL_FILE_POINTER,
                (&mut file as *mut *mut ffi::sqlite3_file).cast(),
            )
        };
        if rc != ffi::SQLITE_OK || file.is_null() {
            return Err(GuardError::GuardUnavailable);
        }
        let methods = unsafe { *(*file).pMethods };
        match operation {
            QualificationOperation::Write => {
                let call = methods.xWrite.ok_or(GuardError::GuardUnavailable)?;
                unsafe {
                    call(file, c"x".as_ptr().cast(), 1, 0);
                }
            }
            QualificationOperation::Truncate => {
                let call = methods.xTruncate.ok_or(GuardError::GuardUnavailable)?;
                unsafe {
                    call(file, 0);
                }
            }
            QualificationOperation::Delete => {
                let path = platform::path_cstring(&self.source.main)?;
                unsafe {
                    io::delete(&mut *self.wrapper, path.as_ptr(), 0);
                }
            }
            QualificationOperation::SizeHint => {
                let call = methods.xFileControl.ok_or(GuardError::GuardUnavailable)?;
                let mut size = (crate::MAX_SOURCE_BYTES * 2) as i64;
                unsafe {
                    call(
                        file,
                        ffi::SQLITE_FCNTL_SIZE_HINT,
                        (&mut size as *mut i64).cast(),
                    );
                }
            }
        }
        Ok(())
    }
    /// Install enforcement and establish a WAL snapshot, or release initial rollback-mode read locks.
    ///
    /// # Safety
    /// This process must own this SQLite engine exclusively, without foreign
    /// connections or concurrent VFS consumers for the entire returned lifetime.
    ///
    /// # Errors
    /// Source, guard, engine, lock and recovery failures are explicit. Setup
    /// attempts owned cleanup; failed interface probes or cleanup poison admission
    /// and require discarding the process. No fallback engine or copied database is used.
    pub unsafe fn open(source: ApprovedSource) -> Result<Self, GuardError> {
        let exclusive = exclusive()?;
        // The caller guarantees quiescent, exclusive engine ownership.
        let abi = poison_failed_probe(unsafe { inspect_native_abi() }, &POISONED)?;
        let vfs_name = CString::new(abi.vfs_name).map_err(|_| GuardError::GuardUnavailable)?;
        let base = unsafe { ffi::sqlite3_vfs_find(vfs_name.as_ptr()) };
        if base.is_null() {
            return Err(GuardError::GuardUnavailable);
        }
        source.verify()?;
        let mut wrapper = Box::new(unsafe { *base });
        wrapper.pNext = ptr::null_mut();
        wrapper.zName = NAME.as_ptr();
        wrapper.szOsFile = std::mem::size_of::<io::GuardFile>() as c_int;
        wrapper.xOpen = Some(io::open);
        wrapper.xDelete = Some(io::delete);
        BASE.store(base, Ordering::Release);
        *STATE.lock().map_err(|_| GuardError::GuardUnavailable)? = Some(State {
            source: source.clone(),
            handles: HashMap::new(),
            hooks: Vec::new(),
            failure: None,
            io_error: None,
        });
        let mut owned = Self {
            db: ptr::null_mut(),
            wrapper,
            source,
            installed: false,
            _exclusive: exclusive,
        };
        let result = (|| {
            owned.install_hooks()?;
            if unsafe { ffi::sqlite3_vfs_register(&mut *owned.wrapper, 0) } != ffi::SQLITE_OK {
                return Err(GuardError::GuardUnavailable);
            }

            owned.installed = true;
            let filename = platform::path_cstring(&owned.source.main)?;
            let rc = unsafe {
                ffi::sqlite3_open_v2(
                    filename.as_ptr(),
                    &mut owned.db,
                    ffi::SQLITE_OPEN_READONLY
                        | ffi::SQLITE_OPEN_NOFOLLOW
                        | ffi::SQLITE_OPEN_EXRESCODE,
                    NAME.as_ptr(),
                )
            };
            if rc != ffi::SQLITE_OK {
                return Err(sqlite_error(rc));
            }
            check()?;
            unsafe {
                ffi::sqlite3_busy_timeout(owned.db, 1000);
                ffi::sqlite3_limit(owned.db, ffi::SQLITE_LIMIT_ATTACHED, 0);
                ffi::sqlite3_limit(
                    owned.db,
                    ffi::SQLITE_LIMIT_LENGTH,
                    crate::MAX_SOURCE_BYTES as c_int,
                );
                ffi::sqlite3_limit(owned.db, ffi::SQLITE_LIMIT_SQL_LENGTH, 4096);
            }
            owned.exec(c"PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN; SELECT count(*) FROM sqlite_schema")?;
            if !owned.uses_wal()? {
                owned.exec(c"ROLLBACK")?;
            }
            if unsafe { ffi::sqlite3_set_authorizer(owned.db, Some(authorize), ptr::null_mut()) }
                != ffi::SQLITE_OK
            {
                return Err(GuardError::GuardUnavailable);
            }
            owned.source.verify()?;
            check()
        })();
        if let Err(error) = result {
            owned.finish()?;
            return Err(error);
        }
        Ok(owned)
    }

    /// Install only active, audited OS hooks and verify every assignment.
    fn install_hooks(&mut self) -> Result<(), GuardError> {
        let base = base();
        let get = unsafe { (*base).xGetSystemCall }.ok_or(GuardError::GuardUnavailable)?;
        let set = unsafe { (*base).xSetSystemCall }.ok_or(GuardError::GuardUnavailable)?;
        for (name, replacement, required) in platform::hooks() {
            let original = unsafe { get(base, name.as_ptr()) };
            if original.is_none() {
                if required {
                    return Err(GuardError::GuardUnavailable);
                }
                continue;
            }
            STATE
                .lock()
                .map_err(|_| GuardError::GuardUnavailable)?
                .as_mut()
                .ok_or(GuardError::GuardUnavailable)?
                .hooks
                .push(SavedHook { name, original });
            let rc = unsafe { set(base, name.as_ptr(), replacement) };
            let after = unsafe { get(base, name.as_ptr()) };
            if rc != ffi::SQLITE_OK || !same(after, replacement) {
                return Err(GuardError::GuardUnavailable);
            }
        }
        Ok(())
    }

    /// Observe the actual locked connection's mode, rather than a potentially stale preflight header.
    fn uses_wal(&mut self) -> Result<bool, GuardError> {
        let mut mode = None;
        reset_io_error()?;
        let rc = unsafe {
            ffi::sqlite3_exec(
                self.db,
                c"PRAGMA main.journal_mode".as_ptr(),
                Some(observe_journal_mode),
                (&mut mode as *mut Option<bool>).cast(),
                ptr::null_mut(),
            )
        };
        check()?;
        if rc != ffi::SQLITE_OK {
            return Err(sqlite_error(rc));
        }
        mode.ok_or(GuardError::GuardUnavailable)
    }

    /// Execute only fixed connection setup/teardown statements, never caller input.
    fn exec(&mut self, sql: &CStr) -> Result<(), GuardError> {
        reset_io_error()?;
        let rc = unsafe {
            ffi::sqlite3_exec(
                self.db,
                sql.as_ptr(),
                None,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        check()?;
        if rc != ffi::SQLITE_OK {
            return Err(sqlite_error(rc));
        }
        Ok(())
    }

    /// Read one integer from one code-owned, read-only statement.
    ///
    /// This is a core qualification seam, not a browser/model SQL console. The
    /// protocol item supplies named projections; callers must not pass captured
    /// instructions as SQL. WAL calls retain the original snapshot; rollback-mode
    /// calls each finish their implicit transaction before returning and may
    /// observe different commits. [`Self::source_changed`] reports observed
    /// metadata changes separately, without invalidating a WAL snapshot.
    ///
    /// # Errors
    /// Rejects multi-statements, writes/configuration changes, oversized SQL, non-integer/multiple rows,
    /// source identity changes and every latched policy violation.
    pub fn scalar_i64(&mut self, sql: &CStr) -> Result<i64, GuardError> {
        self.with_statement(sql, 1, |statement| {
            reset_io_error()?;
            let rc = unsafe { ffi::sqlite3_step(statement) };
            check()?;
            if rc == ffi::SQLITE_DONE {
                return Err(GuardError::InvalidInput);
            }
            if rc != ffi::SQLITE_ROW {
                return Err(sqlite_error(rc));
            }
            if unsafe { ffi::sqlite3_column_type(statement, 0) } != ffi::SQLITE_INTEGER {
                return Err(GuardError::Data);
            }
            let value = unsafe { ffi::sqlite3_column_int64(statement, 0) };
            reset_io_error()?;
            let rc = unsafe { ffi::sqlite3_step(statement) };
            check()?;
            if rc == ffi::SQLITE_ROW {
                return Err(GuardError::InvalidInput);
            }
            if rc != ffi::SQLITE_DONE {
                return Err(sqlite_error(rc));
            }
            Ok(value)
        })
    }

    /// Observe main/WAL metadata changes without claiming a global atomic snapshot.
    ///
    /// # Errors
    /// Returns source identity/access/limit or previously latched guard failures.
    pub fn source_changed(&self) -> Result<bool, GuardError> {
        check()?;
        self.source.verify()
    }

    /// Report whether the initial WAL snapshot is retained; rollback reads otherwise use request scopes.
    pub(crate) fn retained_snapshot(&self) -> bool {
        unsafe { ffi::sqlite3_get_autocommit(self.db) == 0 }
    }

    /// Start a bounded internal read scope only when no connection snapshot already exists.
    pub(crate) fn begin_read_scope(&mut self) -> Result<bool, GuardError> {
        check()?;
        self.source.verify()?;
        let started = !self.retained_snapshot();
        if started {
            self.exec(c"BEGIN")?;
        }
        Ok(started)
    }

    /// End only a still-active scope created by the caller; SQLite may already have rolled it back on I/O failure.
    pub(crate) fn end_read_scope(&mut self, started: bool) -> Result<(), GuardError> {
        if started && self.retained_snapshot() {
            self.exec(c"ROLLBACK")?;
        }
        Ok(())
    }

    /// Finish a retained snapshot so data_version can observe commits before final connection cleanup.
    pub(crate) fn release_snapshot(&mut self) -> Result<(), GuardError> {
        self.end_read_scope(self.retained_snapshot())
    }

    /// Visit bounded original cells from one generated read-only statement, finalizing on every result.
    ///
    /// Only the private helper's validated declaration compiler supplies SQL.
    /// Cell bytes are checked before copying; the visitor applies encoded row/key budgets.
    pub(crate) fn read_rows(
        &mut self,
        sql: &CStr,
        bindings: &[Cell],
        max_rows: usize,
        max_raw_bytes: usize,
        mut visit: impl FnMut(Vec<Cell>) -> Result<(), GuardError>,
    ) -> Result<(), GuardError> {
        self.with_statement(sql, 64, |statement| {
            let columns = unsafe { ffi::sqlite3_column_count(statement) };
            if unsafe { ffi::sqlite3_bind_parameter_count(statement) } as usize != bindings.len() {
                return Err(GuardError::InvalidInput);
            }
            for (index, value) in bindings.iter().enumerate() {
                bind_cell(statement, (index + 1) as c_int, value)?;
            }
            let mut count = 0;
            let mut remaining = max_raw_bytes;
            loop {
                reset_io_error()?;
                let rc = unsafe { ffi::sqlite3_step(statement) };
                check()?;
                if rc == ffi::SQLITE_DONE {
                    break;
                }
                if rc != ffi::SQLITE_ROW {
                    return Err(sqlite_error(rc));
                }
                if count >= max_rows {
                    return Err(GuardError::Limit);
                }
                let mut row = Vec::with_capacity(columns as usize);
                for column in 0..columns {
                    row.push(read_cell(statement, column, &mut remaining)?);
                }
                visit(row)?;
                count += 1;
            }
            Ok(())
        })
    }

    /// Share preparation/finalization checks; callbacks must not retain or finalize the borrowed statement.
    fn with_statement<T>(
        &mut self,
        sql: &CStr,
        max_columns: c_int,
        operation: impl FnOnce(*mut ffi::sqlite3_stmt) -> Result<T, GuardError>,
    ) -> Result<T, GuardError> {
        check()?;
        self.source.verify()?;
        if sql.to_bytes().len() > 4096 {
            return Err(GuardError::Limit);
        }
        let mut statement = ptr::null_mut();
        let mut tail = ptr::null();
        reset_io_error()?;
        let rc = unsafe {
            ffi::sqlite3_prepare_v2(self.db, sql.as_ptr(), -1, &mut statement, &mut tail)
        };
        if rc != ffi::SQLITE_OK {
            return Err(sqlite_error(rc));
        }
        if statement.is_null() {
            return Err(GuardError::InvalidInput);
        }
        let result = (|| {
            let columns = unsafe { ffi::sqlite3_column_count(statement) };
            if columns <= 0
                || columns > max_columns
                || unsafe { ffi::sqlite3_stmt_readonly(statement) } == 0
                || !unsafe { CStr::from_ptr(tail) }
                    .to_bytes()
                    .iter()
                    .all(u8::is_ascii_whitespace)
            {
                return Err(GuardError::InvalidInput);
            }
            let value = operation(statement)?;
            self.source.verify()?;
            Ok(value)
        })();
        let finalized = unsafe { ffi::sqlite3_finalize(statement) };
        check()?;
        if finalized != ffi::SQLITE_OK && result.is_ok() {
            return Err(sqlite_error(finalized));
        }
        result
    }

    /// Close the connection and release any WAL snapshot before restoring callbacks; no source checkpoint occurs.
    ///
    /// # Errors
    /// Returns source/policy failures or [`GuardError::Cleanup`] if native teardown fails.
    pub fn close(mut self) -> Result<(), GuardError> {
        let result = check().and_then(|()| self.source.verify().map(|_| ()));
        let closed = self.finish();
        closed?;
        result
    }

    /// Dispose of an already-failed read without new observations; only guard/cleanup failures are returned.
    pub(crate) fn discard(mut self) -> Result<(), GuardError> {
        self.finish()
    }

    /// Close SQLite before releasing hook state, including partial initialization.
    fn finish(&mut self) -> Result<(), GuardError> {
        let mut cleanup = false;
        if !self.db.is_null() {
            if unsafe { ffi::sqlite3_close(self.db) } != ffi::SQLITE_OK {
                POISONED.store(true, Ordering::Release);
                return Err(GuardError::Cleanup);
            }
            self.db = ptr::null_mut();
        }
        let violation = check().err();
        if self.installed {
            if unsafe { ffi::sqlite3_vfs_unregister(&mut *self.wrapper) } != ffi::SQLITE_OK {
                POISONED.store(true, Ordering::Release);
                return Err(GuardError::Cleanup);
            }
            self.installed = false;
        }
        if let Ok(mut state) = STATE.lock() {
            if let Some(state) = state.take() {
                cleanup |= !state.handles.is_empty();
                let base = base();
                if let Some(set) = unsafe { (*base).xSetSystemCall } {
                    let get = unsafe { (*base).xGetSystemCall };
                    for hook in state.hooks.into_iter().rev() {
                        cleanup |= unsafe { set(base, hook.name.as_ptr(), hook.original) }
                            != ffi::SQLITE_OK;
                        cleanup |= get.is_none_or(|get| {
                            !same(unsafe { get(base, hook.name.as_ptr()) }, hook.original)
                        });
                    }
                } else {
                    cleanup = true;
                }
            }
        } else {
            cleanup = true;
        }
        BASE.store(ptr::null_mut(), Ordering::Release);
        if cleanup {
            POISONED.store(true, Ordering::Release);
            return Err(GuardError::Cleanup);
        }
        if let Some(error) = violation {
            return Err(error);
        }
        Ok(())
    }
}

/// Bind exact values to placeholders, copying borrowed payloads into SQLite before returning.
fn bind_cell(
    statement: *mut ffi::sqlite3_stmt,
    index: c_int,
    value: &Cell,
) -> Result<(), GuardError> {
    let rc = match value {
        Cell::Null => unsafe { ffi::sqlite3_bind_null(statement, index) },
        Cell::Integer(value) => unsafe {
            ffi::sqlite3_bind_int64(
                statement,
                index,
                value.parse::<i64>().map_err(|_| GuardError::InvalidInput)?,
            )
        },
        Cell::Real(value) if value.is_finite() => unsafe {
            ffi::sqlite3_bind_double(statement, index, *value)
        },
        Cell::Text(value) if value.len() <= 8192 => unsafe {
            ffi::sqlite3_bind_text(
                statement,
                index,
                value.as_ptr().cast(),
                value.len() as c_int,
                ffi::SQLITE_TRANSIENT(),
            )
        },
        Cell::Blob(value) if value.len() <= 8192 => {
            let bytes = STANDARD
                .decode(value)
                .map_err(|_| GuardError::InvalidInput)?;
            unsafe {
                ffi::sqlite3_bind_blob(
                    statement,
                    index,
                    bytes.as_ptr().cast(),
                    bytes.len() as c_int,
                    ffi::SQLITE_TRANSIENT(),
                )
            }
        }
        _ => return Err(GuardError::InvalidInput),
    };
    if rc == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(sqlite_error(rc))
    }
}

/// Copy a cell only after inspecting its size; never coerce integer/blob identity or replace invalid UTF-8.
fn read_cell(
    statement: *mut ffi::sqlite3_stmt,
    column: c_int,
    remaining: &mut usize,
) -> Result<Cell, GuardError> {
    let kind = unsafe { ffi::sqlite3_column_type(statement, column) };
    match kind {
        ffi::SQLITE_NULL => Ok(Cell::Null),
        ffi::SQLITE_INTEGER => {
            *remaining = remaining.checked_sub(8).ok_or(GuardError::Limit)?;
            Ok(Cell::Integer(
                unsafe { ffi::sqlite3_column_int64(statement, column) }.to_string(),
            ))
        }
        ffi::SQLITE_FLOAT => {
            *remaining = remaining.checked_sub(8).ok_or(GuardError::Limit)?;
            let value = unsafe { ffi::sqlite3_column_double(statement, column) };
            if value.is_finite() {
                Ok(Cell::Real(value))
            } else {
                Err(GuardError::Data)
            }
        }
        ffi::SQLITE_TEXT | ffi::SQLITE_BLOB => {
            let pointer = if kind == ffi::SQLITE_TEXT {
                unsafe { ffi::sqlite3_column_text(statement, column) }
            } else {
                unsafe { ffi::sqlite3_column_blob(statement, column) }.cast::<u8>()
            };
            let length = unsafe { ffi::sqlite3_column_bytes(statement, column) };
            if length < 0 {
                return Err(GuardError::Data);
            }
            *remaining = remaining
                .checked_sub(length as usize)
                .ok_or(GuardError::Limit)?;
            if pointer.is_null() && (length != 0 || kind == ffi::SQLITE_TEXT) {
                return Err(GuardError::Data);
            }
            let bytes = if length == 0 {
                &[][..]
            } else {
                unsafe { std::slice::from_raw_parts(pointer, length as usize) }
            };
            if kind == ffi::SQLITE_TEXT {
                Ok(Cell::Text(
                    std::str::from_utf8(bytes)
                        .map_err(|_| GuardError::Data)?
                        .to_owned(),
                ))
            } else {
                Ok(Cell::Blob(STANDARD.encode(bytes)))
            }
        }
        _ => Err(GuardError::Data),
    }
}

impl Drop for GuardedDatabase {
    /// Fallible callers use close; failed implicit cleanup is explicit and never publishes a result.
    fn drop(&mut self) {
        if (!self.db.is_null() || self.installed) && self.finish().is_err() {
            if self.installed {
                // A failed unregister must not leave SQLite pointing into freed wrapper storage.
                let placeholder = Box::new(unsafe { std::mem::zeroed() });
                Box::leak(std::mem::replace(&mut self.wrapper, placeholder));
            }
            POISONED.store(true, Ordering::Release);
            // A closed diagnostic channel must not replace the retained cleanup failure with a panic.
            let _ = writeln!(
                std::io::stderr().lock(),
                "Native source cleanup failed; discard this engine/process."
            );
        }
    }
}

/// Compare captured addresses rather than materializing a callback again.
fn same(left: ffi::sqlite3_syscall_ptr, right: ffi::sqlite3_syscall_ptr) -> bool {
    match (left, right) {
        (Some(a), Some(b)) => std::ptr::fn_addr_eq(a, b),
        (None, None) => true,
        _ => false,
    }
}

/// Erase a correctly typed platform callback for SQLite's syscall registry.
///
/// # Safety
/// The callback must have the exact native signature for the slot it will replace.
pub(crate) unsafe fn erased(pointer: *const ()) -> ffi::sqlite3_syscall_ptr {
    Some(unsafe { std::mem::transmute::<*const (), unsafe extern "C" fn()>(pointer) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_observes_poison_set_before_mutex_acquisition_finishes() {
        let engine = Mutex::new(());
        let poisoned = AtomicBool::new(false);
        let result = admit_engine(&poisoned, || {
            poisoned.store(true, Ordering::Release);
            engine.try_lock()
        });
        assert!(matches!(result, Err(GuardError::Cleanup)));
    }

    #[test]
    fn failed_native_probe_prevents_later_admission() {
        let engine = Mutex::new(());
        let poisoned = AtomicBool::new(false);
        assert_eq!(poison_failed_probe(Ok(7), &poisoned), Ok(7));
        assert!(!poisoned.load(Ordering::Acquire));
        assert_eq!(
            poison_failed_probe::<()>(Err(GuardError::GuardUnavailable), &poisoned),
            Err(GuardError::GuardUnavailable)
        );
        assert!(matches!(
            admit_engine(&poisoned, || engine.try_lock()),
            Err(GuardError::Cleanup)
        ));
    }

    #[test]
    fn resetting_io_diagnostics_does_not_clear_a_policy_failure() {
        let _owner = exclusive().unwrap();
        *STATE.lock().unwrap() = Some(State {
            source: ApprovedSource {
                main: std::path::PathBuf::from("synthetic-unused"),
                entries: Vec::new(),
                #[cfg(feature = "qualification-hooks")]
                before_open: None,
            },
            handles: HashMap::new(),
            hooks: Vec::new(),
            failure: Some(GuardError::PolicyViolation),
            io_error: Some(GuardError::AccessDenied),
        });
        reset_io_error().unwrap();
        assert_eq!(check(), Err(GuardError::PolicyViolation));
        let state = STATE.lock().unwrap().take().unwrap();
        assert_eq!(state.io_error, None);
    }
}
