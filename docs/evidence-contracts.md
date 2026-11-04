# In-memory evidence contracts

This is the reader/calculator boundary for
[#8](https://github.com/toddysm/agent-insights/issues/8), not a working analyzer.
[Contracts](../src/evidence/contracts.ts) contain no filesystem, database,
network, model or persistence operations. Their validated objects are immutable
in-memory views; they must never be serialized into an application session store.

## Read generations and provenance

- Every read has an independent `id`, wall-clock read-start/read-finish bounds,
  source metadata, sessions, events and visible issues.
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
the future source readers, not disguised as successful empty data.

## Initial reader targets and evidence limits

These are bounded implementation targets, not shipped reader support.
Producer definitions were inspected at Visual Studio Code commit
`2c33b50b16c472efe58357d1d2a8a5414bc23fbf` (1.144.0).
The fixtures are independently authored fictional data; no source implementation
or private capture was copied. No live capture smoke test has run.

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
SQLite roles expose an observed `userVersion` and named parameterized queries,
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

Per-source status observations are independent of captured event timestamps and
of normalization completion. There is no cross-database atomic snapshot or
automatic identity/session match. See the [runtime bounds and SQLite caveats](local-runtime.md#shared-file-and-sqlite-access).
The [source-access suite](../tests/source-access.test.ts) uses synthetic databases
and a separate writer process to exercise actual native lock cancellation,
WAL snapshots, exact limits, cleanup, provenance and the authenticated route.

With Node.js 24:

```bash
npm ci --ignore-scripts
npm run check
npm test
```

The root checks compile the TypeScript contracts and run the fixture/contract
suite. The existing [prototype checks](../design/session-insights/README.md)
remain separate. Hosted contract checks target Ubuntu, Windows and macOS;
their results certify these checks only, not unimplemented runtime/source support.

The [lockfile](../package-lock.json) pins versions and integrity without
machine-specific registry URLs. The [project npm setting](../.npmrc) preserves
that policy when updating dependencies; installation uses the caller's configured
registry. Do not commit credentials or private package-feed URLs.
