//! Native SQLite guard core. The engine is pinned independently of Node and the
//! operating system; this crate is not yet wired into the application runtime.
//! Source-opening policy is developed here before the
//! [protocol helper](https://github.com/toddysm/agent-insights/issues/37).
//! This initial component exposes engine/VFS inspection only, not source access.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(missing_docs)]

use libsqlite3_sys as ffi;
use std::ffi::CStr;
use std::fmt;

mod vfs;
pub use vfs::{HookCapability, NativeAbi, inspect_native_abi};

/// Exact engine identity reviewed for the VFS/operating-system interception seam.
pub const SQLITE_SOURCE_ID: &str =
    "2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76";

/// Controlled guard errors contain no database path, SQL or captured payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardError {
    /// The linked engine or required compile-time policy differs from qualification.
    EngineMismatch,
    /// The native platform/VFS does not expose the required guard seam.
    GuardUnavailable,
}

impl fmt::Display for GuardError {
    /// Render a fixed diagnostic without including native exception text.
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::EngineMismatch => "The SQLite engine does not match the qualified guard build.",
            Self::GuardUnavailable => "The required native SQLite guard is unavailable.",
        })
    }
}

impl std::error::Error for GuardError {}

/// Engine metadata only; this does not certify source-access interception.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineIdentity {
    /// SQLite's complete source identifier, not just the display version.
    pub source_id: String,
    /// Whether loadable extensions were removed from this engine.
    pub extensions_omitted: bool,
    /// Whether SQLite temporary storage is forced to memory.
    pub memory_temporary_storage: bool,
    /// Whether SQLite's background query workers are disabled.
    pub workers_disabled: bool,
    /// Whether data-file memory mapping is disabled; WAL shared memory is separate.
    pub data_file_mapping_disabled: bool,
}

/// Inspect the linked engine without opening a database or reading session sources.
///
/// # Errors
/// Returns [`GuardError::EngineMismatch`] for an unexpected engine identity or
/// compile-time policy. A successful identity check is not guard qualification.
///
/// # Examples
/// ```
/// let identity = agent_insights_sqlite_guard::inspect_engine()?;
/// assert!(identity.extensions_omitted);
/// # Ok::<(), agent_insights_sqlite_guard::GuardError>(())
/// ```
pub fn inspect_engine() -> Result<EngineIdentity, GuardError> {
    // SQLite returns a static, non-null, NUL-terminated source identity.
    let source_id = unsafe { CStr::from_ptr(ffi::sqlite3_sourceid()) }
        .to_str()
        .map_err(|_| GuardError::EngineMismatch)?
        .to_owned();
    let identity = EngineIdentity {
        source_id,
        extensions_omitted: compile_option(c"OMIT_LOAD_EXTENSION"),
        memory_temporary_storage: compile_option(c"TEMP_STORE=3"),
        workers_disabled: compile_option(c"MAX_WORKER_THREADS=0"),
        data_file_mapping_disabled: compile_option(c"MAX_MMAP_SIZE=0"),
    };
    identity.validate()?;
    Ok(identity)
}

impl EngineIdentity {
    /// Reject mismatched engine/build metadata before any source-opening capability.
    ///
    /// # Errors
    /// Returns [`GuardError::EngineMismatch`] unless every required policy matches.
    pub fn validate(&self) -> Result<(), GuardError> {
        if self.source_id != SQLITE_SOURCE_ID
            || !self.extensions_omitted
            || !self.memory_temporary_storage
            || !self.workers_disabled
            || !self.data_file_mapping_disabled
        {
            return Err(GuardError::EngineMismatch);
        }
        Ok(())
    }
}

/// Query one code-owned compile option; no source or user-provided option is evaluated.
fn compile_option(option: &CStr) -> bool {
    // The borrowed C string stays alive for this synchronous SQLite metadata call.
    unsafe { ffi::sqlite3_compileoption_used(option.as_ptr()) != 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linked_engine_matches_the_pinned_source_and_memory_only_build() {
        let engine = inspect_engine().expect("the locked native engine must satisfy build policy");
        assert_eq!(engine.source_id, SQLITE_SOURCE_ID);
        assert!(engine.extensions_omitted);
        assert!(engine.memory_temporary_storage);
        assert!(engine.workers_disabled);
        assert!(engine.data_file_mapping_disabled);
    }

    #[test]
    fn incompatible_engine_or_build_policy_is_not_accepted() {
        let valid = inspect_engine().unwrap();
        for index in 0..5 {
            let mut changed = valid.clone();
            match index {
                0 => changed.source_id.push_str("-different"),
                1 => changed.extensions_omitted = false,
                2 => changed.memory_temporary_storage = false,
                3 => changed.workers_disabled = false,
                _ => changed.data_file_mapping_disabled = false,
            }
            assert_eq!(changed.validate(), Err(GuardError::EngineMismatch));
        }
    }
}
