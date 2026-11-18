/** Native-reader-to-report provenance, exact navigation and authenticated runtime regressions. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { recordedReport } from "../src/runtime/report.js";
import { sessionReportSchema } from "../src/metrics/report.js";
import {
  parseMetric,
  parseReadView,
  evidenceReferenceKey,
} from "../src/evidence/contracts.js";
import {
  contributingEvents,
  unmatchedReferences,
  parseReportHash,
  reportHash,
} from "../src/web/report-navigation.js";
import {
  nativeReportView,
  nativeReportRecords,
} from "./fixtures/native-report.js";
import { exampleReadView } from "./fixtures/read-view.js";
import { syntheticReader } from "./fixtures/analysis.js";
import { startRuntime } from "../src/runtime/server.js";

test("Agent Host messages and executions flow through the real readers and calculator to exact anchors", async () => {
  const view = await nativeReportView();
  const sessionId = view.sessions[0]!.id;
  assert.equal(view.sources[0]?.identity.executionHost, "agent-host");
  const result = sessionReportSchema.parse(
    recordedReport(view, { readId: view.id, sessionId }),
  );
  const tools = result.measurements.find((entry) => entry.id === "tools")!;
  assert.equal(tools.metric.value, 2);
  assert.equal(
    result.measurements.find((entry) => entry.id === "activity")?.metric.value,
    5000,
  );
  assert.equal(
    result.measurements.find((entry) => entry.id === "cumulative")?.metric
      .value,
    7000,
  );
  assert.equal(
    result.measurements.find((entry) => entry.id === "input")?.metric.value,
    null,
  );
  const observation = result.measurements.find(
    (entry) =>
      entry.group === "Usage observations" && entry.metric.value === 20,
  )!;
  assert.ok(observation.label.includes("session-snapshot"));
  assert.ok(
    observation.metric.contributors.some(
      (reference) =>
        reference.location.pointer ===
        "/data/modelMetrics/fictional-model/usage",
    ),
  );
  for (const entry of result.measurements)
    assert.deepEqual(parseMetric(entry.metric, view), entry.metric);
  const contributors = contributingEvents(view, sessionId, tools);
  assert.deepEqual(contributors.map((event) => event.nativeId).sort(), [
    "read-call",
    "shell-call",
  ]);
  const shell = contributors.find((event) => event.nativeId === "shell-call")!;
  assert.deepEqual(
    shell.references.map((reference) =>
      reference.location.kind === "jsonl" ? reference.location.line : null,
    ),
    [4, 7],
  );
  assert.equal(
    shell.kind !== "message" &&
      shell.content?.toolArguments?.includes("printf"),
    true,
  );
  const start = result.measurements.find((entry) => entry.id === "start")!;
  assert.ok(
    contributingEvents(view, sessionId, start).some(
      (event) => event.kind === "message",
    ),
  );
  assert.ok(
    result.measurements.every((entry) => entry.metric.readId === view.id),
  );
});

test("partial, missing and wrong-runtime native sources never become complete reports or fabricated sessions", async () => {
  const raw = nativeReportRecords()
    .map((item) => JSON.stringify(item))
    .join("\n");
  const partial = await nativeReportView({ raw: `${raw}\n{"broken":` });
  assert.ok(partial.issues.length > 0);
  const report = recordedReport(partial, {
    readId: partial.id,
    sessionId: partial.sessions[0]!.id,
  });
  assert.notEqual(
    report.measurements.find((entry) => entry.id === "tools")?.metric.coverage
      .status,
    "complete",
  );
  for (const view of [
    await nativeReportView({ catalogAvailable: false }),
    await nativeReportView({ raw: "" }),
    await nativeReportView({
      raw: '{"traceId":"extension-export-not-agent-host"}\n',
    }),
  ]) {
    assert.equal(view.sessions.length, 0);
    assert.throws(
      () => recordedReport(view, { readId: view.id, sessionId: "invented" }),
      { code: "REPORT_SESSION_UNAVAILABLE" },
    );
  }
});

test("unknown, duplicate, foreign and stale navigation cannot fall back to another record", () => {
  const view = exampleReadView();
  const report = recordedReport(view, {
    readId: view.id,
    sessionId: "session-fixture",
  });
  const input = report.measurements.find((entry) => entry.id === "input")!;
  const foreign = {
    ...view.events[1]!,
    id: "foreign",
    sessionId: "other-session",
  };
  const expanded = parseReadView({
    ...view,
    sessions: [...view.sessions, { ...view.sessions[0]!, id: "other-session" }],
    events: [
      ...view.events,
      foreign,
      { ...view.events[1]!, id: "shared-anchor-outside-scope" },
    ],
  });
  assert.deepEqual(
    contributingEvents(expanded, "session-fixture", {
      ...input,
      scope: {
        sessionId: "session-fixture",
        kind: "events",
        eventIds: ["call-fixture"],
      },
    }).map((event) => event.id),
    ["call-fixture"],
  );
  const altered = {
    ...input,
    metric: {
      ...input.metric,
      contributors: input.metric.contributors.map((reference) => ({
        ...reference,
        recordId: "unknown",
      })),
    },
  };
  assert.deepEqual(contributingEvents(view, "session-fixture", altered), []);
  assert.equal(
    unmatchedReferences(view, "session-fixture", altered.metric.contributors)
      .length,
    1,
  );
  assert.notEqual(
    evidenceReferenceKey(input.metric.contributors[0]!),
    evidenceReferenceKey(altered.metric.contributors[0]!),
  );
  assert.throws(
    () =>
      recordedReport(null, { readId: view.id, sessionId: "session-fixture" }),
    { code: "REPORT_STALE" },
  );
  assert.throws(
    () =>
      recordedReport(view, { readId: "older", sessionId: "session-fixture" }),
    { code: "REPORT_STALE" },
  );
  const route = {
    readId: view.id,
    sessionId: "session-fixture",
    panel: "event" as const,
    id: "id&=?#",
    from: "input",
  };
  assert.deepEqual(parseReportHash(reportHash(route)), route);
  assert.equal(parseReportHash("#session-report"), null);
  assert.throws(() =>
    parseReportHash("#report?read=a&read=b&session=s&panel=event"),
  );
  assert.throws(() =>
    parseReportHash("#report?read=a&session=s&panel=unknown"),
  );
  assert.throws(() =>
    parseReportHash("#report?read=a&session=s&panel=coverage&id=unknown"),
  );
  assert.throws(() =>
    parseReportHash(
      "#report?read=a&session=s&panel=metric&id=input&from=foreign",
    ),
  );
});

test("report endpoint requires access/origin, rejects invalid scope and invalidates on refresh", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-insights-report-"));
  const source = path.join(root, "fixture.jsonl");
  await writeFile(source, "SYNTHETIC");
  const runtime = await startRuntime(
    {
      sources: [source],
      port: 0,
      harness: "copilot",
      model: null,
      copilotPath: null,
    },
    { readers: [syntheticReader] },
  );
  /** Post controlled test selections; credentials are held only inside this runtime-owned closure. */
  const post = (route: string, body: unknown, access = true, origin = true) =>
    fetch(`${runtime.origin}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(access ? { "X-Agent-Insights-Token": runtime.token } : {}),
        ...(origin ? { Origin: runtime.origin } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const view = parseReadView(
      await (
        await post("/api/read", {
          sourceId: "source-1",
          relativePath: "",
          format: "vscode-otel-jsonl",
        })
      ).json(),
    );
    const selection = { readId: view.id, sessionId: "session-fixture" };
    assert.equal((await post("/api/report", selection, false)).status, 401);
    assert.equal(
      (await post("/api/report", selection, true, false)).status,
      403,
    );
    assert.equal(
      (await post("/api/report", { ...selection, eventIds: ["anything"] }))
        .status,
      400,
    );
    assert.equal(
      (await post("/api/report", { ...selection, sessionId: "foreign" }))
        .status,
      404,
    );
    const response = await post("/api/report", selection);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(
      sessionReportSchema
        .parse(await response.json())
        .measurements.find((entry) => entry.id === "input")?.metric.value,
      20,
    );
    await post("/api/refresh", {});
    assert.equal((await post("/api/report", selection)).status, 409);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
