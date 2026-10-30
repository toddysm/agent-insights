# Project state

Capability inventory as of 2026-10-30. This records project delivery status,
not session data or analysis results.

The code baseline is main at `2f9d85cb4658300279e0a5e2e526b4d6ec62fe74`.
The current plan is lightweight design revision 5 in
[#2](https://github.com/toddysm/agent-insights/issues/2), with experience
revision 2 in [#3](https://github.com/toddysm/agent-insights/issues/3).
The user approved the plan, runtime baseline and unattended review/merge scope
on 2026-10-30, followed by configurable Copilot-first analysis and disclosed
remote processing. Interpretation rules and backend qualification remain gated.

Tracking currently uses GitHub issues and native sub-issues/dependencies.
GitHub Project access is unavailable; no board status is claimed.

## Implemented

No production session-analysis capability has shipped.

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
[evidence contracts](evidence-contracts.md) are implemented. No real-session
reader, report or model-analysis capability has shipped.

| Capability                                                                                                                                                                 | Feature slug            | Tracking issue                                           | PRD doc                                                                   | Docs                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local, read-only analysis of Visual Studio Code Copilot Chat sessions: timing, tools, tokens, tasks/outcomes, steering, artifacts and prompt coaching with source evidence | vscode-session-analysis | [#2](https://github.com/toddysm/agent-insights/issues/2) | [Issue-backed design](https://github.com/toddysm/agent-insights/issues/2) | Capture prerequisites [#1](https://github.com/toddysm/agent-insights/issues/1) and final usage guide [#21](https://github.com/toddysm/agent-insights/issues/21) remain incomplete |

## Planned

| Capability | Feature slug | Tracking issue | PRD doc | Documentation status |
| ---------- | ------------ | -------------- | ------- | -------------------- |

No additional production capability is currently scheduled outside this build.

The tracker links 16 new A-P work items plus the existing capture and experience
items: 18 required native children, with 25 immediate dependency links.
The detailed acceptance criteria and dependency order live in those issues.

Harness-owned data is the sole evidence authority. The approved initial scope
reads sources in place and analyzes them transiently in memory. It excludes an
application-owned session database, persistent raw/normalized replicas, saved
analysis history, archives, synchronization, manual corrections and independent
live artifact-verification inputs.

The runtime/source workflow decision in
[#6](https://github.com/toddysm/agent-insights/issues/6) is approved.
The provider/data portion of
[#7](https://github.com/toddysm/agent-insights/issues/7) now approves Copilot first
and remote processing with explicit user awareness. Its completion/rubric rules
remain open. Model execution still requires the qualified adapter and user action;
source selection/refresh does not transmit content. GitHub-hosted validation
remains the selected testing mode.

## Deferred / Won't do

| Capability                                             | Feature slug            | Tracking issue                                           | Reason                                                                                                                                 |
| ------------------------------------------------------ | ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Manual corrections to inferred session interpretations | vscode-session-analysis | [#5](https://github.com/toddysm/agent-insights/issues/5) | Deferred standalone idea, not a required child or dependency of the initial read-only feature; no future correction design is approved |

## Known gaps & debt

| Gap                                                                      | Evidence and next work                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current prototype still contains superseded editing flows                | Align the historical prototype with experience revision 2 through [#3](https://github.com/toddysm/agent-insights/issues/3); do not treat those controls as product requirements                  |
| Real-session readers, reports and model analysis are not implemented yet | The local shell reports missing capabilities explicitly; delivery remains In progress under [#2](https://github.com/toddysm/agent-insights/issues/2)                                             |
| End-user capture and usage documentation is not complete                 | Deliver [#1](https://github.com/toddysm/agent-insights/issues/1) and [#21](https://github.com/toddysm/agent-insights/issues/21), verified against supported captures and the shipped application |
