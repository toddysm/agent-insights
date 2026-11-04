//! Policy VFS: delegate normal reads/locks, deny data changes and guard SHM lifetime.
//! Each callback receives only live SQLite-owned wrapper/file pointers.

use super::{base, deny, entry};
use crate::{GuardError, MAX_SOURCE_BYTES, platform, source::Role};
use libsqlite3_sys as ffi;
use std::ffi::{CStr, c_char, c_int, c_void};
use std::ptr;

/// SQLite allocates this wrapper; the original VFS file has a separately aligned allocation.
#[repr(C)]
pub(super) struct GuardFile {
    header: ffi::sqlite3_file,
    real: *mut ffi::sqlite3_file,
}

/// Resolve the original file and a copied callback table without aliasing foreign mutations.
///
/// # Safety
/// `file` must be a live GuardFile created by open.
unsafe fn underlying(
    file: *mut ffi::sqlite3_file,
) -> Option<(*mut ffi::sqlite3_file, ffi::sqlite3_io_methods)> {
    let real = unsafe { (*(file.cast::<GuardFile>())).real };
    if real.is_null() || unsafe { (*real).pMethods }.is_null() {
        return None;
    }
    Some((real, unsafe { *(*real).pMethods }))
}

/// Refuse an unavailable native callback, including paths whose C caller ignores the error.
fn unavailable() {
    deny(GuardError::GuardUnavailable);
}

/// Admit only the main/WAL file and tell SQLite the actual read-only access flags.
///
/// # Safety
/// Arguments and output storage must satisfy SQLite's xOpen contract.
pub(super) unsafe extern "C" fn open(
    _vfs: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    output: *mut c_int,
) -> c_int {
    unsafe {
        (*file).pMethods = ptr::null();
    }
    if name.is_null() {
        deny(GuardError::PolicyViolation);
        return ffi::SQLITE_CANTOPEN;
    }
    let path = match platform::path_from_c(unsafe { CStr::from_ptr(name) }) {
        Ok(path) => path,
        Err(error) => {
            deny(error);
            return ffi::SQLITE_CANTOPEN;
        }
    };
    let authorized = match entry(&path) {
        Ok(entry) => entry,
        Err(error) => {
            deny(error);
            return ffi::SQLITE_CANTOPEN;
        }
    };
    if !matches!(authorized.role, Role::Main | Role::Wal)
        || flags
            & (ffi::SQLITE_OPEN_DELETEONCLOSE
                | ffi::SQLITE_OPEN_TEMP_DB
                | ffi::SQLITE_OPEN_TEMP_JOURNAL
                | ffi::SQLITE_OPEN_SUBJOURNAL
                | ffi::SQLITE_OPEN_SUPER_JOURNAL)
            != 0
    {
        deny(GuardError::PolicyViolation);
        return ffi::SQLITE_READONLY;
    }
    let base = base();
    if base.is_null() {
        unavailable();
        return ffi::SQLITE_CANTOPEN;
    }
    let Some(open) = (unsafe { (*base).xOpen }) else {
        unavailable();
        return ffi::SQLITE_CANTOPEN;
    };
    let real =
        unsafe { ffi::sqlite3_malloc64((*base).szOsFile as u64) }.cast::<ffi::sqlite3_file>();
    if real.is_null() {
        return ffi::SQLITE_NOMEM;
    }
    unsafe {
        ptr::write_bytes(real.cast::<u8>(), 0, (*base).szOsFile as usize);
    }
    let flags = (flags
        & !(ffi::SQLITE_OPEN_CREATE | ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_EXCLUSIVE))
        | ffi::SQLITE_OPEN_READONLY;
    let rc = unsafe { open(base, name, real, flags, output) };
    if rc != ffi::SQLITE_OK {
        if !unsafe { (*real).pMethods }.is_null()
            && let Some(close) = unsafe { (*(*real).pMethods).xClose }
        {
            unsafe {
                close(real);
            }
        }
        unsafe {
            ffi::sqlite3_free(real.cast());
        }
        return rc;
    }
    unsafe {
        ptr::write(
            file.cast::<GuardFile>(),
            GuardFile {
                header: ffi::sqlite3_file { pMethods: &METHODS },
                real,
            },
        );
    }
    rc
}

/// Never delete source files through the policy VFS.
///
/// # Safety
/// Called only through the owned SQLite VFS.
pub(super) unsafe extern "C" fn delete(
    _vfs: *mut ffi::sqlite3_vfs,
    _name: *const c_char,
    _sync: c_int,
) -> c_int {
    deny(GuardError::PolicyViolation);
    ffi::SQLITE_READONLY
}

/// Release the original file once, including its native locks and OS handles.
///
/// # Safety
/// `file` must be a live GuardFile allocated by SQLite.
unsafe extern "C" fn close(file: *mut ffi::sqlite3_file) -> c_int {
    let Some((real, methods)) = (unsafe { underlying(file) }) else {
        unavailable();
        return ffi::SQLITE_IOERR_CLOSE;
    };
    let rc = if let Some(call) = methods.xClose {
        unsafe { call(real) }
    } else {
        unavailable();
        ffi::SQLITE_IOERR_CLOSE
    };
    unsafe {
        ffi::sqlite3_free(real.cast());
        (*file.cast::<GuardFile>()).real = ptr::null_mut();
        (*file).pMethods = ptr::null();
    }
    if rc != ffi::SQLITE_OK {
        deny(GuardError::Cleanup);
    }
    rc
}

/// Forward a non-mutating file/locking method with sticky failure for a missing callback.
macro_rules! forward {
    ($name:ident, $member:ident, ($($arg:ident:$ty:ty),*), $fallback:expr) => {
        #[doc = "Delegate the pinned VFS's normal read/locking operation.\n\n# Safety\nArguments must satisfy the corresponding SQLite file-method contract."]
        unsafe extern "C" fn $name(file: *mut ffi::sqlite3_file, $($arg:$ty),*) -> c_int {
            let Some((real, methods)) = (unsafe { underlying(file) }) else { unavailable(); return $fallback; };
            let Some(call) = methods.$member else { unavailable(); return $fallback; };
            unsafe { call(real, $($arg),*) }
        }
    };
}
forward!(lock, xLock, (level:c_int), ffi::SQLITE_IOERR_LOCK);
forward!(unlock, xUnlock, (level:c_int), ffi::SQLITE_IOERR_UNLOCK);
forward!(reserved, xCheckReservedLock, (result:*mut c_int), ffi::SQLITE_IOERR_CHECKRESERVEDLOCK);
forward!(sector, xSectorSize, (), 0);
forward!(characteristics, xDeviceCharacteristics, (), 0);
forward!(shm_lock, xShmLock, (offset:c_int, count:c_int, flags:c_int), ffi::SQLITE_IOERR_SHMLOCK);

/// Read only bounded offsets; SQLite retains its required short-read zero-fill semantics.
///
/// # Safety
/// Buffer/file arguments must satisfy SQLite's xRead contract.
unsafe extern "C" fn read(
    file: *mut ffi::sqlite3_file,
    buffer: *mut c_void,
    amount: c_int,
    offset: ffi::sqlite3_int64,
) -> c_int {
    if amount < 0
        || offset < 0
        || (offset as u64)
            .checked_add(amount as u64)
            .is_none_or(|end| end > MAX_SOURCE_BYTES)
    {
        deny(GuardError::Limit);
        return ffi::SQLITE_IOERR_READ;
    }
    let Some((real, methods)) = (unsafe { underlying(file) }) else {
        unavailable();
        return ffi::SQLITE_IOERR_READ;
    };
    let Some(call) = methods.xRead else {
        unavailable();
        return ffi::SQLITE_IOERR_READ;
    };
    unsafe { call(real, buffer, amount, offset) }
}

/// Deny persistent file writes before the operating-system VFS can act.
///
/// # Safety
/// Called only through the owned SQLite file interface.
unsafe extern "C" fn write(
    _file: *mut ffi::sqlite3_file,
    _buffer: *const c_void,
    _amount: c_int,
    _offset: i64,
) -> c_int {
    deny(GuardError::PolicyViolation);
    ffi::SQLITE_READONLY
}
/// Deny resizing a main/WAL file.
///
/// # Safety
/// Called only through the owned SQLite file interface.
unsafe extern "C" fn truncate(_file: *mut ffi::sqlite3_file, _size: i64) -> c_int {
    deny(GuardError::PolicyViolation);
    ffi::SQLITE_READONLY
}
/// A read-only connection has no source data to sync.
///
/// # Safety
/// Called only through the owned SQLite file interface.
unsafe extern "C" fn sync(_file: *mut ffi::sqlite3_file, _flags: c_int) -> c_int {
    deny(GuardError::PolicyViolation);
    ffi::SQLITE_READONLY
}
/// Check the file size returned by the native VFS before SQLite uses it.
///
/// # Safety
/// `size` must be writable and `file` a live wrapper.
unsafe extern "C" fn size(file: *mut ffi::sqlite3_file, size: *mut i64) -> c_int {
    let Some((real, methods)) = (unsafe { underlying(file) }) else {
        unavailable();
        return ffi::SQLITE_IOERR_FSTAT;
    };
    let Some(call) = methods.xFileSize else {
        unavailable();
        return ffi::SQLITE_IOERR_FSTAT;
    };
    let rc = unsafe { call(real, size) };
    if rc == ffi::SQLITE_OK && (unsafe { *size } < 0 || unsafe { *size } as u64 > MAX_SOURCE_BYTES)
    {
        deny(GuardError::Limit);
        return ffi::SQLITE_IOERR_FSTAT;
    }
    rc
}

/// Delegate only non-mutating file controls; never expose or enable alternate I/O methods.
///
/// # Safety
/// The argument must satisfy the requested SQLite file-control contract.
unsafe extern "C" fn control(
    file: *mut ffi::sqlite3_file,
    operation: c_int,
    argument: *mut c_void,
) -> c_int {
    match operation {
        ffi::SQLITE_FCNTL_PRAGMA
        | ffi::SQLITE_FCNTL_MMAP_SIZE
        | ffi::SQLITE_FCNTL_PDB
        | ffi::SQLITE_FCNTL_BUSYHANDLER
        | ffi::SQLITE_FCNTL_COMMIT_PHASETWO
        | ffi::SQLITE_FCNTL_PERSIST_WAL => return ffi::SQLITE_NOTFOUND,
        ffi::SQLITE_FCNTL_LOCKSTATE
        | ffi::SQLITE_FCNTL_LAST_ERRNO
        | ffi::SQLITE_FCNTL_VFSNAME
        | ffi::SQLITE_FCNTL_HAS_MOVED
        | ffi::SQLITE_FCNTL_LOCK_TIMEOUT
        | ffi::SQLITE_FCNTL_DATA_VERSION => {}
        _ => {
            deny(GuardError::PolicyViolation);
            return ffi::SQLITE_READONLY;
        }
    }
    let Some((real, methods)) = (unsafe { underlying(file) }) else {
        unavailable();
        return ffi::SQLITE_NOTFOUND;
    };
    let Some(call) = methods.xFileControl else {
        unavailable();
        return ffi::SQLITE_NOTFOUND;
    };
    unsafe { call(real, operation, argument) }
}

/// Map existing SHM only: the native mapping guard checks its actual handle and bounds too.
///
/// # Safety
/// Arguments must satisfy SQLite's xShmMap contract and output must be writable.
unsafe extern "C" fn shm_map(
    file: *mut ffi::sqlite3_file,
    region: c_int,
    bytes: c_int,
    _extend: c_int,
    output: *mut *mut c_void,
) -> c_int {
    if region < 0
        || bytes <= 0
        || (region as u64 + 1)
            .checked_mul(bytes as u64)
            .is_none_or(|size| size > MAX_SOURCE_BYTES)
    {
        deny(GuardError::Limit);
        return ffi::SQLITE_IOERR_SHMSIZE;
    }
    let Some((real, methods)) = (unsafe { underlying(file) }) else {
        unavailable();
        return ffi::SQLITE_IOERR_SHMMAP;
    };
    let Some(call) = methods.xShmMap else {
        unavailable();
        return ffi::SQLITE_IOERR_SHMMAP;
    };
    let rc = unsafe { call(real, region, bytes, 0, output) };
    if rc == ffi::SQLITE_OK && unsafe { (*output).is_null() } {
        deny(GuardError::RecoveryRequired);
        return ffi::SQLITE_READONLY_CANTINIT;
    }
    rc
}
/// Preserve SQLite's native shared-memory ordering.
///
/// # Safety
/// `file` must be a live wrapper.
unsafe extern "C" fn barrier(file: *mut ffi::sqlite3_file) {
    let Some((real, methods)) = (unsafe { underlying(file) }) else {
        unavailable();
        return;
    };
    if let Some(call) = methods.xShmBarrier {
        unsafe { call(real) };
    } else {
        unavailable();
    }
}
/// Unmap coordination memory without deleting its source file.
///
/// # Safety
/// `file` must be a live wrapper.
unsafe extern "C" fn unmap(file: *mut ffi::sqlite3_file, delete: c_int) -> c_int {
    if delete != 0 {
        deny(GuardError::PolicyViolation);
    }
    let Some((real, methods)) = (unsafe { underlying(file) }) else {
        unavailable();
        return ffi::SQLITE_IOERR_SHMMAP;
    };
    let Some(call) = methods.xShmUnmap else {
        unavailable();
        return ffi::SQLITE_IOERR_SHMMAP;
    };
    unsafe { call(real, 0) }
}

/// Data-file mapping is disabled in the pinned build; SHM uses the guarded version-2 interface.
static METHODS: ffi::sqlite3_io_methods = ffi::sqlite3_io_methods {
    iVersion: 2,
    xClose: Some(close),
    xRead: Some(read),
    xWrite: Some(write),
    xTruncate: Some(truncate),
    xSync: Some(sync),
    xFileSize: Some(size),
    xLock: Some(lock),
    xUnlock: Some(unlock),
    xCheckReservedLock: Some(reserved),
    xFileControl: Some(control),
    xSectorSize: Some(sector),
    xDeviceCharacteristics: Some(characteristics),
    xShmMap: Some(shm_map),
    xShmLock: Some(shm_lock),
    xShmBarrier: Some(barrier),
    xShmUnmap: Some(unmap),
    xFetch: None,
    xUnfetch: None,
};
