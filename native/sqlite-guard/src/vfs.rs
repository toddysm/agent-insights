//! Inspect the pinned native VFS interception seam before implementing source I/O.
//! A passing probe establishes pointer replacement/restoration only. It neither
//! installs the source policy nor certifies prevention of filesystem mutations.

use crate::{GuardError, inspect_engine};
use libsqlite3_sys as ffi;
use std::ffi::CStr;
use std::sync::Mutex;

/// Serialize this crate's probes; the unsafe caller must also exclude all other SQLite use.
static PROBE_LOCK: Mutex<()> = Mutex::new(());

/// One named operating-system slot observed in the linked VFS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookCapability {
    /// SQLite's exact slot name, without pointer addresses or private source data.
    pub name: &'static str,
    /// Whether this build originally had an implementation in the slot.
    pub active: bool,
}

/// A source-independent ABI observation, not a guard-installed or source-safe result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeAbi {
    /// Qualified candidate VFS family; alternate locking VFSes are not substituted.
    pub vfs_name: &'static str,
    /// Slots whose replace/read-back/restore behavior was checked.
    pub hooks: Vec<HookCapability>,
}

/// Minimum audited slots and their compile-time availability requirements.
#[derive(Clone, Copy)]
struct Requirement {
    /// Exact slot name owned by the pinned VFS implementation.
    name: &'static CStr,
    /// Whether this build must provide a live implementation, rather than a compiled-out slot.
    must_be_active: bool,
}

/// Require a live native implementation for this audited slot.
const fn required(name: &'static CStr) -> Requirement {
    Requirement {
        name,
        must_be_active: true,
    }
}

/// Require the slot to exist, permitting it to be compiled out in this target.
const fn conditional(name: &'static CStr) -> Requirement {
    Requirement {
        name,
        must_be_active: false,
    }
}

/// Unix mutations/mappings inspected in the pinned os_unix.c; this is not a full policy.
const UNIX_SLOTS: &[Requirement] = &[
    required(c"open"),
    required(c"close"),
    required(c"ftruncate"),
    required(c"write"),
    conditional(c"pwrite"),
    conditional(c"pwrite64"),
    conditional(c"fchmod"),
    conditional(c"fallocate"),
    required(c"unlink"),
    conditional(c"fchown"),
    required(c"mmap"),
    required(c"munmap"),
    conditional(c"mremap"),
];

/// Windows mutations/mappings inspected in the pinned desktop Win32 VFS.
const WINDOWS_SLOTS: &[Requirement] = &[
    required(c"CreateFileW"),
    required(c"CloseHandle"),
    required(c"WriteFile"),
    required(c"SetEndOfFile"),
    required(c"DeleteFileW"),
    required(c"CreateFileMappingW"),
    conditional(c"CreateFileMappingFromApp"),
    required(c"MapViewOfFile"),
    required(c"UnmapViewOfFile"),
];

/// Select exact qualified target triples; matching only OS/CPU would admit unsupported ABIs.
fn profile_for(target: &str) -> Result<(&'static CStr, &'static [Requirement]), GuardError> {
    match target {
        "aarch64-apple-darwin" | "x86_64-apple-darwin" | "x86_64-unknown-linux-gnu" => {
            Ok((c"unix", UNIX_SLOTS))
        }
        "x86_64-pc-windows-msvc" => Ok((c"win32", WINDOWS_SLOTS)),
        _ => Err(GuardError::GuardUnavailable),
    }
}

/// Verify the pinned VFS exists and its audited callback slots can be restored.
///
/// No database is opened and no source operations are performed. This is the
/// initial ABI qualification step, not installation of the source mutation guard.
///
/// # Safety
/// The caller must own this SQLite engine exclusively: no connections, ongoing
/// SQLite operations, callback mutation or other VFS consumers may exist during
/// the probe. Probe callbacks deliberately have no callable I/O implementation.
/// If the probe fails, abandon the engine/process rather than using it for I/O,
/// because a broken VFS may also have refused callback restoration.
///
/// # Errors
/// Returns [`GuardError::EngineMismatch`] for unqualified engine/build metadata,
/// or [`GuardError::GuardUnavailable`] for unsupported targets or a broken seam.
pub unsafe fn inspect_native_abi() -> Result<NativeAbi, GuardError> {
    let _exclusive = PROBE_LOCK
        .lock()
        .map_err(|_| GuardError::GuardUnavailable)?;
    let (name, requirements) = profile_for(env!("AGENT_INSIGHTS_NATIVE_TARGET"))?;
    inspect_engine()?;
    // The engine is pinned and the caller guarantees it has no concurrent consumers.
    let vfs = unsafe { ffi::sqlite3_vfs_find(name.as_ptr()) };
    // The pointer belongs to the initialized engine and the selected profile is static.
    unsafe { probe(vfs, name, requirements) }
}

/// Sentinel used only for pointer round trips; it must never be called as a syscall.
extern "C" fn sentinel() {}

/// Compare function addresses explicitly; ordinary function equality is not a semantic proof.
fn same(left: ffi::sqlite3_syscall_ptr, right: ffi::sqlite3_syscall_ptr) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => std::ptr::fn_addr_eq(left, right),
        (None, None) => true,
        _ => false,
    }
}

/// Probe exact callback replacement and restoration without invoking any I/O callback.
///
/// # Safety
/// `vfs` must be null or a live SQLite VFS for the duration of this call. The
/// engine must be exclusively owned and abandoned after any probe failure.
unsafe fn probe(
    vfs: *mut ffi::sqlite3_vfs,
    expected: &'static CStr,
    requirements: &[Requirement],
) -> Result<NativeAbi, GuardError> {
    // Check the interface version before accessing the version-3 callback fields.
    if vfs.is_null() || unsafe { (*vfs).iVersion } != 3 {
        return Err(GuardError::GuardUnavailable);
    }
    // The caller supplies a valid VFS; SQLite owns its static name and function pointers.
    let table = unsafe { *vfs };
    if table.zName.is_null() || unsafe { CStr::from_ptr(table.zName) } != expected {
        return Err(GuardError::GuardUnavailable);
    }
    let get = table.xGetSystemCall.ok_or(GuardError::GuardUnavailable)?;
    let set = table.xSetSystemCall.ok_or(GuardError::GuardUnavailable)?;
    if table.xNextSystemCall.is_none() {
        return Err(GuardError::GuardUnavailable);
    }
    let mut hooks = Vec::with_capacity(requirements.len());
    let sentinel_ptr: ffi::sqlite3_syscall_ptr = Some(sentinel);
    for requirement in requirements {
        // Names are static C strings and the caller excludes all concurrent consumers.
        let original = unsafe { get(vfs, requirement.name.as_ptr()) };
        if requirement.must_be_active && original.is_none() {
            return Err(GuardError::GuardUnavailable);
        }
        if original.is_none() {
            // SQLite remembers defaults lazily. Installing into a compiled-out
            // slot can make the sentinel its default and cannot be undone with NULL.
            let reset = unsafe { set(vfs, requirement.name.as_ptr(), None) };
            if reset != ffi::SQLITE_OK || unsafe { get(vfs, requirement.name.as_ptr()) }.is_some() {
                return Err(GuardError::GuardUnavailable);
            }
            hooks.push(HookCapability {
                name: requirement
                    .name
                    .to_str()
                    .map_err(|_| GuardError::GuardUnavailable)?,
                active: false,
            });
            continue;
        }
        // Always attempt restoration, even if replacement reports an error.
        let assigned = unsafe { set(vfs, requirement.name.as_ptr(), sentinel_ptr) };
        let observed = unsafe { get(vfs, requirement.name.as_ptr()) };
        let restored = unsafe { set(vfs, requirement.name.as_ptr(), original) };
        let after = unsafe { get(vfs, requirement.name.as_ptr()) };
        if assigned != ffi::SQLITE_OK
            || restored != ffi::SQLITE_OK
            || !same(observed, sentinel_ptr)
            || !same(after, original)
        {
            return Err(GuardError::GuardUnavailable);
        }
        hooks.push(HookCapability {
            name: requirement
                .name
                .to_str()
                .map_err(|_| GuardError::GuardUnavailable)?,
            active: true,
        });
    }
    Ok(NativeAbi {
        vfs_name: expected
            .to_str()
            .map_err(|_| GuardError::GuardUnavailable)?,
        hooks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_native_target_abis_are_admitted() {
        for target in [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "x86_64-unknown-linux-gnu",
            "x86_64-pc-windows-msvc",
        ] {
            assert!(profile_for(target).is_ok(), "{target}");
        }
        for target in [
            "x86_64-unknown-linux-musl",
            "x86_64-pc-windows-gnu",
            "x86_64-pc-windows-gnullvm",
            "x86_64-unknown-linux-gnux32",
            "aarch64-unknown-linux-gnu",
            "x86_64-uwp-windows-msvc",
            "",
        ] {
            assert!(
                matches!(profile_for(target), Err(GuardError::GuardUnavailable)),
                "{target}"
            );
        }
    }

    #[test]
    fn null_unknown_or_missing_interfaces_are_unavailable() {
        // Null is explicitly accepted as a negative input by probe's contract.
        assert_eq!(
            unsafe { probe(std::ptr::null_mut(), c"unix", UNIX_SLOTS) },
            Err(GuardError::GuardUnavailable)
        );
        // Zero is valid for this C structure's integers, pointers and optional function pointers.
        let mut table: ffi::sqlite3_vfs = unsafe { std::mem::zeroed() };
        table.iVersion = 2;
        assert_eq!(
            unsafe { probe(&mut table, c"unix", UNIX_SLOTS) },
            Err(GuardError::GuardUnavailable)
        );
        table.iVersion = 3;
        table.zName = c"unapproved".as_ptr();
        assert_eq!(
            unsafe { probe(&mut table, c"unix", UNIX_SLOTS) },
            Err(GuardError::GuardUnavailable)
        );
        table.zName = c"unix".as_ptr();
        assert_eq!(
            unsafe { probe(&mut table, c"unix", UNIX_SLOTS) },
            Err(GuardError::GuardUnavailable)
        );
    }

    /// Local callback-table fixture; never registered with the actual SQLite engine.
    struct Mock {
        current: ffi::sqlite3_syscall_ptr,
        default: ffi::sqlite3_syscall_ptr,
        sets: u32,
        fail_on: Option<u32>,
        /// A selected call reports success but leaves the slot unchanged.
        ignore_on: Option<u32>,
        activated: bool,
    }

    /// Distinct original callback address; the probe never executes it.
    extern "C" fn original_callback() {
        std::hint::black_box(1);
    }

    /// Read the fixture's current slot without touching the actual engine.
    ///
    /// # Safety
    /// The VFS must contain a live, exclusively borrowed Mock in pAppData.
    unsafe extern "C" fn mock_get(
        vfs: *mut ffi::sqlite3_vfs,
        _name: *const std::ffi::c_char,
    ) -> ffi::sqlite3_syscall_ptr {
        unsafe { (*((*vfs).pAppData.cast::<Mock>())).current }
    }

    /// Model lazy defaults, reported failures and success without an actual update.
    ///
    /// # Safety
    /// The VFS must contain a live, exclusively borrowed Mock in pAppData.
    unsafe extern "C" fn mock_set(
        vfs: *mut ffi::sqlite3_vfs,
        _name: *const std::ffi::c_char,
        callback: ffi::sqlite3_syscall_ptr,
    ) -> std::ffi::c_int {
        let state = unsafe { &mut *((*vfs).pAppData.cast::<Mock>()) };
        state.sets += 1;
        if state.fail_on == Some(state.sets) {
            return ffi::SQLITE_ERROR;
        }
        state.activated |= callback.is_some();
        if state.ignore_on == Some(state.sets) {
            return ffi::SQLITE_OK;
        }
        if state.default.is_none() {
            state.default = state.current;
        }
        state.current = callback.or(state.default);
        ffi::SQLITE_OK
    }

    /// Supply the unused enumeration entry required by the VFS interface contract.
    extern "C" fn mock_next(
        _vfs: *mut ffi::sqlite3_vfs,
        _name: *const std::ffi::c_char,
    ) -> *const std::ffi::c_char {
        std::ptr::null()
    }

    /// Construct a local table without registering or modifying any global VFS.
    ///
    /// # Safety
    /// `state` must remain live and unmoved until all probe callbacks have returned.
    unsafe fn mock_table(state: *mut Mock) -> ffi::sqlite3_vfs {
        // All zero representations are valid for this C structure's fields.
        let mut table: ffi::sqlite3_vfs = unsafe { std::mem::zeroed() };
        table.iVersion = 3;
        table.zName = c"fixture".as_ptr();
        table.pAppData = state.cast();
        table.xGetSystemCall = Some(mock_get);
        table.xSetSystemCall = Some(mock_set);
        table.xNextSystemCall = Some(mock_next);
        table
    }

    #[test]
    fn compiled_out_slots_are_not_activated() {
        let mut state = Mock {
            current: None,
            default: None,
            sets: 0,
            fail_on: None,
            ignore_on: None,
            activated: false,
        };
        // The local state remains in place throughout this synchronous probe.
        let mut table = unsafe { mock_table(&mut state) };
        let result = unsafe { probe(&mut table, c"fixture", &[conditional(c"disabled")]) }.unwrap();
        assert!(!state.activated);
        assert_eq!(state.sets, 1);
        assert!(!result.hooks[0].active);
        assert!(state.current.is_none());
    }

    #[test]
    fn replacement_and_restoration_failures_remain_unavailable() {
        for fail_on in [1, 2] {
            let mut state = Mock {
                current: Some(original_callback),
                default: None,
                sets: 0,
                fail_on: Some(fail_on),
                ignore_on: None,
                activated: false,
            };
            // This table and its state are isolated from the real engine and remain live.
            let mut table = unsafe { mock_table(&mut state) };
            assert_eq!(
                unsafe { probe(&mut table, c"fixture", &[required(c"active")]) },
                Err(GuardError::GuardUnavailable)
            );
            assert_eq!(
                state.sets, 2,
                "Restoration must be attempted even after failed replacement"
            );
        }
    }

    #[test]
    fn successful_mock_round_trip_reports_active_and_restores_callback() {
        let original: ffi::sqlite3_syscall_ptr = Some(original_callback);
        let mut state = Mock {
            current: original,
            default: None,
            sets: 0,
            fail_on: None,
            ignore_on: None,
            activated: false,
        };
        // The unregistered fixture remains in place for this synchronous probe.
        let mut table = unsafe { mock_table(&mut state) };
        let result = unsafe { probe(&mut table, c"fixture", &[required(c"active")]) }.unwrap();
        assert_eq!(
            result.hooks,
            vec![HookCapability {
                name: "active",
                active: true
            }]
        );
        assert_eq!(state.sets, 2);
        assert!(state.activated);
        assert!(same(state.current, original));
    }

    #[test]
    fn successful_set_without_matching_read_back_is_unavailable() {
        for ignore_on in [1, 2] {
            let original: ffi::sqlite3_syscall_ptr = Some(original_callback);
            let mut state = Mock {
                current: original,
                default: None,
                sets: 0,
                fail_on: None,
                ignore_on: Some(ignore_on),
                activated: false,
            };
            // Both replacement and restoration are exercised without mutating the real VFS.
            let mut table = unsafe { mock_table(&mut state) };
            assert_eq!(
                unsafe { probe(&mut table, c"fixture", &[required(c"active")]) },
                Err(GuardError::GuardUnavailable),
                "Successful call {ignore_on} without an update must fail its read-back check"
            );
            assert_eq!(state.sets, 2, "Restoration must still be attempted");
            assert_eq!(same(state.current, original), ignore_on == 1);
        }
    }
}
