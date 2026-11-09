/**
 * One transient, budgeted JSONL catalog. All detail pages rescan the admitted
 * original prefix and verify its digest; no copied corpus, disk spill or history.
 * RuntimeService owns every borrowed descriptor and the publication/cleanup barrier.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { ReadView } from "../evidence/contracts.js";
import { jsonLines } from "../evidence/readers/jsonl.js";
import { scanVscodeOtel, vscodeOtelReader, vscodeOtelRecordKey } from "../evidence/readers/vscode-otel.js";
import {
  STREAM_LIMITS, ScanBudgetExceeded, catalogPageSchema, detailPageSchema,
  type DetailRequest, type ScanRequest, type ScanStatus, type StreamLimits,
} from "../evidence/streaming.js";
import { RuntimeError, cancelledRead } from "./errors.js";
import { byteChunks, type FileState, type StreamedSource } from "./sources.js";

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
    this.selectionValue = { ...selection };
    this.statusValue = {
      id, sourceId: selection.sourceId, phase: "scanning", reason: "Opening the authorized original source.",
      startedAtMs: Date.now(), finishedAtMs: null, inputStartedAtMs: null, inputFinishedAtMs: null,
      sourceBytes: 0, admittedBytes: 0, scannedBytes: 0,
      workBytes: 0, pass: 0, passScannedBytes: 0, appended: false, cleanupPending: true,
      counts: { records: 0, blank: 0, malformed: 0, incomplete: 0, oversized: 0, unknown: 0, duplicates: 0, executionRecords: 0, unclassifiedRecords: 0, metrics: 0, logs: 0, contentEvents: 0 },
      classification: null, sessions: null, unassigned: null,
    };
  }

  /** Return a detached payload-free progress snapshot, not mutable scan state. */
  get status(): ScanStatus | null {
    return this.statusValue ? { ...this.statusValue, counts: { ...this.statusValue.counts } } : null;
  }

  /** Drop catalog authority immediately; cancellation acknowledgement does not assert cleanup. */
  invalidate(): void {
    this.view = null;
    this.selectionValue = null;
    this.digest = null;
    this.identity = null;
    if (this.statusValue && this.statusValue.phase !== "cleanup-failed")
      this.statusValue = { ...this.statusValue, phase: "cancelled", reason: "The generation was cancelled or replaced." };
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
   * Normalize the admitted source with full-file correlation but bounded, payload-free metadata.
   * Changed metadata triggers an additional continuity pass; append is not called atomic snapshotting.
   */
  async scan(id: string, selection: ScanRequest, source: StreamedSource, signal: AbortSignal): Promise<ReadView> {
    if (this.statusValue?.id !== id) this.prepare(id, selection);
    this.identity = source.identity;
    this.statusValue = {
      id, sourceId: selection.sourceId, phase: "scanning", reason: null,
      startedAtMs: source.startedAtMs, finishedAtMs: null, inputStartedAtMs: source.startedAtMs, inputFinishedAtMs: null,
      sourceBytes: source.boundary, admittedBytes: source.boundary, scannedBytes: 0,
      workBytes: 0, pass: 1, passScannedBytes: 0, appended: false, cleanupPending: true,
      counts: { records: 0, blank: 0, malformed: 0, incomplete: 0, oversized: 0, unknown: 0, duplicates: 0, executionRecords: 0, unclassifiedRecords: 0, metrics: 0, logs: 0, contentEvents: 0 },
      classification: null, sessions: null, unassigned: null,
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
    });
    const digest = hash.digest("hex");
    const observation = await source.verify();
    if (observation.changed) {
      status.pass++;
      const continuity = createHash("sha256");
      for await (const bytes of this.prefix(source, signal, continuity)) {
        void bytes;
      }
      if (continuity.digest("hex") !== digest)
        throw new RuntimeError("SOURCE_CHANGED", "The admitted source prefix changed during scanning; refresh and retry.", 409);
    }
    const final = await source.verify();
    this.check(signal);
    status.appended = final.appended;
    status.reason = null;
    status.inputFinishedAtMs = Date.now();
    this.digest = digest;
    return view;
  }

  /** Publish only after RuntimeService confirms all source cleanup and generation ownership. */
  publish(view: ReadView): ScanStatus {
    const status = this.statusValue;
    if (!status || status.id !== view.id || status.phase !== "scanning")
      throw new RuntimeError("SCAN_STALE", "This scan generation is no longer current.", 409);
    this.view = view;
    status.finishedAtMs = Date.now();
    status.cleanupPending = false;
    status.scannedBytes = status.admittedBytes;
    status.classification = view.sources[0]?.classification ?? null;
    status.sessions = view.sessions.length;
    status.unassigned = view.events.filter((event) => event.sessionId === null).length;
    status.phase = view.sources[0]?.format === null ? "format-unsupported" : view.issues.length ? "partial" : "complete";
    status.reason = !view.events.length
      ? "No supported execution spans in this interval; telemetry counts are separate. Timing/tools/tokens are unavailable, not zero."
      : view.issues.length ? "Coverage is partial; malformed, excluded, incomplete or unassigned evidence is not complete-session coverage." : null;
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
        executions: view.events.filter((event) => event.sessionId === session.id).length })),
      unassigned: status.unassigned,
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

  /**
   * Revalidate the full admitted prefix and return bounded original physical contributors.
   * Correlation is from the whole scan, even for time-window queries; duplicate
   * records are evidence pages, not additive executions or token metrics.
   */
  async details(request: DetailRequest, source: StreamedSource, signal: AbortSignal): Promise<z.infer<typeof detailPageSchema>> {
    const { view, status } = this.current(request.id);
    if (!this.identity || source.identity.dev !== this.identity.dev || source.identity.ino !== this.identity.ino)
      throw new RuntimeError("SOURCE_CHANGED", "The source was replaced; refresh before retrieving evidence.", 409);
    if (request.sessionId !== null && !view.sessions.some((session) => session.id === request.sessionId))
      throw new RuntimeError("SCAN_SELECTION", "Select a session in the current scan.", 400);
    const binding = createHash("sha256").update(JSON.stringify([request.sessionId, request.fromMs, request.toMs])).digest("hex");
    const offset = this.offset(request.id, "detail", request.cursor, binding);
    const selected = new Map<string, ReadView["events"][number]>();
    for (const event of view.events) {
      if (event.kind === "message" || event.sessionId !== request.sessionId) continue;
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
    let payloadBytes = 0;
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
      if (contributors.length >= this.limits.pageRecords || payloadBytes + bytes.length > this.limits.detailBytes) {
        if (!contributors.length) throw new ScanBudgetExceeded("detail");
        nextOffset = lastEnd;
        continue;
      }
      const references = event.references.map((reference) => ({
        ...reference, recordId: record.recordId,
        location: { ...reference.location, kind: "jsonl" as const, line: record.line,
          byteOffset: record.byteOffset, byteLength: record.byteLength },
      }));
      contributors.push({ event: { ...event, id: original.id, sessionId: original.sessionId, references },
        byteOffset: record.byteOffset, byteLength: record.byteLength, line: record.line,
        fingerprint: record.recordId.slice("sha256:".length) });
      payloadBytes += bytes.length;
      lastEnd = record.byteOffset + record.byteLength + (record.terminated ? 1 : 0);
    }
    await source.verify();
    if (hash.digest("hex") !== this.digest)
      throw new RuntimeError("SOURCE_CHANGED", "The admitted source prefix changed; refresh before retrieving evidence.", 409);
    status.appended ||= source.boundary > status.admittedBytes;
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
