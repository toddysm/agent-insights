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
import { RuntimeError, cancelledRead, abortable } from "./errors.js";
import type {
  ReadRequest,
  ReadSetRequest,
  ReadTiming,
  RuntimeStatus,
} from "./protocol.js";
import { SourceAccess, byteChunks } from "./sources.js";
import type { AnalysisRunner } from "../analysis/runner.js";
import { SourceReadSet } from "./source-read.js";
import {
  defaultNativeHelper,
  nativeSqliteAvailability,
  type NativeHelperResolver,
} from "./sqlite.js";
import {
  sourceRequirementSchema,
  type MultiSourceReader,
  type SourceObservation,
} from "../evidence/source-access.js";

/** Validated adapter output with runtime-owned physical observation bounds. */
interface ReadResult {
  readonly view: ReadView;
  readonly observations: readonly SourceObservation[];
  readonly unavailable: readonly { sourceId: string; reason: string }[];
  readonly composite: boolean;
}

/**
 * Reduce coverage for source changes/failures without inventing evidence or timestamps.
 * @param result - Structurally checked output plus authoritative capture observations.
 * @returns A validated read view with source-scoped controlled issues.
 */
function observedView(result: ReadResult): ReadView {
  const issues = [...result.view.issues];
  const sources = result.view.sources.map((source) => {
    const observation = result.observations.find(
      (value) => value.sourceId === source.id,
    );
    if (!observation)
      throw new RuntimeError(
        "INVALID_READER_RESULT",
        "Source evidence has no read observation.",
        502,
      );
    const failure = result.unavailable.find(
      (value) => value.sourceId === source.id,
    );
    const changed = observation.changed || source.changedDuringRead === true;
    if (failure) {
      issues.push({
        sourceId: source.id,
        code: "unreadable-source",
        message: failure.reason,
      });
      const unavailable = {
        status: "unavailable" as const,
        reason: failure.reason,
      };
      return {
        ...source,
        format: null,
        changedDuringRead: false,
        coverage: {
          messages: unavailable,
          timing: unavailable,
          tools: unavailable,
          tokens: unavailable,
        },
      };
    }
    if (
      changed &&
      !issues.some(
        (issue) =>
          issue.sourceId === source.id && issue.code === "source-changed",
      )
    )
      issues.push({
        sourceId: source.id,
        code: "source-changed",
        message: "Source changed during read",
      });
    const coverage = { ...source.coverage };
    if (changed)
      for (const dimension of [
        "messages",
        "timing",
        "tools",
        "tokens",
      ] as const) {
        if (coverage[dimension].status === "complete")
          coverage[dimension] = {
            status: "partial",
            reason: "Source changed during read",
          };
      }
    return { ...source, changedDuringRead: changed, coverage };
  });
  return parseReadView({
    ...result.view,
    sources,
    issues,
    startedAtMs: Math.min(
      ...result.observations.map((value) => value.startedAtMs),
    ),
    finishedAtMs: Math.max(
      ...result.observations.map((value) => value.finishedAtMs),
    ),
  });
}

/**
 * Own one current read, its exact selection and separate input/processing timestamps.
 * Completed data is immutable in memory; invalidation drops it rather than saving
 * history. Readers cannot relabel another source or publish after losing their generation.
 * Analysis lifetime is delegated to the optional AnalysisRunner, not to a source parser.
 */
export class RuntimeService {
  private readonly readers = new Map<SourceFormat, EvidenceReader>();
  private readonly multiReaders = new Map<string, MultiSourceReader>();
  private readonly readSets = new Set<SourceReadSet>();
  private readonly fileCaptures = new Set<Promise<void>>();
  private cleanupFailed = false;
  private cleanupBarrier: Promise<void> = Promise.resolve();
  private current: ReadView | null = null;
  private currentSelection: Readonly<ReadRequest | ReadSetRequest> | null =
    null;
  private currentTiming: ReadTiming | null = null;
  private active: { id: string; controller: AbortController } | null = null;

  /**
   * Register trusted readers against pre-approved source grants without reading content.
   * @param sources - SourceAccess instance owning startup-approved file/directory locations.
   * @param config - Stable launch/model preferences returned in status, not captured session evidence.
   * @param readers - Application-owned format adapters; defaults to none and rejects ambiguous registrations.
   * @param timeoutMs - Positive safe-integer read budget in milliseconds; defaults to 30,000.
   * @param analysis - Runner to invalidate alongside source changes, or null when not configured.
   * @param multiReaders - Code-owned composite readers; no schemas/queries are accepted from the browser.
   * @throws Error for invalid timeout or reader registration.
   */
  constructor(
    private readonly sources: SourceAccess,
    private readonly config: RuntimeConfig,
    readers: readonly EvidenceReader[] = [],
    private readonly timeoutMs = 30_000,
    readonly analysis: AnalysisRunner | null = null,
    multiReaders: readonly MultiSourceReader[] = [],
    private readonly nativeHelper: NativeHelperResolver = defaultNativeHelper,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("Read timeout must be a positive integer");
    for (const reader of readers)
      this.readers.set(reader.format, selectReader(readers, reader.format));
    for (const reader of multiReaders) {
      if (
        !/^[A-Za-z0-9._-]{1,64}$/.test(reader.id) ||
        this.multiReaders.has(reader.id)
      )
        throw new Error("Composite reader identity is invalid or duplicated");
      const inputs = Object.freeze(
        reader.inputs.map((input) => sourceRequirementSchema.parse(input)),
      );
      if (
        inputs.length === 0 ||
        inputs.length > 8 ||
        new Set(inputs.map((input) => input.key)).size !== inputs.length
      )
        throw new Error("Composite reader inputs are invalid or duplicated");
      this.multiReaders.set(
        reader.id,
        Object.freeze({
          id: reader.id,
          inputs,
          read: reader.read.bind(reader),
        }),
      );
    }
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
      nativeSqlite: await nativeSqliteAvailability(this.nativeHelper),
      sources,
      readers: [...this.readers.keys()],
      multiSourceReaders: [...this.multiReaders.values()].map((reader) => ({
        id: reader.id,
        inputs: reader.inputs.map((input) => ({
          key: input.key,
          kind: input.kind,
          format: input.format,
          optional: input.optional === true,
        })),
      })),
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
  get selection(): Readonly<ReadRequest | ReadSetRequest> | null {
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
    return this.runRead(
      request,
      externalSignal,
      async (id, signal, ensureCurrent) => {
        const capture = this.sources.read(
          request.sourceId,
          request.relativePath,
          signal,
        );
        // Retain settlement, not captured bytes; the cancellable wait does not own descriptor lifetime.
        const settled = capture.then(
          () => undefined,
          () => undefined,
        );
        this.fileCaptures.add(settled);
        try {
          const captured = await abortable(capture, signal);
          ensureCurrent();
          const candidate = await abortable(
            reader.read({
              readId: id,
              sourceId: request.sourceId,
              signal,
              bytes: byteChunks(captured.bytes, signal),
            }),
            signal,
          );
          ensureCurrent();
          const view = parseReadView(candidate);
          const firstSource = view.sources[0];
          if (
            view.id !== id ||
            view.sources.length !== 1 ||
            !firstSource ||
            firstSource.id !== request.sourceId ||
            (firstSource.format !== null &&
              firstSource.format !== request.format)
          )
            throw new RuntimeError(
              "INVALID_READER_RESULT",
              "The reader returned evidence for an unrelated read or source.",
              502,
            );
          return {
            view,
            observations: [
              {
                sourceId: request.sourceId,
                kind: "file",
                available: true,
                startedAtMs: captured.startedAtMs,
                finishedAtMs: captured.finishedAtMs,
                changed: captured.changed,
              },
            ],
            unavailable: [],
            composite: false,
          };
        } finally {
          await this.finishCapture(settled);
        }
      },
    );
  }

  /** Confirm real capture settlement and descriptor cleanup within five seconds; retain timed-out owners for shutdown retry. */
  private async finishCapture(capture: Promise<void>): Promise<void> {
    const cleanup = capture.then(() => this.sources.retryCleanup());
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        cleanup,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RuntimeError(
                  "SOURCE_CLEANUP_FAILED",
                  "File capture cleanup could not be confirmed; retry cleanup before reading again.",
                  500,
                ),
              ),
            5000,
          );
        }),
      ]);
      this.fileCaptures.delete(capture);
    } catch {
      this.cleanupFailed = true;
      throw new RuntimeError(
        "SOURCE_CLEANUP_FAILED",
        "File capture cleanup failed; no further reads are admitted until cleanup succeeds.",
        500,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Execute an installed composite reader over explicit, immutable role bindings.
   * @param selection - Reader identity and authorized grant/relative-path bindings only.
   * @param externalSignal - Caller cancellation; no source content or SQL arrives in controls.
   * @returns Validated in-memory view after all owned database processes have exited.
   */
  async readSet(
    selection: ReadSetRequest,
    externalSignal: AbortSignal,
  ): Promise<ReadView> {
    const request = Object.freeze({
      readerId: selection.readerId,
      sources: Object.freeze(
        selection.sources.map((binding) => Object.freeze({ ...binding })),
      ),
    });
    const reader = this.multiReaders.get(request.readerId);
    if (!reader)
      throw new RuntimeError(
        "READER_UNAVAILABLE",
        "No composite reader is installed for this selection.",
        501,
      );
    return this.runRead(
      request,
      externalSignal,
      async (id, signal, ensureCurrent) => {
        const set = new SourceReadSet(
          id,
          signal,
          this.sources,
          reader,
          this.nativeHelper,
        );
        this.readSets.add(set);
        try {
          await set.prepare(request.sources);
          ensureCurrent();
          const view = parseReadView(await abortable(reader.read(set), signal));
          ensureCurrent();
          const observations = await set.finish();
          set.validate(view);
          return {
            view,
            observations,
            unavailable: set.unavailable(),
            composite: true,
          };
        } finally {
          try {
            await set.dispose();
            this.readSets.delete(set);
          } catch {
            this.cleanupFailed = true;
            // eslint-disable-next-line no-unsafe-finally -- Unconfirmed native cleanup must override success/failure and block new generations.
            throw new RuntimeError(
              "SOURCE_CLEANUP_FAILED",
              "Source cleanup failed; no further reads are admitted until cleanup succeeds.",
              500,
            );
          }
        }
      },
    );
  }

  /**
   * Serialize source ownership through prior operation cleanup, including failed disposal.
   * Callers receive the original result/error; the barrier tracks settlement only so
   * an ordinary cancelled read does not poison later work. Cleanup failures stay latched.
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.cleanupBarrier.then(operation);
    this.cleanupBarrier = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Own common read invalidation, deadlines and publication for both input families.
   * @param request - Frozen selection retained only after successful publication.
   * @param externalSignal - Caller/disconnect cancellation, with untrusted reasons discarded.
   * @param execute - Trusted adapter operation; must retain and clean every source owner.
   * @returns Current read, with physical capture bounds separate from processing completion.
   */
  private async runRead(
    request: Readonly<ReadRequest | ReadSetRequest>,
    externalSignal: AbortSignal,
    execute: (
      id: string,
      signal: AbortSignal,
      ensureCurrent: () => void,
    ) => Promise<ReadResult>,
  ): Promise<ReadView> {
    if (this.cleanupFailed)
      throw new RuntimeError(
        "SOURCE_CLEANUP_FAILED",
        "Retry source cleanup before reading again.",
        503,
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
      if (this.cleanupFailed)
        throw new RuntimeError(
          "SOURCE_CLEANUP_FAILED",
          "Retry source cleanup before reading again.",
          503,
        );
      if (controller.signal.aborted || this.active?.id !== id)
        throw cancelledRead(controller.signal);
      if (performance.now() >= deadline) {
        controller.abort(timeoutError);
        throw timeoutError;
      }
    };
    timeout.unref();
    return this.enqueue(async () => {
      try {
        ensureCurrent();
        const result = await execute(id, controller.signal, ensureCurrent);
        ensureCurrent();
        const normalized = observedView(result);
        ensureCurrent();
        const finishedAtMs = Date.now();
        if (
          !Number.isSafeInteger(finishedAtMs) ||
          finishedAtMs < normalized.finishedAtMs
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
          inputStartedAtMs: normalized.startedAtMs,
          inputFinishedAtMs: normalized.finishedAtMs,
          finishedAtMs,
          ...(result.composite ? { sources: result.observations } : {}),
        });
        return this.current;
      } catch (error) {
        if (this.cleanupFailed)
          throw new RuntimeError(
            "SOURCE_CLEANUP_FAILED",
            "Source cleanup failed; retry shutdown.",
            500,
          );
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
    });
  }

  /** Cancel reads and retry retained source cleanup; caller owns analysis-provider shutdown separately. */
  async close(): Promise<void> {
    this.invalidate();
    return this.enqueue(async () => {
      const results = await Promise.allSettled([
        this.sources.retryCleanup(),
        ...[...this.fileCaptures].map((capture) => this.finishCapture(capture)),
        ...[...this.readSets].map(async (set) => {
          await set.dispose();
          this.readSets.delete(set);
        }),
      ]);
      this.cleanupFailed = results.some(
        (result) => result.status === "rejected",
      );
      if (this.cleanupFailed)
        throw new RuntimeError(
          "SOURCE_CLEANUP_FAILED",
          "Source cleanup did not complete; retry shutdown.",
          500,
        );
    });
  }
}
