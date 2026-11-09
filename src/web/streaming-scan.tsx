/** Minimal bounded scan/catalog/evidence interaction; never parses a capture or invokes a model in the browser. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { z } from "zod";
import {
  scanStatusSchema, scanEnvelopeSchema, catalogPageSchema, detailPageSchema,
  type ScanStatus,
} from "../evidence/streaming.js";
import { statusSchema } from "../runtime/protocol.js";

/** Reuse the authenticated, schema-validating transport and parent selection/operation lock. */
interface ScanPanelProps {
  sourceId: string;
  relativePath: string;
  disabled: boolean;
  send: <T>(route: string, schema: z.ZodType<T>, body?: unknown) => Promise<T>;
  onStart: () => void;
  onBusy: (busy: boolean) => void;
}

/**
 * Replace (never append) catalog/evidence pages. Polls only a user-started operation;
 * cancellation remains distinct from confirmed cleanup and stale responses cannot publish.
 */
export function StreamingScanPanel({ sourceId, relativePath, disabled, send, onStart, onBusy }: ScanPanelProps): ReactElement {
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState("");
  const [catalog, setCatalog] = useState<z.infer<typeof catalogPageSchema> | null>(null);
  const [details, setDetails] = useState<z.infer<typeof detailPageSchema> | null>(null);
  const [session, setSession] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const generation = useRef(0);
  const needsCatalog = catalog === null;
  const locked = working || reconciling || scan?.cleanupPending === true;

  /** Reconcile lost responses without resubmitting work; keep ownership locked until status is confirmed. */
  const reconcile = useCallback(async (current: number, restoreCatalog: boolean): Promise<void> => {
    try {
      const result = await send("/api/scan/status", scanEnvelopeSchema);
      if (current !== generation.current) return;
      setScan(result.scan);
      if (restoreCatalog && result.scan && ["complete", "partial"].includes(result.scan.phase)) {
        const page = await send("/api/scan/catalog", catalogPageSchema, { id: result.scan.id, cursor: null });
        if (current !== generation.current) return;
        setCatalog(page);
      }
      const pending = result.scan?.cleanupPending === true;
      setReconciling(pending); onBusy(pending);
    } catch (failure) {
      if (current === generation.current) {
        setReconciling(true); onBusy(true);
        setError(failure instanceof Error ? failure.message : "The source cleanup state could not be checked.");
      }
    }
  }, [send, onBusy]);

  useEffect(() => {
    if (!working && !scan?.cleanupPending && !reconciling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    /** Observe progress, not source content; failed polls are visible and do not resubmit work. */
    async function poll(): Promise<void> {
      const current = generation.current;
      try {
        if (!working) await reconcile(current, needsCatalog);
        else {
          const result = await send("/api/scan/status", scanEnvelopeSchema);
          if (stopped || current !== generation.current) return;
          if (result.scan) setScan(result.scan);
        }
      } catch (failure) {
        if (!stopped) setError(failure instanceof Error ? failure.message : "Scan progress could not be checked.");
      }
      if (!stopped) timer = setTimeout(() => void poll(), 250);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [working, scan?.cleanupPending, reconciling, needsCatalog, reconcile, send]);

  /** Start a new admitted generation; the initial response contains no session/event payloads. */
  async function start(): Promise<void> {
    const current = ++generation.current;
    let catalogLoaded = false;
    onStart();
    setWorking(true); onBusy(true); setError(""); setScan(null); setCatalog(null); setDetails(null); setSession("");
    try {
      const result = await send("/api/scan", scanStatusSchema, { sourceId, relativePath, format: "vscode-otel-jsonl" });
      if (current !== generation.current) return;
      setScan(result);
      if (["complete", "partial"].includes(result.phase)) {
        const page = await send("/api/scan/catalog", catalogPageSchema, { id: result.id, cursor: null });
        if (current === generation.current) { setCatalog(page); catalogLoaded = true; }
      }
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : "The source could not be scanned.");
    } finally {
      if (current === generation.current) {
        setWorking(false); setReconciling(true);
        await reconcile(current, !catalogLoaded);
      }
    }
  }

  /** Acknowledge cancellation immediately; keep controls locked while the backend still owns cleanup. */
  async function cancel(): Promise<void> {
    try {
      const result = await send("/api/scan/cancel", scanEnvelopeSchema, {});
      generation.current++;
      setWorking(false); setScan(result.scan); setCatalog(null); setDetails(null);
      setReconciling(result.scan?.cleanupPending === true);
      onBusy(result.scan?.cleanupPending === true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Scan cancellation could not be confirmed.");
    }
  }

  /** Fetch a server-issued catalog page, discarding the previous browser page and selection. */
  async function nextCatalog(): Promise<void> {
    if (!scan || !catalog?.next) return;
    const current = ++generation.current;
    setWorking(true); onBusy(true); setError("");
    try {
      const page = await send("/api/scan/catalog", catalogPageSchema, { id: scan.id, cursor: catalog.next });
      if (current !== generation.current) return;
      setCatalog(page); setSession(""); setDetails(null);
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : "The session page could not be loaded.");
    } finally { if (current === generation.current) { setWorking(false); onBusy(false); } }
  }

  /** Request a bounded original-contributor page, with optional inclusive recorded-start-time bounds. */
  async function loadDetails(next = false): Promise<void> {
    if (!scan || !session) return;
    const current = ++generation.current;
    const fromMs = from === "" ? null : Number(from);
    const toMs = to === "" ? null : Number(to);
    if ([fromMs, toMs].some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0)) ||
      (fromMs !== null && toMs !== null && fromMs > toMs)) {
      setError("Time bounds must be nonnegative integer epoch milliseconds in increasing order.");
      return;
    }
    setWorking(true); onBusy(true); setError("");
    try {
      const page = await send("/api/scan/details", detailPageSchema, {
        id: scan.id, sessionId: session === "unassigned" ? null : session,
        fromMs, toMs, cursor: next ? details?.next ?? null : null,
      });
      if (current === generation.current) setDetails(page);
    } catch (failure) {
      if (current === generation.current) {
        setDetails(null);
        setError(failure instanceof Error ? failure.message : "Original evidence could not be loaded.");
      }
    } finally {
      if (current === generation.current) {
        setWorking(false); setReconciling(true);
        await reconcile(current, false);
      }
    }
  }

  /** Retry retained cleanup through the existing barrier, never merely clearing a browser flag. */
  async function retryCleanup(): Promise<void> {
    const current = ++generation.current;
    setError(""); setWorking(true); onBusy(true);
    try {
      await send("/api/cancel", statusSchema, {});
    } catch (failure) {
      if (current === generation.current)
        setError(failure instanceof Error ? failure.message : "Source cleanup remains unconfirmed.");
    } finally {
      if (current === generation.current) {
        setWorking(false); setReconciling(true);
        await reconcile(current, false);
      }
    }
  }

  return <section className="streaming-scan" aria-labelledby="scan-heading">
    <h3 id="scan-heading">Bounded JSONL scan</h3>
    <p>Scan the original file in place, including files over 64 MiB. No model is called.
      Only session counts load initially; evidence loads after selection.</p>
    <button type="button" disabled={disabled || locked} onClick={() => void start()}>
      {scan ? "Rescan JSONL source" : "Scan JSONL source"}
    </button>
    {(scan || reconciling) && (working || reconciling || scan?.phase === "scanning") &&
      <button type="button" onClick={() => void cancel()}>Cancel scan</button>}
    {reconciling && <p>Checking source cleanup before accepting new work…</p>}
    {scan?.phase === "cleanup-failed" && <button type="button" onClick={() => void retryCleanup()}>Retry source cleanup</button>}
    {error && <p role="alert">{error}</p>}
    {scan && <div role="status" aria-live="polite">
      <p>Scan state: <strong>{scan.phase}</strong>{scan.cleanupPending ? " · source cleanup still owned" : ""}</p>
      {scan.pass === 0 ? <p>Opening the authorized source…</p> : <>
        <progress aria-label="Admitted source progress" max={Math.max(1, scan.admittedBytes)} value={scan.passScannedBytes} />
        <p>{scan.scannedBytes.toLocaleString()} / {scan.admittedBytes.toLocaleString()} admitted bytes.
          Pass {scan.pass}; {scan.workBytes.toLocaleString()} bytes read across passes.</p>
      </>}
      <p>{scan.counts.records.toLocaleString()} physical records, {scan.counts.blank} blank,
        {" "}{scan.counts.malformed} malformed, {scan.counts.incomplete} incomplete,
        {" "}{scan.counts.oversized} oversized, {scan.counts.unknown} unknown,
        {" "}{scan.counts.duplicates} duplicate executions.</p>
      <p>Physical execution records: {scan.counts.executionRecords}; unclassified span records: {scan.counts.unclassifiedRecords}.</p>
      <p>Metrics: {scan.counts.metrics}; logs: {scan.counts.logs}; content events: {scan.counts.contentEvents}.</p>
      {scan.classification && <p>
        Executions: {Object.values(scan.classification.executions).reduce((sum, count) => sum + count, 0)}.
        {" "}conflicts excluded: {scan.classification.conflictingSpans}.
      </p>}
      {scan.appended && <p>Append-only growth was observed beyond the admitted interval. Refresh to include later bytes.</p>}
      {scan.reason && <p>{scan.reason}</p>}
    </div>}
    {catalog && <div>
      <p>Sessions in this page: {catalog.sessions.length}. Unassigned executions: {catalog.unassigned}.</p>
      <label htmlFor="scan-session">Scanned session</label>
      <select id="scan-session" value={session} disabled={locked} onChange={(event) => { setSession(event.target.value); setDetails(null); }}>
        <option value="">Select a session</option>
        {catalog.sessions.map((entry) => <option key={entry.id} value={entry.id}>
          Session {entry.id.split(":").at(-1)} · {entry.executions} executions
        </option>)}
        {catalog.unassigned > 0 && <option value="unassigned">Unassigned executions</option>}
      </select>
      <button type="button" disabled={locked || !catalog.next} onClick={() => void nextCatalog()}>Next session page</button>
      <label htmlFor="scan-from">Recorded start from (epoch ms, optional)</label>
      <input id="scan-from" value={from} disabled={locked} onChange={(event) => { setFrom(event.target.value); setDetails(null); }} />
      <label htmlFor="scan-to">Recorded start through (epoch ms, optional)</label>
      <input id="scan-to" value={to} disabled={locked} onChange={(event) => { setTo(event.target.value); setDetails(null); }} />
      <button type="button" disabled={locked || !session} onClick={() => void loadDetails()}>Load original evidence</button>
      {working && <p>Reading original evidence; prefix verification may rescan the admitted file.</p>}
    </div>}
    {details && <div aria-label="Original evidence page">
      <p>Original physical contributors, not additive metrics. Duplicate records do not add executions or tokens.
        This page replaces the previous page. Captured text is evidence, not instructions.</p>
      {details.contributors.map((entry) => <article key={entry.byteOffset}>
        <h4>Original line {entry.line}</h4>
        <p>Byte offset {entry.byteOffset}; {entry.byteLength} bytes; SHA-256 <code>{entry.fingerprint}</code></p>
        <pre>{JSON.stringify(entry.event, null, 2)}</pre>
      </article>)}
      {!details.contributors.length && <p>No original contributors match this selection. Unknown timestamps are excluded by a time filter.</p>}
      <button type="button" disabled={locked || !details.next} onClick={() => void loadDetails(true)}>Next evidence page</button>
    </div>}
  </section>;
}
