# Session-insights experience walkthrough

An interactive, **synthetic design prototype** for
[#3](https://github.com/toddysm/agent-insights/issues/3), part of
[#2](https://github.com/toddysm/agent-insights/issues/2).
It is not the production analyzer and does not imply approval of the experience
or a production technology stack.

## Open it locally

Open [index.html](index.html) directly in a modern browser. On macOS, from the
repository root:

```bash
open design/session-insights/index.html
```

On Windows or Linux, open the same file with your browser using the file manager.
Keep [index.html](index.html), [styles.css](styles.css), [model.js](model.js), and
[app.js](app.js) together. No server, dependency installation, build, account, or
model connection is needed to view the mockups. GitHub displays the HTML source;
check out the pull-request branch to walk through the rendered experience.

Start with **Session report**. Use **Load a fresh example** in the sidebar to
follow a scenario. The main navigation preserves your current demo edits;
loading a scenario, **Reset all demo changes**, or reloading the page restores
synthetic fixture state.

## Suggested walkthrough

| Scenario        | Try this                                                                                                              | What to inspect                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| S1: import      | Load the first-session scenario, import an example, try the unsupported-format error, then recover.                   | Selected scope, honest import failures, capture help. No real files are read.                              |
| S2: report      | Read the outcome summary, task table, time panel, and resource metrics.                                               | Distinct evidence statuses and numbers that lead somewhere.                                                |
| S3: steering    | Click Human steering, select U08, inspect before/after, then change its category to New requirement.                  | Two tags originally count as one message; the headline changes from four to three.                         |
| S4: artifacts   | Filter Temporary helper, inspect the create/delete lifecycle, and correct a purpose label.                            | Six unique artifacts versus seven task associations; deleted helpers remain inspectable.                   |
| S5: resources   | Open the token ledger, inspect a request, return to the same scope, then inspect time.                                | Input/output separation, missing usage, interval overlap, and unobserved gaps.                             |
| S6: prompts     | Inspect a task prompt, expand inherited context, follow the clarification, and copy a suggested rewrite.              | Canned ratings are explicitly illustrative; rewrites do not execute.                                       |
| S7: corrections | Rename or correct an outcome; select two tasks to merge, or one to split/adjust segments. Exclude and restore a task. | Changes persist during navigation, source totals are preserved, and affected assessments are marked stale. |
| S8: limitations | Load incomplete evidence or analysis-disabled scenarios. Cancel analysis setup or explicitly show canned results.     | Unavailable is not zero; declining analysis preserves recorded evidence.                                   |

The report, task details, evidence drawer, artifact inventory, prompt coaching,
correction forms, and limited-data states correspond to W0-W7 in the design
issue. On desktop, the evidence drawer keeps the report visible. On narrow
screens it occupies the viewport. Escape closes it; focus returns to its
originating control when that control still exists.

Local hash links can reopen original task/evidence views, for example
[the CSV task's steering evidence](index.html#task/t1?panel=steering&task=t1).
Links to user-created split/merged tasks only work in the current in-memory
demo state. Reset links produce an explicit unavailable-view message rather
than opening another task.

## What is real here, and what is simulated?

**Working prototype behavior**

- Local navigation, metric-to-record drill-down, context preservation, and
  keyboard-accessible dialogs.
- Synthetic counting rules, purpose/category corrections, task renaming,
  outcome changes, merging, splitting, segment reassignment, exclusion and
  restoration, and resetting.
- Data-coverage states, explicit errors, and copied rewrite text where browser
  clipboard permissions permit. Otherwise the text is selected for manual copy.

**Not implemented**

- Actual imports, directory discovery, model analysis, credentials, billing,
  persistent storage, external artifact verification, or editor configuration.
- Real provider selection, asynchronous model-job processing/cancellation, or
  recalculated prompt ratings. The analysis control shows canned fixture
  interpretations only. Edited prompt assessments remain clearly marked stale
  until the reviewer chooses to show the canned analysis again.
- Arbitrary session datasets or production-grade task segmentation. Segment
  correction uses one inclusive range in the 28-turn synthetic example; the
  product design also allows interrupted/multiple task segments.

No page code performs network requests, sends telemetry, loads remote fonts,
reads captures, or calls a model. A restrictive content security policy blocks
network connections. Explicitly opening an external help/issue link navigates
to GitHub. All prompts, file paths, evidence, and model names are fictional.

The default fixture has three tasks, two completed outcomes, four steering
messages, six unique artifacts, 27 tool calls, 12,400 input tokens, and 1,800
output tokens. Observed elapsed time is 42 minutes; merged active intervals
cover 18 minutes, while overlapping recorded spans sum to 20 minutes.
Unobserved gaps are not exact human typing or idle time.

## Validate the mockups

Viewing requires no tooling. Development checks require Node.js 24 or newer:

```bash
cd design/session-insights
npm ci --ignore-scripts
npx playwright install chromium firefox webkit
npm test
```

The scoped package is test tooling only; it is not the application's dependency
or architecture decision. Linux environments may need Playwright's
`--with-deps` browser-install option; GitHub Actions uses it.

- [Model tests](tests/model.test.cjs) check numeric reconciliation, duplicate
  intervals, missing evidence, corrections, and invalid inputs.
- [Browser tests](tests/walkthrough.spec.cjs) load the actual HTML using
  `file://` in Chromium, Firefox, and WebKit. They exercise the scenarios,
  check keyboard and narrow-screen behavior, and fail on unexpected browser
  errors or remote requests.
- The [workflow](../../.github/workflows/design-mockups.yml) runs those checks
  on relevant pull requests and publishes synthetic screenshots, reports, and
  failure traces as a seven-day artifact.

To inspect local browser results after a run:

```bash
npx playwright show-report
```

Please review the experience before production engineering resumes. The
prototype pull request references #3 rather than closing its design-approval
gate automatically.
