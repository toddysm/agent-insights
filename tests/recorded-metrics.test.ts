/** Exact synthetic arithmetic, provenance and accounting regressions; no source or model access. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMetric,
  parseReadView,
  type EvidenceReference,
  type ReadView,
} from "../src/evidence/contracts.js";
import {
  calculateRecordedMetrics,
  type RecordedMetric,
  type RecordedMetrics,
} from "../src/metrics/recorded.js";
import { exampleReadView } from "./fixtures/read-view.js";

/** Synthetic execution shape; test changes remain subject to normal read validation. */
type Execution = Exclude<ReadView["events"][number], { kind: "message" }>;

/** Return a fresh original JSONL locator with no private capture content. */
function reference(id: string, line = 2): EvidenceReference {
  return {
    sourceId: "source-fixture",
    recordId: id,
    location: { kind: "jsonl", line, pointer: "" },
  };
}

/** Build a complete 60-second synthetic execution; overrides model partial/native cases. */
function execution(id: string, changes: Partial<Execution> = {}): Execution {
  return {
    id,
    kind: "model-call",
    nativeId: id,
    sessionId: "session-fixture",
    parentNativeId: null,
    references: [reference(id)],
    name: "synthetic-model",
    startedAtMs: 0,
    endedAtMs: 60_000,
    status: "ok",
    usage: { basis: "per-call", input: 20, output: 5, components: [] },
    ...changes,
  };
}

/** Validate a new bounded read with complete dimension coverage unless explicitly overridden. */
function read(
  events: ReadView["events"],
  changes: Partial<ReadView> = {},
): ReadView {
  const base = exampleReadView();
  return parseReadView({
    ...base,
    sources: base.sources.map((source) => ({
      ...source,
      coverage: {
        messages: { status: "complete" },
        timing: { status: "complete" },
        tools: { status: "complete" },
        tokens: { status: "complete" },
      },
    })),
    events,
    issues: [],
    ...changes,
  });
}

/** Select the fixture session without guessing scope from timestamps or text. */
function calculate(
  view: ReadView,
  eventIds?: readonly string[],
): RecordedMetrics {
  return calculateRecordedMetrics(view, {
    sessionId: "session-fixture",
    ...(eventIds === undefined ? {} : { eventIds }),
  });
}

/** Enumerate every returned number, including identity/component/observation drill-down metrics. */
function measurements(result: RecordedMetrics): RecordedMetric[] {
  return [
    ...Object.values(result.timing),
    result.tools.calls,
    ...result.tools.identities.map((identity) => identity.calls),
    result.tokens.input,
    result.tokens.output,
    ...result.tokens.components.map((component) => component.tokens),
    ...result.tokens.observations.flatMap((observation) => [
      observation.input,
      observation.output,
      ...observation.components.map((component) => component.tokens),
    ]),
  ];
}

test("overlapping 60-second spans yield 60 elapsed/activity and 120 cumulative seconds", () => {
  const view = read([
    execution("parent"),
    execution("child", { parentNativeId: "parent" }),
  ]);
  const result = calculate(view);
  assert.equal(result.timing.elapsed.metric.value, 60_000);
  assert.equal(result.timing.agentActivity.metric.value, 60_000);
  assert.equal(result.timing.cumulativeSpanDuration.metric.value, 120_000);
  assert.equal(result.timing.unobservedGaps.metric.value, 0);
  assert.equal(result.tokens.input.metric.value, 40);
  assert.deepEqual(result.readBounds, {
    startedAtMs: view.startedAtMs,
    finishedAtMs: view.finishedAtMs,
  });
  for (const { metric, scope, definition } of measurements(result)) {
    assert.deepEqual(parseMetric(metric, view), metric);
    assert.equal(scope.sessionId, "session-fixture");
    assert.equal(scope.kind, "session");
    assert.ok(definition.length > 0);
  }
});

test("nested/parallel intervals and observed message boundaries leave unobserved, not idle, gaps", () => {
  const message = exampleReadView().events[0]!;
  assert.equal(message.kind, "message");
  const result = calculate(
    read([
      { ...message, timestampMs: 0 },
      execution("outer", { startedAtMs: 10, endedAtMs: 30 }),
      execution("nested", { startedAtMs: 15, endedAtMs: 20 }),
      execution("parallel", { startedAtMs: 25, endedAtMs: 40 }),
      execution("later", { startedAtMs: 50, endedAtMs: 60 }),
    ]),
  );
  assert.equal(result.timing.elapsed.metric.value, 60);
  assert.equal(result.timing.agentActivity.metric.value, 40);
  assert.equal(result.timing.cumulativeSpanDuration.metric.value, 50);
  assert.equal(result.timing.unobservedGaps.metric.value, 20);
});

test("identical replayed native evidence and repeated selected IDs preserve totals and every locator", () => {
  const original = execution("call");
  const replay = {
    ...original,
    id: "replay",
    references: [reference("call", 3)],
  };
  const view = read([original, replay]);
  const whole = calculate(view);
  const subset = calculate(view, ["call", "replay", "call"]);
  for (const result of [whole, subset]) {
    assert.equal(result.timing.cumulativeSpanDuration.metric.value, 60_000);
    assert.equal(result.tokens.input.metric.value, 20);
    assert.equal(result.tokens.input.metric.contributors.length, 2);
    assert.deepEqual(
      parseMetric(result.tokens.input.metric, view),
      result.tokens.input.metric,
    );
  }
  assert.deepEqual(subset.scope.eventIds, ["call", "replay"]);
});

test("same trace/span across source exports deduplicates, but separate trace scopes do not", () => {
  const original = execution("call", {
    trace: { id: "trace-a", parentId: null },
  });
  const base = read([]);
  const otherSource = { ...base.sources[0]!, id: "second" };
  const replay = {
    ...original,
    id: "replay",
    references: [{ ...reference("call"), sourceId: "second" }],
  };
  const view = read([original, replay], {
    sources: [...base.sources, otherSource],
    sessions: base.sessions.map((session) => ({
      ...session,
      sourceIds: [...session.sourceIds, "second"],
    })),
  });
  assert.equal(calculate(view).tokens.input.metric.value, 20);
  const separate = read([
    original,
    {
      ...original,
      id: "second",
      references: [reference("other-trace")],
      trace: { id: "trace-b", parentId: null },
    },
  ]);
  assert.equal(calculate(separate).tokens.input.metric.value, 40);
});

test("conflicting replays poison the identity even when a subset selects only one copy", () => {
  const original = execution("call");
  const view = read([
    original,
    { ...original, id: "conflict", endedAtMs: 70_000 },
  ]);
  const result = calculate(view, ["call"]);
  assert.equal(result.timing.agentActivity.metric.value, null);
  assert.equal(result.tokens.input.metric.value, null);
  assert.equal(result.exclusions[0]?.reason, "conflicting-replay");
});

test("per-call usage excludes parent/unknown/cumulative observations and preserves component overlaps", () => {
  const view = read([
    execution("call", {
      usage: {
        basis: "per-call",
        input: 100,
        output: 30,
        components: [
          { name: "cache", value: 40, relation: "subset-of-input" },
          { name: "cache", value: 40, relation: "subset-of-input" },
          { name: "reasoning", value: 10, relation: "subset-of-output" },
          { name: "extra", value: 7, relation: "additional" },
          { name: "unqualified", value: 8, relation: "unknown" },
        ],
      },
    }),
    execution("parent", {
      kind: "agent-span",
      usage: { basis: "cumulative", input: 1000, output: 300, components: [] },
    }),
    execution("snapshot", {
      kind: "usage-observation",
      usage: { basis: "cumulative", input: 1000, output: 300, components: [] },
      observation: {
        scope: "session-snapshot",
        model: "synthetic-model",
        additive: false,
      },
    }),
  ]);
  const result = calculate(view);
  assert.equal(result.tokens.input.metric.value, 100);
  assert.equal(result.tokens.output.metric.value, 30);
  assert.deepEqual(
    result.tokens.components.map((component) => [
      component.name,
      component.relation,
      component.tokens.metric.value,
    ]),
    [
      ["cache", "subset-of-input", 40],
      ["reasoning", "subset-of-output", 10],
      ["extra", "additional", 7],
      ["unqualified", "unknown", 8],
    ],
  );
  assert.equal(result.tokens.observations.length, 2);
  assert.equal(result.tokens.observations[1]?.input.metric.value, 1000);
  for (const { metric } of measurements(result))
    assert.deepEqual(parseMetric(metric, view), metric);
});

test("native whole/direct-turn, assistant-output and shutdown reports are never summed", () => {
  const scopes = [
    "turn-inclusive",
    "turn-direct",
    "assistant-output",
    "session-snapshot",
  ] as const;
  const view = read(
    scopes.map((scope, index) =>
      execution(`observation-${index}`, {
        kind: "usage-observation",
        startedAtMs: null,
        endedAtMs: null,
        observation: { scope, model: "model", additive: false },
        usage: {
          basis: "cumulative",
          input: index === 2 ? null : 100,
          output: 10,
          components: [],
        },
      }),
    ),
  );
  const result = calculate(view);
  assert.equal(result.tokens.input.metric.value, null);
  assert.equal(result.tokens.output.metric.value, null);
  assert.equal(result.timing.elapsed.metric.value, null);
  assert.equal(result.tokens.observations.length, 4);
  assert.equal(result.tokens.observations[2]?.input.metric.value, null);
  assert.equal(result.tokens.observations[3]?.output.metric.value, 10);
});

test("missing usage remains unavailable; partial usage and actual zero remain distinct", () => {
  const missing = execution("missing", { usage: null });
  const result = calculate(
    read([
      missing,
      execution("measured", {
        usage: { basis: "per-call", input: 0, output: null, components: [] },
      }),
    ]),
  );
  assert.equal(result.tokens.input.metric.value, 0);
  assert.equal(result.tokens.input.metric.coverage.status, "partial");
  assert.equal(result.tokens.output.metric.value, null);
  assert.equal(result.tokens.output.metric.coverage.status, "unavailable");
  assert.equal(calculate(read([missing])).tokens.input.metric.value, null);
});

test("missing timing boundaries do not become zero activity, and partial spans retain observed boundaries", () => {
  const incomplete = execution("incomplete", {
    startedAtMs: 80_000,
    endedAtMs: null,
    usage: null,
  });
  const result = calculate(read([execution("complete"), incomplete]));
  assert.equal(result.timing.elapsed.metric.value, 80_000);
  assert.equal(result.timing.agentActivity.metric.value, 60_000);
  assert.equal(result.timing.agentActivity.metric.coverage.status, "partial");
  const absent = calculate(
    read([execution("absent", { startedAtMs: null, endedAtMs: null })]),
  );
  assert.equal(absent.timing.agentActivity.metric.value, null);
  assert.equal(absent.timing.elapsed.metric.value, null);
});

test("tool identities include unknown names and missing optional IDs, without counting wrappers/turns/hooks", () => {
  const normal = execution("tool", {
    kind: "tool-call",
    name: "read",
    usage: null,
    tool: { name: "read", callId: null },
  });
  const view = read([
    normal,
    { ...normal, id: "replay", references: [reference("tool", 4)] },
    execution("unknown", {
      kind: "tool-call",
      name: null,
      nativeId: null,
      usage: null,
    }),
    execution("hook", { kind: "hook-execution", usage: null }),
    execution("turn", {
      kind: "assistant-turn",
      usage: null,
      startedAtMs: 0,
      endedAtMs: 90_000,
    }),
    execution("wrapper", {
      kind: "tool-call",
      usage: null,
      nativeExecution: {
        eventIds: ["start"],
        parentEventIds: [],
        agentId: null,
        turnId: null,
        toolCallId: "agent",
        parentToolCallId: null,
        parentAgentTaskId: null,
        completeness: "complete",
        accounting: "bridge-wrapper",
        cancelled: null,
      },
    }),
  ]);
  const result = calculate(view);
  assert.equal(result.tools.calls.metric.value, 2);
  assert.deepEqual(
    result.tools.identities.map((entry) => [
      entry.name,
      entry.calls.metric.value,
    ]),
    [
      ["read", 1],
      [null, 1],
    ],
  );
  assert.equal(result.exclusions[0]?.reason, "bridge-wrapper");
  assert.deepEqual(result.tools.identities[0]?.callIds, []);
  assert.equal(result.timing.agentActivity.metric.value, 60_000);
  assert.equal(result.timing.elapsed.metric.value, 90_000);
});

test("complete source anchors permit observed zero tools, not fabricated zeros for empty subsets or partial sources", () => {
  const complete = read([]);
  assert.equal(calculate(complete).tools.calls.metric.value, 0);
  assert.deepEqual(
    parseMetric(calculate(complete).tools.calls.metric, complete),
    calculate(complete).tools.calls.metric,
  );
  assert.equal(calculate(complete, []).tools.calls.metric.value, null);
  const partial = read([], {
    sources: complete.sources.map((source) => ({
      ...source,
      coverage: {
        ...source.coverage,
        tools: { status: "partial", reason: "Truncated source" },
      },
    })),
  });
  assert.equal(calculate(partial).tools.calls.metric.value, null);
  assert.equal(calculate(partial).tokens.input.metric.value, null);
  const sharedAnchor = read([], {
    sessions: [
      ...complete.sessions,
      { ...complete.sessions[0]!, id: "another-session" },
    ],
  });
  assert.equal(calculate(sharedAnchor).tools.calls.metric.value, null);
});

test("evidence-attributed subsets do not clip intervals or include unselected parallel activity", () => {
  const view = read([
    execution("first"),
    execution("second", { startedAtMs: 30_000, endedAtMs: 90_000 }),
  ]);
  const result = calculate(view, ["second"]);
  assert.equal(result.scope.kind, "events");
  assert.deepEqual(result.scope.eventIds, ["second"]);
  assert.equal(result.timing.observedStart.metric.value, 30_000);
  assert.equal(result.timing.agentActivity.metric.value, 60_000);
  assert.equal(result.tokens.input.metric.value, 20);
  assert.throws(() => calculate(view, ["absent"]), /unknown or foreign/);
  assert.throws(
    () => calculateRecordedMetrics(view, { sessionId: "absent" }),
    /current read/,
  );
});

test("unassigned and shared evidence stay explicit and cannot contaminate attributed totals", () => {
  const attributed = execution("valid");
  const shared = execution("shared", { references: [reference("shared", 5)] });
  const base = read([]);
  const view = read(
    [
      attributed,
      shared,
      { ...shared, id: "other", sessionId: "other-session" },
      execution("unassigned", { sessionId: null }),
    ],
    {
      sessions: [
        ...base.sessions,
        { ...base.sessions[0]!, id: "other-session" },
      ],
    },
  );
  const result = calculate(view);
  assert.equal(result.tokens.input.metric.value, 20);
  assert.equal(result.tokens.input.metric.coverage.status, "partial");
  assert.equal(result.exclusions.length, 2);
  assert.ok(
    result.exclusions.every(
      (entry) => entry.reason === "ambiguous-attribution",
    ),
  );
  for (const { metric } of measurements(result))
    assert.deepEqual(parseMetric(metric, view), metric);
  assert.equal(calculate(view, ["unassigned"]).tokens.input.metric.value, null);
  assert.throws(() => calculate(view, ["other"]), /foreign/);
});

test("partial/changing source coverage cannot produce complete metrics", () => {
  const base = exampleReadView();
  const partial = {
    status: "partial" as const,
    reason: "Source changed during read",
  };
  const view = read([execution("call")], {
    sources: base.sources.map((source) => ({
      ...source,
      changedDuringRead: true,
      coverage: {
        messages: partial,
        timing: partial,
        tools: partial,
        tokens: partial,
      },
    })),
    issues: [
      {
        sourceId: "source-fixture",
        code: "source-changed",
        message: partial.reason,
      },
    ],
  });
  for (const { metric } of measurements(calculate(view))) {
    assert.notEqual(metric.coverage.status, "complete");
    assert.deepEqual(parseMetric(metric, view), metric);
  }
});

test("conflicting components and impossible subsets stay unavailable rather than counting twice", () => {
  const result = calculate(
    read([
      execution("call", {
        usage: {
          basis: "per-call",
          input: 20,
          output: 5,
          components: [
            { name: "cache", value: 5, relation: "subset-of-input" },
            { name: "cache", value: 6, relation: "subset-of-input" },
            { name: "reasoning", value: 6, relation: "subset-of-output" },
          ],
        },
      }),
    ]),
  );
  assert.equal(result.tokens.input.metric.value, 20);
  assert.ok(
    result.tokens.components.every(
      (component) => component.tokens.metric.value === null,
    ),
  );
});

test("one original record cannot establish two conflicting native identities", () => {
  const first = execution("first");
  const view = read([first, { ...first, id: "second", nativeId: "different" }]);
  const result = calculate(view);
  assert.equal(result.tokens.input.metric.value, null);
  assert.equal(result.exclusions[0]?.reason, "conflicting-replay");
});

test("unavailable dimension evidence cannot turn into a complete zero through a complementary source", () => {
  const base = read([]);
  const tool = execution("tool", { kind: "tool-call", usage: null });
  const view = read([tool], {
    sources: [
      ...base.sources.map((source) => ({
        ...source,
        coverage: {
          ...source.coverage,
          tools: {
            status: "unavailable" as const,
            reason: "Unavailable tools",
          },
        },
      })),
      { ...base.sources[0]!, id: "complementary" },
    ],
    sessions: base.sessions.map((session) => ({
      ...session,
      sourceIds: [...session.sourceIds, "complementary"],
      references: [
        ...session.references,
        { ...reference("root"), sourceId: "complementary" },
      ],
    })),
  });
  assert.equal(calculate(view).tools.calls.metric.value, null);
  const measured = parseReadView({
    ...view,
    events: [
      ...view.events,
      {
        ...tool,
        id: "measured",
        nativeId: "measured",
        references: [{ ...reference("measured"), sourceId: "complementary" }],
      },
    ],
  });
  assert.equal(calculate(measured).tools.calls.metric.value, 1);
  assert.equal(
    calculate(measured).tools.calls.metric.coverage.status,
    "partial",
  );
  assert.equal(
    calculate(measured).tools.identities[0]?.calls.metric.coverage.status,
    "partial",
  );
});

test("unavailable session sources limit positive metrics and source-anchored zeros even without events", () => {
  const base = read([]);
  const unavailable = {
    status: "unavailable" as const,
    reason: "Source was not captured",
  };
  const view = read([execution("call")], {
    sources: [
      ...base.sources,
      {
        ...base.sources[0]!,
        id: "uncaptured",
        coverage: {
          messages: unavailable,
          timing: unavailable,
          tools: unavailable,
          tokens: unavailable,
        },
      },
    ],
    sessions: base.sessions.map((session) => ({
      ...session,
      sourceIds: [...session.sourceIds, "uncaptured"],
    })),
  });
  const result = calculate(view);
  assert.equal(result.tokens.input.metric.value, 20);
  assert.equal(result.tokens.input.metric.coverage.status, "partial");
  assert.equal(result.timing.agentActivity.metric.coverage.status, "partial");
  assert.equal(result.tools.calls.metric.value, null);
});

test("unsafe sums are unavailable and fractional milliseconds are preserved", () => {
  const result = calculate(
    read([
      execution("one", {
        startedAtMs: 0.25,
        endedAtMs: 1.5,
        usage: {
          basis: "per-call",
          input: Number.MAX_SAFE_INTEGER,
          output: 0,
          components: [],
        },
      }),
      execution("two", {
        startedAtMs: 0.75,
        endedAtMs: 2,
        usage: { basis: "per-call", input: 1, output: 0, components: [] },
      }),
    ]),
  );
  assert.equal(result.tokens.input.metric.value, null);
  assert.match(
    result.tokens.input.metric.coverage.status === "unavailable"
      ? result.tokens.input.metric.coverage.reason
      : "",
    /safe integer/,
  );
  assert.equal(result.tokens.output.metric.value, 0);
  assert.equal(result.timing.agentActivity.metric.value, 1.75);
  assert.equal(result.timing.cumulativeSpanDuration.metric.value, 2.5);
});

test("175,000 original session anchors preserve zero and unavailable metrics without VM argument overflow", () => {
  const base = read([]);
  const references = Array.from({ length: 175_000 }, (_, index) =>
    reference("large-session", index + 1),
  );
  const view = read([], {
    sessions: base.sessions.map((session) => ({
      ...session,
      references,
    })),
  });
  const result = calculate(view);
  assert.equal(result.tools.calls.metric.value, 0);
  assert.equal(result.tools.calls.metric.contributors.length, 175_000);
  assert.equal(result.tokens.input.metric.value, null);
  assert.equal(result.tokens.input.metric.contributors.length, 175_000);
});

test("usage reports do not relabel tool, agent, hook or generic span names as model identities", () => {
  const usage = {
    basis: "unknown" as const,
    input: 20,
    output: 5,
    components: [],
  };
  const kinds = [
    "agent-span",
    "tool-call",
    "hook-execution",
    "model-call",
  ] as const;
  const result = calculate(
    read([
      ...kinds.map((kind) =>
        execution(kind, { kind, name: "operation-name", usage }),
      ),
      execution("reported-model", {
        kind: "agent-span",
        name: "worker",
        usage,
        model: { requested: "requested-model", responded: "responded-model" },
      }),
      execution("requested-model", {
        kind: "agent-span",
        name: "worker",
        usage,
        model: { requested: "requested-model", responded: null },
      }),
    ]),
  );
  assert.deepEqual(
    result.tokens.observations.map((observation) => observation.model),
    [null, null, null, null, "responded-model", "requested-model"],
  );
});

test("native message replays preserve one timing boundary and poison conflicting timestamps", () => {
  const message = exampleReadView().events[0]!;
  assert.ok(message.kind === "message");
  const replay = {
    ...message,
    id: "message-replay",
    references: [reference("message-replay", 3)],
  };
  const view = read([message, replay]);
  for (const result of [calculate(view), calculate(view, [message.id])]) {
    assert.equal(result.timing.elapsed.metric.value, null);
    assert.equal(result.timing.observedStart.metric.value, message.timestampMs);
    assert.equal(result.timing.observedStart.metric.contributors.length, 2);
  }
  const conflict = calculate(read([message, { ...replay, timestampMs: 950 }]));
  assert.equal(conflict.timing.elapsed.metric.value, null);
  assert.equal(conflict.timing.observedStart.metric.value, null);
  assert.equal(conflict.exclusions[0]?.reason, "conflicting-replay");
});

test("fractional touching intervals cannot round activity beyond elapsed or create negative gaps", () => {
  for (const [intervals, expected] of [
    [
      [
        [0.1, 0.2],
        [0.2, 1.1],
      ],
      1,
    ],
    [
      [
        [0, 0.1],
        [0.1, 0.2],
        [0.2, 0.3],
        [0.3, 0.9],
      ],
      0.9,
    ],
  ] as const) {
    const result = calculate(
      read(
        intervals.map(([start, end], index) =>
          execution(`fractional-${index}`, {
            startedAtMs: start,
            endedAtMs: end,
          }),
        ),
      ),
    );
    assert.equal(result.timing.elapsed.metric.value, expected);
    assert.equal(result.timing.agentActivity.metric.value, expected);
    assert.equal(result.timing.unobservedGaps.metric.value, 0);
  }
});
