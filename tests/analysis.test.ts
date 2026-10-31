/** Consent, provenance, lifecycle and memory-only analysis regressions use synthetic evidence/providers. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  setImmediate as tick,
  setTimeout as delay,
} from "node:timers/promises";
import type { ModelInfo } from "@github/copilot-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseReadView } from "../src/evidence/contracts.js";
import {
  ANALYSIS_ACKNOWLEDGEMENT,
  ANALYSIS_INPUT_LIMIT,
  ANALYSIS_OUTPUT_LIMIT,
  type AnalysisProvider,
  type AnalysisRequest,
  type ProviderInput,
} from "../src/analysis/contracts.js";
import { AnalysisRunner } from "../src/analysis/runner.js";
import {
  MemorySessionFilesystem,
  SESSION_MEMORY_LIMIT,
} from "../src/analysis/memory-filesystem.js";
import {
  copilotClientOptions,
  copilotSessionOptions,
  checkAvailableContext,
  checkModelContext,
} from "../src/analysis/copilot.js";
import { startRuntime } from "../src/runtime/server.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { exampleReadView } from "./fixtures/read-view.js";
import {
  syntheticOperation,
  syntheticProvider,
  syntheticReader,
  syntheticResponse,
} from "./fixtures/analysis.js";

const request: AnalysisRequest = {
  readId: "read-fixture",
  sessionId: "session-fixture",
  operationId: "synthetic",
  acknowledgement: ANALYSIS_ACKNOWLEDGEMENT,
};

test("only the selected session reaches the provider and usage stays separate", async () => {
  const base = exampleReadView();
  const message = base.events[0];
  assert.ok(message);
  const view = parseReadView({
    ...base,
    sessions: [...base.sessions, { ...base.sessions[0], id: "other" }],
    events: [
      ...base.events,
      {
        ...message,
        id: "other-event",
        sessionId: "other",
        text: "DO_NOT_TRANSMIT",
      },
    ],
  });
  let calls = 0;
  const provider: AnalysisProvider = {
    ...syntheticProvider,
    async analyze(input, callbacks) {
      calls++;
      assert.ok(!input.prompt.includes("DO_NOT_TRANSMIT"));
      return syntheticProvider.analyze(input, callbacks);
    },
  };
  const runner = new AnalysisRunner(provider, [syntheticOperation]);
  await runner.availability();
  assert.equal(calls, 0);
  runner.start(view, request);
  await tick();
  const result = runner.run;
  assert.equal(result?.state, "succeeded");
  assert.equal(calls, 1);
  assert.deepEqual(result?.usage, { input: 7, output: 3, model: "synthetic" });
  assert.deepEqual(result?.result?.references, base.events[0]?.references);
  assert.equal(base.events[1]?.kind, "model-call");
  assert.ok(JSON.stringify(base).includes('"input":20'));
  if (result) result.usage.input = 999;
  assert.equal(runner.run?.usage.input, 7);
});

test("stale reads, missing definitions and empty evidence never invoke a model", async () => {
  const runner = new AnalysisRunner(syntheticProvider);
  assert.throws(() => runner.start(null, request), /Read the source again/);
  assert.throws(
    () => runner.start(exampleReadView(), request),
    /not installed/,
  );
  const registered = new AnalysisRunner(syntheticProvider, [
    syntheticOperation,
  ]);
  assert.throws(
    () =>
      registered.start(exampleReadView(), { ...request, sessionId: "other" }),
    /Select a session/,
  );
  assert.throws(
    () =>
      registered.start(
        parseReadView({ ...exampleReadView(), events: [] }),
        request,
      ),
    /No captured events/,
  );
});

test("invalid model envelopes, domain data and citations cannot become successful results", async () => {
  const variants = [
    () => "not JSON",
    (input: ProviderInput) =>
      syntheticResponse(input).replace("read-fixture", "stale-read"),
    (input: ProviderInput) =>
      syntheticResponse(input).replace("message-fixture", "unknown-event"),
    (input: ProviderInput) =>
      syntheticResponse(input).replace(
        '"eventIds":["message-fixture"]',
        '"eventIds":["message-fixture","message-fixture"]',
      ),
    (input: ProviderInput) =>
      syntheticResponse(input).replace('"answer":"synthetic"', '"answer":7'),
    () => "X".repeat(ANALYSIS_OUTPUT_LIMIT + 1),
  ];
  for (const variant of variants) {
    const runner = new AnalysisRunner(
      {
        ...syntheticProvider,
        async analyze(input) {
          return variant(input);
        },
      },
      [syntheticOperation],
    );
    runner.start(exampleReadView(), request);
    await tick();
    assert.equal(runner.run?.state, "failed");
    assert.equal(runner.run?.result, null);
    assert.ok(runner.run?.error?.code.startsWith("ANALYSIS_"));
  }
});

test("the exact serialized input byte limit is accepted and one additional byte is rejected", async () => {
  let bytes = 0;
  const provider: AnalysisProvider = {
    ...syntheticProvider,
    async analyze(input) {
      bytes = Buffer.byteLength(input.system) + Buffer.byteLength(input.prompt);
      return syntheticResponse(input);
    },
  };
  const base = exampleReadView();
  /** Change only message text so every boundary case has identical envelope overhead. */
  const withText = (text: string) =>
    parseReadView({
      ...base,
      events: base.events.map((event) =>
        event.kind === "message" ? { ...event, text } : event,
      ),
    });
  const runner = new AnalysisRunner(provider, [syntheticOperation]);
  runner.start(withText(""), request);
  await tick();
  const text = "X".repeat(ANALYSIS_INPUT_LIMIT - bytes);
  runner.start(withText(text), request);
  await tick();
  assert.equal(bytes, ANALYSIS_INPUT_LIMIT);
  assert.equal(runner.run?.state, "succeeded");
  assert.throws(() => runner.start(withText(text + "X"), request), /64 KiB/);
});

test("cancel, timeout and superseded reads discard results and sanitize abort reasons", async () => {
  const provider: AnalysisProvider = {
    ...syntheticProvider,
    async analyze(_input, callbacks) {
      await new Promise((_resolve, reject) => {
        callbacks.signal.addEventListener(
          "abort",
          () => reject(new Error("PRIVATE_ABORT_PAYLOAD")),
          { once: true },
        );
        if (callbacks.signal.aborted)
          reject(new Error("PRIVATE_ABORT_PAYLOAD"));
      });
      return "";
    },
  };
  const runner = new AnalysisRunner(provider, [syntheticOperation]);
  const run = runner.start(exampleReadView(), request);
  await tick();
  assert.throws(
    () => runner.start(exampleReadView(), request),
    /Wait for the current analysis/,
  );
  await runner.cancel(run.id);
  assert.equal(runner.run?.state, "cancelled");
  assert.ok(!JSON.stringify(runner.run).includes("PRIVATE_ABORT_PAYLOAD"));
  const timed = new AnalysisRunner(
    provider,
    [syntheticOperation],
    undefined,
    5,
  );
  timed.start(exampleReadView(), request);
  await delay(20);
  assert.equal(timed.run?.error?.code, "ANALYSIS_TIMEOUT");
  runner.start(exampleReadView(), request);
  await tick();
  runner.invalidate();
  await runner.close();
  assert.equal(runner.run, null);
});

test("a synchronous provider failure does not leave the runner permanently busy", async () => {
  let reports = 0;
  const runner = new AnalysisRunner(
    {
      ...syntheticProvider,
      analyze() {
        throw new Error("PRIVATE_FAILURE");
      },
    },
    [syntheticOperation],
    () => {
      reports++;
    },
  );
  runner.start(exampleReadView(), request);
  await tick();
  assert.equal(runner.run?.state, "failed");
  assert.ok(!JSON.stringify(runner.run).includes("PRIVATE_FAILURE"));
  runner.start(exampleReadView(), request);
  await tick();
  assert.equal(reports, 2);
});

test("cancellation discards an already completed result without cancelling a newer run", async () => {
  const runner = new AnalysisRunner(syntheticProvider, [syntheticOperation]);
  const first = runner.start(exampleReadView(), request);
  await tick();
  await runner.cancel(first.id);
  assert.equal(runner.run?.state, "cancelled");
  assert.equal(runner.run?.result, null);
  assert.equal(runner.run?.usage.input, 7);
  const second = runner.start(exampleReadView(), request);
  await tick();
  const cancel = runner.cancel(second.id);
  const newer = runner.start(exampleReadView(), request);
  await cancel;
  await tick();
  assert.equal(runner.run?.id, newer.id);
  assert.equal(runner.run?.state, "succeeded");
});

test("runtime shutdown retains its cleanup retry path after the network server has stopped", async () => {
  let fail = true;
  let attempts = 0;
  const runtime = await startRuntime(
    {
      sources: [],
      port: 0,
      harness: "copilot",
      model: null,
      copilotPath: null,
    },
    {
      analysisProvider: {
        ...syntheticProvider,
        async close() {
          attempts++;
          if (fail)
            throw new RuntimeError(
              "COPILOT_CLEANUP_FAILED",
              "Synthetic cleanup failure.",
              500,
            );
        },
      },
    },
  );
  try {
    await assert.rejects(runtime.close(), /cleanup failure/);
    fail = false;
    await runtime.close();
    assert.equal(attempts, 2);
  } finally {
    fail = false;
    await runtime.close();
  }
});

test("overdue synchronous results are rejected and cleanup failures are not reported as successful cancellation", async () => {
  const slow = new AnalysisRunner(
    {
      ...syntheticProvider,
      async analyze(input) {
        const until = performance.now() + 8;
        while (performance.now() < until) {
          /* Simulate non-preemptible provider work. */
        }
        return syntheticResponse(input);
      },
    },
    [syntheticOperation],
    undefined,
    1,
  );
  slow.start(exampleReadView(), request);
  await tick();
  assert.equal(slow.run?.error?.code, "ANALYSIS_TIMEOUT");
  const cleanup = new AnalysisRunner(
    {
      ...syntheticProvider,
      async analyze(_input, callbacks) {
        await new Promise<void>((resolve) =>
          callbacks.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        throw new RuntimeError(
          "COPILOT_CLEANUP_FAILED",
          "Controlled cleanup failure.",
          500,
        );
      },
    },
    [syntheticOperation],
  );
  const run = cleanup.start(exampleReadView(), request);
  await tick();
  await cleanup.cancel(run.id);
  assert.equal(cleanup.run?.state, "failed");
  assert.equal(cleanup.run?.error?.code, "COPILOT_CLEANUP_FAILED");
});

test("virtual filesystem preserves atomic file replacement, metadata and directory semantics", async () => {
  const fs = new MemorySessionFilesystem();
  await fs.writeFile("/sessions/item", "hello");
  await fs.appendFile("/sessions/item", " world");
  assert.equal(await fs.readFile("/sessions/item"), "hello world");
  const stat = await fs.stat("/sessions/item");
  assert.equal(stat.size, 11);
  assert.ok(Number.isFinite(Date.parse(stat.birthtime)));
  await fs.writeFile("/sessions/new", "replacement");
  await fs.rename("/sessions/new", "/sessions/item");
  assert.equal(await fs.readFile("/sessions/item"), "replacement");
  assert.deepEqual(await fs.readdirWithTypes("/sessions"), [
    { name: "item", type: "file" },
  ]);
  await assert.rejects(fs.rm("/sessions", false, false), /not empty/);
  await assert.rejects(fs.rename("/sessions", "/sessions/child"), /Invalid/);
  await assert.rejects(fs.rm("/", true, true), /virtual root/);
  await fs.rm("/sessions", true, false);
  await assert.rejects(fs.readFile("/sessions/item"), { code: "ENOENT" });
  await fs.rm("/missing", false, true);
  fs.dispose();
  await assert.rejects(fs.exists("/"), /closed/);
});

test("virtual filesystem enforces the exact byte limit without changing a failed write target", async () => {
  const fs = new MemorySessionFilesystem();
  const content = "X".repeat(SESSION_MEMORY_LIMIT);
  await fs.writeFile("/limit", content);
  await assert.rejects(fs.appendFile("/limit", "X"), /memory limit/);
  await assert.rejects(fs.writeFile("/limit", content + "X"), /memory limit/);
  assert.equal(await fs.readFile("/limit"), content);
  await fs.writeFile("/limit", "");
  for (let index = 0; index < 510; index++)
    await fs.writeFile(`/entry-${index}`, "");
  await assert.rejects(fs.writeFile("/extra", ""), /memory limit/);
  fs.dispose();
});

test("concurrent virtual calls cannot replace a file with a directory", async () => {
  const fs = new MemorySessionFilesystem();
  const results = await Promise.allSettled([
    fs.writeFile("/entry", "preserve this file"),
    fs.mkdir("/entry", true),
  ]);
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  assert.equal(await fs.readFile("/entry"), "preserve this file");
  fs.dispose();
});

test("a virtual rename rejects oversized descendant paths before changing either subtree", async () => {
  const fs = new MemorySessionFilesystem();
  await fs.writeFile("/from/file", "preserved");
  await assert.rejects(fs.rename("/from", "/" + "x".repeat(4091)), /Invalid/);
  assert.equal(await fs.readFile("/from/file"), "preserved");
  fs.dispose();
});

test("Copilot settings enforce memory storage, no tools/customizations and process-local telemetry opt-out", () => {
  const options = copilotClientOptions("/chosen/copilot", "/owned/temp", false);
  assert.equal(options.mode, "empty");
  assert.equal(options.logLevel, "none");
  assert.equal(options.useLoggedInUser, false);
  assert.equal(options.env?.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  assert.equal(options.env?.GH_TOKEN, undefined);
  assert.equal(options.env?.OTEL_SDK_DISABLED, "true");
  assert.equal(options.sessionFs?.capabilities?.sqlite, false);
  const fs = new MemorySessionFilesystem();
  const session = copilotSessionOptions(
    fs,
    { system: "trusted", prompt: "synthetic" },
    "requested",
  );
  assert.deepEqual(session.availableTools, []);
  assert.deepEqual(session.allowedModels, ["requested"]);
  assert.equal(session.enableFileHooks, false);
  assert.equal(session.enableManagedSettings, true);
  assert.equal(session.enableSessionStore, false);
  assert.equal(session.embeddingCacheStorage, "in-memory");
});

test("model admission supports lazy defaults and Auto without inventing a selected model or ignoring limits", () => {
  const large: ModelInfo = {
    id: "large",
    name: "Synthetic large",
    capabilities: {
      supports: { vision: false, reasoningEffort: false },
      limits: {
        max_context_window_tokens: 10_000,
        max_prompt_tokens: 7000,
        max_output_tokens: 1000,
      },
    },
  };
  const small: ModelInfo = {
    ...large,
    id: "small",
    capabilities: {
      ...large.capabilities,
      limits: { ...large.capabilities.limits, max_prompt_tokens: 6000 },
    },
  };
  const auto: ModelInfo = {
    ...large,
    id: "auto",
    capabilities: {
      ...large.capabilities,
      limits: { max_context_window_tokens: 0 },
    },
  };
  const boundary = { system: "", prompt: "X".repeat(2904) };
  checkModelContext(boundary, large);
  assert.throws(
    () =>
      checkModelContext({ ...boundary, prompt: boundary.prompt + "X" }, large),
    /context budget/,
  );
  checkAvailableContext(boundary, [auto, large], "auto");
  checkAvailableContext(boundary, [auto, large]);
  assert.throws(
    () => checkAvailableContext(boundary, [auto, large, small]),
    /context budget/,
  );
  checkAvailableContext(boundary, [auto, large, small], "large");
  assert.throws(
    () => checkAvailableContext(boundary, [auto]),
    /context limits/,
  );
  assert.throws(
    () => checkAvailableContext(boundary, [large], "missing"),
    /context limits/,
  );
});

test("HTTP analysis requires launch access, matching origin and explicit acknowledgement", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-insights-analysis-api-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "synthetic.jsonl");
  await writeFile(file, "SYNTHETIC");
  let calls = 0;
  const runtime = await startRuntime(
    {
      sources: [file],
      port: 0,
      harness: "copilot",
      model: null,
      copilotPath: null,
    },
    {
      readers: [syntheticReader],
      analysisOperations: [syntheticOperation],
      analysisProvider: {
        ...syntheticProvider,
        async analyze(input, callbacks) {
          calls++;
          return syntheticProvider.analyze(input, callbacks);
        },
      },
    },
  );
  t.after(() => runtime.close());
  const headers = {
    Origin: runtime.origin,
    "X-Agent-Insights-Token": runtime.token,
    "Content-Type": "application/json",
  };
  const status = await runtime.service.status();
  const source = status.sources[0];
  assert.ok(source);
  const view = await runtime.service.read(
    { sourceId: source.id, relativePath: "", format: "vscode-otel-jsonl" },
    new AbortController().signal,
  );
  const body = { ...request, readId: view.id };
  assert.equal(
    (
      await fetch(runtime.origin + "/api/analysis/start", {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(runtime.origin + "/api/analysis/start", {
        method: "POST",
        headers: { ...headers, Origin: "http://evil.invalid" },
        body: JSON.stringify(body),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(runtime.origin + "/api/analysis/start", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, acknowledgement: "" }),
      })
    ).status,
    400,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await fetch(runtime.origin + "/api/analysis/start", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
    ).status,
    202,
  );
  await tick();
  assert.equal(calls, 1);
  assert.equal(runtime.service.analysis?.run?.state, "succeeded");
  await fetch(runtime.origin + "/api/refresh", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(runtime.service.analysis?.run, null);
  assert.equal(calls, 1);
});
