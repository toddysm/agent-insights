# Session-insights experience walkthrough

An interactive, **synthetic, read-only revision-2 prototype** for
[#3](https://github.com/toddysm/agent-insights/issues/3), part of
[#2](https://github.com/toddysm/agent-insights/issues/2).
It is not the production analyzer. Prototype alignment does not approve the
experience: #3 stays open until the user reviews and explicitly approves it.
The historical revision-1 prototype merged in #4 is superseded by this version.

Use only the approved project name and plain functional labels. Do not add
unapproved branding, lab names or taglines.

## Open it locally

Open [index.html](index.html) directly in a modern browser. On macOS, from the
repository root:

```bash
open design/session-insights/index.html
```

Keep [index.html](index.html), [styles.css](styles.css), [model.js](model.js),
and [app.js](app.js) together. No server, dependency installation, build,
account or model connection is needed to view the prototype.
GitHub displays HTML source rather than rendering the walkthrough.

Start with **Session report**. The initial fixture includes canned interpretations,
not the result of an automatic analysis. **Load a fresh example** selects a
scenario. **Reset synthetic example** or reloading restores the original fixture.
Navigation preserves view filters and scroll position; opening a detail moves
focus to its title, and closing it restores the originating control when present.
The evidence panel stays beside the report on desktop and fills a narrow screen.
Escape closes it.

## Suggested walkthrough

| Scenario | Try this | What to inspect |
| --- | --- | --- |
| S1: open evidence | Select the first-source scenario, open an example, try unsupported format, recover, and search the session list. | Explicit selection, no automatic scanning or copying; honest failures and capture help. |
| S2: report | Read the outcome summary and task table; open task/completion contributors and task detail. | Recorded facts versus inferred boundaries, source acceptance versus agent claims, source scope/read time. |
| S3: steering | Click Human steering, select U08, inspect before/after, expand Why this category?, and follow related tool evidence. | Four distinct messages; U08 has two tags but contributes once. No classification edits. |
| S4: artifacts | Filter Temporary helper, inspect the create/delete lifecycle and purpose rationale; then inspect the shared test file. | Six unique artifacts versus seven task associations; purpose is inferred and read-only, not live verification. |
| S5: resources | Open the token ledger, inspect a request, then inspect the activity lanes and Tools & commands. | Input/output separation, overlapping execution, recorded/inferred/unavailable states, full commands/arguments and missing-input limitations; analysis usage stays separate. |
| S6: prompts | Inspect a task prompt, inherited context and the later clarification; copy the read-only suggested rewrite. | Canned model judgments, submission-time rating context, learned clarifications separated from suggested assumptions. |
| S8: limitations | Select incomplete evidence, analysis-disabled, source-changed and source-unavailable scenarios. | Unavailable is not zero; a failed read shows no cached report or archived evidence. |

W6/S7 manual corrections are explicitly excluded. There are no task rename,
merge, split, exclusion, boundary, outcome, category, purpose or rating editors;
no dashboard confirmation of findings; and no save-correction controls.
Original human corrections in the transcript still count as steering evidence.
Deferred idea [#5](https://github.com/toddysm/agent-insights/issues/5) is not
a prerequisite.

### Activity and command details

The report timeline has five lanes. Every lane opens its definition and exact
synthetic contributors:

- **Model processing / thinking — Recorded:** 14 minutes of request boundaries.
  Includes network, queueing and generation, not measured private reasoning.
- **Executing work — Recorded:** 6 minutes of tool spans, including tool waits.
  Two minutes overlap model processing: execution union remains **18 minutes**,
  not 20. The cumulative spans remain 20 minutes.
- **Waiting for you — Recorded:** 4 minutes between an explicit approval
  request and response, shown as source records H01/H02.
- **Session quiet / idle — Inferred:** 6 minutes supported by open-session
  lifecycle records with no pending work/input request. This describes the
  session, not human reading, typing or absence.
- **Unknown / unobserved — Unavailable classification:** 14 minutes lacking
  enough evidence to classify. Never relabel silence as measured idle time.

The session is still 42 minutes long, with 24 minutes outside recorded
execution. These new state fixtures illustrate the user-approved walkthrough
feedback; they do not prove that a production harness exposes these events.
Linked request/tool records expose the recorded start/end minute offsets that
support each execution span. Records without captured boundaries say timing is
unavailable; duration or token counts alone do not place a record on the timeline.
Incomplete evidence omits lifecycle coverage: waiting/quiet become unavailable
and 24 minutes stay unknown. Transcript-only capture has no execution timing;
the entire observed window is unclassified, not zero runtime.

**Tools & commands** is available in navigation and the report header/metric.
It lists all 27 invocations and 8 distinct tool names, with a tool filter.
Select **Inspect full input** for a shell's complete captured multiline command,
working directory, stdout, stderr and exit code; non-shell tools show structured
arguments, including paths/ranges or the full captured patch.
Inputs are escaped text, never executed, evaluated or fetched.
Missing (C22), truncated (C10) and harness-redacted (C25) inputs are labeled;
the UI does not reconstruct the hidden remainder. Partial captures preserve
invocation metadata without inventing arguments/results.
Task-scoped metric drill-downs still retain their task scope.

### Source refresh and analysis lifecycle

1. Select **Analysis not enabled**. Recorded tool/timing/usage metrics remain
   accessible while task/steering interpretations are unavailable.
2. Open **Analysis setup**. Inspect the selected session/source read, content
   categories and product destination: Copilot/remote processing. The prototype
   itself sends nothing. Decline with Cancel, or acknowledge the disclosed scope
   and select **Start simulated analysis**.
3. The simulation remains running until you explicitly choose **Show synthetic
   completion**, **Simulate analysis failure**, or **Cancel analysis**. These
   are reviewer controls, not corrections to findings. Closing the panel does
   not cancel a run; recorded metrics remain accessible.
4. Fail or cancel, then explicitly retry through Analysis setup. No successful
   interpretations appear after failure/cancellation. Actual analysis requests
   made by this prototype are always zero; a product retry may incur separate
   analysis usage. The artifact inventory temporarily ignores purpose/task
   filters when analysis is unavailable, showing all recorded identities.
   Previous selections return only after successful analysis.
5. While a run is open, close the panel and select **Refresh source**. This
   increments the synthetic source read/time, discards interpretations and
   supersedes the older run. Refresh never starts analysis. Old read-tagged
   evidence links become explicitly unavailable rather than showing a newer
   record as the original.
6. Try unavailable/changed-source scenarios. No report totals or archived
   evidence remain accessible. **Retry synthetic read** illustrates a harness
   source becoming available again; it is not restoration from a retained copy.
   Reanalysis still requires a separate acknowledged action.

Harness-owned evidence is the product's only authority. Source selection,
refresh and read-only filters do not modify it. No application session database,
normalized replica, annotations, archive, synchronization or saved report history
is part of this experience. Restarting discards transient results; historical
access depends on the harness retaining evidence.

## Metric-to-evidence contract

| Report element | Contributor route | Original evidence / limitation |
| --- | --- | --- |
| Tasks / completion | Inspect inferred tasks or completion evidence, then task and Inspect outcome evidence | Original request, inferred segment, captured changes/test results, or exact C02 human acceptance. Agent claims alone do not prove completion. |
| Steering | Count, distinct-message list, selected message | Exact instruction and before/after context; category rationale and related tool result. Multiple tags count once. |
| Artifacts / purpose | Count or inventory, filters, selected identity | Captured lifecycle/tool results and inferred-purpose rationale; shared identity counts once per session. A mention is not confirmed creation. |
| Tools / distinct tools | Tools & commands or count, invocation list, full input | Tool identity, complete captured command/arguments, working directory, output, exit code and source reference; missing/truncated/redacted stays explicit. A shell call is not every program executed inside it. |
| Input/output tokens | Token count, model-call ledger, selected request | Exact synthetic usage record, model/task attribution and coverage; do not sum parent checkpoints again. |
| Elapsed / active time / states | Inspect time or a labeled timeline lane | Captured boundaries, overlapping intervals, request/response and lifecycle evidence; 18m union differs from 20m cumulative spans. Quiet is inferred; unsupported gaps stay unknown. |
| Human typing | Unavailable explanation | No typing-start evidence; submission timestamps cannot measure typing duration. |
| Prompt assessment | Prompt coaching, original/inherited context, clarification | Canned model judgment and draft rubric, not an objective score or proof that a prompt caused agent failure. |
| Coverage / unavailable values | Inspect source coverage or the affected metric | Missing fields/capabilities, selected source/read time and capture prerequisites. Missing usage is not zero. |

The complete example contains three tasks, two completed outcomes, four steering
messages, six unique artifacts, 27 tool calls, 12,400 input and 1,800 output tokens.
Observed elapsed time is 42 minutes; active interval union is 18 minutes, leaving
24 minutes outside execution (4 waiting, 6 inferred session quiet, 14 unknown).
One shared test file produces seven task/artifact
associations. T2's **Source acceptance** opens exact synthetic human record C02,
not a confirmation entered through the dashboard.
T1's completion-evidence link opens C14's explicit synthetic passing-test
result alongside its recorded helper deletion, not just a generic success label.

Local hash links can reopen task/evidence views, for example
[the CSV task's steering evidence](index.html#task/t1?panel=steering&task=t1).
Links describe the current transient fixture, not saved history.
User-opened details include a source-read tag. Read identities increase across
refreshes and source replacements within the open page; stale tags and unknown
records produce explicit unavailable states. Original session/task instruction
anchors stay distinct.

## Real behavior and boundaries

Working behavior includes navigation, keyboard/focus continuity, read-only
filters, numeric reconciliation, drill-downs, source/read invalidation and an
explicitly stepped analysis lifecycle. All sources, paths, prompts, model
names, acceptance messages and results are fictional.

There are **no real source readers, model calls, credentials, billing,
asynchronous model jobs, persistent storage, live artifact verification or
editor-setting changes** in this prototype. The missing-source scenarios hide
bundled fixture evidence; they do not prove production file-access safety.
The one-segment tasks do not qualify production interrupted-task inference.
Analysis output is canned, not recalculated.

No page code requests network content, sends telemetry, loads remote fonts,
reads captures or calls a model. Content Security Policy blocks connections.
Opening explicit help/GitHub links is user navigation, not a verification
input to the report. See the [capture guide](../../docs/capture-setup.md)
for Agent Host-first setup and remaining product qualification gates.

## Validate the mockups

Viewing requires no tooling. Development checks require Node.js 24 or newer:

```bash
cd design/session-insights
npm ci --ignore-scripts
npx playwright install chromium firefox webkit
npm test
```

The scoped package is test tooling only; no application dependencies change.
Linux may need Playwright's `--with-deps` browser-install option.

- [Model tests](tests/model.test.cjs) verify reconciliation, partial coverage,
  explicit acknowledgment, failure/cancellation, superseded runs and stale results.
- [Browser tests](tests/walkthrough.spec.cjs) load the actual `file://` HTML in
  Chromium, Firefox and WebKit. They check S1-S6/S8, absence of correction surfaces,
  original acceptance, refresh/recovery, safe invalid links, keyboard/narrow
  layouts and absence of unexpected errors or remote requests.
- The [workflow](../../.github/workflows/design-mockups.yml) runs these checks
  and uploads synthetic screenshots/reports/failure traces for seven days.

After a run, inspect browser results with `npx playwright show-report`.
Passing prototype tests is not real-capture qualification, user experience
approval or completion of the production reporting work in #14.
