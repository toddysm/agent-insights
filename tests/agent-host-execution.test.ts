/**
 * Independently authored native lifecycle/usage fixtures, not captured sessions.
 * The native-target case uses owned synthetic WAL databases and the verified candidate;
 * ordinary application checks exercise normalization and the fail-closed production gate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentHostExecutionReader } from "../src/evidence/readers/agent-host-execution.js";
import type { NativeExecution } from "../src/evidence/readers/agent-host-events.js";
import type { ReadView } from "../src/evidence/contracts.js";
import { productionReaders, productionMultiSourceReaders } from "../src/evidence/readers/index.js";
import type { MultiSourceInput, SqliteRow } from "../src/evidence/source-access.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { RuntimeService } from "../src/runtime/service.js";
import { SourceAccess } from "../src/runtime/sources.js";
import { statusSchema } from "../src/runtime/protocol.js";
import { testNativeHelper } from "./fixtures/native-helper.js";

/** Fictional envelope defaults; overrides deliberately damage typed source fields. */
function event(type: string, id: string, data: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) {
  return { id, type, data, parentId: "start", timestamp: "2026-11-03T10:00:00.001Z", ...fields };
}

/** Pin format and emitted runtime separately from the SDK npm package version. */
function start() {
  return event("session.start", "start", {
    sessionId: "sdk-synthetic", version: 1, producer: "copilot-agent",
    copilotVersion: "1.0.103-unstable.r41379698026.g3219c66",
  }, { parentId: null });
}

/** Original projection-shaped witnesses; native integration verifies actual runtime fingerprints. */
function row(table: string, values: SqliteRow["values"]): SqliteRow {
  const column = table === "chats_v2" ? "chat_uri" : table === "turns" ? "id"
    : table === "turn_usage" ? "turn_id" : table === "session_metadata" || table === "metadata" ? "key" : "session_uri";
  return {
    table, values, key: [{ column, type: "text", value: String(values[column]) }],
    fingerprint: createHash("sha256").update(JSON.stringify(values, (_key, value: unknown) =>
      typeof value === "bigint" ? String(value) : value)).digest("hex"),
  };
}

/** Minimal normalized schema-22 catalog with no runtime/storage translation. */
function catalogRows(): SqliteRow[] {
  return [
    row("chats_v2", {
      chat_uri: "copilotcli:/owner/chat", owner_session_uri: "copilotcli:/owner",
      storage_resource: "copilotcli:/sdk-synthetic", provider_data: '{"sdkSessionId":"sdk-synthetic"}',
      parent_chat: null, tombstoned: 0n, archived: 0n, origin_session_uri: null,
    }),
    row("sessions_v2", {
      session_uri: "copilotcli:/owner", provider: "copilotcli", session_generation: "g1",
      verified: 1n, is_chat_backing: 0n,
    }),
    row("session_chat_catalogs", {
      session_uri: "copilotcli:/owner", authority_version: 2n, session_generation: "g1",
      revision: 1n, projected_revision: 1n,
    }),
  ];
}

/** Borrow synthetic chunked bytes and declared projections; unexpected queries fail the test. */
function input(records: readonly unknown[], options: {
  catalogMissing?: boolean; overlay?: SqliteRow[]; overlayVersion?: number; snapshot?: "request" | "connection";
  raw?: string; signal?: AbortSignal;
} = {}): MultiSourceInput {
  const bytes = Buffer.from(options.raw ?? records.map((value) => JSON.stringify(value)).join("\n") + "\n");
  return {
    readId: "synthetic", signal: options.signal ?? new AbortController().signal,
    get(key) {
      const sourceId = `synthetic:${key}`;
      if (key === "history") return {
        available: true, kind: "file", sourceId,
        bytes: { async *[Symbol.asyncIterator]() {
          for (let offset = 0; offset < bytes.length; offset += 19) yield bytes.subarray(offset, offset + 19);
        } },
      };
      assert.ok(key === "catalog" || key === "overlay");
      if ((key === "catalog" && options.catalogMissing) || (key === "overlay" && !options.overlay))
        return { available: false, sourceId, code: "SOURCE_MISSING", reason: "Synthetic absent role." };
      return {
        available: true, kind: "sqlite", sourceId,
        userVersion: key === "catalog" ? 22 : options.overlayVersion ?? 18,
        snapshotScope: key === "overlay" ? options.snapshot ?? "connection" : "connection",
        query(query, bindings) {
          if (key === "overlay") {
            assert.ok(["metadata", "turns", "usage"].includes(query));
            const table = query === "metadata" ? "session_metadata" : query === "usage" ? "turn_usage" : "turns";
            return Promise.resolve((options.overlay ?? []).filter((item) => item.table === table &&
              (query === "metadata" ? item.values.key === bindings.key : query === "usage" ? item.values.turn_id === bindings.turn : true)));
          }
          const table = query === "sdk_chats" ? "chats_v2" : query === "owner" ? "sessions_v2"
            : query === "authority" ? "session_chat_catalogs" : null;
          assert.ok(table || ["session_backed_chats", "storage_identity", "metadata_key"].includes(query));
          return Promise.resolve(table ? catalogRows().filter((item) => item.table === table) : []);
        },
      };
    },
  };
}

/** Narrow the span/boundary union without treating a message as execution-shaped evidence. */
function executions(view: ReadView): NativeExecution[] {
  return view.events.filter((item): item is NativeExecution => item.kind !== "message");
}

test("native tools pair within agent scope, retain parallel/nested edges and never invent model calls", async () => {
  const first = event("tool.execution_start", "s1", {
    toolCallId: "same-call", toolName: "read", arguments: { path: "not-opened" }, turnId: "loop",
  });
  const view = await agentHostExecutionReader.read(input([
    start(), event("assistant.turn_start", "ts", { turnId: "loop" }),
    first, first,
    event("tool.execution_start", "cs", { toolCallId: "same-call", toolName: "child-read", parentToolCallId: "parent-call" }, { agentId: "child" }),
    event("tool.execution_complete", "ce", { toolCallId: "same-call", success: false, result: { content: "<script>data</script>" } }, { agentId: "child", timestamp: "2026-11-03T10:00:00.003Z" }),
    event("tool.execution_complete", "e1", { toolCallId: "same-call", success: true, result: { content: "captured" } }, { timestamp: "2026-11-03T10:00:00.002Z" }),
    event("assistant.turn_end", "te", { turnId: "loop" }),
    event("model.call_finished", "ephemeral", { inputTokens: 999 }),
  ]));
  assert.equal(view.sessions.length, 1);
  assert.deepEqual(view.events.map((item) => item.kind), ["assistant-turn", "tool-call", "tool-call"]);
  const tools = executions(view).filter((item) => item.kind === "tool-call");
  assert.equal(tools[0]?.status, "ok");
  assert.equal(tools[0]?.references.length, 3);
  assert.equal(tools[0]?.content?.toolArguments, '{"path":"not-opened"}');
  assert.equal(tools[1]?.content?.toolResult, "<script>data</script>");
  assert.equal(tools[1]?.status, "error");
  assert.equal(tools[1]?.nativeExecution?.agentId, "child");
  assert.equal(tools[1]?.nativeExecution?.parentToolCallId, "parent-call");
  assert.ok(tools[1]?.nativeIdentities?.some((identity) => identity.namespace === "copilot-sdk-agent" && identity.value === "child"));
  assert.equal(tools[0]?.startedAtMs, 1793700000001);
  assert.equal(tools[0]?.endedAtMs, 1793700000002);
  assert.equal(view.events[0]?.kind === "assistant-turn" ? view.events[0].status : null, "unknown");
  assert.ok(view.events.every((item) => item.kind !== "model-call" && item.kind !== "message" && item.usage === null));
  assert.ok(view.issues.some((issue) => issue.code === "unknown-record"));
  assert.equal(view.sources[0]?.identity.executionHost, "agent-host");
  assert.equal(view.sources[0]?.coverage.tokens.status, "unavailable");
});

test("optional native session identity pairs lifecycle boundaries without merging other or malformed sessions", async () => {
  for (const explicitStart of [true, false]) {
    const declared = { sessionId: "sdk-synthetic" };
    const first = explicitStart ? declared : {};
    const last = explicitStart ? {} : declared;
    const view = await agentHostExecutionReader.read(input([
      start(),
      event("tool.execution_start", "tool-s", { ...first, toolCallId: "task", toolName: "task" }),
      event("tool.execution_complete", "tool-e", { ...last, toolCallId: "task", success: true }),
      event("assistant.turn_start", "turn-s", { ...first, turnId: "turn" }),
      event("assistant.turn_end", "turn-e", { ...last, turnId: "turn" }),
      event("subagent.started", "agent-s", { ...last, toolCallId: "task", agentName: "worker" }, { agentId: "child" }),
      event("subagent.completed", "agent-e", { ...first, toolCallId: "task" }, { agentId: "child" }),
    ]));
    assert.equal(view.events.length, 3);
    assert.ok(executions(view).every((item) => item.nativeExecution?.completeness === "complete" &&
      item.sessionId === view.sessions[0]?.id && item.references.length === 2));
    assert.equal(executions(view).find((item) => item.kind === "tool-call")?.nativeExecution?.accounting, "bridge-wrapper");
  }
  for (const sessionId of ["other-sdk", null, 7]) {
    const view = await agentHostExecutionReader.read(input([
      start(),
      event("tool.execution_start", "s", { toolCallId: "same", toolName: "read" }),
      event("tool.execution_complete", "e", { sessionId, toolCallId: "same", success: true }),
    ]));
    assert.equal(view.events.length, 2);
    assert.ok(executions(view).every((item) => item.nativeExecution?.completeness !== "complete"));
    assert.ok(view.events.some((item) => item.sessionId === null));
  }
});

test("optional native session identity groups output chunks once without rescuing other or malformed sessions", async () => {
  for (const sessionId of ["sdk-synthetic", "other-sdk", null, 7]) {
    for (const explicitFirst of [true, false]) {
      const declared = { sessionId };
      const view = await agentHostExecutionReader.read(input([
        start(),
        event("assistant.message", "chunk-0", { ...(explicitFirst ? declared : {}), apiCallId: "api", chunkIndex: 0, chunkCount: 2, outputTokens: 7 }),
        event("assistant.message", "chunk-1", { ...(explicitFirst ? {} : declared), apiCallId: "api", chunkIndex: 1, chunkCount: 2, outputTokens: 7 }),
      ]));
      const observations = executions(view).filter((item) => item.observation?.scope === "assistant-output");
      if (sessionId === "sdk-synthetic") {
        assert.equal(observations.length, 1);
        assert.equal(observations[0]?.usage?.output, 7);
        assert.equal(observations[0]?.references.length, 2);
      } else assert.equal(observations.length, 0);
    }
  }
  const repeated = await agentHostExecutionReader.read(input([
    start(),
    event("assistant.message", "first", { apiCallId: "same", outputTokens: 7 }),
    event("assistant.message", "second", { sessionId: "sdk-synthetic", apiCallId: "same", outputTokens: 7 }),
  ]));
  assert.equal(repeated.events.length, 0);
  assert.ok(repeated.issues.some((issue) => issue.message.includes("conflicting API/chunk")));
});

test("subagent lifecycle distinguishes its unique task wrapper, cancellation and parent task identity", async () => {
  const view = await agentHostExecutionReader.read(input([
    start(),
    event("tool.execution_start", "task-start", { toolCallId: "task-call", toolName: "task" }),
    event("subagent.started", "agent-start", { toolCallId: "task-call", agentName: "worker" }, { agentId: "child" }),
    event("subagent.completed", "agent-end", { toolCallId: "task-call", agentName: "worker", cancelled: true }, { agentId: "child" }),
    event("tool.execution_complete", "task-end", { toolCallId: "task-call", success: true }),
  ]));
  const wrapper = executions(view).find((item) => item.kind === "tool-call");
  const agent = executions(view).find((item) => item.kind === "agent-span");
  assert.equal(wrapper?.nativeExecution?.accounting, "bridge-wrapper");
  assert.equal(agent?.nativeExecution?.accounting, "execution");
  assert.equal(agent?.nativeExecution?.parentAgentTaskId, null);
  assert.equal(agent?.nativeExecution?.cancelled, true);
  assert.equal(agent?.status, "unknown");
  assert.equal(agent?.usage, null);
});

test("completion-only subagent parent metadata never establishes a root wrapper", async () => {
  for (const parentId of ["parent-task", null, 7]) {
    const view = await agentHostExecutionReader.read(input([
      start(),
      event("tool.execution_start", "tool-s", { toolCallId: "task", toolName: "task" }),
      event("subagent.started", "agent-s", { toolCallId: "task", agentName: "worker" }, { agentId: "child" }),
      event("subagent.completed", "agent-e", { toolCallId: "task", parentId }, { agentId: "child" }),
      event("tool.execution_complete", "tool-e", { toolCallId: "task", success: true }),
    ]));
    const tool = executions(view).find((item) => item.kind === "tool-call");
    const agent = executions(view).find((item) => item.kind === "agent-span");
    assert.equal(tool?.nativeExecution?.accounting, "ambiguous");
    assert.equal(agent?.nativeExecution?.parentAgentTaskId, typeof parentId === "string" ? parentId : null);
    assert.ok(view.issues.some((issue) => issue.message.includes("non-additive")));
  }
});

test("foreign sessions and other tool-agent scopes cannot change qualified root accounting", async () => {
  const tool = [
    event("tool.execution_start", "root-s", { toolCallId: "shared", toolName: "task" }),
    event("tool.execution_complete", "root-e", { toolCallId: "shared", success: true }),
  ];
  const agent = [
    event("subagent.started", "child-s", { toolCallId: "shared", agentName: "worker" }, { agentId: "child" }),
    event("subagent.completed", "child-e", { toolCallId: "shared" }, { agentId: "child" }),
  ];
  for (const sessionId of ["other-sdk", null, 7]) {
    const view = await agentHostExecutionReader.read(input([
      start(), ...tool, ...agent.map((record) => ({ ...record, data: { ...record.data, sessionId } })),
    ]));
    const root = executions(view).find((item) => item.kind === "tool-call" && item.sessionId !== null);
    assert.equal(root?.nativeExecution?.accounting, "execution");
  }
  for (const scope of [{ sessionId: "other-sdk" }, { agentId: "unrelated-child" }]) {
    const view = await agentHostExecutionReader.read(input([
      start(), ...tool, ...agent,
      event("tool.execution_start", "unrelated-s", { toolCallId: "shared", toolName: "read", ...("sessionId" in scope ? scope : {}) }, "agentId" in scope ? scope : {}),
      event("tool.execution_complete", "unrelated-e", { toolCallId: "shared", success: true, ...("sessionId" in scope ? scope : {}) }, "agentId" in scope ? scope : {}),
    ]));
    const root = executions(view).find((item) => item.kind === "tool-call" &&
      item.sessionId !== null && item.nativeExecution?.agentId === null);
    assert.equal(root?.nativeExecution?.accounting, "bridge-wrapper");
  }
  const invalidAgent = await agentHostExecutionReader.read(input([
    start(), ...tool,
    event("subagent.started", "invalid-agent", { toolCallId: "shared", agentName: "worker" }, { agentId: 7 }),
  ]));
  assert.equal(executions(invalidAgent).find((item) => item.kind === "tool-call")?.nativeExecution?.accounting, "ambiguous");
});

test("conflicting subagent replays remain scoped negative wrapper witnesses without completion", async () => {
  for (const sessionId of ["sdk-synthetic", "other-sdk"]) {
    const conflicting = event("subagent.started", "replayed-agent", {
      sessionId, toolCallId: "shared", agentName: "first",
    }, { agentId: "child" });
    const view = await agentHostExecutionReader.read(input([
      start(),
      event("tool.execution_start", "tool-s", { toolCallId: "shared", toolName: "task" }),
      event("tool.execution_complete", "tool-e", { toolCallId: "shared", success: true }),
      conflicting, { ...conflicting, data: { ...conflicting.data, agentName: "conflicting" } },
    ]));
    const tool = executions(view).find((item) => item.kind === "tool-call");
    assert.equal(tool?.nativeExecution?.accounting, sessionId === "sdk-synthetic" ? "ambiguous" : "execution");
    assert.equal(executions(view).filter((item) => item.kind === "agent-span").length, 0);
    assert.ok(view.issues.some((issue) => issue.code === "ambiguous-session" && issue.references?.length));
  }
});

test("invalid optional relationships do not erase independently qualified session assignment", async () => {
  for (const relationship of ["parentToolCallId", "turnId"]) {
    for (const [first, last] of [[7, undefined], [null, undefined], ["first", "different"]]) {
      for (const subagent of [false, true]) {
        const scope = subagent ? { agentId: "child" } : {};
        const view = await agentHostExecutionReader.read(input([
          start(),
          event(subagent ? "subagent.started" : "tool.execution_start", "s", {
            sessionId: "sdk-synthetic", toolCallId: "call", [subagent ? "agentName" : "toolName"]: "worker", [relationship]: first,
          }, scope),
          event(subagent ? "subagent.completed" : "tool.execution_complete", "e", {
            toolCallId: "call", success: true, [relationship]: last,
          }, scope),
        ]));
        assert.equal(view.events.length, 1);
        const execution = executions(view)[0];
        assert.equal(execution?.sessionId, view.sessions[0]?.id);
        assert.equal(execution?.status, "ok");
        assert.equal(relationship === "turnId" ? execution?.nativeExecution?.turnId : execution?.nativeExecution?.parentToolCallId, null);
        assert.ok(view.issues.some((issue) => issue.code === "unsupported-schema"));
      }
    }
  }
});

test("nested native ID collisions do not classify an unrelated tool as another agent's wrapper", async () => {
  const view = await agentHostExecutionReader.read(input([
    start(),
    event("tool.execution_start", "tool", { toolCallId: "shared", toolName: "task" }, { agentId: "unrelated" }),
    event("subagent.started", "child", { toolCallId: "shared", agentName: "worker", parentId: "parent-task" }, { agentId: "new-child" }),
  ]));
  const tool = executions(view).find((item) => item.kind === "tool-call");
  const agent = executions(view).find((item) => item.kind === "agent-span");
  assert.equal(tool?.nativeExecution?.accounting, "ambiguous");
  assert.equal(agent?.nativeExecution?.parentAgentTaskId, "parent-task");
  assert.ok(view.issues.some((issue) => issue.message.includes("non-additive")));
});

test("interrupted, malformed and reversed lifecycles retain nulls and original diagnostics", async () => {
  const view = await agentHostExecutionReader.read(input([
    start(),
    event("tool.execution_start", "only-start", { toolCallId: "open", toolName: "read" }, { timestamp: "2026-02-30T00:00:00Z", parentId: "outside" }),
    event("tool.execution_complete", "only-end", { toolCallId: "orphan", success: "true" }),
    event("tool.execution_start", "reverse-s", { toolCallId: "reverse" }, { timestamp: "2026-11-03T10:00:00.004Z" }),
    event("tool.execution_complete", "reverse-e", { toolCallId: "reverse", success: false }),
  ]));
  const open = executions(view).find((item) => item.nativeId === "open");
  const orphan = executions(view).find((item) => item.nativeId === "orphan");
  const reverse = executions(view).find((item) => item.nativeId === "reverse");
  assert.equal(open?.kind === "tool-call" ? open.startedAtMs : 0, null);
  assert.equal(open?.nativeExecution?.completeness, "missing-completion");
  assert.equal(orphan?.nativeExecution?.completeness, "missing-start");
  assert.equal(orphan?.status, "unknown");
  assert.equal(reverse?.kind === "tool-call" ? reverse.startedAtMs : 0, null);
  assert.equal(reverse?.kind === "tool-call" ? reverse.endedAtMs : 0, null);
  assert.ok(view.issues.some((issue) => issue.message.includes("predecessor")));
  assert.ok(view.issues.some((issue) => issue.code === "unsupported-schema"));
  assert.ok(view.issues.filter((issue) => issue.references).every((issue) =>
    issue.references?.every((ref) => ref.sourceId === issue.sourceId)));
});

test("conflicting replay variants poison every affected call and logical duplicate starts", async () => {
  const original = event("tool.execution_start", "conflict", { toolCallId: "a", toolName: "read" });
  const view = await agentHostExecutionReader.read(input([
    start(), original, { ...original, data: { toolCallId: "b", toolName: "read" } },
    event("tool.execution_complete", "a-end", { toolCallId: "a", success: true }),
    event("tool.execution_complete", "b-end", { toolCallId: "b", success: true }),
    event("tool.execution_start", "c-1", { toolCallId: "c", toolName: "read" }),
    event("tool.execution_start", "c-2", { toolCallId: "c", toolName: "write" }),
  ]));
  assert.equal(view.events.length, 0);
  assert.ok(view.issues.some((issue) => issue.code === "ambiguous-session"));
});

test("unassigned SDK executions keep per-event namespaces; unsupported native versions never fall back", async () => {
  const records = [start(), event("tool.execution_start", "s", { toolCallId: "call", toolName: "read" }, { agentId: "child" })];
  const view = await agentHostExecutionReader.read(input(records, { catalogMissing: true }));
  assert.equal(view.sessions.length, 0);
  assert.equal(view.events.length, 1);
  assert.equal(view.events[0]?.sessionId, null);
  assert.ok(view.events[0]?.kind !== "message" && view.events[0]?.nativeIdentities?.some((identity) =>
    identity.namespace === "copilot-sdk-session" && identity.value === "sdk-synthetic"));
  assert.equal(view.sources[0]?.identity.executionHost, "unknown");
  const unsupported = start(); unsupported.data.version = 2;
  const rejected = await agentHostExecutionReader.read(input([unsupported, records[1]]));
  assert.equal(rejected.events.length, 0);
  assert.ok(rejected.issues.some((issue) => issue.code === "unsupported-schema"));
});

test("output-only native usage and session snapshots remain non-additive, not model spans or gauges", async () => {
  const view = await agentHostExecutionReader.read(input([
    start(),
    event("assistant.message", "chunk-0", { apiCallId: "api", messageId: "m0", chunkIndex: 0, chunkCount: 2, outputTokens: 7 }),
    event("assistant.message", "chunk-1", { apiCallId: "api", messageId: "m1", chunkIndex: 1, chunkCount: 2, outputTokens: 7 }),
    event("assistant.message", "missing-api", { outputTokens: 100 }),
    event("session.shutdown", "shutdown", {
      currentTokens: 100000, inputTokens: 100000,
      modelMetrics: { "model/a~b": { usage: { inputTokens: 20, outputTokens: 10 } } },
    }),
  ]));
  const observations = executions(view).filter((item) => item.kind === "usage-observation");
  assert.equal(observations.length, 2);
  assert.ok(observations.every((item) => item.observation?.additive === false && item.usage?.basis !== "per-call"));
  const output = observations.find((item) => item.observation?.scope === "assistant-output");
  assert.equal(output?.usage?.input, null);
  assert.equal(output?.usage?.output, 7);
  assert.equal(output?.references.length, 2);
  assert.equal(observations.find((item) => item.observation?.scope === "session-snapshot")?.usage?.input, 20);
  assert.ok(observations.some((item) => item.references.some((ref) => ref.location.pointer === "/data/modelMetrics/model~1a~0b/usage")));
  assert.equal(view.sources[0]?.coverage.tokens.status, "partial");
});

test("counterless sibling messages cannot bypass usage-bearing API group validation", async () => {
  for (const chunkCount of [2, 3]) {
    for (const counterlessFirst of [true, false]) {
      const sibling = event("assistant.message", "counterless", { apiCallId: "api", chunkIndex: 0, chunkCount });
      const chunks = [
        event("assistant.message", "chunk-0", { apiCallId: "api", chunkIndex: 0, chunkCount: 2, outputTokens: 7 }),
        event("assistant.message", "chunk-1", { apiCallId: "api", chunkIndex: 1, chunkCount: 2, outputTokens: 7 }),
      ];
      const view = await agentHostExecutionReader.read(input([
        start(), ...(counterlessFirst ? [sibling, ...chunks] : [...chunks, sibling]),
      ]));
      assert.equal(view.events.length, 0);
      const diagnostic = view.issues.find((issue) => issue.message.includes("conflicting API/chunk"));
      assert.equal(diagnostic?.references?.length, 3);
    }
  }
  const noUsage = await agentHostExecutionReader.read(input([
    start(), event("assistant.message", "plain", { apiCallId: "api", content: "no usage report" }),
  ]));
  assert.equal(noUsage.events.length, 0);
  assert.ok(noUsage.issues.every((issue) => !issue.message.includes("API/chunk")));
});

test("conflicting API aliases, missing chunks and transient usage cannot rescue another response group", async () => {
  const first = event("assistant.message", "conflict", { apiCallId: "api-a", messageId: "m", outputTokens: 7 });
  const view = await agentHostExecutionReader.read(input([
    start(), first, { ...first, data: { apiCallId: "api-b", messageId: "m", outputTokens: 7 } },
    event("assistant.message", "other", { apiCallId: "api-b", messageId: "other", outputTokens: 7 }),
    event("assistant.message", "missing-chunk", { apiCallId: "incomplete", messageId: "last", chunkIndex: 1, chunkCount: 2, outputTokens: 5 }),
    event("assistant.message", "transient", { apiCallId: "transient-api", outputTokens: 10 }, { ephemeral: true }),
    event("session.shutdown", "bad-shutdown", { modelMetrics: { model: { usage: { inputTokens: 99, outputTokens: 99 } } } }, { agentId: "child" }),
  ]));
  assert.equal(view.events.length, 0);
  assert.ok(view.issues.filter((issue) => issue.code === "unsupported-schema").length >= 3);
});

test("reported contradictory native session identity stays unassigned without losing either namespace", async () => {
  const view = await agentHostExecutionReader.read(input([
    start(),
    event("tool.execution_start", "s", { sessionId: "other-sdk", toolCallId: "call", toolName: "read" }),
    event("tool.execution_complete", "e", { sessionId: "other-sdk", toolCallId: "call", success: true }),
    event("assistant.message", "output", { sessionId: "other-sdk", apiCallId: "api", outputTokens: 1 }),
  ]));
  assert.equal(view.events.length, 2);
  assert.ok(view.events.every((item) => item.sessionId === null));
  for (const item of executions(view))
    for (const value of ["sdk-synthetic", "other-sdk"])
      assert.ok(item.nativeIdentities?.some((identity) => identity.namespace === "copilot-sdk-session" && identity.value === value));
});

test("malformed optional native metadata stays diagnosed rather than silently defaulted", async () => {
  const sourceStart = start();
  const view = await agentHostExecutionReader.read(input([
    { ...sourceStart, data: { ...sourceStart.data, detachedFromSpawningParentSessionId: 7 } },
    event("assistant.message", "output", { apiCallId: "api", outputTokens: 1, model: 4 }),
  ]));
  assert.equal(view.sessions[0]?.parentNativeId, null);
  const output = executions(view).find((item) => item.kind === "usage-observation");
  assert.equal(output?.observation?.model, null);
  assert.equal(output?.usage?.input, null);
  assert.equal(view.issues.filter((issue) => issue.code === "unsupported-schema").length, 2);
});

/** Replacement-style overlay rows bridge a host turn to the native root user event, not an assistant loop turn. */
function overlayRows(): SqliteRow[] {
  return [
    row("session_metadata", { key: "agentHost.rowOwnerChat", value: "copilotcli:/owner/chat" }),
    row("turns", { id: "host-turn", event_id: "user-event" }),
    row("turn_usage", { turn_id: "host-turn", usage: JSON.stringify({
      inputTokens: 999999, outputTokens: 0,
      _meta: {
        turnTokenTotals: [{ model: "model", inputTokens: 30, cachedTokens: 5, outputTokens: 12 }],
        directTurnTokenTotals: [{ model: "model", inputTokens: 20, cachedTokens: 3, outputTokens: 8 }],
      },
    }) }),
  ];
}

test("retained whole/direct turn reports preserve overlap and exact multi-source row/field anchors", async () => {
  const view = await agentHostExecutionReader.read(input([
    start(), event("user.message", "user-event", { content: "fictional" }),
    event("assistant.turn_start", "loop-event", { turnId: "unrelated-loop" }),
  ], { overlay: overlayRows() }));
  const observations = executions(view).filter((item) => item.kind === "usage-observation");
  assert.deepEqual(observations.map((item) => item.observation?.scope), ["turn-inclusive", "turn-direct"]);
  assert.deepEqual(observations.map((item) => item.usage?.input), [30, 20]);
  assert.ok(observations.every((item) => item.startedAtMs === null && item.nativeId === "host-turn"));
  assert.ok(observations.every((item) => item.references.some((ref) => ref.location.kind === "sqlite" &&
    ref.location.table === "turn_usage" && ref.location.column === "usage" && ref.location.pointer.startsWith("/_meta/"))));
  assert.ok(observations.every((item) => item.references.some((ref) => ref.location.kind === "jsonl" && ref.location.line === 2)));
  assert.ok(observations.every((item) => item.nativeIdentities?.some((identity) =>
    identity.namespace === "agent-host-turn" && identity.value === "host-turn")));
});

test("overlay ownership, foreign rows, duplicate bridges, malformed counters and request snapshots fail honestly", async () => {
  const records = [start(), event("user.message", "user-event", { content: "fictional" })];
  for (const overlay of [
    [row("turns", { id: "orphan", event_id: null })],
    [row("session_metadata", { key: "agentHost.rowOwnerChat", value: "another-chat" }), ...overlayRows().slice(1)],
    [row("session_metadata", { key: "agentHost.foreignTurnIds", value: "{bad" }), ...overlayRows()],
    [row("session_metadata", { key: "agentHost.foreignTurnIds", value: '["host-turn"]' }), ...overlayRows()],
    [...overlayRows(), row("turns", { id: "other", event_id: "user-event" })],
    [...overlayRows().slice(0, 2), row("turn_usage", { turn_id: "host-turn", usage: '{"_meta":{"turnTokenTotals":[{"model":"m","inputTokens":-1,"cachedTokens":0,"outputTokens":0}]}}' })],
    [...overlayRows().slice(0, 2), row("turn_usage", { turn_id: "host-turn", usage: '{"inputTokens":999,"outputTokens":0}' })],
  ]) {
    const view = await agentHostExecutionReader.read(input(records, { overlay }));
    assert.ok(view.events.every((item) => item.kind !== "usage-observation"));
    assert.equal(view.sources[2]?.coverage.tokens.status, "unavailable");
  }
  for (const options of [{ overlayVersion: 19 }, { snapshot: "request" as const }]) {
    const view = await agentHostExecutionReader.read(input(records, { overlay: overlayRows(), ...options }));
    assert.ok(view.events.every((item) => item.kind !== "usage-observation"));
    assert.ok(view.issues.some((issue) => issue.code === "unsupported-schema"));
  }
  for (const rootEvent of [
    event("user.message", "user-event", {}, { ephemeral: true }),
    event("user.message", "user-event", { sessionId: "another-sdk" }),
  ]) {
    const view = await agentHostExecutionReader.read(input([start(), rootEvent], { overlay: overlayRows() }));
    assert.ok(view.events.every((item) => item.kind !== "usage-observation"));
    assert.ok(view.issues.some((issue) => issue.sourceId === "synthetic:overlay" && issue.code === "ambiguous-session"));
    assert.ok(view.issues.some((issue) => issue.sourceId === "synthetic:history" && issue.code === "ambiguous-session"));
  }
});

test("native reads reject cancellation, damaged tails and source changes without a fabricated successful view", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(agentHostExecutionReader.read(input([start()], { signal: controller.signal })), { name: "AbortError" });
  const broken = input([start()]);
  await assert.rejects(agentHostExecutionReader.read({
    ...broken,
    get(key) {
      const selected = broken.get(key);
      return selected.available && selected.kind === "sqlite"
        ? { ...selected, query() { return Promise.reject(new RuntimeError("SOURCE_CHANGED", "Synthetic change.", 409)); } }
        : selected;
    },
  }), { code: "SOURCE_CHANGED" });
  const partial = await agentHostExecutionReader.read(input([], { raw: JSON.stringify(start()) + "\n{\"broken" }));
  assert.ok(partial.issues.some((issue) => issue.code === "truncated-record"));
  await assert.rejects(agentHostExecutionReader.read(input([], {
    raw: JSON.stringify(start()) + "\n" + " ".repeat(256 * 1024 + 1),
  })), { code: "READ_LIMIT" });
});

test("ordinary startup registers executions as explicitly unavailable before source admission", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-insights-execution-gate-"));
  const service = new RuntimeService(
    await SourceAccess.create([root]),
    { sources: [root], port: 0, harness: "copilot", model: null, copilotPath: path.join(root, "never-run") },
    productionReaders, 30000, null, productionMultiSourceReaders,
  );
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const status = statusSchema.parse(await service.status());
  const reader = status.multiSourceReaders.find((item) => item.id === "agent-host-executions");
  assert.equal(reader?.available, false);
  assert.match(reader?.reason ?? "", /native-helper-v0.1.0/);
  assert.ok(reader);
  await assert.rejects(service.readSet({
    readerId: "agent-host-executions",
    sources: reader.inputs.map((role) => ({ key: role.key, sourceId: "source-1", relativePath: "not-opened" })),
  }, new AbortController().signal), { code: "READER_UNAVAILABLE" });
  assert.deepEqual(await readdir(root), []);
  assert.equal(service.view, null);
});

test("verified native candidate exercises read/refresh/original evidence and preserves synthetic source bytes", {
  skip: !process.env.AGENT_INSIGHTS_TEST_NATIVE_ROOT,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-insights-execution-native-"));
  const catalog = new DatabaseSync(path.join(root, "catalog.db"));
  const overlay = new DatabaseSync(path.join(root, "overlay.db"));
  const file = path.join(root, "events.jsonl");
  const service = new RuntimeService(
    await SourceAccess.create([root]),
    { sources: [root], port: 0, harness: "copilot", model: null, copilotPath: path.join(root, "no-model") },
    [], 30000, null, [agentHostExecutionReader], testNativeHelper,
  );
  t.after(async () => { await service.close(); catalog.close(); overlay.close(); await rm(root, { recursive: true, force: true }); });
  catalog.exec(`
    PRAGMA journal_mode=WAL; PRAGMA user_version=22;
    CREATE TABLE chats_v2(chat_uri TEXT PRIMARY KEY NOT NULL, owner_session_uri TEXT, storage_resource TEXT, parent_chat TEXT, provider_data TEXT, tombstoned, archived, origin_session_uri TEXT);
    CREATE TABLE sessions_v2(session_uri TEXT PRIMARY KEY NOT NULL, provider TEXT, session_generation TEXT, verified, is_chat_backing);
    CREATE TABLE session_chat_catalogs(session_uri TEXT PRIMARY KEY NOT NULL, authority_version, session_generation TEXT, revision, projected_revision);
    CREATE TABLE metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT);
  `);
  overlay.exec(`
    PRAGMA journal_mode=WAL; PRAGMA user_version=18;
    CREATE TABLE turns(id TEXT PRIMARY KEY NOT NULL, event_id TEXT);
    CREATE TABLE turn_usage(turn_id TEXT PRIMARY KEY NOT NULL, usage TEXT NOT NULL);
    CREATE TABLE session_metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT);
  `);
  for (const [database, rows] of [[catalog, catalogRows()], [overlay, overlayRows()]] as const) {
    for (const original of rows) {
      const names = Object.keys(original.values);
      database.prepare(`INSERT INTO ${original.table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
        .run(...Object.values(original.values));
    }
  }
  await writeFile(file, [start(), event("user.message", "user-event", { content: "fictional" }),
    event("tool.execution_start", "s", { toolCallId: "call", toolName: "read", arguments: { command: "never-execute" } }),
    event("tool.execution_complete", "e", { toolCallId: "call", success: true, result: { content: "fictional-output" } }),
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const files = (await readdir(root)).sort();
  const immutable = files.filter((name) => !name.endsWith("-shm"));
  const bytes = await Promise.all(immutable.map((name) => readFile(path.join(root, name))));
  const selection = {
    readerId: "agent-host-executions",
    sources: [
      { key: "history", sourceId: "source-1", relativePath: "events.jsonl" },
      { key: "catalog", sourceId: "source-1", relativePath: "catalog.db" },
      { key: "overlay", sourceId: "source-1", relativePath: "overlay.db" },
    ],
  };
  const first = await service.readSet(selection, new AbortController().signal);
  assert.equal(first.events.filter((item) => item.kind === "tool-call").length, 1);
  assert.equal(first.events.filter((item) => item.kind === "usage-observation").length, 2);
  const refreshed = await service.readSet(selection, new AbortController().signal);
  assert.notEqual(refreshed.id, first.id);
  assert.equal(service.view?.id, refreshed.id);
  assert.equal(first.events[0]?.nativeId, refreshed.events[0]?.nativeId);
  assert.ok(first.events.some((item) => item.references.some((ref) => ref.location.kind === "sqlite" && ref.location.fingerprint.length === 64)));
  assert.deepEqual((await readdir(root)).sort(), files);
  assert.deepEqual(await Promise.all(immutable.map((name) => readFile(path.join(root, name)))), bytes);
});
