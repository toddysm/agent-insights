/**
 * Owned, short-lived SQLite reader process. Native synchronous queries execute
 * here so the parent can terminate actual in-flight work on deadline/cancellation.
 * Only generated SELECT projections over declared ordinary tables are supported.
 * No provider SDK, network client, settings discovery or payload logging is loaded.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { SqliteDefinition, SqliteRow } from "../evidence/source-access.js";
import type { FileState } from "./sources.js";
import {
  MAX_SQLITE_BINDING_BYTES,
  sqliteRequestSchema,
  sqliteBindingBytes,
  taggedSqliteValue,
  type SqliteErrorCode,
  type SqliteReply,
  type SqliteRequest,
} from "./sqlite-protocol.js";

/** Fixed failure code; raw driver messages never leave this process. */
class DatabaseFailure extends Error {
  constructor(readonly code: SqliteErrorCode) {
    super(code);
  }
}

let database: DatabaseSync | undefined;
let definition: SqliteDefinition | undefined;
let initial: Extract<SqliteRequest, { kind: "open" }> | undefined;
let initialVersion = 0;

/** Quote an already-validated code-owned identifier; values never enter this function. */
function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value))
    throw new DatabaseFailure("SQLITE_QUERY");
  return `"${value}"`;
}

/** Reject identity changes/links rather than opening a replacement database or sidecar. */
function verifyFile(file: string, expected: FileState | null): void {
  try {
    const info = lstatSync(file, { bigint: true });
    if (
      !expected ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      String(info.dev) !== expected.dev ||
      String(info.ino) !== expected.ino
    )
      throw new DatabaseFailure("SQLITE_CHANGED");
  } catch (error) {
    if (
      expected === null &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw new DatabaseFailure("SQLITE_CHANGED");
  }
}

/** Recheck the authorized canonical location and exact sidecars on every operation. */
function verifySource(): void {
  if (!initial) throw new DatabaseFailure("SQLITE_FAILED");
  if (realpathSync(initial.path) !== initial.path)
    throw new DatabaseFailure("SQLITE_CHANGED");
  verifyFile(initial.path, initial.main);
  for (const suffix of ["-wal", "-shm", "-journal"] as const)
    verifyFile(initial.path + suffix, initial.sidecars[suffix]);
}

/**
 * Admit a database schema in a read transaction. No producer constructors/migrations are used.
 * @param request - Parent-authorized path, observations and code-owned schema/query declarations.
 * @returns Observed user_version after read-only/schema admission.
 */
function openDatabase(
  request: Extract<SqliteRequest, { kind: "open" }>,
): number {
  if (database) throw new DatabaseFailure("SQLITE_FAILED");
  initial = request;
  verifySource();
  database = new DatabaseSync(request.path, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    timeout: 1000,
  });
  database.exec(
    "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=1000",
  );
  if (database.prepare("PRAGMA query_only").get()?.query_only !== 1)
    throw new DatabaseFailure("SQLITE_FAILED");
  initialVersion = Number(
    database.prepare("PRAGMA data_version").get()?.data_version,
  );
  database.exec("BEGIN");
  const version = Number(
    database.prepare("PRAGMA user_version").get()?.user_version,
  );
  if (!request.definition.userVersions.includes(version))
    throw new DatabaseFailure("SQLITE_SCHEMA");
  const kinds = database.prepare("PRAGMA table_list").all();
  for (const table of request.definition.tables) {
    if (
      !kinds.some(
        (row) =>
          row.schema === "main" &&
          row.name === table.name &&
          row.type === "table",
      )
    )
      throw new DatabaseFailure("SQLITE_SCHEMA");
    const columns = database
      .prepare(`PRAGMA main.table_xinfo(${identifier(table.name)})`)
      .all();
    if (
      columns.some((row) => row.hidden !== 0) ||
      table.columns.some((name) => !columns.some((row) => row.name === name))
    )
      throw new DatabaseFailure("SQLITE_SCHEMA");
    const primary = columns
      .filter((row) => Number(row.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((row) => row.name);
    if (JSON.stringify(primary) !== JSON.stringify(table.primaryKey))
      throw new DatabaseFailure("SQLITE_SCHEMA");
  }
  verifySource();
  definition = request.definition;
  return version;
}

/**
 * Execute a named projection and enforce actual result limits before transmitting rows.
 * @param request - Exact query name/bindings plus the parent's remaining aggregate budgets.
 * @returns Captured projections and their encoded byte cost; throws on one-over limits.
 */
function queryDatabase(request: Extract<SqliteRequest, { kind: "query" }>): {
  rows: SqliteRow[];
  bytes: number;
} {
  if (!database || !definition) throw new DatabaseFailure("SQLITE_FAILED");
  verifySource();
  const query = definition.queries.find(
    (query) => query.id === request.queryId,
  );
  if (!query) throw new DatabaseFailure("SQLITE_QUERY");
  const table = definition.tables.find((table) => table.name === query.table);
  if (!table) throw new DatabaseFailure("SQLITE_SCHEMA");
  const parameters = [
    ...new Set(query.filters.map((filter) => filter.parameter)),
  ];
  if (
    Object.keys(request.bindings).length !== parameters.length ||
    parameters.some((parameter) => !Object.hasOwn(request.bindings, parameter))
  )
    throw new DatabaseFailure("SQLITE_BINDINGS");
  const bindingBytes = sqliteBindingBytes(request.bindings);
  if (bindingBytes > MAX_SQLITE_BINDING_BYTES)
    throw new DatabaseFailure("SQLITE_LIMIT");
  const bindings: SQLInputValue[] = [];
  const predicates = query.filters.map((filter) => {
    let column = identifier(filter.column);
    if (filter.jsonPath) {
      const jsonPath =
        "$" +
        filter.jsonPath
          .map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`))
          .join("");
      column = `json_extract(${column}, ?)`;
      bindings.push(jsonPath);
    }
    bindings.push(request.bindings[filter.parameter] ?? null);
    return `${column} IS ?`;
  });
  const sql =
    `SELECT ${query.columns.map(identifier).join(",")} FROM main.${identifier(query.table)}` +
    (predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "") +
    ` ORDER BY ${table.primaryKey.map(identifier).join(",")} LIMIT ?`;
  bindings.push(request.maxRows + 1);
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  const rows: SqliteRow[] = [];
  let bytes = 0;
  for (const values of statement.iterate(...bindings)) {
    if (rows.length >= request.maxRows)
      throw new DatabaseFailure("SQLITE_LIMIT");
    const key = table.primaryKey.map((column) => {
      const value = values[column];
      if (value === undefined || value === null || value instanceof Uint8Array)
        throw new DatabaseFailure("SQLITE_DATA");
      return {
        column,
        type:
          typeof value === "bigint"
            ? ("integer" as const)
            : typeof value === "number"
              ? ("real" as const)
              : ("text" as const),
        value: String(value),
      };
    });
    const encoded = JSON.stringify(
      query.columns.map((column) => {
        const value = values[column];
        if (
          value === undefined ||
          (typeof value === "number" && !Number.isFinite(value))
        )
          throw new DatabaseFailure("SQLITE_DATA");
        return [column, taggedSqliteValue(value)];
      }),
    );
    const row: SqliteRow = {
      values,
      table: table.name,
      key,
      fingerprint: createHash("sha256").update(encoded).digest("hex"),
    };
    bytes +=
      Buffer.byteLength(encoded) +
      Buffer.byteLength(
        JSON.stringify({ table: row.table, key, fingerprint: row.fingerprint }),
      );
    if (bytes > request.maxBytes) throw new DatabaseFailure("SQLITE_LIMIT");
    rows.push(row);
  }
  verifySource();
  return { rows, bytes };
}

/** End only the read transaction; report concurrent commits rather than checkpointing a source. */
function closeDatabase(): boolean {
  if (!database) return false;
  try {
    database.exec("ROLLBACK");
    const changed =
      Number(database.prepare("PRAGMA data_version").get()?.data_version) !==
      initialVersion;
    verifySource();
    return changed;
  } finally {
    database.close();
    database = undefined;
  }
}

/** Surface driver failures through fixed public categories, never source-dependent exception text. */
function failure(error: unknown): SqliteErrorCode {
  if (error instanceof DatabaseFailure) return error.code;
  if (
    error instanceof Error &&
    "errcode" in error &&
    typeof error.errcode === "number"
  ) {
    const primaryCode = error.errcode & 0xff;
    if (primaryCode === 5 || primaryCode === 6) return "SQLITE_LOCKED";
    return "SQLITE_DATA";
  }
  return "SQLITE_FAILED";
}

/** Send one sanitized/validated result; close the private channel only after a close reply is flushed. */
function reply(message: SqliteReply, close = false): void {
  if (!process.send) process.exit(1);
  process.send(message, (error) => {
    if (error) process.exit(1);
    if (close) process.disconnect();
  });
}

process.on("message", (raw) => {
  const parsed = sqliteRequestSchema.safeParse(raw);
  if (!parsed.success) {
    process.exitCode = 1;
    process.disconnect();
    return;
  }
  const request = parsed.data;
  try {
    if (request.kind !== "close")
      reply({ kind: "started", id: request.id, operation: request.kind });
    if (request.kind === "open")
      reply({
        kind: "opened",
        id: request.id,
        userVersion: openDatabase(request),
      });
    else if (request.kind === "query")
      reply({ kind: "rows", id: request.id, ...queryDatabase(request) });
    else
      reply({ kind: "closed", id: request.id, changed: closeDatabase() }, true);
  } catch (error) {
    reply({ kind: "error", id: request.id, code: failure(error) });
  }
});
process.on("disconnect", () => {
  try {
    database?.close();
  } catch {
    process.exitCode = 1;
  }
});
