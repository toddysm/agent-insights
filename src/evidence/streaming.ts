/** Bounded JSONL scan controls and payload-free browser contracts; no source access or model execution. */
import { z } from "zod";
import { classificationSchema, eventSchema } from "./contracts.js";

/** Separate memory/cardinality/response/work ceilings; file size is not a buffer allocation budget. */
export const STREAM_LIMITS = Object.freeze({
  chunkBytes: 64 * 1024,
  recordBytes: 256 * 1024,
  metadataBytes: 8 * 1024 * 1024,
  identities: 8192,
  references: 32768,
  pageRecords: 20,
  detailBytes: 512 * 1024,
  responseBytes: 1024 * 1024,
  workBytes: 8 * 1024 * 1024 * 1024,
  lifetimeMs: 15 * 60 * 1000,
});
/** Code-owned ceilings may only be lowered for boundary qualification, never configured through HTTP. */
export type StreamLimits = { readonly [K in keyof typeof STREAM_LIMITS]: number };

/** A deliberate stop, never a successful truncated catalog or exact zero. */
export class ScanBudgetExceeded extends Error {
  /** Signal an explicit unavailable/partial outcome; callers must not publish the discarded assembly. */
  constructor(readonly budget: "metadata" | "identities" | "references" | "detail" | "response" | "work" | "lifetime") {
    super(`The scan exceeded its ${budget} budget; results for this operation are unavailable.`);
    this.name = "ScanBudgetExceeded";
  }
}

/** Physical-record accounting is distinct from deduplicated execution classification. */
export interface ScanCounts {
  records: number;
  blank: number;
  malformed: number;
  incomplete: number;
  oversized: number;
  unknown: number;
  duplicates: number;
  executionRecords: number;
  unclassifiedRecords: number;
  metrics: number;
  logs: number;
  contentEvents: number;
}

/** Code-owned bounded normalization; only a first contributor anchor is retained per native identity. */
export interface OtelScanPolicy {
  readonly counts: ScanCounts;
  readonly maxMetadataBytes: number;
  readonly maxIdentities: number;
  readonly maxReferences: number;
  readonly maxRecordBytes: number;
  readonly onLine: (line: { byteOffset: number; byteLength: number; terminated: boolean }) => void;
}

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** One current generation's status; null totals mean unavailable, never measured zero. */
export const scanStatusSchema = z.strictObject({
  id: z.string(),
  sourceId: z.string(),
  phase: z.enum(["scanning", "complete", "partial", "budget-exceeded", "cancelled", "source-changed", "format-unsupported", "cleanup-failed", "failed"]),
  reason: z.string().nullable(),
  startedAtMs: integer,
  finishedAtMs: integer.nullable(),
  inputStartedAtMs: integer.nullable(),
  inputFinishedAtMs: integer.nullable(),
  sourceBytes: integer,
  admittedBytes: integer,
  scannedBytes: integer,
  workBytes: integer,
  pass: integer,
  passScannedBytes: integer,
  appended: z.boolean(),
  cleanupPending: z.boolean(),
  counts: z.strictObject({
    records: integer, blank: integer, malformed: integer, incomplete: integer,
    oversized: integer, unknown: integer, duplicates: integer,
    executionRecords: integer, unclassifiedRecords: integer,
    metrics: integer, logs: integer, contentEvents: integer,
  }),
  classification: classificationSchema.nullable(),
  sessions: integer.nullable(),
  unassigned: integer.nullable(),
});
/** Validated status transported without captured identifiers or payloads. */
export type ScanStatus = z.infer<typeof scanStatusSchema>;
/** A missing scan is distinct from an empty supported source. */
export const scanEnvelopeSchema = z.strictObject({ scan: scanStatusSchema.nullable() });

/** Only explicit grants and the installed format may start a scan; paths remain runtime-authorized. */
export const scanRequestSchema = z.strictObject({
  sourceId: z.string().min(1).max(64),
  relativePath: z.string().max(4096).refine((value) => !value.includes("\0")),
  format: z.literal("vscode-otel-jsonl"),
});
/** Immutable startup-grant selection, not an arbitrary filesystem locator. */
export type ScanRequest = z.infer<typeof scanRequestSchema>;

/** Generation-bound page request; only server-issued opaque cursors select subsequent pages. */
export const scanPageRequestSchema = z.strictObject({
  id: z.string().min(1).max(64),
  cursor: z.string().max(2048).nullable().default(null),
});
/** Selection applies only after complete-source correlation; null selects explicitly unassigned executions. */
export const detailRequestSchema = scanPageRequestSchema.extend({
  sessionId: z.string().min(1).max(128).nullable(),
  fromMs: integer.nullable().default(null),
  toMs: integer.nullable().default(null),
}).refine((value) => value.fromMs === null || value.toMs === null || value.fromMs <= value.toMs);
/** Validated selected contributor-page controls. */
export type DetailRequest = z.infer<typeof detailRequestSchema>;

/** Stable bounded session catalog, not event content or a complete report. */
export const catalogPageSchema = z.strictObject({
  id: z.string(),
  sessions: z.array(z.strictObject({ id: z.string(), executions: integer })).max(STREAM_LIMITS.pageRecords),
  unassigned: integer,
  next: z.string().nullable(),
});

/** Original physical contributors; duplicates are shown as evidence, never additional metric contributors. */
export const detailPageSchema = z.strictObject({
  id: z.string(),
  observedAtMs: integer,
  contributors: z.array(z.strictObject({
    event: eventSchema,
    byteOffset: integer,
    byteLength: integer,
    line: integer.positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })).max(STREAM_LIMITS.pageRecords),
  next: z.string().nullable(),
  scope: z.literal("original-contributors-not-additive-metrics"),
});
