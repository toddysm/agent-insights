/** Private database-process messages. Browser controls cannot supply SQL or these declarations. */
import { z } from "zod";
import {
  sqliteDefinitionSchema,
  sqliteKeySchema,
  type SqliteBindings,
  type SqliteValue,
} from "../evidence/source-access.js";

export const MAX_SQLITE_ROWS = 10_000;
export const MAX_SQLITE_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_SQLITE_BINDING_BYTES = 8192;

/** IPC retains exact integers/binary cells rather than coercing them into JSON numbers/text. */
export const sqliteValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.bigint().min(-9223372036854775808n).max(9223372036854775807n),
  z.instanceof(Uint8Array),
  z.null(),
]);

/** Canonical tagged cells preserve integer/binary identity for byte accounting and fingerprints. */
export function taggedSqliteValue(
  value: SqliteValue,
): readonly [string, string | number | null] {
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (value instanceof Uint8Array)
    return ["blob", Buffer.from(value).toString("base64")];
  return [value === null ? "null" : typeof value, value];
}

/**
 * Measure tagged parameter values without encoding an unbounded string/blob.
 * Returns an over-limit value as soon as the cap is crossed; callers must reject it.
 * The bounded count is independent of parameter order.
 */
export function sqliteBindingBytes(bindings: SqliteBindings): number {
  let bytes = 2;
  let separator = 0;
  for (const value of Object.values(bindings)) {
    if (
      (typeof value === "string" && value.length > MAX_SQLITE_BINDING_BYTES) ||
      (value instanceof Uint8Array &&
        value.byteLength > MAX_SQLITE_BINDING_BYTES)
    )
      return MAX_SQLITE_BINDING_BYTES + 1;
    bytes +=
      separator + Buffer.byteLength(JSON.stringify(taggedSqliteValue(value)));
    if (bytes > MAX_SQLITE_BINDING_BYTES) return bytes;
    separator = 1;
  }
  return bytes;
}
const state = z.strictObject({
  dev: z.string(),
  ino: z.string(),
  size: z.string(),
  mtime: z.string(),
  ctime: z.string(),
});
const id = z.number().int().positive();

/** Validated internal requests; database files were already authorized/pinned by SourceAccess. */
export const sqliteRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("open"),
    id,
    path: z.string(),
    main: state,
    sidecars: z.strictObject({
      "-wal": state.nullable(),
      "-shm": state.nullable(),
      "-journal": state.nullable(),
    }),
    definition: sqliteDefinitionSchema,
  }),
  z.strictObject({
    kind: z.literal("query"),
    id,
    queryId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    bindings: z.record(z.string(), sqliteValueSchema),
    maxRows: z.number().int().nonnegative().max(MAX_SQLITE_ROWS),
    maxBytes: z.number().int().nonnegative().max(MAX_SQLITE_RESULT_BYTES),
  }),
  z.strictObject({ kind: z.literal("close"), id }),
]);
/** Request sent only over the owned child's IPC channel. */
export type SqliteRequest = z.infer<typeof sqliteRequestSchema>;

/** Original row projection and evidence witness, with no executable behavior. */
export const sqliteRowSchema = z.strictObject({
  values: z.record(z.string(), sqliteValueSchema),
  table: z.string(),
  key: sqliteKeySchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Child failures contain fixed codes only, never native SQLite errors or SQL/captured values. */
export const sqliteErrorCodeSchema = z.enum([
  "SQLITE_SCHEMA",
  "SQLITE_QUERY",
  "SQLITE_BINDINGS",
  "SQLITE_LIMIT",
  "SQLITE_DATA",
  "SQLITE_LOCKED",
  "SQLITE_CHANGED",
  "SQLITE_FAILED",
]);
/** Controlled database failure vocabulary shared by both process ends. */
export type SqliteErrorCode = z.infer<typeof sqliteErrorCodeSchema>;

/** Replies are revalidated in the parent before any data reaches a reader. */
export const sqliteReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("started"),
    id,
    operation: z.enum(["open", "query"]),
  }),
  z.strictObject({
    kind: z.literal("opened"),
    id,
    userVersion: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal("rows"),
    id,
    rows: z.array(sqliteRowSchema).max(MAX_SQLITE_ROWS),
    bytes: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("closed"), id, changed: z.boolean() }),
  z.strictObject({ kind: z.literal("error"), id, code: sqliteErrorCodeSchema }),
]);
/** Validated reply, with exact integer cells kept inside the trusted reader boundary. */
export type SqliteReply = z.infer<typeof sqliteReplySchema>;
