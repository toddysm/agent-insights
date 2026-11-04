//! Win32 existing-only source handles and bounded shared-memory section mappings.
//! Handle identity is checked before SQLite receives it; SQLite retains native locking.

use crate::{
    GuardError, policy,
    source::{Role, io_error},
};
use libsqlite3_sys as ffi;
use std::ffi::{CStr, CString, c_void};
use std::fs::{File, Metadata, OpenOptions};
use std::os::windows::{
    ffi::{OsStrExt, OsStringExt},
    fs::OpenOptionsExt,
    io::AsRawHandle,
};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, GENERIC_READ, GENERIC_WRITE, HANDLE,
        INVALID_HANDLE_VALUE, SetLastError,
    },
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_DELETE_ON_CLOSE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FileIdInfo,
        GetFileInformationByHandle, GetFileInformationByHandleEx, GetFileSizeEx, OPEN_EXISTING,
    },
    System::Memory::{FILE_MAP_READ, FILE_MAP_WRITE, PAGE_READONLY, PAGE_READWRITE},
};

/// Full file identity, not a path or a truncated JavaScript integer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    volume: u64,
    id: [u8; 16],
}
/// An existing-file section's checked extent, retained only until its handle closes.
#[derive(Clone)]
struct Mapping {
    size: u64,
    writable: bool,
}
static MAPPINGS: Mutex<Vec<(usize, Mapping)>> = Mutex::new(Vec::new());

/// Read identity and length from the same existing handle that SQLite will use.
fn handle_info(handle: HANDLE) -> Result<(Identity, u64), GuardError> {
    let mut basic = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    let mut id = std::mem::MaybeUninit::<FILE_ID_INFO>::uninit();
    let mut size = 0;
    if unsafe { GetFileInformationByHandle(handle, basic.as_mut_ptr()) } == 0
        || unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileIdInfo,
                id.as_mut_ptr().cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } == 0
        || unsafe { GetFileSizeEx(handle, &mut size) } == 0
    {
        return Err(io_error(&std::io::Error::last_os_error()));
    }
    let basic = unsafe { basic.assume_init() };
    let id = unsafe { id.assume_init() };
    if basic.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
        || size < 0
    {
        return Err(GuardError::SourceChanged);
    }
    Ok((
        Identity {
            volume: id.VolumeSerialNumber,
            id: id.FileId.Identifier,
        },
        size as u64,
    ))
}
/// Inspect the already-open preflight handle.
pub(crate) fn identity_file(file: &File) -> Result<Identity, GuardError> {
    Ok(handle_info(file.as_raw_handle())?.0)
}

/// Open the final object itself; identity inspection rejects reparse points before admission.
pub(crate) fn preflight_file(path: &Path) -> Result<File, GuardError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| io_error(&error))
}

/// Probe native SHM resize/mapping denial using an actual open source handle.
#[cfg(feature = "qualification-hooks")]
pub(crate) fn qualification_shm_limit(handle: usize, resize: bool) -> Result<(), GuardError> {
    let handle = handle as HANDLE;
    if resize {
        if unsafe { truncate(handle) } != 0 {
            return Ok(());
        }
    } else {
        let (_, size) = handle_info(handle)?;
        let length = size + 4096;
        let section = unsafe {
            mapping(
                handle,
                std::ptr::null(),
                PAGE_READWRITE,
                (length >> 32) as u32,
                length as u32,
                std::ptr::null(),
            )
        };
        if !section.is_null() {
            unsafe {
                close(section);
            }
            return Ok(());
        }
    }
    Err(GuardError::Limit)
}
/// Windows locks belong to individual handles; a separate metadata handle does not release SQLite's locks.
pub(crate) fn matches_path(
    path: &Path,
    _metadata: &Metadata,
    expected: &Identity,
) -> Result<bool, GuardError> {
    let file = preflight_file(path)?;
    Ok(identity_file(&file)? == *expected)
}
/// Normalize only Win32 spelling differences; actual opened identity is checked independently.
fn spelling(path: &Path) -> Vec<u16> {
    let value: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .map(|x| match x {
            47 => 92,
            65..=90 => x + 32,
            _ => x,
        })
        .collect();
    value
        .strip_prefix(&[92, 92, 63, 92])
        .unwrap_or(&value)
        .to_vec()
}
/// Compare canonical path spellings without lossy Unicode conversion.
pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    spelling(left) == spelling(right)
}
/// SQLite filenames are UTF-8; reject unrepresentable source paths explicitly.
pub(crate) fn path_cstring(path: &Path) -> Result<CString, GuardError> {
    CString::new(path.to_str().ok_or(GuardError::InvalidInput)?)
        .map_err(|_| GuardError::InvalidInput)
}
/// Decode a SQLite filename without resolving another source from captured data.
pub(crate) fn path_from_c(path: &CStr) -> Result<PathBuf, GuardError> {
    Ok(PathBuf::from(
        path.to_str().map_err(|_| GuardError::InvalidInput)?,
    ))
}

/// Exercise the internal SHM OPEN_ALWAYS request through the real existing-only guard.
#[cfg(feature = "qualification-hooks")]
pub(crate) fn qualification_open_shm(path: &Path) -> Result<(), GuardError> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS,
    };
    let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
    name.push(0);
    let handle = unsafe {
        open(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io_error(&std::io::Error::last_os_error()));
    }
    if unsafe { close(handle) } == 0 {
        return Err(GuardError::Cleanup);
    }
    Ok(())
}
/// Mark a forbidden native operation before returning the Win32 failure sentinel.
fn denied(error: GuardError) {
    policy::deny(error);
    unsafe {
        SetLastError(ERROR_ACCESS_DENIED);
    }
}
/// Decode the pinned VFS's valid NUL-terminated UTF-16 filename.
///
/// # Safety
/// `name` must point to a readable NUL-terminated Windows filename.
unsafe fn wide_path(name: *const u16) -> Result<PathBuf, GuardError> {
    if name.is_null() {
        return Err(GuardError::PolicyViolation);
    }
    let mut length = 0usize;
    while unsafe { *name.add(length) } != 0 {
        length += 1;
        if length > 32767 {
            return Err(GuardError::Limit);
        }
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(unsafe {
        std::slice::from_raw_parts(name, length)
    })))
}
/// Desktop Win32 interception points; UWP/alternate ABIs are rejected by the target gate.
pub(crate) fn hooks() -> Vec<(&'static CStr, ffi::sqlite3_syscall_ptr, bool)> {
    // Each function uses the exact WINAPI signature in the pinned VFS's syscall table.
    unsafe {
        vec![
            (c"CreateFileW", policy::erased(open as *const ()), true),
            (c"CloseHandle", policy::erased(close as *const ()), true),
            (c"WriteFile", policy::erased(write as *const ()), true),
            (c"SetEndOfFile", policy::erased(truncate as *const ()), true),
            (c"DeleteFileW", policy::erased(delete as *const ()), true),
            (
                c"CreateFileMappingW",
                policy::erased(mapping as *const ()),
                true,
            ),
            (c"MapViewOfFile", policy::erased(view as *const ()), true),
            (c"UnmapViewOfFile", policy::erased(unmap as *const ()), true),
        ]
    }
}

/// Force existing-only creation disposition and validate the returned object before use.
///
/// # Safety
/// Arguments follow the pinned CreateFileW WINAPI contract.
unsafe extern "system" fn open(
    name: *const u16,
    access: u32,
    share: u32,
    security: *const SECURITY_ATTRIBUTES,
    _disposition: u32,
    flags: u32,
    template: HANDLE,
) -> HANDLE {
    let path = match unsafe { wide_path(name) } {
        Ok(path) => path,
        Err(error) => {
            denied(error);
            return INVALID_HANDLE_VALUE;
        }
    };
    let entry = match policy::entry(&path) {
        Ok(entry) => entry,
        Err(error) => {
            denied(error);
            return INVALID_HANDLE_VALUE;
        }
    };
    if entry.role == Role::Journal {
        denied(GuardError::JournalPresent);
        return INVALID_HANDLE_VALUE;
    }
    if flags & FILE_FLAG_DELETE_ON_CLOSE != 0 || access & !(GENERIC_READ | GENERIC_WRITE) != 0 {
        denied(GuardError::PolicyViolation);
        return INVALID_HANDLE_VALUE;
    }
    let Some(original) = policy::original(c"CreateFileW") else {
        denied(GuardError::GuardUnavailable);
        return INVALID_HANDLE_VALUE;
    };
    let call: unsafe extern "system" fn(
        *const u16,
        u32,
        u32,
        *const SECURITY_ATTRIBUTES,
        u32,
        u32,
        HANDLE,
    ) -> HANDLE = unsafe { std::mem::transmute(original) };
    let allowed = if entry.role == Role::Shm {
        access
    } else {
        GENERIC_READ
    };
    policy::before_open(&path);
    let handle = unsafe {
        call(
            name,
            allowed,
            share,
            security,
            OPEN_EXISTING,
            flags | FILE_FLAG_OPEN_REPARSE_POINT,
            template,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        policy::note_io(io_error(&std::io::Error::last_os_error()));
        return handle;
    }
    let result = (|| {
        let (identity, size) = handle_info(handle)?;
        if identity != entry.identity {
            return Err(GuardError::SourceChanged);
        }
        if size > crate::MAX_SOURCE_BYTES {
            return Err(GuardError::Limit);
        }
        policy::remember(handle as usize, entry.role)
    })();
    if let Err(error) = result {
        unsafe {
            CloseHandle(handle);
        }
        denied(error);
        return INVALID_HANDLE_VALUE;
    }
    handle
}
/// Release a source or internal native handle, including its Windows locks.
///
/// # Safety
/// The handle comes from the pinned Windows VFS.
unsafe extern "system" fn close(handle: HANDLE) -> i32 {
    policy::forget(handle as usize);
    match MAPPINGS.lock() {
        Ok(mut maps) => maps.retain(|(key, _)| *key != handle as usize),
        Err(_) => policy::deny(GuardError::Cleanup),
    }
    let result = unsafe { CloseHandle(handle) };
    if result == 0 {
        policy::deny(GuardError::Cleanup);
    }
    result
}
/// Deny raw writes, including source-side shared-memory extension writes.
///
/// # Safety
/// Arguments follow WriteFile; no caller buffer is dereferenced.
unsafe extern "system" fn write(
    _handle: HANDLE,
    _buffer: *const c_void,
    _length: u32,
    _written: *mut u32,
    _overlap: *mut c_void,
) -> i32 {
    denied(GuardError::PolicyViolation);
    0
}
/// Deny every source resize, including recovery-related SHM truncation.
///
/// # Safety
/// The handle follows SetEndOfFile's native contract.
unsafe extern "system" fn truncate(_handle: HANDLE) -> i32 {
    denied(GuardError::RecoveryRequired);
    0
}
/// Prevent native deletion even when requested by cleanup.
///
/// # Safety
/// Arguments follow DeleteFileW; the path is not dereferenced.
unsafe extern "system" fn delete(_name: *const u16) -> i32 {
    denied(GuardError::PolicyViolation);
    0
}

/// Create a section only within an existing authorized file; writable mappings are SHM-only.
///
/// # Safety
/// Arguments follow CreateFileMappingW's native contract.
unsafe extern "system" fn mapping(
    file: HANDLE,
    security: *const SECURITY_ATTRIBUTES,
    protect: u32,
    high: u32,
    low: u32,
    name: *const u16,
) -> HANDLE {
    let checked = (|| {
        if !name.is_null() || !matches!(protect, PAGE_READONLY | PAGE_READWRITE) {
            return Err(GuardError::PolicyViolation);
        }
        let (identity, size) = handle_info(file)?;
        let requested = ((high as u64) << 32) | low as u64;
        let length = if requested == 0 { size } else { requested };
        policy::mapping(
            file as usize,
            &identity,
            size,
            length,
            protect == PAGE_READWRITE,
        )?;
        Ok(length)
    })();
    let length = match checked {
        Ok(length) => length,
        Err(error) => {
            denied(error);
            return std::ptr::null_mut();
        }
    };
    let Some(original) = policy::original(c"CreateFileMappingW") else {
        denied(GuardError::GuardUnavailable);
        return std::ptr::null_mut();
    };
    let call: unsafe extern "system" fn(
        HANDLE,
        *const SECURITY_ATTRIBUTES,
        u32,
        u32,
        u32,
        *const u16,
    ) -> HANDLE = unsafe { std::mem::transmute(original) };
    let handle = unsafe { call(file, security, protect, high, low, name) };
    if !handle.is_null() {
        let Ok(mut maps) = MAPPINGS.lock() else {
            unsafe {
                CloseHandle(handle);
            }
            denied(GuardError::GuardUnavailable);
            return std::ptr::null_mut();
        };
        maps.push((
            handle as usize,
            Mapping {
                size: length,
                writable: protect == PAGE_READWRITE,
            },
        ));
    }
    handle
}
/// Map only the bounded portion of a section created by the guarded mapping operation.
///
/// # Safety
/// Arguments follow MapViewOfFile's native contract.
unsafe extern "system" fn view(
    section: HANDLE,
    access: u32,
    high: u32,
    low: u32,
    bytes: usize,
) -> *mut c_void {
    let checked = (|| {
        let maps = MAPPINGS.lock().map_err(|_| GuardError::GuardUnavailable)?;
        let mapping = &maps
            .iter()
            .find(|(key, _)| *key == section as usize)
            .ok_or(GuardError::PolicyViolation)?
            .1;
        if access & !(FILE_MAP_READ | FILE_MAP_WRITE) != 0
            || access & FILE_MAP_WRITE != 0 && !mapping.writable
        {
            return Err(GuardError::PolicyViolation);
        }
        let offset = ((high as u64) << 32) | low as u64;
        let end = if bytes == 0 {
            mapping.size
        } else {
            offset.checked_add(bytes as u64).ok_or(GuardError::Limit)?
        };
        if offset > mapping.size || end > mapping.size {
            return Err(GuardError::Limit);
        }
        Ok(())
    })();
    if let Err(error) = checked {
        denied(error);
        return std::ptr::null_mut();
    }
    let Some(original) = policy::original(c"MapViewOfFile") else {
        denied(GuardError::GuardUnavailable);
        return std::ptr::null_mut();
    };
    let call: unsafe extern "system" fn(HANDLE, u32, u32, u32, usize) -> *mut c_void =
        unsafe { std::mem::transmute(original) };
    unsafe { call(section, access, high, low, bytes) }
}

/// Check view release even when SQLite ignores a failed UnmapViewOfFile result.
///
/// # Safety
/// The address must satisfy the pinned UnmapViewOfFile contract.
unsafe extern "system" fn unmap(address: *const c_void) -> i32 {
    let Some(original) = policy::original(c"UnmapViewOfFile") else {
        denied(GuardError::Cleanup);
        return 0;
    };
    let call: unsafe extern "system" fn(*const c_void) -> i32 =
        unsafe { std::mem::transmute(original) };
    let result = unsafe { call(address) };
    if !super::unmap_succeeded(result != 0) {
        denied(GuardError::Cleanup);
        return 0;
    }
    result
}
