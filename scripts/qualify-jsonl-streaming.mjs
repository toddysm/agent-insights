/**
 * Independently generate owned large fixtures, measure fresh-process RSS and
 * verify exact catalog/provenance results. Prints aggregate receipts only; no
 * private capture, model runtime, retained corpus or persistent index is used.
 * A passed receipt requires a clean working tree and unchanged HEAD throughout.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SourceAccess } from "../.build/src/runtime/sources.js";
import { RuntimeService } from "../.build/src/runtime/service.js";
import { productionReaders } from "../.build/src/evidence/readers/index.js";

const MiB = 1024 * 1024;
const workerSize = Number(process.argv[2] ?? 0);

/** Read provenance from Git; command failures must not produce a successful receipt. */
function gitOutput(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Generate one exactly 64 KiB terminated execution record with a bounded ignored padding field. */
function execution(variant = "base") {
  const raw = {
    traceId: "1".repeat(32), spanId: "0000000000000001", name: "chat fictional", kind: 2,
    startTime: [1760000000, 0], endTime: [1760000001, 0], ended: true, status: { code: 1 },
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.conversation.id": "synthetic-scale",
      "gen_ai.request.model": "fictional", "gen_ai.usage.input_tokens": 20, "gen_ai.usage.output_tokens": 5 },
    resource: { attributes: { "service.name": "synthetic-scale" } },
    instrumentationScope: { name: "synthetic" }, padding: "",
  };
  if (variant !== "base") {
    raw.spanId = variant === "unassigned" ? "0000000000000003" : "0000000000000002";
    if (variant === "unassigned") delete raw.attributes["gen_ai.conversation.id"];
    else raw.attributes["gen_ai.input.messages"] = variant;
  }
  const empty = JSON.stringify(raw);
  raw.padding = "x".repeat(64 * 1024 - Buffer.byteLength(empty) - 1);
  const bytes = Buffer.from(JSON.stringify(raw) + "\n");
  assert.equal(bytes.length, 64 * 1024);
  return bytes;
}

/** Write incrementally, bounding partial-write handling and never building a file-sized buffer. */
async function generate(file, size) {
  const handle = await open(file, "wx");
  try {
    const record = execution();
    const variants = [record, execution("conflict-first"), execution("conflict-second"), execution("unassigned")];
    for (let position = 0; position < size;) {
      const bytes = size - position >= record.length
        ? (variants[position / record.length] ?? record)
        : Buffer.from("\n".repeat(size - position));
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, position + written);
        assert.ok(result.bytesWritten > 0);
        written += result.bytesWritten;
      }
      position += bytes.length;
    }
  } finally { await handle.close(); }
}

/** Build the real service with no analysis runner or native source input. */
async function serviceFor(file) {
  return new RuntimeService(await SourceAccess.create([file]),
    { sources: [file], port: 0, harness: "copilot", model: null, copilotPath: null }, productionReaders);
}

/** Scan and verify counts plus exact first-contributor coordinates without loading all payloads. */
async function run(service, size) {
  const result = await service.scan({ sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" }, new AbortController().signal);
  assert.equal(result.phase, "partial");
  const expected = Math.floor(size / (64 * 1024));
  assert.equal(result.scannedBytes, size);
  assert.equal(result.counts.records, expected + (size % (64 * 1024) ? 1 : 0));
  assert.equal(result.counts.duplicates, expected - 4);
  assert.equal(result.counts.executionRecords, expected);
  assert.equal(result.counts.unclassifiedRecords, 0);
  assert.equal(result.counts.blank, size % (64 * 1024) ? 1 : 0);
  assert.equal(result.classification.executions.modelCalls, 2);
  assert.equal(result.classification.conflictingSpans, 1);
  assert.equal(result.sessions, 1);
  assert.equal(result.unassigned, 1);
  const page = service.scanCatalog.catalog(result.id, null);
  assert.equal(page.sessions[0].executions, 1);
  assert.equal(service.view, null);
  return result;
}

if (workerSize) {
  assert.ok(Number.isSafeInteger(workerSize) && workerSize >= 64 * MiB && workerSize <= 1024 * MiB);
  const root = await mkdtemp(path.join(tmpdir(), "agent-insights-stream-scale-"));
  const file = path.join(root, "synthetic.jsonl");
  const warm = path.join(root, "warm.jsonl");
  let service;
  try {
    await generate(warm, 2 * MiB);
    const warmService = await serviceFor(warm);
    await run(warmService, 2 * MiB);
    await warmService.close();
    await generate(file, workerSize);
    service = await serviceFor(file);
    global.gc?.();
    const baseline = process.memoryUsage();
    let peak = { ...baseline };
    /** Sample external and array-buffer allocations as well as heap/RSS during actual asynchronous reads. */
    const sample = () => {
      const memory = process.memoryUsage();
      for (const key of ["rss", "heapUsed", "external", "arrayBuffers"])
        peak[key] = Math.max(peak[key], memory[key]);
    };
    const timer = setInterval(sample, 5);
    const started = performance.now();
    let result;
    let scanElapsedMs;
    let detailElapsedMs;
    try {
      result = await run(service, workerSize);
      scanElapsedMs = Math.round(performance.now() - started);
      const sessionId = service.scanCatalog.catalog(result.id, null).sessions[0].id;
      const detailStart = performance.now();
      const details = await service.scanDetails({ id: result.id, sessionId,
        cursor: null, fromMs: null, toMs: null }, new AbortController().signal);
      detailElapsedMs = Math.round(performance.now() - detailStart);
      assert.equal(details.contributors[0].byteOffset, 0);
      assert.equal(details.contributors[0].line, 1);
      assert.equal(details.contributors[0].byteLength, 64 * 1024 - 1);
      assert.equal(details.contributors[0].fingerprint,
        createHash("sha256").update(execution().subarray(0, -1)).digest("hex"));
      assert.ok(details.next);
      assert.ok(details.contributors.length <= 20);
    }
    finally { clearInterval(timer); sample(); }
    const maxRss = Math.max(peak.rss, process.resourceUsage().maxRSS * 1024);
    console.log(JSON.stringify({
      sourceBytes: workerSize, node: process.version, platform: process.platform, arch: process.arch,
      elapsedMs: Math.round(performance.now() - started), scanElapsedMs, detailElapsedMs, baseline,
      peak: { ...peak, rss: maxRss }, additionalPeakRss: Math.max(0, maxRss - baseline.rss),
      records: result.counts.records, duplicates: result.counts.duplicates,
      sessions: result.sessions, modelCalls: result.classification.executions.modelCalls,
      scannedBytes: result.scannedBytes, scope: "synthetic-fixed-cardinality-not-real-capture-compatibility",
    }));
  } finally {
    await service?.close();
    assert.ok(path.basename(root).startsWith("agent-insights-stream-scale-"));
    await rm(root, { recursive: true });
  }
} else {
  const revision = gitOutput("rev-parse", "HEAD").trim();
  assert.equal(gitOutput("status", "--porcelain"), "", "Qualification requires a clean committed working tree");
  const receipts = [];
  for (const size of [64 * MiB + 1, 128 * MiB, 384 * MiB, 1024 * MiB]) {
    const worker = spawnSync(process.execPath, ["--expose-gc", import.meta.filename, String(size)], {
      encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: MiB,
    });
    if (worker.error) throw worker.error;
    assert.equal(worker.status, 0, worker.stderr);
    receipts.push(JSON.parse(worker.stdout));
  }
  const small = receipts.find((receipt) => receipt.sourceBytes === 128 * MiB);
  const large = receipts.find((receipt) => receipt.sourceBytes === 1024 * MiB);
  assert.ok(large.additionalPeakRss <= 256 * MiB, "1 GiB scan exceeds 256 MiB additional peak RSS");
  const rssGrowth = large.peak.rss - small.peak.rss;
  assert.ok(rssGrowth <= 64 * MiB, "128 MiB to 1 GiB peak RSS growth exceeds 64 MiB");
  assert.equal(gitOutput("rev-parse", "HEAD").trim(), revision, "HEAD changed during qualification");
  const dirty = gitOutput("status", "--porcelain");
  assert.equal(dirty, "", "The working tree changed during qualification");
  console.log(JSON.stringify({ revision, workingTreeDirty: dirty.length > 0, receipts, rssGrowth,
    gates: { additionalRssBytes: 256 * MiB, growthBytes: 64 * MiB }, result: "passed" }, null, 2));
}
