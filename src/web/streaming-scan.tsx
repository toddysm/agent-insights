/** Session-first bounded scan with reconciled coverage and secondary diagnostics; never parses captures or invokes models. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { z } from "zod";
import {
  scanStatusSchema, scanEnvelopeSchema, catalogPageSchema, detailPageSchema,
  physicalRecordTotal, type ScanStatus,
} from "../evidence/streaming.js";
import { statusSchema } from "../runtime/protocol.js";
import type { ScanReportSelection } from "../metrics/report.js";

/** Reuse the authenticated, schema-validating transport and parent selection/operation lock. */
interface ScanPanelProps {
  sourceId: string;
  relativePath: string;
  disabled: boolean;
  send: <T>(route: string, schema: z.ZodType<T>, body?: unknown) => Promise<T>;
  onStart: () => void;
  onBusy: (busy: boolean) => void;
  onReport: (selection: ScanReportSelection | null) => void;
}

/** A received catalog is invalid, unlike an uncertain transport response that can be recovered from status. */
class CatalogReconciliationError extends Error {}

/** Validate received catalog data explicitly so schema rejection stays distinguishable from a lost authenticated response. */
async function readCatalog(send: ScanPanelProps["send"], id: string, cursor: string | null): Promise<z.infer<typeof catalogPageSchema>> {
  const response = await send("/api/scan/catalog", z.unknown(), { id, cursor });
  const parsed = catalogPageSchema.safeParse(response);
  if (!parsed.success) throw new CatalogReconciliationError("The local service returned an invalid response.");
  return parsed.data;
}

/** Generation-bound cumulative counts and identities, without retaining replaced page payloads. */
interface CatalogProgress {
  id: string;
  sessionIds: Set<string>;
  direct: number;
  associated: number;
}

/** Reject inconsistent pages and return cumulative progress; offset zero resets it and the final page must reconcile exactly. */
function checkedCatalog(page: z.infer<typeof catalogPageSchema>, scan: ScanStatus, offset: number,
  previous: CatalogProgress | null): CatalogProgress {
  const prior = offset === 0 ? null : previous;
  const sessionIds = new Set(prior?.sessionIds);
  for (const entry of page.sessions) sessionIds.add(entry.id);
  const direct = (prior?.direct ?? 0) + page.sessions.reduce((sum, entry) => sum + entry.executions, 0);
  const associated = (prior?.associated ?? 0) + page.sessions.reduce((sum, entry) => sum + entry.associatedExecutions, 0);
  if (page.id !== scan.id || page.totalSessions !== scan.sessions || page.unassigned !== scan.unassigned ||
    page.offset !== offset || !scan.reconciliation ||
    offset !== (prior?.sessionIds.size ?? 0) || (prior !== null && prior.id !== scan.id) ||
    sessionIds.size !== offset + page.sessions.length ||
    direct > scan.reconciliation.directExecutions || associated > scan.reconciliation.associatedExecutions ||
    (page.next === null &&
      (direct !== scan.reconciliation.directExecutions || associated !== scan.reconciliation.associatedExecutions)))
    throw new CatalogReconciliationError("Session page counts do not match this scan generation. Reconciliation unavailable; rescan explicitly.");
  return { id: page.id, sessionIds, direct, associated };
}

/**
 * Replace (never append) catalog/evidence pages. Polls only a user-started operation;
 * cancellation remains distinct from confirmed cleanup and stale responses cannot publish.
 * Discovery, original evidence and explicit whole-session report actions stay distinct.
 */
export function StreamingScanPanel({ sourceId, relativePath, disabled, send, onStart, onBusy, onReport }: ScanPanelProps): ReactElement {
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
  const requestIdentity = useRef<string | null>(null);
  const catalogProgress = useRef<CatalogProgress | null>(null);
  const catalogRejected = useRef(false);
  const needsCatalog = catalog === null;
  const locked = disabled || working || reconciling || scan?.cleanupPending === true;
  const selectedSession = catalog?.sessions.find((entry) => entry.id === session);
  const totals = scan?.reconciliation;

  useEffect(() => () => { generation.current++; }, []);

  /** Latch catalog rejection and invalidate callbacks/derived state without changing backend cleanup ownership. */
  const rejectCatalog = useCallback((): number => {
    const current = ++generation.current;
    catalogRejected.current = true; catalogProgress.current = null;
    setScan(null); setCatalog(null); setDetails(null); setSession(""); onReport(null);
    return current;
  }, [onReport]);

  /** Reconcile without resubmitting work; discard invalidated catalogs and retain the lock until status is confirmed. */
  const reconcile = useCallback(async (current: number, restoreCatalog: boolean): Promise<void> => {
    let observedCleanupPending = true;
    try {
      const result = await send("/api/scan/status", scanEnvelopeSchema);
      if (current !== generation.current) return;
      observedCleanupPending = result.scan?.cleanupPending === true;
      const snapshot = result.scan?.requestId === requestIdentity.current ? result.scan : null;
      const completed = snapshot !== null && ["complete", "partial"].includes(snapshot.phase);
      const publishable = completed && !catalogRejected.current;
      setScan(completed && catalogRejected.current ? null : snapshot);
      if (!publishable) {
        catalogProgress.current = null;
        setCatalog(null); setDetails(null); setSession("");
        onReport(null);
      }
      if (result.scan && !snapshot) {
        setError("The scan was not accepted or was superseded. Start a new scan explicitly.");
      }
      if (restoreCatalog && snapshot && publishable) {
        const page = await readCatalog(send, snapshot.id, null);
        if (current !== generation.current || catalogRejected.current) return;
        catalogProgress.current = checkedCatalog(page, snapshot, 0, catalogProgress.current);
        setCatalog(page);
      }
      const pending = result.scan?.cleanupPending === true;
      setReconciling(pending); onBusy(pending);
    } catch (failure) {
      if (current === generation.current) {
        if (failure instanceof CatalogReconciliationError) rejectCatalog();
        catalogProgress.current = null;
        setScan(null); setCatalog(null); setDetails(null); setSession("");
        onReport(null);
        const pending = observedCleanupPending;
        setReconciling(pending); onBusy(pending);
        setError(failure instanceof Error ? failure.message : "The source cleanup state could not be checked.");
      }
    }
  }, [send, onBusy, onReport, rejectCatalog]);

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
          if (result.scan?.requestId === requestIdentity.current) setScan(result.scan);
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
    let current = ++generation.current;
    const requestId = crypto.randomUUID();
    requestIdentity.current = requestId;
    catalogProgress.current = null;
    catalogRejected.current = false;
    let catalogLoaded = false;
    onStart();
    setWorking(true); onBusy(true); setError(""); setScan(null); setCatalog(null); setDetails(null); setSession("");
    try {
      const result = await send("/api/scan", scanStatusSchema, { requestId, sourceId, relativePath, format: "vscode-otel-jsonl" });
      if (current !== generation.current) return;
      if (result.requestId !== requestId) throw new Error("The scan response did not match the current request.");
      setScan(result);
      if (["complete", "partial"].includes(result.phase)) {
        const page = await readCatalog(send, result.id, null);
        if (current === generation.current) {
          catalogProgress.current = checkedCatalog(page, result, 0, catalogProgress.current);
          setCatalog(page); catalogLoaded = true;
        }
      }
    } catch (failure) {
      if (current === generation.current) {
        if (failure instanceof CatalogReconciliationError) current = rejectCatalog();
        setError(failure instanceof Error ? failure.message : "The source could not be scanned.");
      }
    } finally {
      if (current === generation.current) {
        setWorking(false); setReconciling(true);
        await reconcile(current, !catalogLoaded);
      }
    }
  }

  /** Acknowledge cancellation immediately; keep controls locked while the backend still owns cleanup. */
  async function cancel(): Promise<void> {
    const current = generation.current;
    try {
      const result = await send("/api/scan/cancel", scanEnvelopeSchema, {});
      if (current !== generation.current) return;
      generation.current++;
      catalogProgress.current = null;
      onReport(null);
      setWorking(false); setScan(result.scan); setCatalog(null); setDetails(null);
      setReconciling(result.scan?.cleanupPending === true);
      onBusy(result.scan?.cleanupPending === true);
    } catch (failure) {
      if (current === generation.current)
        setError(failure instanceof Error ? failure.message : "Scan cancellation could not be confirmed.");
    }
  }

  /** Replace the page; rejected catalogs stay unavailable until an explicit rescan, while cleanup status remains observable. */
  async function nextCatalog(): Promise<void> {
    if (!scan || !catalog?.next) return;
    let current = ++generation.current;
    setWorking(true); onBusy(true); setError("");
    try {
      const page = await readCatalog(send, scan.id, catalog.next);
      if (current !== generation.current) return;
      catalogProgress.current = checkedCatalog(page, scan, catalog.offset + catalog.sessions.length, catalogProgress.current);
      setCatalog(page); setSession(""); setDetails(null);
      onReport(null);
    } catch (failure) {
      if (current === generation.current) {
        current = rejectCatalog();
        setError(failure instanceof Error ? failure.message : "The session page could not be loaded.");
      }
    } finally {
      if (current === generation.current) {
        setWorking(false); setReconciling(true);
        await reconcile(current, false);
      }
    }
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
    <p id="scan-guidance">Scan the original file in place, including supported extension exports over 64 MiB.
      No model is called. Scanning discovers sessions, not a report.
      Then select a Scanned session and choose Open session report, or load paged original evidence.</p>
    <button id="scan-source" type="button" aria-describedby="scan-guidance" disabled={disabled || locked} onClick={() => void start()}>
      {scan ? "Rescan JSONL source" : "Scan JSONL source"}
    </button>
    {(scan || reconciling) && (working || reconciling || scan?.phase === "scanning") &&
      <button type="button" onClick={() => void cancel()}>Cancel scan</button>}
    {reconciling && <p>Checking source cleanup before accepting new work…</p>}
    {scan?.phase === "cleanup-failed" && <button type="button" onClick={() => void retryCleanup()}>Retry source cleanup</button>}
    {error && <p role="alert">{error}</p>}
    {scan && <div role="status" aria-live="polite">
      <p>Scan state: <strong>{scan.phase}</strong>{scan.cleanupPending ? " · source cleanup still owned" : ""}</p>
      {scan.phase === "scanning" && (scan.pass === 0 ? <p>Opening the authorized source…</p> :
        <progress aria-label="Admitted source progress" max={Math.max(1, scan.admittedBytes)} value={scan.passScannedBytes} />
      )}
      {scan.appended && <p>Append-only growth was observed beyond the admitted interval. Refresh to include later bytes.</p>}
      {scan.reason && <p>{scan.reason}</p>}
      {!["scanning", "complete", "partial"].includes(scan.phase) && <p>
        No session report is available from this scan. Review the diagnostic above and the selected
        source/format before explicitly retrying. Source cleanup must finish before new work.
      </p>}
    </div>}
    {catalog && <div>
      <div className="scan-result-heading">
        <h4>Sessions found <strong>{catalog.totalSessions.toLocaleString()}</strong></h4>
        <p>In this selected source and admitted scan, not every session you have.</p>
      </div>
      <p className="scan-page-position">{catalog.totalSessions === 0 ? "Showing 0 of 0 sessions" :
        `Showing ${catalog.offset + 1}–${catalog.offset + catalog.sessions.length} of ${catalog.totalSessions} sessions`}</p>
      {catalog.sessions.length === 0 && !catalog.next && <p role="status">
        No reportable sessions were found. No session report was created.
        {catalog.unassigned > 0
          ? " Unassigned executions can be inspected with Load original evidence, but cannot form a session report."
          : " Check the selected export and scan diagnostics; no other session was substituted."}
      </p>}
      <label htmlFor="scan-session">Scanned session (discovery and evidence)</label>
      <select id="scan-session" aria-describedby="scan-report-guidance" value={session}
        disabled={locked || (catalog.sessions.length === 0 && catalog.unassigned === 0)}
        onChange={(event) => { setSession(event.target.value); setDetails(null); onReport(null); }}>
        <option value="">Select a session</option>
        {catalog.sessions.map((entry) => <option key={entry.id} value={entry.id}>
          Session {entry.id.split(":").at(-1)} · {entry.executions} counted · {entry.associatedExecutions} associated (not added)
        </option>)}
        {catalog.unassigned > 0 && <option value="unassigned">Unassigned executions</option>}
      </select>
      <button type="button" disabled={locked || !catalog.next} onClick={() => void nextCatalog()}>Next session page</button>
      <button type="button" aria-describedby="scan-report-guidance" disabled={locked || !selectedSession} onClick={() => {
        if (!scan || !selectedSession) return;
        generation.current++;
        onBusy(true);
        onReport({ id: scan.id, sessionId: selectedSession.id, expectedExecutions: selectedSession.executions });
        window.history.replaceState(null, "", "#session-report");
      }}>Open session report</button>
      <p id="scan-report-guidance">Select a Scanned session, then choose Open session report to calculate its recorded metrics locally.
        Selecting a session alone does not open a report.
        Reports cover the entire admitted session, not this evidence page or the optional time filter.
        Metrics use direct membership only; associated records are inspectable through Load original evidence, not added to totals.
        Unassigned executions cannot form a session report.</p>
      {totals && <section className="scan-coverage" aria-label="Report coverage">
        <h4>Report coverage</h4>
        <p>{totals.trustedExecutions.toLocaleString()} unique trusted executions in this scan.
          One execution is one supported model call, tool call, agent span or hook execution, not one session.</p>
        <dl>
          <div><dt>Counted in session reports</dt><dd>{totals.directExecutions.toLocaleString()} of {totals.trustedExecutions.toLocaleString()}</dd></div>
          <div><dt>Without direct session membership</dt><dd>{totals.withoutDirectMembership.toLocaleString()} of {totals.trustedExecutions.toLocaleString()}</dd></div>
        </dl>
        <p>{totals.directExecutions.toLocaleString()} direct + {totals.withoutDirectMembership.toLocaleString()} without direct membership
          {" "}= {totals.trustedExecutions.toLocaleString()} unique trusted executions across all {catalog.totalSessions} sessions, not just this page.</p>
        <p>Session metrics use direct membership only. This is attribution coverage, not proof of complete captured history
          or complete timing, tool or token measurements.</p>
        {totals.withoutDirectMembership > 0 && <p className="notice">
          Activity without direct membership is outside session metric totals. Select Unassigned executions and Load original evidence
          to inspect it; a parent-session association may still exist and does not assign a direct owner.
        </p>}
        <p>Parent-session associations: {totals.associatedExecutions.toLocaleString()} unique executions.
          These relationships can overlap either membership group; they are not an additional activity bucket or additive usage.
          Per-session associations are shown in the session list and inspectable through Load original evidence.</p>
        {scan?.phase === "partial" && <p className="notice">Coverage is partial. Review Scan diagnostics below for excluded or unclassified input;
          each report explains its own measurement coverage.</p>}
      </section>}
      <label htmlFor="scan-from">Recorded start from (epoch ms, optional)</label>
      <input id="scan-from" value={from} disabled={locked} onChange={(event) => { setFrom(event.target.value); setDetails(null); }} />
      <label htmlFor="scan-to">Recorded start through (epoch ms, optional)</label>
      <input id="scan-to" value={to} disabled={locked} onChange={(event) => { setTo(event.target.value); setDetails(null); }} />
      <button type="button" disabled={locked || !session} onClick={() => void loadDetails()}>Load original evidence</button>
      {working && <p>Reading original evidence; prefix verification may rescan the admitted file.</p>}
    </div>}
    {scan && <details className="scan-diagnostics">
      <summary>Scan diagnostics</summary>
      <p>Technical accounting for this scan generation only. Physical records are input lines, not sessions or metric contributions.
        During scanning or a stopped scan these counts describe only the observed prefix.</p>
      <dl>
        <div><dt>Physical records observed</dt><dd>{scan.counts.records.toLocaleString()}</dd></div>
        <div><dt>Execution records (including repeats and exclusions)</dt><dd>{scan.counts.executionRecords.toLocaleString()}</dd></div>
        <div><dt>Unclassified span records</dt><dd>{scan.counts.unclassifiedRecords.toLocaleString()}</dd></div>
        <div><dt>Metric records</dt><dd>{scan.counts.metrics.toLocaleString()}</dd></div>
        <div><dt>Log records</dt><dd>{scan.counts.logs.toLocaleString()}</dd></div>
        <div><dt>Content-event records</dt><dd>{scan.counts.contentEvents.toLocaleString()}</dd></div>
        <div><dt>Blank lines</dt><dd>{scan.counts.blank.toLocaleString()}</dd></div>
        <div><dt>Malformed records</dt><dd>{scan.counts.malformed.toLocaleString()}</dd></div>
        <div><dt>Incomplete records</dt><dd>{scan.counts.incomplete.toLocaleString()}</dd></div>
        <div><dt>Oversized records</dt><dd>{scan.counts.oversized.toLocaleString()}</dd></div>
        <div><dt>Unknown records</dt><dd>{scan.counts.unknown.toLocaleString()}</dd></div>
      </dl>
      <p>Disjoint physical categories sum to {physicalRecordTotal(scan.counts).toLocaleString()} of {scan.counts.records.toLocaleString()} observed records.
        Repeats are already included, not an extra physical category.</p>
      <p>Unclassified spans lack a supported execution classification, so they are outside trusted execution totals.
        They are not missing sessions. Metrics, logs and content events are non-execution telemetry;
        blank, malformed, incomplete, oversized and unknown input does not become trusted activity.</p>
      {totals ? <div>
        <p>Execution records: {scan.counts.executionRecords.toLocaleString()} = {totals.trustedExecutions.toLocaleString()} trusted originals
          {" "}+ {totals.repeatedExecutionRecords.toLocaleString()} trusted repeat records
          {" "}+ {totals.excludedExecutionRecords.toLocaleString()} excluded execution records.</p>
        <p>Conflicting span identities: {scan.classification?.conflictingSpans.toLocaleString()}.
          An identity can exclude multiple physical records, including repeats.
          Conflicts may involve unclassified spans; the identity count is not subtracted from a physical-record count.</p>
      </div> : <p>Trusted execution reconciliation is unavailable for this scan state; no report totals are inferred.</p>}
      <p>{scan.scannedBytes.toLocaleString()} / {scan.admittedBytes.toLocaleString()} admitted bytes.
        Pass {scan.pass}; {scan.workBytes.toLocaleString()} bytes read across passes.</p>
    </details>}
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
