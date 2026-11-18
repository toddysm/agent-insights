/**
 * Manual Agent Host discovery controls; source/result state lives only in this component.
 * Profiles and custom roots remain explicit. No startup scan, storage, background
 * refresh or model request is initiated here.
 */
import { useRef, useState, type ReactElement } from "react";
import type { z } from "zod";
import {
  discoveryResultSchema,
  type DiscoveryRequest,
  type DiscoveryResult,
  type ReadSetRequest,
  type RuntimeStatus,
} from "../runtime/protocol.js";

/** Reuse the authenticated, schema-validating transport; no file/network access outside that boundary. */
interface DiscoveryProps {
  readonly status: RuntimeStatus;
  readonly disabled: boolean;
  readonly send: <T>(
    route: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ) => Promise<T>;
  readonly onStart: () => void;
  readonly onBusy: (busy: boolean) => void;
  readonly onRead: (selection: ReadSetRequest) => Promise<void>;
}

/** Edit bounded root roles and show qualified, unavailable and ambiguous results without inventing capture coverage. */
export function SourceDiscoveryPanel({
  status,
  disabled,
  send,
  onStart,
  onBusy,
  onRead,
}: DiscoveryProps): ReactElement {
  const [roots, setRoots] = useState<DiscoveryRequest["roots"]>([
    {
      sourceId: status.sources[0]?.id ?? "",
      relativePath: "",
      layout: "settings",
    },
  ]);
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reader = status.multiSourceReaders.find(
    (item) => item.id === "agent-host-sessions",
  );
  const available = reader?.available === true;

  /** Changing controls drops stale results immediately; it never broadens startup authorization. */
  function update(
    index: number,
    patch: Partial<DiscoveryRequest["roots"][number]>,
  ): void {
    generation.current++;
    setResult(null);
    setError("");
    setRoots((previous) =>
      previous.map((root, at) => (at === index ? { ...root, ...patch } : root)),
    );
  }

  /** One user action replaces the discovery view; failures remain visible and cannot restore prior rows. */
  async function discover(): Promise<void> {
    const current = ++generation.current;
    setResult(null);
    setError("");
    onStart();
    onBusy(true);
    try {
      const next = await send("/api/discover", discoveryResultSchema, {
        roots,
      });
      if (current === generation.current) setResult(next);
    } catch (failure) {
      if (current === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Source discovery failed.",
        );
    } finally {
      onBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="discovery-heading">
      <p className="eyebrow">Primary workflow</p>
      <h2 id="discovery-heading">Discover Agent Host sessions</h2>
      <p>
        Choose approved per-user, profile or custom locations. Settings
        discovery checks only globalStorage and profiles; native and overlay
        roots are inspected one directory level deep. Nothing is scanned
        automatically.
      </p>
      {!available && (
        <p role="status">
          {reader?.reason ?? "Qualified Agent Host discovery is not installed."}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void discover();
        }}
      >
        {roots.map((root, index) => (
          <fieldset key={index} disabled={disabled}>
            <legend>Discovery root {index + 1}</legend>
            <label htmlFor={`discovery-source-${index}`}>
              Approved location {index + 1}
            </label>
            <select
              id={`discovery-source-${index}`}
              value={root.sourceId}
              onChange={(event) =>
                update(index, {
                  sourceId: event.target.value,
                  relativePath: "",
                })
              }
            >
              {status.sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.id}: {source.path}
                </option>
              ))}
            </select>
            <label htmlFor={`discovery-role-${index}`}>
              Source role {index + 1}
            </label>
            <select
              id={`discovery-role-${index}`}
              value={root.layout}
              onChange={(event) => {
                const layout = event.target.value;
                if (
                  layout === "settings" ||
                  layout === "catalog" ||
                  layout === "history" ||
                  layout === "overlay"
                )
                  update(index, { layout });
              }}
            >
              <option value="settings">
                App settings home (User): default + profiles
              </option>
              <option value="catalog">Exact Agent Host catalog</option>
              <option value="history">
                Native session-state root or exact JSONL file
              </option>
              <option value="overlay">
                Host session-data root or exact database
              </option>
            </select>
            <label htmlFor={`discovery-path-${index}`}>
              Relative path {index + 1} (blank for the approved location)
            </label>
            <input
              id={`discovery-path-${index}`}
              value={root.relativePath}
              onChange={(event) =>
                update(index, { relativePath: event.target.value })
              }
            />
            {roots.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  generation.current++;
                  setResult(null);
                  setRoots((previous) =>
                    previous.filter((_, at) => at !== index),
                  );
                }}
              >
                Remove root {index + 1}
              </button>
            )}
          </fieldset>
        ))}
        <div className="discovery-actions">
          <button
            type="button"
            disabled={disabled || roots.length >= 16 || !status.sources.length}
            onClick={() => {
              setResult(null);
              setRoots((previous) => [
                ...previous,
                {
                  sourceId: status.sources[0]?.id ?? "",
                  relativePath: "",
                  layout: "history",
                },
              ]);
            }}
          >
            Add discovery root
          </button>
          <button
            className="primary"
            type="submit"
            disabled={
              disabled || !available || roots.some((root) => !root.sourceId)
            }
          >
            {result ? "Refresh discovered sessions" : "Discover sessions"}
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div role="region" aria-label="Discovered sessions">
          <p>
            Read at {new Date(result.finishedAtMs).toLocaleTimeString()}.
            Transient view; no saved catalog.
          </p>
          {result.issues.length > 0 && (
            <ul>
              {result.issues.map((issue, index) => (
                <li key={index}>
                  <strong>{issue.code}</strong>: {issue.message}
                  {issue.sourceId && (
                    <code>
                      {issue.sourceId}: {issue.relativePath}
                    </code>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!result.sessions.length && (
            <p>
              No qualified retained sessions are available from these
              selections. This is not a successful empty session.
            </p>
          )}
          <ul className="source-list">
            {result.sessions.map((session) => (
              <li key={session.id}>
                <div>
                  <strong>
                    {session.runtime === "copilot-agent-host"
                      ? "Copilot Agent Host"
                      : "Unqualified native backing"}
                  </strong>
                  <code>{session.sdkSessionId}</code>
                  <p>
                    Mode: unknown | Execution location: unknown | Analysis
                    provider: separate
                  </p>
                  {session.archived && <p>Archived in the source catalog</p>}
                  <p>
                    {session.state}: {session.reason}
                  </p>
                  <p>{session.references.length} original source references</p>
                  <ul aria-label="Referenced sources">
                    {result.locators
                      .filter((locator) =>
                        session.references.some(
                          (reference) =>
                            reference.sourceId === locator.evidenceSourceId,
                        ),
                      )
                      .map((locator) => (
                        <li key={locator.evidenceSourceId}>
                          <code>
                            {locator.sourceId}: {locator.relativePath}
                          </code>
                        </li>
                      ))}
                  </ul>
                  <button
                    type="button"
                    disabled={disabled || !session.selection}
                    onClick={() => {
                      if (session.selection) void onRead(session.selection);
                    }}
                  >
                    Open retained session
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
