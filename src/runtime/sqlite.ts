/**
 * Own isolated database processes and their deadlines. Native SQLite work is
 * terminated at the process boundary, not merely abandoned by Promise.race.
 * The source lease remains pinned until actual process exit is confirmed.
 */
import { fork, type ChildProcess } from "node:child_process";
import type {
  SqliteBindings,
  SqliteDefinition,
  SqliteRow,
} from "../evidence/source-access.js";
import { RuntimeError, cancelledRead } from "./errors.js";
import type { DatabaseLease } from "./sources.js";
import {
  sqliteReplySchema,
  sqliteValueSchema,
  sqliteBindingBytes,
  MAX_SQLITE_ROWS,
  MAX_SQLITE_RESULT_BYTES,
  MAX_SQLITE_BINDING_BYTES,
  type SqliteReply,
  type SqliteRequest,
  type SqliteErrorCode,
} from "./sqlite-protocol.js";

/** Pending IPC request, owned until a validated reply or actual process exit. */
interface Pending {
  resolve(value: SqliteReply): void;
  reject(error: Error): void;
}

const messages: Record<SqliteErrorCode, string> = {
  SQLITE_SCHEMA: "The database schema/version is not supported by this reader.",
  SQLITE_QUERY: "The reader requested an undeclared database query.",
  SQLITE_BINDINGS: "The reader supplied invalid database query bindings.",
  SQLITE_LIMIT:
    "The database query exceeded its row, binding or result-byte limit.",
  SQLITE_DATA: "The database contains unsupported or malformed data.",
  SQLITE_LOCKED:
    "The database is locked. Retry after the harness finishes its operation.",
  SQLITE_CHANGED:
    "The database or a required sidecar changed identity during the read.",
  SQLITE_FAILED: "The isolated database reader failed.",
};

/**
 * Validate and snapshot parameters before queueing or interprocess transport.
 * Reject oversized values before copying binary data; only SQLite's signed 64-bit integers are valid.
 */
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
    throw new RuntimeError("SQLITE_BINDINGS", messages.SQLITE_BINDINGS, 422);
  if (sqliteBindingBytes(bindings) > MAX_SQLITE_BINDING_BYTES)
    throw new RuntimeError("SQLITE_LIMIT", messages.SQLITE_LIMIT, 413);
  return Object.freeze(
    Object.fromEntries(
      entries.map(([name, value]) => [
        name,
        value instanceof Uint8Array ? new Uint8Array(value) : value,
      ]),
    ),
  );
}

/** One pinned source and read transaction. No process or credential is shared with the analysis provider. */
export class SqliteSource {
  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private stopped = false;
  private failure: Error | undefined;
  private closing: Promise<boolean> | undefined;
  private readonly onAbort: () => void;

  /**
   * Start only the fixed application reader with no inherited debugger/provider environment.
   * @param lease - Authorized runtime-owned database descriptor; caller closes after stop.
   * @param signal - Overall read deadline/cancellation; abort kills this owned process.
   */
  constructor(
    private readonly lease: DatabaseLease,
    private readonly signal: AbortSignal,
  ) {
    if (signal.aborted) throw cancelledRead(signal);
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    this.child = fork(new URL("./sqlite-child.js", import.meta.url), [], {
      env,
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.exited = new Promise((resolve) => {
      /** Release waiters only after exit or failure to spawn, not merely after a kill request. */
      const finish = () => {
        this.stopped = true;
        this.signal.removeEventListener("abort", this.onAbort);
        for (const request of this.pending.values())
          request.reject(
            this.failure ??
              new RuntimeError(
                "SQLITE_PROCESS_EXITED",
                "The database reader exited before completing its request.",
                502,
              ),
          );
        this.pending.clear();
        resolve();
      };
      this.child.once("exit", (code) => {
        if (code !== 0)
          this.failure ??= new RuntimeError(
            "SQLITE_PROCESS_FAILED",
            "The database reader exited unsuccessfully.",
            502,
          );
        finish();
      });
      this.child.once("error", () => {
        this.failure = new RuntimeError(
          "SQLITE_PROCESS_FAILED",
          "The database reader process could not run.",
          502,
        );
        if (this.child.pid === undefined) finish();
        else this.child.kill("SIGKILL");
      });
    });
    this.onAbort = () => {
      this.failure = cancelledRead(signal);
      this.child.kill("SIGKILL");
    };
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.onAbort();
    this.child.on("message", (raw) => {
      const parsed = sqliteReplySchema.safeParse(raw);
      if (!parsed.success) {
        this.failure = new RuntimeError(
          "SQLITE_PROCESS_PROTOCOL",
          "The database reader returned an invalid response.",
          502,
        );
        this.child.kill("SIGKILL");
        return;
      }
      const reply = parsed.data;
      const request = this.pending.get(reply.id);
      if (!request) {
        this.failure = new RuntimeError(
          "SQLITE_PROCESS_PROTOCOL",
          "The database reader returned an unrelated response.",
          502,
        );
        this.child.kill("SIGKILL");
        return;
      }
      if (reply.kind === "started") return;
      this.pending.delete(reply.id);
      if (reply.kind === "error")
        request.reject(
          new RuntimeError(
            reply.code,
            messages[reply.code],
            reply.code === "SQLITE_LIMIT" ? 413 : 422,
          ),
        );
      else request.resolve(reply);
    });
  }

  /**
   * Open/admit the schema; the caller retains this owner even when initialization fails.
   * @param definition - Validated application-owned tables/queries/versions.
   * @returns Observed user_version after admission; caller must stop/release on rejection.
   */
  async initialize(definition: SqliteDefinition): Promise<number> {
    await this.lease.verify();
    const response = await this.request({
      kind: "open",
      id: 0,
      path: this.lease.path,
      main: this.lease.main,
      sidecars: {
        "-wal": this.lease.sidecars["-wal"] ?? null,
        "-shm": this.lease.sidecars["-shm"] ?? null,
        "-journal": this.lease.sidecars["-journal"] ?? null,
      },
      definition,
    });
    if (response.kind !== "opened")
      throw new RuntimeError(
        "SQLITE_PROCESS_PROTOCOL",
        "The database reader did not confirm schema admission.",
        502,
      );
    await this.lease.verify();
    return response.userVersion;
  }

  /** Send one numbered request; channel errors terminate and reject rather than inventing empty results. */
  private request(message: SqliteRequest): Promise<SqliteReply> {
    if (this.stopped || this.failure)
      return Promise.reject(
        this.failure ??
          new RuntimeError(
            "SQLITE_CLOSED",
            "The database read is already closed.",
            409,
          ),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ ...message, id }, (error) => {
        if (!error) return;
        this.failure = new RuntimeError(
          "SQLITE_PROCESS_FAILED",
          "The database reader channel failed.",
          502,
        );
        this.child.kill("SIGKILL");
      });
    });
  }

  /**
   * Query one named projection; results are bounded in the child before transport.
   * @param queryId - Application query identifier, never raw SQL.
   * @param bindings - Exact named parameters.
   * @param rows - Remaining aggregate row budget.
   * @param bytes - Remaining aggregate byte budget.
   * @returns Validated rows and measured encoded cost; rejects after cancellation/identity changes.
   */
  async query(
    queryId: string,
    bindings: SqliteBindings,
    rows: number,
    bytes: number,
  ): Promise<{ rows: readonly SqliteRow[]; bytes: number }> {
    if (this.closing)
      throw new RuntimeError(
        "SQLITE_CLOSED",
        "The database read is closing.",
        409,
      );
    if (this.signal.aborted) throw cancelledRead(this.signal);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(queryId))
      throw new RuntimeError("SQLITE_QUERY", messages.SQLITE_QUERY, 422);
    const copied = copySqliteBindings(bindings);
    await this.lease.verify();
    const response = await this.request({
      kind: "query",
      id: 0,
      queryId,
      bindings: copied,
      maxRows: Math.min(rows, MAX_SQLITE_ROWS),
      maxBytes: Math.min(bytes, MAX_SQLITE_RESULT_BYTES),
    });
    if (response.kind !== "rows")
      throw new RuntimeError(
        "SQLITE_PROCESS_PROTOCOL",
        "The database reader did not return query rows.",
        502,
      );
    if (
      response.rows.length > Math.min(rows, MAX_SQLITE_ROWS) ||
      response.bytes > Math.min(bytes, MAX_SQLITE_RESULT_BYTES)
    )
      throw new RuntimeError(
        "SQLITE_PROCESS_PROTOCOL",
        "The database reader exceeded its assigned result budget.",
        502,
      );
    if (this.signal.aborted) throw cancelledRead(this.signal);
    await this.lease.verify();
    return response;
  }

  /**
   * Close the snapshot and await actual child exit before the source lease can be released.
   * @returns Whether another connection committed during the snapshot.
   */
  close(): Promise<boolean> {
    return (this.closing ??= (async () => {
      if (this.signal.aborted || this.failure) {
        await this.stop();
        throw this.failure ?? cancelledRead(this.signal);
      }
      try {
        const reply = await this.request({ kind: "close", id: 0 });
        if (reply.kind !== "closed")
          throw new RuntimeError(
            "SQLITE_PROCESS_PROTOCOL",
            "The database reader did not confirm transaction close.",
            502,
          );
        await this.exited;
        if (this.failure) throw this.failure;
        return reply.changed;
      } catch (error) {
        await this.stop();
        throw error;
      }
    })());
  }

  /** Terminate only this owned process, even while native SQLite is blocked, and wait for exit. */
  async stop(): Promise<void> {
    if (!this.stopped) {
      this.failure ??= new RuntimeError(
        "SQLITE_CLOSED",
        "The database read was stopped.",
        409,
      );
      this.child.kill("SIGKILL");
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RuntimeError(
                  "SQLITE_CLEANUP_FAILED",
                  "The owned database process did not confirm exit.",
                  500,
                ),
              ),
            5000,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
