/** Synthetic analysis definitions and readers for tests only; never registered in the shipped runtime. */
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

/** Fixed synthetic output contract, deliberately unrelated to task counts or prompt ratings. */
export const syntheticOperation: AnalysisOperation = {
  id: "synthetic",
  label: "Synthetic analysis",
  instructions:
    'Return data {"answer":"synthetic"} with selected event references.',
  resultSchema: z.strictObject({ answer: z.string() }),
};

/** Echo only validated selection identifiers, preserving the common result envelope. */
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

/** Deterministic mock transport with explicit analysis-only usage, not a real Copilot connection. */
export const syntheticProvider: AnalysisProvider = {
  /** No external resources are owned by the synthetic transport. */
  async close() {},
  async status() {
    return { available: true, version: "synthetic", reason: "Test provider." };
  },
  async analyze(input, callbacks) {
    callbacks.progress("running");
    callbacks.usage({ input: 7, output: 3, model: "synthetic" });
    return syntheticResponse(input);
  },
};

/** Bind a fictional fixture to the granted source/read identity; this does not parse capture bytes. */
export const syntheticReader: EvidenceReader = {
  format: "vscode-otel-jsonl",
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
