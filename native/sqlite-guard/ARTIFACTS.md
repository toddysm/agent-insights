# Native helper artifacts and explicit preparation

[#38](https://github.com/toddysm/agent-insights/issues/38) builds qualified
**release candidates**. It does not publish binaries. Versioned publication and end-user installation verification remain gated by
[#39](https://github.com/toddysm/agent-insights/issues/39).

## Trust and current availability

A checksum inside a package cannot authenticate that package. Verification
requires an independently trusted manifest digest:

- Production lookup uses only application-owned release pins. This checkout
  pins `native-helper-v0.1.0`; missing/tampered installation reports
  `NATIVE_GUARD_UNAVAILABLE` explicitly. A pin does not prove publication.
- Developer preparation is an explicit `--candidate` workflow. A clean local
  build writes its trust receipt **outside** the packaged directory, only after
  qualification passes. The receipt must match the current clean source checkout.
  Do not accept a receipt copied from an untrusted package or capture.
- Package metadata binds the executable and third-party notices to their
  SHA-256 digests and byte lengths. The external pin binds the metadata itself.
  File hashes, fixed architecture, pinned engine/build policy and the source-free
  handshake must agree before the helper is prepared.

The receipt is local build trust, not a signature, public release attestation,
formal native-security audit or protection against a hostile same-account
process. CI (continuous integration) artifacts are reviewable candidates, not an
instruction to execute arbitrary files. A manifest and binary replaced together
are rejected by the independent pin.

## Supported candidate targets

| Native runner | Artifact target            |
| ------------- | -------------------------- |
| macOS arm64   | `aarch64-apple-darwin`     |
| macOS x64     | `x86_64-apple-darwin`      |
| GNU/Linux x64 | `x86_64-unknown-linux-gnu` |
| Windows x64   | `x86_64-pc-windows-msvc`   |

Builds verify Rust's actual host triple and run the binary on that host.
Unsupported architectures and non-GNU Linux fail explicitly, without selecting
another target. OS (operating system) compatibility is qualified on the recorded
runner version; the self-check rejects binaries that cannot execute on the
preparing machine. Broader older-OS compatibility is not inferred from a triple.

## Versioned release preparation

Publication and actual download verification are recorded in
[#39](https://github.com/toddysm/agent-insights/issues/39). Until that record
confirms rollout, do not infer availability from the pins in a checkout.
This native-helper prerelease is not a complete application release.

The [application-owned pins](../../src/runtime/native-release.ts) select only
`native-helper-v0.1.0`, sourced from
`d0cabfcb7ce78d83a061138cd70b1cbaae47b648`. Its exact packaged and installed
candidates passed on all four native runners in
[qualification run 42125840919](https://github.com/toddysm/agent-insights/actions/runs/42125840919).
Publishing renames those verified files; it does not rebuild their contents.
Guard version is `0.1.0`, protocol version is `1`, Rust is `1.91.0`, and the
manifest pins the exact SQLite source identifier and build options.

With Node.js 24+, npm and the application checkout, explicitly run:

```sh
npm ci --ignore-scripts
npm run prepare:native
```

No Rust toolchain or C compiler is needed for release preparation. The npm
command builds only the application control code. It accepts no URL, version,
executable path or browser/model-supplied override.

The three fixed GitHub release asset names for the selected target are:

- `manifest-<target>.json`
- `agent-insights-sqlite-helper-<target>` (append `.exe` for Windows)
- `THIRD-PARTY-NOTICES-<target>.txt`

All URLs use the exact repository/tag in the pins, not `latest`. HTTPS redirects
are limited to GitHub's fixed release transport hosts, without credentials.
The independently pinned manifest digest and byte length are checked **before**
an executable is downloaded. Its source revision, target, engine and guard
contract must match. Executable and notices downloads enforce exact hashes and
byte counts even without `Content-Length`, sharing a 90-second download deadline.
No archive extraction or package install hook runs.

Successful preparation checks the source-free handshake and atomically installs
verified bytes at `.native-helper/<target>/<manifest-sha256>/`. Output is
sanitized JSON containing `prepared`, `release`, `target`, `sourceCommit` and
`manifestSha256`, never local build paths or native diagnostics. An existing
installation is verified and self-checked offline; tampering is an error, not
an automatic redownload/repair.

An unavailable release, unsupported platform, checksum/length mismatch,
permission failure or incompatible self-check reports
`NATIVE_GUARD_UNAVAILABLE` and a nonzero exit status. Failed attempts remove
only their own download/preparation staging directories. File-only and analysis
features remain independent; no read or refresh retries preparation.

After separately authorized publication, the
[release smoke workflow](../../.github/workflows/native-release.yml) executes
this exact end-user command on all four supported runners, then checks runtime
lookup and offline idempotence. It can be called from the existing native
workflow with `verify_release=true`; ordinary native qualification remains the
default. This smoke path installs no Rust/C tools and builds no replacement
native binaries. Candidate/fixture checks are not a substitute for this actual
release download qualification.

## Contributor workflow

Prerequisites: Node.js 24+, the pinned Rust 1.91.0 toolchain, a native C compiler,
Git, and a clean committed checkout. Build dependencies may be restored by Cargo;
only the explicit build command performs this work. It uses `--locked`,
`--release`, `--no-default-features` and the actual host target in a dedicated
target directory. Ambient compiler/engine/loader flags are not forwarded.
Cargo runs from an isolated temporary working directory and configuration home,
using the exact Rust 1.91.0 executables resolved by rustup. The hashed repository
Cargo policy is supplied explicitly. Caller `HOME`/`CARGO_HOME` configuration,
Rust flags and compiler wrappers are not inherited; unexpected ancestor Cargo
configuration fails closed. Installed-byte qualification uses the same isolation.
Both packaged- and installed-byte qualification use the same required-test
runner: it lists the exact parent-loss test before execution and requires one
passed, zero failed and zero ignored tests. Missing, cfg-disabled or ignored
tests cannot produce a passing receipt.

From the repository root:

```sh
npm ci --ignore-scripts
npm run test:native-artifacts
npm run package:native
npm run prepare:native -- --candidate
npm run qualify:native
```

The npm commands compile the TypeScript control code where needed. Candidate
packaging needs Rust/C; preparation and verification do not build native code.
No npm install lifecycle hook prepares or downloads a helper.

Packaging writes:

```text
.build/native-candidates/<target>/<revision-and-input-sha256>/
  agent-insights-sqlite-helper[.exe]
  manifest.json
  THIRD-PARTY-NOTICES.txt
.build/native-trust/<target>.json
.build/native-trust/<target>-prepared.json
```

The manifest records the Git revision, source-input digest, Cargo lockfile,
toolchain and build-policy digests, actual compiler/tool versions, pinned SQLite
source identifier/options, handshake, executable and notices hashes. Source
identification is reproducible; bit-for-bit reproducible compiler output across
different machines is not claimed.

The receipt records actual runner/OS/architecture, Node version, optional workflow
run identifier and passed qualification. It is emitted only after the **packaged
binary** passes the full synthetic process suite and parent-loss test, with its
hash rechecked afterward. The exact executable—not Cargo's default development
output—is passed to those tests.

Preparation copies verified bytes into a temporary directory, self-checks them,
re-verifies them, and atomically renames the complete package to:

```text
.native-helper/<target>/<manifest-sha256>/
```

The final location is content-addressed. Existing installations are verified,
not overwritten or silently repaired. A cancelled/failed attempt cleans only
its own staging directory; a directory left by process death is never selected.
Parent components and source files must be regular files/directories, not links.
Package-provided filenames cannot select arbitrary locations.

`npm run qualify:native` executes the process suite, parent-loss test and
preparation lifecycle tests against the **installed bytes**, and verifies those
bytes again. Temporary sources and artifact locations belong only to the tests.
The separate prepared-qualification report is emitted only after these checks pass.
No private captures or authenticated model calls are used.

The native workflow repeats this on all four targets and retains candidates
and their receipts for 14 days. Downloading a workflow artifact does not
automatically trust or activate it, and there is no GitHub release or registry
publication in this workflow.

## Runtime boundary

[The verification module](../../src/runtime/native-helper.ts) is read-only:
it does not import network/build/process-execution code or call preparation.
Missing, modified, malformed or unsupported artifacts produce the fixed
`NATIVE_GUARD_UNAVAILABLE` error. It never falls back to Node SQLite, a copied
database, another target or a candidate receipt.

Application integration remains
[#33](https://github.com/toddysm/agent-insights/issues/33). It must verify the
application-owned pin and installed bytes immediately before launch, validate the
[protocol handshake](PROTOCOL.md), keep parent/source leases, and surface
unavailability without disabling file-only or analysis features. No read/refresh
path downloads, builds, prepares or selects a browser/model-provided executable.
The shared SQLite runtime integration shipped through
[#33](https://github.com/toddysm/agent-insights/issues/33). That is separate from
source-specific reader delivery and verification of published native artifacts.

## Failure, upgrade and rollback

| Symptom                               | Action                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release asset unavailable             | Check the #39 rollout record and retry explicit release preparation; never invent a URL/checksum or fall back to a development candidate.                                                            |
| Dirty checkout / source mismatch      | Commit the intended source, then package a new candidate. Do not edit the receipt to bypass the mismatch.                                                                                            |
| Candidate already exists              | Preserve the previous candidate; explicitly remove only that verified owned candidate directory if a rebuild of identical inputs is intended. Packaging does not recursively delete arbitrary roots. |
| Missing or checksum-mismatched file   | Stop using it. Obtain/rebuild the trusted candidate; do not accept its self-declared hash.                                                                                                           |
| Self-check, target or engine mismatch | Use the qualified target/toolchain; do not bypass the check or enable qualification hooks.                                                                                                           |
| Interrupted preparation               | No final location points at partial data. Retry after inspecting/removing only the exact owned `.preparing-*` directory if necessary.                                                                |
| Upgrade/rollback                      | Select an independently reviewed pin for the desired version. Content-addressed installations coexist; current lookup never guesses the newest directory. Release pin changes belong to #39.         |

Final ordinary-user capture/usage documentation remains #1/#21. This contributor
guide does not claim that public compiler-free installation has shipped.

Release upgrades or rollback require a reviewed application pin change, not
replacing assets under an existing tag. Stop the application before removing
only a verified owned content-addressed installation; never remove harness
sources. Restore a prior reviewed checkout/pin only when its release is still
trusted and qualified. Before the first release, there is no earlier released
helper to roll back to: file-only operation remains available.

Revocation is a separately authorized release withdrawal **and** a reviewed
pin-removal/update PR. Deleting remote assets alone does not revoke already
installed bytes. Stop native reads and remove the exact revoked installation
after verifying its target/digest; do not silently select another directory.
Keep #39 open if any supported platform's end-user verification fails.
