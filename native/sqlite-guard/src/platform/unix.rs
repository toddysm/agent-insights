//! Unix source operations: no-create opens, actual descriptor identities and bounded SHM mappings.
//! SQLite continues to own POSIX locks. No transaction-time metadata check opens another main-file descriptor.

use crate::{
    GuardError, policy,
    source::{Entry, Role, io_error},
};
use libsqlite3_sys as ffi;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::fs::{File, Metadata, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::{
    ffi::OsStrExt,
    fs::{MetadataExt, OpenOptionsExt},
};
use std::path::{Path, PathBuf};

/// Stable native file identity, independent of pathname/content changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    dev: u64,
    ino: u64,
}

/// Inspect an existing preflight descriptor; this does not create another descriptor.
pub(crate) fn identity_file(file: &File) -> Result<Identity, GuardError> {
    Ok(fd_info(file.as_raw_fd())?.0)
}

/// Open preflight evidence without following a final symlink or blocking on a substituted FIFO.
pub(crate) fn preflight_file(path: &Path) -> Result<File, GuardError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| io_error(&error))
}

/// Attempt SHM growth/mapping through native callbacks, not a pure-policy mock.
#[cfg(feature = "qualification-hooks")]
pub(crate) fn qualification_shm_limit(handle: usize, resize: bool) -> Result<(), GuardError> {
    let fd = handle as c_int;
    let (_, size) = fd_info(fd)?;
    if resize {
        if unsafe { truncate(fd, (size + 4096) as libc::off_t) } == 0 {
            return Ok(());
        }
    } else {
        let address = unsafe {
            map(
                std::ptr::null_mut(),
                (size + 4096) as usize,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd,
                0,
            )
        };
        if address != libc::MAP_FAILED {
            unsafe {
                libc::munmap(address, (size + 4096) as usize);
            }
            return Ok(());
        }
    }
    Err(GuardError::Limit)
}
/// Unix stat/lstat metadata provides identity without releasing SQLite's process-owned locks.
pub(crate) fn matches_path(
    _path: &Path,
    metadata: &Metadata,
    expected: &Identity,
) -> Result<bool, GuardError> {
    Ok(metadata.dev() == expected.dev && metadata.ino() == expected.ino)
}
/// Preserve exact canonical Unix pathname bytes.
pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    left == right
}
/// Encode a code-approved path without a URI or lossy conversion.
pub(crate) fn path_cstring(path: &Path) -> Result<CString, GuardError> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| GuardError::InvalidInput)
}
/// Decode SQLite's existing filename without interpreting it as an instruction.
pub(crate) fn path_from_c(path: &CStr) -> Result<PathBuf, GuardError> {
    Ok(Path::new(std::ffi::OsStr::from_bytes(path.to_bytes())).to_owned())
}

/// Exercise SQLite's SHM-style create request through the real guarded OS boundary.
#[cfg(feature = "qualification-hooks")]
pub(crate) fn qualification_open_shm(path: &Path) -> Result<(), GuardError> {
    let path = path_cstring(path)?;
    let fd = unsafe { open(path.as_ptr(), libc::O_RDWR | libc::O_CREAT, 0o600) };
    if fd < 0 {
        return Err(io_error(&std::io::Error::last_os_error()));
    }
    if unsafe { close(fd) } != 0 {
        return Err(GuardError::Cleanup);
    }
    Ok(())
}

/// Read descriptor identity/size without following a pathname or touching file data.
fn fd_info(fd: c_int) -> Result<(Identity, u64), GuardError> {
    let mut value = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, value.as_mut_ptr()) } != 0 {
        return Err(io_error(&std::io::Error::last_os_error()));
    }
    let value = unsafe { value.assume_init() };
    if value.st_mode & libc::S_IFMT != libc::S_IFREG || value.st_size < 0 {
        return Err(GuardError::SourceChanged);
    }
    #[cfg(target_os = "macos")]
    let device = value.st_dev as u64;
    #[cfg(target_os = "linux")]
    let device = value.st_dev;
    Ok((
        Identity {
            dev: device,
            ino: value.st_ino,
        },
        value.st_size as u64,
    ))
}

/// Set errno for SQLite's native error handling; never put captured values in a diagnostic.
fn errno(value: c_int) {
    #[cfg(target_os = "macos")]
    unsafe {
        *libc::__error() = value;
    }
    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location() = value;
    }
}
/// Fail a denied operation and retain the violation even if its caller ignores errno.
fn denied(error: GuardError) -> c_int {
    policy::deny(error);
    errno(libc::EACCES);
    -1
}

/// Audit-selected syscall replacements. Inactive slots are never activated.
pub(crate) fn hooks() -> Vec<(&'static CStr, ffi::sqlite3_syscall_ptr, bool)> {
    // Every erased pointer below matches the pinned Unix slot's signature.
    unsafe {
        vec![
            (c"open", policy::erased(open as *const ()), true),
            (c"close", policy::erased(close as *const ()), true),
            (c"write", policy::erased(write as *const ()), true),
            (c"pwrite", policy::erased(pwrite as *const ()), false),
            (c"pwrite64", policy::erased(pwrite as *const ()), false),
            (c"ftruncate", policy::erased(truncate as *const ()), true),
            (c"fchmod", policy::erased(chmod as *const ()), false),
            (c"fchown", policy::erased(chown as *const ()), false),
            (c"fallocate", policy::erased(allocate as *const ()), false),
            (c"unlink", policy::erased(unlink as *const ()), true),
            (c"mmap", policy::erased(map as *const ()), true),
            (c"munmap", policy::erased(unmap as *const ()), true),
        ]
    }
}

/// Open existing authorized objects only, then validate the actual descriptor before returning it.
///
/// # Safety
/// SQLite must supply a valid filename and the pinned Unix open-slot ABI.
unsafe extern "C" fn open(path: *const c_char, flags: c_int, mode: c_int) -> c_int {
    let Some(original) = policy::original(c"open") else {
        return denied(GuardError::GuardUnavailable);
    };
    let call: unsafe extern "C" fn(*const c_char, c_int, c_int) -> c_int =
        unsafe { std::mem::transmute(original) };
    if path.is_null() {
        return denied(GuardError::PolicyViolation);
    }
    let name = unsafe { CStr::from_ptr(path) };
    // These fixed devices supply SQLite runtime entropy/closed-standard-descriptor repair, not session evidence.
    if matches!(name.to_bytes(), b"/dev/urandom" | b"/dev/null") {
        return unsafe { call(path, libc::O_RDONLY | libc::O_CLOEXEC, 0) };
    }
    let path_buf = match path_from_c(name) {
        Ok(path) => path,
        Err(error) => return denied(error),
    };
    let selected = match policy::entry(&path_buf) {
        Ok(entry) => entry,
        Err(error) => return denied(error),
    };
    if selected.role == Role::Journal {
        return denied(GuardError::JournalPresent);
    }
    if flags & libc::O_TRUNC != 0 {
        return denied(GuardError::PolicyViolation);
    }
    let mut safe =
        flags & !(libc::O_CREAT | libc::O_EXCL | libc::O_TRUNC | libc::O_WRONLY | libc::O_RDWR);
    safe |= libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    if selected.role == Role::Shm && flags & libc::O_RDWR != 0 {
        safe |= libc::O_RDWR;
    }
    policy::before_open(&path_buf);
    let fd = unsafe { call(path, safe, mode) };
    if fd < 0 {
        let error = io_error(&std::io::Error::last_os_error());
        if error == GuardError::SourceChanged {
            policy::deny(error);
        } else {
            policy::note_io(error);
        }
        return fd;
    }
    let validated = validate_open(fd, &selected);
    if let Err(error) = validated {
        unsafe {
            libc::close(fd);
        }
        return denied(error);
    }
    fd
}

/// Validate only the descriptor that SQLite will use, avoiding extra same-inode closes.
fn validate_open(fd: c_int, entry: &Entry) -> Result<(), GuardError> {
    let (identity, size) = fd_info(fd)?;
    if identity != entry.identity {
        return Err(GuardError::SourceChanged);
    }
    if size > crate::MAX_SOURCE_BYTES {
        return Err(GuardError::Limit);
    }
    policy::remember(fd as usize, entry.role)
}

/// Release an owned native descriptor, including coordination locks.
///
/// # Safety
/// `fd` is supplied by SQLite's pinned Unix VFS.
unsafe extern "C" fn close(fd: c_int) -> c_int {
    policy::forget(fd as usize);
    let result = unsafe { libc::close(fd) };
    if result != 0 {
        policy::deny(GuardError::Cleanup);
    }
    result
}
/// Deny raw writes, including the SHM-extension write path.
///
/// # Safety
/// Arguments follow the native write-slot ABI; the buffer is never dereferenced.
unsafe extern "C" fn write(_fd: c_int, _buffer: *const c_void, _length: usize) -> isize {
    denied(GuardError::PolicyViolation) as isize
}
/// Deny positioned writes, including SHM growth.
///
/// # Safety
/// Arguments follow the 64-bit qualified Unix pwrite ABI.
unsafe extern "C" fn pwrite(
    _fd: c_int,
    _buffer: *const c_void,
    _length: usize,
    _offset: i64,
) -> isize {
    denied(GuardError::PolicyViolation) as isize
}
/// Deny all source resizing, including first-reader SHM reset.
///
/// # Safety
/// Arguments follow the qualified Unix ftruncate ABI.
unsafe extern "C" fn truncate(_fd: c_int, _size: libc::off_t) -> c_int {
    denied(GuardError::RecoveryRequired)
}
/// Deny permission changes on existing source objects.
///
/// # Safety
/// Arguments follow the qualified Unix fchmod ABI.
unsafe extern "C" fn chmod(_fd: c_int, _mode: libc::mode_t) -> c_int {
    denied(GuardError::PolicyViolation)
}
/// Deny ownership changes, including source-side root-user SHM adjustments.
///
/// # Safety
/// Arguments follow the qualified Unix fchown ABI.
unsafe extern "C" fn chown(_fd: c_int, _owner: libc::uid_t, _group: libc::gid_t) -> c_int {
    denied(GuardError::PolicyViolation)
}
/// Deny allocation/size hints; posix_fallocate returns an error number directly.
///
/// # Safety
/// Arguments follow the qualified Unix allocation-slot ABI.
unsafe extern "C" fn allocate(_fd: c_int, _offset: libc::off_t, _length: libc::off_t) -> c_int {
    policy::deny(GuardError::PolicyViolation);
    libc::EACCES
}
/// Deny deletion even during an otherwise successful native close.
///
/// # Safety
/// Arguments follow the qualified Unix unlink ABI; the path is never dereferenced.
unsafe extern "C" fn unlink(_name: *const c_char) -> c_int {
    denied(GuardError::PolicyViolation)
}

/// Allow writable mappings only for the existing SHM object's already allocated extent.
///
/// # Safety
/// Arguments follow the pinned Unix mmap ABI.
unsafe extern "C" fn map(
    address: *mut c_void,
    length: usize,
    protection: c_int,
    flags: c_int,
    fd: c_int,
    offset: libc::off_t,
) -> *mut c_void {
    let checked = (|| {
        if offset < 0 || protection & libc::PROT_EXEC != 0 {
            return Err(GuardError::PolicyViolation);
        }
        let (identity, size) = fd_info(fd)?;
        let end = (offset as u64)
            .checked_add(length as u64)
            .ok_or(GuardError::Limit)?;
        policy::mapping(
            fd as usize,
            &identity,
            size,
            end,
            protection & libc::PROT_WRITE != 0,
        )
    })();
    if let Err(error) = checked {
        denied(error);
        return libc::MAP_FAILED;
    }
    let Some(original) = policy::original(c"mmap") else {
        denied(GuardError::GuardUnavailable);
        return libc::MAP_FAILED;
    };
    let call: unsafe extern "C" fn(
        *mut c_void,
        usize,
        c_int,
        c_int,
        c_int,
        libc::off_t,
    ) -> *mut c_void = unsafe { std::mem::transmute(original) };
    unsafe { call(address, length, protection, flags, fd, offset) }
}

/// Check native unmapping even when SQLite ignores its return value.
///
/// # Safety
/// Address and length must satisfy the pinned Unix munmap contract.
unsafe extern "C" fn unmap(address: *mut c_void, length: usize) -> c_int {
    let Some(original) = policy::original(c"munmap") else {
        return denied(GuardError::Cleanup);
    };
    let call: unsafe extern "C" fn(*mut c_void, usize) -> c_int =
        unsafe { std::mem::transmute(original) };
    let result = unsafe { call(address, length) };
    if !super::unmap_succeeded(result == 0) {
        return denied(GuardError::Cleanup);
    }
    result
}
