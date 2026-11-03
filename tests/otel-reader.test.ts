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
import type { ReaderInput, ReadView } from "../src/evidence/contracts.js";

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
