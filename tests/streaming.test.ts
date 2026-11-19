/** Synthetic bounded-stream, provenance, paging and cleanup regressions; no private capture or model access. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { jsonLines } from "../src/evidence/readers/jsonl.js";
import { scanVscodeOtel, vscodeOtelReader } from "../src/evidence/readers/vscode-otel.js";
import { productionReaders } from "../src/evidence/readers/index.js";
import { STREAM_LIMITS, ScanBudgetExceeded, type StreamLimits, type ScanCounts, type ScanRequest, type DetailRequest } from "../src/evidence/streaming.js";
import { SourceAccess } from "../src/runtime/sources.js";
import { RuntimeService } from "../src/runtime/service.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { JsonlScan } from "../src/runtime/jsonl-scan.js";
import { byteChunks, type StreamedSource } from "../src/runtime/sources.js";
import { startRuntime } from "../src/runtime/server.js";
import type { ReaderInput } from "../src/evidence/contracts.js";
import { scanReportSchema, scanMetricPageSchema } from "../src/metrics/report.js";

/** Create independent exporter-shaped fictional spans; malformed overrides are intentional negative fixtures. */
function span(index = 1, attributes: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: "1".repeat(32), spanId: index.toString(16).padStart(16, "0"), name: "chat fictional",
    kind: 2, startTime: [1760000000 + index, 0], endTime: [1760000001 + index, 0],
    ended: true, status: { code: 1 }, events: [], links: [],
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.conversation.id": "fictional-session",
      "gen_ai.request.model": "fictional", "gen_ai.usage.input_tokens": 20,
      "gen_ai.usage.output_tokens": 5, ...attributes },
    resource: { attributes: { "service.name": "fictional" } },
    instrumentationScope: { name: "fictional" }, ...fields,
  };
}

/** Borrow synthetic bytes with controlled chunk splits. */
function input(text: string | Buffer, width = 64 * 1024): ReaderInput {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  return { readId: "synthetic-read", sourceId: "source-1", signal: new AbortController().signal,
    bytes: (async function* () {
      for (let offset = 0; offset < bytes.length; offset += width) yield bytes.subarray(offset, offset + width);
    })() };
}

/** Zero physical counters for independently bounded normalization tests. */
function counts(): ScanCounts {
  return { records: 0, blank: 0, malformed: 0, incomplete: 0, oversized: 0, unknown: 0, duplicates: 0, executionRecords: 0, unclassifiedRecords: 0, metrics: 0, logs: 0, contentEvents: 0 };
}

/** Allocate only an owned temporary source and always close its service before deleting that exact fixture root. */
async function fixture(t: TestContext, text: string): Promise<{ service: RuntimeService; file: string; sources: SourceAccess }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agent-insights-stream-test-"));
  const file = path.join(root, "fictional.jsonl");
  await fs.writeFile(file, text);
  const sources = await SourceAccess.create([file]);
  const service = new RuntimeService(sources, { sources: [file], port: 0, harness: "copilot", model: null, copilotPath: null }, productionReaders);
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true }); });
  return { service, file, sources };
}

/** Start the explicit source selection, without any analysis runner. */
function scan(service: RuntimeService) {
  return service.scan({ sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" }, new AbortController().signal);
}

/** Fetch one selection's original contributor page. */
function details(service: RuntimeService, id: string, sessionId: string | null, cursor: string | null = null, fromMs: number | null = null) {
  return service.scanDetails({ id, sessionId, cursor, fromMs, toMs: null }, new AbortController().signal);
}

/** Use the production report operation without manufacturing a whole-file read. */
function report(service: RuntimeService, id: string, sessionId: string) {
  return service.scanReport({ id, sessionId }, new AbortController().signal);
}

/** Fetch exact metric contributors; neither a time filter nor an event page can define the totals. */
function metricPage(service: RuntimeService, id: string, sessionId: string, metricId: string, cursor: string | null = null) {
  return service.scanMetricDetails({ id, sessionId, metricId, cursor }, new AbortController().signal);
}

test("scan reports use whole-session deduplicated timing/tools/tokens and exact paged physical contributors", async (t) => {
  const model = span(1);
  const tool = span(2, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "shell",
    "gen_ai.tool.call.id": "fictional-tool", "gen_ai.tool.call.arguments": "printf fictional" });
  const last = span(3, { "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 0 });
  const foreign = span(8, { "gen_ai.conversation.id": "another-session", "gen_ai.usage.input_tokens": 9000 });
  const conflict = span(4, { "gen_ai.input.messages": "first" });
  const rows = [model, tool, foreign, conflict, ...Array.from({ length: 25 }, () => model),
    span(4, { "gen_ai.input.messages": "other" }), last];
  const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const { service } = await fixture(t, text);
  const scanResult = await scan(service);
  const id = scanResult.id;
  const sessionId = service.scanCatalog.catalog(id, null).sessions[0]!.id;
  const result = scanReportSchema.parse(await report(service, id, sessionId));
  const values = Object.fromEntries(result.measurements.map((entry) => [entry.id, entry.value]));
  assert.equal(values.input, 27);
  assert.equal(values.output, 5);
  assert.equal(values.tools, 1);
  assert.equal(values.elapsed, 3000);
  assert.equal(values.activity, 3000);
  assert.equal(values.cumulative, 3000);
  assert.equal(values.gaps, 0);
  assert.equal(result.measurements[0]?.coverage.status, "partial");
  assert.equal(result.prefixSha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(result.admittedBytes, Buffer.byteLength(text));
  assert.ok(!JSON.stringify(result).includes("printf fictional"));
  assert.equal(service.view, null);
  let page = scanMetricPageSchema.parse(await metricPage(service, id, sessionId, "input"));
  assert.equal(page.contributors.length, 20);
  let total = 0;
  const lines: number[] = [];
  while (true) {
    for (const entry of page.contributors) {
      total++;
      lines.push(entry.line);
      assert.equal(entry.event.sessionId, sessionId);
      assert.equal(entry.fingerprint, createHash("sha256").update(JSON.stringify(rows[entry.line - 1])).digest("hex"));
      assert.equal(entry.byteOffset, Buffer.byteLength(rows.slice(0, entry.line - 1).map((row) => JSON.stringify(row) + "\n").join("")));
      assert.ok([model.spanId, last.spanId].includes(entry.event.nativeId));
    }
    if (!page.next) break;
    await assert.rejects(metricPage(service, id, sessionId, "tools", page.next), (e) => e instanceof RuntimeError && e.code === "SCAN_CURSOR");
    page = await metricPage(service, id, sessionId, "input", page.next);
  }
  assert.equal(total, 27);
  assert.deepEqual(lines, [1, ...Array.from({ length: 25 }, (_, i) => i + 5), 31]);
  const tools = await metricPage(service, id, sessionId, "tools");
  assert.deepEqual(tools.contributors.map((entry) => entry.line), [2]);
  assert.equal((await report(service, id, sessionId)).measurements.find((entry) => entry.id === "input")?.value, 27);
});

test("empty tool IDs survive compact scans, report counting and original contributor rescans", async (t) => {
  const first = span(1, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "shell", "gen_ai.tool.call.id": "" });
  const second = span(2, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "shell", "gen_ai.tool.call.id": "" });
  const rows = [first, second, first, span(3)];
  const { service, file } = await fixture(t, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const before = await fs.readFile(file);
  const status = await scan(service);
  const { id } = status;
  assert.equal(status.phase, "complete");
  assert.equal(status.reason, null);
  const sessionId = service.scanCatalog.catalog(id, null).sessions[0]!.id;
  const result = await report(service, id, sessionId);
  for (const [metric, value] of [["tools", 2], ["input", 20], ["output", 5], ["cumulative", 3000]] as const) {
    const measurement = result.measurements.find((entry) => entry.id === metric);
    assert.equal(measurement?.value, value);
    assert.equal(measurement?.coverage.status, "complete");
  }
  const contributors = (await metricPage(service, id, sessionId, "tools")).contributors;
  assert.deepEqual(contributors.map((entry) => entry.line), [1, 2, 3]);
  for (const entry of contributors) {
    const event = entry.event;
    assert.ok(event.kind === "tool-call");
    assert.equal(event.tool?.callId, null);
    assert.equal(event.nativeId, rows[entry.line - 1]?.spanId);
    assert.equal(entry.fingerprint, createHash("sha256").update(JSON.stringify(rows[entry.line - 1])).digest("hex"));
    assert.ok(event.references.some((ref) =>
      ref.location.kind === "jsonl" && ref.location.line === entry.line &&
      ref.location.pointer === "/attributes/gen_ai.tool.call.id",
    ));
  }
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal(service.view, null);
  assert.match(result.issues.join(" "), /Tool-call identifier unavailable: empty value/);
  await fs.appendFile(file, JSON.stringify(span(4, {
    "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "shell", "gen_ai.tool.call.id": null,
  })) + "\n");
  const malformed = await scan(service);
  assert.equal(malformed.phase, "partial");
  assert.match(malformed.reason ?? "", /Coverage is partial/);
});

test("compact scans resolve out-of-order parent-only calls and preserve full-read relationships on every physical replay", async (t) => {
  const child = span(2, { "gen_ai.conversation.id": undefined, "copilot_chat.parent_chat_session_id": "parent" });
  const rows = [child, child, span(1, { "copilot_chat.chat_session_id": "parent", "gen_ai.usage.input_tokens": 7 })];
  const { service, file } = await fixture(t, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const before = await fs.readFile(file);
  const status = await scan(service);
  const { id } = status;
  assert.equal(status.phase, "partial");
  assert.equal(status.unassigned, 1);
  const catalog = service.scanCatalog.catalog(id, null);
  assert.equal(catalog.unassigned, 1);
  const session = catalog.sessions[0]!;
  assert.equal(session.executions, 1);
  assert.equal(session.associatedExecutions, 1);
  const result = await report(service, id, session.id);
  assert.deepEqual(result.contributions, { directEvents: 1, associatedEvents: 1 });
  assert.equal(result.measurements.find((entry) => entry.id === "input")?.value, 7);
  const originals = (await details(service, id, session.id)).contributors;
  assert.deepEqual(originals.map((entry) => entry.line), [1, 2, 3]);
  for (const entry of originals.slice(0, 2)) {
    const event = entry.event;
    assert.ok(event.kind === "model-call" && event.parentChat);
    assert.equal(event.sessionId, null);
    assert.equal(event.parentChat.status, "resolved");
    assert.equal(event.parentChat.sessionId, session.id);
    assert.equal(event.parentChat.reference.recordId, `sha256:${entry.fingerprint}`);
    assert.equal(event.parentChat.reference.location.kind, "jsonl");
    assert.ok(event.parentChat.reference.location.kind === "jsonl" && event.parentChat.reference.location.line === entry.line);
  }
  assert.deepEqual((await metricPage(service, id, session.id, "input")).contributors.map((entry) => entry.line), [3]);
  assert.deepEqual((await details(service, id, null)).contributors.map((entry) => entry.line), [1, 2]);
  assert.deepEqual(await fs.readFile(file), before);
});

test("compact replay signatures distinguish malformed parent values and presence from exact duplicates", async () => {
  const policy = { maxMetadataBytes: 32768, maxIdentities: 1, maxReferences: 20,
    maxRecordBytes: STREAM_LIMITS.recordBytes, onLine() {} };
  for (const [first, second] of [[17, 18], [undefined, null], [null, ""], ["", false]]) {
    const summary = counts();
    const text = [first, second].map((value) => JSON.stringify(span(1, {
      "copilot_chat.parent_chat_session_id": value,
    }))).join("\n");
    const view = await scanVscodeOtel(input(text), { ...policy, counts: summary });
    assert.equal(view.events.length, 0);
    assert.equal(view.sources[0]?.classification?.conflictingSpans, 1);
    assert.equal(summary.duplicates, 0);
  }
  const summary = counts();
  const invalid = JSON.stringify(span(1, { "copilot_chat.parent_chat_session_id": 17 }));
  const view = await scanVscodeOtel(input(`${invalid}\n${invalid}`), { ...policy, counts: summary });
  assert.equal(view.events.length, 1);
  assert.equal(summary.duplicates, 1);
  const event = view.events[0];
  assert.ok(event?.kind === "model-call" && !event.parentChat);
});

test("scan reports preserve measured-zero witnesses and explain unavailable usage without successful zeros", async (t) => {
  const { service } = await fixture(t, [span(1, {
    "gen_ai.usage.input_tokens": undefined, "gen_ai.usage.output_tokens": undefined,
  }), span(2, { "gen_ai.usage.input_tokens": undefined, "gen_ai.usage.output_tokens": undefined })].map((row) => JSON.stringify(row)).join("\n"));
  const { id } = await scan(service);
  const sessionId = service.scanCatalog.catalog(id, null).sessions[0]!.id;
  const result = await report(service, id, sessionId);
  const tools = result.measurements.find((entry) => entry.id === "tools")!;
  assert.equal(tools.value, 0);
  assert.equal(tools.coverage.status, "complete");
  assert.equal(tools.evidenceKind, "coverage-witnesses");
  const usage = result.measurements.find((entry) => entry.id === "input")!;
  assert.equal(usage.value, null);
  assert.equal(usage.coverage.status, "unavailable");
  for (const metric of ["tools", "input"])
    assert.deepEqual((await metricPage(service, id, sessionId, metric)).contributors.map((entry) => entry.line), [1, 2]);
});

test("one-sided token usage retains exact provenance but labels unavailable totals as coverage witnesses", async (t) => {
  for (const [missing, present, value] of [["input", "output", 5], ["output", "input", 0]] as const) {
    const { service } = await fixture(t, JSON.stringify(span(1, {
      [`gen_ai.usage.${missing}_tokens`]: undefined, [`gen_ai.usage.${present}_tokens`]: value,
    })));
    const { id } = await scan(service);
    const sessionId = service.scanCatalog.catalog(id, null).sessions[0]!.id;
    const result = await report(service, id, sessionId);
    const unavailable = result.measurements.find((entry) => entry.id === missing)!;
    assert.equal(unavailable.value, null);
    assert.equal(unavailable.coverage.status, "unavailable");
    assert.equal(unavailable.evidenceKind, "coverage-witnesses");
    const measured = result.measurements.find((entry) => entry.id === present)!;
    assert.equal(measured.value, value);
    assert.equal(measured.evidenceKind, "contributors");
    for (const metric of [missing, present]) {
      const page = await metricPage(service, id, sessionId, metric);
      assert.equal(page.evidenceKind, metric === missing ? "coverage-witnesses" : "contributors");
      assert.deepEqual(page.contributors.map((entry) => entry.line), [1]);
      assert.equal(page.contributors[0]?.event.nativeId, "0000000000000001");
    }
  }
});

test("report selection/metric authority rejects stale or foreign IDs and source changes, admitting appends only on rescan", async (t) => {
  for (const change of ["append", "prefix", "truncate", "replace"]) {
    const text = JSON.stringify(span(1)) + "\n";
    const { service, file } = await fixture(t, text);
    const { id } = await scan(service);
    const sessionId = service.scanCatalog.catalog(id, null).sessions[0]!.id;
    await assert.rejects(report(service, id, "foreign"), (e) => e instanceof RuntimeError && e.code === "SCAN_SELECTION");
    await assert.rejects(metricPage(service, id, sessionId, "foreign"), (e) => e instanceof RuntimeError && e.code === "SCAN_SELECTION");
    assert.equal((await report(service, id, sessionId)).measurements.find((entry) => entry.id === "input")?.value, 20);
    if (change === "append") {
      await fs.appendFile(file, JSON.stringify(span(2)) + "\n");
      const current = await report(service, id, sessionId);
      assert.equal(current.appended, true);
      assert.equal(current.measurements.find((entry) => entry.id === "input")?.value, 20);
      assert.deepEqual((await metricPage(service, id, sessionId, "input")).contributors.map((entry) => entry.line), [1]);
      const fresh = await scan(service);
      await assert.rejects(report(service, id, sessionId), (e) => e instanceof RuntimeError && e.code === "SCAN_STALE");
      const newer = service.scanCatalog.catalog(fresh.id, null).sessions[0]!.id;
      assert.equal((await report(service, fresh.id, newer)).measurements.find((entry) => entry.id === "input")?.value, 40);
    } else {
      if (change === "replace") { await fs.rename(file, file + ".old"); await fs.writeFile(file, text); }
      if (change === "truncate") await fs.truncate(file, 3);
      if (change === "prefix") await fs.writeFile(file, text.replace('"input_tokens":20', '"input_tokens":21').replace('"gen_ai.usage.input_tokens":20', '"gen_ai.usage.input_tokens":21'));
      await assert.rejects(report(service, id, sessionId), (e) => e instanceof RuntimeError && e.code === "SOURCE_CHANGED");
      assert.equal(service.scanCatalog.status?.phase, "source-changed");
      await assert.rejects(metricPage(service, id, sessionId, "input"), RuntimeError);
    }
  }
});

test("report calculation and measurement budgets fail explicitly at one-over, without sampled totals", async () => {
  const text = [span(1), span(2)].map((row) => JSON.stringify(row)).join("\n");
  const exact = await catalogFor(text, { ...STREAM_LIMITS, reportEvents: 2, reportMeasurements: 9 });
  const selection = { id: "synthetic-generation", sessionId: exact.scanner.catalog("synthetic-generation", null).sessions[0]!.id };
  assert.equal((await exact.scanner.report(selection, exact.source, new AbortController().signal)).measurements.length, 9);
  for (const limits of [{ reportEvents: 1 }, { reportMeasurements: 8 }]) {
    const over = await catalogFor(text, { ...STREAM_LIMITS, ...limits });
    await assert.rejects(over.scanner.report(selection, over.source, new AbortController().signal),
      (error) => error instanceof ScanBudgetExceeded && error.budget === "report");
    await assert.rejects(over.scanner.metricDetails({ ...selection, metricId: "input", cursor: null }, over.source, new AbortController().signal), ScanBudgetExceeded);
  }
});

test("reports and metric pages enforce response, work and monotonic expiry boundaries", async (t) => {
  const text = JSON.stringify(span());
  const base = await catalogFor(text);
  const request = { id: "synthetic-generation", sessionId: base.scanner.catalog("synthetic-generation", null).sessions[0]!.id };
  const result = await base.scanner.report(request, base.source, new AbortController().signal);
  const responseBytes = Buffer.byteLength(JSON.stringify(result));
  const exact = await catalogFor(text, { ...STREAM_LIMITS, responseBytes });
  await exact.scanner.report(request, exact.source, new AbortController().signal);
  const over = await catalogFor(text, { ...STREAM_LIMITS, responseBytes: responseBytes - 1 });
  await assert.rejects(over.scanner.report(request, over.source, new AbortController().signal),
    (error) => error instanceof ScanBudgetExceeded && error.budget === "response");
  const work = await catalogFor(text, { ...STREAM_LIMITS, workBytes: 2 * Buffer.byteLength(text) });
  await work.scanner.report(request, work.source, new AbortController().signal);
  await assert.rejects(work.scanner.metricDetails({ ...request, metricId: "input", cursor: null }, work.source, new AbortController().signal),
    (error) => error instanceof ScanBudgetExceeded && error.budget === "work");
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const expiring = await catalogFor(text, { ...STREAM_LIMITS, lifetimeMs: 1000 });
  now = 999;
  await expiring.scanner.report(request, expiring.source, new AbortController().signal);
  now = 1000;
  for (const operation of [
    () => expiring.scanner.report(request, expiring.source, new AbortController().signal),
    () => expiring.scanner.metricDetails({ ...request, metricId: "input", cursor: null }, expiring.source, new AbortController().signal),
  ]) await assert.rejects(operation(), (error) => error instanceof RuntimeError && error.code === "SCAN_EXPIRED");
});

test("report-only budget misses preserve the catalog and ordinary evidence for every session after cleanup", async (t) => {
  const rows = [...Array.from({ length: STREAM_LIMITS.reportEvents + 1 }, (_, index) => span(index + 1)),
    span(STREAM_LIMITS.reportEvents + 2, { "gen_ai.conversation.id": "another-session" })];
  const { service, file } = await fixture(t, rows.map((row) => JSON.stringify(row)).join("\n"));
  const { id } = await scan(service);
  const catalog = service.scanCatalog.catalog(id, null);
  assert.equal(catalog.sessions.length, 2);
  for (const session of catalog.sessions) {
    for (const operation of [
      () => report(service, id, session.id),
      () => metricPage(service, id, session.id, "input"),
    ]) {
      const before = service.scanCatalog.status;
      await assert.rejects(operation(), (error) => error instanceof RuntimeError && error.code === "SCAN_BUDGET");
      assert.deepEqual(service.scanCatalog.status, before);
      assert.deepEqual(service.scanCatalog.catalog(id, null), catalog);
    }
    const page = await details(service, id, session.id);
    assert.equal(page.contributors.length, Math.min(STREAM_LIMITS.pageRecords, session.executions));
    assert.ok(page.contributors.every((entry) => entry.event.sessionId === session.id));
    if (page.next)
      assert.equal((await details(service, id, session.id, page.next)).contributors.length, STREAM_LIMITS.pageRecords);
  }
  assert.equal(service.view, null);
  await fs.writeFile(file, JSON.stringify(span()));
  await assert.rejects(details(service, id, catalog.sessions[1]!.id),
    (error) => error instanceof RuntimeError && error.code === "SOURCE_CHANGED");
  assert.equal(service.scanCatalog.status?.phase, "source-changed");
});

test("descriptor cleanup failure still invalidates an over-budget report's catalog and blocks reuse", async (t) => {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { service } = await fixture(t, Array.from({ length: STREAM_LIMITS.reportEvents + 1 }, (_, index) =>
    JSON.stringify(span(index + 1))).join("\n"));
  const { id } = await scan(service);
  const sessionId = service.scanCatalog.catalog(id, null).sessions[0]!.id;
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const close = handle.close.bind(handle);
    let attempts = 0;
    t.mock.method(handle, "close", async () => {
      if (++attempts === 1) throw new Error("FICTIONAL_REPORT_CLOSE_FAILURE");
      await close();
    });
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(report(service, id, sessionId),
    (error) => error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED");
  assert.equal(service.scanCatalog.status?.phase, "cleanup-failed");
  assert.equal(service.scanCatalog.status?.sessions, null);
  assert.throws(() => service.scanCatalog.catalog(id, null), RuntimeError);
  await assert.rejects(details(service, id, sessionId),
    (error) => error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED");
  t.mock.restoreAll(); syncBuiltinESMExports();
  await service.close();
  assert.equal((await scan(service)).sessions, 1);
});

test("cancelled report late-open retains the actual five-second cleanup barrier and cannot publish", async (t) => {
  const { service } = await fixture(t, JSON.stringify(span()));
  const { id } = await scan(service);
  const sessionId = service.scanCatalog.catalog(id, null).sessions[0]!.id;
  const originalOpen = fs.open;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let admitted!: () => void;
  const opening = new Promise<void>((resolve) => { admitted = resolve; });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    admitted(); await blocked; return originalOpen(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const rejected = assert.rejects(report(service, id, sessionId),
    (error) => error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED");
  await opening;
  const before = performance.now();
  service.invalidate();
  assert.ok(performance.now() - before < 1000);
  await rejected;
  assert.ok(performance.now() - before >= 4900);
  assert.equal(service.scanCatalog.status?.cleanupPending, true);
  await assert.rejects(scan(service), (error) => error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED");
  release();
  await service.close();
  assert.equal(service.scanCatalog.status?.cleanupPending, false);
  assert.equal(service.view, null);
});

test("scale qualification rejects a dirty Git tree without running large workers or issuing a passed receipt", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agent-insights-stream-provenance-"));
  t.after(() => fs.rm(root, { recursive: true }));
  await fs.writeFile(path.join(root, "fictional-uncommitted.txt"), "original fictional");
  for (const args of [
    ["init", "--quiet"],
    ["add", "--force", "fictional-uncommitted.txt"],
    ["-c", "user.name=Fictional Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${path.join(root, "no-hooks")}`,
      "commit", "--allow-empty", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  }
  await fs.writeFile(path.join(root, "fictional-uncommitted.txt"), "fictional");
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../../scripts/qualify-jsonl-streaming.mjs")],
    { cwd: root, encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Qualification requires a clean committed working tree/);
  assert.equal(result.stdout, "");
  assert.deepEqual((await fs.readdir(root)).sort(), [".git", "fictional-uncommitted.txt"]);
});

test("framing preserves UTF-8/CRLF, physical blanks and exact byte coordinates", async () => {
  const text = '\n{"text":"é"}\r\n\n{"ok":true}';
  const observed: number[] = [];
  const records = [];
  for await (const line of jsonLines(input(text, 1), { maxRecordBytes: 32, onLine: (line) => observed.push(line.line) })) records.push(line);
  assert.deepEqual(observed, [1, 2, 3, 4]);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.byteOffset, 1);
  assert.equal(records[0]?.byteLength, Buffer.byteLength('{"text":"é"}\r'));
  assert.equal(records[1]?.line, 4);
  assert.equal(records[1]?.terminated, false);
});

test("record limit is inclusive and oversized independent lines are skipped before decoding", async () => {
  const records = [];
  for await (const line of jsonLines(input('{"x":1}\n{"xx":1}\n{"y":2}', 2), { maxRecordBytes: 7 })) records.push(line);
  assert.equal(records.length, 3);
  assert.ok(records[0] && "value" in records[0]);
  assert.ok(records[1] && "error" in records[1] && records[1].error === "oversized");
  assert.ok(records[2] && "value" in records[2]);
  assert.equal(records[2].line, 3);
  assert.equal(records[2].byteOffset, 17);
});

test("compact scan preserves normalized classification/correlation without retaining content or duplicate anchors", async () => {
  const text = Array.from({ length: 4000 }, () => JSON.stringify(span(1, { "gen_ai.input.messages": "fictional payload" }))).join("\n");
  const summary = counts();
  const view = await scanVscodeOtel(input(text), {
    counts: summary, maxMetadataBytes: 32 * 1024, maxIdentities: 1, maxReferences: 2,
    maxRecordBytes: STREAM_LIMITS.recordBytes, onLine() {},
  });
  assert.equal(view.events.length, 1);
  assert.equal(view.events[0]?.references.length, 1);
  assert.equal(view.sessions[0]?.references.length, 1);
  assert.equal(summary.duplicates, 3999);
  assert.equal(summary.records, 4000);
  const event = view.events[0];
  assert.ok(event && event.kind !== "message");
  assert.equal(event.content?.inputMessages, null);
  const small = await vscodeOtelReader.read(input(text));
  assert.deepEqual(view.sources[0]?.classification, small.sources[0]?.classification);
});

test("metadata, identity and reference ceilings stop explicitly at the boundary, never evicting state", async () => {
  const policy = { counts: counts(), maxMetadataBytes: 32768, maxIdentities: 2, maxReferences: 4,
    maxRecordBytes: STREAM_LIMITS.recordBytes, onLine() {} };
  await scanVscodeOtel(input([span(1), span(2)].map((value) => JSON.stringify(value)).join("\n")), policy);
  await assert.rejects(scanVscodeOtel(input([span(1), span(2), span(3)].map((value) => JSON.stringify(value)).join("\n")),
    { ...policy, counts: counts() }), ScanBudgetExceeded);
  await assert.rejects(scanVscodeOtel(input(JSON.stringify(span())), { ...policy, maxMetadataBytes: 1 }), ScanBudgetExceeded);
  await assert.rejects(scanVscodeOtel(input(JSON.stringify(span())), { ...policy, maxReferences: 1 }), ScanBudgetExceeded);
  const ownChat = JSON.stringify(span(1, { "copilot_chat.chat_session_id": "parent" }));
  const view = await scanVscodeOtel(input(ownChat), { ...policy, counts: counts(), maxReferences: 3 });
  assert.ok(view.events[0]?.references.some((ref) => ref.location.pointer === "/attributes/copilot_chat.chat_session_id"));
  await assert.rejects(scanVscodeOtel(input(ownChat), { ...policy, counts: counts(), maxReferences: 2 }),
    (error) => error instanceof ScanBudgetExceeded && error.budget === "references");
});

test("metrics-only, malformed, incomplete, oversized, blank and unknown records are distinct", async (t) => {
  const text = '\n{"scopeMetrics":[]}\n{}\nbroken\n' + "x".repeat(STREAM_LIMITS.recordBytes + 1) + '\n{"';
  const { service } = await fixture(t, text);
  const result = await scan(service);
  assert.equal(result.phase, "partial");
  assert.deepEqual(result.counts, { records: 6, blank: 1, malformed: 1, incomplete: 1, oversized: 1, unknown: 1, duplicates: 0, executionRecords: 0, unclassifiedRecords: 0, metrics: 1, logs: 0, contentEvents: 0 });
  assert.equal(result.classification?.nonExecutionRecords.metrics, 1);
  assert.equal(result.classification?.executions.modelCalls, 0);
  assert.match(result.reason ?? "", /unavailable, not zero/);
  assert.equal(result.scannedBytes, Buffer.byteLength(text));
  assert.equal(service.view, null);
});

test("bounded catalog and original contributor pages are stable, opaque and non-additive", async (t) => {
  const repeated = JSON.stringify(span(1));
  const text = "\n" + Array.from({ length: 23 }, () => repeated).join("\r\n") + "\n";
  const { service } = await fixture(t, text);
  const result = await scan(service);
  assert.equal(result.counts.duplicates, 22);
  const catalog = service.scanCatalog.catalog(result.id, null);
  assert.equal(catalog.sessions[0]?.executions, 1);
  const sessionId = catalog.sessions[0].id;
  const first = await details(service, result.id, sessionId);
  assert.equal(first.contributors.length, STREAM_LIMITS.pageRecords);
  assert.ok(first.next);
  assert.equal(first.contributors[0]?.line, 2);
  assert.equal(first.contributors[0]?.byteOffset, 1);
  assert.equal(first.contributors[0]?.fingerprint, createHash("sha256").update(repeated + "\r").digest("hex"));
  const second = await details(service, result.id, sessionId, first.next);
  assert.equal(second.contributors.length, 3);
  assert.equal(second.next, null);
  assert.equal(second.contributors[0]?.event.id, first.contributors[0]?.event.id);
  assert.equal(first.scope, "original-contributors-not-additive-metrics");
  await assert.rejects(details(service, result.id, null, first.next), (error) => error instanceof RuntimeError && error.code === "SCAN_CURSOR");
  await assert.rejects(details(service, result.id, sessionId, `${first.next}x`), (error) => error instanceof RuntimeError && error.code === "SCAN_CURSOR");
  await assert.rejects(details(service, result.id, sessionId, `${first.next}!`), (error) => error instanceof RuntimeError && error.code === "SCAN_CURSOR");
  await assert.rejects(details(service, result.id, sessionId, `${first.next}=`), (error) => error instanceof RuntimeError && error.code === "SCAN_CURSOR");
});

test("session catalog pages replace rather than split sessions; cursors reject refresh and other sources", async (t) => {
  const { service } = await fixture(t, Array.from({ length: 25 }, (_, index) =>
    JSON.stringify(span(index + 1, { "gen_ai.conversation.id": `fictional-${index}` }))).join("\n"));
  const result = await scan(service);
  const first = service.scanCatalog.catalog(result.id, null);
  assert.equal(first.sessions.length, 20);
  assert.ok(first.next);
  assert.equal(service.scanCatalog.catalog(result.id, first.next).sessions.length, 5);
  assert.throws(() => service.scanCatalog.catalog("another-generation", first.next), RuntimeError);
  const newer = await scan(service);
  assert.throws(() => service.scanCatalog.catalog(newer.id, first.next), RuntimeError);
});

test("full-source parents outside a time selection establish ownership without adding out-of-window contributors", async (t) => {
  const parent = span(1);
  const child = span(2, { "gen_ai.conversation.id": undefined }, {
    parentSpanContext: { traceId: "1".repeat(32), spanId: "0000000000000001" },
  });
  const unassigned = span(3, { "gen_ai.conversation.id": undefined });
  const { service } = await fixture(t, [child, parent, unassigned].map((value) => JSON.stringify(value)).join("\n"));
  const result = await scan(service);
  assert.equal(result.sessions, 1);
  assert.equal(result.unassigned, 1);
  const sessionId = service.scanCatalog.catalog(result.id, null).sessions[0]!.id;
  const page = await details(service, result.id, sessionId, null, 1760000002000);
  assert.equal(page.contributors.length, 1);
  assert.equal(page.contributors[0]?.line, 1);
  assert.equal((await details(service, result.id, null)).contributors.length, 1);
});

test("conflicting payloads are detected even though scan metadata discards their text", async (t) => {
  const { service } = await fixture(t, [span(1, { "gen_ai.input.messages": "first" }),
    span(1, { "gen_ai.input.messages": "second" }), span(2)].map((value) => JSON.stringify(value)).join("\n"));
  const result = await scan(service);
  assert.equal(result.classification?.conflictingSpans, 1);
  assert.equal(result.classification?.executions.modelCalls, 1);
});

test("detail retrieval accepts append beyond the boundary but rejects same-offset mutation and replacement", async (t) => {
  const original = JSON.stringify(span(1, { "gen_ai.input.messages": "first" })) + "\n";
  const { service, file } = await fixture(t, original);
  const result = await scan(service);
  const sessionId = service.scanCatalog.catalog(result.id, null).sessions[0]!.id;
  await fs.appendFile(file, JSON.stringify(span(2)) + "\n");
  assert.equal((await details(service, result.id, sessionId)).contributors.length, 1);
  await fs.writeFile(file, original.replace("first", "other") + JSON.stringify(span(2)) + "\n");
  await assert.rejects(details(service, result.id, sessionId), (error) => error instanceof RuntimeError && error.code === "SOURCE_CHANGED");
  assert.equal(service.scanCatalog.status?.phase, "source-changed");
  const refreshed = await scan(service);
  const replacementSession = service.scanCatalog.catalog(refreshed.id, null).sessions[0]!.id;
  await fs.rename(file, file + ".old");
  await fs.writeFile(file, original);
  await assert.rejects(details(service, refreshed.id, replacementSession), (error) => error instanceof RuntimeError && error.code === "SOURCE_CHANGED");
});

test("borrowed streams finish at admission and preserve scope/identity checks", async (t) => {
  const { sources, file } = await fixture(t, "original");
  await sources.withStream("source-1", "", new AbortController().signal, async (source) => {
    await fs.appendFile(file, "append");
    let bytes = 0;
    for await (const chunk of source.chunks()) bytes += chunk.length;
    assert.equal(bytes, 8);
    assert.equal((await source.verify()).appended, true);
  });
  await assert.rejects(sources.withStream("source-1", "../escape", new AbortController().signal, async () => 1), RuntimeError);
  const signal = AbortSignal.abort();
  await assert.rejects(sources.withStream("source-1", "", signal, async () => 1), RuntimeError);
});

test("cancellation acknowledges within one second while the actual five-second late-open cleanup barrier remains owned", async (t) => {
  const { service } = await fixture(t, JSON.stringify(span()));
  const originalOpen = fs.open;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let admitted!: () => void;
  const opening = new Promise<void>((resolve) => { admitted = resolve; });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    admitted();
    await blocked;
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const pending = scan(service);
  // Observe rejection before triggering it, avoiding unhandled asynchronous cancellation.
  const rejected = assert.rejects(pending, (error) => error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED");
  await opening;
  const before = performance.now();
  service.invalidate();
  assert.ok(performance.now() - before < 1000);
  await rejected;
  assert.ok(performance.now() - before >= 4900);
  await assert.rejects(scan(service), (error) => error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED");
  release();
  await service.close();
  assert.equal(service.scanCatalog.status?.cleanupPending, false);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal((await scan(service)).sessions, 1);
});

/** Borrowed independent in-memory source for budget tests; no filesystem authorization claim is made. */
function memorySource(text: string): StreamedSource {
  const bytes = Buffer.from(text);
  return {
    identity: { dev: "1", ino: "1", size: String(bytes.length), mtime: "1", ctime: "1" },
    boundary: bytes.length, startedAtMs: Date.now(),
    chunks: () => byteChunks(bytes, new AbortController().signal),
    verify: async () => ({ changed: false, appended: false }),
  };
}

/** Run the real scanner against a code-owned borrowed test source and explicitly confirm publication. */
async function catalogFor(text: string, limits: StreamLimits = STREAM_LIMITS) {
  const scanner = new JsonlScan(limits);
  const source = memorySource(text);
  scanner.prepare("synthetic-generation", { sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" });
  scanner.publish(await scanner.scan("synthetic-generation",
    { sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" },
    source, new AbortController().signal));
  return { scanner, source };
}

test("work, selected-payload and serialized-response byte ceilings pass exactly and reject one over", async () => {
  const text = JSON.stringify(span());
  const length = Buffer.byteLength(text);
  await catalogFor(text, { ...STREAM_LIMITS, workBytes: length });
  await assert.rejects(catalogFor(text, { ...STREAM_LIMITS, workBytes: length - 1 }), ScanBudgetExceeded);
  const exact = await catalogFor(text, { ...STREAM_LIMITS, detailBytes: length });
  const sessionId = exact.scanner.catalog("synthetic-generation", null).sessions[0]!.id;
  const request = { id: "synthetic-generation", sessionId, cursor: null, fromMs: null, toMs: null };
  const page = await exact.scanner.details(request, exact.source, new AbortController().signal);
  const over = await catalogFor(text, { ...STREAM_LIMITS, detailBytes: length - 1 });
  await assert.rejects(over.scanner.details(request, over.source, new AbortController().signal), ScanBudgetExceeded);
  const responseBytes = Buffer.byteLength(JSON.stringify(page));
  const boundary = await catalogFor(text, { ...STREAM_LIMITS, responseBytes });
  await boundary.scanner.details(request, boundary.source, new AbortController().signal);
  const tooSmall = await catalogFor(text, { ...STREAM_LIMITS, responseBytes: responseBytes - 1 });
  await assert.rejects(tooSmall.scanner.details(request, tooSmall.source, new AbortController().signal), ScanBudgetExceeded);
});

test("monotonic generation lifetime rejects expired catalogs without accepting old cursors", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const { scanner } = await catalogFor(JSON.stringify(span()), { ...STREAM_LIMITS, lifetimeMs: 1000 });
  now = 999;
  scanner.catalog("synthetic-generation", null);
  assert.equal(scanner.status?.phase, "complete");
  now = 1000;
  assert.equal(scanner.status?.phase, "budget-exceeded");
  assert.match(scanner.status?.reason ?? "", /lifetime/);
  assert.equal(scanner.status?.sessions, null);
  assert.equal(scanner.status?.classification, null);
  assert.equal(scanner.status?.cleanupPending, false);
  assert.throws(() => scanner.catalog("synthetic-generation", null),
    (error) => error instanceof RuntimeError && error.code === "SCAN_EXPIRED");
  now = 1001;
  assert.throws(() => scanner.catalog("synthetic-generation", null), RuntimeError);
});

test("expired status drops catalog authority without claiming an owned detail descriptor was closed", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const { scanner } = await catalogFor(JSON.stringify(span()), { ...STREAM_LIMITS, lifetimeMs: 1000 });
  scanner.pending("synthetic-generation");
  now = 1000;
  assert.equal(scanner.status?.phase, "budget-exceeded");
  assert.equal(scanner.status?.cleanupPending, true);
  assert.equal(scanner.status?.unassigned, null);
  scanner.cleanupConfirmed("synthetic-generation");
  assert.equal(scanner.status?.cleanupPending, false);
  assert.equal(scanner.status?.phase, "budget-exceeded");
});

test("selected detail bytes charge original whitespace and CR at exact physical-record boundaries", async () => {
  const compact = JSON.stringify(span());
  const length = STREAM_LIMITS.recordBytes;
  const record = compact + " ".repeat(length - Buffer.byteLength(compact) - 1) + "\r";
  const text = `${record}\n`.repeat(3);
  const { scanner, source } = await catalogFor(text);
  const sessionId = scanner.catalog("synthetic-generation", null).sessions[0]!.id;
  const request = { id: "synthetic-generation", sessionId, cursor: null, fromMs: null, toMs: null };
  const page = await scanner.details(request, source, new AbortController().signal);
  assert.equal(page.contributors.length, 2);
  assert.equal(page.contributors.reduce((sum, entry) => sum + entry.byteLength, 0), STREAM_LIMITS.detailBytes);
  assert.equal(page.contributors[0]?.fingerprint, createHash("sha256").update(record).digest("hex"));
  assert.ok(page.next);
  const next = await scanner.details({ ...request, cursor: page.next }, source, new AbortController().signal);
  assert.equal(next.contributors.length, 1);
  assert.equal(next.contributors[0]?.byteOffset, 2 * (length + 1));
  assert.equal(next.next, null);
  const single = await catalogFor(text, { ...STREAM_LIMITS, detailBytes: length });
  assert.equal((await single.scanner.details(request, single.source, new AbortController().signal)).contributors.length, 1);
  const over = await catalogFor(text, { ...STREAM_LIMITS, detailBytes: length - 1 });
  await assert.rejects(over.scanner.details(request, over.source, new AbortController().signal),
    (error) => error instanceof ScanBudgetExceeded && error.budget === "detail");
});

test("both many sessions and one giant session return explicit production-budget outcomes", async (t) => {
  for (const manySessions of [false, true]) {
    const text = Array.from({ length: STREAM_LIMITS.identities + 1 }, (_, index) =>
      JSON.stringify(span(index + 1, { "gen_ai.conversation.id": manySessions ? `fictional-${index}` : "one-giant-session" }))).join("\n");
    const categories = [{ scopeMetrics: [] }, { hrTime: [1760000000, 0], resource: {}, instrumentationScope: {} },
      span(9000, { "gen_ai.operation.name": "content_event" })].map((value) => JSON.stringify(value)).join("\n");
    const { service } = await fixture(t, categories + "\n" + text);
    const result = await scan(service);
    assert.equal(result.phase, "budget-exceeded");
    assert.equal(result.sessions, null);
    assert.equal(result.unassigned, null);
    assert.equal(result.classification, null);
    assert.equal(result.counts.metrics, 1);
    assert.equal(result.counts.logs, 1);
    assert.equal(result.counts.contentEvents, 1);
    const c = result.counts;
    assert.equal(c.records, c.blank + c.malformed + c.incomplete + c.oversized + c.unknown +
      c.executionRecords + c.unclassifiedRecords + c.metrics + c.logs + c.contentEvents);
    assert.ok(result.scannedBytes < result.admittedBytes);
    assert.throws(() => service.scanCatalog.catalog(result.id, null), RuntimeError);
    assert.equal(service.view, null);
  }
});

test("all physical record categories sum to admitted records independently of native deduplication", async (t) => {
  const text = [span(), span(), span(2, { "gen_ai.operation.name": undefined }),
    { scopeMetrics: [] }, {}, "bad"].map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n") + "\n\n";
  const { service } = await fixture(t, text);
  const result = await scan(service);
  const c = result.counts;
  const nonExecution = result.classification!.nonExecutionRecords;
  assert.equal(c.records, c.blank + c.malformed + c.incomplete + c.oversized + c.unknown +
    c.executionRecords + c.unclassifiedRecords + Object.values(nonExecution).reduce((sum, value) => sum + value, 0));
});

test("scan HTTP controls require launch access/origin and never return payloads before selection", async (t) => {
  const text = JSON.stringify(span(1, { "gen_ai.input.messages": "FICTIONAL_PAYLOAD_ONLY_AFTER_SELECTION" })) + "\n";
  const { file } = await fixture(t, text);
  const runtime = await startRuntime({ sources: [file], port: 0, harness: "copilot", model: null, copilotPath: path.join(path.dirname(file), "no-model") },
    { readers: productionReaders });
  t.after(() => runtime.close());
  /** Call only this test-owned loopback runtime; credentials never leave it or enter diagnostics. */
  const api = (route: string, body?: unknown, authenticated = true, origin = runtime.origin) =>
    fetch(runtime.origin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(authenticated ? { "X-Agent-Insights-Token": runtime.token } : {}),
        Origin: origin, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const selection = { sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" };
  assert.equal((await api("/api/scan", selection, false)).status, 401);
  assert.equal((await api("/api/scan", selection, true, "https://example.invalid")).status, 403);
  assert.equal((await api("/api/scan", { ...selection, sql: "untrusted" })).status, 400);
  assert.equal((await api("/api/scan", { ...selection, relativePath: "../escape" })).status, 403);
  const response = await api("/api/scan", selection);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes("FICTIONAL_PAYLOAD") && !body.includes("fictional-session"));
  const result = runtime.service.scanCatalog.status!;
  const page = runtime.service.scanCatalog.catalog(result.id, null);
  const catalogResponse = await api("/api/scan/catalog", { id: result.id, cursor: null });
  assert.equal(catalogResponse.status, 200);
  assert.ok(!(await catalogResponse.text()).includes("FICTIONAL_PAYLOAD"));
  const detail = await api("/api/scan/details", { id: result.id, sessionId: page.sessions[0]!.id });
  assert.equal(detail.status, 200);
  assert.ok((await detail.text()).includes("FICTIONAL_PAYLOAD_ONLY_AFTER_SELECTION"));
  const reportSelection = { id: result.id, sessionId: page.sessions[0]!.id };
  assert.equal((await api("/api/scan/report", reportSelection, false)).status, 401);
  assert.equal((await api("/api/scan/report", reportSelection, true, "https://example.invalid")).status, 403);
  assert.equal((await api("/api/scan/report", { ...reportSelection, fromMs: 1 })).status, 400);
  const reportResponse = await api("/api/scan/report", reportSelection);
  assert.equal(reportResponse.status, 200);
  const reportText = await reportResponse.text();
  assert.equal(scanReportSchema.parse(JSON.parse(reportText)).measurements.find((entry) => entry.id === "input")?.value, 20);
  assert.ok(!reportText.includes("FICTIONAL_PAYLOAD_ONLY_AFTER_SELECTION"));
  const metricResponse = await api("/api/scan/metric", { ...reportSelection, metricId: "input" });
  assert.equal(metricResponse.status, 200);
  assert.match(await metricResponse.text(), /FICTIONAL_PAYLOAD_ONLY_AFTER_SELECTION/);
  assert.equal((await api("/api/view")).status, 404);
  assert.equal((await api("/api/scan/cancel", {})).status, 202);
  assert.equal((await api("/api/scan/catalog", { id: result.id, cursor: null })).status, 409);
});

test("selected small-source execution facts and per-call accounting match the existing reader exactly", async (t) => {
  const text = JSON.stringify(span(1, { "gen_ai.input.messages": "fictional input", "gen_ai.output.messages": "fictional output" }));
  const { service } = await fixture(t, text);
  const original = await service.read({ sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" }, new AbortController().signal);
  const scanned = await scan(service);
  assert.deepEqual(scanned.classification, original.sources[0]?.classification);
  const sessionId = service.scanCatalog.catalog(scanned.id, null).sessions[0]!.id;
  const page = await details(service, scanned.id, sessionId);
  const { id: oldId, sessionId: oldSession, references: oldRefs, ...oldFacts } = original.events[0]!;
  const { id: newId, sessionId: newSession, references: newRefs, ...newFacts } = page.contributors[0]!.event;
  assert.notEqual(newId, oldId);
  assert.notEqual(newSession, oldSession);
  assert.deepEqual(newFacts, oldFacts);
  assert.deepEqual(newRefs.map((ref) => {
    assert.equal(ref.location.kind, "jsonl");
    if (ref.location.kind !== "jsonl") throw new Error("Expected an original JSONL reference");
    const { byteOffset, byteLength, ...location } = ref.location;
    assert.equal(byteOffset, 0);
    assert.equal(byteLength, Buffer.byteLength(text));
    return { ...ref, location };
  }), oldRefs);
  assert.ok(scanned.inputStartedAtMs !== null && scanned.inputFinishedAtMs !== null);
  assert.ok(scanned.finishedAtMs! >= scanned.inputFinishedAtMs);
});

test("append during a scan triggers a continuity pass and never chases the growing EOF", async (t) => {
  const text = JSON.stringify(span()) + "\n";
  const { sources, file } = await fixture(t, text);
  const scanner = new JsonlScan();
  const view = await sources.withStream("source-1", "", new AbortController().signal, async (source) => {
    await fs.appendFile(file, JSON.stringify(span(2)) + "\n");
    return scanner.scan("append-generation", { sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" },
      source, new AbortController().signal);
  });
  const result = scanner.publish(view);
  assert.equal(result.appended, true);
  assert.equal(result.pass, 2);
  assert.equal(result.scannedBytes, Buffer.byteLength(text));
  assert.equal(result.counts.executionRecords, 1);
});

test("prefix changes between continuity passes cannot publish an apparently complete catalog", async (t) => {
  const text = JSON.stringify(span(1, { "gen_ai.input.messages": "first" })) + "\n";
  const { sources, file } = await fixture(t, text);
  const scanner = new JsonlScan();
  await assert.rejects(sources.withStream("source-1", "", new AbortController().signal, async (source) => {
    let checks = 0;
    return scanner.scan("changed-generation", { sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" }, {
      ...source,
      verify: async () => {
        const observation = await source.verify();
        if (checks++ === 0) await fs.writeFile(file, text.replace("first", "other"));
        return { ...observation, changed: true };
      },
    }, new AbortController().signal);
  }), (error) => error instanceof RuntimeError && error.code === "SOURCE_CHANGED");
  assert.throws(() => scanner.catalog("changed-generation", null), RuntimeError);
});

// Grow on mutation so open-descriptor timestamp caching cannot hide the metadata change under test.
for (const continuity of [false, true]) {
  test(`scan rejects a final-verification mutation ${continuity ? "after continuity checking" : "after an unchanged first observation"}`, async (t) => {
    const text = JSON.stringify(span(1, { "gen_ai.input.messages": "first" })) + "\n";
    const { sources, file } = await fixture(t, text);
    const scanner = new JsonlScan();
    await assert.rejects(sources.withStream("source-1", "", new AbortController().signal, async (source) => {
      if (continuity) await fs.appendFile(file, "\n");
      let checks = 0;
      return scanner.scan("late-change", { sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" }, {
        ...source,
        verify: async () => {
          if (checks++ === 1) await fs.writeFile(file, text.replace("first", "other") + (continuity ? "\n\n" : "\n"));
          return source.verify();
        },
      }, new AbortController().signal);
    }), (error) => error instanceof RuntimeError && error.code === "SOURCE_CHANGED");
    assert.throws(() => scanner.catalog("late-change", null), RuntimeError);
    assert.equal(scanner.status?.inputFinishedAtMs, null);
  });

  test(`detail rejects a post-read prefix mutation ${continuity ? "after continuity checking" : "at its first verification"}`, async (t) => {
    const text = JSON.stringify(span(1, { "gen_ai.input.messages": "first" })) + "\n";
    const { service, sources, file } = await fixture(t, text);
    const status = await scan(service);
    const sessionId = service.scanCatalog.catalog(status.id, null).sessions[0]!.id;
    await assert.rejects(sources.withStream("source-1", "", new AbortController().signal, (source) => {
      let checks = 0;
      return service.scanCatalog.details({ id: status.id, sessionId, cursor: null, fromMs: null, toMs: null }, {
        ...source,
        verify: async () => {
          if (checks++ === (continuity ? 1 : 0)) await fs.writeFile(file, text.replace("first", "other") + (continuity ? "\n\n" : "\n"));
          else if (continuity && checks === 1) await fs.appendFile(file, "\n");
          return source.verify();
        },
      }, new AbortController().signal);
    }), (error) => error instanceof RuntimeError && error.code === "SOURCE_CHANGED");
  });
}

test("detail continuity checking accepts append-only changes without including the new suffix", async (t) => {
  const text = JSON.stringify(span()) + "\n";
  const { service, sources, file } = await fixture(t, text);
  const status = await scan(service);
  const sessionId = service.scanCatalog.catalog(status.id, null).sessions[0]!.id;
  const page = await sources.withStream("source-1", "", new AbortController().signal, (source) => {
    let checks = 0;
    return service.scanCatalog.details({ id: status.id, sessionId, cursor: null, fromMs: null, toMs: null }, {
      ...source,
      verify: async () => {
        if (checks++ === 0) await fs.appendFile(file, JSON.stringify(span(2)) + "\n");
        return source.verify();
      },
    }, new AbortController().signal);
  });
  assert.equal(page.contributors.length, 1);
  assert.equal(page.contributors[0]?.fingerprint, createHash("sha256").update(text.slice(0, -1)).digest("hex"));
  assert.equal(service.scanCatalog.status?.appended, true);
  assert.equal(service.scanCatalog.status?.pass, 3);
  assert.equal(service.scanCatalog.status?.counts.executionRecords, 1);
});

test("filesystem open/read failures are controlled, descriptor-owned and recoverable without exposing raw errors", async (t) => {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { service } = await fixture(t, JSON.stringify(span()));
  const originalOpen = fs.open;
  t.mock.method(fs, "open", () => { throw Object.assign(new Error("FICTIONAL_PRIVATE_PATH"), { code: "EIO" }); });
  syncBuiltinESMExports();
  await assert.rejects(scan(service), (error) => error instanceof RuntimeError && error.code === "SOURCE_IO" && !error.message.includes("FICTIONAL"));
  t.mock.restoreAll(); syncBuiltinESMExports();
  let closed = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, "read", () => { throw Object.assign(new Error("FICTIONAL_PRIVATE_CONTENT"), { code: "EIO" }); });
    t.mock.method(handle, "close", async () => { closed++; await close(); });
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(scan(service), (error) => error instanceof RuntimeError && error.code === "SOURCE_IO" && !error.message.includes("FICTIONAL"));
  assert.equal(closed, 1);
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal((await scan(service)).sessions, 1);
});

test("failed descriptor closure overrides a successful catalog and blocks every later read until retry", async (t) => {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { service } = await fixture(t, JSON.stringify(span()));
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    t.mock.method(handle, "close", () => { throw new Error("FICTIONAL_CLOSE_PATH"); });
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(scan(service), (error) => error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED" && !error.message.includes("FICTIONAL"));
  assert.equal(service.scanCatalog.status?.phase, "cleanup-failed");
  assert.equal(service.scanCatalog.status?.sessions, null);
  await assert.rejects(service.read({ sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" }, new AbortController().signal),
    (error) => error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED");
  t.mock.restoreAll(); syncBuiltinESMExports();
  await service.close();
  assert.equal((await scan(service)).sessions, 1);
});

test("scan and detail controls are frozen before asynchronous admission", async (t) => {
  const { service } = await fixture(t, JSON.stringify(span()));
  const selection: ScanRequest = { requestId: "11111111-1111-4111-8111-111111111111",
    sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" };
  const pending = service.scan(selection, new AbortController().signal);
  selection.sourceId = "unapproved";
  selection.relativePath = "../unapproved";
  selection.requestId = "22222222-2222-4222-8222-222222222222";
  const result = await pending;
  assert.equal(result.sourceId, "source-1");
  assert.equal(result.requestId, "11111111-1111-4111-8111-111111111111");
  const controls: DetailRequest = { id: result.id, sessionId: service.scanCatalog.catalog(result.id, null).sessions[0]!.id,
    cursor: null, fromMs: null, toMs: null };
  const page = service.scanDetails(controls, new AbortController().signal);
  controls.sessionId = "another-session";
  controls.fromMs = Number.MAX_SAFE_INTEGER;
  assert.equal((await page).contributors.length, 1);
});

test("a detail-close failure stays latched even when the automatic descriptor retry succeeds", async (t) => {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { service } = await fixture(t, JSON.stringify(span()));
  const result = await scan(service);
  const sessionId = service.scanCatalog.catalog(result.id, null).sessions[0]!.id;
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const close = handle.close.bind(handle);
    let attempts = 0;
    t.mock.method(handle, "close", async () => {
      if (++attempts === 1) throw new Error("FICTIONAL_DETAIL_CLOSE_FAILURE");
      await close();
    });
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(details(service, result.id, sessionId),
    (error) => error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED");
  assert.equal(service.scanCatalog.status?.phase, "cleanup-failed");
  await assert.rejects(scan(service),
    (error) => error instanceof RuntimeError && error.code === "SOURCE_CLEANUP_FAILED");
  t.mock.restoreAll(); syncBuiltinESMExports();
  await service.close();
  assert.equal((await scan(service)).sessions, 1);
});

test("the metadata charge passes its exact boundary and rejects one additional charged byte", async () => {
  const text = JSON.stringify(span(1, { "copilot_chat.chat_session_id": "parent" }));
  const policy = { counts: counts(), maxMetadataBytes: 32768, maxIdentities: 1, maxReferences: 3,
    maxRecordBytes: STREAM_LIMITS.recordBytes, onLine() {} };
  let low = 0;
  let high = policy.maxMetadataBytes;
  while (high - low > 1) {
    const middle = Math.floor((high + low) / 2);
    try {
      await scanVscodeOtel(input(text), { ...policy, counts: counts(), maxMetadataBytes: middle });
      high = middle;
    } catch (error) {
      if (!(error instanceof ScanBudgetExceeded) || error.budget !== "metadata") throw error;
      low = middle;
    }
  }
  await scanVscodeOtel(input(text), { ...policy, counts: counts(), maxMetadataBytes: high });
  await assert.rejects(scanVscodeOtel(input(text), { ...policy, counts: counts(), maxMetadataBytes: high - 1 }),
    (error) => error instanceof ScanBudgetExceeded && error.budget === "metadata");
});

test("uppercase native IDs retain physical-line identity and never attach to lowercase executions", async (t) => {
  const traceId = "abcdef0123456789".repeat(2);
  const spanId = "abcdef0123456789";
  const text = [
    span(1, { "gen_ai.conversation.id": "upper" }, { traceId: traceId.toUpperCase(), spanId: spanId.toUpperCase() }),
    span(1, { "gen_ai.conversation.id": "lower" }, { traceId, spanId }),
  ].map((value) => JSON.stringify(value)).join("\n");
  const { service } = await fixture(t, text);
  const result = await scan(service);
  const sessions = service.scanCatalog.catalog(result.id, null).sessions;
  assert.equal(sessions.length, 2);
  const upper = await details(service, result.id, sessions[0]!.id);
  const lower = await details(service, result.id, sessions[1]!.id);
  assert.deepEqual(upper.contributors.map((entry) => entry.line), [1]);
  assert.deepEqual(lower.contributors.map((entry) => entry.line), [2]);
  assert.equal(upper.contributors[0]!.event.nativeId, null);
  assert.equal(lower.contributors[0]!.event.nativeId, spanId);
});

test("metrics, logs and content events sharing execution IDs do not consume detail pages or invalidate unchanged sources", async (t) => {
  const execution = span();
  const text = [...Array.from({ length: STREAM_LIMITS.pageRecords }, () => execution),
    { ...execution, hrTime: [1760000000, 0] },
    span(1, { "gen_ai.operation.name": "content_event" }), { ...execution, scopeMetrics: [] }]
    .map((value) => JSON.stringify(value)).join("\n");
  const { service } = await fixture(t, text);
  const result = await scan(service);
  const page = await details(service, result.id, service.scanCatalog.catalog(result.id, null).sessions[0]!.id);
  assert.deepEqual(page.contributors.map((entry) => entry.line),
    Array.from({ length: STREAM_LIMITS.pageRecords }, (_, index) => index + 1));
  assert.equal(page.next, null);
  assert.equal(service.scanCatalog.status?.phase, "complete");
});
