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
  eventSchema,
  parseMetric,
  type ReaderInput,
  type ReadView,
} from "../src/evidence/contracts.js";
import { calculateRecordedMetrics } from "../src/metrics/recorded.js";
import { recordedReport } from "../src/runtime/report.js";

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

test("mixed retained evidence separates timestamps, model operations, attribution and capture history", async () => {
  const operations = ["chat", "embeddings", "execute_tool", "execute_tool", "execute_hook", "chat", "chat"];
  const view = await read(operations.map((operation, index) => record(
    { spanId: (index + 1).toString(16).padStart(16, "0") },
    {
      "gen_ai.operation.name": operation,
      "gen_ai.conversation.id": index < 4 ? nativeSession : undefined,
      "copilot_chat.chat_session_id": index === 0 ? "parent" : undefined,
      "copilot_chat.parent_chat_session_id": index === 6 ? "parent" : undefined,
      "gen_ai.tool.name": operation === "execute_tool" ? "fictional_tool" : undefined,
      "gen_ai.tool.call.id": operation === "execute_tool" ? "" : undefined,
      "gen_ai.usage.input_tokens": operation === "chat" ? 20 : undefined,
      "gen_ai.usage.output_tokens": operation === "chat" ? 5 : undefined,
    },
  )));
  const source = view.sources[0]!;
  assert.equal(source.coverage.timing.status, "complete");
  assert.equal(source.coverage.tools.status, "complete");
  assert.equal(source.coverage.tokens.status, "partial");
  assert.equal(source.coverage.messages.status, "unavailable");
  assert.equal(source.coverageDetails?.retainedTiming.status, "complete");
  assert.equal(source.coverageDetails?.chatUsage.status, "complete");
  assert.equal(source.coverageDetails?.embeddingUsage.status, "unavailable");
  assert.equal(source.coverageDetails?.sessionAttribution.status, "partial");
  assert.equal(source.coverageDetails?.history.status, "partial");
  assert.equal(source.identity.executionHost, "unknown");
  assert.equal(source.classification?.executions.hookExecutions, 1);
  const emptyIds = view.issues.find((issue) => /identifier unavailable/.test(issue.message));
  assert.equal(emptyIds?.count, 2);
  assert.equal(emptyIds.affectsCoverage, false);
  assert.deepEqual(emptyIds.impact, { scope: "records", dimensions: ["tools"] });
  const sessionId = view.sessions[0]!.id;
  const whole = calculateRecordedMetrics(view, { sessionId });
  assert.equal(whole.tools.calls.metric.value, 2);
  assert.equal(whole.tools.calls.metric.coverage.status, "complete");
  assert.equal(whole.tokens.input.metric.value, 20);
  assert.equal(whole.tokens.input.metric.coverage.status, "partial");
  assert.deepEqual(whole.tokens.input.contributorEventIds, [view.events[0]!.id]);
  assert.deepEqual(whole.tokens.input.metric.contributors, view.events[0]!.references);
  assert.ok(whole.tokens.input.scope.eventIds.includes(view.events[1]!.id));
  assert.equal(whole.exclusions.filter((entry) => entry.reason === "unassigned").length, 2);
  assert.equal(whole.exclusions.filter((entry) => entry.reason === "associated-only").length, 1);
  for (const [index, value, status] of [[0, 20, "complete"], [1, null, "unavailable"]] as const) {
    const event = view.events[index]!;
    const selected = calculateRecordedMetrics(view, { sessionId, eventIds: [event.id] });
    assert.equal(selected.tokens.input.metric.value, value);
    assert.equal(selected.tokens.input.metric.coverage.status, status);
    assert.deepEqual(selected.tokens.input.contributorEventIds, [event.id]);
    assert.deepEqual(selected.tokens.input.scope.eventIds, [event.id]);
    assert.deepEqual(selected.tokens.input.metric.contributors, event.references);
    assert.deepEqual(parseMetric(selected.tokens.input.metric, view), selected.tokens.input.metric);
    assert.equal(selected.timing.elapsed.metric.coverage.status, "complete");
  }
  assert.deepEqual(parseReadView(JSON.parse(JSON.stringify(view))), view);
});

test("operation usage distinguishes absent calls from retained calls with missing usage", async () => {
  for (const [operation, present, absent, absentReason] of [
    ["chat", "chatUsage", "embeddingUsage", "No retained embedding calls"],
    ["embeddings", "embeddingUsage", "chatUsage", "No retained chat calls"],
  ] as const) {
    const view = await read([record({}, { "gen_ai.operation.name": operation })]);
    const details = view.sources[0]!.coverageDetails!;
    assert.deepEqual(details[absent], { status: "unavailable", reason: absentReason });
    assert.equal(details[present].status, "complete");
    const missing = await read([record({}, {
      "gen_ai.operation.name": operation,
      "gen_ai.usage.input_tokens": undefined,
      "gen_ai.usage.output_tokens": undefined,
    })]);
    const usage = missing.sources[0]!.coverageDetails![present];
    assert.equal(usage.status, "unavailable");
    assert.match(usage.reason, /usage is missing/);
    assert.equal(missing.events.length, 1);
  }
});

test("record-scoped malformed usage limits tokens, not timestamps or another selected model call", async () => {
  const view = await read([
    record(),
    record({ spanId: "2".repeat(16) }, { "gen_ai.usage.input_tokens": -1 }),
  ]);
  const issue = view.issues.find((issue) => /Invalid reported token/.test(issue.message));
  assert.deepEqual(issue?.impact, { scope: "records", dimensions: ["tokens"] });
  assert.equal(issue.severity, "error");
  assert.equal(view.sources[0]?.coverage.timing.status, "complete");
  const sessionId = view.sessions[0]!.id;
  const selected = calculateRecordedMetrics(view, { sessionId, eventIds: [view.events[0]!.id] });
  assert.equal(selected.tokens.input.metric.coverage.status, "complete");
  assert.deepEqual(parseMetric(selected.tokens.input.metric, view), selected.tokens.input.metric);
  const whole = calculateRecordedMetrics(view, { sessionId });
  assert.equal(whole.tokens.input.metric.value, 20);
  assert.equal(whole.tokens.input.metric.coverage.status, "partial");
});

test("scoped metric validation rejects unmeasured embedding usage even alongside measured chat anchors", async () => {
  const view = await read([
    record(),
    record({ spanId: "2".repeat(16) }, {
      "gen_ai.operation.name": "embeddings",
      "gen_ai.usage.input_tokens": undefined,
      "gen_ai.usage.output_tokens": undefined,
    }),
  ]);
  const sessionId = view.sessions[0]!.id;
  const missing = calculateRecordedMetrics(view, {
    sessionId, eventIds: [view.events[1]!.id],
  }).tokens.input.metric;
  assert.equal(missing.value, null);
  assert.deepEqual(parseMetric(missing, view), missing);
  for (const coverage of [
    { status: "complete" },
    { status: "partial", reason: "Only an unmeasured call was selected" },
  ]) {
    assert.throws(() => parseMetric({ ...missing, value: 1, coverage }, view), /unavailable/);
  }
  const measured = calculateRecordedMetrics(view, {
    sessionId, eventIds: [view.events[0]!.id],
  }).tokens.input.metric;
  assert.equal(measured.coverage.status, "complete");
  assert.deepEqual(parseMetric(measured, view), measured);
  assert.throws(() => parseMetric({
    ...measured,
    coverage: { status: "partial", reason: "Mixed measured and missing usage" },
    contributors: [...measured.contributors, ...missing.contributors],
  }, view), /unavailable/);
});

test("scoped tool-zero anchors ignore another session's malformed tool ID", async () => {
  const view = await read([
    record(),
    record({ spanId: "2".repeat(16) }, {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.conversation.id": "other-session",
      "gen_ai.tool.name": "fictional_tool",
      "gen_ai.tool.call.id": 17,
      "gen_ai.usage.input_tokens": undefined,
      "gen_ai.usage.output_tokens": undefined,
    }),
  ]);
  assert.equal(view.sources[0]?.coverage.tools.status, "partial");
  const metric = calculateRecordedMetrics(view, { sessionId: view.events[0]!.sessionId! }).tools.calls.metric;
  assert.equal(metric.value, 0);
  assert.equal(metric.coverage.status, "complete");
  assert.ok(metric.contributors.length > 0);
  assert.deepEqual(parseMetric(metric, view), metric);
  assert.equal(calculateRecordedMetrics(view, {
    sessionId: view.events[1]!.sessionId!,
  }).tools.calls.metric.coverage.status, "partial");
});

test("non-model usage exclusions do not limit per-call totals or unrelated usage observations", async () => {
  const operations = ["chat", "execute_hook", "invoke_agent", "execute_hook", "invoke_agent"];
  const view = await read(operations.map((operation, index) => record(
    { spanId: (index + 1).toString(16).padStart(16, "0") },
    {
      "gen_ai.operation.name": operation,
      "gen_ai.conversation.id": index < 3 ? nativeSession : undefined,
    },
  )));
  const metrics = calculateRecordedMetrics(view, { sessionId: view.sessions[0]!.id });
  assert.equal(metrics.exclusions.filter((entry) => entry.reason === "unassigned").length, 2);
  assert.equal(metrics.timing.elapsed.metric.coverage.status, "partial");
  for (const [metric, value] of [[metrics.tokens.input.metric, 20], [metrics.tokens.output.metric, 5]] as const) {
    assert.equal(metric.value, value);
    assert.equal(metric.coverage.status, "complete");
    assert.deepEqual(parseMetric(metric, view), metric);
  }
  assert.equal(metrics.tokens.observations.length, 2);
  for (const observation of metrics.tokens.observations)
    assert.equal(observation.input.metric.coverage.status, "complete");
});

test("scoped diagnostic indexing bounds anchor reads linearly across differently named tools", async () => {
  const count = 64;
  const view = await read(Array.from({ length: count }, (_, index) => record(
    { spanId: (index + 1).toString(16).padStart(16, "0") },
    {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": `fictional_tool_${index}`,
      "gen_ai.tool.call.id": 17,
      "gen_ai.usage.input_tokens": undefined,
      "gen_ai.usage.output_tokens": undefined,
    },
  )));
  let anchorReads = 0;
  const counted = {
    ...view,
    issues: view.issues.map((issue) => ({
      ...issue,
      references: (issue.references ?? []).map((reference) => ({
        ...reference,
        /** Count diagnostic indexing work without timing noise or changing evidence. */
        get location() {
          anchorReads++;
          return reference.location;
        },
      })),
    })),
  };
  const metrics = calculateRecordedMetrics(counted, { sessionId: view.sessions[0]!.id });
  assert.equal(metrics.tools.identities.length, count);
  assert.ok(metrics.tools.identities.every((entry) => entry.calls.metric.coverage.status === "partial"));
  assert.ok(anchorReads <= count * 2, `Expected linear diagnostic anchor reads, got ${anchorReads}`);
});

test("repeated source-wide unsupported records retain counts without per-record diagnostic amplification", async () => {
  const count = 16384;
  const text = "0\n".repeat(count);
  const view = await vscodeOtelReader.read(input(text));
  const issue = view.issues.find((entry) => entry.code === "unknown-record");
  assert.equal(issue?.count, count);
  assert.equal(issue.severity, "error");
  assert.match(issue.message, /first line 1/);
  assert.deepEqual(issue.impact, { scope: "source", dimensions: ["messages", "timing", "tools", "tokens"] });
  assert.equal(issue.references, undefined);
  assert.equal(view.events.length, 0);
  assert.equal(view.sources[0]?.coverage.timing.status, "unavailable");
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < Buffer.byteLength(text));
});

test("unassigned hook exclusions are indexed once rather than scanned for every tool name", async () => {
  const count = 64;
  const view = await read(Array.from({ length: count * 2 }, (_, index) => record(
    { spanId: (index + 1).toString(16).padStart(16, "0") },
    {
      "gen_ai.operation.name": index < count ? "execute_tool" : "execute_hook",
      "gen_ai.conversation.id": index < count ? nativeSession : undefined,
      "gen_ai.tool.name": index < count ? `tool_${index}` : undefined,
      "gen_ai.usage.input_tokens": undefined,
      "gen_ai.usage.output_tokens": undefined,
    },
  )));
  let hookKindReads = 0;
  const counted = {
    ...view,
    events: view.events.map((event) => event.kind !== "hook-execution" ? event : ({
      ...event,
      /** Observe exclusion work independently of machine timing, without changing event semantics. */
      get kind() {
        hookKindReads++;
        return event.kind;
      },
    })),
  };
  const metrics = calculateRecordedMetrics(counted, { sessionId: view.sessions[0]!.id });
  assert.equal(metrics.tools.identities.length, count);
  assert.equal(metrics.exclusions.length, count);
  assert.ok(metrics.tools.identities.every((entry) => entry.calls.metric.coverage.status === "complete"));
  assert.equal(metrics.timing.elapsed.metric.coverage.status, "partial");
  assert.ok(hookKindReads <= count * 20, `Expected linear exclusion processing, got ${hookKindReads}`);
});

test("unknown operations, malformed/truncated input, changed sources and identity conflicts limit totals, not retained timestamp validity", async () => {
  const valid = record();
  for (const tail of [
    JSON.stringify(record({ spanId: "2".repeat(16) }, { "gen_ai.operation.name": "unqualified" })),
    "{malformed}\n",
    '{"incomplete":',
    JSON.stringify(record({}, { "gen_ai.usage.input_tokens": 99 })),
  ]) {
    const view = await vscodeOtelReader.read(input(`${JSON.stringify(valid)}\n${JSON.stringify(record({ spanId: "3".repeat(16) }))}\n${tail}`));
    const sessionId = view.sessions[0]!.id;
    assert.equal(view.sources[0]?.coverageDetails?.retainedTiming.status, "complete");
    const metrics = calculateRecordedMetrics(view, { sessionId });
    for (const entry of [metrics.tokens.input, metrics.timing.elapsed, metrics.tools.calls])
      assert.notEqual(entry.metric.coverage.status, "complete");
    assert.ok(view.issues.some((issue) => issue.severity === "error" && issue.impact?.scope === "source"));
  }
  const original = await read([valid]);
  const partial = { status: "partial", reason: "Source changed during read" };
  const changed = parseReadView({
    ...original,
    sources: original.sources.map((source) => ({
      ...source, changedDuringRead: true,
      coverage: { messages: source.coverage.messages, timing: partial, tokens: partial, tools: partial },
    })),
    issues: [{ sourceId: original.sources[0]!.id, code: "source-changed", message: partial.reason }],
  });
  assert.equal(changed.sources[0]?.coverageDetails?.retainedTiming.status, "complete");
  assert.equal(calculateRecordedMetrics(changed, { sessionId: changed.sessions[0]!.id }).tokens.input.metric.coverage.status, "partial");
});

test("log, metric and content-event-only inputs describe non-execution telemetry without invented calls", async () => {
  for (const raw of [
    { scopeMetrics: [] },
    { hrTime: [1760000000, 0], resource: {}, instrumentationScope: {} },
    record({}, { "gen_ai.operation.name": "content_event" }),
  ]) {
    const view = await read([raw]);
    assert.equal(view.events.length, 0);
    assert.equal(view.sessions.length, 0);
    assert.match(view.issues[0]!.message, /Non-execution telemetry was found/);
    assert.ok(Object.values(view.sources[0]!.coverage).every((coverage) => coverage.status === "unavailable"));
  }
});

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
  const metrics = calculateRecordedMetrics(view, { sessionId: view.sessions[0].id });
  assert.equal(metrics.tools.calls.metric.value, 0);
  assert.equal(metrics.tokens.input.metric.value, 20);
  assert.equal(metrics.tokens.output.metric.value, 5);
  assert.equal(metrics.timing.elapsed.metric.value, 1100);
  assert.deepEqual(parseMetric(metrics.tools.calls.metric, view), metrics.tools.calls.metric);
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
  assert.equal(malformed.sources[0]?.coverage.timing.status, "complete");
  assert.ok(malformed.issues.every((issue) => issue.severity === "error"));
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
  const missing = record({}, { "gen_ai.operation.name": undefined });
  for (const records of [
    [first, conflicting, first],
    [first, conflicting, conflicting, first],
    [first, missing, first],
    [missing, first, first],
  ]) {
    const conflicted = await read(records);
    assert.equal(conflicted.events.length, 0);
    assert.equal(conflicted.sources[0]?.classification?.conflictingSpans, 1);
    const lines = new Set(
      conflicted.issues.flatMap((diagnostic) =>
        (diagnostic.references ?? []).map((ref) => {
          assert.ok(ref.location.kind === "jsonl");
          return ref.location.line;
        }),
      ),
    );
    assert.deepEqual(
      [...lines].sort((a, b) => a - b),
      Array.from({ length: records.length }, (_, index) => index + 1),
    );
  }
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
  assert.ok(view.issues.some((issue) => issue.code === "missing-field" && /Span-parent linkage/.test(issue.message)));
  assert.ok(view.issues.some((issue) => /Cycle in captured parent/.test(issue.message)));
  assert.ok(!view.issues.some((issue) => issue.code === "ambiguous-session"));
});

test("four parent-only calls preserve explicit associations, original fields and nullable membership", async () => {
  const auxiliary = Array.from({ length: 4 }, (_, index) => record(
    { spanId: (index + 2).toString(16).padStart(16, "0") },
    { "gen_ai.conversation.id": undefined, "copilot_chat.parent_chat_session_id": "parent" },
  ));
  const parent = record({}, {
    "copilot_chat.chat_session_id": "parent", "gen_ai.usage.input_tokens": 7,
  });
  const view = await read([...auxiliary, auxiliary[0], parent]);
  assert.equal(view.sessions.length, 1);
  const sessionId = view.sessions[0]!.id;
  assert.equal(view.events.length, 5);
  for (const event of view.events.slice(0, 4)) {
    assert.ok(event.kind === "model-call" && event.parentChat);
    assert.equal(event.sessionId, null);
    assert.deepEqual(event.nativeIdentities, []);
    assert.equal(event.parentChat.namespace, "vscode-chat");
    assert.equal(event.parentChat.value, "parent");
    assert.equal(event.parentChat.status, "resolved");
    assert.equal(event.parentChat.sessionId, sessionId);
    assert.equal(event.parentChat.reference.location.pointer, "/attributes/copilot_chat.parent_chat_session_id");
    assert.ok(event.references.some((ref) => ref.recordId === event.parentChat?.reference.recordId));
  }
  const report = recordedReport(view, { readId: view.id, sessionId });
  assert.deepEqual(report.contributions, { directEvents: 1, associatedEvents: 4 });
  assert.equal(report.measurements.find((entry) => entry.id === "input")?.metric.value, 7);
  for (const entry of report.measurements) parseMetric(entry.metric, view);
  assert.deepEqual(parseReadView(JSON.parse(JSON.stringify(view))), view);
});

test("own identity stays independent and parent lookup never crosses GenAI identity namespaces or invents absent sessions", async () => {
  const rows = [
    record({}, { "gen_ai.conversation.id": "only-conversation" }),
    record({ spanId: "2".repeat(16) }, {
      "gen_ai.conversation.id": "own-conversation", "copilot_chat.chat_session_id": "own-editor",
      "copilot_chat.parent_chat_session_id": "only-conversation",
    }),
    record({ spanId: "3".repeat(16) }, {
      "gen_ai.conversation.id": undefined, "copilot_chat.parent_chat_session_id": "out-of-read",
    }),
  ];
  const view = await read(rows);
  assert.equal(view.sessions.length, 2);
  const own = view.events[1];
  assert.ok(own?.kind === "model-call");
  assert.equal(own.sessionId, view.sessions[1]?.id);
  assert.deepEqual(own.nativeIdentities, [
    { namespace: "vscode-chat", value: "own-editor" },
    { namespace: "gen-ai-conversation", value: "own-conversation" },
  ]);
  assert.equal(own.parentChat?.status, "unresolved");
  assert.equal(own.parentChat.sessionId, null);
  const missing = view.events[2];
  assert.ok(missing?.kind === "model-call");
  assert.equal(missing.sessionId, null);
  assert.equal(missing.parentChat?.value, "out-of-read");
  assert.match(view.issues.map((issue) => issue.message).join(" "), /session is not present in this read/);
  const withParent = await read([...rows, record({ spanId: "4".repeat(16) }, {
    "gen_ai.conversation.id": undefined, "copilot_chat.chat_session_id": "only-conversation",
  })]);
  const resolved = withParent.events[1];
  assert.ok(resolved?.kind === "model-call" && resolved.parentChat);
  assert.equal(resolved.parentChat.status, "resolved");
  assert.equal(resolved.parentChat.sessionId, withParent.sessions[2]?.id);
  assert.equal(resolved.sessionId, withParent.sessions[1]?.id);
  assert.deepEqual(resolved.nativeIdentities, own.nativeIdentities);
});

test("resolved associations do not conceal ambiguous own identity and malformed parent values stay evidenced", async () => {
  const view = await read([
    record({}, { "copilot_chat.chat_session_id": "one" }),
    record({ spanId: "2".repeat(16) }, { "copilot_chat.chat_session_id": "two" }),
    record({ spanId: "3".repeat(16) }, { "copilot_chat.parent_chat_session_id": "one" }),
    record({ spanId: "4".repeat(16), parentSpanContext: { traceId: trace, spanId: "3".repeat(16) } }, {
      "gen_ai.conversation.id": undefined,
    }),
  ]);
  const child = view.events[2];
  assert.ok(child?.kind === "model-call");
  assert.equal(child.sessionId, null);
  assert.equal(child.parentChat?.status, "resolved");
  assert.equal(view.issues.find((issue) => issue.code === "ambiguous-session")?.count, 2);
  const metrics = calculateRecordedMetrics(view, { sessionId: child.parentChat.sessionId! });
  assert.ok(metrics.exclusions.some((entry) =>
    entry.eventIds.includes(child.id) && entry.reason === "ambiguous-attribution"));
  assert.equal(metrics.tokens.input.metric.value, 20);
  assert.equal(metrics.tokens.input.metric.coverage.status, "partial");
  assert.equal(metrics.timing.elapsed.metric.coverage.status, "partial");
  for (const value of ["", null, 17]) {
    const invalid = await read([record({}, { "copilot_chat.parent_chat_session_id": value })]);
    const event = invalid.events[0];
    assert.ok(event?.kind === "model-call" && !event.parentChat);
    assert.ok(event.references.some((ref) => ref.location.pointer === "/attributes/copilot_chat.parent_chat_session_id"));
    assert.match(invalid.issues.map((issue) => issue.message).join(" "), /Invalid reported parent-chat identifier/);
  }
});

test("parent-only identity does not fabricate sessions and ten truly unlinked calls have missing, not conflicting linkage", async () => {
  const rows = Array.from({ length: 10 }, (_, index) => record(
    { spanId: (index + 1).toString(16).padStart(16, "0") },
    { "gen_ai.operation.name": index < 3 ? "chat" : "embeddings", "gen_ai.conversation.id": undefined },
  ));
  const view = await read(rows);
  assert.equal(view.sessions.length, 0);
  assert.equal(view.events.length, 10);
  assert.ok(view.events.every((event) => event.sessionId === null));
  const missing = view.issues.find((issue) => /no reported session identity/.test(issue.message));
  assert.equal(missing?.code, "missing-field");
  assert.equal(missing.count, 10);
  assert.ok(!view.issues.some((issue) => issue.code === "ambiguous-session"));
  const parentOnly = await read([record({}, {
    "gen_ai.conversation.id": undefined, "copilot_chat.parent_chat_session_id": "absent",
  })]);
  assert.equal(parentOnly.sessions.length, 0);
  assert.equal(parentOnly.events[0]?.sessionId, null);
});

test("self/cyclic parent-chat edges and conflicting replays never resolve or overwrite direct sessions", async () => {
  const rows = [["a", "b"], ["b", "c"], ["c", "a"], ["self", "self"]].map(([own, parent], index) =>
    record({ spanId: (index + 1).toString(16).padStart(16, "0") }, {
      "gen_ai.conversation.id": undefined, "copilot_chat.chat_session_id": own,
      "copilot_chat.parent_chat_session_id": parent,
    }));
  const view = await read(rows);
  assert.equal(view.sessions.length, 4);
  assert.deepEqual(view.events.map((event) => event.kind !== "message" && event.parentChat?.status), ["cycle", "cycle", "cycle", "self"]);
  assert.ok(view.events.every((event) => event.sessionId !== null && event.kind !== "message" && event.parentChat?.sessionId === null));
  assert.match(view.issues.map((issue) => issue.message).join(" "), /Cycle in explicit parent-chat/);
  const conflict = await read([rows[0], record({ spanId: "0000000000000001" }, {
    "gen_ai.conversation.id": undefined, "copilot_chat.chat_session_id": "a",
    "copilot_chat.parent_chat_session_id": "different",
  })]);
  assert.equal(conflict.events.length, 0);
  assert.equal(conflict.sessions.length, 0);
  assert.equal(conflict.sources[0]?.classification?.conflictingSpans, 1);
});

test("malformed parent values and field presence remain conflicting native-span facts", async () => {
  for (const [first, second] of [[17, 18], [undefined, null], [null, ""], ["", false]]) {
    const view = await read([
      record({}, { "copilot_chat.parent_chat_session_id": first }),
      record({}, { "copilot_chat.parent_chat_session_id": second }),
    ]);
    assert.equal(view.events.length, 0);
    assert.equal(view.sessions.length, 0);
    assert.equal(view.sources[0]?.classification?.conflictingSpans, 1);
  }
  const invalid = record({}, { "copilot_chat.parent_chat_session_id": 17 });
  const duplicate = await read([invalid, invalid]);
  assert.equal(duplicate.events.length, 1);
  const event = duplicate.events[0];
  assert.ok(event?.kind === "model-call" && !event.parentChat);
});

test("span-inherited and GenAI conversation membership preserve agreeing parent-chat links without self diagnoses or double counting", async () => {
  for (const conversationLinked of [false, true]) {
    const view = await read([
      record({}, { "copilot_chat.chat_session_id": "parent", "gen_ai.usage.input_tokens": 20 }),
      record({ spanId: "2".repeat(16), ...(!conversationLinked
        ? { parentSpanContext: { traceId: trace, spanId: "1".repeat(16) } } : {}) }, {
        "gen_ai.conversation.id": conversationLinked ? nativeSession : undefined,
        "copilot_chat.parent_chat_session_id": "parent", "gen_ai.usage.input_tokens": 7,
      }),
    ]);
    const child = view.events[1];
    assert.ok(child?.kind === "model-call" && child.parentChat);
    assert.deepEqual(child.nativeIdentities, conversationLinked
      ? [{ namespace: "gen-ai-conversation", value: nativeSession }] : []);
    assert.equal(child.sessionId, view.sessions[0]!.id);
    assert.equal(child.parentChat.status, "resolved");
    assert.equal(child.parentChat.sessionId, child.sessionId);
    assert.ok(!view.issues.some((issue) => /own session/.test(issue.message)));
    assert.equal(view.sources[0]?.coverage.tokens.status, "complete");
    const report = recordedReport(view, { readId: view.id, sessionId: child.sessionId });
    assert.deepEqual(report.contributions, { directEvents: 2, associatedEvents: 0 });
    assert.equal(report.measurements.find((entry) => entry.id === "input")?.metric.value, 27);
  }
});

test("parent-chat contracts reject wrong-source/record anchors, wrong namespaces, invented and ambiguous targets", async () => {
  const view = await read([
    record({}, { "copilot_chat.chat_session_id": "parent" }),
    record({ spanId: "2".repeat(16) }, {
      "gen_ai.conversation.id": undefined, "copilot_chat.parent_chat_session_id": "parent",
    }),
  ]);
  const child = view.events[1];
  assert.ok(child?.kind === "model-call" && child.parentChat);
  const link = child.parentChat;
  assert.throws(() => eventSchema.parse({ ...child, parentChat: { ...link, sessionId: null } }));
  assert.throws(() => eventSchema.parse({ ...child, parentChat: { ...link, reference: { ...link.reference, sourceId: "foreign" } } }));
  for (const parentChat of [
    { ...child.parentChat, sessionId: "invented" },
    { ...child.parentChat, namespace: "gen-ai-conversation" },
    { ...child.parentChat, reference: { ...child.parentChat.reference, sourceId: "other-source" } },
    { ...child.parentChat, reference: { ...child.parentChat.reference, recordId: "unrelated-record" } },
    { ...child.parentChat, reference: { ...child.parentChat.reference, location: { kind: "jsonl", line: 1, pointer: "/attributes/copilot_chat.parent_chat_session_id" } } },
  ])
    assert.throws(() => parseReadView({ ...view, events: [view.events[0], { ...child, parentChat }] }));
  const duplicate = { ...view.sessions[0], id: "another-observed-parent" };
  assert.throws(() => parseReadView({ ...view, sessions: [...view.sessions, duplicate] }));
  const ambiguous = parseReadView({ ...view, sessions: [...view.sessions, duplicate],
    events: [view.events[0], { ...child, parentChat: { ...child.parentChat, status: "ambiguous", sessionId: null } }] });
  assert.equal(ambiguous.events[1]?.sessionId, null);
  const foreign = { ...view.sessions[0], id: "foreign-session", sourceIds: ["foreign"],
    references: view.sessions[0]!.references.map((ref) => ({ ...ref, sourceId: "foreign" })) };
  const isolated = parseReadView({
    ...view, sources: [...view.sources, { ...view.sources[0], id: "foreign" }], sessions: [foreign],
    events: [{ ...child, parentChat: { ...child.parentChat, status: "unresolved", sessionId: null } }],
  });
  assert.equal(isolated.events[0]?.sessionId, null);
  assert.throws(() => parseReadView({ ...isolated,
    events: [{ ...child, parentChat: { ...child.parentChat, sessionId: foreign.id } }] }));
  const secondSourceChild = { ...child,
    references: child.references.map((ref) => ({ ...ref, sourceId: "foreign" })),
    parentChat: { ...link, status: "unresolved", sessionId: null,
      reference: { ...link.reference, sourceId: "foreign" } } };
  const combined = parseReadView({
    ...view, sources: [...view.sources, { ...view.sources[0], id: "foreign" }],
    sessions: [{ ...view.sessions[0], sourceIds: ["source-fictional", "foreign"] }],
    events: [view.events[0], secondSourceChild],
  });
  assert.ok(combined.events[1]?.kind !== "message" && combined.events[1]?.parentChat?.status === "unresolved");
  assert.throws(() => parseReadView({ ...combined, events: [
    view.events[0], { ...secondSourceChild, parentChat: { ...secondSourceChild.parentChat, status: "resolved", sessionId: view.sessions[0]!.id } },
  ] }));
});

test("associated-only exclusions refer only to the selected parent and keep membership coverage partial", async () => {
  const view = await read([
    record({}, { "copilot_chat.chat_session_id": "a" }),
    record({ spanId: "2".repeat(16) }, { "copilot_chat.chat_session_id": "b" }),
    record({ spanId: "3".repeat(16) }, {
      "gen_ai.conversation.id": undefined, "copilot_chat.parent_chat_session_id": "b",
    }),
  ]);
  const a = recordedReport(view, { readId: view.id, sessionId: view.sessions[0]!.id });
  const b = recordedReport(view, { readId: view.id, sessionId: view.sessions[1]!.id });
  assert.ok(!a.exclusions.some((entry) => entry.reason === "associated-only"));
  assert.ok(b.exclusions.some((entry) => entry.reason === "associated-only"));
  assert.equal(view.sources[0]?.coverage.tokens.status, "complete");
  assert.equal(view.sources[0]?.coverageDetails?.sessionAttribution.status, "partial");
  assert.match(view.issues.map((issue) => issue.message).join(" "), /parent-chat association does not establish own-session identity/);
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

test("optional tool-call IDs distinguish absent, empty and invalid types without coercion or payload diagnostics", async () => {
  const empty = "Tool-call identifier unavailable: empty value";
  const invalid = "Invalid reported gen_ai.tool.call.id: expected a string";
  for (const [value, expected, message] of [
    [undefined, null, null],
    ["", null, empty],
    ["  fictional-call  ", "  fictional-call  ", null],
    [" ", " ", null],
    [null, null, invalid],
    [42, null, invalid],
    [false, null, invalid],
    [["PRIVATE_ID_MARKER"], null, invalid],
    [{ captured: "PRIVATE_ID_MARKER" }, null, invalid],
  ] as const) {
    const raw = record(
      { status: { code: 2 } },
      {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "fictional_tool",
        "gen_ai.tool.call.id": value,
      },
    );
    const view = await read([raw]);
    const event = view.events[0];
    assert.ok(event?.kind === "tool-call");
    assert.equal(event.tool?.callId, expected);
    assert.equal(event.nativeId, "1".repeat(16));
    assert.equal(event.trace?.id, trace);
    assert.equal(event.name, "fictional_tool");
    assert.equal(event.status, "error");
    assert.equal(event.startedAtMs, 1760000000100);
    assert.equal(event.endedAtMs, 1760000001200);
    assert.equal(event.usage?.input, 20);
    assert.equal(event.usage?.output, 5);
    assert.equal(event.usage.basis, "unknown");
    const fieldRef = {
      ...event.references[0],
      location: { kind: "jsonl", line: 1, pointer: "/attributes/gen_ai.tool.call.id" },
    };
    assert.equal(
      event.references.some((ref) => ref.location.pointer === fieldRef.location.pointer),
      value !== undefined,
    );
    assert.deepEqual(view.issues, message === null ? [] : [{
      sourceId: "source-fictional",
      code: "missing-field",
      message: `${message} (1 occurrence(s); first line 1).`,
      ...(message === empty ? { affectsCoverage: false } : {}),
      impact: { scope: "records", dimensions: ["tools"] },
      severity: message === empty ? "info" : "error",
      count: 1,
      references: [fieldRef],
    }]);
    assert.ok(!JSON.stringify(view.issues).includes("PRIVATE_ID_MARKER"));
    assert.equal(view.sources[0]?.coverage.timing.status, "complete");
  }
});

test("two empty-ID tools retain distinct usable executions, original fields and unrelated model usage", async () => {
  const tools = ["1".repeat(16), "2".repeat(16)].map((spanId) =>
    record({ spanId }, {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "fictional_tool",
      "gen_ai.tool.call.id": "",
    }),
  );
  const view = await read([...tools, record({ spanId: "3".repeat(16) })]);
  assert.equal(view.events.length, 3);
  assert.notEqual(view.events[0]?.id, view.events[1]?.id);
  for (const [index, raw] of tools.entries()) {
    const event = view.events[index];
    assert.ok(event?.kind === "tool-call");
    assert.equal(event.tool?.callId, null);
    assert.equal(event.nativeId, raw.spanId);
    assert.ok(event.references.some((ref) =>
      ref.recordId === `sha256:${createHash("sha256").update(JSON.stringify(raw)).digest("hex")}` &&
      ref.location.kind === "jsonl" && ref.location.line === index + 1 &&
      ref.location.pointer === "/attributes/gen_ai.tool.call.id",
    ));
  }
  assert.equal(view.issues.length, 1);
  assert.equal(view.issues[0]?.count, 2);
  const session = view.sessions[0];
  assert.ok(session);
  const metrics = calculateRecordedMetrics(view, { sessionId: session.id });
  assert.equal(metrics.tools.calls.metric.value, 2);
  assert.deepEqual(metrics.tools.identities[0]?.callIds, []);
  assert.equal(metrics.tokens.input.metric.value, 20);
  assert.equal(metrics.tokens.output.metric.value, 5);
  for (const dimension of ["timing", "tools", "tokens"] as const)
    assert.equal(view.sources[0]?.coverage[dimension].status, "complete");
});

test("unavailable tool IDs never replace trace-scoped identity or full-fact duplicate/conflict rules", async () => {
  const empty = record({}, {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "fictional_tool",
    "gen_ai.tool.call.id": "",
  });
  const deduplicated = await read([empty, { ...empty, traceId: otherTrace }, empty]);
  assert.equal(deduplicated.events.length, 2);
  assert.deepEqual(
    deduplicated.events[0]?.references.filter((ref) => ref.location.pointer === "")
      .map((ref) => ref.location.kind === "jsonl" && ref.location.line),
    [1, 3],
  );
  for (const changed of [
    record({}, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "fictional_tool", "gen_ai.tool.call.id": "different-call" }),
    record({}, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "other_tool", "gen_ai.tool.call.id": "" }),
    { ...empty, endTime: [1760000002, 0] },
  ]) {
    for (const records of [[empty, changed], [changed, empty]]) {
      const view = await read(records);
      assert.equal(view.events.length, 0);
      assert.equal(view.sources[0]?.classification?.conflictingSpans, 1);
      const conflict = view.issues.find((issue) =>
        issue.message.startsWith("Conflicting records share a native span identity; excluded"),
      );
      assert.equal(conflict?.code, "unknown-record");
      for (const line of [1, 2])
        assert.ok(conflict?.references?.some((ref) =>
          ref.location.kind === "jsonl" && ref.location.line === line,
        ));
    }
  }
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
    assert.equal(view.sources[0]?.coverage.tokens.status, "complete");
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
