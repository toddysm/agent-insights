/**
 * Own one checksum-verified native helper and its source lease until actual process exit.
 * No Node SQLite, worker fork, native build/download, producer restoration or captured executable path is used.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import type {
  SqliteBindings,
  SqliteDefinition,
  SqliteRow,
} from "../evidence/source-access.js";
import { RuntimeError, cancelledRead } from "./errors.js";
import type { DatabaseLease } from "./sources.js";
import {
  preparedNativeHelper,
  nativeTarget,
  NATIVE_POLICY,
} from "./native-helper.js";
import {
  SqliteFrames,
  sqliteRequestFrame,
  sqliteValueSchema,
  sqliteBindingBytes,
  encodeCell,
  decodeRows,
  sqliteProtocolError,
  MAX_SQLITE_ROWS,
  MAX_SQLITE_RESULT_BYTES,
  MAX_SQLITE_BINDING_BYTES,
  SQLITE_OPERATION_MS,
  type SqliteReply,
  type NativeSqliteCode,
} from "./sqlite-protocol.js";

/** Trusted embedding seam: resolve and reverify a code-owned prepared helper, never a browser/model/user option. */
export type NativeHelperResolver = () => Promise<string>;
export const defaultNativeHelper: NativeHelperResolver = preparedNativeHelper;

/** Source-free artifact status, separate from registered source readers and the model executor. */
export async function nativeSqliteAvailability(resolve: NativeHelperResolver) {
  try {
    await resolve();
    return {
      available: true,
      version: NATIVE_POLICY.guardVersion,
      reason: "A verified native SQLite helper is prepared.",
    };
  } catch (error) {
    if (
      !(error instanceof RuntimeError) ||
      error.code !== "NATIVE_GUARD_UNAVAILABLE"
    )
      throw error;
    return { available: false, version: null, reason: error.message };
  }
}

/** Fixed native categories deliberately separate unavailable source evidence from fatal guard/transport failures. */
export function nativeSqliteError(code: NativeSqliteCode): RuntimeError {
  const mapped: Record<NativeSqliteCode, readonly [string, string, number]> = {
    ACCESS_DENIED: [
      "SOURCE_DENIED",
      "The database or a required sidecar cannot be read with current permissions.",
      403,
    ],
    SOURCE_UNAVAILABLE: [
      "SOURCE_UNAVAILABLE",
      "The database or a required sidecar is unavailable.",
      404,
    ],
    IO: ["SOURCE_IO", "Database input/output is unavailable.", 422],
    SOURCE_CHANGED: [
      "SOURCE_CHANGED",
      "Database source identity changed during the read.",
      409,
    ],
    BUSY: [
      "SQLITE_LOCKED",
      "The database is locked. Retry after the harness finishes its operation.",
      409,
    ],
    RECOVERY_REQUIRED: [
      "SQLITE_RECOVERY_REQUIRED",
      "The owning harness must finish database recovery or initialization.",
      409,
    ],
    JOURNAL_PRESENT: [
      "SQLITE_JOURNAL_PRESENT",
      "A rollback journal is present. Retry after the producer removes it; retained-journal modes are unsupported.",
      409,
    ],
    SCHEMA: [
      "SQLITE_SCHEMA",
      "The database schema/version is not supported by this reader.",
      422,
    ],
    QUERY: [
      "SQLITE_QUERY",
      "The reader requested an undeclared database query.",
      422,
    ],
    BINDINGS: [
      "SQLITE_BINDINGS",
      "The reader supplied invalid database query bindings.",
      422,
    ],
    LIMIT: [
      "SQLITE_LIMIT",
      "The database request exceeded its fixed resource limit.",
      413,
    ],
    DATA: [
      "SQLITE_DATA",
      "The database contains unsupported or malformed data.",
      422,
    ],
    CLOCK: [
      "SQLITE_CLOCK",
      "The database observation clock was inconsistent.",
      502,
    ],
    DEADLINE: [
      "READ_TIMEOUT",
      "The native database read exceeded its deadline.",
      408,
    ],
    CANCELLED: [
      "READ_CANCELLED",
      "The native database read was cancelled.",
      409,
    ],
    CLEANUP: [
      "SQLITE_CLEANUP_FAILED",
      "Native database cleanup did not complete.",
      500,
    ],
    GUARD_UNAVAILABLE: [
      "NATIVE_GUARD_UNAVAILABLE",
      "The qualified native guard is unavailable.",
      503,
    ],
    ENGINE_MISMATCH: [
      "NATIVE_GUARD_UNAVAILABLE",
      "The native engine is incompatible with the qualified guard.",
      503,
    ],
    POLICY_VIOLATION: [
      "SQLITE_GUARD",
      "A forbidden database source operation was prevented.",
      502,
    ],
    PROTOCOL: [
      "SQLITE_PROCESS_PROTOCOL",
      "The native database protocol failed.",
      502,
    ],
    CHANNEL_LOST: [
      "SQLITE_PROCESS_PROTOCOL",
      "The native database channel was lost before completion.",
      502,
    ],
    PARENT_LOST: [
      "SQLITE_PROCESS_PROTOCOL",
      "Native helper parent supervision failed.",
      502,
    ],
  };
  return new RuntimeError(...mapped[code]);
}

/** Validate/copy the exact parameter set before asynchronous work; do not coerce unsupported values. */
export function copySqliteBindings(bindings: SqliteBindings): SqliteBindings {
  const entries = Object.entries(bindings);
  if (
    entries.length > 16 ||
    entries.some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ||
        !sqliteValueSchema.safeParse(value).success,
    )
  )
    throw nativeSqliteError("BINDINGS");
  if (sqliteBindingBytes(bindings) > MAX_SQLITE_BINDING_BYTES)
    throw nativeSqliteError("LIMIT");
  return Object.freeze(
    Object.fromEntries(
      entries.map(([name, value]) => [
        name,
        value instanceof Uint8Array ? new Uint8Array(value) : value,
      ]),
    ),
  );
}

/** A single pending operation; the parent never pipelines helper operations. */
interface Pending {
  id: number;
  started: boolean;
  expected: "opened" | "rows" | "closed";
  resolve(reply: SqliteReply): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Native snapshot owner. WAL uses a connection snapshot; rollback requests use independent bounded transactions. */
export class SqliteSource {
  private child: ChildProcessWithoutNullStreams | undefined;
  private exited: Promise<void> = Promise.resolve();
  private ended = false;
  private failure: Error | undefined;
  private pending: Pending | undefined;
  private ready: { resolve(): void; reject(error: Error): void } | undefined;
  private handshake = false;
  private initializing = false;
  private frames = new SqliteFrames();
  private sequence = 0;
  private closing: Promise<boolean> | undefined;
  private closedReply = false;
  private definition: SqliteDefinition | undefined;
  private observationStart: number | undefined;
  private observationFinish = 0;
  private lifetime: NodeJS.Timeout | undefined;
  private stderrBytes = 0;
  private remainingRows = MAX_SQLITE_ROWS;
  private remainingBytes = MAX_SQLITE_RESULT_BYTES;
  private queryCount = 0;
  private readonly onAbort = () => this.fail(cancelledRead(this.signal));
  snapshotScope: "connection" | "request" | undefined;

  /** Establish source/process ownership before any async resolution or spawn; launch only after explicit initialization. */
  constructor(
    private readonly lease: DatabaseLease,
    private readonly signal: AbortSignal,
    private readonly resolveHelper: NativeHelperResolver = defaultNativeHelper,
  ) {}

  /** Recheck asynchronous cancellation/poison after awaited work, never reuse an owner stopped during resolution. */
  private ensureActive(): void {
    if (this.signal.aborted) throw cancelledRead(this.signal);
    if (this.failure) throw this.failure;
  }

  /** Retain the first failure, except cleanup failures take precedence; kill only this owned helper. */
  private fail(error: Error): void {
    if (
      !this.failure ||
      (error instanceof RuntimeError && error.code === "SQLITE_CLEANUP_FAILED")
    )
      this.failure = error;
    this.ready?.reject(this.failure);
    this.ready = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = undefined;
    }
    if (this.child && !this.ended) this.child.kill("SIGKILL");
  }

  /** Correlate state, identifiers and observation scope before resolving any operation. */
  private receive(reply: SqliteReply): void {
    if (this.failure) return;
    if (!this.handshake) {
      if (reply.kind !== "hello" || reply.target !== nativeTarget())
        throw sqliteProtocolError();
      this.handshake = true;
      this.ready?.resolve();
      this.ready = undefined;
      return;
    }
    const pending = this.pending;
    if (reply.kind === "hello" || !pending || reply.id !== pending.id)
      throw sqliteProtocolError();
    if (reply.kind === "started") {
      if (pending.started) throw sqliteProtocolError();
      pending.started = true;
      return;
    }
    if (!pending.started) throw sqliteProtocolError();
    if (reply.kind === "error") {
      this.fail(nativeSqliteError(reply.code));
      return;
    }
    if (reply.kind !== pending.expected) throw sqliteProtocolError();
    if (reply.kind === "opened") this.snapshotScope = reply.snapshotScope;
    if (reply.kind === "rows" || reply.kind === "closed") {
      const observed = reply.observation;
      if (
        observed.snapshotScope !== this.snapshotScope ||
        (this.observationStart !== undefined &&
          observed.startedAtMs !== this.observationStart) ||
        observed.finishedAtMs < this.observationFinish
      )
        throw sqliteProtocolError();
      this.observationStart = observed.startedAtMs;
      this.observationFinish = observed.finishedAtMs;
    }
    if (reply.kind === "closed") this.closedReply = true;
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.resolve(reply);
  }

  /** Resolve the independently pinned artifact, then confirm a source-free native handshake before sending any source grant. */
  async initialize(definition: SqliteDefinition): Promise<number> {
    this.ensureActive();
    if (this.initializing) throw sqliteProtocolError();
    this.initializing = true;
    const executable = await this.resolveHelper();
    this.ensureActive();
    await this.lease.verify();
    this.ensureActive();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        executable,
        ["--parent-pid", String(process.pid), "--lifetime-ms", "30000"],
        { env, stdio: "pipe", windowsHide: true },
      );
    } catch {
      throw new RuntimeError(
        "SQLITE_PROCESS_FAILED",
        "The verified native helper could not be launched.",
        503,
      );
    }
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    const started = performance.now();
    this.lifetime = setTimeout(
      () => this.fail(nativeSqliteError("DEADLINE")),
      30_000,
    );
    const startup = setTimeout(
      () => this.fail(nativeSqliteError("DEADLINE")),
      SQLITE_OPERATION_MS,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.frames.push(chunk, (reply) => this.receive(reply));
      } catch (error) {
        this.fail(
          error instanceof RuntimeError ? error : sqliteProtocolError(),
        );
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 8192) this.fail(sqliteProtocolError());
    });
    child.stdin.on("error", () => this.fail(sqliteProtocolError()));
    child.stdout.on("error", () => this.fail(sqliteProtocolError()));
    child.stderr.on("error", () => this.fail(sqliteProtocolError()));
    child.once("error", () =>
      this.fail(
        new RuntimeError(
          "SQLITE_PROCESS_FAILED",
          "The native database helper failed.",
          502,
        ),
      ),
    );
    this.exited = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.ended = true;
        if (this.lifetime) clearTimeout(this.lifetime);
        this.signal.removeEventListener("abort", this.onAbort);
        try {
          this.frames.finish();
        } catch {
          this.fail(sqliteProtocolError());
        }
        if (
          !this.failure &&
          (code !== 0 || signal !== null || !this.closedReply)
        ) {
          const codes: Partial<Record<number, NativeSqliteCode>> = {
            64: "PROTOCOL",
            65: "GUARD_UNAVAILABLE",
            66: "CANCELLED",
            67: "DEADLINE",
            68: "PARENT_LOST",
            69: "CHANNEL_LOST",
            71: "LIMIT",
            72: "CLEANUP",
          };
          this.fail(
            code !== null && codes[code]
              ? nativeSqliteError(codes[code])
              : new RuntimeError(
                  "SQLITE_PROCESS_FAILED",
                  "The native database helper exited before a successful close.",
                  502,
                ),
          );
        }
        if (code === 72) this.fail(nativeSqliteError("CLEANUP"));
        resolve();
      });
    });
    this.signal.addEventListener("abort", this.onAbort, { once: true });
    if (this.signal.aborted) this.onAbort();
    try {
      await ready;
      clearTimeout(startup);
      if (performance.now() - started >= SQLITE_OPERATION_MS)
        throw nativeSqliteError("DEADLINE");
      this.definition = definition;
      const response = await this.request("opened", {
        kind: "open",
        protocolVersion: 1,
        path: this.lease.path,
        definition,
        timeoutMs: SQLITE_OPERATION_MS,
      });
      if (
        response.kind !== "opened" ||
        !definition.userVersions.includes(response.userVersion)
      )
        throw sqliteProtocolError();
      await this.lease.verify();
      return response.userVersion;
    } catch (error) {
      this.fail(error instanceof Error ? error : sqliteProtocolError());
      await this.stop();
      throw this.failure ?? sqliteProtocolError();
    } finally {
      clearTimeout(startup);
    }
  }

  /** One bounded request at a time; a protocol/write/deadline failure poisons the entire source generation. */
  private request(
    expected: Pending["expected"],
    body: object,
  ): Promise<SqliteReply> {
    if (this.signal.aborted) return Promise.reject(cancelledRead(this.signal));
    if (this.failure) return Promise.reject(this.failure);
    if (!this.child || this.ended || this.pending)
      return Promise.reject(sqliteProtocolError());
    const id = ++this.sequence;
    const frame = sqliteRequestFrame({ ...body, id });
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(nativeSqliteError("DEADLINE")),
        SQLITE_OPERATION_MS + 1000,
      );
      this.pending = { id, started: false, expected, resolve, reject, timer };
      child.stdin.write(frame, (error) => {
        if (error) this.fail(sqliteProtocolError());
      });
    });
  }

  /** Execute only a registered query with exact bindings; recompute all original row witnesses and encoded budgets. */
  async query(
    queryId: string,
    bindings: SqliteBindings,
    rows: number,
    bytes: number,
  ): Promise<{ rows: readonly SqliteRow[]; bytes: number }> {
    if (this.closing || !this.definition)
      throw new RuntimeError(
        "SQLITE_CLOSED",
        "The native database read is not open.",
        409,
      );
    const definition = this.definition;
    const query = definition.queries.find((q) => q.id === queryId);
    if (!query) throw nativeSqliteError("QUERY");
    const copied = copySqliteBindings(bindings);
    const names = new Set(query.filters.map((filter) => filter.parameter));
    if (
      names.size !== Object.keys(copied).length ||
      [...names].some((name) => !Object.hasOwn(copied, name))
    )
      throw nativeSqliteError("BINDINGS");
    if (
      !Number.isSafeInteger(rows) ||
      rows < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    )
      throw nativeSqliteError("LIMIT");
    if (++this.queryCount > 256) throw nativeSqliteError("LIMIT");
    const maxRows = Math.min(rows, this.remainingRows),
      maxBytes = Math.min(bytes, this.remainingBytes);
    await this.lease.verify();
    const reply = await this.request("rows", {
      kind: "query",
      queryId,
      bindings: Object.fromEntries(
        Object.entries(copied).map(([name, value]) => [
          name,
          encodeCell(value),
        ]),
      ),
      maxRows,
      maxBytes,
      timeoutMs: SQLITE_OPERATION_MS,
    });
    if (reply.kind !== "rows") throw sqliteProtocolError();
    let decoded: readonly SqliteRow[];
    try {
      decoded = decodeRows(reply, definition, queryId, maxRows, maxBytes);
    } catch {
      const error = sqliteProtocolError();
      this.fail(error);
      throw error;
    }
    if (this.signal.aborted) throw cancelledRead(this.signal);
    if (this.failure) throw this.failure;
    await this.lease.verify();
    this.remainingRows -= decoded.length;
    this.remainingBytes -= reply.bytes;
    return { rows: decoded, bytes: reply.bytes };
  }

  /** Require close acknowledgement, whole-frame output and actual successful exit before releasing a source lease. */
  close(): Promise<boolean> {
    return (this.closing ??= (async () => {
      try {
        const reply = await this.request("closed", { kind: "close" });
        if (reply.kind !== "closed") throw sqliteProtocolError();
        await this.awaitExit();
        if (this.failure) throw this.failure;
        return reply.observation.changed;
      } catch (error) {
        await this.stop();
        throw error;
      }
    })());
  }

  /** Bound confirmation of process exit; cleanup failure prevents source lease release or replacement reads. */
  private async awaitExit(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(nativeSqliteError("CLEANUP")), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Stop only the owned child; never mistake rejection of an awaiting Promise for native termination. */
  async stop(): Promise<void> {
    if (!this.child || !this.ended) {
      this.fail(
        this.failure ??
          new RuntimeError(
            "SQLITE_CLOSED",
            "The native database read was stopped.",
            409,
          ),
      );
    }
    await this.awaitExit();
  }
}
