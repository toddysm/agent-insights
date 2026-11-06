/**
 * Verify execution normalization using independently authored fictional records.
 * No private captures, filesystem access or model invocation is used by these
 * tests; packaged CLI and browser integration separately verify registration.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { vscodeOtelReader } from "../src/evidence/readers/vscode-otel.js";
import { jsonLines } from "../src/evidence/readers/jsonl.js";
import {
  parseReadView,
  type ReaderInput,
  type ReadView,
} from "../src/evidence/contracts.js";

const trace = "1".repeat(32);
const otherTrace = "2".repeat(32);
const nativeSession = "fictional-session";

/**
 * Create a fictional exporter-shaped span; overrides deliberately allow invalid fixtures.
 * @param fields - Top-level fields replacing defaults, including malformed test values.
 * @param attributes - Attribute overrides; undefined values are omitted by JSON serialization.
 * @returns A fresh source object, not normalized evidence.
 */
function record(
  fields: Record<string, unknown> = {},
  attributes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    traceId: trace,
    spanId: "1".repeat(16),
    name: "chat fictional-model",
    kind: 2,
    startTime: [1760000000, 100000000],
    endTime: [1760000001, 200000000],
    duration: [1, 100000000],
    ended: true,
    status: { code: 1 },
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.conversation.id": nativeSession,
      "gen_ai.request.model": "fictional-model",
      "gen_ai.usage.input_tokens": 20,
      "gen_ai.usage.output_tokens": 5,
      ...attributes,
    },
    events: [],
    links: [],
    resource: { attributes: { "service.name": "fictional-producer" } },
    instrumentationScope: { name: "fictional" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...fields,
  };
}

/**
 * Borrow a fixture's bytes in controlled chunk sizes without copying capture files.
 * @param bytes - Fictional UTF-8 bytes, including intentionally malformed cases.
 * @param size - Positive chunk width used to split multibyte characters and line endings.
 */
async function* chunks(
  bytes: Uint8Array,
  size: number,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}

/**
 * Construct the same bounded-stream input shape used by the runtime.
 * @param text - Fixture text or explicit malformed bytes.
 * @param size - Chunk width in bytes, defaulting to 64.
 * @param signal - Optional caller-owned cancellation, otherwise a fresh active signal.
 */
function input(
  text: string | Uint8Array,
  size = 64,
  signal = new AbortController().signal,
): ReaderInput {
  const bytes =
    typeof text === "string" ? new TextEncoder().encode(text) : text;
  return {
    readId: "read-fictional",
    sourceId: "source-fictional",
    bytes: chunks(bytes, size),
    signal,
  };
}

/**
 * Parse JSON-serializable fictional lines through the production adapter.
 * @param records - Independent raw records in their source order.
 * @returns Validated immutable normalized evidence, with a conventional final newline.
 */
function read(records: readonly unknown[]): Promise<ReadView> {
  return vscodeOtelReader.read(
    input(records.map((value) => JSON.stringify(value)).join("\n") + "\n"),
  );
}

test("normalizes exact identity, time units, content, status and usage with original anchors", async () => {
  const original = record(
    {},
    {
      "gen_ai.input.messages":
        '[{"role":"user","content":"Fictional request"}]',
      "gen_ai.output.messages":
        '[{"role":"assistant","content":"Fictional answer"}]',
      "gen_ai.response.model": "fictional-effective",
    },
  );
  const view = await read([original]);
  const event = view.events[0];
  assert.ok(event && event.kind === "model-call");
  assert.equal(event.nativeId, "1".repeat(16));
  assert.equal(event.trace?.id, trace);
  assert.equal(event.startedAtMs, 1760000000100);
  assert.equal(event.endedAtMs, 1760000001200);
  assert.equal(event.status, "ok");
  assert.equal(event.model?.responded, "fictional-effective");
  assert.equal(event.usage?.basis, "per-call");
  assert.equal(event.usage.input, 20);
  assert.equal(event.usage.output, 5);
  assert.match(event.content?.inputMessages ?? "", /Fictional request/);
  assert.deepEqual(event.references[0], {
    sourceId: "source-fictional",
    recordId: `sha256:${createHash("sha256").update(JSON.stringify(original)).digest("hex")}`,
    location: { kind: "jsonl", line: 1, pointer: "" },
  });
  assert.ok(
    event.references.some(
      (ref) => ref.location.pointer === "/attributes/gen_ai.input.messages",
    ),
  );
  assert.equal(view.sessions[0]?.nativeId, nativeSession);
  assert.equal(view.sources[0]?.coverage.tokens.status, "complete");
  assert.equal(view.sources[0]?.coverage.messages.status, "unavailable");
  assert.equal(view.sources[0]?.changedDuringRead, null);
  assert.ok(Object.isFrozen(event.content));
});

test("explicit operations keep embeddings, hooks, tools and agent executions distinct", async () => {
  const operations = [
    "chat",
    "embeddings",
    "execute_tool",
    "invoke_agent",
    "execute_hook",
  ];
  const view = await read(
    operations.map((operation, index) =>
      record(
        {
          spanId: (index + 1).toString(16).padStart(16, "0"),
          name: "misleading execute_hook label",
        },
        {
          "gen_ai.operation.name": operation,
          "gen_ai.tool.name": "fictional_tool",
        },
      ),
    ),
  );
  assert.deepEqual(
    view.events.map((event) => event.kind),
    ["model-call", "model-call", "tool-call", "agent-span", "hook-execution"],
  );
  assert.deepEqual(
    view.events.map((event) => event.kind !== "message" && event.operation),
    operations,
  );
  assert.deepEqual(view.sources[0]?.classification?.executions, {
    modelCalls: 2,
    toolCalls: 1,
    agentSpans: 1,
    hookExecutions: 1,
  });
  assert.equal(view.sources[0]?.identity.executionHost, "unknown");
  assert.equal(view.issues.length, 0);
});

test("hook metadata, status, timing and quoted content survive contract parsing with original anchors", async () => {
  const raw = record(
    { name: "execute_hook PreToolUse", status: { code: 2 } },
    {
      "gen_ai.operation.name": "execute_hook",
      "copilot_chat.hook_type": "PreToolUse",
      "copilot_chat.hook_result_kind": "non_blocking_error",
      "copilot_chat.hook_input": '{"command":"DO_NOT_EXECUTE"}',
      "copilot_chat.hook_output": "Fictional hook error",
      "copilot_chat.chat_session_id": "editor-hook",
    },
  );
  const view = parseReadView(JSON.parse(JSON.stringify(await read([raw]))));
  const hook = view.events[0];
  assert.ok(hook?.kind === "hook-execution");
  assert.equal(hook.operation, "execute_hook");
  assert.equal(hook.name, "PreToolUse");
  assert.equal(hook.spanName, "execute_hook PreToolUse");
  assert.equal(hook.status, "error");
  assert.equal(hook.startedAtMs, 1760000000100);
  assert.equal(hook.endedAtMs, 1760000001200);
  assert.equal(hook.usage?.basis, "unknown");
  assert.equal(hook.usage.input, 20);
  assert.deepEqual(hook.hook, {
    type: "PreToolUse",
    resultKind: "non_blocking_error",
    input: '{"command":"DO_NOT_EXECUTE"}',
    output: "Fictional hook error",
  });
  assert.ok(Object.isFrozen(hook.hook));
  assert.deepEqual(hook.nativeIdentities, [
    { namespace: "vscode-chat", value: "editor-hook" },
    { namespace: "gen-ai-conversation", value: nativeSession },
  ]);
  for (const field of ["hook_input", "hook_output"])
    assert.ok(
      hook.references.some(
        (ref) => ref.location.pointer === `/attributes/copilot_chat.${field}`,
      ),
    );
  assert.equal(
    hook.references[0]?.recordId,
    `sha256:${createHash("sha256").update(JSON.stringify(raw)).digest("hex")}`,
  );
  assert.equal(view.sources[0]?.coverage.tokens.status, "unavailable");
});

test("nine hooks and two missing-operation spans are not eleven unsupported executions", async () => {
  const hooks = Array.from({ length: 9 }, (_, index) =>
    record(
      { spanId: (index + 1).toString(16).padStart(16, "0") },
      {
        "gen_ai.operation.name": "execute_hook",
        "copilot_chat.hook_type": "PostToolUse",
      },
    ),
  );
  const missing = [10, 11].map((index) =>
    record(
      {
        spanId: index.toString(16).padStart(16, "0"),
        name: "execute_hook misleading",
      },
      {
        "gen_ai.operation.name": undefined,
      },
    ),
  );
  const view = await read([
    ...hooks,
    ...missing,
    hooks[0],
    missing[0],
    { scopeMetrics: [], resource: {} },
    { hrTime: [1760000000, 0], resource: {}, instrumentationScope: {} },
    record({}, { "gen_ai.operation.name": "content_event" }),
  ]);
  assert.equal(view.events.length, 9);
  assert.ok(view.events.every((event) => event.kind === "hook-execution"));
  assert.deepEqual(view.sources[0]?.classification, {
    executions: {
      modelCalls: 0,
      toolCalls: 0,
      agentSpans: 0,
      hookExecutions: 9,
    },
    unclassifiedSpans: {
      missingOperation: 2,
      malformedOperation: 0,
      unsupportedOperation: 0,
    },
    conflictingSpans: 0,
    nonExecutionRecords: { metrics: 1, logs: 1, contentEvents: 1 },
  });
  assert.equal(view.issues.length, 1);
  const issue = view.issues[0];
  assert.equal(issue?.code, "missing-field");
  assert.equal(issue.count, 3);
  assert.deepEqual(
    issue.references?.map(
      (ref) => ref.location.kind === "jsonl" && ref.location.line,
    ),
    [10, 11, 13],
  );
  assert.ok(!issue.message.includes("Unsupported execution operation"));
  assert.equal(view.sources[0]?.coverage.timing.status, "partial");
  assert.equal(view.sources[0]?.coverage.tokens.status, "unavailable");
  assert.equal(
    view.events[0]?.references.filter((ref) => ref.location.pointer === "")
      .length,
    2,
  );
});

test("missing, empty, malformed and unsupported operations stay distinct and payload-free", async () => {
  const values = [
    undefined,
    "",
    " \t",
    null,
    0,
    {},
    [],
    "PRIVATE_OPERATION_MARKER",
    " chat ",
  ];
  const view = await read(
    values.map((value, index) =>
      record(
        { spanId: (index + 1).toString(16).padStart(16, "0") },
        {
          "gen_ai.operation.name": value,
        },
      ),
    ),
  );
  assert.equal(view.events.length, 0);
  assert.equal(view.sessions.length, 0);
  assert.deepEqual(view.sources[0]?.classification?.unclassifiedSpans, {
    missingOperation: 3,
    malformedOperation: 4,
    unsupportedOperation: 2,
  });
  const reasons = view.issues.filter((issue) => issue.references);
  assert.equal(reasons.length, 3);
  assert.deepEqual(
    reasons.map((issue) => issue.count),
    [3, 4, 2],
  );
  assert.equal(reasons.flatMap((issue) => issue.references ?? []).length, 9);
  assert.ok(!JSON.stringify(view).includes("PRIVATE_OPERATION_MARKER"));
  assert.ok(
    view.issues.some((issue) =>
      issue.message.includes("excluded from trusted totals"),
    ),
  );
  const containers = await read([
    record({ attributes: undefined }),
    record({ spanId: "2".repeat(16), attributes: null }),
    record({ spanId: "3".repeat(16), attributes: [] }),
  ]);
  assert.deepEqual(containers.sources[0]?.classification?.unclassifiedSpans, {
    missingOperation: 1,
    malformedOperation: 2,
    unsupportedOperation: 0,
  });
});

test("hook metadata omission does not manufacture a hook type and malformed content limits coverage", async () => {
  const omitted = await read([
    record({}, { "gen_ai.operation.name": "execute_hook" }),
  ]);
  const event = omitted.events[0];
  assert.ok(event?.kind === "hook-execution");
  assert.deepEqual(event.hook, {
    type: null,
    resultKind: null,
    input: null,
    output: null,
  });
  const malformed = await read([
    record(
      {},
      {
        "gen_ai.operation.name": "execute_hook",
        "copilot_chat.hook_type": 42,
        "copilot_chat.hook_result_kind": "unknown-result",
        "copilot_chat.hook_input": {},
        "copilot_chat.hook_output":
          "[VS Code: value truncated for persistence]",
      },
    ),
  ]);
  assert.equal(malformed.events.length, 1);
  assert.equal(
    malformed.sources[0]?.classification?.executions.hookExecutions,
    1,
  );
  assert.equal(malformed.sources[0]?.coverage.timing.status, "partial");
  assert.ok(
    malformed.issues.some((issue) => issue.message.includes("hook_type")),
  );
  assert.ok(
    malformed.issues.some((issue) =>
      issue.message.includes("hook result kind"),
    ),
  );
  assert.ok(
    malformed.issues.some((issue) =>
      issue.message.includes("content representation"),
    ),
  );
  assert.ok(
    malformed.issues.some((issue) => issue.code === "truncated-record"),
  );
});

test("hook duplicates and unsupported identity conflicts never inflate execution counts", async () => {
  const hook = record(
    {},
    {
      "gen_ai.operation.name": "execute_hook",
      "copilot_chat.hook_type": "Stop",
    },
  );
  for (const unknown of [undefined, "", null, "unqualified", "chat"]) {
    const conflicting = record({}, { "gen_ai.operation.name": unknown });
    for (const pair of [
      [hook, conflicting],
      [conflicting, hook],
    ]) {
      const view = await read([...pair, hook]);
      assert.equal(view.events.length, 0);
      assert.equal(
        view.sources[0]?.classification?.executions.hookExecutions,
        0,
      );
      assert.equal(view.sources[0]?.classification?.conflictingSpans, 1);
      assert.equal(view.sources[0]?.coverage.tokens.status, "unavailable");
      const conflict = view.issues.find((issue) =>
        issue.message.includes("Conflicting execution operations"),
      );
      assert.ok(conflict?.references);
      assert.ok(
        conflict?.references?.some(
          (ref) => ref.location.kind === "jsonl" && ref.location.line === 1,
        ),
      );
      assert.ok(
        conflict.references.some(
          (ref) => ref.location.kind === "jsonl" && ref.location.line === 2,
        ),
      );
    }
  }
  const changed = await read([
    hook,
    record(
      {},
      {
        "gen_ai.operation.name": "execute_hook",
        "copilot_chat.hook_type": "PreToolUse",
      },
    ),
  ]);
  assert.equal(changed.sources[0]?.classification?.conflictingSpans, 1);
  assert.equal(changed.events.length, 0);
  assert.equal(
    changed.issues.find((issue) =>
      issue.message.includes("Conflicting records"),
    )?.references?.length,
    4,
  );
  const distinct = await read([hook, hook, { ...hook, traceId: otherTrace }]);
  assert.equal(
    distinct.sources[0]?.classification?.executions.hookExecutions,
    2,
  );
});

test("repeated conflicts retain all original anchors with linear diagnostic growth", async () => {
  const first = record(
    {},
    {
      "gen_ai.operation.name": "execute_hook",
      "copilot_chat.hook_type": "Stop",
    },
  );
  const conflicting = record(
    {},
    {
      "gen_ai.operation.name": "execute_hook",
      "copilot_chat.hook_type": "PostToolUse",
    },
  );
  const repetitions = 1000;
  const view = await read([
    first,
    ...Array.from({ length: repetitions }, () => conflicting),
  ]);
  const issue = view.issues.find((value) =>
    value.message.includes("Conflicting records"),
  );
  assert.equal(view.events.length, 0);
  assert.equal(view.sources[0]?.classification?.conflictingSpans, 1);
  assert.equal(issue?.count, repetitions);
  assert.equal(issue?.references?.length, (repetitions + 1) * 2);
  assert.equal(
    new Set(
      issue?.references?.map(
        (ref) => ref.location.kind === "jsonl" && ref.location.line,
      ),
    ).size,
    repetitions + 1,
  );
  const operationConflict = await read([
    first,
    first,
    first,
    record({}, { "gen_ai.operation.name": undefined }),
  ]);
  const excluded = operationConflict.issues.find((value) =>
    value.message.includes("Conflicting execution operations"),
  );
  assert.deepEqual(
    [
      ...new Set(
        excluded?.references?.map(
          (ref) => ref.location.kind === "jsonl" && ref.location.line,
        ),
      ),
    ],
    [1, 2, 3, 4],
  );
});

test("nested hooks and agent wrappers keep model usage separate without aggregating intervals", async () => {
  const parent = record(
    { spanId: "2".repeat(16) },
    { "gen_ai.operation.name": "invoke_agent" },
  );
  const child = record(
    {
      spanId: "3".repeat(16),
      parentSpanContext: { traceId: trace, spanId: "2".repeat(16) },
    },
    {
      "gen_ai.operation.name": "execute_hook",
      "gen_ai.conversation.id": undefined,
    },
  );
  const view = await read([parent, child, record()]);
  assert.deepEqual(
    view.events.map((event) => event.kind !== "message" && event.usage?.basis),
    ["unknown", "unknown", "per-call"],
  );
  assert.equal(view.events[0]?.sessionId, view.events[1]?.sessionId);
  assert.deepEqual(view.sources[0]?.classification?.executions, {
    modelCalls: 1,
    toolCalls: 0,
    agentSpans: 1,
    hookExecutions: 1,
  });
  assert.ok(
    view.events.every(
      (event) =>
        event.kind !== "message" &&
        event.startedAtMs === 1760000000100 &&
        event.endedAtMs === 1760000001200,
    ),
  );
  assert.equal(view.sources[0]?.coverage.tokens.status, "complete");
});

test("mixed telemetry and duplicate wrappers do not become extra executions", async () => {
  const model = record();
  const agent = record(
    { spanId: "2".repeat(16) },
    { "gen_ai.operation.name": "invoke_agent" },
  );
  const view = await read([
    { resource: {}, scopeMetrics: [] },
    {
      severityNumber: 9,
      hrTime: [1760000000, 0],
      resource: { attributes: {} },
      instrumentationScope: { name: "fictional" },
      body: "Fictional telemetry log",
    },
    agent,
    model,
    model,
  ]);
  assert.deepEqual(
    view.events.map((event) => event.kind),
    ["agent-span", "model-call"],
  );
  const event = view.events[1];
  assert.ok(event && event.kind === "model-call");
  assert.deepEqual(
    event.references
      .filter((ref) => ref.location.pointer === "")
      .map((ref) => (ref.location.kind === "jsonl" ? ref.location.line : null)),
    [4, 5],
  );
  const wrapper = view.events[0];
  assert.ok(wrapper && wrapper.kind === "agent-span");
  assert.equal(wrapper.usage?.basis, "unknown");
});

test("same native span ID in different traces remains distinct", async () => {
  const view = await read([record(), record({ traceId: otherTrace })]);
  assert.equal(view.events.length, 2);
  assert.equal(new Set(view.events.map((event) => event.id)).size, 2);
});

test("valid log records without optional severity or body do not degrade execution coverage", async () => {
  for (const optional of [
    {},
    { severityNumber: 9 },
    { body: "Fictional log" },
    { severityNumber: 9, body: "Fictional log" },
  ]) {
    const view = await read([
      {
        hrTime: [1760000000, 0],
        hrTimeObserved: [1760000000, 1],
        resource: { attributes: {} },
        instrumentationScope: { name: "fictional" },
        attributes: {},
        droppedAttributesCount: 0,
        ...optional,
      },
      record(),
    ]);
    assert.equal(view.events.length, 1);
    assert.equal(view.issues.length, 0);
    assert.equal(view.sources[0]?.coverage.timing.status, "complete");
    assert.equal(view.sources[0]?.coverage.tools.status, "complete");
    assert.equal(view.sources[0]?.coverage.tokens.status, "complete");
  }
});

test("original record fingerprints distinguish replacements even when interpreted fields match", async () => {
  const first = await read([record()]);
  const second = await read([record({ uninterpretedField: "changed" })]);
  assert.equal(first.events[0]?.nativeId, second.events[0]?.nativeId);
  assert.notEqual(
    first.events[0]?.references[0]?.recordId,
    second.events[0]?.references[0]?.recordId,
  );
});

test("large duplicate sets within the source limit retain all original anchors", async () => {
  const raw = record(
    {},
    {
      "copilot_chat.chat_session_id": "editor-fictional",
      "gen_ai.input.messages": "",
      "gen_ai.output.messages": "",
      "gen_ai.tool.call.arguments": "",
      "gen_ai.tool.call.result": "",
    },
  );
  const repetitions = 25_000;
  const text = (JSON.stringify(raw) + "\n").repeat(repetitions);
  assert.ok(Buffer.byteLength(text) < 64 * 1024 * 1024);
  const view = await vscodeOtelReader.read(input(text, 64 * 1024));
  assert.equal(view.events.length, 1);
  assert.equal(view.events[0]?.references.length, repetitions * 7);
  assert.equal(view.sessions[0]?.references.length, repetitions * 7);
});

test("conflicting duplicate facts or producer metadata are excluded rather than guessed", async () => {
  for (const conflicting of [
    record({}, { "gen_ai.usage.input_tokens": 21 }),
    record({
      resource: { attributes: { "service.name": "another-producer" } },
    }),
  ]) {
    const view = await read([
      record(),
      conflicting,
      record({ spanId: "3".repeat(16) }),
    ]);
    assert.equal(view.events.length, 1);
    assert.equal(view.events[0]?.nativeId, "3".repeat(16));
    assert.ok(
      view.issues.some((issue) =>
        issue.message.includes("Conflicting records"),
      ),
    );
    assert.equal(view.sources[0]?.coverage.tokens.status, "partial");
  }
});

test("unsupported execution operations cannot conceal native identity conflicts in either order", async () => {
  const supported = record();
  for (const unsupported of [
    record({}, { "gen_ai.operation.name": "unqualified-execution" }),
    record({ attributes: null }),
    record({ attributes: [] }),
  ]) {
    for (const pair of [
      [supported, unsupported],
      [unsupported, supported],
    ]) {
      const view = await read(pair);
      assert.equal(view.events.length, 0);
      assert.equal(view.sessions.length, 0);
      assert.equal(view.sources[0]?.coverage.tokens.status, "unavailable");
      assert.ok(
        view.issues.some((issue) =>
          issue.message.includes("Conflicting execution operations"),
        ),
      );
      const withChild = await read([
        ...pair,
        record(
          {
            spanId: "2".repeat(16),
            parentSpanContext: { traceId: trace, spanId: "1".repeat(16) },
          },
          { "gen_ai.conversation.id": undefined },
        ),
      ]);
      assert.equal(withChild.events.length, 1);
      assert.equal(withChild.events[0]?.sessionId, null);
    }
  }
  const content = record({}, { "gen_ai.operation.name": "content_event" });
  for (const pair of [
    [supported, content],
    [content, supported],
  ]) {
    const view = await read(pair);
    assert.equal(view.events.length, 1);
    assert.equal(view.sources[0]?.coverage.tokens.status, "complete");
  }
});

test("child-before-parent ordering inherits only an explicit within-read parent session", async () => {
  const child = record(
    {
      spanId: "2".repeat(16),
      parentSpanContext: { traceId: trace, spanId: "1".repeat(16) },
    },
    { "gen_ai.conversation.id": undefined },
  );
  const view = await read([
    child,
    record({ startTime: undefined, endTime: undefined }),
  ]);
  assert.equal(view.events.length, 2);
  assert.equal(view.sessions.length, 1);
  assert.equal(view.events[0]?.sessionId, view.events[1]?.sessionId);
  assert.equal(view.events[0]?.parentNativeId, "1".repeat(16));
  const childEvent = view.events[0];
  const parentEvent = view.events[1];
  assert.ok(
    childEvent &&
      parentEvent &&
      childEvent.kind !== "message" &&
      parentEvent.kind !== "message",
  );
  assert.deepEqual(childEvent.nativeIdentities, []);
  assert.deepEqual(parentEvent.nativeIdentities, [
    { namespace: "gen-ai-conversation", value: nativeSession },
  ]);
  assert.equal(parentEvent.startedAtMs, null);
  assert.equal(parentEvent.endedAtMs, null);
});

test("missing identities and missing or cyclic parents do not create synthetic native sessions", async () => {
  const view = await read([
    record(
      { parentSpanContext: { traceId: trace, spanId: "2".repeat(16) } },
      { "gen_ai.conversation.id": undefined },
    ),
    record(
      {
        spanId: "2".repeat(16),
        parentSpanContext: { traceId: trace, spanId: "1".repeat(16) },
      },
      { "gen_ai.conversation.id": undefined },
    ),
    record(
      {
        spanId: "3".repeat(16),
        parentSpanContext: { traceId: trace, spanId: "4".repeat(16) },
      },
      { "gen_ai.conversation.id": undefined },
    ),
  ]);
  assert.equal(view.sessions.length, 0);
  assert.ok(view.events.every((event) => event.sessionId === null));
  assert.ok(view.issues.some((issue) => issue.code === "ambiguous-session"));
});

test("an invalid cross-trace parent is retained as evidence but not used to invent an association", async () => {
  const view = await read([
    record(),
    record(
      {
        traceId: otherTrace,
        spanId: "2".repeat(16),
        parentSpanContext: { traceId: trace, spanId: "1".repeat(16) },
      },
      { "gen_ai.conversation.id": undefined },
    ),
  ]);
  assert.equal(view.events[1]?.sessionId, null);
  assert.ok(
    view.issues.some((issue) =>
      issue.message.includes("Invalid native parent"),
    ),
  );
});

test("reported session IDs do not conceal parent cycles or manufacture a missing tool name", async () => {
  const view = await read([
    record({ parentSpanContext: { traceId: trace, spanId: "2".repeat(16) } }),
    record(
      {
        spanId: "2".repeat(16),
        parentSpanContext: { traceId: trace, spanId: "1".repeat(16) },
        name: "execute_tool",
      },
      {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.call.id": "call-fictional",
      },
    ),
  ]);
  assert.ok(
    view.issues.some((issue) => issue.message.includes("Cycle in captured")),
  );
  const tool = view.events[1];
  assert.ok(tool && tool.kind === "tool-call");
  assert.equal(tool.name, null);
  assert.equal(tool.spanName, "execute_tool");
  assert.equal(tool.tool?.callId, "call-fictional");
  assert.equal(view.sources[0]?.coverage.tools.status, "partial");
});

test("editor and GenAI identity namespaces remain explicit and ambiguous aliases stay unassigned", async () => {
  const view = await read([
    record({}, { "copilot_chat.chat_session_id": "editor-one" }),
    record(
      { spanId: "2".repeat(16) },
      { "copilot_chat.chat_session_id": "editor-two" },
    ),
    record({ spanId: "3".repeat(16) }),
  ]);
  assert.equal(view.sessions.length, 2);
  assert.equal(view.events[2]?.sessionId, null);
  const unassigned = view.events[2];
  assert.ok(unassigned && unassigned.kind !== "message");
  assert.deepEqual(unassigned.nativeIdentities, [
    { namespace: "gen-ai-conversation", value: nativeSession },
  ]);
  assert.deepEqual(view.sessions[0]?.nativeIdentities, [
    { namespace: "vscode-chat", value: "editor-one" },
    { namespace: "gen-ai-conversation", value: nativeSession },
  ]);
});

test("a uniquely reported editor alias connects records without truncating native identifiers", async () => {
  const native = "editor-" + "界".repeat(512);
  const view = await read([
    record({}, { "copilot_chat.chat_session_id": native }),
    record({ spanId: "2".repeat(16) }),
  ]);
  assert.equal(view.sessions.length, 1);
  assert.equal(view.sessions[0]?.nativeId, native);
  assert.equal(view.events[0]?.sessionId, view.events[1]?.sessionId);
});

test("tools preserve quoted arguments/results and reported failure without invoking anything", async () => {
  const view = await read([
    record(
      { status: { code: 2 } },
      {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "fictional_tool",
        "gen_ai.tool.call.arguments": '{"instruction":"DO_NOT_EXECUTE"}',
        "gen_ai.tool.call.result": "Fictional failure",
        "gen_ai.usage.input_tokens": undefined,
        "gen_ai.usage.output_tokens": undefined,
      },
    ),
  ]);
  const event = view.events[0];
  assert.ok(event && event.kind === "tool-call");
  assert.equal(event.name, "fictional_tool");
  assert.equal(event.status, "error");
  assert.equal(
    event.content?.toolArguments,
    '{"instruction":"DO_NOT_EXECUTE"}',
  );
  assert.equal(event.content?.toolResult, "Fictional failure");
  assert.equal(event.usage, null);
  assert.equal(view.sources[0]?.coverage.tokens.status, "unavailable");
});

test("missing or invalid usage is unavailable/partial while explicitly reported zero remains zero", async () => {
  const missing = await read([
    record(
      {},
      {
        "gen_ai.usage.input_tokens": undefined,
        "gen_ai.usage.output_tokens": undefined,
      },
    ),
  ]);
  assert.equal(missing.sources[0]?.coverage.tokens.status, "unavailable");
  const partial = await read([
    record({}, { "gen_ai.usage.output_tokens": -1 }),
  ]);
  const event = partial.events[0];
  assert.ok(event && event.kind === "model-call");
  assert.equal(event.usage?.input, 20);
  assert.equal(event.usage?.output, null);
  assert.equal(partial.sources[0]?.coverage.tokens.status, "partial");
  const zero = await read([
    record(
      {},
      { "gen_ai.usage.input_tokens": 0, "gen_ai.usage.output_tokens": 0 },
    ),
  ]);
  assert.equal(zero.sources[0]?.coverage.tokens.status, "complete");
  assert.equal(
    zero.events[0]?.kind === "model-call" && zero.events[0].usage?.output,
    0,
  );
});

test("cache overlap is unknown and reasoning aliases are never added together", async () => {
  const view = await read([
    record(
      {},
      {
        "gen_ai.usage.cache_read.input_tokens": 7,
        "gen_ai.usage.reasoning_tokens": 3,
        "gen_ai.usage.reasoning.output_tokens": 3,
      },
    ),
  ]);
  const event = view.events[0];
  assert.ok(event && event.kind === "model-call");
  assert.deepEqual(event.usage?.components, [
    { name: "cache-read", value: 7, relation: "unknown" },
    { name: "reasoning", value: 3, relation: "unknown" },
  ]);
  const conflict = await read([
    record(
      {},
      {
        "gen_ai.usage.reasoning_tokens": 2,
        "gen_ai.usage.reasoning.output_tokens": 3,
      },
    ),
  ]);
  assert.ok(
    conflict.issues.some((issue) =>
      issue.message.includes("Conflicting reasoning"),
    ),
  );
  const conflicting = conflict.events[0];
  assert.ok(conflicting && conflicting.kind === "model-call");
  assert.equal(conflicting.usage?.components.length, 0);
});

test("missing, unfinished, reversed and incorrectly scaled timing never fabricates an end", async () => {
  for (const fields of [
    { endTime: undefined },
    { ended: false, endTime: [0, 0] },
    { endTime: [1, 0] },
    { endTime: ["1760000001", "0"] },
    { endTime: [1760000001, 1e9] },
  ]) {
    const view = await read([record(fields)]);
    const event = view.events[0];
    assert.ok(event && event.kind === "model-call");
    assert.equal(event.endedAtMs, null);
    assert.equal(view.sources[0]?.coverage.timing.status, "partial");
  }
});

test("untimed span headers preserve execution evidence while logs and metrics remain excluded", async () => {
  for (const operation of ["chat", "execute_tool", "invoke_agent"]) {
    const untimed = record(
      { startTime: undefined, endTime: undefined },
      {
        "gen_ai.operation.name": operation,
        "gen_ai.tool.name": "fictional_tool",
      },
    );
    const view = await read([
      {
        ...untimed,
        severityNumber: 9,
        hrTime: [1760000000, 0],
        body: "Fictional log",
      },
      { ...untimed, scopeMetrics: [] },
      untimed,
    ]);
    assert.equal(view.events.length, 1);
    const event = view.events[0];
    assert.ok(event && event.kind !== "message");
    assert.equal(event.startedAtMs, null);
    assert.equal(event.endedAtMs, null);
    assert.equal(event.usage?.input, 20);
    assert.equal(event.usage?.output, 5);
    assert.equal(view.sessions.length, 1);
    assert.equal(view.sources[0]?.coverage.timing.status, "unavailable");
    assert.ok(
      view.issues.some((issue) =>
        issue.message.includes("Incomplete recorded timing"),
      ),
    );
  }
});

test("unknown statuses, dropped fields and producer truncation markers surface limitations", async () => {
  const view = await read([
    record(
      { status: { code: 99 }, droppedAttributesCount: 1 },
      {
        "gen_ai.input.messages":
          "[VS Code: value truncated for persistence; original 2000000 chars]",
      },
    ),
  ]);
  assert.ok(
    view.issues.some((issue) =>
      issue.message.includes("Unsupported recorded span status"),
    ),
  );
  assert.ok(
    view.issues.some((issue) => issue.message.includes("dropped telemetry")),
  );
  assert.ok(
    view.issues.some((issue) => issue.message.includes("truncation marker")),
  );
  const event = view.events[0];
  assert.ok(event && event.kind === "model-call");
  assert.equal(event.status, "unknown");
});

test("malformed status containers and absent status codes are not silently discarded", async () => {
  for (const status of [
    2,
    null,
    [],
    "ok",
    false,
    {},
    { message: "Fictional status" },
  ]) {
    const view = await read([record({ status })]);
    const event = view.events[0];
    assert.ok(event && event.kind === "model-call");
    assert.equal(event.status, "unknown");
    assert.ok(
      view.issues.some((issue) =>
        issue.message.includes("Unsupported recorded span status"),
      ),
    );
    assert.equal(view.sources[0]?.coverage.tokens.status, "partial");
  }
  for (const status of [undefined, { code: 0 }]) {
    const view = await read([record({ status })]);
    const event = view.events[0];
    assert.ok(event && event.kind === "model-call");
    assert.equal(event.status, "unknown");
    assert.equal(view.issues.length, 0);
    assert.equal(view.sources[0]?.coverage.tokens.status, "complete");
  }
});

test("malformed producer flags and identity metadata cannot produce complete coverage", async () => {
  const view = await read([
    record(
      {
        ended: "false",
        kind: "client",
        droppedAttributesCount: -1,
      },
      { "copilot_chat.chat_session_id": 42 },
    ),
  ]);
  const event = view.events[0];
  assert.ok(event && event.kind === "model-call");
  assert.equal(event.endedAtMs, null);
  for (const message of [
    "completion flag",
    "span kind",
    "drop count",
    "session identifier",
  ])
    assert.ok(view.issues.some((issue) => issue.message.includes(message)));
  assert.equal(view.sources[0]?.coverage.tokens.status, "partial");
});

test("missing or malformed exporter resource and scope metadata retain only partial evidence", async () => {
  for (const fields of [
    { resource: undefined },
    { resource: null },
    { resource: [] },
    { resource: { attributes: null } },
    { resource: {} },
    { instrumentationScope: undefined },
    { instrumentationScope: null },
    { instrumentationScope: [] },
    { instrumentationScope: {} },
    { instrumentationScope: { name: 42 } },
  ]) {
    const view = await read([record(fields)]);
    assert.equal(view.events.length, 1);
    assert.ok(view.issues.some((issue) => issue.message.includes("exporter")));
    assert.equal(view.sources[0]?.coverage.timing.status, "partial");
    assert.equal(view.sources[0]?.coverage.tools.status, "partial");
    assert.equal(view.sources[0]?.coverage.tokens.status, "partial");
  }
});

test("reported names and identifiers with invalid types are diagnosed without coercion", async () => {
  const view = await read([
    record(
      {
        name: 42,
        resource: {
          attributes: { "service.name": 42, "service.version": false },
        },
      },
      {
        "gen_ai.request.model": 42,
        "gen_ai.response.model": null,
        "gen_ai.agent.name": [],
        "gen_ai.tool.name": false,
        "gen_ai.tool.call.id": {},
      },
    ),
  ]);
  const event = view.events[0];
  assert.ok(event && event.kind === "model-call");
  assert.equal(event.name, null);
  assert.equal(event.spanName, null);
  assert.deepEqual(event.model, { requested: null, responded: null });
  assert.deepEqual(event.tool, { name: null, callId: null });
  assert.equal(view.sources[0]?.identity.producer, null);
  assert.equal(view.sources[0]?.identity.version, null);
  assert.ok(
    view.issues.some((issue) => issue.message.includes("Invalid reported")),
  );
  assert.equal(view.sources[0]?.coverage.tokens.status, "partial");
});

test("framing preserves UTF-8, BOM, CRLF and physical line references across byte boundaries", async () => {
  const raw = record({}, { "gen_ai.tool.call.result": "Fictional café 界 😀" });
  const text = "\ufeff\r\n \r\n" + JSON.stringify(raw);
  const view = await vscodeOtelReader.read(input(text, 1));
  const event = view.events[0];
  assert.ok(event && event.kind === "model-call");
  assert.equal(event.content?.toolResult, "Fictional café 界 😀");
  assert.deepEqual(event.references[0]?.location, {
    kind: "jsonl",
    line: 3,
    pointer: "",
  });
  assert.equal(view.issues.length, 0);
});

test("damaged independent records retain good evidence without leaking parser exception payloads", async () => {
  const text =
    JSON.stringify(record()) +
    '\n{"PRIVATE_MARKER":bad}\n' +
    JSON.stringify(record({ spanId: "2".repeat(16) })) +
    '\n{"unfinished":"SECRET_TAIL';
  const view = await vscodeOtelReader.read(input(text));
  assert.equal(view.events.length, 2);
  assert.ok(view.issues.some((issue) => issue.code === "truncated-record"));
  assert.ok(view.issues.some((issue) => issue.code === "unknown-record"));
  assert.equal(view.sources[0]?.coverage.tokens.status, "partial");
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_MARKER|SECRET_TAIL/);
});

test("invalid UTF-8 is explicit and does not prevent a later independent valid record", async () => {
  const valid = new TextEncoder().encode(JSON.stringify(record()));
  const bytes = new Uint8Array([0xc3, 0x28, 10, ...valid]);
  const view = await vscodeOtelReader.read(input(bytes, 3));
  assert.equal(view.events.length, 1);
  assert.ok(
    view.issues.some((issue) => issue.message.includes("Invalid UTF-8")),
  );
});

test("empty, unsupported, non-execution-only and unknown-operation sources never fabricate sessions", async () => {
  for (const records of [
    [],
    [{ resourceSpans: [] }],
    [{ version: 3, requests: [] }],
    [{ scopeMetrics: [] }],
    [record({}, { "gen_ai.operation.name": "unqualified-operation" })],
  ]) {
    const view = await read(records);
    assert.equal(view.events.length, 0);
    assert.equal(view.sessions.length, 0);
    const source = view.sources[0];
    assert.ok(source);
    assert.ok(
      Object.values(source.coverage).every(
        (coverage) => coverage.status === "unavailable",
      ),
    );
    assert.ok(view.issues.some((issue) => issue.code === "unsupported-schema"));
  }
});

test("cancellation rejects before consuming data and during multi-record framing", async () => {
  const controller = new AbortController();
  controller.abort();
  let pulled = false;
  /** Mark stream consumption so pre-aborted input cannot quietly read even its first chunk. */
  async function* bytes(): AsyncGenerator<Uint8Array> {
    pulled = true;
    yield new TextEncoder().encode(JSON.stringify(record()));
  }
  await assert.rejects(
    vscodeOtelReader.read({
      readId: "read",
      sourceId: "source",
      bytes: bytes(),
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(pulled, false);
  const active = new AbortController();
  const framed = jsonLines(input("{}\n{}\n", 64, active.signal));
  assert.equal((await framed.next()).done, false);
  active.abort();
  await assert.rejects(framed.next(), { name: "AbortError" });
});
