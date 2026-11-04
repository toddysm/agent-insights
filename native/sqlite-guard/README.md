# Native SQLite guard development

Work item [#36](https://github.com/toddysm/agent-insights/issues/36) implements
the native source-safety boundary described in the
[approved design](https://github.com/toddysm/agent-insights/issues/33#issuecomment-6621343238).
It is not another agent, an application session database or a copied corpus.

## Current implementation

The core pins and inspects the SQLite engine and probes the
virtual file system (VFS) application binary interface (ABI). It verifies that
required callback slots exist and that active callbacks can be replaced and
restored in an exclusively owned, quiescent engine. Compiled-out callbacks are
never activated: SQLite lazily records defaults, so activating an empty slot
could prevent restoration with a null callback.

The probe checks actual callback read-backs, not just success return codes.
Tests cover a successful round trip and false-success results during both
replacement and restoration; either mismatch keeps the interface unavailable.

`ApprovedSource` captures one explicitly authorized main file and its exact
companions; `GuardedDatabase` installs source policy before SQLite opens them.
Ordinary VFS operations and internal Unix/Win32 file calls are guarded:

- Main/WAL handles are existing-only and read-only, with opened-object identity
  checks before SQLite receives the handle.
- Existing SHM may be mapped for SQLite coordination, but never created,
  extended, truncated or deleted. Mapping bounds use the actual open handle.
- Raw writes, deletion, metadata changes and preallocation are denied. A denied
  operation remains a failed read even when the native caller ignores its result.
- SQLite retains its own locking protocol. Source limits, a bounded native busy
  wait, normal close and failed-setup cleanup are tested with a separate producer.
- WAL mode retains a connection-lifetime read snapshot, so later commits do not
  change its query values. Rollback mode uses a separate implicit transaction per
  scalar statement; an idle reader does not block a DELETE-mode producer's commit.
  Separate rollback-mode calls may observe different commits. Individual reads
  can still contend with writers; process-level deadlines remain #37.
- Exclusive WAL-index recovery locks are rejected, including when a live producer
  retains invalid SHM. Native unmap failures poison the engine even if SQLite
  ignores the return value.

The public scalar-read seam accepts only code-owned, single read-only integer
queries. A preparation-time authorizer rejects configuration changes; only
read-only `query_only`, `trusted_schema`, `busy_timeout`, `user_version` and
`data_version` PRAGMAs are admitted. It is not a browser/model query console. Source matching, domain schema
admission and named projections remain the protocol/runtime readers' responsibility.
The application must authorize the main path before preflight. Preflight uses
read-only, no-follow descriptors and binds canonicalization to the opened main
object. All retained rollback journals, including empty ones, return
`JournalPresent`, not a claim that recovery is required. Retry after an active
DELETE-mode writer finishes and removes its journal. Idle TRUNCATE/PERSIST
sources retaining a journal are deliberately not admitted; the application
neither deletes it nor changes the producer's journal mode. Only the producer
may finish its journal lifecycle. Descriptors close before SQLite takes locks;
Unix transaction-time identity checks do not open extra same-inode descriptors.
Journal absence is rechecked around native open and reads, including empty
journals SQLite can hide from its own file-open checks.
`source_changed()` reports observed main/WAL metadata changes separately from
source identity rejection; a content change does not invalidate a WAL snapshot.

The core is not an operating-system sandbox or protection against arbitrary
native-code exploitation or a hostile same-account process. SHM coordination
can change existing bytes; no global atomic multi-source snapshot is claimed.
No database copy, immutable/live-file shortcut, repair or producer constructor
is used. Ordinary source errors and policy/cleanup failures are distinct.

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
  disables data-file memory mapping. Unix locking is pinned to POSIX-only
  (`SQLITE_ENABLE_LOCKING_STYLE=0`), with no automatic dot-file/flock/proxy
  fallback. The build policy is checked before admission. WAL shared memory is
  a separate mechanism.
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
cargo test --locked --manifest-path native/sqlite-guard/Cargo.toml --features qualification-hooks
RUSTDOCFLAGS="-D warnings" cargo doc --locked --manifest-path native/sqlite-guard/Cargo.toml --no-deps --document-private-items
```

The commands above are relative to the repository root. From the crate
directory, omit `--manifest-path native/sqlite-guard/Cargo.toml`.

The [native workflow](../../.github/workflows/native-guard.yml) executes on
macOS arm64/x64, GNU/Linux x64 and MSVC Windows x64 and verifies the actual
host target. The crate embeds Cargo's exact target triple; musl, Windows
GNU/gnullvm, x32 and other unqualified ABIs are explicitly rejected.
Source qualification uses a separate Node.js 24+ synthetic writer. One integration
test serializes real engine ownership and exercises multiple source scenarios;
its test count is not a count of the individual scenarios. Native execution is
required on each declared target before claiming that target qualified.

`qualification-hooks` adds deterministic race barriers and denied-operation
probes for testing only. It must not be enabled in released helpers. The
unmap fault reports failure after releasing the test-owned mapping so temporary
fixture cleanup remains possible; engine reuse must still fail. The
production build has no barrier callbacks or qualification operations. The
protocol/packaging items must verify that distinction in their handshake/artifacts.

## Unsafe contract

The ABI probe temporarily changes callback addresses. Its caller must own the
SQLite engine exclusively, with no connections or concurrent SQLite consumers.
No probe callback may execute as an I/O operation. After a failed probe,
abandon the engine/process rather than attempt source access. The crate does
not claim to sandbox arbitrary native code or a hostile same-account process.

The guarded connection has the same exclusive-engine obligation throughout its
lifetime. Only one guarded connection may own the engine in a process. Use
`close()` to observe teardown errors. Failed cleanup poisons further admission;
the helper supervisor must discard/terminate that process rather than reuse it.
Failed native interface probes also poison admission. Read-only SHM that needs
initialization is a recovery error, not permission for SQLite's private heap
WAL-index fallback; the owning producer must initialize it first.
Process cancellation and parent-loss supervision are implemented in #37, not
by pretending that synchronous library calls can be interrupted by a promise.

## Third-party notices

The pinned SQLite engine is [public domain](https://sqlite.org/copyright.html).
The [libsqlite3-sys bindings](https://github.com/rusqlite/rusqlite) are MIT
licensed. The `libc` and `windows-sys` platform bindings and the `tempfile` test
dependency are available under MIT or Apache-2.0. Dependencies retain their
upstream license notices in their
source packages. No upstream source implementation is copied into this
repository; Cargo builds the checksum-pinned dependency. Binary packaging must
include the required notices under #38 before release authorization in #39.
