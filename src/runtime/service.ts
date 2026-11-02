/**
 * Coordinate authorized source reads and retain one normalized generation in memory.
 *
 * SourceAccess owns native file access; registered EvidenceReader implementations
 * own format parsing. VS Code Copilot Chat is the first planned reader family.
 * The optional analysis runner consumes normalized evidence independently of that
 * source format; using Copilot CLI to execute analysis does not change the source.
 *
 * No readers are discovered dynamically, and no read/result history is persisted.
 * Refresh or a new read invalidates prior analysis as well as the current view.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  parseReadView,
  selectReader,
  type EvidenceReader,
  type ReadView,
  type SourceFormat,
} from "../evidence/contracts.js";
import type { RuntimeConfig } from "./config.js";
import { RuntimeError, cancelledRead } from "./errors.js";
import type { ReadRequest, ReadTiming, RuntimeStatus } from "./protocol.js";
import { SourceAccess } from "./sources.js";
import type { AnalysisRunner } from "../analysis/runner.js";

/**
 * Stop waiting for an adapter when the owned signal aborts.
 * @param operation - Already-started adapter work whose eventual rejection remains observed.
 * @param signal - Read-owned cancellation/deadline signal; public cancellation errors are normalized.
 * @returns The adapter result, or a rejection if it fails or cancellation wins.
 * This does not preempt synchronous JavaScript or terminate the adapter itself.
 */
async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancelledRead(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Expose the bounded capture to an internal reader in at most 64 KiB views.
 * @param bytes - Captured source buffer owned by this read, not a live file handle.
 * @param signal - Checked before each yield to stop delivery after cancellation.
 * @returns An asynchronous sequence of subarray views; readers must not mutate them.
 * Iteration rejects with a controlled cancellation error when the signal aborts.
 */
async function* byteChunks(
  bytes: Uint8Array,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    if (signal.aborted) throw cancelledRead(signal);
    yield bytes.subarray(offset, offset + 64 * 1024);
  }
}

/**
 * Own one current read, its exact selection and separate input/processing timestamps.
 * Completed data is immutable in memory; invalidation drops it rather than saving
 * history. Readers cannot relabel another source or publish after losing their generation.
 * Analysis lifetime is delegated to the optional AnalysisRunner, not to a source parser.
 */
export class RuntimeService {
  private readonly readers = new Map<SourceFormat, EvidenceReader>();
  private current: ReadView | null = null;
  private currentSelection: Readonly<ReadRequest> | null = null;
  private currentTiming: ReadTiming | null = null;
  private active: { id: string; controller: AbortController } | null = null;

  /**
   * Register trusted readers against pre-approved source grants without reading content.
   * @param sources - SourceAccess instance owning startup-approved file/directory locations.
   * @param config - Stable launch/model preferences returned in status, not captured session evidence.
   * @param readers - Application-owned format adapters; defaults to none and rejects ambiguous registrations.
   * @param timeoutMs - Positive safe-integer read budget in milliseconds; defaults to 30,000.
   * @param analysis - Runner to invalidate alongside source changes, or null when not configured.
   * @throws Error for invalid timeout or reader registration.
   */
  constructor(
    private readonly sources: SourceAccess,
    private readonly config: RuntimeConfig,
    readers: readonly EvidenceReader[] = [],
    private readonly timeoutMs = 30_000,
    readonly analysis: AnalysisRunner | null = null,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("Read timeout must be a positive integer");
    for (const reader of readers)
      this.readers.set(reader.format, selectReader(readers, reader.format));
  }

  /**
   * Recheck source availability and return the current read/analysis status.
   * @returns Source metadata, registered formats, current capture bounds and the
   * current analysis snapshot. Filesystem/provider inspection errors may reject.
   * This does not parse source content or start analysis; provider status can probe
   * an installed executable's version without creating an analysis session.
   */
  async status(): Promise<RuntimeStatus> {
    const sources = await this.sources.list();
    const availability =
      this.analysis === null
        ? {
            available: false,
            version: null,
            reason:
              "The Copilot analysis adapter is not installed in this runtime yet.",
          }
        : await this.analysis.availability();
    return {
      checkedAtMs: Date.now(),
      sources,
      readers: [...this.readers.keys()],
      hasReadView: this.current !== null,
      readTiming: this.currentTiming,
      analysis: {
        harness: this.config.harness,
        requestedModel: this.config.model,
        ...availability,
        remoteProcessing: true,
        operations: this.analysis?.definitions ?? [],
        run: this.analysis?.run ?? null,
      },
    };
  }

  /**
   * Borrow the immutable current read, or null before a successful read/after invalidation.
   * No disk lookup or restoration of an older view occurs.
   */
  get view(): ReadView | null {
    return this.current;
  }

  /**
   * Return the frozen selection that produced the current generation, or null.
   * It is not a live reference to whichever fields the browser currently displays.
   */
  get selection(): Readonly<ReadRequest> | null {
    return this.currentSelection;
  }

  /**
   * Return this generation's actual input-capture interval and processing completion.
   * Null means no current read. Analysis must match readId before using these bounds
   * and must not reinterpret processing completion as the time evidence was observed.
   */
  get readTiming(): ReadTiming | null {
    return this.currentTiming;
  }

  /**
   * Request cancellation and immediately clear the visible view, selection and timing.
   * Also invalidates analysis but does not await provider shutdown; the server/runner
   * owns that asynchronous cleanup. No logical source data is modified.
   */
  invalidate(): void {
    this.analysis?.invalidate();
    this.active?.controller.abort();
    this.active = null;
    this.current = null;
    this.currentSelection = null;
    this.currentTiming = null;
  }

  /**
   * Capture an authorized source and normalize it through its registered adapter.
   * @param selection - Startup grant ID, relative path and installed format; a frozen
   * copy prevents caller mutation from relabeling in-flight work.
   * @param externalSignal - Caller/disconnect cancellation; its raw reason is never exposed publicly.
   * @returns The immutable current ReadView after source, generation and schema checks.
   * Input observation bounds are retained separately from parsing completion.
   * @throws Rejects with controlled RuntimeError values for unavailable readers,
   * source-access failures, timeout/cancellation, invalid output, stale work or clock changes.
   * Starting a supported read invalidates the prior read and analysis first.
   */
  async read(
    selection: ReadRequest,
    externalSignal: AbortSignal,
  ): Promise<ReadView> {
    const request = Object.freeze({ ...selection });
    const reader = this.readers.get(request.format);
    if (!reader)
      throw new RuntimeError(
        "READER_UNAVAILABLE",
        "No reader is installed for the selected format.",
        501,
      );
    this.invalidate();
    const id = randomUUID();
    const controller = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    const timeoutError = new RuntimeError(
      "READ_TIMEOUT",
      "The read exceeded its time limit.",
      408,
    );
    this.active = { id, controller };
    /** External callers cannot inject a sensitive abort reason into the public error. */
    const abort = () => controller.abort(cancelledRead());
    externalSignal.addEventListener("abort", abort, { once: true });
    if (externalSignal.aborted) controller.abort();
    const timeout = setTimeout(
      () => controller.abort(timeoutError),
      this.timeoutMs,
    );
    /** A blocked event loop cannot deliver the timer; check elapsed time before publishing too. */
    const ensureCurrent = () => {
      if (controller.signal.aborted || this.active?.id !== id)
        throw cancelledRead(controller.signal);
      if (performance.now() >= deadline) {
        controller.abort(timeoutError);
        throw timeoutError;
      }
    };
    timeout.unref();
    try {
      const captured = await abortable(
        this.sources.read(
          request.sourceId,
          request.relativePath,
          controller.signal,
        ),
        controller.signal,
      );
      ensureCurrent();
      const input = {
        readId: id,
        sourceId: request.sourceId,
        signal: controller.signal,
        bytes: byteChunks(captured.bytes, controller.signal),
      };
      const candidate = await abortable(reader.read(input), controller.signal);
      ensureCurrent();
      const view = parseReadView(candidate);
      const firstSource = view.sources[0];
      if (
        view.id !== id ||
        view.sources.length !== 1 ||
        firstSource === undefined ||
        firstSource.id !== request.sourceId ||
        (firstSource.format !== null && firstSource.format !== request.format)
      ) {
        throw new RuntimeError(
          "INVALID_READER_RESULT",
          "The reader returned evidence for an unrelated read or source.",
          502,
        );
      }
      const sources = view.sources.map((source) =>
        captured.changed
          ? {
              ...source,
              changedDuringRead: true,
              coverage: {
                messages:
                  source.coverage.messages.status === "complete"
                    ? {
                        status: "partial",
                        reason: "Source changed during read",
                      }
                    : source.coverage.messages,
                timing:
                  source.coverage.timing.status === "complete"
                    ? {
                        status: "partial",
                        reason: "Source changed during read",
                      }
                    : source.coverage.timing,
                tools:
                  source.coverage.tools.status === "complete"
                    ? {
                        status: "partial",
                        reason: "Source changed during read",
                      }
                    : source.coverage.tools,
                tokens:
                  source.coverage.tokens.status === "complete"
                    ? {
                        status: "partial",
                        reason: "Source changed during read",
                      }
                    : source.coverage.tokens,
              },
            }
          : source,
      );
      const issues = [...view.issues];
      if (
        captured.changed &&
        !issues.some(
          (issue) =>
            issue.code === "source-changed" &&
            issue.sourceId === request.sourceId,
        )
      ) {
        issues.push({
          code: "source-changed",
          sourceId: request.sourceId,
          message: "Source changed during read",
        });
      }
      const normalized = parseReadView({
        ...view,
        startedAtMs: captured.startedAtMs,
        finishedAtMs: captured.finishedAtMs,
        sources,
        issues,
      });
      ensureCurrent();
      const finishedAtMs = Date.now();
      if (
        !Number.isSafeInteger(finishedAtMs) ||
        finishedAtMs < captured.finishedAtMs
      ) {
        throw new RuntimeError(
          "CLOCK_CHANGED",
          "The clock changed while completing the read. Retry the operation.",
          409,
        );
      }
      this.current = Object.freeze({ ...normalized, finishedAtMs });
      this.currentSelection = request;
      this.currentTiming = Object.freeze({
        readId: id,
        inputStartedAtMs: captured.startedAtMs,
        inputFinishedAtMs: captured.finishedAtMs,
        finishedAtMs,
      });
      return this.current;
    } catch (error) {
      if (controller.signal.aborted) throw cancelledRead(controller.signal);
      if (error instanceof z.ZodError)
        throw new RuntimeError(
          "INVALID_READER_RESULT",
          "The reader returned invalid evidence.",
          502,
        );
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal.removeEventListener("abort", abort);
      if (this.active?.id === id) this.active = null;
    }
  }
}
