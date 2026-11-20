/**
 * Whole-admitted-session report with replace-only physical evidence pages.
 * The browser holds numeric summaries and one bounded page, never a capture/index.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { z } from "zod";
import {
  scanReportSchema,
  scanMetricPageSchema,
  type ScanReportRequest,
  type ScanReport,
  type ScanMetricPage,
} from "../metrics/report.js";
import { scanEnvelopeSchema } from "../evidence/streaming.js";
import { statusSchema } from "../runtime/protocol.js";
import { EvidenceDrawer, metricValue } from "./session-report.js";
import { SourceCoverageDetails, DiagnosticMessage } from "./coverage-details.js";
import {
  parseReportHash,
  reportHash,
  reportHistoryDepth,
  type ReportRoute,
} from "./report-navigation.js";

/** Reuse the authenticated transport and application's source-operation lock. */
interface Props {
  readonly selection: ScanReportRequest;
  readonly send: <T>(
    route: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ) => Promise<T>;
  readonly onBusy: (busy: boolean) => void;
}

/** Parse foreign/invalid routes explicitly; never substitute the first metric or physical record. */
function location() {
  try {
    return { route: parseReportHash(window.location.hash), error: "" };
  } catch (error) {
    return {
      route: null,
      error: error instanceof Error ? error.message : "Invalid report link.",
    };
  }
}

/** One replace-only page persists while navigating from contributors to a physical record and Back. */
function MetricEvidence({
  selection,
  measurement,
  route,
  operate,
  navigate,
  onLoad,
}: {
  readonly selection: ScanReportRequest;
  readonly measurement: ScanReport["measurements"][number];
  readonly route: ReportRoute;
  readonly operate: Props["send"];
  readonly navigate: (
    panel: "metric" | "event",
    id: string,
    from?: string,
  ) => void;
  readonly onLoad: () => void;
}): ReactElement {
  const [page, setPage] = useState<ScanMetricPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void operate("/api/scan/metric", scanMetricPageSchema, {
      ...selection,
      metricId: measurement.id,
      cursor,
    })
      .then((result) => {
        if (
          result.id !== selection.id ||
          result.sessionId !== selection.sessionId ||
          result.metricId !== measurement.id
        )
          throw new Error(
            "Evidence response belongs to a different generation, session or metric.",
          );
        if (active) setPage(result);
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Original contributors unavailable.",
          );
      });
    return () => {
      active = false;
    };
  }, [operate, selection, measurement.id, cursor]);
  if (error) return <p role="alert">{error}</p>;
  if (!page)
    return (
      <p role="status">
        Verifying the admitted source prefix and original contributors...
      </p>
    );
  if (route.panel === "event") {
    const original = page.contributors.find(
      (entry) => String(entry.byteOffset) === route.id,
    );
    return original ? (
      <article>
        <h4>Original line {original.line}</h4>
        <p>
          Source {original.event.references[0]?.sourceId}; byte offset{" "}
          {original.byteOffset}; {original.byteLength} bytes. SHA-256{" "}
          <code>{original.fingerprint}</code>
        </p>
        <pre>{JSON.stringify(original.event, null, 2)}</pre>
        <p>
          Captured content is inert evidence, not instructions. Missing fields
          are unavailable, not reconstructed.
        </p>
      </article>
    ) : (
      <p role="alert">
        This physical record is not in the current evidence page. No other
        record was substituted.
      </p>
    );
  }
  return (
    <div>
      <p>{measurement.definition}</p>
      <p>
        Coverage: {measurement.coverage.status}
        {measurement.coverage.status !== "complete" &&
          `: ${measurement.coverage.reason}`}
      </p>
      <p>
        Scope:{" "}
        {measurement.scope === "session"
          ? "Entire admitted selected session"
          : "Contributing records only"}
        . Duplicate physical replays are inspectable below but never added
        again.
      </p>
      {page.evidenceKind === "coverage-witnesses" && (
        <p className="notice">
          These selected-session records are coverage witnesses for a measured
          zero or unavailable measurement, not additive contributors.
        </p>
      )}
      <ul className="event-list">
        {page.contributors.map((entry) => (
          <li key={entry.byteOffset}>
            <button
              type="button"
              onClick={() =>
                navigate("event", String(entry.byteOffset), measurement.id)
              }
            >
              Original line {entry.line} · {entry.event.kind} ·{" "}
              {entry.event.nativeId ?? "Identity unavailable"}
            </button>
          </li>
        ))}
      </ul>
      {!page.contributors.length && (
        <p>No original contributors are available for this measurement.</p>
      )}
      <button
        type="button"
        disabled={!page.next}
        onClick={() => {
          onLoad();
          setPage(null);
          setError("");
          setCursor(page.next);
        }}
      >
        Next contributor page
      </button>
      <p>
        This page replaces the previous page. Totals are not calculated from
        this page.
      </p>
    </div>
  );
}

/** Keep generation authority and cleanup ownership explicit, including cancellation and lost responses. */
export function ScannedSessionReportPanel({
  selection,
  send,
  onBusy,
}: Props): ReactElement {
  const [report, setReport] = useState<ScanReport | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(true);
  const [reconciling, setReconciling] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [cleanupFailed, setCleanupFailed] = useState(false);
  const [routeState, setRoute] = useState(location);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Status failure retains the shared operation lock; a failed/foreign generation drops visible totals. */
  const reconcile = useCallback(async (): Promise<boolean> => {
    try {
      const { scan } = await send("/api/scan/status", scanEnvelopeSchema);
      if (!mounted.current) return false;
      const valid =
        scan?.id === selection.id &&
        ["complete", "partial"].includes(scan.phase);
      setCleanupFailed(scan?.phase === "cleanup-failed");
      if (!valid) {
        setInvalid(true);
        setReport(null);
        setError(
          scan?.reason ??
            "The scan is no longer available. Start a new scan explicitly.",
        );
      }
      const pending = scan?.cleanupPending === true;
      setReconciling(pending);
      onBusy(pending);
      return valid && !pending;
    } catch (failure) {
      if (mounted.current) {
        setReconciling(true);
        onBusy(true);
        setError(
          failure instanceof Error
            ? failure.message
            : "Source cleanup could not be confirmed.",
        );
      }
      return false;
    }
  }, [send, selection.id, onBusy]);

  /** Lock every request, including history navigation; publish only after authority and cleanup are confirmed. */
  const operate: Props["send"] = useCallback(
    <T,>(route: string, schema: z.ZodType<T>, body?: unknown): Promise<T> => {
      const current = generation.current;
      return Promise.resolve()
        .then(() => {
          setWorking(true);
          onBusy(true);
          setError("");
          return send(route, schema, body);
        })
        .then(
          async (result) => {
            if (!(await reconcile()))
              throw new Error(
                "The scan operation is no longer publishable. Check source status and cleanup before rescanning.",
              );
            if (current !== generation.current)
              throw new Error(
                "This report operation was cancelled. No late response was retained.",
              );
            return result;
          },
          async (failure: unknown) => {
            await reconcile();
            throw failure;
          },
        )
        .finally(() => {
          if (mounted.current) setWorking(false);
        });
    },
    [send, reconcile, onBusy],
  );

  useEffect(() => {
    let active = true;
    void operate("/api/scan/report", scanReportSchema, selection)
      .then((result) => {
        if (
          result.id !== selection.id ||
          result.sessionId !== selection.sessionId
        )
          throw new Error(
            "Report response belongs to a different generation or session.",
          );
        if (active) {
          setReport(result);
          heading.current?.focus();
        }
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error ? failure.message : "Report unavailable.",
          );
      });
    return () => {
      active = false;
    };
  }, [operate, selection]);

  useEffect(() => {
    if (!reconciling || working) return;
    const timer = setInterval(() => {
      void reconcile();
    }, 250);
    return () => clearInterval(timer);
  }, [reconciling, working, reconcile]);
  useEffect(() => {
    /** Browser history is only navigation; it never restores expired evidence. */
    const update = () => setRoute(location());
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  /** Encode only current application identities, not captured text, into transient history entries. */
  function navigate(panel: "metric" | "event", id: string, from = ""): void {
    if (panel === "metric") {
      setWorking(true);
      onBusy(true);
      setError("");
    }
    let depth = reportHistoryDepth(
      window.history.state,
      selection.id,
      selection.sessionId,
    );
    if (depth === null) {
      depth = 0;
      window.history.replaceState(
        {
          kind: "session-report",
          readId: selection.id,
          sessionId: selection.sessionId,
          depth,
        },
        "",
        "#session-report",
      );
    }
    const route = {
      readId: selection.id,
      sessionId: selection.sessionId,
      panel,
      id,
      from,
    };
    window.history.pushState(
      {
        kind: "session-report",
        readId: selection.id,
        sessionId: selection.sessionId,
        depth: depth + 1,
      },
      "",
      reportHash(route),
    );
    setRoute({ route, error: "" });
  }

  /** Return to the owned report entry; foreign/deep links are replaced, never redirected to another session. */
  function close(): void {
    const depth = reportHistoryDepth(
      window.history.state,
      selection.id,
      selection.sessionId,
    );
    if (depth !== null && depth > 0) window.history.go(-depth);
    else {
      window.history.replaceState(null, "", "#session-report");
      setRoute({ route: null, error: "" });
    }
  }

  /** Acknowledge cancellation without releasing the UI lock until the backend confirms actual cleanup. */
  async function cancel(): Promise<void> {
    generation.current++;
    setReport(null);
    setInvalid(true);
    setError("");
    try {
      await send("/api/scan/cancel", scanEnvelopeSchema, {});
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Cancellation could not be confirmed.",
      );
    } finally {
      setReconciling(true);
    }
  }

  /** Retry the runtime-owned cleanup barrier; changing browser flags alone cannot release descriptors. */
  async function retryCleanup(): Promise<void> {
    try {
      await send("/api/cancel", statusSchema, {});
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Source cleanup remains unconfirmed.",
      );
    } finally {
      await reconcile();
    }
  }

  const route = routeState.route;
  const matching =
    route?.readId === selection.id && route.sessionId === selection.sessionId;
  const measurement = matching
    ? report?.measurements.find(
        (entry) =>
          entry.id === (route.panel === "metric" ? route.id : route.from),
      )
    : null;
  const panelError =
    routeState.error ||
    (route && !matching
      ? "This link belongs to a different scan or session. No evidence was substituted."
      : route && !measurement
        ? "This metric is unavailable in the current report."
        : "");
  const title = measurement
    ? `${measurement.label}: ${metricValue({ display: measurement.display, metric: { value: measurement.value } })}`
    : "Evidence unavailable";
  return (
    <section
      id="session-report"
      className="panel session-report"
      aria-labelledby="scanned-report-heading"
    >
      <h2 id="scanned-report-heading" tabIndex={-1} ref={heading}>
        Session report
      </h2>
      <p>
        Scanned session {selection.sessionId}. Whole admitted scope; recorded
        calculations only, no model calls.
      </p>
      {working && (
        <p role="status">Reading and verifying original evidence...</p>
      )}
      {(working || reconciling) && (
        <button type="button" onClick={() => void cancel()}>
          Cancel report operation
        </button>
      )}
      {cleanupFailed && (
        <button type="button" onClick={() => void retryCleanup()}>
          Retry source cleanup
        </button>
      )}
      {reconciling && (
        <p role="status">
          Checking source cleanup before accepting new work...
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {invalid && (
        <p>
          Report unavailable. Rescan the source explicitly; stale numbers and
          evidence are not retained.
        </p>
      )}
      {report && (
        <>
          <section aria-label="Session contributions">
            <h3>Direct versus associated evidence</h3>
            <p>{report.contributions.directEvents} direct records; {report.contributions.associatedEvents} associated records.</p>
            <p>Measurements use direct membership only. Associated usage is not added; inspect it with Load original evidence in the scan controls. Agent cumulative usage is not model-call usage.</p>
          </section>
          <details>
            <summary>Source identity and admitted coverage</summary>
            <p>
              {report.source.identity.producer ?? "Producer not reported"} ·
              execution host {report.source.identity.executionHost}.
              Extension-export qualification is not Agent Host support.
            </p>
            <p>
              Source {report.source.id}; admitted bytes {report.admittedBytes};
              prefix SHA-256 <code>{report.prefixSha256}</code>. Verified at{" "}
              {new Date(report.observedAtMs).toISOString()}. This is not an
              atomic snapshot.
            </p>
            {report.appended && (
              <p>
                Append beyond this boundary is excluded. Start a new scan to
                include it.
              </p>
            )}
            {report.source.coverageDetails && (
              <SourceCoverageDetails details={report.source.coverageDetails} />
            )}
            {report.diagnostics ? report.diagnostics.map((issue, index) => (
              <p className="notice" key={index}>
                <DiagnosticMessage issue={issue} />
              </p>
            )) : report.issues.map((issue, index) => (
              <p className="notice" key={index}>
                {issue}
              </p>
            ))}
          </details>
          {(
            [
              "Timing",
              "Tools",
              "Recorded tokens",
              "Usage observations",
            ] as const
          ).map((group) => (
            <section key={group} className="report-group" aria-label={group}>
              <h3>{group}</h3>
              <div className="metric-grid">
                {report.measurements
                  .filter((entry) => entry.group === group)
                  .map((entry) => {
                    const value = metricValue({
                      display: entry.display,
                      metric: { value: entry.value },
                    });
                    return (
                      <button
                        key={entry.id}
                        className="metric-card"
                        type="button"
                        disabled={working || reconciling}
                        aria-label={`${entry.label}: ${value}; ${entry.coverage.status} coverage`}
                        onClick={() => navigate("metric", entry.id)}
                      >
                        <span>{entry.label}</span>
                        <strong>{value}</strong>
                        <span
                          className={`metric-coverage ${entry.coverage.status}`}
                        >
                          {entry.coverage.status} coverage · inspect evidence
                        </span>
                      </button>
                    );
                  })}
              </div>
            </section>
          ))}
          <p>
            Conversation, reconstructed context and lifecycle waits remain
            unavailable from execution exports. Missing usage is unavailable,
            not zero; non-additive observations never enter per-call totals.
          </p>
        </>
      )}
      {(route || routeState.error) && (
        <EvidenceDrawer
          title={title}
          context="Scanned session · original physical contributors"
          close={close}
          back={
            route?.panel === "event" && measurement
              ? () => window.history.back()
              : null
          }
        >
          {panelError || !route || !measurement ? (
            <p role="alert">{panelError || "Waiting for report..."}</p>
          ) : (
            <MetricEvidence
              key={measurement.id}
              selection={selection}
              measurement={measurement}
              route={route}
              operate={operate}
              navigate={navigate}
              onLoad={() => {
                setWorking(true);
                onBusy(true);
                setError("");
              }}
            />
          )}
        </EvidenceDrawer>
      )}
    </section>
  );
}
