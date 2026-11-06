# Run the local interface

The current runtime implements
[#9](https://github.com/toddysm/agent-insights/issues/9): source configuration,
availability checks, a controlled read boundary and an in-memory reader registry.
It also includes the [Copilot analysis transport](copilot-analysis.md).
It includes the VS Code OpenTelemetry extension file-export reader from
[#10](https://github.com/toddysm/agent-insights/issues/10). Conversation readers,
report views and interpretation definitions are not installed yet.
The interface states those limitations explicitly. The
[historical prototype](../design/session-insights/README.md) is separate and
continues to use fictional data.

## Install and start

Use Node.js 24 and npm. From the repository root:

```bash
npm ci --include=dev --ignore-scripts
npm start -- --source /path/to/private/captures
```

Install dependencies once per checkout, and again when the lockfile changes.
The development dependencies are needed to compile this source distribution.
`npm start` runs `npm run build` automatically before launching; it does not
install packages or start an older build when compilation fails.

Git does not contain the generated `.build` directory. Pulling or cloning the
repository alone therefore does not prepare it to run. On older revisions that
lack automatic startup building, run `npm run build` before `npm start`.
If you deliberately disable npm lifecycle scripts for startup, build explicitly
first. The `--ignore-scripts` flag in the installation command above applies
only to installation; it does not disable later startup hooks.

`--source` can name a file or directory; repeat it for additional locations, up
to 32. Relative paths resolve against the startup directory. Shell-expanded home
paths work; the application does not expand a quoted literal `~`.
No locations are discovered or scanned automatically. Starting without sources
is valid and displays "No sources configured."

The server binds only to `127.0.0.1`. Its default port is chosen by the operating
system, avoiding collisions with other local services. Use `--port NUMBER` to
request a specific port; `--port 0` restores automatic selection.

Open the full launch URL printed by the server. Its fragment contains a
per-process access credential:

```text
http://127.0.0.1:<port>/#access=<generated-value>
```

Treat that URL like a password; do not share or commit it. The browser removes
the credential from the visible URL and retains it only in memory. A page reload
therefore requires reopening the original launch URL. The "Refresh sources"
button does not reload the page or lose access. Restarting the process changes
the credential. Stop the runtime with Ctrl+C.

## Source selection and limits

Configured locations are checked for availability and shown only after
authentication. A missing or unreadable startup location remains unavailable;
correct it and restart to grant access. Existing authorized locations can be
rechecked with "Refresh sources."

For a directory grant, a reader request must name a relative file inside it.
A regular-file read cannot select neighboring files through a file grant.
For a database, the grant also covers its exact existing `-wal`, `-shm` and
`-journal` companions, subject to the same identity and size checks, not arbitrary
neighboring paths. Traversal, cross-drive paths, links
escaping the canonical grant, and retargeted configured links are rejected.
Only regular files are read, using read-only descriptors. A single read is
limited to 64 MiB; oversized captures produce an explicit error, not silent
truncation. There are no filesystem watchers.

### Read an existing execution capture

1. Start with `--source` pointing to an existing VS Code OpenTelemetry file export
   or its authorized parent directory. Do not copy the capture into this project.
2. Open the private launch URL and select the configured source. For a directory,
   enter the relative capture filename.
3. Select `vscode-otel-jsonl` and choose **Read source**.
4. Inspect the observed session/record counts, **Read coverage** and expandable
   **Read limitations**. Reading does not invoke a model.
   **Operation classification** separates model calls (chat/embeddings), tool
   calls, agent executions and hook executions. Missing/empty, malformed and
   unsupported operations remain visible as unclassified spans, outside execution
   counts. For nine hooks and two missing-operation spans, expect **Hook
   executions: 9** and **Unclassified spans (operation missing): 2**.
   These are source-wide observations, not selected-session metrics or proof of
   complete capture. Conflicting spans and non-execution metric/log/content-event
   records have separate counts. Captured hook content is never executed.

The reader targets the extension file exporter inspected in VS Code 1.144.0;
it is not an Agent Debug Log export, OpenTelemetry Protocol wire export, saved
chat, native Copilot history or arbitrary JSON Lines reader. See the exact
[format and evidence limits](evidence-contracts.md#execution-reader-behavior).
Synthetic exporter-shaped fixtures qualify the declared format. A user-reported
fresh-capture smoke test found two session groups and 32 records with limitations;
a separately authorized bounded structural inspection identified empty optional
tool IDs, hook/unknown operations and missing or parent-only session linkage.
This is partial compatibility evidence, not a fully qualified producer/runtime.
Hook/operation classification is implemented by this refinement; optional tool
IDs, parent-chat relationships and scoped coverage remain tracked in
[#47](https://github.com/toddysm/agent-insights/issues/47),
[#48](https://github.com/toddysm/agent-insights/issues/48) and
[#49](https://github.com/toddysm/agent-insights/issues/49).

Malformed independent records can yield a partial read with valid records
retained. A trailing unfinished record is reported, not silently discarded.
After the writer finishes, choose **Read source** again. Unsupported input without
usable evidence reports unavailable data rather than successful zero totals.
Records without an unambiguous reported session remain unassigned; paths and
timestamps are not used to invent one. Existing capture prerequisites remain
tracked in [#1](https://github.com/toddysm/agent-insights/issues/1).

Production readers are registered by the executable. Trusted embedding/tests may
explicitly supply their own reader list; the server factory alone defaults to
none. All adapters receive bounded bytes and cancellation through the
[reader contract](evidence-contracts.md), not arbitrary filesystem access.
Composite readers receive only their declared, explicitly authorized
file/database roles, not permission to select arbitrary paths.

Read views remain in process memory. Refresh, cancellation and process shutdown
discard the current view. An older operation cannot publish a result after a
newer read or refresh. Source-change metadata is a best-effort observation, not
a claim of an atomic filesystem snapshot. This is not a security sandbox against
a hostile process already running with the same operating-system account.

The published view's `startedAtMs` is the input-capture start, but its
`finishedAtMs` includes adapter processing and validation. It is not the time
through which the harness source was observed. Authenticated status separates
these meanings:

| Field                          | Meaning                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `readTiming.inputStartedAtMs`  | Physical source capture started.                                 |
| `readTiming.inputFinishedAtMs` | Physical source capture finished.                                |
| `readTiming.finishedAtMs`      | Processing finished; equals the published view's `finishedAtMs`. |

Use the two `input*` fields for source observation. Never substitute processing
completion for `inputFinishedAtMs`; if capture timing is unavailable, report it
as unavailable. Source-change checks apply to the capture interval, not later
adapter computation. Low-level adapter results contain provisional assembly
timestamps that the runtime replaces before publishing a read view.
The read deadline also uses a monotonic elapsed-time check before publication:
synchronous parsing cannot publish an overdue result merely because it delayed
the timeout callback. Cancellation cannot preempt JavaScript that is currently
blocking the event loop, but its eventual result is rejected.

File-only reads retain the actual capture operation through descriptor cleanup,
not just the cancellable wait. Cancellation, refresh, shutdown and replacement
therefore cannot release the read barrier while an earlier capture is still
running. Cleanup confirmation is bounded to five seconds; if it times out or
fails, ownership is retained and new reads remain blocked until a cleanup retry
succeeds. A late capture/close failure cannot publish a view or silently clear
that block.

### Shared file and SQLite access

The shared foundation for
[#33](https://github.com/toddysm/agent-insights/issues/33) reads **existing
harness-owned databases in place**. It does not create an Agent Insights database,
replica, archive, synchronization process or saved analysis history. Native Agent
Host conversation/execution readers remain separate work in
[#31](https://github.com/toddysm/agent-insights/issues/31) and
[#32](https://github.com/toddysm/agent-insights/issues/32); this build registers none.

Trusted embedding code can register `multiSourceReaders`. The authenticated
`POST /api/read-set` control selects a registered `readerId` and one
`{ key, sourceId, relativePath }` binding per declared role. The same launch-token,
origin and 8,192-byte request-body checks apply as for `POST /api/read`.
Status exposes role metadata, **not** query/schema declarations. There is no
generic SQL endpoint, automatic source discovery or model call during reading.
A path mentioned inside captured evidence does not authorize another file.

Adapters declare supported `user_version` values, ordinary tables, exact primary
keys, selected columns and named equality queries. Values are bound parameters;
optional JSON field paths are code-owned identifier/index segments. Views,
virtual tables and generated-column tables are rejected. Adapters cannot issue
writes, `ATTACH`, extension-loading commands or arbitrary SQL through this
interface. No producer store constructor, migration or session restoration is used.

Each database runs in the separately prepared, verified **native SQLite helper**,
with existing-only guarded file access, native locking, read-only/query-only
settings, extension loading disabled and temporary storage in memory. Parent
metadata checks alone do not enforce no-create behavior: ordinary read-only
SQLite can recreate sidecars. There is no Node SQLite fallback.
The parent validates the source-free handshake before sending a source grant,
and independently validates frames, request IDs, original row keys, fingerprints
and encoded byte costs. Raw native diagnostics are bounded and never displayed.
This is **not** a Copilot/model process and inherits no provider credentials or
Node.js debugger/preload configuration. Cancellation/deadlines
terminate the owned process and await exit; cleanup failures remain explicit and
block further reads until cleanup is retried. Refresh/cancel and shutdown also
await source cleanup. Replacement reads wait for prior-generation disposal before
acquiring sources; a delayed cleanup failure cannot leave a newer view published.
The process-exit confirmation limit is five seconds.
The composite owner also bounds cleanup confirmation to five seconds. If source
admission, lease verification or descriptor close is still pending, the read
fails with `SOURCE_CLEANUP_FAILED` and retains ownership; refresh, shutdown and
replacement do not wait indefinitely or claim cleanup succeeded. New reads stay
blocked until a cleanup retry confirms those operations settled and descriptors
closed. Cancellation does not forcibly interrupt operating-system filesystem I/O.
Failed descriptor closes are retained by the source-access owner even when
admission failed before a database lease was returned. This also applies to
file captures; such failures cannot become optional-source unavailability.
Source-free artifact lookup is also bounded to five seconds. Cancellation,
deadlines and disposal stop waiting for a stalled lookup without waiting for its
filesystem Promise; any eventual result is discarded and cannot launch a helper.
This does not cancel the underlying operating-system artifact read itself.

Status and the source panel expose `nativeSqlite` availability separately from
source-reader registration and the model executor. No public release pins exist
yet, so normal startup reports native SQLite unavailable pending
[#39](https://github.com/toddysm/agent-insights/issues/39), even if a developer
candidate was built locally. File-only reads and model availability are independent.
Missing, unsupported or tampered native preparation is fatal for a database read,
including an optional role; it never becomes a successful empty result.
Neither startup nor reading builds, downloads, repairs or installs the helper.
Preparation is an explicit separate operation described in the
[native artifact contract](../native/sqlite-guard/ARTIFACTS.md).

| Bound                                                      | Limit                  |
| ---------------------------------------------------------- | ---------------------- |
| Roles per composite read                                   | 1–8                    |
| One database, including existing WAL/SHM/journal sidecars  | 64 MiB total           |
| Combined captured file bytes plus encoded database results | 64 MiB                 |
| Database rows across all queries in one read               | 10,000                 |
| Encoded database results per query and per helper          | 8 MiB                  |
| Tagged parameter values per query                          | 8,192 bytes            |
| Queries per composite read, including empty results        | 256                    |
| Overall read/helper lifetime / native operation            | 30 seconds / 5 seconds |

Database result cost includes canonical tagged values and original key/table/
fingerprint metadata; it is not a promise about total process memory or transport
overhead. Limits reject one-over requests/results rather than truncating them.
Write-ahead logging (WAL) databases retain a connection-wide snapshot.
Rollback-mode databases use bounded transactions per request and release locks
while idle; successive queries may observe different commits. SQLite inputs and
status observations expose `snapshotScope` as `connection` or `request`.
Independently updated files and databases **do not form a global atomic snapshot**.
Status retains per-source observation intervals, admitted versions and detected changes.
Source-specific readers still own identity matching and accounting.

Live WAL databases require their existing WAL and shared-memory (SHM) sidecars.
Missing sidecars and links/replacements fail explicitly. Any retained rollback
journal, including an empty TRUNCATE/PERSIST journal, is reported as
`SQLITE_JOURNAL_PRESENT`, not guessed to require recovery. An actual native
recovery requirement has its separate `SQLITE_RECOVERY_REQUIRED` diagnosis.
Access denial, I/O failure and lock contention are also distinct from malformed
data. Optional ordinary source failures are unavailable inputs; guard, protocol
and cleanup failures reject the entire read. The reader
never changes journal mode, checkpoints, repairs, copies the database or uses
`immutable=true` to bypass live coordination. Read-only SQLite may update
**existing shared-memory coordination bytes**; it does not promise byte-for-byte
immutability of that sidecar. Main/WAL metadata changes reduce coverage, while
SHM coordination changes alone do not. Identity checks are best effort, not an
atomic defense against a hostile same-account replace-and-revert race.

## Copilot configuration and remote processing

The approved first backend is installed Copilot. These startup options record
the requested preferences but do not launch or authenticate Copilot yet:

```bash
npm start -- --source /path/to/capture.jsonl --harness copilot --model MODEL_ID
```

Use `--copilot-path PATH` to select an explicit installed executable. If no model
is requested, the interface displays the harness default;
it does not invent an effective model. Other harness names are rejected rather
than silently substituted.

**A local harness does not mean local model inference.** After acknowledgement,
selected conversation messages and relevant
tool results may be sent to Copilot's remote service. They can contain source
code, private paths or other sensitive material. Provider/account retention,
data-handling and usage limits still apply.

The analysis action requires an explicit acknowledgement before transmission;
source selection and refresh never send capture content to a model. Production
interpretation definitions are still pending, so no analysis action is offered
until a definition and readable session are available.

The application must not persist source payloads or results in a database,
browser storage, history, logs or archives. The Copilot adapter uses bounded
in-memory session storage with tools, unrelated customizations and payload
telemetry disabled. See its [qualification, authentication and limits](copilot-analysis.md).
If the installed version or
enforced policy cannot provide those controls, analysis remains unavailable.
Credentials stay with supported harness authentication; the application must
not copy auth files or silently fall back to another provider.

Provider/cloud decisions are recorded in
[#7](https://github.com/toddysm/agent-insights/issues/7), with integration tracked
in [#15](https://github.com/toddysm/agent-insights/issues/15). The initial
completion/rubric defaults are approved. The transport is implemented; the
individual interpretation definitions remain separate work.

## Errors and validation

- **Missing dependencies or generated CLI:** run
  `npm ci --include=dev --ignore-scripts`, then `npm start`. For an older revision,
  run `npm run build` between those commands.
- **Access required:** reopen the full launch URL; do not put the credential in
  a query parameter or browser storage.
- **Unavailable location:** check the configured path and permissions, then
  restart if it was unavailable at startup or its target/type changed.
- **No reader installed:** the capture format is not implemented in this build;
  no example data or zero-valued report replaces it.
- **Read cancelled / timed out:** retry through the interface. A stale result is
  never attached to a newer read.
- **Database schema, sidecar or recovery error:** use a supported source and let
  the owning harness finish its operation; do not copy/repair it through this app.
- **Source cleanup failed:** retry cancellation/shutdown. A successful view or
  a new read is not substituted while a source owner remains uncleaned.
- **Unexpected failure:** the server reports a diagnostic code, not raw request
  bodies, source text, credentials or exception stacks.

Developer checks:

```bash
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

The application workflow runs Node.js 24 type/unit/integration checks on Ubuntu,
Windows and macOS, plus the real runtime walkthrough in Chromium on Ubuntu.
These checks do not certify every capture format, model, browser or platform
configuration. Capture setup remains the separate guide in
[#1](https://github.com/toddysm/agent-insights/issues/1).
