# In-memory evidence contracts

This is the reader/calculator boundary for
[#8](https://github.com/toddysm/agent-insights/issues/8), not a working analyzer.
[Contracts](../src/evidence/contracts.ts) contain no filesystem, database,
network, model or persistence operations. Their validated objects are immutable
in-memory views; they must never be serialized into an application session store.

## Read generations and provenance

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
These identify planned native inputs, **not shipped adapters or qualification of
all producer versions**. Native qualification is tracked in
[#30](https://github.com/toddysm/agent-insights/issues/30); it is distinct from the
Local/extension targets above.

The [source fixtures](../tests/fixtures/) include span nesting/cumulative-usage
hazards, version-3 chat, mutation envelopes, an intentionally truncated tail and
an unknown schema. The [normalized fixture](../tests/fixtures/read-view.ts) and
[tests](../tests/contracts.test.ts) exercise partial, unavailable, changing and
complementary-source views. Structural fixture checks are not live-producer or
platform certification.

### Execution reader behavior

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
summaries (source, code, message and optional occurrence count) alongside
selected-session events. Full diagnostic anchor arrays remain in the read view,
not the model input: unrelated source records must not consume a small selected
session's analysis budget. Source counts must not be mistaken for that session's
totals. Earlier version-1 views without these optional fields remain valid.

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

| Producer field/declaration                                                                                 | Reader interpretation                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Direct span context, `parentSpanContext`, `resource.attributes`, `instrumentationScope`                    | Trace-scoped identity and reported metadata, not an OTLP wrapper or a path-derived identity.                                     |
| `startTime` / `endTime` tuples                                                                             | Epoch seconds plus nanosecond remainder, converted to milliseconds; missing values stay unavailable.                             |
| `gen_ai.operation.name`                                                                                    | Explicit mappings for `chat`, `embeddings`, `execute_tool`, `invoke_agent` and `execute_hook`; other operations are not guessed. |
| `copilot_chat.hook_type`, `copilot_chat.hook_result_kind`, `copilot_chat.hook_input`, `copilot_chat.hook_output` | Reported hook metadata and quoted strings with original anchors; not tool calls or commands to execute. |
| `gen_ai.conversation.id` / `copilot_chat.chat_session_id`                                                  | Separately named identity hints; the latter is the editor chat identifier, not an alias inferred from equal text.                |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`                                                 | Reported counts on the represented operation; no estimates or missing-to-zero conversion.                                        |
| Cache attributes and both reasoning-token attribute names                                                  | Components retained without assuming overlap; the vocabulary explicitly identifies the reasoning fields as dual-emitted aliases. |
| `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` | Optional content-gated attributes retained only as captured strings and source references.                                       |
| Separate file span/log/metric exporters                                                                    | A single destination can contain different signal types; non-execution records are not additional calls.                         |

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
unavailable results; a numeric zero requires complete source coverage for the
selected dimension. Availability of a different dimension is not enough.
Numeric event contributions also require that dimension to be available.
Metric coverage cannot be stronger than contributing source coverage: a partial
capture cannot produce a complete metric. This is intentionally conservative
while coverage is tracked at the source/dimension level.
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
