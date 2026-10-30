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

The [source fixtures](../tests/fixtures/) include span nesting/cumulative-usage
hazards, version-3 chat, mutation envelopes, an intentionally truncated tail and
an unknown schema. The [normalized fixture](../tests/fixtures/read-view.ts) and
[tests](../tests/contracts.test.ts) exercise partial, unavailable, changing and
complementary-source views. Structural fixture checks are not live-producer or
platform certification.

## Calculated metrics

`parseMetric` requires the current read/session, a unit, explicit coverage and
source contributors. Available zero is different from unavailable `null`.
Known event references must belong unambiguously to the requested session,
even when multiple sessions share a source. Each session also declares original
source anchors in `references`. Non-event anchors are accepted only for zero or
unavailable results; arbitrary undeclared references and another session's events
are rejected. Even a measured zero needs evidence, such as a declared complete
source array's root reference.

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
