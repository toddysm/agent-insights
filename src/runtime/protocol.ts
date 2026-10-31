/** Shared browser/server envelopes; settings and status are not a persisted session catalog. */
import { z } from "zod";
import { sourceFormatSchema } from "../evidence/contracts.js";
import { analysisRunSchema } from "../analysis/contracts.js";

/** Explicitly available/unavailable configured location; paths are returned only after authentication. */
export const locationSchema = z.strictObject({
  id: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory", "unknown"]),
  available: z.boolean(),
  reason: z.string().nullable(),
});

/** Installation status and the current in-memory run/result; polling never starts model analysis. */
export const statusSchema = z.strictObject({
  checkedAtMs: z.number(),
  sources: z.array(locationSchema),
  readers: z.array(sourceFormatSchema),
  hasReadView: z.boolean(),
  readTiming: z
    .strictObject({
      readId: z.string(),
      inputStartedAtMs: z.number(),
      inputFinishedAtMs: z.number(),
      finishedAtMs: z.number(),
    })
    .readonly()
    .nullable(),
  analysis: z.strictObject({
    harness: z.literal("copilot"),
    requestedModel: z.string().nullable(),
    available: z.boolean(),
    version: z.string().nullable(),
    remoteProcessing: z.literal(true),
    reason: z.string(),
    operations: z.array(z.strictObject({ id: z.string(), label: z.string() })),
    run: analysisRunSchema.nullable(),
  }),
});

/** Browser status returned from an authenticated metadata request. */
export type RuntimeStatus = z.infer<typeof statusSchema>;
/** Input observation bounds are distinct from completion of adapter processing. */
export type ReadTiming = NonNullable<RuntimeStatus["readTiming"]>;
/** Configured source status, not proof of capture-format compatibility. */
export type SourceLocation = z.infer<typeof locationSchema>;

/** A read selects a configured grant and a path inside it, never an arbitrary absolute path. */
export const readRequestSchema = z.strictObject({
  sourceId: z.string().min(1),
  relativePath: z
    .string()
    .max(4096)
    .refine((value) => !value.includes("\0")),
  format: sourceFormatSchema,
});

/** Validated source selection passed to the source boundary. */
export type ReadRequest = z.infer<typeof readRequestSchema>;

/** Public failures contain controlled messages, never raw exceptions or captured payloads. */
export const errorSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});
