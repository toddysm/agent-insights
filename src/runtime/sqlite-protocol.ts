/** Strict native-helper frames, exact cells and original projection witnesses. No browser/capture SQL is accepted. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  sqliteKeySchema,
  type SqliteBindings,
  type SqliteDefinition,
  type SqliteRow,
  type SqliteValue,
} from "../evidence/source-access.js";
import { nativeHandshakeSchema } from "./native-helper.js";
import { RuntimeError } from "./errors.js";

export const MAX_SQLITE_ROWS = 10_000;
export const MAX_SQLITE_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_SQLITE_BINDING_BYTES = 8192;
export const MAX_SQLITE_REQUEST_BYTES = 1024 * 1024;
export const MAX_SQLITE_REPLY_BYTES = 24 * 1024 * 1024;
export const SQLITE_OPERATION_MS = 5000;

/** Integers retain signed-64-bit identity; these values never pass through an unsafe JavaScript integer. */
export const sqliteValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.bigint().min(-9223372036854775808n).max(9223372036854775807n),
  z.instanceof(Uint8Array),
  z.null(),
]);

/** Canonical tagged cell shape used for compatibility fingerprints and result-byte accounting. */
export function taggedSqliteValue(
  value: SqliteValue,
): readonly [string, string | number | null] {
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (value instanceof Uint8Array)
    return ["blob", Buffer.from(value).toString("base64")];
  return [value === null ? "null" : typeof value, value];
}

/** Count bounded binding bytes before copying/encoding; exceeding the cap is not truncated success. */
export function sqliteBindingBytes(bindings: SqliteBindings): number {
  let bytes = 2;
  for (const [index, value] of Object.values(bindings).entries()) {
    if (
      (typeof value === "string" && value.length > MAX_SQLITE_BINDING_BYTES) ||
      (value instanceof Uint8Array &&
        value.byteLength > MAX_SQLITE_BINDING_BYTES)
    )
      return MAX_SQLITE_BINDING_BYTES + 1;
    bytes +=
      Number(index > 0) +
      Buffer.byteLength(JSON.stringify(taggedSqliteValue(value)));
    if (bytes > MAX_SQLITE_BINDING_BYTES) return bytes;
  }
  return bytes;
}

const integer = z
  .string()
  .max(20)
  .regex(/^(0|-?[1-9][0-9]*)$/)
  .pipe(
    z.string().refine((value) => {
      const parsed = BigInt(value);
      return parsed >= -9223372036854775808n && parsed <= 9223372036854775807n;
    }),
  );
const cellSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("null") }),
  z.strictObject({ type: z.literal("integer"), value: integer }),
  z.strictObject({ type: z.literal("real"), value: z.number().finite() }),
  z.strictObject({
    type: z.literal("text"),
    value: z.string().max(MAX_SQLITE_RESULT_BYTES),
  }),
  z.strictObject({
    type: z.literal("blob"),
    value: z
      .string()
      .max(Math.ceil(MAX_SQLITE_RESULT_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .refine(
        (value) => Buffer.from(value, "base64").toString("base64") === value,
      ),
  }),
]);
/** Lossless tagged wire cell for the private helper channel. */
type Cell = z.infer<typeof cellSchema>;

/** Encode only already-validated values; bigint and binary never use JSON's lossy default conversion. */
export function encodeCell(value: SqliteValue): Cell {
  if (value === null) return { type: "null" };
  if (typeof value === "bigint")
    return { type: "integer", value: value.toString() };
  if (typeof value === "number") return { type: "real", value };
  if (typeof value === "string") return { type: "text", value };
  return { type: "blob", value: Buffer.from(value).toString("base64") };
}

/** Decode a validated cell; no missing-data defaults or integer rounding. */
function decodeCell(cell: Cell): SqliteValue {
  switch (cell.type) {
    case "null":
      return null;
    case "integer":
      return BigInt(cell.value);
    case "blob":
      return new Uint8Array(Buffer.from(cell.value, "base64"));
    default:
      return cell.value;
  }
}

const id = z.number().int().positive().max(0xffffffff);
export const snapshotScopeSchema = z.enum(["connection", "request"]);
const observation = z
  .strictObject({
    startedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    finishedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    changed: z.boolean(),
    snapshotScope: snapshotScopeSchema,
  })
  .refine((value) => value.finishedAtMs >= value.startedAtMs);
const row = z.strictObject({
  values: z.record(z.string(), cellSchema),
  table: z.string(),
  key: sqliteKeySchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const nativeSqliteCodeSchema = z.enum([
  "PROTOCOL",
  "CHANNEL_LOST",
  "PARENT_LOST",
  "DEADLINE",
  "CANCELLED",
  "GUARD_UNAVAILABLE",
  "ENGINE_MISMATCH",
  "POLICY_VIOLATION",
  "CLEANUP",
  "ACCESS_DENIED",
  "SOURCE_UNAVAILABLE",
  "SOURCE_CHANGED",
  "IO",
  "BUSY",
  "RECOVERY_REQUIRED",
  "JOURNAL_PRESENT",
  "SCHEMA",
  "QUERY",
  "BINDINGS",
  "LIMIT",
  "DATA",
  "CLOCK",
]);
/** All replies are revalidated before they can reach an evidence reader. */
export const sqliteReplySchema = z.discriminatedUnion("kind", [
  nativeHandshakeSchema,
  z.strictObject({ kind: z.literal("started"), id }),
  z.strictObject({
    kind: z.literal("opened"),
    id,
    userVersion: z.number().int().nonnegative().max(2147483647),
    snapshotScope: snapshotScopeSchema,
  }),
  z.strictObject({
    kind: z.literal("rows"),
    id,
    rows: z.array(row).max(MAX_SQLITE_ROWS),
    bytes: z.number().int().nonnegative().max(MAX_SQLITE_RESULT_BYTES),
    observation,
  }),
  z.strictObject({ kind: z.literal("closed"), id, observation }),
  z.strictObject({
    kind: z.literal("error"),
    id,
    code: nativeSqliteCodeSchema,
  }),
]);
export type SqliteReply = z.infer<typeof sqliteReplySchema>;
/** Closed helper error vocabulary; mappings never expose source-bearing native messages. */
export type NativeSqliteCode = z.infer<typeof nativeSqliteCodeSchema>;

/** Payload-free error for malformed, stale, oversized or inconsistent native output. */
export function sqliteProtocolError(): RuntimeError {
  return new RuntimeError(
    "SQLITE_PROCESS_PROTOCOL",
    "The native database helper returned an invalid response.",
    502,
  );
}

/** One prefix-validated frame buffer. Counts each byte once and rejects partial termination. */
export class SqliteFrames {
  private readonly prefix = Buffer.alloc(4);
  private prefixUsed = 0;
  private payload: Buffer | undefined;
  private used = 0;

  /** Feed owned pipe bytes; callbacks run only for whole valid UTF-8/JSON frames within the cap. */
  push(chunk: Buffer, receive: (reply: SqliteReply) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const n = Math.min(4 - this.prefixUsed, chunk.length - offset);
        chunk.copy(this.prefix, this.prefixUsed, offset, offset + n);
        this.prefixUsed += n;
        offset += n;
        if (this.prefixUsed !== 4) return;
        const length = this.prefix.readUInt32BE();
        if (!length || length > MAX_SQLITE_REPLY_BYTES)
          throw sqliteProtocolError();
        this.payload = Buffer.alloc(length);
        this.used = 0;
      }
      const n = Math.min(
        this.payload.length - this.used,
        chunk.length - offset,
      );
      chunk.copy(this.payload, this.used, offset, offset + n);
      this.used += n;
      offset += n;
      if (this.used !== this.payload.length) return;
      let raw: unknown;
      try {
        raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(this.payload),
        );
      } catch {
        throw sqliteProtocolError();
      }
      const parsed = sqliteReplySchema.safeParse(raw);
      if (!parsed.success) throw sqliteProtocolError();
      this.payload = undefined;
      this.prefixUsed = 0;
      this.used = 0;
      receive(parsed.data);
    }
  }

  /** Require a frame boundary at normal exit; partial output never counts as a completed read. */
  finish(): void {
    if (this.prefixUsed || this.payload) throw sqliteProtocolError();
  }
}

/** Bound encoded requests before handing bytes to the pipe; declarations and bindings already have structural caps. */
export function sqliteRequestFrame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (!bytes.length || bytes.length > MAX_SQLITE_REQUEST_BYTES)
    throw new RuntimeError(
      "SQLITE_LIMIT",
      "The native database request exceeded its frame limit.",
      413,
    );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}

/** Recompute declared projection, original typed key, fingerprint and exact cost rather than trusting a helper's accounting. */
export function decodeRows(
  reply: Extract<SqliteReply, { kind: "rows" }>,
  definition: SqliteDefinition,
  queryId: string,
  maxRows: number,
  maxBytes: number,
): readonly SqliteRow[] {
  const query = definition.queries.find((q) => q.id === queryId);
  const table = definition.tables.find((t) => t.name === query?.table);
  if (!query || !table || reply.rows.length > maxRows || reply.bytes > maxBytes)
    throw sqliteProtocolError();
  let bytes = 0;
  const identities = new Set<string>();
  const rows = reply.rows.map((row) => {
    if (
      row.table !== table.name ||
      Object.keys(row.values).length !== query.columns.length ||
      query.columns.some((name) => !Object.hasOwn(row.values, name))
    )
      throw sqliteProtocolError();
    const values = Object.fromEntries(
      Object.entries(row.values).map(([name, value]) => [
        name,
        decodeCell(value),
      ]),
    );
    const key = table.primaryKey.map((column) => {
      const value = values[column];
      if (value === undefined || value === null || value instanceof Uint8Array)
        throw sqliteProtocolError();
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
    const encodedKey = JSON.stringify(key);
    if (encodedKey !== JSON.stringify(row.key) || identities.has(encodedKey))
      throw sqliteProtocolError();
    identities.add(encodedKey);
    const encoded = JSON.stringify(
      query.columns.map((column) => [
        column,
        taggedSqliteValue(values[column]!),
      ]),
    );
    const fingerprint = createHash("sha256").update(encoded).digest("hex");
    if (fingerprint !== row.fingerprint) throw sqliteProtocolError();
    bytes +=
      Buffer.byteLength(encoded) +
      Buffer.byteLength(JSON.stringify({ table: row.table, key, fingerprint }));
    if (bytes > maxBytes) throw sqliteProtocolError();
    return Object.freeze({
      values: Object.freeze(values),
      table: row.table,
      key: Object.freeze(key),
      fingerprint,
    });
  });
  if (bytes !== reply.bytes) throw sqliteProtocolError();
  return Object.freeze(rows);
}
