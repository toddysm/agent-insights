# Project state

Capability inventory as of 2026-11-03. This records project delivery status,
not session data or analysis results.

The merged baseline is main at `d767c31665fffb72154fbccb23ecbd2494072c97`.
The current scope is lightweight revision 8 in
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
the adjustment. Revision 8 captures that source-priority change; its implementation
design is not yet approved. The prior revision-7 approval is historical, not
permission to continue the Local-only source plan unchanged.

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
It is not Agent Host support. Existing conversation work
[#11](https://github.com/toddysm/agent-insights/issues/11) remains paused pending
source qualification and the revised design.

| Capability                                                                                                                                                                 | Feature slug            | Tracking issue                                           | PRD doc                                                                   | Docs                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local, read-only analysis of Visual Studio Code Copilot Chat sessions: timing, tools, tokens, tasks/outcomes, steering, artifacts and prompt coaching with source evidence | vscode-session-analysis | [#2](https://github.com/toddysm/agent-insights/issues/2) | [Issue-backed design](https://github.com/toddysm/agent-insights/issues/2) | Capture prerequisites [#1](https://github.com/toddysm/agent-insights/issues/1) and final usage guide [#21](https://github.com/toddysm/agent-insights/issues/21) remain incomplete |

## Planned

| Capability | Feature slug | Tracking issue | PRD doc | Documentation status |
| ---------- | ------------ | -------------- | ------- | -------------------- |
| Copilot Agent Host source qualification and read-only execution/conversation readers | vscode-session-analysis | [#30](https://github.com/toddysm/agent-insights/issues/30), [#32](https://github.com/toddysm/agent-insights/issues/32), [#31](https://github.com/toddysm/agent-insights/issues/31) under [#2](https://github.com/toddysm/agent-insights/issues/2) | Revision 8 scope captured; qualified implementation design pending #30 and human approval | Extend required capture guide [#1](https://github.com/toddysm/agent-insights/issues/1) and usage guide [#21](https://github.com/toddysm/agent-insights/issues/21); no duplicate documentation item |

These are required adjustments to the existing feature, not optional future
harness support. No new implementation has started.

The tracker links the original A-P work, existing capture/experience items and
three Agent Host items: 21 required native children, with 36 immediate dependency links.
The detailed acceptance criteria and dependency order live in those issues.

The earlier #10/#11 plan targets the OpenTelemetry extension export and saved
chat v3/mutation sources. These are not assumed to be Agent Host evidence.
Qualification #30 must identify authoritative sources, supported versions, capture
and retention behavior, and reuse/disposition of that earlier work. It precedes
the new execution/conversation readers and final capture instructions. Existing
discovery #12 and reporting #14 now require both Agent Host readers; delivery #20
must verify the actual Agent Host path with producer-generated evidence.

Harness identity is separate from Ask/Agent mode, local execution location and
the Copilot CLI analysis executor. Do not require switching to Local or bypassing
managed sandbox/permission policy to satisfy the primary workflow.

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
| VS Code Agent Debug Log execution adapter qualification | vscode-session-analysis | [#27](https://github.com/toddysm/agent-insights/issues/27) | A particular export adapter is deferred, not Agent Host support. #30 must revisit this deferral if the adapter is needed for the qualified primary path |

## Known gaps & debt

| Gap                                                                      | Evidence and next work                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent Host source compatibility and implementation design are unqualified | Complete #30 and approve the revised design before #32/#31 implementation. An enabled Local exporter or empty capture is not Agent Host verification |
| Current prototype still contains superseded editing flows                | Align the historical prototype with experience revision 2 through [#3](https://github.com/toddysm/agent-insights/issues/3); do not treat those controls as product requirements                  |
| Real-session readers, reports and interpretation definitions are not implemented yet | The transport is available, but the local shell reports missing consumers explicitly; delivery remains In progress under [#2](https://github.com/toddysm/agent-insights/issues/2) |
| End-user capture and usage documentation is not complete                 | Deliver [#1](https://github.com/toddysm/agent-insights/issues/1) and [#21](https://github.com/toddysm/agent-insights/issues/21), verified against supported captures and the shipped application |
