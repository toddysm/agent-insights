/**
 * Code-owned multi-source reader declarations and borrowed access contracts.
 * These declare bounded file/database inputs, not executable SQL from a browser
 * or capture. Domain readers still own normalization, identity and accounting.
 */
import { z } from "zod";
import type { ReadView } from "./contracts.js";

/** Declared adapter targets; an identifier alone does not install or qualify a parser. */
export const sourceFormatSchema = z.enum([
  "vscode-otel-jsonl",
  "vscode-chat-v3-json",
  "vscode-chat-mutations-jsonl",
  "copilot-sdk-events-jsonl",
  "vscode-agenthost-catalog-sqlite",
  "vscode-agenthost-session-sqlite",
]);

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const identifiers = z
  .array(identifier)
  .min(1)
  .max(64)
  .refine((values) => new Set(values).size === values.length);

/** An original SQLite key preserves integer/real/text identity without unsafe integer conversion. */
export const sqliteKeySchema = z
  .array(
    z
      .strictObject({
        column: identifier,
        type: z.enum(["integer", "real", "text"]),
        value: z.string(),
      })
      .readonly(),
  )
  .min(1)
  .max(16)
  .refine(
    (parts) => new Set(parts.map((part) => part.column)).size === parts.length,
  )
  .readonly();

/** A table must have the declared primary key; views, virtual/generated tables are not admitted. */
const tableSchema = z
  .strictObject({
    name: identifier,
    columns: identifiers.readonly(),
    primaryKey: identifiers.max(16).readonly(),
  })
  .readonly();

/** Equality filters use placeholders; optional JSON paths contain identifiers/indices, never SQL. */
const filterSchema = z
  .strictObject({
    column: identifier,
    parameter: identifier,
    jsonPath: z
      .array(z.union([identifier, z.number().int().nonnegative().max(10000)]))
      .min(1)
      .max(16)
      .readonly()
      .optional(),
  })
  .readonly();

/** Named SELECT projections over declared tables, with no arbitrary SQL or caller-provided identifiers. */
const querySchema = z
  .strictObject({
    id: identifier,
    table: identifier,
    columns: identifiers.readonly(),
    filters: z.array(filterSchema).max(16).readonly(),
  })
  .readonly();

/** Trusted adapter declarations validated before any source is opened. */
export const sqliteDefinitionSchema = z
  .strictObject({
    userVersions: z
      .array(z.number().int().nonnegative().max(2147483647))
      .min(1)
      .max(32)
      .readonly(),
    tables: z.array(tableSchema).min(1).max(32).readonly(),
    queries: z.array(querySchema).min(1).max(64).readonly(),
  })
  .superRefine((definition, context) => {
    const tables = new Map(
      definition.tables.map((table) => [table.name, table]),
    );
    if (
      tables.size !== definition.tables.length ||
      new Set(definition.queries.map((query) => query.id)).size !==
        definition.queries.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate table or query declaration",
      });
    for (const table of definition.tables) {
      if (table.primaryKey.some((key) => !table.columns.includes(key)))
        context.addIssue({
          code: "custom",
          message: "Primary key must be declared",
        });
    }
    for (const query of definition.queries) {
      const table = tables.get(query.table);
      if (
        !table ||
        query.columns.some((column) => !table.columns.includes(column)) ||
        query.filters.some(
          (filter) => !table.columns.includes(filter.column),
        ) ||
        table.primaryKey.some((key) => !query.columns.includes(key))
      )
        context.addIssue({
          code: "custom",
          message:
            "Query must use declared columns and preserve its primary key",
        });
    }
  })
  .readonly();

/** Immutable schema and SELECT declarations supplied only by application code. */
export type SqliteDefinition = z.infer<typeof sqliteDefinitionSchema>;
/** Primitive SQLite values; integers remain bigint until a domain reader validates their semantics. */
export type SqliteValue =
  string | number | bigint | Uint8Array<ArrayBuffer> | null;
/** Named bindings cannot replace SQL, table names or selected columns. */
export type SqliteBindings = Readonly<Record<string, SqliteValue>>;

/** A source row and its original key/content fingerprint, retained only for this read. */
export interface SqliteRow {
  readonly values: Readonly<Record<string, SqliteValue>>;
  readonly table: string;
  readonly key: z.infer<typeof sqliteKeySchema>;
  readonly fingerprint: string;
}

/** Code-owned roles distinguish independent files even when they share one directory grant. */
export const sourceRequirementSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      key: identifier,
      kind: z.literal("file"),
      format: sourceFormatSchema,
      optional: z.boolean().optional(),
    })
    .readonly(),
  z
    .strictObject({
      key: identifier,
      kind: z.literal("sqlite"),
      format: sourceFormatSchema,
      optional: z.boolean().optional(),
      database: sqliteDefinitionSchema,
    })
    .readonly(),
]);
/** A trusted adapter's required/optional source role, not a user-selected schema definition. */
export type SourceRequirement = z.infer<typeof sourceRequirementSchema>;

/** Observation bounds are per input, never a global atomic snapshot or processing completion. */
export const sourceObservationSchema = z
  .strictObject({
    sourceId: z.string().min(1),
    kind: z.enum(["file", "sqlite"]),
    startedAtMs: z.number().nonnegative(),
    finishedAtMs: z.number().nonnegative(),
    changed: z.boolean(),
    available: z.boolean(),
    userVersion: z.number().int().nonnegative().optional(),
    snapshotScope: z.enum(["connection", "request"]).optional(),
  })
  .refine((value) => value.finishedAtMs >= value.startedAtMs)
  .readonly();
/** Runtime-owned source observation, distinct from recorded event timestamps. */
export type SourceObservation = z.infer<typeof sourceObservationSchema>;

/** A missing optional input is explicit and must not contribute fabricated evidence. */
export interface UnavailableInput {
  readonly available: false;
  readonly sourceId: string;
  readonly code: string;
  readonly reason: string;
}
/** Borrowed file bytes from a bounded capture; the reader may not persist them. */
export interface FileInput {
  readonly available: true;
  readonly kind: "file";
  readonly sourceId: string;
  readonly bytes: AsyncIterable<Uint8Array>;
}
/** Borrowed transaction access; the runtime owns process/connection lifetime. */
export interface SqliteInput {
  readonly available: true;
  readonly kind: "sqlite";
  readonly sourceId: string;
  readonly userVersion: number;
  readonly snapshotScope: "connection" | "request";
  /**
   * Run a named code-owned projection. WAL retains a connection snapshot;
   * rollback-mode calls each use a bounded transaction and can observe different commits.
   * @param queryId - Registered query name; not SQL.
   * @param bindings - Exact named parameters required by that query.
   * @returns Bounded original rows; rejects on invalid bindings, limits, cancellation or source/schema failure.
   */
  query(
    queryId: string,
    bindings: SqliteBindings,
  ): Promise<readonly SqliteRow[]>;
}
/** Current input access, with missing optional data distinguished from successful emptiness. */
export type SourceInput = UnavailableInput | FileInput | SqliteInput;

/** One read generation; only declared and explicitly authorized roles are accessible. */
export interface MultiSourceInput {
  readonly readId: string;
  readonly signal: AbortSignal;
  /** Return the declared role or reject an unknown role; no filesystem lookup is implied. */
  get(key: string): SourceInput;
}

/** Shared-source adapter extension point. No production parser is installed by declaring this interface. */
export interface MultiSourceReader {
  readonly id: string;
  readonly inputs: readonly SourceRequirement[];
  /** Normalize borrowed inputs; preserve every declared source and its original references. */
  read(input: MultiSourceInput): Promise<ReadView>;
}
