/** Source-selection shell; no browser storage, remote model requests or synthetic report data. */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { readViewSchema } from "../evidence/contracts.js";
import {
  errorSchema,
  statusSchema,
  type RuntimeStatus,
} from "../runtime/protocol.js";
import "./styles.css";

/** Consume the per-process launch credential without retaining it in browser storage or the visible URL. */
function launchAccess(): string {
  const value =
    new URLSearchParams(window.location.hash.slice(1)).get("access") ?? "";
  window.history.replaceState(null, "", window.location.pathname);
  return value;
}

const token = launchAccess();

/** Validate server envelopes and surface controlled errors; never substitute a successful empty result. */
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

/** Display only actual source availability and configuration; analysis remains explicitly unavailable. */
function App(): ReactElement {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [format, setFormat] = useState("");
  const [readNotice, setReadNotice] = useState("");
  const generation = useRef(0);
  const selected = status?.sources.find((source) => source.id === sourceId);

  /** Refresh metadata manually and disregard responses from older UI operations. */
  async function load(refresh: boolean): Promise<void> {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setReadNotice("");
    try {
      const result = await request(
        refresh ? "/api/refresh" : "/api/status",
        statusSchema,
        refresh ? {} : undefined,
      );
      if (current !== generation.current) return;
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
    if (token) void load(false);
  }, []);

  /** Request a supported read; readers are never installed or selected through a silent fallback. */
  async function read(): Promise<void> {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setReadNotice("");
    try {
      const view = await request("/api/read", readViewSchema, {
        sourceId,
        relativePath,
        format,
      });
      if (current !== generation.current) return;
      const summary =
        view.sessions.length === 0 && view.events.length === 0
          ? "No session evidence is available from this read."
          : `Read completed: ${view.sessions.length} sessions and ${view.events.length} records.`;
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
                  disabled={busy}
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
                        disabled={busy}
                        onChange={(event) => {
                          setSourceId(event.target.value);
                          setRelativePath("");
                          setReadNotice("");
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
                            disabled={busy}
                            onChange={(event) => {
                              setRelativePath(event.target.value);
                              setReadNotice("");
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
                        }}
                        disabled={busy || status.readers.length === 0}
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
                        disabled={busy || !selected?.available || !format}
                      >
                        Read source
                      </button>
                    </form>
                  )}
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
            </section>
            <section
              className="panel analysis"
              aria-labelledby="analysis-heading"
            >
              <div className="section-heading">
                <h2 id="analysis-heading">Analysis</h2>
                <span className="status-tag warning">Not available yet</span>
              </div>
              <dl>
                <div>
                  <dt>Configured harness</dt>
                  <dd>Copilot</dd>
                </div>
                <div>
                  <dt>Requested model</dt>
                  <dd>
                    {status?.analysis.requestedModel ??
                      "Harness default (not connected)"}
                  </dd>
                </div>
              </dl>
              <div className="cloud-notice">
                <h3>Analysis sends selected content to a remote service</h3>
                <p>
                  When enabled, Copilot analysis will send selected messages and
                  relevant tool results to its remote endpoint. A locally
                  installed harness is not on-device inference. Your account's
                  usage limits and provider retention policies apply.
                </p>
                <p>
                  Selecting or refreshing sources does not send their content to
                  a model. Analysis will require an explicit acknowledgement and
                  action; no analyzer is connected in this build.
                </p>
              </div>
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
