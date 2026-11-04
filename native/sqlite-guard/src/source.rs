//! Capture only an explicitly approved main file and its exact SQLite companions.
//! Preflight is not the no-create guard; native opens must recheck actual handles.

use crate::{GuardError, platform};
use std::fs::{Metadata, symlink_metadata};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Qualification-only callback; production builds contain no opening barrier.
#[cfg(feature = "qualification-hooks")]
type OpenBarrier = std::sync::Arc<dyn Fn(&Path) + Send + Sync>;

/// Maximum combined size of one main database and its existing companions.
pub const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;

/// Exact source roles; no path read from database content becomes a new grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    Main,
    Wal,
    Shm,
    Journal,
}

/// An existing object admitted before SQLite takes any native locks.
#[derive(Clone)]
pub(crate) struct Entry {
    pub path: PathBuf,
    pub role: Role,
    pub identity: platform::Identity,
    pub size: u64,
    modified: SystemTime,
}

/// One caller-approved source set. It contains no database/session data cache.
///
/// The application must authorize the supplied main path before calling
/// [`ApprovedSource::capture`]. Only its exact WAL/SHM companions are admitted;
/// retained journals are rejected. Captured content never grants another path.
#[derive(Clone)]
pub struct ApprovedSource {
    pub(crate) main: PathBuf,
    pub(crate) entries: Vec<Entry>,
    #[cfg(feature = "qualification-hooks")]
    pub(crate) before_open: Option<OpenBarrier>,
}

/// Classify filesystem errors without retaining paths or native error text.
pub(crate) fn io_error(error: &std::io::Error) -> GuardError {
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ELOOP) {
        return GuardError::SourceChanged;
    }
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => GuardError::AccessDenied,
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
            GuardError::SourceUnavailable
        }
        std::io::ErrorKind::InvalidInput => GuardError::InvalidInput,
        _ => GuardError::Io,
    }
}

/// Append an exact SQLite suffix without replacing a filename extension.
fn companion(main: &Path, suffix: &str) -> PathBuf {
    let mut name = main.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Reject links/non-files and retain only metadata, never file contents.
fn regular(path: &Path) -> Result<Metadata, GuardError> {
    let metadata = symlink_metadata(path).map_err(|error| io_error(&error))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(GuardError::SourceChanged);
    }
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(GuardError::Limit);
    }
    Ok(metadata)
}

impl ApprovedSource {
    /// Observe an already-authorized absolute path and its existing companions.
    ///
    /// # Errors
    /// Rejects missing/inaccessible/nonregular files, invalid SQLite headers,
    /// missing live-WAL companions, retained rollback journals and size excess.
    /// All preflight descriptors close before a SQLite connection is started.
    pub fn capture(path: &Path) -> Result<Self, GuardError> {
        Self::capture_bound(path, || {})
    }

    /// Bind canonicalization to the already-opened object; the callback is only exposed in qualification builds.
    fn capture_bound(path: &Path, before_canonical: impl FnOnce()) -> Result<Self, GuardError> {
        let _exclusive = crate::policy::exclusive()?;
        if !path.is_absolute() {
            return Err(GuardError::InvalidInput);
        }
        let initial = regular(path)?;
        let main_file = platform::preflight_file(path)?;
        let main_identity = platform::identity_file(&main_file)?;
        if !platform::matches_path(path, &initial, &main_identity)? {
            return Err(GuardError::SourceChanged);
        }
        before_canonical();
        if !platform::matches_path(path, &regular(path)?, &main_identity)? {
            return Err(GuardError::SourceChanged);
        }
        let main = path.canonicalize().map_err(|error| io_error(&error))?;
        if !platform::matches_path(&main, &regular(&main)?, &main_identity)? {
            return Err(GuardError::SourceChanged);
        }
        let mut main_file = Some(main_file);
        let mut entries = Vec::new();
        let mut header = [0; 100];
        for (role, selected) in [
            (Role::Main, main.clone()),
            (Role::Wal, companion(&main, "-wal")),
            (Role::Shm, companion(&main, "-shm")),
            (Role::Journal, companion(&main, "-journal")),
        ] {
            let metadata = match regular(&selected) {
                Ok(metadata) => metadata,
                Err(GuardError::SourceUnavailable) if role != Role::Main => {
                    // Confirm absence separately; access/I/O failures must not become "missing".
                    match symlink_metadata(&selected) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(io_error(&error)),
                        Ok(_) => return Err(GuardError::SourceChanged),
                    }
                }
                Err(error) => return Err(error),
            };
            if role == Role::Journal {
                return Err(GuardError::RecoveryRequired);
            }
            let mut file = if role == Role::Main {
                main_file.take().ok_or(GuardError::GuardUnavailable)?
            } else {
                platform::preflight_file(&selected)?
            };
            let identity = platform::identity_file(&file)?;
            if !platform::matches_path(&selected, &metadata, &identity)? {
                return Err(GuardError::SourceChanged);
            }
            let metadata = file.metadata().map_err(|error| io_error(&error))?;
            if role == Role::Main {
                file.read_exact(&mut header).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::UnexpectedEof {
                        GuardError::Data
                    } else {
                        io_error(&error)
                    }
                })?;
            }
            if entries
                .iter()
                .any(|entry: &Entry| entry.identity == identity)
            {
                return Err(GuardError::SourceChanged);
            }
            entries.push(Entry {
                path: selected,
                role,
                identity,
                size: metadata.len(),
                modified: metadata.modified().map_err(|error| io_error(&error))?,
            });
        }
        if &header[..16] != b"SQLite format 3\0" {
            return Err(GuardError::Data);
        }
        let wal_mode = header[18] == 2 || header[19] == 2;
        if wal_mode
            && (!entries.iter().any(|entry| entry.role == Role::Wal)
                || !entries.iter().any(|entry| entry.role == Role::Shm))
        {
            return Err(GuardError::SourceUnavailable);
        }
        let source = Self {
            main,
            entries,
            #[cfg(feature = "qualification-hooks")]
            before_open: None,
        };
        source.verify()?;
        Ok(source)
    }

    /// Recheck journal absence, identities and bounds without extra transaction-time handles.
    pub(crate) fn verify(&self) -> Result<bool, GuardError> {
        // SQLite's xAccess can hide zero-length journals, so checking xOpen alone is insufficient.
        match symlink_metadata(companion(&self.main, "-journal")) {
            Ok(_) => return Err(GuardError::RecoveryRequired),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(&error)),
        }
        let mut total = 0u64;
        let mut changed = false;
        for entry in &self.entries {
            let metadata = regular(&entry.path)?;
            if !platform::matches_path(&entry.path, &metadata, &entry.identity)? {
                return Err(GuardError::SourceChanged);
            }
            total = total.checked_add(metadata.len()).ok_or(GuardError::Limit)?;
            if entry.role != Role::Shm
                && (metadata.len() != entry.size
                    || metadata.modified().map_err(|error| io_error(&error))? != entry.modified)
            {
                changed = true;
            }
        }
        if total > MAX_SOURCE_BYTES {
            return Err(GuardError::Limit);
        }
        Ok(changed)
    }

    /// Match an exact authorized native filename; a missing/foreign role is not a grant.
    pub(crate) fn entry(&self, path: &Path) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|entry| platform::same_path(&entry.path, path))
    }

    /// Install a deterministic test-only barrier immediately before a guarded native open.
    ///
    /// This build feature is for qualification binaries, never release helpers.
    #[cfg(feature = "qualification-hooks")]
    pub fn with_open_barrier(mut self, callback: impl Fn(&Path) + Send + Sync + 'static) -> Self {
        self.before_open = Some(std::sync::Arc::new(callback));
        self
    }

    /// Inject a preflight replacement after opening the approved object but before canonicalization.
    ///
    /// # Errors
    /// Returns capture errors, including replacement/link rejection. Qualification builds only.
    #[cfg(feature = "qualification-hooks")]
    pub fn capture_with_preflight_barrier(
        path: &Path,
        callback: impl FnOnce(),
    ) -> Result<Self, GuardError> {
        Self::capture_bound(path, callback)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filesystem_failures_are_distinct_from_malformed_data() {
        for (kind, expected) in [
            (std::io::ErrorKind::NotFound, GuardError::SourceUnavailable),
            (
                std::io::ErrorKind::PermissionDenied,
                GuardError::AccessDenied,
            ),
            (std::io::ErrorKind::Other, GuardError::Io),
            (std::io::ErrorKind::InvalidInput, GuardError::InvalidInput),
        ] {
            assert_eq!(io_error(&std::io::Error::from(kind)), expected);
        }
    }
}
