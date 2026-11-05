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

#[cfg(feature = "qualification-hooks")]
static FAIL_UNMAP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(feature = "qualification-hooks")]
static FAIL_CLOSE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Report one unmap as failed after actually releasing the test mapping, avoiding leaked fixture resources.
#[cfg(feature = "qualification-hooks")]
pub(crate) fn qualification_fail_unmap() {
    FAIL_UNMAP.store(true, std::sync::atomic::Ordering::Release);
}

/// Preserve native success/failure, except for an explicitly armed qualification fault.
pub(crate) fn unmap_succeeded(result: bool) -> bool {
    #[cfg(feature = "qualification-hooks")]
    if FAIL_UNMAP.swap(false, std::sync::atomic::Ordering::AcqRel) {
        return false;
    }
    result
}

/// Report one close as failed after releasing the test handle, avoiding leaked fixture resources.
#[cfg(feature = "qualification-hooks")]
pub(crate) fn qualification_fail_close() {
    FAIL_CLOSE.store(true, std::sync::atomic::Ordering::Release);
}

/// Preserve native close results except for the explicitly armed qualification fault.
pub(crate) fn close_succeeded(result: bool) -> bool {
    #[cfg(feature = "qualification-hooks")]
    if FAIL_CLOSE.swap(false, std::sync::atomic::Ordering::AcqRel) {
        return false;
    }
    result
}
