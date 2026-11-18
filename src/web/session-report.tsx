/**
 * Render one read-only, read-scoped report with inert source content and exact evidence.
 * Filters and dialog navigation remain in memory; no analysis, source writes or storage.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { z } from "zod";
import type { EvidenceReference, ReadView } from "../evidence/contracts.js";
import {
  sessionReportSchema,
  type ReportMeasurement,
  type SessionReport,
} from "../metrics/report.js";
import {
  contributingEvents,
  unmatchedReferences,
  parseReportHash,
  reportHash,
  reportHistoryDepth,
  type ReportRoute,
} from "./report-navigation.js";

/** Reuse the local authenticated transport; a report request computes metrics without model execution. */
interface ReportProps {
  readonly view: ReadView;
  readonly send: <T>(
    route: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ) => Promise<T>;
}

/** Parsed location errors stay visible rather than falling back to a valid record. */
interface ReportLocation {
  readonly route: ReportRoute | null;
  readonly error: string;
}

/** Preserve exact fractional milliseconds and valid evidence outside JavaScript's calendar-date range. */
function timestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? `${value} ms since epoch (outside displayable date range)`
    : `${date.toISOString()}${Number.isInteger(value) ? "" : ` (${value} ms since epoch)`}`;
}

/** Read the current fragment without retaining launch credentials or accepting captured links. */
function currentLocation(): ReportLocation {
  try {
    return { route: parseReportHash(window.location.hash), error: "" };
  } catch (failure) {
    return {
      route: null,
      error:
        failure instanceof Error ? failure.message : "Report link unavailable.",
    };
  }
}

/** Format recorded numbers without replacing missing data or silently rounding measured milliseconds. */
function metricValue(entry: ReportMeasurement): string {
  const value = entry.metric.value;
  if (value === null) return "Unavailable";
  if (entry.display === "timestamp") return timestamp(value);
  if (entry.display === "duration")
    return `${value.toLocaleString("en-US", { maximumFractionDigits: 20 })} ms`;
  return value.toLocaleString("en-US");
}

/** Give each retained event an honest label without interpreting messages as tasks or commands. */
function eventLabel(event: ReadView["events"][number]): string {
  if (event.kind === "message") return `${event.role} message`;
  return `${event.kind}: ${event.name ?? "name unavailable"} (${event.status})`;
}

/** Expose full original anchors as text; paths, pointers and captured URLs never become executable links. */
function SourceAnchors({
  references,
}: {
  readonly references: readonly EvidenceReference[];
}): ReactElement {
  return (
    <ul className="source-anchors">
      {references.map((reference, index) => (
        <li key={index}>
          <strong>{reference.sourceId}</strong> ·{" "}
          <code>{reference.recordId}</code>
          <pre>{JSON.stringify(reference.location, null, 2)}</pre>
        </li>
      ))}
    </ul>
  );
}

/** Render source identity and dimension-specific limitations, not a harness inferred from Ask/Agent mode. */
function Coverage({
  view,
  sessionId,
}: {
  readonly view: ReadView;
  readonly sessionId: string;
}): ReactElement {
  const session = view.sessions.find((item) => item.id === sessionId);
  return (
    <div>
      <p>
        Read-time evidence only. Sources may have changed since this read.
        Refresh discards this generation and never starts model analysis.
      </p>
      <p>
        Input read started: <time>{timestamp(view.startedAtMs)}</time>
        <br />
        Read processing finished: <time>{timestamp(view.finishedAtMs)}</time>
      </p>
      <p>
        Processing completion is not an input-observation bound or a global
        snapshot. First/last captured timestamps describe retained session
        evidence, not the read operation.
      </p>
      {view.sources
        .filter((source) => session?.sourceIds.includes(source.id))
        .map((source) => (
          <section key={source.id} className="coverage-source">
            <h4>{source.identity.producer ?? "Producer not reported"}</h4>
            <dl>
              <div>
                <dt>Source</dt>
                <dd>{source.id}</dd>
              </div>
              <div>
                <dt>Execution host</dt>
                <dd>{source.identity.executionHost}</dd>
              </div>
              <div>
                <dt>Reported version</dt>
                <dd>{source.identity.version ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Format</dt>
                <dd>{source.format ?? "Unsupported or unavailable"}</dd>
              </div>
              <div>
                <dt>Changed during read</dt>
                <dd>
                  {source.changedDuringRead === null
                    ? "Unknown"
                    : source.changedDuringRead
                      ? "Yes; partial evidence"
                      : "Not observed"}
                </dd>
              </div>
              {Object.entries(source.coverage).map(([dimension, coverage]) => (
                <div key={dimension}>
                  <dt>{dimension}</dt>
                  <dd>
                    {coverage.status}
                    {coverage.status !== "complete" && `: ${coverage.reason}`}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      {view.issues
        .filter((issue) => session?.sourceIds.includes(issue.sourceId))
        .map((issue, index) => (
          <p key={index} className="notice">
            {issue.message}
          </p>
        ))}
      <p>
        Mode labels and the Copilot CLI analysis executor do not identify a
        source. Select retained evidence from the intended runtime; do not
        switch harnesses or bypass capture policy to fill gaps.
      </p>
    </div>
  );
}

/** Show exact captured fields and adjacent messages, without claiming reconstructed model context. */
function OriginalEvent({
  event,
  view,
  openEvent,
}: {
  readonly event: ReadView["events"][number];
  readonly view: ReadView;
  readonly openEvent: (id: string) => void;
}): ReactElement {
  const messages = view.events.filter(
    (item) => item.sessionId === event.sessionId && item.kind === "message",
  );
  const messageIndex = messages.findIndex((item) => item.id === event.id);
  const adjacent =
    messageIndex < 0
      ? []
      : [messages[messageIndex - 1], messages[messageIndex + 1]].filter(
          (item) => item !== undefined,
        );
  return (
    <article>
      <p className="eyebrow">Original retained evidence · read-only</p>
      <h4>{eventLabel(event)}</h4>
      <p>
        Native identity: <code>{event.nativeId ?? "Not reported"}</code>
      </p>
      {event.kind === "message" ? (
        <>
          <h4>Captured message</h4>
          {event.text === null ? (
            <p className="notice">
              Message content unavailable in this source.
            </p>
          ) : (
            <pre>{event.text}</pre>
          )}
          {event.nativeMessage && (
            <details>
              <summary>Recorded message attribution and identities</summary>
              <pre>{JSON.stringify(event.nativeMessage, null, 2)}</pre>
            </details>
          )}
          {adjacent.length > 0 && (
            <div>
              <h4>Adjacent retained messages</h4>
              <p>
                Source order, not an inferred causal relationship or complete
                model context.
              </p>
              {adjacent.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openEvent(item.id)}
                >
                  {eventLabel(item)} · {item.nativeId ?? item.id}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <p>
            Start:{" "}
            {event.startedAtMs === null
              ? "Unavailable"
              : timestamp(event.startedAtMs)}
            <br />
            End:{" "}
            {event.endedAtMs === null
              ? "Unavailable"
              : timestamp(event.endedAtMs)}
          </p>
          {(
            [
              "toolArguments",
              "toolResult",
              "inputMessages",
              "outputMessages",
            ] as const
          ).map((field) => (
            <details key={field}>
              <summary>Captured {field}</summary>
              {event.content?.[field] === null ||
              event.content?.[field] === undefined ? (
                <p>Unavailable: this source did not retain this field.</p>
              ) : (
                <pre>{event.content[field]}</pre>
              )}
            </details>
          ))}
          {event.hook && (
            <details>
              <summary>Captured hook content</summary>
              <pre>{JSON.stringify(event.hook, null, 2)}</pre>
            </details>
          )}
          <details>
            <summary>Recorded usage and execution metadata</summary>
            <pre>
              {JSON.stringify(
                {
                  usage: event.usage,
                  model: event.model,
                  tool: event.tool,
                  nativeExecution: event.nativeExecution,
                  observation: event.observation,
                  nativeIdentities: event.nativeIdentities,
                },
                null,
                2,
              )}
            </pre>
          </details>
          <p>
            Shell invocations are not counts of every program inside a command.
            Missing working directory, stdout, stderr, exit status, truncation
            or redaction metadata is unavailable, not reconstructed.
          </p>
        </>
      )}
      <h4>Original source anchors</h4>
      <SourceAnchors references={event.references} />
      <p>
        Captured text, commands and URLs are inert evidence. They are never
        executed or opened by this report.
      </p>
    </article>
  );
}

/** Native modal focus trapping and Escape handling preserve the report's filter, scroll and invoking control. */
function EvidenceDrawer({
  title,
  children,
  close,
  back,
  context,
}: {
  readonly title: string;
  readonly children: ReactElement;
  readonly close: () => void;
  readonly back: (() => void) | null;
  readonly context: string;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    const scroll = window.scrollY;
    element?.showModal();
    return () => {
      element?.close();
      // History traversal restores its own focus/scroll after popstate; restore the report afterward.
      window.requestAnimationFrame(() => {
        if (
          trigger instanceof HTMLElement &&
          trigger.isConnected &&
          !document.querySelector("dialog[open]")
        ) {
          trigger.focus({ preventScroll: true });
          window.scrollTo({ top: scroll });
        }
      });
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [title, context]);
  return (
    <dialog
      ref={dialog}
      className={`evidence-drawer${wide ? " wide" : ""}`}
      aria-labelledby="evidence-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), summary, [href], [tabindex]:not([tabindex='-1'])",
          ),
        ].filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) return;
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === heading.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="drawer-controls">
        {back && (
          <button type="button" onClick={back}>
            Back to contributors
          </button>
        )}
        <button type="button" onClick={() => setWide(!wide)}>
          {wide ? "Side panel" : "Full-width detail"}
        </button>
        <button type="button" onClick={close}>
          Close evidence
        </button>
      </div>
      <p className="eyebrow">{context}</p>
      <h3 id="evidence-title" tabIndex={-1} ref={heading}>
        {title}
      </h3>
      {children}
    </dialog>
  );
}

/** Render a selected session; remount on read/session changes so late responses cannot mix generations. */
function SelectedReport({
  view,
  send,
  sessionId,
}: ReportProps & { readonly sessionId: string }): ReactElement {
  const [report, setReport] = useState<SessionReport | null>(null);
  const [error, setError] = useState("");
  const [location, setLocation] = useState(currentLocation);
  const [toolFilter, setToolFilter] = useState("");
  const session = view.sessions.find((item) => item.id === sessionId);
  const events = view.events.filter((event) => event.sessionId === sessionId);
  const tools = events.filter(
    (
      event,
    ): event is Exclude<ReadView["events"][number], { kind: "message" }> =>
      event.kind === "tool-call",
  );
  const messages = events.filter((event) => event.kind === "message");
  const names = [...new Set(tools.map((event) => event.name))];
  useEffect(() => {
    let active = true;
    void send("/api/report", sessionReportSchema, {
      readId: view.id,
      sessionId,
    })
      .then((result) => {
        if (result.readId !== view.id || result.sessionId !== sessionId)
          throw new Error(
            "Report response belongs to a different read or session.",
          );
        if (active) setReport(result);
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Report calculation failed.",
          );
      });
    return () => {
      active = false;
    };
  }, [send, view.id, sessionId]);
  useEffect(() => {
    /** Browser Back/Forward resolves only within the still-retained read. */
    const update = (): void => {
      setLocation(currentLocation());
    };
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  /** Navigate only using application-owned IDs; never insert captured HTML or captured hrefs. */
  function navigate(panel: ReportRoute["panel"], id = "", from = ""): void {
    const route = { readId: view.id, sessionId, panel, id, from };
    let depth = reportHistoryDepth(window.history.state, view.id, sessionId);
    if (depth === null || (!location.route && !location.error)) {
      depth = 0;
      window.history.replaceState(
        { kind: "session-report", readId: view.id, sessionId, depth },
        "",
        "#session-report",
      );
    }
    window.history.pushState(
      { kind: "session-report", readId: view.id, sessionId, depth: depth + 1 },
      "",
      reportHash(route),
    );
    setLocation({ route, error: "" });
  }
  /** Return to this report's existing history entry; unknown/deep links are replaced, never pushed. */
  function close(): void {
    const depth = reportHistoryDepth(window.history.state, view.id, sessionId);
    if (depth !== null && depth > 0) window.history.go(-depth);
    else {
      window.history.replaceState(null, "", "#session-report");
      setLocation({ route: null, error: "" });
    }
  }

  const route = location.route;
  let title = "Evidence unavailable";
  let panelError = location.error;
  let content = <p>Select a recorded metric or interaction.</p>;
  let back: (() => void) | null = null;
  if (route && (route.readId !== view.id || route.sessionId !== sessionId))
    panelError =
      "This link belongs to a different read or session. No evidence was substituted. Reopen the intended session from its selected sources.";
  if (route && !panelError && report) {
    const metric = report.measurements.find(
      (entry) =>
        entry.id ===
        (route.panel === "metric"
          ? route.id
          : route.from === "activity-lanes"
            ? "activity"
            : route.from),
    );
    if (route.panel === "coverage") {
      title = "Source identity and capture coverage";
      content = <Coverage view={view} sessionId={sessionId} />;
    } else if (route.panel === "activity") {
      const measurement = report.measurements.find(
        (entry) => entry.id === "activity",
      );
      const activity = measurement
        ? contributingEvents(view, sessionId, measurement)
        : [];
      title = "Recorded activity and missing lanes";
      content = (
        <div>
          <p>
            Activity is the union of captured execution intervals, not processor
            time or private reasoning. Overlapping spans are not added as
            elapsed time.
          </p>
          <p>
            Only contributing complete intervals appear below. Excluded,
            conflicting and incomplete records are not activity intervals;
            retained tool records remain inspectable under Tools &amp; commands
            and excluded-evidence anchors.
          </p>
          {(
            ["model-call", "tool-call", "agent-span", "hook-execution"] as const
          ).map((kind) => (
            <section key={kind}>
              <h4>{kind}</h4>
              {activity.some((event) => event.kind === kind) ? (
                <ul className="event-list">
                  {activity
                    .filter((event) => event.kind === kind)
                    .map((event) => (
                      <li key={event.id}>
                        <button
                          type="button"
                          onClick={() =>
                            navigate("event", event.id, "activity-lanes")
                          }
                        >
                          {eventLabel(event)}
                        </button>
                      </li>
                    ))}
                </ul>
              ) : (
                <p>Unavailable: no attributable captured spans.</p>
              )}
            </section>
          ))}
          <h4>Waiting for you</h4>
          <p>Unavailable: no qualified lifecycle classification.</p>
          <h4>Inferred quiet / idle</h4>
          <p>
            Not analyzed. Gaps do not establish human inactivity or typing time.
          </p>
          <h4>Unknown</h4>
          <p>
            Unobserved gaps remain unknown. Inspect the gap metric for its
            captured boundaries.
          </p>
        </div>
      );
    } else if (route.panel === "metric") {
      if (!metric)
        panelError =
          "This metric is not in this report. No other metric was substituted.";
      else {
        title = `${metric.label}: ${metricValue(metric)}`;
        const contributors = contributingEvents(view, sessionId, metric);
        const anchors = unmatchedReferences(
          contributors,
          metric.metric.contributors,
        );
        content = (
          <div>
            <p className="metric-definition">{metric.definition}</p>
            <p>
              Coverage: {metric.metric.coverage.status}
              {metric.metric.coverage.status !== "complete" &&
                ` — ${metric.metric.coverage.reason}`}
            </p>
            <p>
              Scope:{" "}
              {metric.scope.kind === "session"
                ? "Selected session"
                : "Contributing records only"}{" "}
              · recorded calculation, not a model judgment.
            </p>
            {metric.group === "Usage observations" && (
              <p className="notice">
                Non-additive reported usage. Do not sum observations, cumulative
                snapshots, overlay summaries or per-call totals.
              </p>
            )}
            <h4>Contributing records</h4>
            {contributors.length > 0 ? (
              <ul className="event-list">
                {contributors.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      onClick={() => navigate("event", event.id, metric.id)}
                    >
                      {eventLabel(event)} · {event.nativeId ?? event.id}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                No attributable interaction content is available for this value.
                The coverage explanation and any original source witnesses are
                shown instead.
              </p>
            )}
            {anchors.length > 0 && (
              <>
                <h4>Original source witnesses</h4>
                <p>
                  These source witnesses do not identify a contributing
                  normalized interaction for this measurement. They are not
                  replaced with a nearby message or tool call.
                </p>
                <SourceAnchors references={anchors} />
              </>
            )}
          </div>
        );
      }
    } else {
      const event = events.find((item) => item.id === route.id);
      if (
        !event ||
        (route.from &&
          (!metric ||
            !contributingEvents(view, sessionId, metric).some(
              (item) => item.id === event.id,
            )))
      )
        panelError =
          "This record does not belong to the requested evidence scope. No other record was substituted.";
      else {
        title = eventLabel(event);
        back =
          route.from === "activity-lanes"
            ? () => navigate("activity")
            : metric
              ? () => navigate("metric", metric.id)
              : null;
        content = (
          <OriginalEvent
            event={event}
            view={view}
            openEvent={(id) => navigate("event", id)}
          />
        );
      }
    }
  }
  if (panelError) content = <p role="alert">{panelError}</p>;

  return (
    <>
      <div className="report-heading">
        <div>
          <p className="eyebrow">Session report · recorded evidence</p>
          <h3>{session?.nativeId ?? sessionId}</h3>
          <p>
            Scope: selected session. Tool filters change visible invocations,
            not session totals.
          </p>
        </div>
        <button type="button" onClick={() => navigate("coverage")}>
          Read at {timestamp(view.finishedAtMs)} · coverage and sources
        </button>
      </div>
      <div
        className="interpretation-grid"
        aria-label="Interpretation availability"
      >
        {[
          "Tasks and outcomes",
          "Human steering",
          "Artifacts and accomplishments",
          "Prompt coaching",
        ].map((label) => (
          <div key={label}>
            <h4>{label}</h4>
            <strong>Not analyzed</strong>
            <p>
              Interpretation is not available in this report. No tasks, scores
              or completion claims are invented.
            </p>
          </div>
        ))}
      </div>
      <div className="report-source-line">
        {view.sources
          .filter((source) => session?.sourceIds.includes(source.id))
          .map((source) => (
            <p key={source.id}>
              <strong>
                {source.identity.executionHost === "agent-host"
                  ? "Copilot Agent Host"
                  : source.identity.executionHost === "extension"
                    ? "Extension-host source"
                    : "Unknown execution host"}
              </strong>
              {" · "}
              {source.identity.producer ?? "Producer unknown"}
              {" · "}
              {source.identity.version ?? "Version unavailable"}
            </p>
          ))}
        <button type="button" onClick={() => navigate("coverage")}>
          Inspect source identity and capture coverage
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!report && !error && (
        <p role="status">Calculating recorded metrics...</p>
      )}
      {report && (
        <>
          {(
            [
              "Timing",
              "Tools",
              "Recorded tokens",
              "Usage observations",
            ] as const
          ).map((group) => (
            <section className="report-group" key={group} aria-label={group}>
              <h3>{group}</h3>
              {group === "Usage observations" && (
                <p>
                  Reported native/cumulative snapshots are non-additive,
                  separate from the recorded per-call ledger.
                </p>
              )}
              <div className="metric-grid">
                {report.measurements
                  .filter((entry) => entry.group === group)
                  .map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="metric-card"
                      aria-label={`${entry.label}: ${metricValue(entry)}; ${entry.metric.coverage.status} coverage`}
                      onClick={() => navigate("metric", entry.id)}
                    >
                      <span>{entry.label}</span>
                      <strong>{metricValue(entry)}</strong>
                      <span
                        className={`metric-coverage ${entry.metric.coverage.status}`}
                      >
                        {entry.metric.coverage.status} coverage · inspect
                        evidence
                      </span>
                    </button>
                  ))}
              </div>
              {group === "Usage observations" &&
                !report.measurements.some((entry) => entry.group === group) && (
                  <p>No native usage observations are available.</p>
                )}
            </section>
          ))}
          <section className="report-group">
            <h3>Activity</h3>
            <p>
              Recorded execution, unknown gaps and unavailable lifecycle lanes
              stay separate.
            </p>
            <button type="button" onClick={() => navigate("activity")}>
              Inspect activity lanes
            </button>
          </section>
          {report.exclusions.length > 0 && (
            <details>
              <summary>Excluded or ambiguously attributed evidence</summary>
              {report.exclusions.map((exclusion, index) => (
                <div key={index}>
                  <p>{exclusion.reason}</p>
                  <SourceAnchors references={exclusion.references} />
                </div>
              ))}
            </details>
          )}
        </>
      )}
      <section className="report-group" aria-labelledby="tools-heading">
        <h3 id="tools-heading">Tools &amp; commands</h3>
        <label htmlFor="report-tool-filter">Tool filter</label>
        <select
          id="report-tool-filter"
          value={toolFilter}
          onChange={(event) => setToolFilter(event.target.value)}
        >
          <option value="">All tools</option>
          {names.map((name) => (
            <option key={name ?? "unknown"} value={JSON.stringify(name)}>
              {name ?? "Unknown tool"}
            </option>
          ))}
        </select>
        <ul className="event-list">
          {tools
            .filter(
              (event) =>
                !toolFilter || JSON.stringify(event.name) === toolFilter,
            )
            .map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  onClick={() => navigate("event", event.id)}
                >
                  {eventLabel(event)} · {event.nativeId ?? event.id}
                </button>
              </li>
            ))}
        </ul>
        {tools.length === 0 && (
          <p>
            No attributable tool invocations were retained. This is not a
            measured zero unless the tool metric has complete coverage.
          </p>
        )}
      </section>
      <section className="report-group" aria-labelledby="conversation-heading">
        <h3 id="conversation-heading">Source-backed conversation</h3>
        <ul className="event-list">
          {messages.map((event) => (
            <li key={event.id}>
              <button type="button" onClick={() => navigate("event", event.id)}>
                {eventLabel(event)} · {event.nativeId ?? event.id}
              </button>
            </li>
          ))}
        </ul>
        {messages.length === 0 && (
          <p>
            Conversation unavailable. Execution input/output is not a
            reconstructed conversation. Inspect capture coverage for the
            selected source.
          </p>
        )}
      </section>
      {(route || location.error) && (
        <EvidenceDrawer
          title={title}
          context={`Selected session: ${session?.nativeId ?? sessionId}${route?.from ? ` / ${route.from}` : ""}${route?.id ? ` / ${route.id}` : ""}`}
          close={close}
          back={back}
        >
          {report || panelError ? (
            content
          ) : (
            <p role="status">{error || "Waiting for the current report..."}</p>
          )}
        </EvidenceDrawer>
      )}
    </>
  );
}

/** Select among sessions in the current read, without inventing reports for an empty/wrong-runtime source. */
export function SessionReportPanel({ view, send }: ReportProps): ReactElement {
  const [sessionId, setSessionId] = useState(view.sessions[0]?.id ?? "");
  return (
    <section
      id="session-report"
      className="panel session-report"
      aria-labelledby="report-heading"
    >
      <h2 id="report-heading">Session report</h2>
      {view.sessions.length === 0 ? (
        <div className="empty">
          <h3>No attributable session is available</h3>
          <p>
            Inspect read coverage and source diagnostics above. Empty, missing,
            unsupported or wrong-runtime evidence is not replaced with a sample
            report. Choose retained source evidence from the intended runtime
            within your existing access policy.
          </p>
        </div>
      ) : (
        <>
          <label htmlFor="report-session">Report session</label>
          <select
            id="report-session"
            value={sessionId}
            onChange={(event) => {
              window.history.replaceState(null, "", "#session-report");
              setSessionId(event.target.value);
            }}
          >
            {view.sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.nativeId ?? session.id}
              </option>
            ))}
          </select>
          <SelectedReport
            key={`${view.id}/${sessionId}`}
            view={view}
            sessionId={sessionId}
            send={send}
          />
        </>
      )}
    </section>
  );
}
