//! Public engine/ABI inspection in its own test process, without source files,
//! database connections, model calls or runtime integration.
use agent_insights_sqlite_guard::{SQLITE_SOURCE_ID, inspect_engine, inspect_native_abi};

/// Repeated probes in this fresh process must leave the native call table unchanged.
#[test]
fn public_inspection_reports_the_pinned_engine_and_restored_native_slots() {
    let engine = inspect_engine().expect("the built engine must match its locked policy");
    assert_eq!(engine.source_id, SQLITE_SOURCE_ID);
    // This fresh test process has no database connections or concurrent SQLite consumers.
    let before = unsafe { inspect_native_abi() }.expect("the native ABI must be available");
    assert!(matches!(before.vfs_name, "unix" | "win32"));
    assert!(!before.hooks.is_empty());
    // A second probe checks that the first one did not leave sentinels installed.
    let after = unsafe { inspect_native_abi() }.expect("callback restoration must be repeatable");
    assert_eq!(before, after);
}
