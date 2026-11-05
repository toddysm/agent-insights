//! Standalone helper process; it owns SQLite and standard I/O without loading any producer runtime.

fn main() {
    // This executable is the sole SQLite consumer and owns the process/channels for its entire lifetime.
    let code = unsafe { agent_insights_sqlite_guard::helper::run(std::env::args_os().skip(1)) };
    std::process::exit(code);
}
