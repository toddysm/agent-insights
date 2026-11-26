/**
 * One transient, budgeted JSONL catalog. All detail pages rescan the admitted
 * original prefix and verify its digest; no copied corpus, disk spill or history.
 * RuntimeService owns every borrowed descriptor and the publication/cleanup barrier.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { ReadView } from "../evidence/contracts.js";
import { associatedWithSession } from "../evidence/relationships.js";
import { jsonLines } from "../evidence/readers/jsonl.js";
import { scanVscodeOtel, vscodeOtelReader, vscodeOtelRecordKey } from "../evidence/readers/vscode-otel.js";
import {
  STREAM_LIMITS, ScanBudgetExceeded, catalogPageSchema, detailPageSchema, scanStatusSchema, scanReconciliationSchema,
  type DetailRequest, type ScanRequest, type ScanStatus, type StreamLimits,
} from "../evidence/streaming.js";
import { RuntimeError, cancelledRead } from "./errors.js";
import { byteChunks, type FileState, type StreamedSource } from "./sources.js";
import { recordedReport } from "./report.js";
import { scanReportSchema, type ScanReportRequest, type ScanMetricRequest, type ScanReport, type ScanMetricPage, type ReportMeasurement } from "../metrics/report.js";

/** Signing material is runtime-local and discarded with this instance, never persisted. */
const cursorBody = z.strictObject({
  id: z.string(), kind: z.enum(["catalog", "detail"]), offset: z.number().int().nonnegative(),
  selection: z.string(), expires: z.number(),
});

/** First-contributor metadata stays internal; only bounded catalog/detail projections cross HTTP. */
export class JsonlScan {
  private statusValue: ScanStatus | null = null;
  private view: ReadView | null = null;
  private selectionValue: ScanRequest | null = null;
  private identity: FileState | null = null;
  private digest: string | null = null;
  private readonly secret = randomBytes(32);
  private started = 0;
  private executionAccounting: { trustedRecords: number; excludedRecords: number } | null = null;

  /** Production uses fixed ceilings; lower code-owned ceilings make boundary/one-over tests inexpensive. */
  constructor(private readonly limits: StreamLimits = STREAM_LIMITS) {
    for (const key of Object.keys(STREAM_LIMITS) as (keyof StreamLimits)[]) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > STREAM_LIMITS[key])
        throw new RangeError("Scan ceilings must be positive safe integers no larger than production limits");
    }
  }

  /** Admit a generation before asynchronous acquisition so opening/cancellation has observable ownership. */
  prepare(id: string, selection: ScanRequest): void {
    this.started = performance.now();
    this.view = null;
    this.executionAccounting = null;
    this.selectionValue = { ...selection };
    this.statusValue = {
      id, requestId: selection.requestId ?? null, sourceId: selection.sourceId, phase: "scanning", reason: "Opening the authorized original source.",
      startedAtMs: Date.now(), finishedAtMs: null, inputStartedAtMs: null, inputFinishedAtMs: null,
      sourceBytes: 0, admittedBytes: 0, scannedBytes: 0,
      workBytes: 0, pass: 0, passScannedBytes: 0, appended: false, cleanupPending: true,
      counts: { records: 0, blank: 0, malformed: 0, incomplete: 0, oversized: 0, unknown: 0, duplicates: 0, executionRecords: 0, unclassifiedRecords: 0, metrics: 0, logs: 0, contentEvents: 0 },
      classification: null, sessions: null, unassigned: null, reconciliation: null,
    };
  }

  /** Return detached progress; expire completed catalogs without claiming an owned descriptor was closed. */
  get status(): ScanStatus | null {
    if (this.statusValue && ["complete", "partial"].includes(this.statusValue.phase) &&
      performance.now() - this.started >= this.limits.lifetimeMs) {
      const cleanupPending = this.statusValue.cleanupPending;
      this.fail(new ScanBudgetExceeded("lifetime"));
      this.statusValue.cleanupPending = cleanupPending;
    }
    return this.statusValue ? { ...this.statusValue, counts: { ...this.statusValue.counts },
      reconciliation: this.statusValue.reconciliation ? { ...this.statusValue.reconciliation } : null } : null;
  }

  /** Drop catalog authority immediately; cancellation acknowledgement does not assert cleanup. */
  invalidate(): void {
    this.view = null;
    this.selectionValue = null;
    this.digest = null;
    this.identity = null;
    if (this.statusValue && this.statusValue.phase !== "cleanup-failed")
      this.statusValue = { ...this.statusValue, phase: "cancelled", reason: "The generation was cancelled or replaced.",
        sessions: null, unassigned: null, classification: null, reconciliation: null };
  }

  /** Reconcile confirmed cleanup after cancellation/retry without restoring an old catalog. */
  cleanupConfirmed(id?: string): void {
    if (this.statusValue && (id === undefined || this.statusValue.id === id)) {
      this.statusValue.cleanupPending = false;
      if (this.statusValue.phase === "cleanup-failed") this.statusValue.phase = "cancelled";
    }
  }

  /** Fail closed with controlled status; errors never contain source values or private paths. */
  fail(error: unknown): void {
    this.view = null;
    if (!this.statusValue) return;
    const cleanup = error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED";
    this.statusValue.phase = cleanup ? "cleanup-failed"
      : error instanceof ScanBudgetExceeded ? "budget-exceeded"
      : error instanceof RuntimeError && error.code === "SOURCE_CHANGED" ? "source-changed"
      : error instanceof RuntimeError && ["READ_CANCELLED", "READ_TIMEOUT"].includes(error.code) ? "cancelled"
      : "failed";
    this.statusValue.cleanupPending = cleanup;
    this.statusValue.reason = error instanceof ScanBudgetExceeded ? error.message
      : error instanceof RuntimeError ? error.message : "The scan could not be completed.";
    this.statusValue.finishedAtMs = Date.now();
    this.statusValue.sessions = null;
    this.statusValue.unassigned = null;
    this.statusValue.classification = null;
    this.statusValue.reconciliation = null;
    this.executionAccounting = null;
  }

  /** Apply monotonic lifetime and cumulative physical-read budgets on every chunk/record/page. */
  private check(signal: AbortSignal): ScanStatus {
    if (signal.aborted) throw cancelledRead(signal);
    const status = this.statusValue;
    if (!status) throw new RuntimeError("SCAN_STALE", "No current scan generation is available.", 409);
    if (performance.now() - this.started >= this.limits.lifetimeMs) throw new ScanBudgetExceeded("lifetime");
    if (status.workBytes > this.limits.workBytes) throw new ScanBudgetExceeded("work");
    return status;
  }

  /** Hash only the admitted prefix; read/work accounting includes every actual borrowed chunk. */
  private async *prefix(source: StreamedSource, signal: AbortSignal, hash: ReturnType<typeof createHash>): AsyncGenerator<Uint8Array> {
    const status = this.check(signal);
    let offset = 0;
    status.passScannedBytes = 0;
    if (source.boundary < status.admittedBytes)
      throw new RuntimeError("SOURCE_CHANGED", "The source was truncated; refresh before retrieving evidence.", 409);
    for await (const chunk of source.chunks()) {
      status.workBytes += chunk.byteLength;
      this.check(signal);
      const bytes = chunk.subarray(0, status.admittedBytes - offset);
      hash.update(bytes);
      offset += bytes.byteLength;
      status.passScannedBytes = offset;
      yield bytes;
      if (offset >= status.admittedBytes) break;
    }
  }

  /**
   * Rehash after an observed change, charging the same generation's work budget.
   * Reject any further change at the final check rather than publish an unverified
   * observation or retry indefinitely while a writer continues changing the file.
   */
  private async verifyPrefix(source: StreamedSource, signal: AbortSignal, digest: string): Promise<{ appended: boolean }> {
    const observation = await source.verify();
    if (observation.changed) {
      this.check(signal).pass++;
      const continuity = createHash("sha256");
      for await (const bytes of this.prefix(source, signal, continuity)) {
        void bytes;
      }
      if (continuity.digest("hex") !== digest)
        throw new RuntimeError("SOURCE_CHANGED", "The admitted source prefix changed; refresh and retry.", 409);
    }
    const final = await source.verify();
    if (final.changed)
      throw new RuntimeError("SOURCE_CHANGED", "The source changed at final verification; refresh and retry.", 409);
    this.check(signal);
    return final;
  }

  /**
   * Normalize the admitted source with full-file correlation but bounded, payload-free metadata.
   * Changed metadata triggers continuity checking; a new final-check change rejects.
   * Append is not called atomic snapshotting.
   */
  async scan(id: string, selection: ScanRequest, source: StreamedSource, signal: AbortSignal): Promise<ReadView> {
    if (this.statusValue?.id !== id) this.prepare(id, selection);
    this.identity = source.identity;
    this.executionAccounting = null;
    this.statusValue = {
      id, requestId: selection.requestId ?? null, sourceId: selection.sourceId, phase: "scanning", reason: null,
      startedAtMs: source.startedAtMs, finishedAtMs: null, inputStartedAtMs: source.startedAtMs, inputFinishedAtMs: null,
      sourceBytes: source.boundary, admittedBytes: source.boundary, scannedBytes: 0,
      workBytes: 0, pass: 1, passScannedBytes: 0, appended: false, cleanupPending: true,
      counts: { records: 0, blank: 0, malformed: 0, incomplete: 0, oversized: 0, unknown: 0, duplicates: 0, executionRecords: 0, unclassifiedRecords: 0, metrics: 0, logs: 0, contentEvents: 0 },
      classification: null, sessions: null, unassigned: null, reconciliation: null,
    };
    const status = this.statusValue;
    const hash = createHash("sha256");
    const view = await scanVscodeOtel({
      readId: id, sourceId: selection.sourceId, signal, bytes: this.prefix(source, signal, hash),
    }, {
      counts: status.counts,
      maxMetadataBytes: this.limits.metadataBytes,
      maxIdentities: this.limits.identities,
      maxReferences: this.limits.references,
      maxRecordBytes: this.limits.recordBytes,
      onLine: (line) => {
        this.check(signal);
        status.scannedBytes = line.byteOffset + line.byteLength + (line.terminated ? 1 : 0);
      },
      onExecutionAccounting: (accounting) => { this.executionAccounting = accounting; },
    });
    const digest = hash.digest("hex");
    const final = await this.verifyPrefix(source, signal, digest);
    status.appended = final.appended;
    status.reason = null;
    status.inputFinishedAtMs = Date.now();
    this.digest = digest;
    return view;
  }

  /** Publish only reconciled full-generation totals after cleanup; mismatches reject rather than manufacture coverage. */
  publish(view: ReadView): ScanStatus {
    const status = this.statusValue;
    if (!status || status.id !== view.id || status.phase !== "scanning")
      throw new RuntimeError("SCAN_STALE", "This scan generation is no longer current.", 409);
    status.finishedAtMs = Date.now();
    status.cleanupPending = false;
    status.scannedBytes = status.admittedBytes;
    status.classification = view.sources[0]?.classification ?? null;
    status.sessions = view.sessions.length;
    status.unassigned = view.events.filter((event) => event.sessionId === null).length;
    const limited = view.issues.some((issue) => issue.affectsCoverage !== false);
    status.phase = view.sources[0]?.format === null ? "format-unsupported" : limited ? "partial" : "complete";
    status.reason = !view.events.length
      ? "No supported execution spans in this interval; telemetry counts are separate. Timing/tools/tokens are unavailable, not zero."
      : limited ? "Coverage is partial; malformed, excluded, incomplete or unassigned evidence is not complete-session coverage." : null;
    if (["complete", "partial"].includes(status.phase)) {
      const memberships = new Map(view.sessions.map((session) => [session.id, 0]));
      let associatedExecutions = 0;
      for (const event of view.events) {
        if (event.sessionId !== null) {
          const count = memberships.get(event.sessionId);
          if (count === undefined)
            throw new RuntimeError("SCAN_RECONCILIATION", "Execution membership names a session outside this scan; totals are unavailable.", 409);
          memberships.set(event.sessionId, count + 1);
        }
        if (event.kind !== "message" && event.parentChat?.status === "resolved" &&
          event.parentChat.sessionId !== event.sessionId) {
          if (!event.parentChat.sessionId || !memberships.has(event.parentChat.sessionId))
            throw new RuntimeError("SCAN_RECONCILIATION", "An associated session is outside this scan; totals are unavailable.", 409);
          associatedExecutions++;
        }
      }
      if (!this.executionAccounting)
        throw new RuntimeError("SCAN_RECONCILIATION", "Physical execution accounting is unavailable; rescan before reporting.", 409);
      const totals = scanReconciliationSchema.safeParse({
        trustedExecutions: view.events.length,
        directExecutions: [...memberships.values()].reduce((sum, count) => sum + count, 0),
        withoutDirectMembership: status.unassigned,
        associatedExecutions,
        trustedExecutionRecords: this.executionAccounting.trustedRecords,
        repeatedExecutionRecords: this.executionAccounting.trustedRecords - view.events.length,
        excludedExecutionRecords: this.executionAccounting.excludedRecords,
      });
      if (!totals.success)
        throw new RuntimeError("SCAN_RECONCILIATION", "Execution counts do not reconcile; totals are unavailable.", 409);
      status.reconciliation = totals.data;
      if (!scanStatusSchema.safeParse(status).success)
        throw new RuntimeError("SCAN_RECONCILIATION", "Physical and session counts do not reconcile; totals are unavailable.", 409);
    }
    this.view = view;
    return this.status!;
  }

  /** Require an unexpired current catalog; no expired, cancelled or different-source cursor may resolve. */
  private current(id: string): { view: ReadView; status: ScanStatus } {
    if (!this.statusValue)
      throw new RuntimeError("SCAN_STALE", "No current scan generation is available.", 409);
    if (performance.now() - this.started >= this.limits.lifetimeMs)
      throw new RuntimeError("SCAN_EXPIRED", "The scan expired; refresh to create a new generation.", 409);
    const status = this.statusValue;
    if (!this.view || status.id !== id || !["complete", "partial"].includes(status.phase))
      throw new RuntimeError("SCAN_STALE", "Select the current completed scan generation.", 409);
    return { view: this.view, status };
  }

  /** Bind opaque pagination to generation, operation and exact selection without retaining cursor maps. */
  private encode(kind: "catalog" | "detail", offset: number, selection = ""): string {
    const status = this.statusValue!;
    const body = Buffer.from(JSON.stringify({ id: status.id, kind, offset, selection,
      expires: status.startedAtMs + this.limits.lifetimeMs })).toString("base64url");
    return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }

  /** Authenticate the cursor before parsing; selection mismatches are controlled errors, not empty pages. */
  private offset(id: string, kind: "catalog" | "detail", cursor: string | null, selection = ""): number {
    this.current(id);
    if (cursor === null) return 0;
    const [body, signature, extra] = cursor.split(".");
    if (!body || !signature || extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(signature))
      throw new RuntimeError("SCAN_CURSOR", "The scan cursor is invalid or expired.", 400);
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (expected.length !== supplied.length || supplied.toString("base64url") !== signature ||
      Buffer.from(body, "base64url").toString("base64url") !== body || !timingSafeEqual(expected, supplied))
      throw new RuntimeError("SCAN_CURSOR", "The scan cursor is invalid or expired.", 400);
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new RuntimeError("SCAN_CURSOR", "The scan cursor is invalid or expired.", 400);
    }
    const parsed = cursorBody.safeParse(decoded);
    if (!parsed.success || parsed.data.id !== id || parsed.data.kind !== kind ||
      parsed.data.selection !== selection || parsed.data.expires <= Date.now())
      throw new RuntimeError("SCAN_CURSOR", "The scan cursor is invalid or expired.", 400);
    return parsed.data.offset;
  }

  /** Return one source-order catalog page without native identifiers, references or event payloads. */
  catalog(id: string, cursor: string | null): z.infer<typeof catalogPageSchema> {
    const { view, status } = this.current(id);
    const offset = this.offset(id, "catalog", cursor);
    const entries = view.sessions.slice(offset, offset + this.limits.pageRecords);
    return catalogPageSchema.parse({
      id, sessions: entries.map((session) => ({ id: session.id,
        executions: view.events.filter((event) => event.sessionId === session.id).length,
        associatedExecutions: view.events.filter((event) => associatedWithSession(event, session.id)).length })),
      unassigned: status.unassigned,
      totalSessions: view.sessions.length, offset,
      next: offset + entries.length < view.sessions.length ? this.encode("catalog", offset + entries.length) : null,
    });
  }

  /** Resolve the exact authorized selection only after validating the requested generation. */
  selection(id: string): ScanRequest {
    this.current(id);
    if (!this.selectionValue) throw new RuntimeError("SCAN_STALE", "The scan selection is no longer available.", 409);
    return { ...this.selectionValue };
  }

  /** Expose owned page acquisition/cleanup before awaiting an open, without relabeling catalog completeness. */
  pending(id: string): void {
    this.current(id).status.cleanupPending = true;
  }

  /** Bound calculator amplification and verify direct membership against the scan; never truncate or substitute counts. */
  private calculate(request: ScanReportRequest) {
    const { view, status } = this.current(request.id);
    if (!view.sessions.some((session) => session.id === request.sessionId))
      throw new RuntimeError("SCAN_SELECTION", "Select a session in the current scan.", 400);
    if (view.events.length > this.limits.reportEvents) throw new ScanBudgetExceeded("report");
    const report = recordedReport(view, { readId: request.id, sessionId: request.sessionId });
    if (!status.reconciliation ||
      report.contributions.directEvents !== view.events.filter((event) => event.sessionId === request.sessionId).length)
      throw new RuntimeError("SCAN_RECONCILIATION", "Report membership does not reconcile with this scan; report unavailable.", 409);
    if (report.measurements.length > this.limits.reportMeasurements) throw new ScanBudgetExceeded("report");
    return report;
  }

  /** Check physical identity before every report/evidence pass, not only descriptor metadata at scan time. */
  private sameSource(source: StreamedSource): void {
    if (!this.identity || source.identity.dev !== this.identity.dev || source.identity.ino !== this.identity.ino)
      throw new RuntimeError("SOURCE_CHANGED", "The source was replaced; rescan before retrieving a report or evidence.", 409);
  }

  /** Distinguish exact calculator contributors from records explaining absent or measured-zero fields. */
  private evidenceKind(measurement: ReportMeasurement): ScanMetricPage["evidenceKind"] {
    return measurement.metric.value !== null && measurement.contributorEventIds.length ? "contributors" : "coverage-witnesses";
  }

  /**
   * Revalidate the entire admitted prefix before publishing whole-session numbers.
   * Calculation uses the scan's bounded full-source correlation, never an evidence page;
   * append-only growth stays outside this generation until an explicit new scan.
   * Diagnostic summaries retain severity/impact/count but omit original anchor arrays.
   */
  async report(request: ScanReportRequest, source: StreamedSource, signal: AbortSignal): Promise<ScanReport> {
    const report = this.calculate(request);
    const { view, status } = this.current(request.id);
    this.sameSource(source);
    const hash = createHash("sha256");
    status.pass++;
    for await (const bytes of this.prefix(source, signal, hash)) void bytes;
    const digest = hash.digest("hex");
    if (digest !== this.digest)
      throw new RuntimeError("SOURCE_CHANGED", "The admitted source prefix changed; rescan before reporting.", 409);
    const final = await this.verifyPrefix(source, signal, digest);
    status.appended ||= final.appended || source.boundary > status.admittedBytes;
    this.check(signal);
    const result = scanReportSchema.parse({
      id: request.id, sessionId: request.sessionId, source: view.sources[0],
      contributions: report.contributions,
      scanTotals: status.reconciliation,
      admittedBytes: status.admittedBytes, prefixSha256: digest, observedAtMs: Date.now(),
      appended: status.appended, issues: view.issues.map((issue) => issue.message),
      diagnostics: view.issues.map((issue) => ({
        sourceId: issue.sourceId, code: issue.code, message: issue.message,
        ...(issue.affectsCoverage === undefined ? {} : { affectsCoverage: issue.affectsCoverage }),
        ...(issue.severity === undefined ? {} : { severity: issue.severity }),
        ...(issue.impact === undefined ? {} : { impact: issue.impact }),
        ...(issue.count === undefined ? {} : { count: issue.count }),
      })),
      measurements: report.measurements.map((entry) => ({
        id: entry.id, label: entry.label, group: entry.group, display: entry.display,
        definition: entry.definition, scope: entry.scope.kind,
        value: entry.metric.value, unit: entry.metric.unit, coverage: entry.metric.coverage,
        evidenceKind: this.evidenceKind(entry),
      })),
    });
    if (Buffer.byteLength(JSON.stringify(result)) > this.limits.responseBytes) throw new ScanBudgetExceeded("response");
    return result;
  }

  /** Recompute the same bounded selection, then page every physical replay of its exact contributors. */
  async metricDetails(request: ScanMetricRequest, source: StreamedSource, signal: AbortSignal): Promise<ScanMetricPage> {
    const report = this.calculate(request);
    const measurement = report.measurements.find((entry) => entry.id === request.metricId);
    if (!measurement) throw new RuntimeError("SCAN_SELECTION", "Select a measurement in this session's report.", 400);
    const ids = new Set(measurement.contributorEventIds);
    const anchors = new Set(measurement.metric.contributors.map((ref) => ref.recordId));
    const { view } = this.current(request.id);
    const explainUnavailable = !ids.size && !anchors.size && measurement.metric.value === null;
    for (const event of view.events) {
      if (event.sessionId !== request.sessionId) continue;
      if (event.references.some((ref) => anchors.has(ref.recordId)) ||
        explainUnavailable) ids.add(event.id);
    }
    const result = {
      ...await this.details({ id: request.id, sessionId: request.sessionId, cursor: request.cursor, fromMs: null, toMs: null },
        source, signal, { metricId: request.metricId, ids }),
      sessionId: request.sessionId, metricId: request.metricId, evidenceKind: this.evidenceKind(measurement),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > this.limits.responseBytes) throw new ScanBudgetExceeded("response");
    return result;
  }

  /**
   * Revalidate the full admitted prefix and return bounded original physical contributors.
   * Correlation is from the whole scan, even for time-window queries; duplicate
   * records are evidence pages, not additive executions or token metrics. Observed
   * changes require continuity checking; new final-check changes reject the page.
   * Selected-byte charging uses original record lengths, including whitespace/CR but excluding LF.
   */
  async details(request: DetailRequest, source: StreamedSource, signal: AbortSignal,
    metric?: { readonly metricId: string; readonly ids: ReadonlySet<string> }): Promise<z.infer<typeof detailPageSchema>> {
    const { view, status } = this.current(request.id);
    this.sameSource(source);
    if (request.sessionId !== null && !view.sessions.some((session) => session.id === request.sessionId))
      throw new RuntimeError("SCAN_SELECTION", "Select a session in the current scan.", 400);
    const binding = createHash("sha256").update(JSON.stringify([request.sessionId, request.fromMs, request.toMs, metric?.metricId ?? null])).digest("hex");
    const offset = this.offset(request.id, "detail", request.cursor, binding);
    const selected = new Map<string, ReadView["events"][number]>();
    for (const event of view.events) {
      if (event.kind === "message" || (event.sessionId !== request.sessionId &&
        (request.sessionId === null || !associatedWithSession(event, request.sessionId)))) continue;
      if (metric && !metric.ids.has(event.id)) continue;
      const time = event.startedAtMs;
      if ((request.fromMs !== null && (time === null || time < request.fromMs)) ||
        (request.toMs !== null && (time === null || time > request.toMs))) continue;
      const line = event.references[0]?.location;
      selected.set(event.trace?.id && event.nativeId ? `${event.trace.id}/${event.nativeId}`
        : line?.kind === "jsonl" ? `line-${line.line}` : "", event);
    }
    const hash = createHash("sha256");
    status.pass++;
    const contributors: z.infer<typeof detailPageSchema>["contributors"] = [];
    let nextOffset: number | null = null;
    let selectedBytes = 0;
    let lastEnd = offset;
    for await (const record of jsonLines({
      readId: request.id, sourceId: status.sourceId, signal, bytes: this.prefix(source, signal, hash),
    }, { maxRecordBytes: this.limits.recordBytes })) {
      if ("error" in record || record.byteOffset < offset) continue;
      const raw = record.value;
      const original = selected.get(vscodeOtelRecordKey(raw, record.line));
      if (!original || nextOffset !== null) continue;
      const bytes = Buffer.from(JSON.stringify(raw));
      const detail = await vscodeOtelReader.read({
        readId: request.id, sourceId: status.sourceId, signal,
        bytes: byteChunks(bytes, signal),
      });
      const event = detail.events[0];
      if (!event) continue;
      if (contributors.length >= this.limits.pageRecords || selectedBytes + record.byteLength > this.limits.detailBytes) {
        if (!contributors.length) throw new ScanBudgetExceeded("detail");
        nextOffset = lastEnd;
        continue;
      }
      const references = event.references.map((reference) => ({
        ...reference, recordId: record.recordId,
        location: { ...reference.location, kind: "jsonl" as const, line: record.line,
          byteOffset: record.byteOffset, byteLength: record.byteLength },
      }));
      const parentReference = references.find((ref) => ref.location.pointer === "/attributes/copilot_chat.parent_chat_session_id");
      if (original.kind !== "message" && original.parentChat && !parentReference)
        throw new RuntimeError("SOURCE_CHANGED", "The original parent-chat field is unavailable; rescan before retrieving evidence.", 409);
      const parentChat = original.kind !== "message" && original.parentChat && parentReference
        ? { ...original.parentChat, reference: parentReference } : undefined;
      contributors.push({ event: { ...event, id: original.id, sessionId: original.sessionId, references,
        ...(parentChat ? { parentChat } : {}) },
        byteOffset: record.byteOffset, byteLength: record.byteLength, line: record.line,
        fingerprint: record.recordId.slice("sha256:".length) });
      selectedBytes += record.byteLength;
      lastEnd = record.byteOffset + record.byteLength + (record.terminated ? 1 : 0);
    }
    const digest = hash.digest("hex");
    if (digest !== this.digest)
      throw new RuntimeError("SOURCE_CHANGED", "The admitted source prefix changed; refresh before retrieving evidence.", 409);
    const final = await this.verifyPrefix(source, signal, digest);
    status.appended ||= final.appended || source.boundary > status.admittedBytes;
    this.check(signal);
    const result = detailPageSchema.parse({
      id: request.id, observedAtMs: Date.now(), contributors, scope: "original-contributors-not-additive-metrics",
      next: nextOffset === null ? null : this.encode("detail", nextOffset, binding),
    });
    if (Buffer.byteLength(JSON.stringify(result)) > this.limits.responseBytes)
      throw new ScanBudgetExceeded("response");
    return result;
  }
}
