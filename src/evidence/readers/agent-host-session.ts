/**
 * Compose conversation and execution evidence for one authoritative Agent Host chat.
 * History framing and catalog qualification happen once; no unrelated sessions,
 * input files or overlapping usage scopes are merged by this adapter.
 */
import { parseReadView, type ReadView } from "../contracts.js";
import type { MultiSourceInput, MultiSourceReader } from "../source-access.js";
import { readNativeHistory } from "./agent-host-history.js";
import { resolveAgentHostOwnership } from "./agent-host-catalog.js";
import { readAgentHostConversation } from "./agent-host-conversation.js";
import {
  agentHostExecutionReader,
  readAgentHostExecution,
} from "./agent-host-execution.js";

/** Discovery cannot enable unreleased helper features or bypass the existing production gate. */
export const agentHostUnavailableReason =
  "Copilot Agent Host reading requires a separately qualified native helper release with guarded JSON and literal-prefix predicates; the pinned native-helper-v0.1.0 is incompatible.";

/**
 * Borrow a single parsed history/catalog decision for both evidence dimensions.
 * Every input retains original anchors; conversation coverage never asserts execution
 * completeness. Underlying access, schema-budget and cancellation failures reject.
 */
async function read(input: MultiSourceInput): Promise<ReadView> {
  const history = await readNativeHistory(
    input.get("history"),
    input.readId,
    input.signal,
  );
  const catalog = input.get("catalog");
  const ownership =
    history.start && catalog.available && catalog.kind === "sqlite"
      ? await resolveAgentHostOwnership(
          catalog,
          String(history.start.data.sessionId),
          input.signal,
        )
      : null;
  const conversation = await readAgentHostConversation(
    input,
    history,
    ownership,
  );
  const execution = await readAgentHostExecution(input, history, ownership);
  const issues = new Map(
    [...conversation.issues, ...execution.issues].map((issue) => [
      JSON.stringify(issue),
      issue,
    ]),
  );
  return parseReadView({
    ...execution,
    startedAtMs: Math.min(conversation.startedAtMs, execution.startedAtMs),
    finishedAtMs: Math.max(conversation.finishedAtMs, execution.finishedAtMs),
    sources: execution.sources.map((source) => ({
      ...source,
      coverage: {
        ...source.coverage,
        messages:
          conversation.sources.find((item) => item.id === source.id)?.coverage
            .messages ?? source.coverage.messages,
      },
    })),
    events: [...conversation.events, ...execution.events],
    issues: [...issues.values()],
  });
}

/** Required history/catalog are revalidated on open; an unavailable overlay does not erase retained native evidence. */
export const agentHostSessionReader: MultiSourceReader = Object.freeze({
  id: "agent-host-sessions",
  inputs: agentHostExecutionReader.inputs.map((input) => ({
    ...input,
    optional: input.key === "overlay",
  })),
  read,
});
