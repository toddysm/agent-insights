/**
 * Shared contracts for an acknowledged analysis of an already-normalized read.
 *
 * Readers supply evidence; application-owned operations supply interpretation
 * instructions; a provider executes those instructions. These are separate
 * responsibilities: using Copilot CLI as a provider does not select CLI history
 * as the evidence source. VS Code Copilot Chat is the first planned source.
 *
 * Zod schemas run at browser/server boundaries. TypeScript interfaces describe
 * internal collaborators and are erased during compilation. This module performs
 * no source reads, authentication, process creation, model calls or persistence.
 */
import { z } from "zod";
import { evidenceIdSchema, referenceSchema } from "../evidence/contracts.js";

/** Maximum combined UTF-8 bytes of trusted instructions and serialized selected evidence. */
export const ANALYSIS_INPUT_LIMIT = 64 * 1024;
/** Maximum UTF-8 bytes of model response text accepted before parsing its JSON. */
export const ANALYSIS_OUTPUT_LIMIT = 128 * 1024;
/** Disclosure version explicitly acknowledged by the user for an analysis start. */
export const ANALYSIS_ACKNOWLEDGEMENT = "remote-processing-v1";
const id = evidenceIdSchema;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Browser control message selecting one session from the displayed read.
 * It carries identifiers and acknowledgement, not capture uploads or arbitrary
 * instructions. The runner separately verifies current-generation membership,
 * the installed operation and availability of selected evidence.
 */
export const analysisRequestSchema = z.strictObject({
  readId: id,
  sessionId: id,
  operationId: id,
  acknowledgement: z.literal(ANALYSIS_ACKNOWLEDGEMENT),
});
/** Structurally validated start request; semantic selection checks remain the runner's responsibility. */
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;

/**
 * Reported usage of the analysis itself, separate from usage in captured evidence.
 * Input/output are nonnegative safe integers or null when unavailable. A model
 * may be known even without usage events; unresolved or mixed identity stays null.
 * These fields do not represent a locally estimated token count or a billing guarantee.
 */
export const analysisUsageSchema = z.strictObject({
  input: count.nullable(),
  output: count.nullable(),
  model: z.string().nullable(),
});
/** Detached usage snapshot delivered by the provider; null is not measured zero. */
export type AnalysisUsage = z.infer<typeof analysisUsageSchema>;

/**
 * Common shape required of model-generated JSON before operation-specific checks.
 * Source identifiers retain the evidence contract's exact values. This schema
 * cannot establish that a cited event belongs to the selection; the runner checks
 * identity, uniqueness and membership before attaching original source references.
 */
export const modelResultSchema = z.strictObject({
  readId: id,
  sessionId: id,
  operationId: id,
  eventIds: z.array(id).min(1).max(512),
  data: z.json(),
});

/**
 * Public snapshot of the single current run, including its progress or terminal state.
 * Wall-clock timestamps use Unix epoch milliseconds. The runner controls lifecycle
 * consistency, clears results on cancellation/invalidation and sanitizes failures.
 * Shape validation here is not proof of successful execution or correct interpretation.
 */
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
/** Current in-memory run snapshot; its identifier is not a durable job-history key. */
export type AnalysisRun = z.infer<typeof analysisRunSchema>;

/**
 * Trusted analysis definition registered by application code, never by a capture
 * file or browser request. A definition pairs a task's instructions with its result
 * contract; this transport layer does not itself define task counts or prompt scores.
 * Callers must keep registered definitions stable for the runner's lifetime.
 */
export interface AnalysisOperation {
  /** Nonempty unique key used in the control request and echoed result envelope. */
  readonly id: string;
  /** Human-readable selection label; not the instructions sent to the model. */
  readonly label: string;
  /** Trusted operation instructions appended after the common evidence-handling rules. */
  readonly instructions: string;
  /** Validates/transforms the data field; its accepted output must also be JSON-serializable. */
  readonly resultSchema: z.ZodType;
}

/**
 * Prepared provider input held only in memory. The runner applies the combined
 * input-byte limit before dispatch; callers bypassing the runner must uphold that
 * selection, consent and size contract themselves.
 */
export interface ProviderInput {
  /** Application-authored system instructions, not instructions discovered in source content. */
  readonly system: string;
  /** Serialized selected evidence and provenance, treated by the model as untrusted data. */
  readonly prompt: string;
}

/**
 * Run-scoped control and notifications supplied to a provider.
 * Callbacks must not throw, initiate another run or persist sensitive data.
 * The runner ignores updates from an invalidated or terminal run.
 */
export interface ProviderCallbacks {
  /** Aborted on user cancellation, source invalidation or the runner's deadline. */
  readonly signal: AbortSignal;
  /** Reports transport milestones; it must not contain prompt or response fragments. */
  readonly progress: (stage: "connecting" | "running") => void;
  /** Reports analysis-only usage/model snapshots; unavailable components remain null. */
  readonly usage: (usage: AnalysisUsage) => void;
}

/**
 * Execution boundary shared by the real Copilot adapter and controlled test doubles.
 * A provider may own processes and operational metadata, but not a persistent corpus
 * of session evidence. Failed cleanup must retain ownership for a later close call.
 */
export interface AnalysisProvider {
  /**
   * Inspect installation compatibility without sending evidence or creating an analysis.
   * @returns Availability, detected version or null, and a user-facing explanation.
   */
  status(): Promise<{
    available: boolean;
    version: string | null;
    reason: string;
  }>;
  /**
   * Execute one already-authorized input and release owned resources before success.
   * @param input - Bounded, selected evidence and trusted instructions prepared by the caller.
   * @param callbacks - Cancellation signal and payload-free progress/usage observers.
   * @returns Raw response text for the runner to validate; rejects on execution or cleanup failure.
   */
  analyze(input: ProviderInput, callbacks: ProviderCallbacks): Promise<string>;
  /**
   * Stop/remove any resources retained by this provider, including a failed prior cleanup.
   * @returns Resolves only when cleanup is confirmed; rejects while ownership must be retained.
   */
  close(): Promise<void>;
}
