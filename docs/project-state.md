# Project state

Capability inventory as of 2026-11-04. This records project delivery status,
not session data or analysis results.

The merged baseline is main at `d767c31665fffb72154fbccb23ecbd2494072c97`.
The current proposed scope is lightweight revision 12 in
[#2](https://github.com/toddysm/agent-insights/issues/2), with experience
revision 2 in [#3](https://github.com/toddysm/agent-insights/issues/3).
The user approved the plan, runtime baseline and unattended review/merge scope
on 2026-10-30, followed by configurable Copilot-first analysis and disclosed
remote processing and the initial interpretation defaults. The Copilot runner
and its qualification shipped through [#26](https://github.com/toddysm/agent-insights/pull/26).
On 2026-11-02 the user approved the reader refinement in
[#10](https://github.com/toddysm/agent-insights/issues/10) and
[#11](https://github.com/toddysm/agent-insights/issues/11), including immediate
implementation after publication. On 2026-11-03 the user clarified that
**Copilot Agent Host is the intended everyday workflow** and authorized filing
the adjustment, then authorized source qualification in #30. The user subsequently
approved the shared read-only SQLite/multi-source direction, requested its
work items and authorized #33 implementation. The partial implementation is
preserved in draft [#35](https://github.com/toddysm/agent-insights/pull/35).
After review exposed a source-side file-creation race, the user approved revising
the safety boundary. Revision 12 proposes the
[native guard design](https://github.com/toddysm/agent-insights/issues/33#issuecomment-6621343238);
that detailed revision awaits confirmation before implementation resumes.
No merge or native-binary release is authorized. Earlier approved revisions are
historical, not approval of the new design or the superseded Local-only plan.

Tracking currently uses GitHub issues and native sub-issues/dependencies.
GitHub Project access is unavailable; no board status is claimed.

## Implemented

No complete production session-analysis workflow has shipped.

| Capability | Feature slug | Tracking issue | PRD doc | Docs (arch/dev) | Docs (user) | Landed |
| ---------- | ------------ | -------------- | ------- | --------------- | ----------- | ------ |

Here and below, the template column `PRD doc` means product requirements document
or, for lightweight planning, the linked issue-backed design.

### Existing design artifact

| Artifact                                                                         | Evidence                                                                                                                | Documentation                                                              | Landed     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------- |
| Locally viewable synthetic session-insights prototype; not a production analyzer | [Pull request #4](https://github.com/toddysm/agent-insights/pull/4), [prototype](../design/session-insights/index.html) | [Walkthrough and development checks](../design/session-insights/README.md) | 2026-10-29 |

The prototype demonstrates navigation, numeric summaries, evidence drill-down
and illustrative prompt coaching with fictional data. It does not read real
sessions or call a model. Its revision-1 editing controls are superseded by
the current read-only design. Removing those controls and reviewing the
aligned experience remain work in
[#3](https://github.com/toddysm/agent-insights/issues/3).
Prototype tests are not validation of production source readers or analysis.

## In progress

The runtime baseline is TypeScript, Node.js 24 and React on a loopback-only
server, with explicit source selection and manual refresh. The
[local interface](local-runtime.md) and
[evidence contracts](evidence-contracts.md) are implemented. The
[Copilot transport and analysis runner](copilot-analysis.md) implement consent,
in-memory execution, validated references, cancellation and separate usage.
Real-session readers, reports and interpretation definitions remain incomplete.
The Local-exporter implementation in
[#29](https://github.com/toddysm/agent-insights/pull/29) is preserved and unmerged.
It is not Agent Host support, and the user cannot complete its live test because
the Local harness option is unavailable. The user explicitly requested leaving
that unfinished work open. Existing conversation work
[#11](https://github.com/toddysm/agent-insights/issues/11) remains paused pending
separate authorization. Both Local-only items are supplemental/deferred and no
longer block the required Agent Host delivery.

| Capability                                                                                                                                                                 | Feature slug            | Tracking issue                                           | PRD doc                                                                   | Docs                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local, read-only analysis of Visual Studio Code Copilot Chat sessions: timing, tools, tokens, tasks/outcomes, steering, artifacts and prompt coaching with source evidence | vscode-session-analysis | [#2](https://github.com/toddysm/agent-insights/issues/2) | [Issue-backed design](https://github.com/toddysm/agent-insights/issues/2) | Capture prerequisites [#1](https://github.com/toddysm/agent-insights/issues/1) and final usage guide [#21](https://github.com/toddysm/agent-insights/issues/21) remain incomplete |
| Shared authorized read-only SQLite/multi-source access and original references | vscode-session-analysis | [#33](https://github.com/toddysm/agent-insights/issues/33) | [Proposed native guard](https://github.com/toddysm/agent-insights/issues/33#issuecomment-6621343238), revision 12 | Partial implementation in draft [#35](https://github.com/toddysm/agent-insights/pull/35), blocked on guard design/qualification; not shipped. Runtime/evidence guides accompany implementation; final user docs remain #1/#21 |

At #35 head `7ef06a70cd1884e3a050f3aba2eef834a93955de`, 91 local
unit/integration/startup tests, six Chromium cases and all four hosted checks
passed. Copilot's initial cleanup-overlap finding was fixed, but its fresh
review found a producer-shutdown race that can recreate write-ahead-log (WAL)
and shared-memory (SHM) files, plus unreadable-WAL error misclassification.
Synthetic probes confirmed that Node read-only/query-only settings and Node
filesystem permission mode do not enforce the no-create guarantee.
Those passing checks do not qualify the missing native guard.
Codex review quota remains unavailable; no exception is assumed.

## Planned

| Capability | Feature slug | Tracking issue | PRD doc | Documentation status |
| ---------- | ------------ | -------------- | ------- | -------------------- |
| Copilot Agent Host execution/conversation readers over the shared boundary | vscode-session-analysis | [#30](https://github.com/toddysm/agent-insights/issues/30), [#32](https://github.com/toddysm/agent-insights/issues/32), [#31](https://github.com/toddysm/agent-insights/issues/31) under [#2](https://github.com/toddysm/agent-insights/issues/2) | Proposed revision 12 and source draft 3 in #30; #31/#32 remain blocked on #33/#30 and are not implemented | Extend required capture guide [#1](https://github.com/toddysm/agent-insights/issues/1) and usage guide [#21](https://github.com/toddysm/agent-insights/issues/21); no duplicate documentation item |

These are required adjustments to the existing feature, not optional future
harness support. The shared foundation has started, but the native guard and
Agent Host readers have not been implemented.

The required tracker now has 20 native children and 31 immediate dependency links.
Local-only #10/#11 remain open outside that completion gate; #12/#14 no longer
depend on them. #33 follows the existing runtime and precedes #31/#32.
The detailed acceptance criteria and dependency order live in those issues.

The earlier #10/#11 plan targets the OpenTelemetry extension export and saved
chat v3/mutation sources. These are not assumed to be Agent Host evidence.
Qualification #30 records native source/version/identity findings and a selected
source check. Optional per-call capture/routing remains unqualified and is now
tracked separately in [#34](https://github.com/toddysm/agent-insights/issues/34),
not a blocker of the native baseline. #30's planning handoff precedes the
new execution/conversation readers and final capture instructions. Existing
discovery #12 and reporting #14 now require both Agent Host readers; delivery #20
must verify the actual Agent Host path with producer-generated evidence.

Harness identity is separate from Ask/Agent mode, local execution location and
the Copilot CLI analysis executor. Do not require switching to Local or bypassing
managed sandbox/permission policy to satisfy the primary workflow.

Static inspection in #30 identifies existing native event history plus
harness-owned catalog/session databases as the proposed baseline, with optional
Agent Host telemetry for detailed per-call evidence. Host telemetry uses
`chat.agentHost.otel.*`; personal changes require a full application restart.
Reading existing harness databases is not an application-owned session store.
Shared access [#33](https://github.com/toddysm/agent-insights/issues/33) owns
bounded queries/cancellation, transient read generations and row/file provenance,
not source-specific accounting. Its proposed native helper uses a pinned SQLite
engine, a virtual file system (VFS) policy and audited operating-system call
guards, including internal SHM operations. It preserves SQLite locking and
permits only existing-file access and bounded existing-SHM coordination.
Missing or unqualified enforcement disables SQLite explicitly, with no
unguarded or copied-database fallback. Existing file-only behavior remains.
Rust/C build tooling and verified per-platform artifacts are new delivery work,
not already available dependencies. The initial native qualification targets
are macOS arm64/x64, Linux x64 and Windows x64; support is not claimed before
native tests pass. Binary publication needs separate authorization.
Eighteen static schema/source assertions passed.
A separately authorized inspection then verified one harmless native Agent Host
exchange and its exact catalog/turn-usage linkage. Only sanitized findings are
published; no capture content, identifiers or raw usage values are stored here.
Native history, database main files and write-ahead logs were unchanged; existing
SQLite shared-memory sidecars changed, so byte-for-byte sidecar immutability is
not claimed. No source replicas, model requests or settings changes were made.
This is not a production-reader, optional-telemetry or all-version qualification.

Harness-owned data is the sole evidence authority. The approved initial scope
reads sources in place and analyzes them transiently in memory. It excludes an
application-owned session database, persistent raw/normalized replicas, saved
analysis history, archives, synchronization, manual corrections and independent
live artifact-verification inputs.

The runtime/source workflow decision in
[#6](https://github.com/toddysm/agent-insights/issues/6) is approved.
The provider/data portion of
[#7](https://github.com/toddysm/agent-insights/issues/7) now approves Copilot first
and remote processing with explicit user awareness. The user also approved its
initial completion/rubric rules. Model execution requires a qualified installed
runtime, an application-owned interpretation definition and acknowledged user action;
source selection/refresh does not transmit content. GitHub-hosted validation
remains the selected testing mode.

## Deferred / Won't do

| Capability                                             | Feature slug            | Tracking issue                                           | Reason                                                                                                                                 |
| ------------------------------------------------------ | ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Manual corrections to inferred session interpretations | vscode-session-analysis | [#5](https://github.com/toddysm/agent-insights/issues/5) | Deferred standalone idea, not a required child or dependency of the initial read-only feature; no future correction design is approved |
| Local/extension execution source support | vscode-session-analysis | [#10](https://github.com/toddysm/agent-insights/issues/10), [#29](https://github.com/toddysm/agent-insights/pull/29) | Open and preserved; the user cannot complete Local live testing. No merge or closure, and no Agent Host completion dependency |
| Local saved-chat conversation formats | vscode-session-analysis | [#11](https://github.com/toddysm/agent-insights/issues/11) | Open supplemental work, not the primary Agent Host conversation reader or a required blocker |
| VS Code Agent Debug Log execution adapter qualification | vscode-session-analysis | [#27](https://github.com/toddysm/agent-insights/issues/27) | A particular export adapter is deferred, not Agent Host support. #30 must revisit this deferral if the adapter is needed for the qualified primary path |
| Optional Agent Host per-call telemetry and effective capture routing | vscode-session-analysis | [#34](https://github.com/toddysm/agent-insights/issues/34) | Unverified follow-up, not passed or required for native history/retained turn-usage analysis; new capture activity requires specific authorization |

## Known gaps & debt

| Gap                                                                      | Evidence and next work                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared source-access guard is blocked; Agent Host readers remain unimplemented | #33/#35 retain a partial implementation with verified safety gaps. Direction approval is recorded; detailed revision 12 awaits confirmation, native implementation and qualification. #31/#32 remain prerequisite-blocked. Optional telemetry remains #34, not a baseline requirement or claimed success |
| Current prototype still contains superseded editing flows                | Align the historical prototype with experience revision 2 through [#3](https://github.com/toddysm/agent-insights/issues/3); do not treat those controls as product requirements                  |
| Real-session readers, reports and interpretation definitions are not implemented yet | The transport is available, but the local shell reports missing consumers explicitly; delivery remains In progress under [#2](https://github.com/toddysm/agent-insights/issues/2) |
| End-user capture and usage documentation is not complete                 | Deliver [#1](https://github.com/toddysm/agent-insights/issues/1) and [#21](https://github.com/toddysm/agent-insights/issues/21), verified against supported captures and the shipped application |
