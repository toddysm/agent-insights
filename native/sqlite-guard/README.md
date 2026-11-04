# Native SQLite guard development

Work item [#36](https://github.com/toddysm/agent-insights/issues/36) implements
the native source-safety boundary described in the
[approved design](https://github.com/toddysm/agent-insights/issues/33#issuecomment-6621343238).
It is not another agent, an application session database or a copied corpus.

## Current implementation

This initial component pins and inspects the SQLite engine and probes the
virtual file system (VFS) application binary interface (ABI). It verifies that
required callback slots exist and that active callbacks can be replaced and
restored in an exclusively owned, quiescent engine. Compiled-out callbacks are
never activated: SQLite lazily records defaults, so activating an empty slot
could prevent restoration with a null callback.

**This does not implement or certify the source mutation guard yet.** No
source-opening API is exposed. The policy VFS, actual operating-system guards,
source lifecycle/race tests and their full platform qualification remain in
#36. Do not use a passing ABI probe as proof of read-only source access.

The bounded helper process/protocol is
[#37](https://github.com/toddysm/agent-insights/issues/37), artifact preparation
is [#38](https://github.com/toddysm/agent-insights/issues/38), runtime integration
remains [#33](https://github.com/toddysm/agent-insights/issues/33), and binary
publication is separately gated in
[#39](https://github.com/toddysm/agent-insights/issues/39).
The existing Node runtime and production-reader availability are unchanged.

## Engine and build policy

- Rust 1.91.0 is pinned in [the toolchain file](../../rust-toolchain.toml).
- `libsqlite3-sys` 0.39.1 bundles SQLite 3.54.1. Its complete source identifier
  is checked at runtime rather than trusting a display version.
- [Cargo configuration](../../.cargo/config.toml) forces memory-only temporary
  storage, removes loadable extensions, disables background query workers and
  disables data-file memory mapping. WAL shared memory is a separate mechanism.
- System-library fallback is disabled for this build. A wrong source identity
  or missing required build policy returns a controlled error.
- [Cargo.lock](Cargo.lock) pins the resolved dependency versions and checksums.
  The bindings retain their default build-support features because their
  current build script requires them even when compiling the bundled engine.

Run from this repository or crate directory so the repository's Cargo
configuration is applied. Native development requires Rust/rustup and a C
compiler. The ordinary-user artifact preparation path is not implemented yet;
no installation hook or runtime download is introduced by this crate.

```sh
cargo fmt --manifest-path native/sqlite-guard/Cargo.toml --check
cargo clippy --locked --manifest-path native/sqlite-guard/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path native/sqlite-guard/Cargo.toml
RUSTDOCFLAGS="-D warnings" cargo doc --locked --manifest-path native/sqlite-guard/Cargo.toml --no-deps --document-private-items
```

The commands above are relative to the repository root. From the crate
directory, omit `--manifest-path native/sqlite-guard/Cargo.toml`.

The [native workflow](../../.github/workflows/native-guard.yml) executes on
macOS arm64/x64, GNU/Linux x64 and MSVC Windows x64 and verifies the actual
host target. The crate embeds Cargo's exact target triple; musl, Windows
GNU/gnullvm, x32 and other unqualified ABIs are explicitly rejected.
At this stage it qualifies engine/ABI behavior only, not source protection or
all operating-system versions.

## Unsafe contract

The ABI probe temporarily changes callback addresses. Its caller must own the
SQLite engine exclusively, with no connections or concurrent SQLite consumers.
No probe callback may execute as an I/O operation. After a failed probe,
abandon the engine/process rather than attempt source access. The crate does
not claim to sandbox arbitrary native code or a hostile same-account process.

## Third-party notices

The pinned SQLite engine is [public domain](https://sqlite.org/copyright.html).
The [libsqlite3-sys bindings](https://github.com/rusqlite/rusqlite) are MIT
licensed. Build dependencies retain their upstream license notices in their
source packages. No upstream source implementation is copied into this
repository; Cargo builds the checksum-pinned dependency. Binary packaging must
include the required notices under #38 before release authorization in #39.
