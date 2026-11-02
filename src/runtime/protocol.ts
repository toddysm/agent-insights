/**
 * Browser/server control and status shapes for the loopback runtime.
 *
 * These schemas validate network envelopes, not raw harness capture formats.
 * Source locations, available readers and analysis-provider status are distinct:
 * a detected Copilot CLI executor does not imply that a VS Code capture reader
 * or interpretation definition is installed.
 *
 * Status may include the one current in-memory analysis result; it is not a
 * persistent catalog/history. Membership, consent and lifecycle checks also run
 * in the source service and analysis runner, beyond these structural schemas.
 */
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

/**
 * Authenticated status response: source availability, actual registered readers,
 * capture timing and analysis-provider/run information. Checking status does not
 * itself read capture content or start inference. Null timing/run fields denote
 * absence rather than a fabricated empty session or zero-valued analysis.
 */
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
