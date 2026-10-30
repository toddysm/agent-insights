/** Fictional evidence builder for contract tests; never reads a real capture. */
import { parseReadView, type ReadView } from "../../src/evidence/contracts.js";

/** Return a fresh immutable read containing a message and a model call with missing output usage. */
export function exampleReadView(): ReadView {
  return parseReadView({
    schemaVersion: 1,
    id: "read-fixture",
    startedAtMs: 1000,
    finishedAtMs: 1100,
    sources: [
      {
        id: "source-fixture",
        format: "vscode-otel-jsonl",
        identity: {
          producer: "synthetic",
          version: null,
          executionHost: "unknown",
        },
        changedDuringRead: false,
        coverage: {
          messages: { status: "complete" },
          timing: { status: "complete" },
          tools: { status: "complete" },
          tokens: {
            status: "partial",
            reason: "Output usage was not reported",
          },
        },
      },
    ],
    sessions: [
      {
        id: "session-fixture",
        nativeId: "native-session",
        sourceIds: ["source-fixture"],
        references: [
          {
            sourceId: "source-fixture",
            recordId: "session-header",
            location: { kind: "jsonl", line: 1, pointer: "/session" },
          },
        ],
      },
    ],
    events: [
      {
        id: "message-fixture",
        sessionId: "session-fixture",
        nativeId: "request-1",
        parentNativeId: null,
        references: [
          {
            sourceId: "source-fixture",
            recordId: "request-1",
            location: { kind: "jsonl", line: 1, pointer: "" },
          },
        ],
        kind: "message",
        role: "user",
        instructionId: "request-1",
        text: "Create a fictional example.",
        timestampMs: 900,
      },
      {
        id: "call-fixture",
        sessionId: "session-fixture",
        nativeId: "span-1",
        parentNativeId: "parent-outside-read",
        references: [
          {
            sourceId: "source-fixture",
            recordId: "span-1",
            location: { kind: "jsonl", line: 2, pointer: "" },
          },
        ],
        kind: "model-call",
        name: "fictional-model",
        startedAtMs: 910,
        endedAtMs: 950,
        status: "ok",
        usage: {
          basis: "per-call",
          input: 20,
          output: null,
          components: [
            { name: "cache-read", value: 5, relation: "subset-of-input" },
          ],
        },
      },
    ],
    issues: [
      {
        sourceId: "source-fixture",
        code: "missing-field",
        message: "Output usage was not reported",
      },
    ],
  });
}
