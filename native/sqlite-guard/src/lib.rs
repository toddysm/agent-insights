//! Native SQLite guard core. The engine is pinned independently of Node and the
//! operating system; this crate is not yet wired into the application runtime.
//! Source-opening policy lives here, independently of the
//! [protocol helper](https://github.com/toddysm/agent-insights/issues/37).
//! Sources are explicit existing-file grants; no producer runtime or copied database is used.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(missing_docs)]

use libsqlite3_sys as ffi;
use std::ffi::CStr;
use std::fmt;

mod vfs;
pub use vfs::{HookCapability, NativeAbi, inspect_native_abi};

pub mod helper;
mod platform;
mod policy;
mod source;
pub use policy::GuardedDatabase;
#[cfg(feature = "qualification-hooks")]
pub use policy::QualificationOperation;
pub use source::{ApprovedSource, MAX_SOURCE_BYTES};

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
    /// Another guarded connection already owns this process's SQLite engine.
    InUse,
    /// A selected source or required companion could not be opened.
    SourceUnavailable,
    /// An operating-system I/O operation failed independently of source format.
    Io,
    /// Operating-system permissions denied source access.
    AccessDenied,
    /// A selected file changed identity, became a link or ceased to be regular.
    SourceChanged,
    /// The source or a requested mapping exceeds its fixed bound.
    Limit,
    /// The owning harness must finish recovery or initialize its shared memory.
    RecoveryRequired,
    /// A rollback journal is present; retry after the producer removes it. Retained-journal modes are not admitted.
    JournalPresent,
    /// The source does not match the application-owned schema declaration.
    Schema,
    /// A forbidden source operation was attempted; this read is permanently failed.
    PolicyViolation,
    /// Native lock waiting exhausted its bounded busy timeout.
    Busy,
    /// Source bytes or a returned value are not compatible with this operation.
    Data,
    /// The caller supplied an invalid path or non-scalar/non-read-only query.
    InvalidInput,
    /// The native connection or file cleanup did not complete successfully.
    Cleanup,
}

impl fmt::Display for GuardError {
    /// Render a fixed diagnostic without including native exception text.
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::EngineMismatch => "The SQLite engine does not match the qualified guard build.",
            Self::GuardUnavailable => "The required native SQLite guard is unavailable.",
            Self::InUse => "A guarded database already owns this SQLite engine.",
            Self::SourceUnavailable => "A selected database or required sidecar is unavailable.",
            Self::Io => "Source input/output is unavailable.",
            Self::AccessDenied => "Source access was denied by operating-system permissions.",
            Self::SourceChanged => "A source file changed identity or is not a regular file.",
            Self::Limit => "A source operation exceeded its fixed limit.",
            Self::RecoveryRequired => {
                "The owning harness must finish source recovery or initialization."
            }
            Self::JournalPresent => {
                "A rollback journal is present; retry after the owning harness removes it. Retained-journal modes are not supported."
            }
            Self::Schema => "The source schema is not supported by this declaration.",
            Self::PolicyViolation => "A forbidden source operation was prevented.",
            Self::Busy => "The source remained locked beyond the bounded wait.",
            Self::Data => "The source contains unsupported or malformed data.",
            Self::InvalidInput => "The guarded read request is invalid.",
            Self::Cleanup => "Native source cleanup did not complete.",
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
    /// Whether automatic Unix fallback to dot-file/flock/proxy locking is disabled.
    pub posix_locking_only: bool,
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
        posix_locking_only: compile_option(c"ENABLE_LOCKING_STYLE=0"),
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
            || !self.posix_locking_only
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
        assert!(engine.posix_locking_only);
    }

    #[test]
    fn incompatible_engine_or_build_policy_is_not_accepted() {
        let valid = inspect_engine().unwrap();
        for index in 0..6 {
            let mut changed = valid.clone();
            match index {
                0 => changed.source_id.push_str("-different"),
                1 => changed.extensions_omitted = false,
                2 => changed.memory_temporary_storage = false,
                3 => changed.workers_disabled = false,
                4 => changed.data_file_mapping_disabled = false,
                _ => changed.posix_locking_only = false,
            }
            assert_eq!(changed.validate(), Err(GuardError::EngineMismatch));
        }
    }
}
