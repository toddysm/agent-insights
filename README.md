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
Real source readers, report views and model analysis are not installed yet;
the interface reports those capabilities as unavailable rather than showing
example data.
See the [capability inventory](docs/project-state.md) for the current plan.

To validate the contracts with Node.js 24:

```bash
npm ci --ignore-scripts
npm run check
npm test
```

To open the local interface:

```bash
npm run build
npm start -- --source /path/to/private/captures
```

Open the full, private launch URL printed by the server.
Copilot is the first planned analysis backend. When enabled, it sends selected
content to a remote service; a local harness is not on-device inference.
See the [runtime and privacy guide](docs/local-runtime.md) before using analysis.
