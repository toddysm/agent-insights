/**
 * Validate the recorded-report transport independently of source access and calculation.
 * The browser receives definitions and original contributors, never a saved report.
 */
import { z } from "zod";
import {
  evidenceIdSchema,
  metricSchema,
  referenceSchema,
} from "../evidence/contracts.js";

/** A report always names the exact current read and a session within it. */
export const reportRequestSchema = z.strictObject({
  readId: evidenceIdSchema,
  sessionId: evidenceIdSchema,
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
