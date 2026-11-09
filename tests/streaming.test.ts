/** Synthetic bounded-stream, provenance, paging and cleanup regressions; no private capture or model access. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { jsonLines } from "../src/evidence/readers/jsonl.js";
import { scanVscodeOtel, vscodeOtelReader } from "../src/evidence/readers/vscode-otel.js";
import { productionReaders } from "../src/evidence/readers/index.js";
import { STREAM_LIMITS, ScanBudgetExceeded, type ScanCounts, type ScanRequest, type DetailRequest } from "../src/evidence/streaming.js";
import { SourceAccess } from "../src/runtime/sources.js";
import { RuntimeService } from "../src/runtime/service.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { JsonlScan } from "../src/runtime/jsonl-scan.js";
import { byteChunks, type StreamedSource } from "../src/runtime/sources.js";
import { startRuntime } from "../src/runtime/server.js";
import type { ReaderInput } from "../src/evidence/contracts.js";

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
async function catalogFor(text: string, limits = STREAM_LIMITS) {
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
  now = 1000;
  assert.throws(() => scanner.catalog("synthetic-generation", null),
    (error) => error instanceof RuntimeError && error.code === "SCAN_EXPIRED");
  now = 1001;
  assert.throws(() => scanner.catalog("synthetic-generation", null), RuntimeError);
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
  const selection: ScanRequest = { sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" };
  const pending = service.scan(selection, new AbortController().signal);
  selection.sourceId = "unapproved";
  selection.relativePath = "../unapproved";
  const result = await pending;
  assert.equal(result.sourceId, "source-1");
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
  const text = JSON.stringify(span());
  const policy = { counts: counts(), maxMetadataBytes: 32768, maxIdentities: 1, maxReferences: 2,
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
