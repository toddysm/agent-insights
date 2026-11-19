/**
 * Validate the recorded-report transport independently of source access and calculation.
 * The browser receives definitions and original contributors, never a saved report.
 */
import { z } from "zod";
import {
  evidenceIdSchema,
  metricSchema,
  referenceSchema,
  coverageSchema,
  sourceSchema,
} from "../evidence/contracts.js";
import { STREAM_LIMITS, detailPageSchema } from "../evidence/streaming.js";

/** A report always names the exact current read and a session within it. */
export const reportRequestSchema = z.strictObject({
  readId: evidenceIdSchema,
  sessionId: evidenceIdSchema,
});

/** Relationship counts describe normalized records; associated usage is not added to direct metrics. */
const contributionsSchema = z.strictObject({
  directEvents: z.number().int().nonnegative(),
  associatedEvents: z.number().int().nonnegative(),
});

/** Display metadata cannot change a calculator's value, coverage or attribution. */
const measurementSchema = z
  .strictObject({
    id: z.string().min(1),
    label: z.string().min(1),
    group: z.enum(["Timing", "Tools", "Recorded tokens", "Usage observations"]),
    display: z.enum(["duration", "timestamp", "number"]),
    metric: metricSchema,
    contributorEventIds: z.array(evidenceIdSchema).readonly(),
    scope: z
      .strictObject({
        sessionId: evidenceIdSchema,
        kind: z.enum(["session", "events"]),
        eventIds: z.array(evidenceIdSchema).readonly(),
      })
      .readonly(),
    definition: z.string().min(1),
  })
  .readonly();

/** One recomputed session report; non-additive usage stays visibly separate. */
export const sessionReportSchema = z
  .strictObject({
    readId: evidenceIdSchema,
    sessionId: evidenceIdSchema,
    contributions: contributionsSchema,
    measurements: z.array(measurementSchema).readonly(),
    exclusions: z
      .array(
        z
          .strictObject({
            eventIds: z.array(evidenceIdSchema).readonly(),
            reason: z.string().min(1),
            references: z.array(referenceSchema).readonly(),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();

/** Validated session-only selection; no inferred task scope is accepted. */
export type ReportRequest = z.infer<typeof reportRequestSchema>;
/** Current-read report shared by the runtime and read-only interface. */
export type SessionReport = z.infer<typeof sessionReportSchema>;
/** A clickable measurement whose definition and contributors remain inspectable. */
export type ReportMeasurement = SessionReport["measurements"][number];

/** A selected session in an admitted scan, never the currently displayed evidence page. */
export const scanReportRequestSchema = z.strictObject({
  id: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(128),
});
export type ScanReportRequest = z.infer<typeof scanReportRequestSchema>;

/** Server-owned measurement IDs bind original-contributor cursors to their exact calculation scope. */
export const scanMetricRequestSchema = scanReportRequestSchema.extend({
  metricId: z.string().min(1).max(128),
  cursor: z.string().max(2048).nullable().default(null),
});
export type ScanMetricRequest = z.infer<typeof scanMetricRequestSchema>;

/** Witnesses explain measured zero or unavailable usage; they are not additive contributions. */
const evidenceKindSchema = z.enum(["contributors", "coverage-witnesses"]);

/**
 * Bounded numeric projection of the existing calculator. Original anchors and event
 * lists stay runtime-local; every measurement resolves through verified physical pages.
 */
export const scanReportSchema = z.strictObject({
  id: z.string(),
  sessionId: z.string(),
  contributions: contributionsSchema,
  source: sourceSchema,
  admittedBytes: z.number().int().nonnegative(),
  prefixSha256: z.string().regex(/^[a-f0-9]{64}$/),
  observedAtMs: z.number().int().nonnegative(),
  appended: z.boolean(),
  issues: z.array(z.string()),
  measurements: z
    .array(
      measurementSchema
        .unwrap()
        .omit({
          metric: true,
          contributorEventIds: true,
          scope: true,
        })
        .extend({
          value: z
            .number()
            .finite()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .nullable(),
          unit: z.enum(["milliseconds", "tokens", "count"]),
          coverage: coverageSchema,
          scope: z.enum(["session", "events"]),
          evidenceKind: evidenceKindSchema,
        })
        .refine(
          (entry) =>
            (entry.value === null) ===
              (entry.coverage.status === "unavailable") &&
            (entry.value === null ||
              entry.unit === "milliseconds" ||
              Number.isSafeInteger(entry.value)),
          "Coverage and numeric value must agree; tokens and counts must be safe integers.",
        ),
    )
    .max(STREAM_LIMITS.reportMeasurements),
});
export type ScanReport = z.infer<typeof scanReportSchema>;

/** One replace-only physical page; replay occurrences never add again to the report totals. */
export const scanMetricPageSchema = detailPageSchema.extend({
  sessionId: z.string(),
  metricId: z.string(),
  evidenceKind: evidenceKindSchema,
});
export type ScanMetricPage = z.infer<typeof scanMetricPageSchema>;
