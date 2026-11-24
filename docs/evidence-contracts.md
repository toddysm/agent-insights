# In-memory evidence contracts

This is the reader/calculator boundary for
[#8](https://github.com/toddysm/agent-insights/issues/8), not a working analyzer.
[Contracts](../src/evidence/contracts.ts) contain no filesystem, database,
network, model or persistence operations. Their validated objects are immutable
in-memory views; they must never be serialized into an application session store.

## Read generations and provenance

The authenticated `POST /api/report` control accepts only the current `readId`
and an attributed `sessionId`. It invokes the pure
[recorded calculator](../src/metrics/recorded.ts) through the
[report adapter](../src/runtime/report.ts); no source access, inference or report
cache occurs. Invalid controls fail, foreign sessions return unavailable, and
missing/replaced reads are stale rather than restored from history. The shared
[report schema](../src/metrics/report.ts) carries exact metric provenance,
definitions, coverage, scope, exact contributing normalized event IDs and
non-additive observation labels to the browser. Contributor IDs identify the
calculator's actual groups (including replay IDs), not every event in the
selection scope. Original-content panels require both a contributing ID and
full original-locator identity within the current read/session. Sharing an
anchor does not make another event a contributor; unmatched source witnesses
never resolve by record proximity or colliding native IDs. Source witnesses
remain visible when they overlap a noncontributing event's locator, including
session evidence supporting a measured zero tool count.

Native report tests compose the real combined Agent Host reader, calculator and
browser with independently authored history/catalog projections. Browser
transport shims are explicitly not released-helper qualification. The native
source-access suite separately runs guarded catalog/history/overlay discovery,
combined reads and exact report anchors with the verified candidate. Neither
synthetic coverage nor reporting removes the production helper-release gate.

- Every read has an independent `id`, source metadata, sessions, events and visible
  issues. In runtime-published views, `startedAtMs` is input-capture start and
  `finishedAtMs` is processing completion, including adapter work and validation.
  The separate `readTiming.inputStartedAtMs`/`inputFinishedAtMs` values describe
  physical source observation; processing completion is not an observation bound.
  Direct adapter results have only provisional assembly timestamps because
  `ReaderInput` does not carry filesystem capture timing.
- At least one source must be retained, including for unavailable or unsupported
  input; a completely empty view must not disguise a failed read.
- Timestamps are Unix milliseconds. Durations use milliseconds, including
  fractional milliseconds. Tokens/counts are nonnegative safe integers.
  Readers convert producer units, preserving original record locators.
- Source and normalized event/session IDs are separate from reported native IDs.
  Native IDs, timestamps, text and usage can be `null`; do not manufacture them.
  IDs are namespaced within the current read, not a persistent catalog.
- JSON references use a JSON Pointer; JSON Lines references also use a 1-based
  line number. One reconstructed event can retain multiple original references.
  Source instruction identities remain independent of inferred task segments.
- SQLite references retain the authorized source, table, typed original primary
  key, captured column (or whole projection), JSON Pointer within that column
  when applicable, and a SHA-256 fingerprint of the captured projection.
  Integers remain exact decimal key strings; row position is never identity.
  The composite runtime checks row/key/fingerprint and selected-column membership
  against rows actually returned in that generation. Structured-value pointer
  meaning remains the domain reader's responsibility.
- Parent native IDs may refer outside the captured read. This is not permission
  to invent an absent parent or count a wrapper as an extra model call.
- Coverage is complete, partial with a reason, or unavailable with a reason.
  It describes the bounded evidence read, not all historical session activity.
- An unknown source format is `null`, not a guessed adapter identity; all its
  coverage dimensions must remain unavailable.
- `changedDuringRead: false` means no change was detected by the reader's checks,
  not an atomic-snapshot guarantee. `null` means unverified. A detected change
  requires reduced coverage and a `source-changed` issue. Conversely, that issue
  requires the flag to be `true`, not `false` or unverified. Refresh creates a new
  read generation; late results for the previous generation are not current.

`parseReadView` validates normalized structure and reference relationships;
it rejects invalid input rather than repairing it. It does not prove a producer's
claims, reconstruct transcripts, correlate sessions or detect format compatibility.
Unknown producer properties and incomplete input must be handled explicitly by
source readers, not disguised as successful empty data.

## Initial reader targets and evidence limits

The execution reader now implements the first target; both conversation targets
remain pending in [#11](https://github.com/toddysm/agent-insights/issues/11).
Producer definitions were inspected at Visual Studio Code commit
`2c33b50b16c472efe58357d1d2a8a5414bc23fbf` (1.144.0).
The fixtures are independently authored fictional data; no source implementation
or private capture was copied. A fresh user-reported smoke test retained execution
records with partial coverage; a separately authorized fixed-prefix structural
inspection identified the follow-ups in
[#46](https://github.com/toddysm/agent-insights/issues/46),
[#47](https://github.com/toddysm/agent-insights/issues/47),
[#48](https://github.com/toddysm/agent-insights/issues/48) and
[#49](https://github.com/toddysm/agent-insights/issues/49).
The user's producer version and execution runtime remain unconfirmed; this
does not certify every VS Code version or claim Agent Host reader support.

| Target                        | Producer evidence                                                                                                                                                                                                                                                                                                                            | Available fields / limitations                                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vscode-otel-jsonl`           | [Extension file exporter](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/extensions/copilot/src/platform/otel/node/fileExporters.ts)                                                                                                                                                                      | Span IDs, parent context, attributes and second/nanosecond time tuples. The exporter also writes log/metric records; these are not extra spans. Usage/content depend on actual attributes and effective capture settings.          |
| `vscode-chat-v3-json`         | [Serialized chat model](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/src/vs/workbench/contrib/chat/common/model/chatModel.ts)                                                                                                                                                                           | Session ID, creation date and ordered requests with request IDs, text/parsed messages and response parts. Request timestamps are optional. A bare chat export is not necessarily a version-3 saved session.                        |
| `vscode-chat-mutations-jsonl` | [Mutation envelopes](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts), [session storage](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/src/vs/workbench/contrib/chat/common/model/chatSessionStore.ts) | Initial state (`kind: 0`), property replacement (1), array append/truncate (2), deletion (3). A line is an operation, not a complete message. Truncated tails, conflicting operations and unknown kinds require explicit handling. |

Agent Debug Logs, OpenTelemetry Protocol (OTLP) exports, native software
development kit records and extension file-export JSON Lines are not interchangeable.
No Agent Debug Log, OTLP, native-record, index-database, older-version or unknown
schema support is claimed by this contract work. Additional verified adapters
can extend the format identifiers without introducing a copied dataset.

The shared access foundation additionally declares `copilot-sdk-events-jsonl`,
`vscode-agenthost-catalog-sqlite` and `vscode-agenthost-session-sqlite`.
The conversation adapter below uses the first two; session-overlay execution
accounting remains pending in [#32](https://github.com/toddysm/agent-insights/issues/32).
Declaring an identifier does not qualify all producer versions. Native qualification is tracked in
[#30](https://github.com/toddysm/agent-insights/issues/30); it is distinct from the
Local/extension targets above.

The [source fixtures](../tests/fixtures/) include span nesting/cumulative-usage
hazards, version-3 chat, mutation envelopes, an intentionally truncated tail and
an unknown schema. The [normalized fixture](../tests/fixtures/read-view.ts) and
[tests](../tests/contracts.test.ts) exercise partial, unavailable, changing and
complementary-source views. Structural fixture checks are not live-producer or
platform certification.

### Agent Host native evidence handoff

[#30](https://github.com/toddysm/agent-insights/issues/30) records the source
qualification and pinned producer evidence. Its native-history-first design
feeds execution [#32](https://github.com/toddysm/agent-insights/issues/32) and
conversation [#31](https://github.com/toddysm/agent-insights/issues/31).
The conversation adapter is now installed as a separately authorized build;
the qualification handoff itself did not authorize implementation. The separately
authorized execution build is described [below](#agent-host-execution-reader).
The merged [shared access boundary](local-runtime.md#shared-file-and-sqlite-access)
supplies guards, bounded queries and provenance, not these domain mappings.

| Declared input identifier | Qualified baseline / reader obligation |
| --- | --- |
| `copilot-sdk-events-jsonl` | Observed format 1; retain event `id`, `parentId`, timestamp, type/data and applicable `agentId`. Require the actual session-start identity/version/producer, not a directory-name guess. Shared SDK history alone does not identify an Agent Host session. |
| `vscode-agenthost-catalog-sqlite` | Observed schema 22; resolve current authoritative `sessions_v2`/`chats_v2` ownership, provider backing, runtime/storage mappings and tombstones. Do not union compatibility mirrors as additional chats. |
| `vscode-agenthost-session-sqlite` | Observed schema 18; use the verified storage identity and exact `turns.id`/`event_id` bridge for retained `turn_usage`. A stored report is not an append-only per-call ledger. |

The [version pins and controlled verification procedure](local-runtime.md#agent-host-qualification-handoff)
describe one selected source on the inspected VS Code build. They are required
version/structure guard and regression-fixture inputs for future readers, not
blanket support for all records with those version numbers. Unsupported or
conflicting schema/identity evidence must be explicit, not sent to the
Local/extension parser as a fallback.

| Evidence | Coverage and accounting boundary |
| --- | --- |
| Retained native messages | Preserve submitted content, event/chunk identity and original anchors. User-message records may be automatic, subagent or scaffolded traffic; captured flags and qualified mappings, not repeated text, determine classification. Model-submitted content is not necessarily exact typed text. |
| Native tool/turn events | Pair tools only by qualified native call identity within scope; missing starts/completions stay incomplete. Event `parentId` is a graph edge, not a task, and an assistant turn is not a model call. |
| Assistant `outputTokens` | Optional output-only observations require `apiCallId`/chunk-aware handling. They do not reconstruct missing input consumption or establish a complete call ledger. |
| Retained host turn usage | Replacement semantics retain the latest report. `_meta.turnTokenTotals` includes descendants/compaction; `directTurnTokenTotals` excludes descendants. These overlap and must not be added together. Top-level `inputTokens` may describe the latest call/context, not total consumption. |
| Native shutdown usage | A session aggregate snapshot, not another additive set of per-call contributions. Missing shutdown is unavailable, not zero. |
| Per-model-call timing and complete input/output usage | Not established by native history: inspected `assistant.usage` and `model.call_*` records are ephemeral. Prospective trace formats/routing remain unqualified in [#34](https://github.com/toddysm/agent-insights/issues/34). |

The host skips child-chat usage persistence because parent costs already
include descendants. Preserve accounting scope and reported/absent status;
do not sum overlapping parent/child, whole/direct-turn or shutdown observations.
Compaction/context-truncation notifications alone do not prove physical log
deletion. Preserve missing content/timestamps, interrupted history, unresolved
parents and ambiguities without inventing a complete transcript.

Every normalized fact needs the original JSONL line/pointer or SQLite
table/key/column/JSON-pointer/projection fingerprint, retaining multiple anchors
when a fact joins sources. Host session/chat addresses, storage identities,
native SDK conversations, events, calls and subagents are distinct namespaces;
do not flatten them or infer matches from text, timing or filenames.

Optional `vscode-agenthost-otel-sqlite` and native/host trace JSONL adapters are
not shipped or qualified. The inspected host completed-span forwarder uses
millisecond scalar timestamps and `parentSpanId`; the extension exporter uses
second/nanosecond tuples and `parentSpanContext`. Pass-through native output can
differ again. Do not reuse a wire parser on the assumption of a shared SDK.
Agent Debug adapter [#27](https://github.com/toddysm/agent-insights/issues/27)
remains deferred, not a required source for the selected native-first baseline.
Local saved-chat [#11](https://github.com/toddysm/agent-insights/issues/11) remains
supplemental; the now-merged extension reader does not establish native support.

Validation in #30 was 18 historical static assertions and one explicitly
authorized no-tools native-source inspection, not product-reader tests.
Future adapters require independently authored synthetic fixtures for the
qualified mappings, unsupported/conflicting/missing input, chunk/replay identity,
accounting overlap, original anchors and cancellation/source changes.
[#20](https://github.com/toddysm/agent-insights/issues/20) still owns integrated
producer-generated verification; optional telemetry is not a native prerequisite.

### Agent Host discovery and combined reads

Manual [source discovery](local-runtime.md#discover-agent-host-sessions) produces
a transient list, not a `ReadView`, persisted session catalog or analysis result.
Only explicitly selected configured grants/layouts are inspected. Initial
`--source` locations and explicitly UI-added current-run locations share the same
read-only containment, identity, resource and qualified-reader boundaries.
Authenticated `POST /api/locations/add` accepts `{ path, kind }`, with `kind`
`file` or `directory`, and requires the same literal-loopback Origin and launch
credential as existing controls. It validates an existing absolute local path
and returns `{ sourceId, status }`; no file bytes, uploads, SQL, home-directory
inference or persisted location catalog are involved. Canonical admissions are
serialized and deduplicated under the shared 32-location ceiling. Admission
stages cleanup and status inspection before committing a new grant, then
revalidates its path/identity. Cancellation governs the entire operation:
unfinished cleanup remains runtime-owned, but a rejected addition does not
authorize a new location. Unavailable old aliases cannot veto admission of a
separately validated path or be silently rebound. Final revalidation checks
matching grants for a surviving reusable binding before allocating another
slot, including at capacity. The response carries all
alias availability failures observed during final revalidation, rather than
reusing its earlier availability snapshot. Search and reading still require
separate actions.
The bounded
`discovery_chats` projection uses the same schema-22 definition and ownership
resolver as native reading; paths and shared SDK branding do not establish
runtime identity.

The first native physical line must satisfy the pinned format/runtime guard.
Its exact SDK identity must have one authoritative catalog backing and one
distinct admitted history. Physical aliases are deduplicated; independent
catalogs and duplicate histories do not merge on timestamps, filenames or text.
Overlay discovery requires explicit unique chat-owner metadata and still
revalidates every turn/event bridge during reading. Missing overlay ownership
does not exclude independently retained native conversation/execution evidence.

The `agent-host-sessions` composite adapter frames the full native input once,
resolves ownership once, then reuses those same-generation inputs for conversation
and execution normalization. Both dimensions keep their original references,
distinct event identities and partial/unavailable coverage; usage scopes are
not summed during composition. An omitted optional role has an explicit
unavailable input/observation, never a guessed neighboring path.

Discovery/combined reading is registered with the existing incompatible-helper
gate. Synthetic qualification explicitly installs the adapter with a verified
candidate; it does not enable production access or certify live producer data.

### Agent Host conversation reader

The implemented `agent-host-conversations` reader is **gated out of the production
registry**: the pinned `native-helper-v0.1.0` lacks the guarded JSON and
literal-prefix predicates it requires. A separately authorized, qualified helper
release and reviewed production registration change are required to enable it.
Preparing a development candidate does not enable the production reader.
Qualification tests explicitly register the reader with a verified candidate.
The reader borrows
two explicitly authorized inputs through #33: `history` (`copilot-sdk-events-jsonl`)
and `catalog` (`vscode-agenthost-catalog-sqlite`). It never opens a path from
captured content, invokes producer restoration/migration APIs, calls a model or
persists a transcript. Local saved-chat #11 remains a separate, unmodified contract.
Native execution accounting and session overlay usage remain #32's responsibility.

Native history has separate retention ceilings: 256 KiB per physical record
(excluding LF), 8 MiB cumulative bytes (including framing and blanks), 8,192
distinct event IDs and 32,768 physical records. IDs in malformed envelopes consume the
identity budget; exact replays, malformed lines and blanks consume the physical
record budget. Exceeding any ceiling rejects the whole read with `READ_LIMIT`
(413), never a truncated transcript or partially published view.

Support is intentionally limited to the qualified baseline:

- One retained format-1 `session.start`, first among valid native envelopes,
  producer `copilot-agent`, emitted runtime
  `1.0.103-unstable.r41379698026.g3219c66` and a reported SDK session ID.
  Other runtimes require qualification, even when they reuse format number 1.
  The event fields were checked against the public SDK package
  `1.0.27-unstable.41379698026.g3219c66`, whose archive integrity matched its
  published SHA-512. This is schema inspection, not a new live-source test.
- Catalog schema 22, one live `chats_v2` row with the exact
  `provider_data.sdkSessionId`, or an absent backing blob with an explicit
  session-backed `storage_resource` matching the pinned canonical session URI.
  The latter mapping supports unreserved raw SDK IDs, not inferred filename IDs
  or a role guessed from the chat URI. Both paths require a verified `copilotcli` owner, normalized
  authority 2, matching owner/catalog generations, and equal catalog/projected
  revisions. Returned owner/authority keys must exactly match the selected owner,
  even when a catalog declares case-insensitive key collations.
  Authority flags and revisions require SQLite INTEGER cells; exact-valued REAL
  cells are not accepted as integer authority.
  Legacy authority, stale projections, conflicting live owners,
  provider overrides, malformed deletion flags, provisional/hidden/deleted owners and malformed identity
  mappings are unavailable, not guessed or repaired. Archived retained chats
  remain readable and retain their archive flag.
  Deletion/provisional metadata must contain canonical `true`/`false` text when
  present; malformed status is indeterminate, not an inactive flag.
- Ownership requires the shared boundary's `connection` snapshot scope across
  all catalog queries. Per-request/rollback-mode snapshots are unavailable:
  combining their rows could qualify ownership that never existed in one commit.
  The reader does not alter journal mode or create missing WAL/SHM sidecars.
- `sessions_v2`, `session_chat_catalogs`, `chats_v2` and scoped `metadata`
  projections establish identity. Reverse identity lookups filter both the
  session/chat mapping-key namespace and JSON `storage` by the selected owner/chat;
  suppression and provider overrides use exact
  metadata keys for stored and runtime identities. Returned metadata keys are
  checked exactly even when schema collations permit case-insensitive matches.
  Unrelated metadata is not
  returned or charged against result budgets. Guarded JSON predicates treat
  malformed JSON as nonmatching, never a null match or a query-wide parse error.
  Explicit
  `sessionStorageIdentity:`/`chatStorageIdentity:` mappings preserve runtime and
  storage namespaces. Each returned mapping must also parse to the selected
  storage identity; disagreement between SQLite extraction and JSON parsing
  cannot silently trigger stored-identity fallback.
  The stored chat identity is `chats_v2.chat_uri`, not its
  `storage_resource` backing (which may identify an SDK session).
  Stored-identity fallback requires both an absent reverse mapping and an absent
  exact forward mapping key; malformed or conflicting forward mappings remain
  unavailable with their original row witnesses.
  Compatibility mirrors are not unioned as additional chats.
  Schema/access/query failures remain controlled runtime failures.
  Matching rows still share the boundary's 10,000-row/8-MiB result budgets;
  excessive relevant mappings fail explicitly with `SQLITE_LIMIT`, never
  truncation or arbitrary owner selection. Reverse lookups may scan the catalog
  and remain subject to the existing query deadline and source-size limit.

`message.text` preserves native `user.message.data.content` verbatim, including an
empty submission. Optional `transformedContent` remains separate; no scaffold
stripping is presented as proof of the user's exact keystrokes. Missing/invalid
content or timestamps remain null with diagnostics. Calendar-invalid dates are
not normalized into another day; valid ISO fractions and explicit timezone offsets
retain millisecond timestamps. `nativeMessage` retains reported message, interaction,
originating-message, request/client-request/service-request,
turn, API-call, chunk and agent/tool/task-parent identities, `source`, `delivery`, `agentMode`, autopilot and
ephemeral flags. Omission stays null, not false.

Human attribution follows the pinned submitted-message semantics, not message
text, timing or task inference. Automatic/source-injected and autopilot traffic,
subagent activity and malformed attribution receive no `instructionId`. A
`user.message` with `delivery: queued` is already consumed/submitted; a
`pending_messages.modified` snapshot or draft is not a new instruction.
Tool results, system/internal messages and lifecycle events are not human messages.
Captured steering delivery is retained without inferring task purpose.

Original instruction IDs are SDK-session scoped and distinguish logical
`messageId` from a fallback envelope ID. Exact event/logical-message replays retain
all original anchors but contribute once. Logical replays may differ only in
envelope event ID; conflicting timestamps, predecessors or other envelope facts
are excluded rather than selecting the first captured value. Malformed agent
identities cannot create separate deduplication namespaces for the same message.
Repeated text with different identities
remains distinct. Conflicting identities are excluded with anchored diagnostics,
not repaired into multiple human instructions. A malformed envelope sharing a
valid event ID invalidates that identity in either ordering, including logical
replays under another envelope ID.
Captured physical order is retained;
timestamps never reorder submissions.

Authoritative `assistant.message` records supersede ephemeral starts/deltas.
Interrupted streams without a final message are anchored limitations, never
invented completed responses. Split responses retain `apiCallId`, `chunkIndex`
and `chunkCount` as `response-part` records; they are not independent whole
utterances or model calls. Even malformed captured ordinals remain response parts,
not whole messages. Unexpected assistant chunk fields on user submissions are
diagnosed without changing human attribution or whole-submission status.
Missing/conflicting chunks are explicit. This reader
does not sum output tokens or reconstruct missing per-call input usage.

Each fact retains original JSONL line/byte coordinates and a parseable record's SHA-256, or
SQLite table, typed primary key and projection fingerprint through the shared
reference helper. Session provenance also retains the catalog rows establishing
ownership. Host runtime/chat/storage and SDK session namespaces remain distinct.
Malformed lines retain their physical coordinates without inventing a parsed-record hash.
Malformed reported detached-session parent IDs remain null with an anchored
diagnostic rather than silently becoming omitted parents.
Reported detached-session parents, host parent chats, origin owners and agent IDs
are preserved without inventing parent sessions, flattening subagents or joining
execution evidence by equal text, filenames or timing.

Message coverage is always **partial, retained native log only**: current model
context and lost historical branches cannot be established from the file.
Compaction/context-truncation/rewind notices do not prove physical log deletion
or recover deleted records. Missing start, unsupported source, missing catalog
or ambiguous ownership means unavailable conversation coverage and no normalized
session. Timing/tool/token coverage is unavailable for this conversation adapter.

Synthetic tests cover replay/conflict, original anchors, flags, pending versus
submitted messages, split/interrupted responses, missing fields, unsupported
schemas, cancellation and ownership. The native qualification job additionally
uses the real guard on owned synthetic databases, verifies source bytes/no new
files and refresh invalidation. An ordinary run without a prepared candidate
explicitly skips that integration case; it is not a native qualification pass.
Producer-generated end-to-end verification remains #20, not a claim made by
these synthetic tests.

### Agent Host execution reader

`agent-host-executions` consumes explicitly bound `history`, `catalog` and `overlay`
roles through the shared access boundary. The optional overlay may be omitted or
point to a missing input; no source is discovered
or opened from captured content. It shares #31's bounded native framing,
format-1/emitted-runtime pin and schema-22 catalog authority checks. Schema-18
overlay projections are separate from the catalog. There is no extension-parser,
SDK restoration, database migration or source-copy fallback.

The executable **registers but disables** this adapter. Authenticated status lists
`available: false` and a fixed reason: the pinned `native-helper-v0.1.0` lacks the
guarded JSON/literal-prefix predicates required for catalog authority. Read-set
selection returns `READER_UNAVAILABLE` before source admission. A separately
authorized, qualified helper release and reviewed removal of the registry gate
are required for production use; candidate preparation cannot override the gate.
Trusted qualification tests explicitly install the ungated adapter and a verified
candidate, never a browser-selected executable.

| Normalized evidence | Meaning and accounting |
| --- | --- |
| `tool-call` | Pair recorded start/completion by native call ID within SDK session and envelope-agent scope, independent of interleaving/order. Missing boundaries stay partial with null times; missing/invalid `success` is unknown, never success by default. Captured argument JSON and model-facing result text remain inert content, which may already be producer-truncated. Detailed/binary results are available only in the original record, not followed as paths. |
| `agent-span` | Native subagent start/completion/failure, including reported agent/task/tool-parent namespaces. Cancelled completion is unknown rather than successful work. A uniquely matching root task tool is marked `nativeExecution.accounting: bridge-wrapper`; it is not another additive agent execution. Every contributing subagent record must agree with the root relationship; parent metadata reported only at completion also disqualifies it. Nested/overlapping call IDs without qualified parent-scope agreement are `ambiguous`, also non-additive; task-registry IDs are not assumed equivalent to envelope-agent IDs. |
| `assistant-turn` | Recorded agent-loop boundaries, **not a model call, user task or proof of successful execution**. Status remains unknown; usage is null. |
| `usage-observation` / `assistant-output` | Output-only report with native API identity. Every message sharing the scoped API identity participates in validation, including counterless siblings. Split responses require a complete, nonconflicting set of chunk ordinals with a consistent counter; the repeated API output counter is retained once, never summed across chunks. Incomplete/conflicting/unqualified observations are diagnosed and excluded. Groups with neither usage nor conflicts are ignored. Input remains null. |
| `usage-observation` / `turn-inclusive`, `turn-direct` | Separate latest retained per-model whole-turn and direct-turn reports. Inclusive totals contain descendants/compaction; direct totals exclude descendants. Both are cumulative, overlap and must **not** be added. Top-level/latest-call/context gauges are ignored. |
| `usage-observation` / `session-snapshot` | Reported native shutdown per-model cumulative input/output snapshot. It overlaps turn/output observations and is not another set of per-call contributions. No shutdown means unavailable, not zero. |

For lifecycle pairing, API/chunk grouping, conflict poisoning and root-wrapper
qualification, only an omitted optional native `data.sessionId` inherits the
qualified enclosing SDK session. Explicit malformed or different IDs are not
repaired into that scope; original namespace witnesses remain retained.
Wrapper candidate call IDs also stay within that SDK scope, and root-tool
uniqueness follows the existing session/envelope-agent lifecycle key. Foreign
sessions or tools in other envelope-agent scopes do not change root accounting.

Every usage observation declares `observation.additive: false`; no observation
is a `model-call` or per-call usage ledger. Ephemeral `assistant.usage` and
`model.call_*` records remain outside this qualified persisted mapping.
Optional telemetry #34 is still unqualified. The reader calculates no metrics.

Overlay joins require one connection snapshot, exact root native `user.message`
envelope IDs in `turns.event_id`, and unique host turn IDs in `turn_usage.turn_id`.
Assistant loop-turn IDs, text, timestamps and filenames cannot substitute for
that bridge. Present `agentHost.rowOwnerChat` must match qualified runtime/storage
chat identity; `agentHost.foreignTurnIds` excludes compatibility rows.
Malformed ownership/foreign lists and competing native bridges are unavailable.
When owner metadata is absent, only the exact retained root-event bridge qualifies
the selected report; this does not authenticate a guessed storage path or discover
other databases. Per-model input/output/cached counters must be safe nonnegative
integers and models unique within each reported scope. Missing whole/direct fields
do not make latest-call gauges consumption totals. Replacement usage has no recorded
observation time: it remains null, not the bridged user-message timestamp.
Queries share the access layer's aggregate row/byte/deadline and 256-query ceilings;
exceeding a ceiling fails the entire read rather than publishing an evicted subset.
The overlay reads the `turns` and `turn_usage` projections once each and groups
usage by exact `turn_id` in memory, so the query count does not grow with bridged
turns. Unbridged usage rows do not establish observations, and duplicate reports
for one turn remain excluded rather than selecting one.

Exact native event replays merge original anchors. Conflicting event/lifecycle
identities poison every affected call; they are not arbitrarily paired.
Conflicting subagent boundaries remain negative wrapper witnesses even without
a retained completion. Invalid optional relationship fields remain unavailable
and diagnosed without erasing independently qualified session assignment.
`nativeExecution` retains all contributing event IDs and event-graph predecessor
IDs separately from call/agent/turn/task-parent relationships. Each event also
retains native identifier namespaces independently of session association.
Qualified SDK history without unique Agent Host catalog ownership can retain
**unassigned** native executions, with unknown harness identity and unavailable
Agent Host coverage. Unsupported native format/runtime produces no executions.
Unknown operations, malformed fields, missing times/results, interrupted tails,
context-retention notices and changing sources remain explicit diagnostics.
Coverage is partial or unavailable, never a complete model-call ledger.

Original JSONL byte/line/pointer anchors and SQLite table/typed-key/column/pointer/
projection fingerprints survive joins. Refresh replaces the transient generation;
no payload logs, model calls, browser storage or copied corpus are introduced.
Synthetic normalization tests run with application validation on Ubuntu, Windows
and macOS; guarded read/refresh/source-integrity tests additionally run on the four
native-helper targets via `qualify:source-access`. Skipped native tests in ordinary
application runs are not native qualification. Producer-generated tool workflows,
other producer versions and integrated delivery remain #20, not claims of these
fixtures. Required final guides remain #1/#21.

### Execution reader behavior

Extension `copilot_chat.parent_chat_session_id` becomes `event.parentChat`, with
the verbatim value, `vscode-chat` namespace, original JSONL field reference,
resolution status and nullable target `sessionId`. It never replaces
`nativeIdentities`, `sessionId`, `gen_ai.conversation.id` or native span ancestry.
Exactly one same-source observed session carrying that editor-chat identity is
required; equal GenAI/native IDs or cross-source anchors cannot match it.
The session's source list alone is not identity evidence: the matching original
`copilot_chat.chat_session_id` field must report that value in the relationship's
source. Compact scans retain this field anchor as well as the first root anchor.
Out-of-order parents resolve after assembly. Absent/out-of-read targets stay
`unresolved`; multiple candidates are `ambiguous`; self-links and edges within
cyclic session components are `self`/`cycle`. Unresolved targets have null IDs
and never create sessions. Shared validation recomputes these outcomes and
rejects unrelated original field evidence, invented targets and stale resolutions.

Parent-only calls retain null direct membership. Three unlinked chat calls and
seven unlinked embeddings stay ten unassigned calls, with missing-linkage
diagnostics, not fabricated session IDs or conflicting-identity diagnoses.
Existing qualified span-parent inheritance remains independent. No matching by
time, path or trace ID alone occurs.
An agreeing parent-chat link on an execution with span-inherited membership or
only a matching GenAI conversation identity remains resolved, not a self-link.
Self-links require the execution's own reported `vscode-chat` identity to equal
the reported parent value. Direct members are excluded from associated counts
even when they also retain such a resolved relationship.
Missing direct membership remains coverage-limiting even when a parent-chat link
resolves; a scan with such unassigned calls is partial, not complete.

Reports expose `contributions.directEvents` and `associatedEvents` separately;
measurements and their original contributors use direct membership only.
Associated records are inspectable separately in the small-read report and scan
detail pages, retaining their own identities and full-read resolution even when
their parent is outside the physical page. Catalogs expose direct `executions`
and separate `associatedExecutions`; `unassigned` still means no direct membership.
Model analysis inputs include resolved associates with the same explicit
relationship, contribution counts and instructions not to add associated usage
to direct totals. Its acknowledgement discloses the same complete selection count,
direct/associated counts and possible cross-session captured content before sending.
The associated-content warning is shown only when the selection has associates.
Model-call consumption and non-additive cumulative agent usage
remain separate. Exact replays never increase these normalized counts; differing
parent values or field presence on the same native span are conflicting evidence
and excluded, including differences between malformed values. Replay signatures
retain this distinction without making malformed values eligible for resolution.

The [bounded scan contracts](../src/evidence/streaming.ts) and
[scan coordinator](../src/runtime/jsonl-scan.ts) reuse this adapter's operation,
deduplication and correlation rules. A compact scan compares full normalized
facts before dropping prompt/tool/hook payloads, retains first contributor anchors
and counts physical duplicate executions. It does not publish an all-event
`ReadView` through `/api/view` or make its catalog an analysis input.
Selected original contributors are loaded through bounded pages; enumerating
duplicate records is not repeated metric contribution. Small-capture reads retain
their existing output and reference behavior.

The authenticated controls are `POST /api/scan`, `POST /api/scan/catalog`,
`POST /api/scan/details`, `POST /api/scan/cancel` and `GET /api/scan/status`.
They share launch-token, origin, control-body, grant containment and regular-file
checks with the existing runtime. The scan input names a grant, relative path,
installed format and optional opaque client `requestId`. Status echoes that ID
so lost-start reconciliation cannot adopt an older or unrelated scan. It is not
page authority. Pages accept a current server-issued generation, server-issued
cursor and session/time selection, never an arbitrary path, schema or SQL query.
Invalid/expired or selection-mismatched cursors are controlled failures.

`POST /api/scan/report` accepts only the current scan `id` and an explicitly
selected `sessionId`. The [report contract](../src/metrics/report.ts) returns
bounded numeric summaries, source identity, admitted byte boundary and prefix
SHA-256, not an all-event view or an anchor array. It uses the existing recorded
calculator over the bounded scan's whole-source correlated facts. At most 512
retained execution identities across the source and 128 measurements are
admitted to calculation/publication; crossing either ceiling is an explicit
unavailable report (`SCAN_BUDGET`), not sampling. A calculation-only budget error
from either report endpoint preserves catalog/ordinary-evidence authority after
confirmed descriptor cleanup; source-integrity, cleanup and other budget failures
still invalidate the generation. Existing metadata, work,
lifetime and response ceilings still apply. The 64 MiB whole-file read limit
is unchanged.

`POST /api/scan/metric` adds a server-owned `metricId` and optional signed cursor.
It recomputes the same bounded metric selection and rescans the original prefix
for its exact physical contributors, including replays without adding them again.
Cursor authentication binds generation, session, metric and admitted scope.
Source-only zero witnesses and selected-session records explaining unavailable
usage are labeled `coverage-witnesses`; they are not additive contributions.
Unavailable values keep this label even when calculator provenance includes
event IDs (for example, output-only usage explaining missing input tokens).
Every published page retains original line/byte coordinates, record fingerprint
and source identity. Calculator definitions, deduplication and non-additive
native observation rules are not redefined by this transport.

Reports, ordinary detail pages and metric pages share the runtime's owned
descriptor, disconnect/cancel, cleanup and current-generation publication gate.
Every report and page checks physical identity and the admitted prefix digest.
Appends beyond admission require a new explicit scan to affect totals. Changed,
truncated, replaced, cancelled, foreign or expired sources/selections cannot
publish old numbers or substitute evidence. No model call, persistent corpus,
disk index or source write is introduced; production Agent Host helper gates
remain independent and unchanged.

JSONL references may additionally carry original `byteOffset` and `byteLength`.
Fingerprints cover the original record bytes, excluding LF and including CR.
Before a detail response publishes, the original identity and full admitted-prefix
digest must match. Scan status separates input observation (`inputStartedAtMs`,
`inputFinishedAtMs`) from post-cleanup completion (`finishedAtMs`); event producer
timestamps remain independent. Detail pages carry their own `observedAtMs`.
`records` includes physical blanks; blank/malformed/incomplete/oversized/unknown,
physical execution/unclassified records and physical `metrics`/`logs`/`contentEvents`
counts account for the observed prefix. These physical counters remain available
during scanning and after a budget stop makes trusted totals unavailable.
Deduplicated trusted classification,
conflicts and unassigned executions are separate quantities.

See [resource limits, partial results and rescan costs](local-runtime.md#scan-large-jsonl-captures-in-place).

The [execution adapter](../src/evidence/readers/vscode-otel.ts) is installed by the
normal command-line application. Its supported operations are `chat` and
`embeddings` (distinct operation values within model calls), `execute_tool`
(tool calls), `invoke_agent` (agent spans) and `execute_hook` (hook executions).
Hook executions are not tool or model calls. Known log/metric records and
standalone `content_event` records are not extra executions. Unqualified operations
and unknown shapes produce limitations.
Logs are recognized through their required time/resource/instrumentation-scope
fields; optional severity and body fields are not prerequisites.
Span name/kind fields also identify compatible spans when both timestamps are
absent; missing timing does not discard otherwise usable execution or parent evidence.
Missing or malformed required exporter resource/scope metadata retains usable
records only with an explicit limitation and reduced coverage. Reported
model/tool/producer names with unsupported types are not silently coerced or
treated like ordinary omission.

The adapter preserves trace-scoped span identity, parent context, reported
model/tool/hook names, timestamps, status and usage. Optional typed `trace`,
`operation`, `spanName`, `model`, `tool`, `hook` and `content` fields extend
execution events without breaking older normalized fixtures. Content retains
only known captured string attributes:
input/output messages and tool arguments/results. These are quoted evidence,
not reconstructed conversation messages or executable instructions. Their
original attribute pointers are included in event references.
Hook metadata retains `copilot_chat.hook_type` and `copilot_chat.hook_result_kind`
as `hook.type` and `hook.resultKind`; the result kind does not replace the captured
span status. `copilot_chat.hook_input` and `copilot_chat.hook_output` become quoted
`hook.input` and `hook.output` strings with original attribute pointers. Neither
the reader nor analysis executes captured commands. Missing hook metadata stays
null; malformed content and unsupported result kinds produce limitations.
For this adapter, each reference's `recordId` is `sha256:` followed by the digest
of the original physical line bytes, excluding LF but retaining any CR or initial
byte-order mark. Together with source/line/pointer, it allows later evidence
resolution to detect replacement rather than silently show different content.
It is a content fingerprint, not producer authentication or a retained raw copy.
The original span label is separate from the reported tool name/call ID. A generic
`execute_tool` label does not manufacture a missing tool name. Cyclic native parent
relationships are diagnosed even when records have explicit session identifiers.

`gen_ai.tool.call.id` is optional and independent of trace/span identity. An
absent attribute yields `tool.callId: null` without a diagnostic. An empty string
also yields null, with the controlled `missing-field` notice
`Tool-call identifier unavailable: empty value`. This notice alone does not
reduce timing, tool-execution or model-token coverage. Its issue carries
`affectsCoverage: false`, so it remains visible without labeling a source read
or bounded scan partial. Omitted or true `affectsCoverage` retains limiting
semantics within the diagnostic's affected scope; analysis summaries preserve the flag.
Nonempty strings,
including whitespace, are preserved verbatim. Reported null, numeric, boolean,
array and object values yield null and the limiting `missing-field` diagnostic
`Invalid reported gen_ai.tool.call.id: expected a string`; values are never
coerced or interpolated into diagnostic messages.
Present attributes retain their original line/fingerprint/field pointer, including
empty and malformed values; diagnostics carry that field anchor. Compact scans
retain the first diagnostic anchor and exact occurrence count; contributor
rescans recover original event/field references.
Unavailable call IDs never become generated business IDs or deduplication keys.
Two otherwise usable tool spans with distinct native identities remain two
executions. Repeated native identities still require matching normalized facts,
session identities and producer metadata; conflicting facts are excluded rather
than overwritten. Malformed tool-call identifiers affect tool evidence, not
otherwise valid timestamps or model-call usage.

Execution-event `nativeIdentities` preserve only identifiers actually reported
on that event, even when it cannot be assigned to a session. An inherited
association does not manufacture per-event hints. Session `nativeIdentities`
aggregate the distinct `vscode-chat` and `gen-ai-conversation` namespaces.
An explicit editor identity can resolve a
uniquely matching conversation alias within this read; ambiguous aliases remain
unassigned. Missing identities can inherit only an unambiguous captured parent
association, never a filename, trace-only guess or temporal match. Cross-source
correlation remains separate.

Identical supported span facts/identities/producer metadata collapse to one
execution with all original line references. Conflicting repeated native
trace/span identities are excluded with a visible issue. Unsupported attributes
are not interpreted; their original records remain referenced in the harness.
Native execution identities are checked before unsupported operations are filtered:
an unqualified operation cannot hide a conflict with a supported call in either
source order. Intentionally ignored log/metric/content telemetry stays separate.

Missing/empty/whitespace-only operation metadata, malformed values/attribute
containers and unknown nonempty operations are distinct unclassified-span
diagnostics. They do not create execution events or inferred sessions from span
labels. Diagnostics include optional structured `count` and original `references`,
never the unknown operation value or captured payload. Counts describe diagnostic
occurrences, including duplicate physical records.

Optional source `classification` exposes source-wide observations:
`executions` (`modelCalls`, `toolCalls`, `agentSpans`, `hookExecutions`),
`unclassifiedSpans` (`missingOperation`, `malformedOperation`, `unsupportedOperation`),
`conflictingSpans` and `nonExecutionRecords` (`metrics`, `logs`, `contentEvents`).
Execution/unclassified counts deduplicate valid native trace/span identities;
identity-less spans count separately by original line. Conflicting identities
are excluded into their own bucket rather than counted as executions or ordinary
unclassified spans. Non-execution counts count physical records, not invocations.
For nine qualified hooks and two distinct missing-operation spans, the summary
reports nine hook executions and two unclassified spans, not eleven unsupported
calls.
These observations are not trusted per-session metrics, a complete-capture claim
or runtime identification. Unclassified/conflicting records still limit coverage.
Analysis receives relevant source-wide classification and payload-free diagnostic
summaries alongside selected-session events. Scoped diagnostics preserve severity,
impact and count. Record-scoped summaries include the first representative anchor,
not the full source-wide anchor array; an occurrence count larger than the anchor
array is not proof that other selected records are unaffected. Legacy summaries
remain unchanged. Source counts must not be mistaken for session totals.
Earlier version-1 views without these optional fields remain valid.

### Evidence-scoped coverage

The extension reader's optional source `coverageDetails` has the explicit
`basis: retained-executions`. It separates `retainedTiming`, `chatUsage`,
`embeddingUsage`, `sessionAttribution` and `history` from the existing aggregate
`coverage` dimensions. Complete retained timestamps mean all retained supported
executions have valid start/end fields, not that every source span or the entire
session was captured. `history` cannot be complete. Unknown/unclassified spans,
damaged input and conflicting native identities still limit aggregate totals.
Detected source changes limit every dimension even when retained timestamps
remain individually valid.

Diagnostics may carry `severity` (`info`, `warning`, `error`) and `impact`:
`scope` is `source`, `records`, `attribution`, `content` or `metadata`, with an
explicit `dimensions` list. These fields are independently optional for reader
compatibility; the UI labels absent severity as "severity unreported".
Severity-only labels remain visible; diagnostics with neither field keep their legacy message-only display.
Malformed/conflicting evidence remains an error.
Missing direct linkage is a warning, not a conflict. Record-scoped diagnostics
require original anchors. Unknown impacts are conservatively source-scoped;
empty optional tool IDs remain informational. Missing timestamps affect timing;
invalid usage affects tokens; captured-content limitations affect messages.
Malformed labels/status metadata stay errors without invalidating known numeric
fields. Missing native execution identity, invalid exporter structure, dropped
fields, unknown operations and integrity failures remain conservative.

Unassigned executions may have valid timestamps and tokens. They never enter a
specific session's totals. Explicit parent association stays distinct from direct
membership and is not additive. Known ambiguous direct identity takes precedence
over an otherwise resolved parent association. Chat and embedding availability are separate:
when an operation has no retained calls, its unavailable reason says so rather than
claiming usage is missing from nonexistent calls. For retained calls,
an embedding call without usage has unavailable tokens; a combined chat/embedding
total is partial, not a chat total plus invented embedding zero. Selecting only a
valid chat call can yield complete retained-field coverage even when another
operation's usage is missing. Unavailable per-call results retain their original
event IDs, scope and references; positive subtotals retain measured contributors
and the full selected scope, not fabricated numeric contributions.

Compact scans retain a diagnostic's first anchor and exact occurrence count.
When the count exceeds retained anchors, its affected dimension remains
conservatively limited across the source rather than clearing later sessions.
Original contributor rescans preserve field pointers. Valid log/metric/content-event
only input reports non-execution telemetry, not an empty source or zero calls.
Admitted-scan report `diagnostics` preserve severity, scope, dimensions and occurrence
counts without original anchor arrays, under the existing response-byte ceiling.
Legacy `issues` messages remain available; older responses without structured
diagnostics still display their messages. Exclusion applicability is indexed once
per calculation by dimension and observation event, not rescanned per tool name.
Repeated source-wide notices retain exact occurrence counts and first-line locations
without automatically retaining a redundant anchor for every unsupported record.
Explicit conflict references and record-scoped field anchors remain preserved.
Messages remain unavailable without a qualified conversation reader. Operation
classification never certifies runtime identity or Agent Host compatibility.

Model-call token counts are per-call. Non-model usage accounting remains unknown,
not additional model consumption, including aggregate usage on hooks or agent spans.
Captured intervals are retained individually; nested spans must not be summed as
elapsed time. This classification change does not implement the metrics calculator.
Cache/reasoning component overlap remains unknown; identical legacy/new
reasoning aliases represent one component and
conflicting aliases produce a limitation. Missing counts remain null, including
missing output usage; explicit reported zero remains zero.

Coverage concerns supported evidence in the bounded read, not all session history.
Execution content does not establish conversation coverage. Dropped-field counts,
recognized truncation markers, damaged records and incomplete timing/usage
reduce coverage. Absence of a truncation marker does not prove that the producer
captured all content; effective capture settings still matter. Raw parser errors
and captured payloads are never diagnostic messages.

### Producer mapping evidence

The implementation inspected these public producer definitions at VS Code commit
`2c33b50b16c472efe58357d1d2a8a5414bc23fbf`, rather than treating filenames or the
synthetic fixtures as proof of the wire format:

| Definition                                                                                                                                                               | SHA-256 of inspected file bytes                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [File exporter](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/extensions/copilot/src/platform/otel/node/fileExporters.ts)            | `d5fd8f85c2e58d4d59283ec9c28c3339e5be9ca928a3ab8c4d8fafced3055138` |
| [Attribute vocabulary](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/extensions/copilot/src/platform/otel/common/genAiAttributes.ts) | `c2e82f03f276d5efb0edb105c0dcf2e5bea9ba60842b7806678a70bea2d63e2c` |

| Producer field/declaration                                                                                       | Reader interpretation                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Direct span context, `parentSpanContext`, `resource.attributes`, `instrumentationScope`                          | Trace-scoped identity and reported metadata, not an OTLP wrapper or a path-derived identity.                                     |
| `startTime` / `endTime` tuples                                                                                   | Epoch seconds plus nanosecond remainder, converted to milliseconds; missing values stay unavailable.                             |
| `gen_ai.operation.name`                                                                                          | Explicit mappings for `chat`, `embeddings`, `execute_tool`, `invoke_agent` and `execute_hook`; other operations are not guessed. |
| `copilot_chat.hook_type`, `copilot_chat.hook_result_kind`, `copilot_chat.hook_input`, `copilot_chat.hook_output` | Reported hook metadata and quoted strings with original anchors; not tool calls or commands to execute.                          |
| `gen_ai.conversation.id` / `copilot_chat.chat_session_id`                                                        | Separately named identity hints; the latter is the editor chat identifier, not an alias inferred from equal text.                |
| `copilot_chat.parent_chat_session_id` | Explicit same-source editor-chat association with original field evidence, separate from own-session identity and native ancestry. |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`                                                       | Reported counts on the represented operation; no estimates or missing-to-zero conversion.                                        |
| Cache attributes and both reasoning-token attribute names                                                        | Components retained without assuming overlap; the vocabulary explicitly identifies the reasoning fields as dual-emitted aliases. |
| `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`       | Optional content-gated attributes retained only as captured strings and source references.                                       |
| Separate file span/log/metric exporters                                                                          | A single destination can contain different signal types; non-execution records are not additional calls.                         |

This is static compatibility evidence, not proof of producer authenticity,
all-version support, content completeness or live private-capture qualification.
Fixtures are independently authored and contain no copied source implementation
or private capture. If a reviewer cannot retrieve the upstream definitions,
that independent-verification gap must remain explicit rather than becoming a
claimed successful check.

## Calculated metrics

`parseMetric` requires the current read/session, a unit, evidence `dimension`
(`messages`, `timing`, `tools` or `tokens`), explicit coverage and
source contributors. Available zero is different from unavailable `null`.
Known event references must belong unambiguously to the requested session,
even when multiple sessions share a source. Each session also declares original
source anchors in `references`. Non-event anchors are accepted only for zero or
unavailable results; a numeric zero requires complete applicable coverage for the
selected dimension. Availability of a different dimension is not enough.
Numeric event contributions also require that dimension to be available.
Legacy readers retain source/dimension coverage as an upper bound. Qualified
scoped extension coverage uses applicable source-integrity, selected-record field
availability and diagnostics instead. Every numeric contributor requires available
fields; adding measured anchors cannot admit an unavailable usage anchor. Missing
usage cannot back a numeric token metric merely because no diagnostic was emitted;
an unrelated missing field cannot poison a valid selected
field. Source changes and unknown impacts never produce complete totals.
Arbitrary undeclared references and another session's events are rejected.
Even a measured zero needs evidence, such as a declared complete source array's
root reference. Missing/partial root evidence must not become an observed zero.

Contract validation does not validate arithmetic or establish that a declared
locator exists in the underlying source; readers/calculators must supply genuine
locators and drill-down must report lost/invalid evidence rather than substitute it.

Usage declares per-call, cumulative or unknown accounting. Cache/reasoning
components declare their overlap with input/output totals; do not add subsets
twice. Task grouping and prompt judgments do not belong in recorded events.
Their provider policy and result contracts remain separate work.

### Recorded-metrics calculator

The pure [calculator](../src/metrics/recorded.ts) accepts a validated `ReadView`
and `{ sessionId, eventIds? }`. Omit `eventIds` for a whole-session selection;
provide current-read event IDs for an evidence-attributed subset. A subset is
not a time window: selected executions retain their full recorded intervals.
Unknown/foreign event IDs and absent sessions throw. No source reads, model
calls, persistence or task inference occur.

Each `RecordedMetric` wraps the existing `Metric` in `metric`, with its
`scope` and a functional `definition`. The result also retains the read's
observation bounds; these are not session start/end times. Every numeric
contributor is attributable to the selected session and available for the
metric's dimension. Legacy source/dimension coverage remains an upper bound;
scoped extension diagnostics apply only to affected dimensions and records.
Missing selected fields and relevant conflicts/unassigned evidence reduce
availability; associated-only records are not missing direct contributions.
Unassigned hook/agent usage does not limit per-call model totals, and an unrelated
excluded record does not limit a separately scoped usage observation. Diagnostic
impacts and retained-field availability are indexed once per calculation rather
than rescanning every diagnostic anchor for each reported tool name.
All session sources conservatively constrain dimensional coverage, including
unavailable sources with no normalized events. An available source cannot hide
another source's missing contributions or establish a source-anchored zero alone.

- **Observed start/end** are the earliest/latest selected message or execution
  boundary timestamps, in Unix milliseconds. **Elapsed** is their difference,
  requiring at least two recorded boundaries. Usage-observation timestamps
  do not establish session timing.
- **Recorded agent activity** is the union of complete model, tool, agent and
  hook execution intervals. Nested/parallel overlap counts once. Assistant
  turns are boundaries, not model calls or proof of uninterrupted activity.
- **Cumulative span duration** sums distinct complete execution intervals,
  intentionally including nested/parallel work. Two overlapping 60-second
  spans give 60 seconds elapsed/activity and 120 cumulative seconds.
- **Unobserved gaps** are observed elapsed minus interval-union activity,
  requiring both measurements. They are neither human typing nor true idle
  time. Incomplete intervals remain partial/unavailable, not zero-length spans.
- **Tool calls/identities** count distinct recorded executions, including
  incomplete calls. Missing names remain `null`; optional absent call IDs
  are not fabricated or replaced by span IDs. Qualified native bridge wrappers
  are excluded.
- **Input/output tokens** sum only model-call `per-call` measurements.
  Parent usage, cumulative/unknown reports, whole/direct-turn totals,
  assistant-output reports and shutdown snapshots are not added to these
  totals or to one another. Each non-additive report remains inspectable in
  `tokens.observations`, with its own scope, model and original contributors.
  Model identity requires explicit observation or responded/requested model
  metadata; an agent, tool, hook or generic span name is not a model identity.
  Native-only evidence may therefore expose reported usage while per-call
  totals remain unavailable.
- **Components** retain name, value and declared overlap relation separately.
  Cache/reasoning subsets are not added again; even `additional` and `unknown`
  components stay separate from input/output totals. Conflicting duplicate
  components and impossible subset counts are unavailable or explicitly partial.

Repeated native identities deduplicate only within qualified trace/SDK/source
scopes. Identical replays retain every locator without multiplying totals;
conflicting variants poison the identity even when a subset selects one copy.
Without a comparable native identity, only identical original locator sets
establish replay identity; matching text/timing is not sufficient. Unassigned
and shared-source evidence remains in `exclusions`, not silently assigned to
the selected session. Unassigned replays are grouped into one exclusion with
all event IDs and unique original locators, separately from attributed records
even when their native IDs match. Selections may expand to equivalent replay locators.

Missing token measurements stay unavailable; a reported zero is still a
measurement. Zero tools without event contributors requires complete relevant
source coverage and an unambiguous declared session anchor, and is not inferred
for an empty subset. Unsafe numeric sums are unavailable with a reason.
The [numeric tests](../tests/recorded-metrics.test.ts) and native-reader
integration checks run in the existing application validation matrix.
Report/UI wiring remains separate work in
[#14](https://github.com/toddysm/agent-insights/issues/14).

## Extending and validating

An `EvidenceReader` receives only a borrowed byte stream and cancellation signal
from the approved source-access boundary. It cannot select a filesystem path
through this interface. Readers must honor cancellation and report corrupt,
unsupported or incomplete input explicitly. `selectReader` rejects missing or
ambiguous registration; it never chooses a silent fallback.

`MultiSourceReader` uses [code-owned source declarations](../src/evidence/source-access.ts).
The runtime binds one explicitly granted location to each declared role and
supplies `MultiSourceInput.get(key)`. File roles expose bounded borrowed bytes;
SQLite roles expose an observed `userVersion`, `snapshotScope` and named parameterized queries,
not a database connection. Query results preserve bigint/binary cells internally.
Readers must validate their domain semantics before creating normalized facts.
JSON-path equality filters guard extraction with `json_valid`; malformed JSON
does not match, including when the bound comparison value is null. Readers must
validate matched objects and cannot treat nonmatching rows as qualified evidence.
Code-owned `prefix: true` filters instead require text bindings and compare a
literal, case-sensitive prefix over text cells, including embedded NULs and
Unicode (no SQL wildcard interpretation). Binary cells do not match; prefix and JSON
path modes cannot be combined in one filter.

Optional missing/incompatible inputs are typed unavailable values with controlled
diagnostics, never empty result sets. They must remain visible as unavailable
sources and cannot contribute invented references, sessions or measured zero.
Required-source failures reject the read. Every successful role has a separate
generation-local source identity even when several roles share one directory grant.
Readers may use `sqliteReference` from the [composite coordinator](../src/runtime/source-read.ts)
to construct original row anchors. The runtime validates these witnesses,
downgrades coverage for detected source changes, awaits database process cleanup
and rejects stale results before publishing the one current in-memory view.
Missing native preparation, guard/protocol failures and unconfirmed cleanup are
fatal even for optional roles. The application never silently substitutes Node
SQLite or prepares an artifact while reading.

Per-source status observations are independent of captured event timestamps and
of normalization completion. There is no cross-database atomic snapshot or
automatic identity/session match. See the [runtime bounds and SQLite caveats](local-runtime.md#shared-file-and-sqlite-access).
WAL reads expose a connection snapshot; rollback-mode reads expose per-request
snapshots and release their native locks between queries.
The [source-access suite](../tests/source-access.test.ts) uses synthetic databases
and a separate writer process to exercise actual native lock cancellation,
WAL snapshots, exact limits, cleanup, provenance and the authenticated route.
The [transport suite](../tests/sqlite-transport.test.ts) independently tests
malformed framing, stale replies, row witnesses, cleanup failures and actual
termination using fictional subprocesses without a native release.

With Node.js 24:

```bash
npm ci --ignore-scripts
npm run check
npm test
```

Ordinary tests explicitly skip real native source-access cases when no verified
candidate is selected. They do not download or compile a helper. To qualify these
cases, first commit a clean checkout and use the explicit
[candidate preparation workflow](../native/sqlite-guard/ARTIFACTS.md):

```bash
npm run build
npm run package:native
npm run prepare:native -- --candidate
npm run qualify:native
npm run qualify:source-access
```

The final command verifies the independently recorded candidate and installed
bytes before selecting it through a test-only resolver. Native continuous
integration runs this qualification on all four supported targets; it is not
an arbitrary executable override in the application or a public release.

The root checks compile the TypeScript contracts and run the fixture/contract
suite. The existing [prototype checks](../design/session-insights/README.md)
remain separate. Hosted contract checks target Ubuntu, Windows and macOS;
their results certify these checks only, not unimplemented runtime/source support.

The [lockfile](../package-lock.json) pins versions and integrity without
machine-specific registry URLs. The [project npm setting](../.npmrc) preserves
that policy when updating dependencies; installation uses the caller's configured
registry. Do not commit credentials or private package-feed URLs.
