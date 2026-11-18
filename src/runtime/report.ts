/** Adapt pure recorded metrics for display; reject stale/foreign selections without reading sources. */
import type { ReadView } from "../evidence/contracts.js";
import {
  calculateRecordedMetrics,
  type RecordedMetric,
} from "../metrics/recorded.js";
import type {
  ReportRequest,
  ReportMeasurement,
  SessionReport,
} from "../metrics/report.js";
import { RuntimeError } from "./errors.js";

/**
 * Compute one current session report without inference, source I/O or retained history.
 * Reject missing/replaced reads and unknown sessions with controlled navigation errors.
 */
export function recordedReport(
  view: ReadView | null,
  selection: ReportRequest,
): SessionReport {
  if (!view || view.id !== selection.readId)
    throw new RuntimeError(
      "REPORT_STALE",
      "This read is no longer available. Read the selected sources again; no saved report is retained.",
      409,
    );
  if (!view.sessions.some((session) => session.id === selection.sessionId))
    throw new RuntimeError(
      "REPORT_SESSION_UNAVAILABLE",
      "This session is not in the selected read. No other session was substituted.",
      404,
    );
  const result = calculateRecordedMetrics(view, {
    sessionId: selection.sessionId,
  });
  const measurements: ReportMeasurement[] = [];
  /** Attach presentation metadata while preserving the calculator's exact scope and provenance. */
  function add(
    id: string,
    label: string,
    group: ReportMeasurement["group"],
    value: RecordedMetric,
    display: ReportMeasurement["display"] = "number",
  ): void {
    measurements.push({ id, label, group, display, ...value });
  }
  add(
    "elapsed",
    "Observed elapsed",
    "Timing",
    result.timing.elapsed,
    "duration",
  );
  add(
    "activity",
    "Recorded agent activity",
    "Timing",
    result.timing.agentActivity,
    "duration",
  );
  add(
    "cumulative",
    "Cumulative spans (overlap included)",
    "Timing",
    result.timing.cumulativeSpanDuration,
    "duration",
  );
  add(
    "gaps",
    "Unobserved gaps",
    "Timing",
    result.timing.unobservedGaps,
    "duration",
  );
  add(
    "start",
    "First captured timestamp",
    "Timing",
    result.timing.observedStart,
    "timestamp",
  );
  add(
    "end",
    "Last captured timestamp",
    "Timing",
    result.timing.observedEnd,
    "timestamp",
  );
  add("tools", "Tool calls", "Tools", result.tools.calls);
  result.tools.identities.forEach((tool, index) => {
    add(`tool-${index}`, tool.name ?? "Unknown tool", "Tools", tool.calls);
  });
  add("input", "Recorded input tokens", "Recorded tokens", result.tokens.input);
  add(
    "output",
    "Recorded output tokens",
    "Recorded tokens",
    result.tokens.output,
  );
  result.tokens.components.forEach((component, index) => {
    add(
      `component-${index}`,
      `${component.name} (${component.relation}; not added to totals)`,
      "Recorded tokens",
      component.tokens,
    );
  });
  result.tokens.observations.forEach((observation, index) => {
    const label = `${observation.model ?? "Unknown model"} / ${observation.basis} / ${observation.accountingScope}`;
    add(
      `observation-${index}-input`,
      `${label}: input`,
      "Usage observations",
      observation.input,
    );
    add(
      `observation-${index}-output`,
      `${label}: output`,
      "Usage observations",
      observation.output,
    );
    observation.components.forEach((component, componentIndex) => {
      add(
        `observation-${index}-component-${componentIndex}`,
        `${label}: ${component.name} (${component.relation})`,
        "Usage observations",
        component.tokens,
      );
    });
  });
  return {
    readId: view.id,
    sessionId: selection.sessionId,
    measurements,
    exclusions: result.exclusions,
  };
}
