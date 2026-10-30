/** Contract, provenance and synthetic-source checks; no private capture or provider access. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import {
  parseMetric,
  parseReadView,
  selectReader,
  type EvidenceReader,
} from "../src/evidence/contracts.js";
import { exampleReadView } from "./fixtures/read-view.js";

test("facts retain original identities, missing usage and unresolved native parents", () => {
  const view = exampleReadView();
  const [message, call] = view.events;
  assert.ok(message?.kind === "message");
  assert.equal(message.instructionId, "request-1");
  assert.ok(call?.kind === "model-call");
  assert.equal(call.usage?.output, null);
  assert.equal(call.usage?.components[0]?.relation, "subset-of-input");
  assert.equal(call.parentNativeId, "parent-outside-read");
  assert.ok(
    Object.isFrozen(view) &&
      Object.isFrozen(view.events) &&
      Object.isFrozen(call.usage),
  );
});

test("unknown versions and unexpected normalized fields fail instead of being stripped", () => {
  assert.throws(
    () => parseReadView({ ...exampleReadView(), schemaVersion: 2 }),
    z.ZodError,
  );
  assert.throws(
    () => parseReadView({ ...exampleReadView(), tasks: [] }),
    z.ZodError,
  );
});

test("complete controlled evidence retains measured zero separately from missing usage", () => {
  const view = exampleReadView();
  const source = view.sources[0];
  const call = view.events[1];
  assert.ok(source && call?.kind === "model-call" && call.usage);
  const complete = parseReadView({
    ...view,
    sources: [
      {
        ...source,
        coverage: { ...source.coverage, tokens: { status: "complete" } },
      },
    ],
    events: [view.events[0], { ...call, usage: { ...call.usage, output: 0 } }],
    issues: [],
  });
  const measured = complete.events[1];
  assert.ok(measured?.kind === "model-call");
  assert.equal(measured.usage?.output, 0);
  assert.equal(complete.sources[0]?.coverage.tokens.status, "complete");
});

test("read bounds, identities and references are validated", () => {
  const view = exampleReadView();
  for (const invalid of [
    { ...view, finishedAtMs: 999 },
    { ...view, finishedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...view, events: [...view.events, ...view.events] },
    { ...view, sources: [] },
    { ...view, sessions: [] },
    {
      ...view,
      issues: [
        { sourceId: "absent", code: "missing-field", message: "Missing" },
      ],
    },
  ])
    assert.throws(() => parseReadView(invalid), z.ZodError);
});

test("a completely empty read cannot hide a missing or unsupported source", () => {
  assert.throws(
    () =>
      parseReadView({
        ...exampleReadView(),
        sources: [],
        sessions: [],
        events: [],
        issues: [],
      }),
    z.ZodError,
  );
});

test("invalid span bounds and token quantities fail", () => {
  const view = exampleReadView();
  const call = view.events[1];
  assert.ok(call?.kind === "model-call");
  for (const change of [
    { endedAtMs: 900 },
    { startedAtMs: Number.NaN },
    { usage: { basis: "per-call", input: -1, output: 0, components: [] } },
    { usage: { basis: "per-call", input: 1.5, output: 0, components: [] } },
  ])
    assert.throws(
      () => parseReadView({ ...view, events: [{ ...call, ...change }] }),
      z.ZodError,
    );
});

test("changed sources require reduced coverage and an explicit issue", () => {
  const view = exampleReadView();
  const source = view.sources[0];
  assert.ok(source);
  assert.throws(() =>
    parseReadView({
      ...view,
      sources: [{ ...source, changedDuringRead: true }],
    }),
  );
  const partial = { status: "partial", reason: "Source changed during read" };
  const changed = {
    ...view,
    sources: [
      {
        ...source,
        changedDuringRead: true,
        coverage: {
          messages: partial,
          timing: partial,
          tools: partial,
          tokens: partial,
        },
      },
    ],
    issues: [
      { sourceId: source.id, code: "source-changed", message: partial.reason },
    ],
  };
  assert.equal(parseReadView(changed).sources[0]?.changedDuringRead, true);
  assert.throws(() => parseReadView({ ...changed, issues: [] }));
  for (const changedDuringRead of [false, null]) {
    assert.throws(
      () =>
        parseReadView({
          ...changed,
          sources: changed.sources.map((candidate) => ({
            ...candidate,
            changedDuringRead,
          })),
        }),
      z.ZodError,
    );
  }
});

test("unavailable source stays explicit without fake sessions or zero-valued records", () => {
  const source = exampleReadView().sources[0];
  assert.ok(source);
  const unavailable = { status: "unavailable", reason: "Unsupported schema" };
  const view = parseReadView({
    ...exampleReadView(),
    sources: [
      {
        ...source,
        format: null,
        changedDuringRead: null,
        coverage: {
          messages: unavailable,
          timing: unavailable,
          tools: unavailable,
          tokens: unavailable,
        },
      },
    ],
    sessions: [],
    events: [],
    issues: [
      {
        sourceId: source.id,
        code: "unsupported-schema",
        message: unavailable.reason,
      },
    ],
  });
  assert.equal(view.events.length, 0);
  assert.equal(view.sources[0]?.coverage.tokens.status, "unavailable");
  assert.equal(view.sources[0]?.format, null);
  assert.throws(
    () =>
      parseReadView({
        ...exampleReadView(),
        sources: [{ ...source, format: null }],
      }),
    z.ZodError,
  );
});

test("complementary sources keep separate identities and explicit associations", () => {
  const view = exampleReadView();
  const source = view.sources[0];
  const session = view.sessions[0];
  assert.ok(source && session);
  const combined = parseReadView({
    ...view,
    sources: [
      ...view.sources,
      { ...source, id: "conversation", format: "vscode-chat-v3-json" },
    ],
    sessions: [
      { ...session, sourceIds: [...session.sourceIds, "conversation"] },
    ],
  });
  assert.equal(combined.sources.length, 2);
  assert.equal(combined.sessions.length, 1);
  assert.equal(combined.events.length, view.events.length);
});

test("metric units, missing values, contribution scope and stale reads are enforced", () => {
  const view = exampleReadView();
  const reference = view.events[0]?.references[0];
  assert.ok(reference);
  const metric = {
    readId: view.id,
    sessionId: "session-fixture",
    key: "tools.calls",
    basis: "calculated",
    dimension: "tools",
    unit: "count",
    value: 0,
    coverage: { status: "complete" },
    contributors: [reference],
  };
  assert.equal(parseMetric(metric, view).value, 0);
  assert.equal(
    parseMetric(
      {
        ...metric,
        value: null,
        coverage: { status: "unavailable", reason: "Missing" },
        contributors: [],
      },
      view,
    ).value,
    null,
  );
  for (const change of [
    { value: null },
    { value: -1 },
    { value: 0.1 },
    { contributors: [] },
    { value: 0, coverage: { status: "unavailable", reason: "Missing" } },
    { readId: "old-read" },
    { sessionId: "absent" },
    { contributors: [{ ...reference, sourceId: "absent" }] },
  ])
    assert.throws(() => parseMetric({ ...metric, ...change }, view));
  assert.equal(
    parseMetric(
      { ...metric, dimension: "timing", unit: "milliseconds", value: 0.25 },
      view,
    ).value,
    0.25,
  );
});

test("reader extension point rejects missing/ambiguous registration and accepts a controlled adapter", async () => {
  const reader: EvidenceReader = {
    format: "vscode-otel-jsonl",
    async read(context) {
      context.signal.throwIfAborted();
      return parseReadView({ ...exampleReadView(), id: context.readId });
    },
  };
  assert.throws(() => selectReader([], reader.format), /found 0/);
  assert.throws(() => selectReader([reader, reader], reader.format), /found 2/);
  const abort = new AbortController();
  const bytes = (async function* () {
    yield new Uint8Array();
  })();
  const context = {
    readId: "new-read",
    sourceId: "source-fixture",
    bytes,
    signal: abort.signal,
  };
  assert.equal(
    (await selectReader([reader], reader.format).read(context)).id,
    "new-read",
  );
  abort.abort();
  await assert.rejects(reader.read(context), { name: "AbortError" });
});

test("shared-source metrics reject another session, ambiguous events and undeclared roots", () => {
  const base = exampleReadView();
  const session = base.sessions[0];
  const event = base.events[0];
  const original = event?.references[0];
  const root = session?.references[0];
  assert.ok(session && event && original && root);
  const otherReference = {
    ...original,
    recordId: "other-request",
    location: { kind: "jsonl", line: 3, pointer: "" },
  };
  const otherEvent = {
    ...event,
    id: "other-event",
    sessionId: "other-session",
    references: [otherReference],
  };
  const view = parseReadView({
    ...base,
    sessions: [
      ...base.sessions,
      { ...session, id: "other-session", nativeId: "other-native" },
    ],
    events: [...base.events, otherEvent],
  });
  const metric = {
    readId: view.id,
    sessionId: session.id,
    key: "messages",
    basis: "calculated",
    dimension: "messages",
    unit: "count",
    value: 1,
    coverage: { status: "complete" },
    contributors: [original],
  };
  assert.equal(parseMetric(metric, view).value, 1);
  assert.throws(
    () => parseMetric({ ...metric, contributors: [otherReference] }, view),
    /another or ambiguous/,
  );
  assert.throws(
    () =>
      parseMetric(
        {
          ...metric,
          value: 0,
          contributors: [{ ...root, recordId: "invented" }],
        },
        view,
      ),
    /declared/,
  );
  assert.throws(
    () => parseMetric({ ...metric, contributors: [root] }, view),
    /declared/,
  );
  assert.equal(
    parseMetric({ ...metric, value: 0, contributors: [root] }, view).value,
    0,
  );
  assert.equal(
    parseMetric(
      {
        ...metric,
        value: null,
        coverage: { status: "unavailable", reason: "Missing" },
        contributors: [root],
      },
      view,
    ).value,
    null,
  );
  const ambiguous = parseReadView({
    ...view,
    events: [...base.events, { ...otherEvent, references: [original] }],
  });
  assert.throws(() => parseMetric(metric, ambiguous), /another or ambiguous/);
  const unassigned = parseReadView({
    ...base,
    events: [{ ...event, sessionId: null }],
  });
  assert.throws(() => parseMetric(metric, unassigned), /another or ambiguous/);
});

test("zero anchors require complete relevant evidence, not merely another available dimension", () => {
  const base = exampleReadView();
  const source = base.sources[0];
  const session = base.sessions[0];
  assert.ok(source && session);
  const metric = {
    readId: base.id,
    sessionId: session.id,
    key: "tools.calls",
    basis: "calculated",
    dimension: "tools",
    unit: "count",
    value: 0,
    coverage: { status: "complete" },
    contributors: session.references,
  };
  const unavailable = { status: "unavailable", reason: "Unsupported input" };
  const unknown = parseReadView({
    ...base,
    sources: [
      {
        ...source,
        format: null,
        changedDuringRead: null,
        coverage: {
          messages: unavailable,
          timing: unavailable,
          tools: unavailable,
          tokens: unavailable,
        },
      },
    ],
    events: [],
    issues: [
      {
        sourceId: source.id,
        code: "unsupported-schema",
        message: unavailable.reason,
      },
    ],
  });
  assert.throws(() => parseMetric(metric, unknown), /unavailable/);
  assert.equal(
    parseMetric({ ...metric, value: null, coverage: unavailable }, unknown)
      .value,
    null,
  );
  for (const tools of [
    unavailable,
    { status: "partial", reason: "Missing tail" },
  ]) {
    const incomplete = parseReadView({
      ...base,
      sources: [{ ...source, coverage: { ...source.coverage, tools } }],
      events: [],
    });
    assert.throws(
      () => parseMetric(metric, incomplete),
      /unavailable|complete evidence/,
    );
    assert.throws(() =>
      parseMetric(
        { ...metric, coverage: { status: "partial", reason: "Missing tail" } },
        incomplete,
      ),
    );
  }
  const missingTools = parseReadView({
    ...base,
    sources: [
      { ...source, coverage: { ...source.coverage, tools: unavailable } },
    ],
  });
  const eventReference = base.events[0]?.references[0];
  assert.ok(eventReference);
  assert.throws(
    () =>
      parseMetric({ ...metric, contributors: [eventReference] }, missingTools),
    /unavailable/,
  );
  const emptyComplete = parseReadView({ ...base, events: [], issues: [] });
  assert.equal(parseMetric(metric, emptyComplete).value, 0);
});

test("many-session reads preserve ID-based event associations", () => {
  const base = exampleReadView();
  const session = base.sessions[0];
  const event = base.events[0];
  assert.ok(session && event);
  const sessions = Array.from({ length: 200 }, (_, index) => ({
    ...session,
    id: `session-${index}`,
    nativeId: `native-session-${index}`,
    references: [
      {
        sourceId: "source-fixture",
        recordId: `session-header-${index}`,
        location: { kind: "jsonl", line: index + 1, pointer: "" },
      },
    ],
  }));
  const events = Array.from({ length: 2000 }, (_, index) => ({
    ...event,
    id: `event-${index}`,
    nativeId: `native-event-${index}`,
    sessionId: `session-${index % 200}`,
    references: [
      {
        sourceId: "source-fixture",
        recordId: `event-record-${index}`,
        location: { kind: "jsonl", line: index + 201, pointer: "" },
      },
    ],
  }));
  const view = parseReadView({ ...base, sessions, events });
  assert.equal(view.sessions.length, 200);
  assert.equal(view.events[1999]?.sessionId, "session-199");
  assert.throws(
    () =>
      parseReadView({
        ...view,
        events: [
          ...view.events,
          { ...event, id: "invalid-event", sessionId: "missing" },
        ],
      }),
    z.ZodError,
  );
});

test("source locators reject malformed pointers and nonpositive line numbers", () => {
  const view = exampleReadView();
  const event = view.events[0];
  assert.ok(event);
  for (const location of [
    { kind: "jsonl", line: 0, pointer: "" },
    { kind: "json", pointer: "requests/0" },
    { kind: "json", pointer: "/bad~escape" },
  ])
    assert.throws(() =>
      parseReadView({
        ...view,
        events: [
          {
            ...event,
            references: [
              { sourceId: "source-fixture", recordId: "request-1", location },
            ],
          },
        ],
      }),
    );
});

test("controlled source fixtures preserve distinct envelopes and intentional incomplete/unknown cases", async () => {
  const directory = new URL("../../tests/fixtures/", import.meta.url);
  const spanLines = (await readFile(new URL("otel.jsonl", directory), "utf8"))
    .trim()
    .split("\n");
  const spans: unknown[] = spanLines.map((line) => JSON.parse(line));
  const envelope = z.object({
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
    spanId: z.string().regex(/^[0-9a-f]{16}$/),
    startTime: z.tuple([
      z.number().int(),
      z.number().int().min(0).max(999999999),
    ]),
    endTime: z.tuple([
      z.number().int(),
      z.number().int().min(0).max(999999999),
    ]),
    attributes: z.record(z.string(), z.unknown()),
  });
  spans.forEach((span) => envelope.parse(span));
  const chat = z
    .object({
      version: z.literal(3),
      sessionId: z.string(),
      requests: z.array(z.object({ requestId: z.string() })).min(1),
    })
    .parse(
      JSON.parse(await readFile(new URL("chat-v3.json", directory), "utf8")),
    );
  assert.equal(chat.version, 3);
  assert.equal(chat.requests[0]?.requestId, "request-1");
  const operations = z
    .array(z.object({ kind: z.number(), v: z.unknown().optional() }))
    .parse(
      (await readFile(new URL("chat-mutations.jsonl", directory), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  assert.deepEqual(
    operations.map((entry) => entry.kind),
    [0, 2, 1, 3],
  );
  const initial = z.object({ sessionId: z.string() }).parse(operations[0]?.v);
  const appended = z
    .array(z.object({ requestId: z.string() }))
    .min(1)
    .parse(operations[1]?.v);
  assert.equal(initial.sessionId, chat.sessionId);
  assert.equal(appended[0]?.requestId, chat.requests[0]?.requestId);
  const incomplete = (
    await readFile(new URL("incomplete.jsonl", directory), "utf8")
  )
    .trim()
    .split("\n");
  assert.doesNotThrow(() => JSON.parse(incomplete[0] ?? ""));
  assert.throws(() => JSON.parse(incomplete[1] ?? ""), SyntaxError);
  const unknown = z
    .object({ version: z.number() })
    .parse(
      JSON.parse(await readFile(new URL("unknown.json", directory), "utf8")),
    );
  assert.equal(unknown.version, 999);
});
