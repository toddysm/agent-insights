# agent-insights

Project for analyzing the usage of Copilot AI agents.

## Experience design

The [session-insights HTML walkthrough](design/session-insights/index.html)
uses synthetic data to explore the proposed report and evidence drill-downs.
Open it locally in a browser; no backend or build is required.
See the [walkthrough guide](design/session-insights/README.md) for scenarios,
limitations, and validation instructions.

## Implementation

The first production foundation is the
[in-memory evidence contract](docs/evidence-contracts.md). Source readers,
the local application and model analysis are not implemented yet.
See the [capability inventory](docs/project-state.md) for the current plan.

To validate the contracts with Node.js 24:

```bash
npm ci --ignore-scripts
npm run check
npm test
```
