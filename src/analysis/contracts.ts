/** Transient analysis protocol, independent of source readers and individual interpretation prompts. */
import { z } from "zod";
import { referenceSchema } from "../evidence/contracts.js";

export const ANALYSIS_INPUT_LIMIT = 64 * 1024;
export const ANALYSIS_OUTPUT_LIMIT = 128 * 1024;
export const ANALYSIS_ACKNOWLEDGEMENT = "remote-processing-v1";
const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A user authorizes one operation on one session from the currently displayed read. */
export const analysisRequestSchema = z.strictObject({
  readId: id,
  sessionId: id,
  operationId: id,
  acknowledgement: z.literal(ANALYSIS_ACKNOWLEDGEMENT),
});
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;

/** Usage belongs to this analysis, never to the subject session; missing values remain null. */
export const analysisUsageSchema = z.strictObject({
  input: count.nullable(),
  output: count.nullable(),
  model: z.string().nullable(),
});
export type AnalysisUsage = z.infer<typeof analysisUsageSchema>;

/** All model output remains a judgment and must cite selected event identities. */
export const modelResultSchema = z.strictObject({
  readId: id,
  sessionId: id,
  operationId: id,
  eventIds: z.array(id).min(1).max(512),
  data: z.json(),
});

/** At most one current run/result; no job history or persistent result identifiers. */
export const analysisRunSchema = z.strictObject({
  id,
  readId: id,
  sessionId: id,
  operationId: id,
  state: z.enum(["running", "succeeded", "failed", "cancelled"]),
  stage: z.enum([
    "preparing",
    "connecting",
    "running",
    "validating",
    "finished",
  ]),
  startedAtMs: count,
  finishedAtMs: count.nullable(),
  usage: analysisUsageSchema,
  result: z
    .strictObject({
      data: z.json(),
      eventIds: z.array(id),
      references: z.array(referenceSchema),
    })
    .nullable(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
});
export type AnalysisRun = z.infer<typeof analysisRunSchema>;

/** Only application-owned definitions can supply instructions or validate domain-specific data. */
export interface AnalysisOperation {
  readonly id: string;
  readonly label: string;
  readonly instructions: string;
  readonly resultSchema: z.ZodType;
}

/** A prepared prompt contains only the explicitly selected session and trusted instructions. */
export interface ProviderInput {
  readonly system: string;
  readonly prompt: string;
}

/** Callbacks expose stages and reported usage, not raw model output or diagnostics. */
export interface ProviderCallbacks {
  readonly signal: AbortSignal;
  readonly progress: (stage: "connecting" | "running") => void;
  readonly usage: (usage: AnalysisUsage) => void;
}

/** Injectable transport boundary; implementations must stop owned resources on cancellation. */
export interface AnalysisProvider {
  /** Inspect executable availability only; must not transmit evidence or connect to a model. */
  status(): Promise<{
    available: boolean;
    version: string | null;
    reason: string;
  }>;
  /** Run acknowledged, prepared input; stop owned resources when the signal aborts or the call settles. */
  analyze(input: ProviderInput, callbacks: ProviderCallbacks): Promise<string>;
  /** Retry cleanup of retained resources; reject until their termination/removal is confirmed. */
  close(): Promise<void>;
}
