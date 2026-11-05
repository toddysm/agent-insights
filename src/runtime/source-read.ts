/**
 * Assemble explicitly selected file/database inputs for one transient read.
 * The owner enforces aggregate budgets, original-row witnesses and cleanup;
 * source-specific identity, event parsing and accounting stay in domain readers.
 */
import { createHash } from "node:crypto";
import type { ReadView } from "../evidence/contracts.js";
import {
  sourceRequirementSchema,
  type MultiSourceInput,
  type MultiSourceReader,
  type SourceInput,
  type SourceObservation,
  type SourceRequirement,
  type SqliteBindings,
  type SqliteRow,
} from "../evidence/source-access.js";
import { RuntimeError, cancelledRead, abortable } from "./errors.js";
import {
  SourceAccess,
  MAX_SOURCE_BYTES,
  byteChunks,
  type DatabaseLease,
} from "./sources.js";
import {
  SqliteSource,
  copySqliteBindings,
  defaultNativeHelper,
  type NativeHelperResolver,
} from "./sqlite.js";
import { MAX_SQLITE_ROWS } from "./sqlite-protocol.js";

/** Public controls select grants/roles only; schemas and SQL are never accepted here. */
export interface SourceBinding {
  readonly key: string;
  readonly sourceId: string;
  readonly relativePath: string;
}

/** Database ownership is retained until both process and pinned descriptor are closed. */
interface DatabaseOwner {
  readonly key: string;
  readonly sourceId: string;
  readonly lease: DatabaseLease;
  readonly process: SqliteSource;
  userVersion?: number;
}

/** Witness for the exact projection returned by a database operation in this generation. */
interface RowWitness {
  readonly recordId: string;
  readonly columns: ReadonlySet<string>;
}

/**
 * Build an original row reference without coercing keys or referencing a normalized object.
 * @param sourceId - This input's generated current-read identity.
 * @param row - Original row returned by the restricted database input.
 * @param column - Queried field, or null for the whole captured projection.
 * @param pointer - JSON Pointer within a structured field; empty for a whole row.
 * @returns A shared-contract reference; runtime validates it against this read's witnesses.
 */
export function sqliteReference(
  sourceId: string,
  row: SqliteRow,
  column: string | null = null,
  pointer = "",
): ReadView["events"][number]["references"][number] {
  if (
    (column === null && pointer !== "") ||
    (column !== null && !Object.hasOwn(row.values, column))
  )
    throw new RuntimeError(
      "INVALID_SQLITE_REFERENCE",
      "Database evidence must reference a captured column.",
      422,
    );
  return {
    sourceId,
    recordId: rowIdentity(row.table, row.key),
    location: {
      kind: "sqlite",
      table: row.table,
      key: row.key,
      column,
      pointer,
      fingerprint: row.fingerprint,
    },
  };
}

/** Stable identity uses the original table/typed key; a row's position is never its identity. */
function rowIdentity(table: string, key: SqliteRow["key"]): string {
  return `sqlite:${table}:${createHash("sha256").update(JSON.stringify(key)).digest("hex")}`;
}

/** Match row projection witnesses independently of a later reference's chosen field. */
function witnessKey(
  table: string,
  key: SqliteRow["key"],
  fingerprint: string,
): string {
  return JSON.stringify([table, key, fingerprint]);
}

/** One composite capture; no view/history survives disposal or generation invalidation. */
export class SourceReadSet implements MultiSourceInput {
  readonly requirements: readonly SourceRequirement[];
  readonly signal: AbortSignal;
  private readonly stopped = new AbortController();
  private readonly inputs = new Map<string, SourceInput>();
  private readonly observations = new Map<string, SourceObservation>();
  private readonly databases = new Map<string, DatabaseOwner>();
  private readonly witnesses = new Map<string, Map<string, RowWitness>>();
  private remainingBytes = MAX_SOURCE_BYTES;
  private remainingRows = MAX_SQLITE_ROWS;
  private queryCount = 0;
  private queue: Promise<void> = Promise.resolve();
  private queryFailure: Error | undefined;
  private finishing = false;
  private disposal: Promise<void> | undefined;
  private admission: Promise<void> | undefined;
  private finalization: Promise<readonly SourceObservation[]> | undefined;

  /**
   * Establish ownership before opening any source/process, so failed setup is still disposable.
   * @param readId - Runtime-owned generation.
   * @param signal - Overall cancellation/deadline signal.
   * @param access - Startup-authorized grant boundary.
   * @param reader - Trusted registered adapter declarations, validated and copied here.
   * @param nativeHelper - Trusted pinned artifact resolver; public controls cannot supply one.
   */
  constructor(
    readonly readId: string,
    signal: AbortSignal,
    private readonly access: SourceAccess,
    reader: MultiSourceReader,
    private readonly nativeHelper: NativeHelperResolver = defaultNativeHelper,
  ) {
    this.signal = AbortSignal.any([signal, this.stopped.signal]);
    this.requirements = Object.freeze(
      reader.inputs.map((input) => sourceRequirementSchema.parse(input)),
    );
    if (
      this.requirements.length === 0 ||
      this.requirements.length > 8 ||
      new Set(this.requirements.map((input) => input.key)).size !==
        this.requirements.length
    )
      throw new RuntimeError(
        "INVALID_READER",
        "A composite reader must declare one to eight unique input roles.",
        500,
      );
  }

  /** Expose only a declared, prepared role; access after finalization is an explicit error. */
  get(key: string): SourceInput {
    if (this.finishing)
      throw new RuntimeError(
        "READ_CLOSED",
        "The source read has finished.",
        409,
      );
    const input = this.inputs.get(key);
    if (!input)
      throw new RuntimeError(
        "SOURCE_ROLE",
        "The reader requested an unavailable input role.",
        400,
      );
    return input;
  }

  /**
   * Capture files and open bounded database snapshots for exactly the requested roles.
   * @param bindings - Explicit grants/relative paths, copied by the runtime before this call.
   * @returns After admission; missing optional inputs are typed unavailable results, not empty data.
   */
  prepare(bindings: readonly SourceBinding[]): Promise<void> {
    if (this.admission || this.finishing)
      return Promise.reject(
        new RuntimeError(
          "READ_CLOSED",
          "The source admission has already started or finished.",
          409,
        ),
      );
    this.admission = this.prepareSources(bindings);
    return abortable(this.admission, this.signal);
  }

  /** Retain actual admission until it settles, including a descriptor acquired after cancellation. */
  private async prepareSources(
    bindings: readonly SourceBinding[],
  ): Promise<void> {
    if (
      bindings.length !== this.requirements.length ||
      new Set(bindings.map((binding) => binding.key)).size !==
        bindings.length ||
      bindings.some(
        (binding) =>
          !this.requirements.some((input) => input.key === binding.key),
      )
    )
      throw new RuntimeError(
        "SOURCE_ROLES",
        "Select exactly the registered input roles.",
        400,
      );
    for (const requirement of this.requirements) {
      if (this.signal.aborted) throw cancelledRead(this.signal);
      const binding = bindings.find(
        (binding) => binding.key === requirement.key,
      );
      if (!binding)
        throw new RuntimeError(
          "SOURCE_ROLES",
          "A required source role was not selected.",
          400,
        );
      const sourceId = `${this.readId}:source:${requirement.key}`;
      const startedAtMs = Date.now();
      try {
        if (requirement.kind === "file") {
          const capture = await this.access.read(
            binding.sourceId,
            binding.relativePath,
            this.signal,
            this.remainingBytes,
          );
          if (this.signal.aborted) throw cancelledRead(this.signal);
          this.consume(capture.bytes.byteLength, 0);
          this.inputs.set(
            requirement.key,
            Object.freeze({
              available: true,
              kind: "file",
              sourceId,
              bytes: byteChunks(capture.bytes, this.signal),
            }),
          );
          this.observations.set(sourceId, {
            sourceId,
            kind: "file",
            startedAtMs: capture.startedAtMs,
            finishedAtMs: capture.finishedAtMs,
            changed: capture.changed,
            available: true,
          });
        } else {
          const lease = await this.access.database(
            binding.sourceId,
            binding.relativePath,
            this.signal,
          );
          let process: SqliteSource;
          try {
            process = new SqliteSource(lease, this.signal, this.nativeHelper);
          } catch (error) {
            await lease.close();
            throw error;
          }
          const owner: DatabaseOwner = {
            key: requirement.key,
            sourceId,
            lease,
            process,
          };
          this.databases.set(requirement.key, owner);
          owner.userVersion = await process.initialize(requirement.database);
          const snapshotScope = process.snapshotScope;
          if (!snapshotScope)
            throw new RuntimeError(
              "SQLITE_PROCESS_PROTOCOL",
              "The native helper did not establish a snapshot scope.",
              502,
            );
          this.inputs.set(
            requirement.key,
            Object.freeze({
              available: true,
              kind: "sqlite",
              sourceId,
              userVersion: owner.userVersion,
              snapshotScope,
              query: (id: string, parameters: SqliteBindings) =>
                this.query(owner, id, parameters),
            }),
          );
        }
      } catch (error) {
        const optionalCodes = [
          "SOURCE_MISSING",
          "SOURCE_UNAVAILABLE",
          "SOURCE_DENIED",
          "SOURCE_IO",
          "SQLITE_SCHEMA",
          "SQLITE_FORMAT",
          "SQLITE_SIDECARS",
          "SQLITE_RECOVERY_REQUIRED",
          "SQLITE_JOURNAL_PRESENT",
          "SQLITE_LOCKED",
        ];
        if (
          !requirement.optional ||
          !(error instanceof RuntimeError) ||
          !optionalCodes.includes(error.code)
        )
          throw error;
        const owner = this.databases.get(requirement.key);
        if (owner) {
          await owner.process.stop();
          await owner.lease.close();
          this.databases.delete(requirement.key);
        }
        this.inputs.set(
          requirement.key,
          Object.freeze({
            available: false,
            sourceId,
            code: error.code,
            reason: error.message,
          }),
        );
        this.observations.set(sourceId, {
          sourceId,
          kind: requirement.kind,
          startedAtMs,
          finishedAtMs: Date.now(),
          changed: false,
          available: false,
        });
      }
    }
  }

  /** Reserve actual bytes/rows against the entire read, not a silently reset per-query allowance. */
  private consume(bytes: number, rows: number): void {
    if (bytes > this.remainingBytes || rows > this.remainingRows)
      throw new RuntimeError(
        "READ_LIMIT",
        "The combined read exceeded its byte or database-row limit.",
        413,
      );
    this.remainingBytes -= bytes;
    this.remainingRows -= rows;
  }

  /**
   * Serialize requests against the shared budget, retaining failures for finalization too.
   * @param owner - This role's retained database/process owner.
   * @param queryId - Application-owned named projection.
   * @param bindings - Exact named parameters; never SQL.
   * @returns Bounded rows whose original key/columns are recorded for provenance validation.
   */
  private query(
    owner: DatabaseOwner,
    queryId: string,
    bindings: SqliteBindings,
  ): Promise<readonly SqliteRow[]> {
    if (this.finishing)
      return Promise.reject(
        new RuntimeError("READ_CLOSED", "The source read has finished.", 409),
      );
    if (++this.queryCount > 256) {
      const error = new RuntimeError(
        "READ_LIMIT",
        "The combined read exceeded its query-count limit.",
        413,
      );
      this.queryFailure ??= error;
      return Promise.reject(error);
    }
    let copied: SqliteBindings;
    try {
      copied = copySqliteBindings(bindings);
    } catch (error) {
      const failure =
        error instanceof Error
          ? error
          : new RuntimeError(
              "SQLITE_BINDINGS",
              "The query bindings are invalid.",
              422,
            );
      this.queryFailure ??= failure;
      return Promise.reject(failure);
    }
    const operation = this.queue.then(async () => {
      if (this.signal.aborted) throw cancelledRead(this.signal);
      const result = await owner.process.query(
        queryId,
        copied,
        this.remainingRows,
        this.remainingBytes,
      );
      if (this.signal.aborted) throw cancelledRead(this.signal);
      this.consume(result.bytes, result.rows.length);
      const witnesses =
        this.witnesses.get(owner.sourceId) ?? new Map<string, RowWitness>();
      for (const row of result.rows)
        witnesses.set(witnessKey(row.table, row.key, row.fingerprint), {
          recordId: rowIdentity(row.table, row.key),
          columns: new Set(Object.keys(row.values)),
        });
      this.witnesses.set(owner.sourceId, witnesses);
      return result.rows;
    });
    this.queue = operation.then(
      () => undefined,
      (error: unknown) => {
        this.queryFailure ??=
          error instanceof Error
            ? error
            : new RuntimeError(
                "SQLITE_FAILED",
                "The database query failed.",
                502,
              );
      },
    );
    return operation;
  }

  /**
   * Close every successful snapshot and observe changes before publishing any result.
   * @returns Source-specific capture bounds, never a global atomic snapshot.
   * @throws Any query/cleanup/identity failure, including unawaited failed reader operations.
   */
  finish(): Promise<readonly SourceObservation[]> {
    if (this.disposal || this.signal.aborted)
      return Promise.reject(cancelledRead(this.signal));
    this.finishing = true;
    this.finalization ??= this.finishSources();
    return abortable(this.finalization, this.signal);
  }

  /** Track actual final verification separately from the caller's cancellable wait. */
  private async finishSources(): Promise<readonly SourceObservation[]> {
    await this.queue;
    if (this.queryFailure) throw this.queryFailure;
    for (const owner of this.databases.values()) {
      const changed = await owner.process.close();
      const changedFile = await owner.lease.verify();
      this.observations.set(owner.sourceId, {
        sourceId: owner.sourceId,
        kind: "sqlite",
        startedAtMs: owner.lease.startedAtMs,
        finishedAtMs: Date.now(),
        changed: changed || changedFile,
        available: true,
        userVersion: owner.userVersion,
        snapshotScope: owner.process.snapshotScope,
      });
    }
    return Object.freeze([...this.observations.values()]);
  }

  /**
   * Validate source membership and actual database witnesses before runtime publication.
   * @param view - Structurally validated adapter result for this generation.
   */
  validate(view: ReadView): void {
    const expected = new Map(
      this.requirements.map((requirement) => [
        `${this.readId}:source:${requirement.key}`,
        requirement,
      ]),
    );
    if (
      view.id !== this.readId ||
      view.sources.length !== expected.size ||
      view.sources.some(
        (source) =>
          !expected.has(source.id) ||
          (source.format !== null &&
            source.format !== expected.get(source.id)?.format),
      )
    )
      throw new RuntimeError(
        "INVALID_READER_RESULT",
        "The reader returned unrelated composite sources.",
        502,
      );
    for (const reference of [
      ...view.events.flatMap((event) => event.references),
      ...view.sessions.flatMap((session) => session.references),
    ]) {
      const requirement = expected.get(reference.sourceId);
      const observation = this.observations.get(reference.sourceId);
      if (!requirement || !observation?.available)
        throw new RuntimeError(
          "INVALID_READER_RESULT",
          "Evidence refers to an unavailable source.",
          502,
        );
      if (reference.location.kind === "sqlite") {
        const { table, key, fingerprint, column } = reference.location;
        const witness = this.witnesses
          .get(reference.sourceId)
          ?.get(witnessKey(table, key, fingerprint));
        if (
          requirement.kind !== "sqlite" ||
          !witness ||
          witness.recordId !== reference.recordId ||
          (column !== null && !witness.columns.has(column))
        )
          throw new RuntimeError(
            "INVALID_SQLITE_REFERENCE",
            "Database evidence does not match an observed row and field.",
            502,
          );
      } else if (requirement.kind !== "file")
        throw new RuntimeError(
          "INVALID_SQLITE_REFERENCE",
          "Database evidence requires an original row reference.",
          502,
        );
    }
  }

  /** Return explicit optional-input failures for runtime coverage/diagnostics; no payload text is retained. */
  unavailable(): readonly { sourceId: string; reason: string }[] {
    return [...this.inputs.values()]
      .filter((input) => !input.available)
      .map((input) => ({ sourceId: input.sourceId, reason: input.reason }));
  }

  /**
   * Stop owned processes, wait for real admission/query/verification completion, then release descriptors.
   * A five-second confirmation failure retains ownership and blocks replacement until cleanup is retried.
   * This is called on success, error, cancellation and server shutdown.
   */
  async dispose(): Promise<void> {
    this.finishing = true;
    this.stopped.abort(cancelledRead());
    const cleanup = (this.disposal ??= (async () => {
      try {
        await Promise.all(
          [...this.databases.values()].map((owner) => owner.process.stop()),
        );
        // Read failures are delivered by their callers; cleanup needs actual settlement, not read success.
        await Promise.allSettled([
          this.admission,
          this.queue,
          this.finalization,
        ]);
        const outcomes = await Promise.allSettled(
          [...this.databases].map(async ([key, owner]) => {
            await owner.process.stop();
            await owner.lease.close();
            this.databases.delete(key);
          }),
        );
        this.inputs.clear();
        this.witnesses.clear();
        const failed = outcomes.find(
          (outcome) => outcome.status === "rejected",
        );
        if (failed?.status === "rejected") throw failed.reason;
      } catch (error) {
        this.disposal = undefined;
        throw error;
      }
    })());
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
                  "Source cleanup could not be confirmed; retry cleanup before another read.",
                  500,
                ),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
