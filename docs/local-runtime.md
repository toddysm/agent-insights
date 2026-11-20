# Run the local interface

The current runtime implements
[#9](https://github.com/toddysm/agent-insights/issues/9): source configuration,
availability checks, a controlled read boundary and an in-memory reader registry.
It also includes the [Copilot analysis transport](copilot-analysis.md).
It includes the VS Code OpenTelemetry extension file-export reader from
[#10](https://github.com/toddysm/agent-insights/issues/10), Agent Host backend
readers behind their qualified-helper availability gates, and a
[recorded session report](#read-the-session-report). Interpretation definitions
remain separate, unavailable work. The interface states those limitations explicitly. The
[historical prototype](../design/session-insights/README.md) is separate and
continues to use fictional data.

Before configuring captures, follow the
[Agent Host-first capture setup guide](capture-setup.md), including privacy,
runtime-specific settings, verification and the current production-reader gates.

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

### Read the session report

After **Read source** (files up to 64 MiB) or **Open retained session**, use
**Report session (from source read)** to choose among sessions in that read.
For larger supported extension JSONL exports, use the separate
[scan -> session -> report workflow](#scan-large-jsonl-captures-in-place) instead.
The report computes recorded timing, tool
and token metrics locally without a model request. The Agent Host
discovery/combined-reader path is primary; its existing incompatible-helper
gate is not bypassed by report availability. An extension-export report does
not qualify Agent Host support. Empty, unqualified and wrong-runtime reads
show diagnostics rather than sample sessions.

For extension exports, **Direct versus associated evidence** separates direct
membership from explicit `copilot_chat.parent_chat_session_id` relationships.
Metrics use direct members only. Associated calls remain inspectable separately,
with their own reported identities and original relationship field; their usage
is not added to direct totals or to cumulative agent usage. A parent-only call
can say **Direct session membership: unavailable; explicit parent chat: resolved**.
A missing parent says **Parent chat identifier reported, but its session is not
present in this read**; no missing session is created. In a scan, select the
parent session and **Load original evidence** to inspect associated calls;
unassigned evidence also retains calls without direct membership.
Such scans remain partial even if every explicit parent resolves. Before a model
analysis, its acknowledgement counts both direct and associated records and warns
that associated captured content may be directly owned by another session.

Tasks/outcomes, steering, artifacts and prompt coaching show **Not analyzed**.
The source-backed conversation and **Tools & commands** expose retained
messages, full captured multiline arguments/results and original source
anchors. Unknown shell fields remain unavailable; one shell invocation is not
every program inside its command. Captured HTML, commands and URLs are inert
text, never instructions to execute or external links to follow.

Select any metric, including **Unavailable**, to see its definition, coverage,
contributing records and exact original message/tool evidence. Source-only
witnesses show their original locators with an unavailable-content explanation.
Native cumulative/overlay observations remain non-additive and separate from
per-call token totals. **Inspect activity lanes** distinguishes recorded
model/tool/agent/hook spans from unavailable waiting, not-analyzed quiet/idle
and unknown gaps; assistant turns are not fabricated model calls. Only complete,
attributable intervals contributing to the activity calculation appear in its
lanes; excluded wrappers and incomplete tool records remain inspectable as
evidence, not activity.

Tool filtering changes visible invocations, not session totals. The evidence
dialog preserves filters and report scroll, supports full-width detail,
keyboard focus trapping, Escape, Back/Forward and focus return. Closing returns
to the underlying report entry, so Back does not reopen a just-closed drawer.
Fractional timestamps include exact epoch milliseconds alongside the calendar
display. On narrow
screens it fills the viewport. Invalid, foreign or stale links never fall back
to another record. Links identify only a transient read and stop working when
that generation is discarded.

**Read at ... / coverage and sources** shows actual producer/host/version,
read timing and dimension-specific limitations. Read processing completion is
not a physical input-observation bound or proof of a global snapshot. Ask/Agent
mode and the separately configured analysis executor are not source identities.
Refresh or a new selection discards the old report and evidence; reread the
selected sources explicitly to compute fresh metrics. No report history,
source replica, browser storage or correction controls are created.

For extension exports, **Field availability and capture scope** separates
**Retained execution timestamps**, **Chat usage**, **Embedding usage**,
**Session attribution** and **Source/session history**. Complete timestamps
describe retained supported executions only; unknown spans or truncation can still
limit aggregate timing. Chat usage can be complete while embedding usage is
unavailable and the combined token subtotal is partial. Missing tokens are never
zero. Direct membership, explicit parent association and unassigned evidence
remain separate; unassigned usage is not added to a selected session.
Diagnostics identify severity, affected dimensions and source/record/linkage scope.
Missing linkage is not a conflicting identity. These same field-availability
details are available in **Source identity and admitted coverage** for scan reports.

For a directory grant, a reader request must name a relative file inside it.
A regular-file read cannot select neighboring files through a file grant.
For a database, the grant also covers its exact existing `-wal`, `-shm` and
`-journal` companions, subject to the same identity and size checks, not arbitrary
neighboring paths. Traversal, cross-drive paths, links
escaping the canonical grant, and retargeted configured links are rejected.
Only regular files are read, using read-only descriptors. **Read source** retains
the 64 MiB small-capture ceiling; **Scan JSONL source** streams the installed
extension-export format without allocating a file-sized buffer. SQLite main
files and sidecars retain their existing 64 MiB limits. These are separate from
record, metadata and selected-detail budgets below. There are no filesystem watchers.

### Scan large JSONL captures in place

Select the authorized file/directory and `vscode-otel-jsonl`, then choose
**Scan JSONL source**. For a directory grant, keep the relative capture filename.
If **Read source** rejects a file over 64 MiB, **Go to Scan JSONL source** moves
keyboard focus to the existing scan button, preserving the source, relative path
and format. Following that link does not read or scan anything; activate the
scan button explicitly. The failed read produces no partial report and does
not restore a previous report. Do not truncate, split or copy normal captures. The scan
admits the original descriptor's starting byte length, reads 64 KiB chunks and
finishes at that boundary rather than chasing an active writer.
It does not invoke a model or transmit source content.

The interface shows physical-record/category counts and per-pass byte progress.
**complete** means complete for the admitted interval, not proof of complete
session capture. **partial**, **cancelled**, **source-changed**, **budget-exceeded**,
**format-unsupported**, **failed** and **cleanup-failed** are distinct outcomes.
Malformed/oversized independent lines, incomplete trailing writes, conflicting
identities and unassigned executions reduce coverage. A metrics/log-only source
reports telemetry but unavailable execution timing/tools/tokens, **not zero usage**.
Messages/conversation coverage remains separate.

Choose a **Scanned session (discovery and evidence)**, then **Open session report**, without first using
**Read source**. This report uses the same recorded timing, tool and per-call
token definitions as the small-source report, over **all admitted contributing
session records**, not an evidence page or the optional time filter. Unassigned
executions cannot form a session report. Source identity, the admitted byte
boundary, prefix fingerprint and coverage remain inspectable.
Scanning or selecting a session alone does not open a report. Until the explicit
report action, the sidebar explains the read-or-scan prerequisite instead of
requiring another whole-file read. The scanned-session selector is not the
**Report session (from source read)** selector used for small reads.
An empty scan shows **No reportable sessions were found**; unassigned executions
can expose original evidence but cannot form a report. Failed/unsupported scans
show their diagnostic and no report action. Correct the source/format or retry
explicitly after cleanup; no alternative session is selected for you.

The scan-to-report integration is available in this build. It remains limited to
the supported `vscode-otel-jsonl` extension-export format, not SQLite, saved chats,
Agent Debug Log exports or arbitrary JSONL. It does not bypass source grants,
native-helper gates, cancellation/cleanup barriers or report-calculation budgets.

Select any report metric, including **Unavailable**, to page its exact original
physical contributors. Each page replaces the previous one; repeated physical
records are inspectable but never added again. Measured-zero and missing-usage
records are explicitly labeled **coverage witnesses**, not additive
contributions. Tool-name measurements expose the original tool arguments/results
as inert text. Back returns from a record to its current contributor page;
Escape returns focus to the invoking metric. No source corpus enters browser
storage and no model is called.

Choose a **Scanned session** (or **Unassigned executions**), optionally enter
inclusive recorded-start bounds in epoch milliseconds, then **Load original
evidence**. Correlation uses the whole admitted source, including parents outside
the selected time window. Unknown start times are excluded when a time filter
is present. Session and evidence pages replace previous pages rather than adding
an unbounded browser collection. Physical duplicate contributors are evidence,
not extra executions or additive model usage.

Each evidence page reopens the authorized original, verifies file identity and
hashes the complete admitted prefix before publication. This deliberately costs
a rescan per page; progress reports its additional pass/work bytes. Line numbers,
byte offsets/lengths and SHA-256 fingerprints refer to the original physical
record (excluding LF, including CR when present), never a normalized array index.
Append beyond the boundary can be reported separately after continuity checking;
**Rescan JSONL source** creates a new generation to include later bytes. Rotation,
replacement, truncation or changed prefix bytes invalidate evidence. These checks
are best-effort observations, **not an atomic snapshot of a live file**.
Scans, reports and evidence pages rehash after a detected metadata change. A further
change detected at final verification rejects publication with **source-changed**
rather than serving unverified evidence or retrying indefinitely against a writer.
If an evidence read invalidates its scan, the old session catalog, selection and
evidence page are cleared; rescan the source before retrieving evidence again.
Expired completed scans report **budget-exceeded** instead of remaining
publishable. Expiration never claims that an owned detail descriptor was closed.
Catalog pagination also reconciles current authority, so an expired page request
clears cached sessions/evidence and leaves an explicit rescan available.

**Cancel scan** acknowledges cancellation independently of descriptor cleanup.
It clears catalog/detail authority and prevents late publication. New reads remain
blocked behind the owned cleanup barrier. If the five-second cleanup confirmation
fails, use **Retry source cleanup**; an acknowledgement alone never asserts that
the descriptor closed.
Lost scan/catalog responses are reconciled from request-matching status without
automatically rescanning. A start request lost before server admission cannot
restore an older scan's catalog. If status cannot be reached, controls stay locked
while status polling retries; they unlock only after cleanup is confirmed. Detail requests
also reconcile final cleanup, including failed descriptor closure.

| Resource | Current ceiling / behavior |
| --- | --- |
| Physical record | 256 KiB before collection/decoding; excluded independent lines are counted explicitly |
| Retained metadata | 8 MiB of charged metadata (four times serialized bytes plus per-entry overhead), not an exact RSS measurement |
| Native identities | 8,192; exceeding a ceiling returns unavailable totals, never silent eviction |
| Retained references | 32,768; compact metadata retains first anchors, with contributor pages rescanned from the original |
| Catalog/evidence page | At most 20 entries |
| Selected raw detail budget | 512 KiB of original record bytes per page, including whitespace/CR but excluding LF; a record that cannot fit is an explicit budget error |
| Serialized detail response | 1 MiB maximum |
| Report calculation | At most 512 retained execution identities across the admitted source and 128 measurements; over-budget reports are unavailable, never sampled |
| Report transport | Numeric summaries only, at most 1 MiB; original contributors use the existing bounded physical pages |
| Cumulative physical-read work | 8 GiB per generation, including continuity/detail passes |
| Generation lifetime | 15 minutes, checked monotonically; expiration requires an explicit rescan |

These are not a blanket input-size ceiling or an analysis model context allowance.
A single giant session and very many sessions can both exhaust metadata before
the file ends. Such a scan returns **budget-exceeded**, admitted/scanned bounds
and unavailable totals, not a sampled complete catalog. A catalog within scan
budgets can still exceed the stricter report-calculation budget; this is an
explicit **SCAN_BUDGET** report error, not a partial-session success. After
confirmed source cleanup, this calculation-only failure preserves the catalog,
session selection and ordinary evidence pages; it does not change the scan's
complete/partial state. Other resource, source-integrity and cleanup failures
still invalidate the scan.
No persistent cursor,
session index, copied corpus, temporary disk spill or application database exists.
Restarting loses the catalog and requires another scan. Cursors are signed,
generation/selection-bound and expire; using them with another scan/source or
changed time bounds or report metric is rejected. Reports and contributor pages
share the scan's work and lifetime limits; deep enumeration can exhaust work
even when the first pages succeed. **Cancel report operation** acknowledges
cancellation; **Retry source cleanup** retries an unconfirmed cleanup barrier.

Large synthetic scale qualification is separate from real producer compatibility.
Run `npm run qualify:streaming` from a clean committed checkout. Passed receipts
are rejected if the working tree is dirty or HEAD changes during qualification.
The scale path includes whole-session report calculation, exact expected timing
and usage totals, two metric contributor pages and a repeat report, rather than
only scanning. It enforces at most 256 MiB additional peak RSS at 1 GiB and at
most 64 MiB peak-RSS growth from 128 MiB to 1 GiB.
This implementation does not expand the schema mappings described below.
No new private-source inspection or real-capture qualification is implied.
Inspecting a user's real capture still requires a separate authorized manual
smoke test. Synthetic success is not live-producer or Agent Host certification.

### Read an existing execution capture

1. Start with `--source` pointing to an existing VS Code OpenTelemetry file export
   or its authorized parent directory. Do not copy the capture into this project.
2. Open the private launch URL and select the configured source. For a directory,
   enter the relative capture filename.
3. Select `vscode-otel-jsonl`. For a capture up to 64 MiB, choose **Read source**.
   For a larger capture, choose **Scan JSONL source**, select a **Scanned session**,
   then **Open session report** as described [above](#scan-large-jsonl-captures-in-place).
   Do not route a large capture back through **Read source**.
4. For a small read, inspect the observed session/record counts, **Read coverage** and expandable
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
Hook classification, optional tool-ID semantics, parent-chat associations and
evidence-scoped coverage are implemented. Their synthetic validation does not
complete live-producer/runtime qualification. Empty optional tool IDs do not
downgrade valid timing or token fields. Malformed values remain visible errors
for their affected evidence; unknown operations and integrity failures remain
conservative. A valid log/metric/content-event-only file explicitly reports
**Non-execution telemetry was found**, with execution metrics unavailable.
Messages remain unavailable until a qualified conversation reader exists.

Malformed independent records can yield a partial read with valid records
retained. A trailing unfinished record is reported, not silently discarded.
After the writer finishes, choose **Read source** again for a small capture or
**Rescan JSONL source** for the large-file workflow. Unsupported input without
usable evidence reports unavailable data rather than successful zero totals.
Records without an unambiguous reported session remain unassigned; paths and
timestamps are not used to invent one. The
[capture prerequisites and verification guide](capture-setup.md) distinguishes
this extension format from native Agent Host evidence.

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
Host conversation reading now uses this boundary through
[#31](https://github.com/toddysm/agent-insights/issues/31); native execution
accounting remains separate work in [#32](https://github.com/toddysm/agent-insights/issues/32).

Trusted embedding code can register `multiSourceReaders`. The authenticated
`POST /api/read-set` control selects a registered `readerId` and one
`{ key, sourceId, relativePath }` binding per required role. Optional roles may
be omitted: they remain explicitly unavailable and no substitute path is opened.
The same launch-token,
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
source-reader registration and the model executor. This checkout pins only
`native-helper-v0.1.0`; a pin alone does not establish publication or installation.
The release/download qualification record remains
[#39](https://github.com/toddysm/agent-insights/issues/39). Explicitly run
`npm run prepare:native` before database reads. Missing preparation reports
native SQLite unavailable, even if a developer candidate was built locally.
File-only reads and model availability are independent.
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

## Agent Host qualification handoff

The source qualification in
[#30](https://github.com/toddysm/agent-insights/issues/30) supplied the pinned
handoff. The separately authorized
[conversation reader](evidence-contracts.md#agent-host-conversation-reader) now
uses the shared access boundary. The separately authorized
[native execution reader](evidence-contracts.md#agent-host-execution-reader)
adds retained lifecycles and non-additive usage, with the production gate below.
Selecting `vscode-otel-jsonl`, enabling an extension exporter or preparing the
native helper does not add Agent Host support. Ask/Agent mode, running locally
and the Copilot CLI analysis executor do not identify the capture's harness.

### Qualified baseline and source selection

The 2026-11-03 findings pin VS Code **1.145.0**, source commit
`3c0ec3a089398503a462029e7cc2a5749df5169a`, built-in Copilot Chat **0.73.0**
and host SDK package **`1.0.27-unstable.41379698026.g3219c66`**.
One separately authorized no-tools test observed native event format **1**,
catalog schema **22**, session overlay schema **18** and emitted runtime
**`1.0.103-unstable.r41379698026.g3219c66`**. Package and emitted runtime versions
are different pins. These historical observations do not certify today's
installation, other schemas or unimplemented readers. The conversation reader
rejects other native runtime versions and unqualified catalog authority variants.

| Harness-owned source | Selection and purpose |
| --- | --- |
| Host catalog: `<appSettingsHome>/globalStorage/agent-host.db` | Establish the exact current Copilot owner/chat and backing native identity, including runtime-to-storage mappings and archive/tombstone authority. |
| Native history: `<CopilotHome>/session-state/<sdkConversationId>/events.jsonl` | Read retained messages, tool/turn events and their original identities. `CopilotHome` follows the producer's `COPILOT_HOME` override or default `.copilot` home; the directory alone does not establish Agent Host ownership. |
| Host overlay: `<userData>/agentSessionData/<storage-key>/session.db` | Read qualified turn/event bridges and retained usage for the verified chat. Resolve its storage key from authoritative identity metadata, not a guessed UUID. |

These are producer-root placeholders, not literal application arguments or
permission to scan a home directory. Readers must use explicitly granted
roots, verified catalog ownership and the guarded shared boundary; they must not
open producer SDK stores, restore sessions, migrate databases or copy sources.
The [native evidence handoff](evidence-contracts.md#agent-host-native-evidence-handoff)
defines coverage, accounting and original-anchor requirements.

### Discover Agent Host sessions

The **Discover Agent Host sessions** panel is the primary source workflow.
Like native reading, production discovery is **explicitly unavailable** until a
separately qualified compatible helper release is shipped. Preparing a developer
candidate does not remove that gate. The supplemental extension exporter remains
a separate format, not a substitute for Agent Host evidence.

Start with `--source` for every approved location, then select discovery roots
in the panel. Nothing scans the home directory or guesses an operating-system
default. Each root selects a startup grant and a confined relative path:

| Role | Inspected locations |
| --- | --- |
| App settings home | `globalStorage/agent-host.db` and `profiles/<profile>/globalStorage/agent-host.db` under the selected app settings home (normally `User`); no unrelated profile content |
| Exact catalog | One explicitly selected catalog file, including a custom/profile catalog |
| Native history | `events.jsonl` at the selected directory and one child-directory level, or an exact JSONL file |
| Host overlay | `session.db` at the selected directory and one child-directory level, or an exact database |

Use the corresponding per-user/custom roots from the harness configuration;
the analyzer does not derive them from a working directory, SDK branding or
timestamps. Named child links, including session directories and profile
directories, are excluded with explicit `SOURCE_LINK` issues rather than followed
or silently dropped. Directory/file admission still uses
the [approved source boundary](#source-selection-and-limits).
Explicit roots use their admitted file/directory kind, not a filename extension;
extensionless files and directories ending in `.jsonl` or `.db` remain usable.
An absent `profiles` directory means no custom profiles, not a missing selected
settings home. Invalid selected roots and inaccessible existing children remain explicit issues.

**Discover sessions** sends an authenticated `POST /api/discover` with
`{ roots: [{ sourceId, relativePath, layout }] }`. Layout is `settings`,
`catalog`, `history` or `overlay`. **Refresh discovered sessions** repeats that
explicit request, replacing the list and invalidating prior read/analysis.
**Refresh sources** drops the discovery list and current evidence. No watcher,
session database, saved catalog or archive is created.

Discovery verifies the pinned native header and current normalized catalog
ownership. Physical aliases deduplicate; distinct files claiming one SDK identity
and competing profile catalogs stay ambiguous. Distinct SDK backings claiming a
shared runtime/storage chat identity are also ambiguous, preventing one overlay
from being attributed to several sessions. Sharing only a parent session does
not conflict. An overlay is proposed only from
explicit `agentHost.rowOwnerChat` metadata; absent/ambiguous ownership leaves
overlay usage unavailable. Selecting one exact catalog resolves profile scope
without silently choosing a winner. Opening a result reopens and revalidates the
selected sources through `agent-host-sessions`, framing the full native history
and checking catalog ownership once for both conversation and execution readers.
The open request also retains the discovered SDK and host identities: replacing
history or ownership at the same path rejects with `SOURCE_CHANGED`, not another
chat's successful read.
Generated paths also retain their selected `discoveryRoot` in composite controls:
discovery and reopening reject child links, including implicit filenames and
intermediate layout directories. An alias explicitly selected as a file or root
remains allowed within its startup grant; it is not an implicit neighbor scan.
Deduplication identities must match the actual opened history descriptor or
prepared database footprint. Rotation between admission and opening is an
explicit source-change issue, and failed candidates cannot hide another alias.
Overlay assignments become effective only after their catalog read is accepted.

The list separates runtime from mode, execution location and analysis provider.
Unknown mode/location stays unknown. Missing or rotated history, permission errors,
unsupported sources, ambiguous ownership and archived retention are explicit;
they never become a successful empty session. Each response includes read-time
bounds, original references, per-input observations and a transient `locators`
map from every evidence source ID to its approved grant/relative path, including
ambiguous or unavailable selections. Unmatched overlays remain explicit issues.
These are not live verification.

Discovery accepts at most 16 root selections, 256 entries in a directory,
64 candidate files and 64 chat rows per catalog, and a 256-KiB first-line header.
Shared SQLite/query limits and the runtime deadline also apply. Limits reject,
never silently truncate. Generated reopen controls must fit the same 8-KiB
transport limit as submitted controls; oversized identities/paths reject discovery
before a ready selection can be published. Large stores require narrower selections; integrated
producer-generated and cross-platform qualification remains separate from the
synthetic discovery tests.
Native cleanup failures abort discovery, not just the affected source, even if a
subsequent cleanup retry confirms resource release.
Only expected source-admission failures become per-source issues. Native protocol,
guard, cleanup and budget failures reject the generation. SQLite aliases deduplicate
only when their admitted main and sidecar identities match; hard-linked main files
with independent WAL/SHM files remain separate competing catalogs.
If the native engine rejects a hard-linked database as requiring recovery, that
location remains explicitly unavailable; any separately admitted catalog remains
usable rather than either location silently hiding the other.

Within one catalog connection, discovery reuses bounded chat/metadata projections
for exact-key and first-JSON-member lookups, including whitespace, escaping and
duplicate keys. JSON depth follows native admission; unsupported bindings retain
native validation.
Native predicate matching alone does not establish ownership: the decoded
provider backing must also match the SDK. A first/last duplicate-member mismatch
remains unqualified; lookup indexes do not relax reader admission.
Original row witnesses and shared row/byte/query limits remain intact.
JSON-BLOB rows and NUL-terminated JSON prefixes route their affected bindings
through native predicates instead of being silently excluded or disabling all
text indexes. Unrelated lookups stay indexed; unsupported or competing ownership
still fails closed.
Cached bindings retain the shared encoded-size limit. An optional overlay removed
after discovery becomes an explicit unavailable input on open; generated links
and scope violations still reject.
This lookup state is discarded after discovery, not a copied application catalog.

### Agent Host execution availability

The executable registers `agent-host-executions` but reports `available: false`
and an incompatibility reason in authenticated `/api/status`. Selection through
`POST /api/read-set` returns `READER_UNAVAILABLE` (501) **before opening sources**.
The pinned `native-helper-v0.1.0` lacks the guarded catalog predicates. Neither
preparing that release nor preparing a development candidate enables this gate.
A compatible helper release needs separate publication/qualification approval
and a reviewed registry update; the analyzer never builds/downloads a replacement
during reads. The existing extension reader remains independently available.

Trusted qualification embeddings with an explicitly registered ungated reader
and verified candidate use:

```json
{
  "readerId": "agent-host-executions",
  "sources": [
    { "key": "history", "sourceId": "source-1", "relativePath": "events.jsonl" },
    { "key": "catalog", "sourceId": "source-2", "relativePath": "agent-host.db" },
    { "key": "overlay", "sourceId": "source-3", "relativePath": "session.db" }
  ]
}
```

These are illustrative grant IDs from authenticated status, not captured paths.
Required roles need explicit bindings; an omitted or missing optional overlay leaves host
usage unavailable while retained native executions can still be read. Use an
empty relative path for a file grant. The catalog and present usage overlay need
connection-scoped snapshots with existing readable WAL/SHM sidecars. Do not change
producer journal settings, create missing sidecars or guess a storage key to make
a read succeed. Source identity changes, unsupported schemas, budgets, permission
failures and cancellation remain explicit, with no copied-source fallback.

Supported pins and retention ceilings match the qualified native conversation
baseline; overlay support is limited to schema 18 and exact retained root
user-event/host-turn bridges. See the [execution field and accounting contract](evidence-contracts.md#agent-host-execution-reader).
Assistant turns are not model calls. Output-only, whole/direct-turn and shutdown
usage observations are non-additive; complete per-call token usage/timing remains
unavailable without separately qualified telemetry. No source read invokes a model
or executes captured arguments/results. These synthetic tests do not replace the
producer-generated integrated workflow in #20 or complete guides #1/#21.

### Read a qualified native conversation

**Production availability:** this backend reader is implemented but gated out of
the executable's registry. The selected `native-helper-v0.1.0` does not support
the required guarded JSON and literal-prefix predicates. Until a separately
authorized, qualified helper release and reviewed registration update land,
`/api/status` does not advertise `agent-host-conversations` and `/api/read-set`
rejects that selection with `READER_UNAVAILABLE`. Preparing a development candidate
does not enable it or replace the production resolver.

The following contract applies to trusted embeddings and qualification tests
that explicitly register the reader with a verified compatible helper:

Start with explicit grants to the selected native-history and catalog files (or
their authorized containing directories), following the existing `--source`
controls. Prepare a verified native helper through the documented
[artifact workflow](../native/sqlite-guard/ARTIFACTS.md); the runtime never builds,
downloads or substitutes an unguarded database reader during a read.
Native artifact publication requires separate release authorization, as in #39;
that completed release does not provide this reader's required predicates.
Catalog ownership needs a connection-scoped snapshot (the shared boundary's WAL
mode with existing readable sidecars). Per-request/rollback-mode catalogs are
reported unavailable; do not change producer journal settings or create sidecars
to make a read succeed.

With that explicit registration, authenticated `/api/status` advertises `agent-host-conversations` in
`multiSourceReaders`. Send an authenticated `POST /api/read-set` using the existing
launch-token and origin controls, with this shape (grant IDs come from status,
not from captured paths):

```json
{
  "readerId": "agent-host-conversations",
  "sources": [
    { "key": "history", "sourceId": "source-1", "relativePath": "events.jsonl" },
    { "key": "catalog", "sourceId": "source-2", "relativePath": "agent-host.db" }
  ]
}
```

For file grants use an empty `relativePath`; directory grants use a contained
relative path. Both role bindings are required. The roles permit explicit
unavailability, but a missing input cannot establish a conversation and is never
reported as a successful empty transcript. Unsupported schemas/pins, denied
access and missing native preparation remain explicit errors or limitations.
The read does not require the session overlay, optional telemetry or a model.

Native history additionally permits at most 256 KiB per physical record
(excluding LF), 8 MiB total bytes including framing/blanks, 8,192 distinct event
IDs (including malformed envelopes), and 32,768 physical records (including
replays, malformed lines and blanks). Crossing a limit returns `READ_LIMIT`
(413) and clears the previous view; no truncated transcript is published.

The backend implementation does not add automatic native-source discovery or a
new report UI. The current single-file extension/scan controls are not native
conversation selectors. #12 owns source discovery/correlation, #14 owns report
drill-down and #20 owns integrated producer verification. Use original anchors
only within their current read generation; refresh discards the previous view.
Results are in memory only. Do not copy private content into saved reports or
send it to analysis merely to verify a read.

### Retained history versus optional telemetry

Native history does not require enabling telemetry. The selected test retained
its expected exchange and a matching host turn-usage row, but no per-call usage
records; missing per-call input tokens are **unavailable**, not zero.

Optional prospective capture uses `chat.agentHost.otel.*`, not
`github.copilot.chat.otel.*`. The inspected settings are `enabled`,
`exporterType`, `outfile`, `captureContent` and `dbSpanExporter.enabled` under that
host namespace. Personal changes require a **full VS Code application restart**;
Reload Window may leave the shared host running. Respect effective managed
policy and inherited destinations; do not override them or enable extra
destinations merely to satisfy the analyzer.

Effective routing, restart/export behavior and genuine per-call capture still
need qualification in [#34](https://github.com/toddysm/agent-insights/issues/34).
Content capture can expose prompts, code and tool data. It requires its own
informed authorization, not automatic enablement. An enabled exporter, existing
file or empty trace is not proof of capture, and telemetry is not retroactive.

### Controlled smoke procedure for later delivery

This is a handoff for capture guide
[#1](https://github.com/toddysm/agent-insights/issues/1), usage guide
[#21](https://github.com/toddysm/agent-insights/issues/21) and integrated delivery
[#20](https://github.com/toddysm/agent-insights/issues/20), not a claim that the
current interface can perform the native read:

1. Obtain explicit permission for one selected harmless Agent Host test and its
   exact catalog/native/overlay sources. Prefer an existing test. Generating a
   new no-tools echo exchange is normal harness inference, potentially remote;
   obtain separate permission and request no project edits or commands.
2. Verify producer/schema pins and the exact host owner/chat/backing mapping.
   Missing source, empty source, wrong harness/destination and unsupported
   schema are distinct failures, not successful zero-valued reports.
3. Use bounded guarded reads in place. Check the known exchange, original
   anchors and any retained turn/usage linkage. Do not follow captured paths,
   execute captured instructions, upload content or invoke analysis.
4. Compare native history, database and WAL fingerprints/metadata before/after,
   report detected changes and preserve observation intervals. Existing SHM
   coordination bytes may change; do not promise physical sidecar immutability
   or an atomic snapshot across sources.
5. Publish only sanitized counts, booleans, version pins and limitations, never
   private identifiers, paths, prompts, credentials or exact usage values.
   Separate static inspection, synthetic tests and actual producer evidence.

The historical selected test did not cover tools, optional telemetry, broad
migration variants or production adapters. This documentation handoff performs
no new private read, settings change, capture or model request and does not
authorize reader implementation.

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
- **The source exceeds the 64 MiB read limit:** for a supported
  `vscode-otel-jsonl` export, follow **Go to Scan JSONL source**, explicitly
  activate the scan button, select a **Scanned session**, then **Open session
  report**. Selection is preserved; nothing is scanned automatically. Original
  evidence pages are not a complete report. Other formats/SQLite retain their
  safety limits; changing a reader label does not convert an unsupported capture.
- **Scan complete but no report is open:** select a reportable **Scanned session**
  and choose **Open session report**. Empty catalogs and unassigned executions
  cannot form a report. Check scan diagnostics rather than retrying a large
  whole-file read; failed scans never restore a stale report.
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

For the oversized-read recovery, scan outcomes and unchanged small-read flow,
run `npm run test:browser -- tests/browser/scanned-report.spec.mjs tests/browser/streaming.spec.mjs tests/browser/execution-reader.spec.mjs`.
These browser tests use only owned synthetic captures; the large recovery case
actually exceeds 64 MiB and follows the recovery link with the keyboard.
The existing runtime boundary test separately checks exactly 64 MiB versus one
additional byte. These suites are included in the existing application CI.

The application workflow runs Node.js 24 type/unit/integration checks on Ubuntu,
Windows and macOS, plus the real runtime walkthrough in Chromium on Ubuntu.
These checks do not certify every capture format, model, browser or platform
configuration. Capture setup remains the separate guide in
[#1](https://github.com/toddysm/agent-insights/issues/1).
