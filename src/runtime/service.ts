/** One transient read generation and a fixed registry of trusted, application-owned readers. */
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

/** Await a cooperative adapter without allowing ignored cancellation to retain the current generation. */
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

/** Yield bounded captured bytes only while this read remains authorized and active. */
async function* byteChunks(
  bytes: Uint8Array,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    if (signal.aborted) throw cancelledRead(signal);
    yield bytes.subarray(offset, offset + 64 * 1024);
  }
}

/** Holds at most the current normalized view; refresh/cancellation discards it without saving history. */
export class RuntimeService {
  private readonly readers = new Map<SourceFormat, EvidenceReader>();
  private current: ReadView | null = null;
  private currentSelection: Readonly<ReadRequest> | null = null;
  private currentTiming: ReadTiming | null = null;
  private active: { id: string; controller: AbortController } | null = null;

  /** Register only explicitly supplied internal adapters; this is not a dynamic plugin loader. */
  constructor(
    private readonly sources: SourceAccess,
    private readonly config: RuntimeConfig,
    readers: readonly EvidenceReader[] = [],
    private readonly timeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("Read timeout must be a positive integer");
    for (const reader of readers)
      this.readers.set(reader.format, selectReader(readers, reader.format));
  }

  /** Report source access and actual adapter availability without connecting to a model. */
  async status(): Promise<RuntimeStatus> {
    const sources = await this.sources.list();
    return {
      checkedAtMs: Date.now(),
      sources,
      readers: [...this.readers.keys()],
      hasReadView: this.current !== null,
      readTiming: this.currentTiming,
      analysis: {
        harness: this.config.harness,
        requestedModel: this.config.model,
        available: false,
        remoteProcessing: true,
        reason:
          "The Copilot analysis adapter is not installed in this runtime yet.",
      },
    };
  }

  /** Return the current in-memory generation, not a rehydrated or persisted result. */
  get view(): ReadView | null {
    return this.current;
  }

  /** Retain the exact file selection for the current generation, never a mutable UI selection. */
  get selection(): Readonly<ReadRequest> | null {
    return this.currentSelection;
  }

  /** Abort this runtime's active operation and discard its view; never touch source files. */
  invalidate(): void {
    this.active?.controller.abort();
    this.active = null;
    this.current = null;
    this.currentSelection = null;
    this.currentTiming = null;
  }

  /** Run a registered reader on approved bytes; reject stale, invalid or mis-scoped adapter results. */
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
