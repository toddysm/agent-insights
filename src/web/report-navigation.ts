/** Resolve read-scoped report navigation and exact original anchors, never nearest-record fallbacks. */
import {
  evidenceReferenceKey,
  type EvidenceReference,
  type ReadView,
} from "../evidence/contracts.js";
import type { ReportMeasurement } from "../metrics/report.js";

/** Only application-owned panels are routable; IDs always belong to one read and session. */
export interface ReportRoute {
  readonly readId: string;
  readonly sessionId: string;
  readonly panel: "metric" | "event" | "coverage" | "activity";
  readonly id: string;
  readonly from: string;
}

/** Encode identifiers, not captured text/commands, in transient browser navigation. */
export function reportHash(route: ReportRoute): string {
  return `#report?${new URLSearchParams({
    read: route.readId,
    session: route.sessionId,
    panel: route.panel,
    id: route.id,
    from: route.from,
  }).toString()}`;
}

/** Return null for no report route; invalid report links throw instead of selecting other evidence. */
export function parseReportHash(hash: string): ReportRoute | null {
  if (hash === "#session-report" || !hash.startsWith("#report")) return null;
  if (!hash.startsWith("#report?"))
    throw new Error(
      "This report link is invalid. No evidence was substituted.",
    );
  const query = new URLSearchParams(hash.slice("#report?".length));
  const allowed = ["read", "session", "panel", "id", "from"];
  if (
    [...query.keys()].some(
      (key) => !allowed.includes(key) || query.getAll(key).length !== 1,
    )
  )
    throw new Error("This report link contains invalid controls.");
  const readId = query.get("read");
  const sessionId = query.get("session");
  const panel = query.get("panel");
  if (
    !readId ||
    !sessionId ||
    !["metric", "event", "coverage", "activity"].includes(panel ?? "")
  )
    throw new Error(
      "This report link is incomplete. Select a current session.",
    );
  if (
    panel !== "metric" &&
    panel !== "event" &&
    panel !== "coverage" &&
    panel !== "activity"
  )
    throw new Error("This report panel is unavailable.");
  const id = query.get("id") ?? "";
  const from = query.get("from") ?? "";
  if (
    ((panel === "metric" || panel === "event") && !id) ||
    ((panel === "coverage" || panel === "activity") && (id || from)) ||
    (panel === "metric" && from)
  )
    throw new Error("This report link has an invalid evidence scope.");
  return { readId, sessionId, panel, id, from };
}

/** Match all original-location fields, not just a colliding record ID or native event ID. */
export function contributingEvents(
  view: ReadView,
  sessionId: string,
  measurement: ReportMeasurement,
): ReadView["events"] {
  const references = new Set(
    measurement.metric.contributors.map(evidenceReferenceKey),
  );
  return view.events.filter(
    (event) =>
      event.sessionId === sessionId &&
      event.references.some((reference) =>
        references.has(evidenceReferenceKey(reference)),
      ),
  );
}

/** Retain source witnesses without normalized content as anchors, not fabricated conversation records. */
export function unmatchedReferences(
  view: ReadView,
  sessionId: string,
  references: readonly EvidenceReference[],
): readonly EvidenceReference[] {
  const known = new Set(
    view.events
      .filter((event) => event.sessionId === sessionId)
      .flatMap((event) => event.references.map(evidenceReferenceKey)),
  );
  return references.filter(
    (reference) => !known.has(evidenceReferenceKey(reference)),
  );
}
