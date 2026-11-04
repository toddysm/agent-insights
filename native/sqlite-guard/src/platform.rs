//! Platform-specific existing-only opens and bounded shared-memory mappings.
//! SQLite retains its own lock protocol; these guards do not implement database locks.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub(crate) use unix::*;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::*;
