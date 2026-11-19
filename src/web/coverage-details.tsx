/** Render qualified-reader field availability separately from capture history and linkage. */
import type { ReactElement } from "react";
import type { ReadView } from "../evidence/contracts.js";

/** Source-wide retained fields are not selected-session totals or complete-capture claims. */
export function SourceCoverageDetails({
  details,
}: {
  readonly details: NonNullable<ReadView["sources"][number]["coverageDetails"]>;
}): ReactElement {
  const entries = [
    ["Retained execution timestamps", details.retainedTiming],
    ["Chat usage", details.chatUsage],
    ["Embedding usage", details.embeddingUsage],
    ["Session attribution", details.sessionAttribution],
    ["Source/session history", details.history],
  ] as const;
  return (
    <div role="group" aria-label="Scoped evidence coverage">
      <h4>Field availability and capture scope</h4>
      <p>
        Source-wide retained fields, not selected-session totals. Complete
        timestamps for retained executions do not prove complete session capture.
        Direct membership, explicit parent association and unassigned evidence
        remain separate.
      </p>
      <dl>
        {entries.map(([label, coverage]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {coverage.status}
              {coverage.status !== "complete" && `: ${coverage.reason}`}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Preserve legacy messages; scoped diagnostics label severity (or its absence), dimensions and scope. */
export function DiagnosticMessage({
  issue,
}: {
  readonly issue: ReadView["issues"][number];
}): ReactElement {
  return (
    <>
      <span>{issue.message}</span>
      {issue.impact && (
        <small>
          {" "}({issue.severity ?? "severity unreported"}; {issue.impact.scope};{" "}
          {issue.impact.dimensions.length
            ? issue.impact.dimensions.join(", ")
            : `${issue.impact.scope} only`})
        </small>
      )}
    </>
  );
}
