/**
 * Mount the local source/analysis interface and send validated controls to its backend.
 *
 * Capture selection and analysis execution are separate: VS Code Copilot Chat is
 * the first planned evidence source; Copilot CLI is the backend's analysis executor.
 * The browser does not parse captures, connect directly to a remote model or
 * register analysis definitions. Missing production readers/definitions remain visible.
 *
 * Launch access, the displayed read and control state stay in memory. User actions
 * trigger source reads or acknowledged analysis; status polling only observes work
 * already accepted by the backend. No local/session storage or sample report data is used.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { readViewSchema, type ReadView } from "../evidence/contracts.js";
import {
  ANALYSIS_ACKNOWLEDGEMENT,
  analysisRunSchema,
} from "../analysis/contracts.js";
import {
  errorSchema,
  statusSchema,
  type RuntimeStatus,
} from "../runtime/protocol.js";
import "./styles.css";
import { StreamingScanPanel } from "./streaming-scan.js";

/**
 * Read bootstrap access from the initial URL fragment and remove that fragment from history.
 * @returns The supplied access value, or an empty string when absent.
 * This performs no authentication request and writes no browser storage; the server
 * later validates the in-memory value on each authenticated request.
 */
function launchAccess(): string {
  const value =
    new URLSearchParams(window.location.hash.slice(1)).get("access") ?? "";
  window.history.replaceState(null, "", window.location.pathname);
  return value;
}

const token = launchAccess();

/**
 * Send one local control/status request and validate its successful response.
 * @typeParam T - Result shape produced by the supplied Zod schema.
 * @param route - Application-owned relative backend route, not a URL from captured evidence.
 * @param schema - Validator for the expected successful response body.
 * @param body - Undefined selects GET; any supplied value is JSON-encoded for POST.
 * @returns Validated data, or rejects with a displayable Error for transport,
 * decoding, server-reported or schema failures. No successful empty fallback is returned.
 * The launch credential is attached in memory; raw response bodies are not logged.
 */
async function request<T>(
  route: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-Agent-Insights-Token": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "Cannot reach the local service. Check that it is still running.",
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("The local service returned an unreadable response.");
  }
  if (!response.ok) {
    const failure = errorSchema.safeParse(data);
    throw new Error(
      failure.success
        ? failure.data.error.message
        : "The local service returned an unexpected error.",
    );
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new Error("The local service returned an invalid response.");
  return parsed.data;
}

/**
 * Display source-wide operation observations, separately from coverage and session metrics.
 * Unclassified/conflicting spans are excluded from execution counts; no usage or
 * elapsed-time arithmetic is performed here. Older readers can omit this summary.
 */
function SourceClassification({
  classification,
}: {
  classification: NonNullable<ReadView["sources"][number]["classification"]>;
}): ReactElement {
  const entries = [
    ["Model calls", classification.executions.modelCalls],
    ["Tool calls", classification.executions.toolCalls],
    ["Agent executions", classification.executions.agentSpans],
    ["Hook executions", classification.executions.hookExecutions],
    [
      "Unclassified spans (operation missing)",
      classification.unclassifiedSpans.missingOperation,
    ],
    [
      "Unclassified spans (operation malformed)",
      classification.unclassifiedSpans.malformedOperation,
    ],
    [
      "Unclassified spans (unsupported operation)",
      classification.unclassifiedSpans.unsupportedOperation,
    ],
    ["Conflicting spans (excluded)", classification.conflictingSpans],
    ["Metric records", classification.nonExecutionRecords.metrics],
    ["Log records", classification.nonExecutionRecords.logs],
    ["Content-event records", classification.nonExecutionRecords.contentEvents],
  ] as const;
  return (
    <div role="group" aria-label="Operation classification">
      <h4>Operation classification</h4>
      <p>
        Counts describe this source, not a selected session or complete capture.
        Hook executions are separate from model and tool calls. Unclassified and
        conflicting spans are excluded from execution counts.
      </p>
      <dl>
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Own the displayed read, selection, acknowledgement and current-run controls.
 * It never infers metrics or changes captured evidence. Lost start responses are
 * reconciled through status instead of resubmitting work; terminal data is shown
 * only for the matching selection, while active cancellation remains reachable.
 * @returns The local interface; effects and event handlers perform its backend requests.
 */
function App(): ReactElement {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [analysisNotice, setAnalysisNotice] = useState("");
  const [busy, setBusy] = useState(Boolean(token));
  const [sourceId, setSourceId] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [format, setFormat] = useState("");
  const [readNotice, setReadNotice] = useState("");
  const [view, setView] = useState<ReadView | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [scanReset, setScanReset] = useState(0);
  const [operationId, setOperationId] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const generation = useRef(0);
  const [startAttempt, setStartAttempt] = useState<{
    previousRunId: string | null;
    readId: string;
    sessionId: string;
    operationId: string;
  } | null>(null);
  const selected = status?.sources.find((source) => source.id === sourceId);
  const run = status?.analysis.run;
  const analysisRunning = run?.state === "running";
  const analysisLocked = analysisRunning || reconciling;
  const selectedRun =
    run?.readId === view?.id &&
    run?.sessionId === sessionId &&
    run?.operationId === operationId &&
    run?.id !== startAttempt?.previousRunId;

  /** Apply source/provider status, retaining only selections still offered by the backend. */
  const adoptStatus = useCallback((result: RuntimeStatus): void => {
    setStatus(result);
    setSourceId((previous) =>
      result.sources.some((source) => source.id === previous)
        ? previous
        : (result.sources[0]?.id ?? ""),
    );
    setFormat((previous) =>
      result.readers.some((reader) => reader === previous)
        ? previous
        : (result.readers[0] ?? ""),
    );
  }, []);

  /**
   * Clear browser-only read/acknowledgement state when its selection changes.
   * This does not call the backend or independently cancel its work; source reads,
   * refresh and explicit cancellation own those server-side transitions.
   */
  function clearView(resetScan = true): void {
    if (resetScan) setScanReset((previous) => previous + 1);
    setStartAttempt(null);
    setAnalysisNotice("");
    setPollError("");
    setView(null);
    setSessionId("");
    setAcknowledged(false);
  }

  /**
   * Load source/provider status, optionally invalidating the backend's current read.
   * @param refresh - True posts the refresh control; false only reads current status.
   * @returns Resolves after current-generation state/error updates. Handled request
   * failures are displayed rather than thrown to UI event callers; stale replies are ignored.
   */
  async function load(refresh: boolean): Promise<void> {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setReadNotice("");
    if (refresh) clearView();
    try {
      const result = await request(
        refresh ? "/api/refresh" : "/api/status",
        statusSchema,
        refresh ? {} : undefined,
      );
      if (current !== generation.current) return;
      adoptStatus(result);
    } catch (failure) {
      if (current === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Source status could not be refreshed.",
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!token) return;
    let active = true;
    const current = ++generation.current;
    void request("/api/status", statusSchema)
      .then((result) => {
        if (active && current === generation.current) adoptStatus(result);
      })
      .catch((failure: unknown) => {
        if (active && current === generation.current)
          setError(
            failure instanceof Error
              ? failure.message
              : "Source status could not be refreshed.",
          );
      })
      .finally(() => {
        if (active && current === generation.current) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [adoptStatus]);

  useEffect(() => {
    if (!analysisRunning && !reconciling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const current = generation.current;
    /**
     * Poll the existing run or reconcile an ambiguous start within this UI generation.
     * Retries failed status reads, never analysis submissions. Successful terminal/newer
     * state cannot be overwritten by an older poll; cleanup stops scheduled polling.
     * @returns Resolves after a state/error update or scheduling the next status attempt.
     */
    async function poll(): Promise<void> {
      try {
        const result = await request("/api/status", statusSchema);
        if (stopped || current !== generation.current) return;
        setPollError("");
        if (reconciling) {
          const attempt = startAttempt;
          const restored = result.analysis.run;
          if (
            attempt &&
            restored &&
            restored.id !== attempt.previousRunId &&
            restored.readId === attempt.readId &&
            restored.sessionId === attempt.sessionId &&
            restored.operationId === attempt.operationId
          ) {
            setStartAttempt(null);
            setError("");
          }
          setStatus(result);
          setReconciling(false);
        } else {
          setStatus((previous) =>
            previous !== null &&
            previous.analysis.run !== null &&
            previous.analysis.run.id === run?.id &&
            previous.analysis.run.state === "running"
              ? result
              : previous,
          );
        }
        if (result.analysis.run?.state === "running")
          timer = setTimeout(() => void poll(), reconciling ? 0 : 500);
      } catch (failure) {
        if (!stopped && current === generation.current) {
          setPollError(
            failure instanceof Error
              ? failure.message
              : "Analysis status could not be checked.",
          );
          timer = setTimeout(() => void poll(), 1000);
        }
      }
    }
    timer = setTimeout(() => void poll(), 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [analysisRunning, run?.id, reconciling, startAttempt]);

  /**
   * Handle an explicit Analyze action using the current selection and acknowledgement.
   * The request contains identifiers, not arbitrary prompt instructions or capture uploads.
   * @returns Resolves after the start response or a displayed error, not after inference.
   * An ambiguous failure locks another start while status reconciliation finds whether
   * the server accepted it; the original analysis request is never automatically resent.
   */
  async function analyze(): Promise<void> {
    if (!view) {
      setError("Read a source and select a session before analysis.");
      return;
    }
    setBusy(true);
    setError("");
    setPollError("");
    setAnalysisNotice("");
    setStartAttempt({
      previousRunId: run?.id ?? null,
      readId: view.id,
      sessionId,
      operationId,
    });
    try {
      const result = await request("/api/analysis/start", analysisRunSchema, {
        readId: view.id,
        sessionId,
        operationId,
        acknowledgement: acknowledged ? ANALYSIS_ACKNOWLEDGEMENT : "",
      });
      setStartAttempt(null);
      setStatus((previous) =>
        previous
          ? { ...previous, analysis: { ...previous.analysis, run: result } }
          : previous,
      );
    } catch (failure) {
      setReconciling(true);
      setError(
        failure instanceof Error
          ? failure.message
          : "Analysis could not be started.",
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Request cancellation of the displayed run ID, including after reopening the page.
   * @returns Resolves after backend cleanup/status or a displayed error. A cancellation
   * outside the local selection receives an action notice, not another selection's
   * terminal result/usage. Server-side ID checks protect a newer run from a stale request.
   */
  async function cancelAnalysis(): Promise<void> {
    if (!run) {
      setError("No current analysis is available to cancel.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await request("/api/analysis/cancel", statusSchema, {
        id: run.id,
      });
      setStatus(result);
      if (!selectedRun) {
        if (result.analysis.run?.state === "cancelled")
          setAnalysisNotice("Analysis was cancelled.");
        else if (result.analysis.run?.error)
          setError(result.analysis.run.error.message);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Analysis could not be cancelled.",
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Request the selected source grant, relative path and registered reader format.
   * @returns Resolves after retaining a current-generation read/status or displaying an
   * error. This resets analysis acknowledgement and does not invoke a model.
   * The backend owns parsing; absent readers are not replaced with synthetic evidence.
   */
  async function read(): Promise<void> {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setReadNotice("");
    clearView();
    try {
      const view = await request("/api/read", readViewSchema, {
        sourceId,
        relativePath,
        format,
      });
      if (current !== generation.current) return;
      const nextStatus = await request("/api/status", statusSchema);
      if (current !== generation.current) return;
      setView(view);
      setStatus(nextStatus);
      const partial =
        view.issues.length > 0 ||
        view.sources.some((source) =>
          Object.values(source.coverage).some(
            (coverage) => coverage.status === "partial",
          ),
        );
      const summary =
        view.sessions.length === 0 && view.events.length === 0
          ? "No session evidence is available from this read."
          : view.sessions.length === 0
            ? `${view.events.length} record${view.events.length === 1 ? " was" : "s were"} read, but no session could be identified.`
            : `${partial ? "Partial read" : "Read completed"}: ${view.sessions.length} session${view.sessions.length === 1 ? "" : "s"} and ${view.events.length} record${view.events.length === 1 ? "" : "s"}.`;
      const limitations = view.issues
        .slice(0, 3)
        .map((issue) => issue.message)
        .join(" ");
      setReadNotice(
        `${summary} ${limitations} Report views are not installed yet.`,
      );
    } catch (failure) {
      if (current === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "The source could not be read.",
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <aside className="sidebar">
        <a className="brand" href="#content">
          Agent Insights
        </a>
        <nav aria-label="Main navigation">
          <a href="#sources" aria-current="page">
            Sources
          </a>
          <span aria-disabled="true">
            Session report <small>Not available yet</small>
          </span>
        </nav>
        <p className="sidebar-note">
          Read-only source access.
          <br />
          No saved session history.
        </p>
      </aside>
      <main id="content" tabIndex={-1}>
        <header>
          <div>
            <p className="eyebrow">Local runtime</p>
            <h1>Sources</h1>
          </div>
          <span className="status-tag">Loopback only</span>
        </header>
        {!token ? (
          <section className="panel" aria-labelledby="access-heading">
            <h2 id="access-heading">Access required</h2>
            <p>
              Open the full launch URL printed by <code>npm start</code>. The
              access credential is held only in memory and is cleared by a page
              reload.
            </p>
          </section>
        ) : (
          <>
            {error && (
              <div className="alert" role="alert">
                {error}
                {status && (
                  <span> Previously checked source status is shown below.</span>
                )}
              </div>
            )}
            <section
              id="sources"
              className="panel"
              aria-labelledby="sources-heading"
            >
              <div className="section-heading">
                <div>
                  <h2 id="sources-heading">Configured locations</h2>
                  <p>Only locations you authorize at startup can be read.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void load(true)}
                  disabled={busy || analysisLocked}
                >
                  {busy ? "Checking..." : "Refresh sources"}
                </button>
              </div>
              {status ? (
                <>
                  <p className="checked">
                    Checked at{" "}
                    {new Date(status.checkedAtMs).toLocaleTimeString()}. Refresh
                    rereads availability; nothing is synchronized to a database.
                  </p>
                  {status.sources.length === 0 ? (
                    <div className="empty">
                      <h3>No sources configured</h3>
                      <p>Restart with an explicit capture file or directory:</p>
                      <code>npm start -- --source /path/to/capture</code>
                    </div>
                  ) : (
                    <ul className="source-list">
                      {status.sources.map((source) => (
                        <li key={source.id}>
                          <div>
                            <strong>
                              {source.kind === "unknown"
                                ? "Unavailable location"
                                : source.kind === "file"
                                  ? "Capture file"
                                  : "Capture directory"}
                            </strong>
                            <code>{source.path}</code>
                            {source.reason && <p>{source.reason}</p>}
                          </div>
                          <span
                            className={`status-tag ${source.available ? "" : "warning"}`}
                          >
                            {source.available ? "Accessible" : "Unavailable"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {status.sources.length > 0 && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void read();
                      }}
                    >
                      <label htmlFor="source">Source location</label>
                      <select
                        id="source"
                        value={sourceId}
                        disabled={busy || analysisLocked}
                        onChange={(event) => {
                          setSourceId(event.target.value);
                          setRelativePath("");
                          setReadNotice("");
                          clearView();
                        }}
                      >
                        {status.sources.map((source) => (
                          <option value={source.id} key={source.id}>
                            {source.path}
                          </option>
                        ))}
                      </select>
                      {selected?.kind === "directory" && (
                        <>
                          <label htmlFor="relative-path">
                            File inside this directory
                          </label>
                          <input
                            id="relative-path"
                            value={relativePath}
                            disabled={busy || analysisLocked}
                            onChange={(event) => {
                              setRelativePath(event.target.value);
                              setReadNotice("");
                              clearView();
                            }}
                            placeholder="session.jsonl"
                          />
                        </>
                      )}
                      <label htmlFor="format">Reader format</label>
                      <select
                        id="format"
                        value={format}
                        onChange={(event) => {
                          setFormat(event.target.value);
                          setReadNotice("");
                          clearView();
                        }}
                        disabled={
                          busy || analysisLocked || status.readers.length === 0
                        }
                      >
                        {status.readers.length === 0 ? (
                          <option value="">No readers installed</option>
                        ) : (
                          status.readers.map((reader) => (
                            <option key={reader}>{reader}</option>
                          ))
                        )}
                      </select>
                      <button
                        className="primary"
                        type="submit"
                        disabled={
                          busy ||
                          analysisLocked ||
                          !selected?.available ||
                          !format
                        }
                      >
                        Read source
                      </button>
                    </form>
                  )}
                  {status.sources.length > 0 && format === "vscode-otel-jsonl" && (
                    <StreamingScanPanel
                      key={JSON.stringify([sourceId, relativePath, format, scanReset])}
                      sourceId={sourceId}
                      relativePath={relativePath}
                      disabled={busy || analysisLocked || !selected?.available}
                      send={request}
                      onStart={() => { clearView(false); setReadNotice(""); }}
                      onBusy={setBusy}
                    />
                  )}
                  <p className="notice" role="status">
                    Native SQLite:{" "}
                    {status.nativeSqlite.available ? "prepared" : "unavailable"}
                    . {status.nativeSqlite.reason} File-only sources and
                    analysis are independent.
                  </p>
                  {status.readers.length === 0 && (
                    <p className="notice" role="status">
                      Source readers are not installed yet. Location checks do
                      not read session contents or produce analysis.
                    </p>
                  )}
                </>
              ) : (
                <p role="status">Checking configured locations...</p>
              )}
              {readNotice && (
                <p className="notice" role="status">
                  {readNotice}
                </p>
              )}
              {view && (
                <section aria-labelledby="read-coverage-heading">
                  <h3 id="read-coverage-heading">Read coverage</h3>
                  <p>
                    Coverage describes this bounded read, not all session
                    history.
                  </p>
                  {view.sources.map((source) => (
                    <div key={source.id}>
                      <dl>
                        {(
                          ["messages", "timing", "tools", "tokens"] as const
                        ).map((dimension) => {
                          const coverage = source.coverage[dimension];
                          return (
                            <div key={dimension}>
                              <dt>
                                {dimension[0]?.toUpperCase()}
                                {dimension.slice(1)}
                              </dt>
                              <dd>
                                {coverage.status}
                                {coverage.status !== "complete" &&
                                  `: ${coverage.reason}`}
                              </dd>
                            </div>
                          );
                        })}
                      </dl>
                      {source.classification && (
                        <SourceClassification
                          classification={source.classification}
                        />
                      )}
                    </div>
                  ))}
                  {view.issues.length > 0 && (
                    <details>
                      <summary>Read limitations ({view.issues.length})</summary>
                      <ul>
                        {view.issues.map((issue, index) => (
                          <li key={index}>{issue.message}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </section>
              )}
            </section>
            <section
              className="panel analysis"
              aria-labelledby="analysis-heading"
            >
              <div className="section-heading">
                <h2 id="analysis-heading">Analysis</h2>
                <span
                  className={`status-tag ${status?.analysis.available ? "" : "warning"}`}
                >
                  {status?.analysis.available
                    ? "Copilot detected"
                    : "Unavailable"}
                </span>
              </div>
              <dl>
                <div>
                  <dt>Configured harness</dt>
                  <dd>Copilot</dd>
                </div>
                <div>
                  <dt>Requested model</dt>
                  <dd>
                    {status?.analysis.requestedModel ?? "Harness default"}
                  </dd>
                </div>
              </dl>
              <p>{status?.analysis.reason}</p>
              {pollError && analysisLocked && (
                <p role="alert">{pollError} Retrying analysis status...</p>
              )}
              {reconciling && (
                <p role="status">
                  Checking whether analysis started. The analysis request will
                  not be resent.
                </p>
              )}
              {analysisNotice && <p role="status">{analysisNotice}</p>}
              <div className="cloud-notice">
                <h3>Analysis sends selected content to a remote service</h3>
                <p>
                  Copilot analysis sends selected messages and relevant tool
                  results to its remote endpoint. A locally installed harness is
                  not on-device inference. Your account's usage limits and
                  provider retention policies apply.
                </p>
                <p>
                  Authentication uses the supported GitHub CLI login or token
                  environment. Check that it is the account you intend to use;
                  it may differ from another Copilot chat's login.
                </p>
                <p>
                  Selecting or refreshing sources does not send their content to
                  a model. Analysis requires an explicit acknowledgement and
                  action. Results are model judgments, not independently
                  verified facts.
                </p>
              </div>
              {status?.analysis.operations.length === 0 ? (
                <p className="notice">
                  Analysis definitions are not installed yet. Task, steering,
                  artifact and prompt analyses are separate upcoming work.
                </p>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void analyze();
                  }}
                >
                  <label htmlFor="analysis-session">Session to analyze</label>
                  <select
                    id="analysis-session"
                    value={sessionId}
                    disabled={busy || analysisLocked || !view}
                    onChange={(event) => {
                      setSessionId(event.target.value);
                      setStartAttempt(null);
                      setAnalysisNotice("");
                      setAcknowledged(false);
                    }}
                  >
                    <option value="">Read a source and select a session</option>
                    {view?.sessions.map((session) => (
                      <option value={session.id} key={session.id}>
                        {session.nativeId ?? session.id}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="analysis-operation">Analysis</label>
                  <select
                    id="analysis-operation"
                    value={operationId}
                    disabled={busy || analysisLocked}
                    onChange={(event) => {
                      setOperationId(event.target.value);
                      setStartAttempt(null);
                      setAnalysisNotice("");
                      setAcknowledged(false);
                    }}
                  >
                    <option value="">Select an analysis</option>
                    {status?.analysis.operations.map((operation) => (
                      <option value={operation.id} key={operation.id}>
                        {operation.label}
                      </option>
                    ))}
                  </select>
                  <p>
                    {view && sessionId
                      ? `${view.events.filter((event) => event.sessionId === sessionId).length} captured records from this session will be sent.`
                      : "No session evidence selected."}
                  </p>
                  <label className="consent" htmlFor="analysis-consent">
                    <input
                      id="analysis-consent"
                      type="checkbox"
                      checked={acknowledged}
                      disabled={busy || analysisLocked}
                      onChange={(event) =>
                        setAcknowledged(event.target.checked)
                      }
                    />
                    I understand that selected content is sent remotely and my
                    account's usage and provider retention policies apply.
                  </label>
                  <button
                    className="primary"
                    type="submit"
                    disabled={
                      busy ||
                      analysisLocked ||
                      !acknowledged ||
                      !view ||
                      !sessionId ||
                      !operationId ||
                      !status?.analysis.available
                    }
                  >
                    Analyze
                  </button>
                </form>
              )}
              {run && (analysisRunning || selectedRun) && (
                <div className="analysis-result">
                  <p role="status">
                    Analysis {run.state}: {run.stage}.
                  </p>
                  {analysisRunning && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void cancelAnalysis()}
                    >
                      Cancel analysis
                    </button>
                  )}
                  {run.error && <p role="alert">{run.error.message}</p>}
                  <p>
                    Analysis input tokens: {run.usage.input ?? "Unavailable"};
                    output tokens: {run.usage.output ?? "Unavailable"}.
                    Effective model: {run.usage.model ?? "Not reported"}. This
                    usage is separate from the captured session.
                  </p>
                  {run.result && selectedRun && (
                    <>
                      <h3>Model-generated result</h3>
                      <pre>{JSON.stringify(run.result.data, null, 2)}</pre>
                      <p>Evidence records: {run.result.eventIds.join(", ")}</p>
                    </>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Application root is missing");
createRoot(root).render(<App />);
