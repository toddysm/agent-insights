# agent-insights

Project for analyzing the usage of Copilot AI agents.

## Experience design

The [session-insights HTML walkthrough](design/session-insights/index.html)
uses synthetic data to explore the proposed report and evidence drill-downs.
Open it locally in a browser; no backend or build is required.
See the [walkthrough guide](design/session-insights/README.md) for scenarios,
limitations, and validation instructions.

## Implementation

The [local runtime](docs/local-runtime.md) provides a loopback-only source
interface and read-only access boundary, built on the
[in-memory evidence contract](docs/evidence-contracts.md).
The [Copilot analysis transport](docs/copilot-analysis.md) adds acknowledged,
memory-only model execution. Real source readers, report views and interpretation
definitions are not installed yet; the interface reports those capabilities as
unavailable rather than showing example data.
Visual Studio Code Copilot Chat remains the first capture source. Copilot CLI is
the analysis executor, not the first history source being imported; see the
[source/executor distinction](docs/copilot-analysis.md#vs-code-evidence-and-the-analysis-executor-are-different).
See the [capability inventory](docs/project-state.md) for the current plan.

Native source-safety work lives in the
[Rust guard crate](native/sqlite-guard/README.md), including guarded existing-file
reads and native qualification tests. The helper protocol, artifact delivery and
Node integration remain separate work; this does not change installed reader availability.

To validate the implementation with Node.js 24:

```bash
npm ci --ignore-scripts
npm run lint
npm run test:lint
npm run check
npm test
```

ESLint uses [flat configuration](eslint.config.js), recommended JavaScript rules,
type-aware TypeScript rules for the compiler project, and recommended React
Hooks rules. Generated build, native target and browser-report files are ignored.
Application continuous integration runs lint with zero warnings allowed.

The initial lint findings were corrected rather than stored in a debt baseline.
Documented exceptions preserve intentional contracts: synchronous test doubles
may keep async signatures; the in-memory SDK adapter and byte-stream adapter
retain asynchronous rejection/iteration without artificial waits; cleanup failure
may deliberately override success or cancellation. Object-rest omissions are
allowed for stripping credentials. Other type-aware checks remain enabled,
including floating promises except the known-safe `node:test` registrations.
Configuration tests check both accepted fixtures and rejected floating promises.

To open the local interface from a fresh checkout:

```bash
npm ci --include=dev --ignore-scripts
npm start -- --source /path/to/private/captures
```

`npm start` builds the current source before launching. Build output is not
stored in Git, and each checkout needs its own dependency installation.
`npm run build` remains available as an explicit build command.

Open the full, private launch URL printed by the server.
Copilot is the first analysis backend. After acknowledgement, it sends selected
content to a remote service; a local harness is not on-device inference.
See the [runtime and privacy guide](docs/local-runtime.md) before using analysis.
