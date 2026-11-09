# Project state

Capability inventory as of 2026-11-09. This records project delivery status,
not session data or analysis results.

The merged baseline is main at `5adb0e2984ed62584502a5ca001d372c5e3e037c`.
The approved architecture and explicit execution breakdown are recorded as
lightweight revision 15 in
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
work items and authorized #33 implementation, now merged through
[#35](https://github.com/toddysm/agent-insights/pull/35).
After review exposed a source-side file-creation race, the user approved revising
the safety boundary. The user then approved the revision-12
[native guard design](https://github.com/toddysm/agent-insights/issues/33#issuecomment-6621343238);
revision 13 records the requested explicit work-item decomposition without
changing that architecture. The engine/interface foundation merged through
[#40](https://github.com/toddysm/agent-insights/pull/40) under specific user
authorization. Actual source enforcement for
[#36](https://github.com/toddysm/agent-insights/issues/36) and ESLint tooling
[#42](https://github.com/toddysm/agent-insights/issues/42) merged through
[#41](https://github.com/toddysm/agent-insights/pull/41), with explicit user
acceptance of the disclosed security risks. That is not completed security
remediation or a waiver for later work.
The bounded helper protocol in #37 merged through
[#43](https://github.com/toddysm/agent-insights/pull/43) on 2026-11-05 after
the user explicitly accepted its quota-blocked Codex review and manual
native-security limitation. That exception applies only to #43.
Artifact preparation #38 merged through
[#44](https://github.com/toddysm/agent-insights/pull/44) on 2026-11-05 after
the user authorized its normal merge. Both configured reviews and all eight
exact-head checks passed without a waiver, including packaged/installed
candidate qualification on all four native targets. Public binary distribution
remains separately gated by #39; the merge does not publish binaries. The superseded
Local-only plan is not restored by this approval. On 2026-11-06 the user
separately approved the extension-reader refinements and dependency-order start
in revision 14. This does not substitute extension telemetry for Agent Host evidence.
On 2026-11-09 the user confirmed #45's bounded-streaming scope and qualification
thresholds and authorized its isolated one-PR build with hosted CI/reviews and
tracking updates, recorded as revision 15. Merge, model calls and private-source
inspection are not authorized. Large synthetic scale results remain distinct
from real-capture compatibility.

Tracking currently uses GitHub issues and native sub-issues/dependencies.
GitHub Project access is unavailable; no board status is claimed.

## Implemented

No complete production session-analysis workflow has shipped.

| Capability | Feature slug | Tracking issue | PRD doc | Docs (arch/dev) | Docs (user) | Landed |
| ---------- | ------------ | -------------- | ------- | --------------- | ----------- | ------ |

Here and below, the template column `PRD doc` means product requirements document
or, for lightweight planning, the linked issue-backed design.

### Delivered foundations

These are supporting components, not a complete production analysis workflow.

| Component                                                    | Tracking                                                   | Landed evidence                                                                                                                                                                                            | Documentation                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Rust SQLite source guard core                                | [#36](https://github.com/toddysm/agent-insights/issues/36) | [#41](https://github.com/toddysm/agent-insights/pull/41), merged 2026-11-04; native source-operation qualification                                                                                         | [Guard development](../native/sqlite-guard/README.md)                   |
| Type-aware JavaScript/TypeScript linting                     | [#42](https://github.com/toddysm/agent-insights/issues/42) | [#41](https://github.com/toddysm/agent-insights/pull/41), merged 2026-11-04; zero-warning validation and configuration tests                                                                               | [Development checks](../README.md)                                      |
| Bounded native helper protocol                               | [#37](https://github.com/toddysm/agent-insights/issues/37) | [#43](https://github.com/toddysm/agent-insights/pull/43), merged 2026-11-05; native process/lifetime qualification                                                                                         | [Helper protocol](../native/sqlite-guard/PROTOCOL.md)                   |
| Qualified native candidates and explicit offline preparation | [#38](https://github.com/toddysm/agent-insights/issues/38) | [#44](https://github.com/toddysm/agent-insights/pull/44), merged 2026-11-05; exact packaged/installed qualification on four targets, not a public release                                                  | [Artifact workflow and trust](../native/sqlite-guard/ARTIFACTS.md)      |
| Shared guarded source access, provenance and cleanup         | [#33](https://github.com/toddysm/agent-insights/issues/33) | [#35](https://github.com/toddysm/agent-insights/pull/35), merged 2026-11-05 as d0cabfcb7ce78d83a061138cd70b1cbaae47b648; all eight exact-head checks passed; scoped user disposition of review limitations | [Runtime source access](local-runtime.md#shared-file-and-sqlite-access) |

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
[#29](https://github.com/toddysm/agent-insights/pull/29) now resumes on the
merged runtime/lint baseline under the user's dependency-order request.
The fresh manual test retained execution records but remained partial; runtime
identity and full live compatibility are not established. Separate operation,
identifier, relationship and coverage tasks follow the reader foundation.
This is not Agent Host support. Existing conversation work
[#11](https://github.com/toddysm/agent-insights/issues/11) remains paused pending
separate authorization; no new dependency is added to the Agent Host readers.

| Capability                                                                                                                                                                 | Feature slug            | Tracking issue                                                                                                        | PRD doc                                                                   | Docs                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local, read-only analysis of Visual Studio Code Copilot Chat sessions: timing, tools, tokens, tasks/outcomes, steering, artifacts and prompt coaching with source evidence | vscode-session-analysis | [#2](https://github.com/toddysm/agent-insights/issues/2)                                                              | [Issue-backed design](https://github.com/toddysm/agent-insights/issues/2) | Capture prerequisites [#1](https://github.com/toddysm/agent-insights/issues/1) and final usage guide [#21](https://github.com/toddysm/agent-insights/issues/21) remain incomplete |
| Extension-export reader foundation and qualification                                                                                                                       | vscode-session-analysis | [#10](https://github.com/toddysm/agent-insights/issues/10) / [#29](https://github.com/toddysm/agent-insights/pull/29) | Approved refinement revision 14 in #2                                     | Format reader and CLI integration present; live compatibility remains partial. Follow-up classification/coverage fixes are not claimed implemented.                               |
| Bounded streaming of large JSONL exports and original-evidence pages | vscode-session-analysis | [#45](https://github.com/toddysm/agent-insights/issues/45) | Approved streaming scope and thresholds, revision 15 in #2 | [Scan limits and usage](local-runtime.md#scan-large-jsonl-captures-in-place), [contracts](evidence-contracts.md#execution-reader-behavior); implementation/qualification In progress, private-capture qualification separately gated |

At #35 head `7ef06a70cd1884e3a050f3aba2eef834a93955de`, 91 local
unit/integration/startup tests, six Chromium cases and all four hosted checks
passed. Copilot's initial cleanup-overlap finding was fixed, but its fresh
review found a producer-shutdown race that can recreate write-ahead-log (WAL)
and shared-memory (SHM) files, plus unreadable-WAL error misclassification.
Synthetic probes confirmed that Node read-only/query-only settings and Node
filesystem permission mode do not enforce the no-create guarantee.
Those historical passing checks did not qualify the then-missing native guard.
The guard core, helper protocol and artifact preparation landed in #41/#43/#44;
#35 then replaced the unsafe Node SQLite path and merged its qualified runtime
integration. Its final merge had explicit user acceptance of the disclosed
Codex quota/lifecycle-review limitations; that exception does not transfer to #29.
The historical #35 review lacked Codex quota; that is not a permanent global
review status. Both configured reviewers completed for #40/#41; #43 merged with
its own explicit user exception after green checks and resolved feedback.
No prior quota or security-risk exception carried over to #44; it merged with
both current-head reviews complete and all checks passing.

The user subsequently reviewed #41 and explicitly requested including tooling
item [#42](https://github.com/toddysm/agent-insights/issues/42) in that same pull
request. Its type-aware ESLint configuration, configuration tests and zero-warning
application validation are merged through #41. Actionable findings were
corrected; narrow documented exceptions preserve intentional async and cleanup
contracts rather than introducing a debt baseline. The native review fixes
release idle rollback-mode read locks and distinguish journal presence from
required recovery, while preserving WAL snapshots.

## Planned

| Capability                                                                 | Feature slug            | Tracking issue                                                                                                                                                                                                                                    | PRD doc                                                                               | Documentation status                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copilot Agent Host execution/conversation readers over the shared boundary | vscode-session-analysis | [#30](https://github.com/toddysm/agent-insights/issues/30), [#32](https://github.com/toddysm/agent-insights/issues/32), [#31](https://github.com/toddysm/agent-insights/issues/31) under [#2](https://github.com/toddysm/agent-insights/issues/2) | Native design preserved; #33 is merged, #30 handoff and reader implementation remain  | Extend required capture guide [#1](https://github.com/toddysm/agent-insights/issues/1) and usage guide [#21](https://github.com/toddysm/agent-insights/issues/21); no duplicate documentation item |
| Publish qualified native artifacts                                         | vscode-session-analysis | [#39](https://github.com/toddysm/agent-insights/issues/39)                                                                                                                                                                                        | Follows #38 and #33; separately gated on release approval                             | Real end-user installation verification; required before complete delivery #20                                                                                                                     |
| Explicit hook and unclassified-operation handling                          | vscode-session-analysis | [#46](https://github.com/toddysm/agent-insights/issues/46)                                                                                                                                                                                        | Depends on #10; own event kind and contract/consumer updates                          | Synthetic mapping/accounting regressions and related format docs                                                                                                                                   |
| Optional tool-ID semantics                                                 | vscode-session-analysis | [#47](https://github.com/toddysm/agent-insights/issues/47)                                                                                                                                                                                        | Depends on #10; independent of #46                                                    | Empty/absent versus malformed tests and diagnostic docs                                                                                                                                            |
| Explicit parent-chat relationships                                         | vscode-session-analysis | [#48](https://github.com/toddysm/agent-insights/issues/48)                                                                                                                                                                                        | Depends on #10; preserve own versus parent identity                                   | Relationship/provenance/accounting tests and docs                                                                                                                                                  |
| Evidence-specific coverage and attribution                                 | vscode-session-analysis | [#49](https://github.com/toddysm/agent-insights/issues/49)                                                                                                                                                                                        | Depends on #46/#47/#48                                                                | Coverage/diagnostic UI, contract and browser tests; interpretation docs                                                                                                                            |

These are required adjustments to the existing feature, not optional future
harness support. The guard core, helper protocol and candidate preparation are
merged, including runtime integration; public artifact distribution and Agent Host
readers remain unfinished.

Revision 13 established 24 native children and 38 immediate dependency links,
verified without cycles. The user's later #42 tooling addition brings the
tracker to 25 children without adding native prerequisite edges. The execution
order remains #36 -> #37 -> #38 -> #33 ->
#39 -> complete delivery #20. Existing #1/#21 remain the documentation items.
The user reactivated #10/#29 and approved #46/#47/#48, then #49 for the
extension-export refinement; #45 remains separate. These add no dependency
from the Agent Host readers to the unmerged extension reader.
Local conversation #11 remains paused; #12/#14 no longer
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
not source-specific accounting. Its integrated native helper uses a pinned SQLite
engine, a virtual file system (VFS) policy and audited operating-system call
guards, including internal SHM operations. It preserves SQLite locking and
permits only existing-file access and bounded existing-SHM coordination.
Missing or unqualified enforcement disables SQLite explicitly, with no
unguarded or copied-database fallback. Existing file-only behavior remains.
Rust/C tooling is required for native development; verified per-platform
artifacts remain delivery work. Development tooling is not a shipped end-user
installation path. The initial native qualification targets
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

| Capability                                                           | Feature slug            | Tracking issue                                             | Reason                                                                                                                                                  |
| -------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual corrections to inferred session interpretations               | vscode-session-analysis | [#5](https://github.com/toddysm/agent-insights/issues/5)   | Deferred standalone idea, not a required child or dependency of the initial read-only feature; no future correction design is approved                  |
| Local saved-chat conversation formats                                | vscode-session-analysis | [#11](https://github.com/toddysm/agent-insights/issues/11) | Open supplemental work, not the primary Agent Host conversation reader or a required blocker                                                            |
| VS Code Agent Debug Log execution adapter qualification              | vscode-session-analysis | [#27](https://github.com/toddysm/agent-insights/issues/27) | A particular export adapter is deferred, not Agent Host support. #30 must revisit this deferral if the adapter is needed for the qualified primary path |
| Optional Agent Host per-call telemetry and effective capture routing | vscode-session-analysis | [#34](https://github.com/toddysm/agent-insights/issues/34) | Unverified follow-up, not passed or required for native history/retained turn-usage analysis; new capture activity requires specific authorization      |

## Known gaps & debt

| Gap                                                                                                                 | Evidence and next work                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native foundations and runtime integration are merged; public distribution and Agent Host readers remain incomplete | #41 completed #36/#42, #43 completed #37, #44 completed #38 and [#35](https://github.com/toddysm/agent-insights/pull/35) completed #33. Release #39 needs separate permission. Source qualification and Agent Host readers remain separate; optional telemetry remains #34. #10/#29 resumes as the dependency for the approved extension-reader refinements #46-#49, not as Agent Host support. |
| Current prototype still contains superseded editing flows                                                           | Align the historical prototype with experience revision 2 through [#3](https://github.com/toddysm/agent-insights/issues/3); do not treat those controls as product requirements                                                                                                                                                                                                                 |
| Conversation readers, reports and interpretation definitions remain incomplete                                      | The execution reader and transport are available; missing consumers are reported explicitly. Delivery remains In progress under [#2](https://github.com/toddysm/agent-insights/issues/2)                                                                                                                                                                                                        |
| End-user capture and usage documentation is not complete                                                            | Deliver [#1](https://github.com/toddysm/agent-insights/issues/1) and [#21](https://github.com/toddysm/agent-insights/issues/21), verified against supported captures and the shipped application                                                                                                                                                                                                |
