/**
 * Shared test doubles for exercising the analysis path before real VS Code readers
 * and interpretation definitions are registered.
 *
 * All content and usage are fictional. The declared VS Code trace format only
 * exercises registration/routing; syntheticReader does not parse those bytes.
 * Production startup imports none of these definitions into its registries.
 */
import { z } from "zod";
import {
  parseReadView,
  type EvidenceReader,
} from "../../src/evidence/contracts.js";
import type {
  AnalysisOperation,
  AnalysisProvider,
  ProviderInput,
} from "../../src/analysis/contracts.js";
import { exampleReadView } from "./read-view.js";

/**
 * Test-only instruction/validation pair returning a fixed answer object.
 * It tests transport/result handling, not task completion, steering or prompt ratings.
 */
export const syntheticOperation: AnalysisOperation = {
  id: "synthetic",
  label: "Synthetic analysis",
  instructions:
    'Return data {"answer":"synthetic"} with selected event references.',
  resultSchema: z.strictObject({ answer: z.string() }),
};

/**
 * Build a deterministic fake model response for a runner-prepared input.
 * @param input - Its JSON prompt must contain readId, sessionId and operationId.
 * @returns JSON text echoing those identifiers and citing the known fixture message.
 * Invalid fixture JSON/identifiers throw; no provider or source filesystem is used.
 */
export function syntheticResponse(input: ProviderInput): string {
  const selection = z
    .object({
      readId: z.string(),
      sessionId: z.string(),
      operationId: z.string(),
    })
    .parse(JSON.parse(input.prompt));
  return JSON.stringify({
    ...selection,
    eventIds: ["message-fixture"],
    data: { answer: "synthetic" },
  });
}

/**
 * Immediate in-memory provider for control/result tests.
 * Reported token counts and model identity are synthetic values, not measurements
 * of either a real provider call or the captured subject session.
 */
export const syntheticProvider: AnalysisProvider = {
  /** Resolve immediately: this fake owns no process, connection or filesystem resource. */
  async close() {},
  /** Resolve as available for test UI routing, not as proof that Copilot is installed. */
  async status() {
    return { available: true, version: "synthetic", reason: "Test provider." };
  },
  /**
   * Return a fixture response while exercising the runner's notification path.
   * @param input - Runner-prepared JSON selection to echo in the result.
   * @param callbacks - Receives fixed progress/usage; this immediate fake has no external work to cancel.
   * @returns Synthetic response text, or rejects if fixture construction fails.
   */
  async analyze(input, callbacks) {
    callbacks.progress("running");
    callbacks.usage({ input: 7, output: 3, model: "synthetic" });
    return syntheticResponse(input);
  },
};

/**
 * Registration-only fake reader for the VS Code trace format.
 * It binds fictional normalized events to a source grant/read identity without
 * consuming input.bytes. It must never be advertised as real capture support.
 */
export const syntheticReader: EvidenceReader = {
  format: "vscode-otel-jsonl",
  /**
   * Construct a fresh immutable fixture for this read generation.
   * @param input - Supplies readId and sourceId for all fixture references; capture bytes are unused.
   * @returns Structurally validated fictional evidence; invalid fixture identity rejects.
   */
  async read(input) {
    const view = exampleReadView();
    return parseReadView({
      ...view,
      id: input.readId,
      sources: view.sources.map((source) => ({
        ...source,
        id: input.sourceId,
      })),
      sessions: view.sessions.map((session) => ({
        ...session,
        sourceIds: [input.sourceId],
        references: session.references.map((reference) => ({
          ...reference,
          sourceId: input.sourceId,
        })),
      })),
      events: view.events.map((event) => ({
        ...event,
        references: event.references.map((reference) => ({
          ...reference,
          sourceId: input.sourceId,
        })),
      })),
      issues: view.issues.map((issue) => ({
        ...issue,
        sourceId: input.sourceId,
      })),
    });
  },
};
