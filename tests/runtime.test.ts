/** Runtime integration/security regressions use only owned synthetic files and internal test readers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import {
  parseReadView,
  type EvidenceReader,
  type ReaderInput,
  type ReadView,
} from "../src/evidence/contracts.js";
import { parseConfig, type RuntimeConfig } from "../src/runtime/config.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { errorSchema, statusSchema } from "../src/runtime/protocol.js";
import {
  allowedHost,
  loopbackOrigin,
  startRuntime,
  type RunningRuntime,
} from "../src/runtime/server.js";
import { RuntimeService } from "../src/runtime/service.js";
import {
  MAX_SOURCE_BYTES,
  pointsToOpenedFile,
  SourceAccess,
} from "../src/runtime/sources.js";

/** Create a uniquely owned fixture directory; never clean user or repository source locations. */
async function fixture(
  t: TestContext,
): Promise<{ root: string; allowed: string; file: string; outside: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-insights-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "allowed-sibling");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  const file = path.join(allowed, "capture.jsonl");
  await Promise.all([
    writeFile(file, "SYNTHETIC_SOURCE_CONTENT"),
    writeFile(path.join(outside, "private.txt"), "OUTSIDE_MARKER"),
  ]);
  return { root, allowed, file, outside };
}

/** Return the approved startup baseline with no model connection or implicit sources. */
function config(sources: readonly string[] = []): RuntimeConfig {
  return {
    sources,
    port: 0,
    harness: "copilot",
    model: null,
    copilotPath: null,
  };
}

/** Construct a structurally valid synthetic result; this is deliberately not a source-format parser. */
function readerView(input: ReaderInput, text: string): ReadView {
  const reference = {
    sourceId: input.sourceId,
    recordId: "fixture-record",
    location: { kind: "jsonl", line: 1, pointer: "" },
  };
  const unavailable = {
    status: "unavailable",
    reason: "Synthetic reader has no telemetry",
  };
  return parseReadView({
    schemaVersion: 1,
    id: input.readId,
    startedAtMs: 1,
    finishedAtMs: 2,
    sources: [
      {
        id: input.sourceId,
        format: "vscode-otel-jsonl",
        identity: {
          producer: "synthetic",
          version: null,
          executionHost: "unknown",
        },
        changedDuringRead: false,
        coverage: {
          messages: { status: "complete" },
          timing: unavailable,
          tools: unavailable,
          tokens: unavailable,
        },
      },
    ],
    sessions: [
      {
        id: "fixture-session",
        nativeId: null,
        sourceIds: [input.sourceId],
        references: [reference],
      },
    ],
    events: [
      {
        id: "fixture-message",
        sessionId: "fixture-session",
        nativeId: null,
        parentNativeId: null,
        references: [reference],
        kind: "message",
        role: "user",
        instructionId: null,
        text,
        timestampMs: null,
      },
    ],
    issues: [],
  });
}

/** Consume only the supplied byte stream, proving integration without installing a production reader. */
const syntheticReader: EvidenceReader = {
  format: "vscode-otel-jsonl",
  async read(input) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input.bytes) chunks.push(chunk);
    return readerView(input, Buffer.concat(chunks).toString("utf8"));
  },
};

/** Call a protected route with this test runtime's credential, never a real harness credential. */
async function api(
  runtime: RunningRuntime,
  route: string,
  body?: unknown,
): Promise<Response> {
  return fetch(runtime.origin + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Agent-Insights-Token": runtime.token,
      ...(body === undefined
        ? {}
        : { Origin: runtime.origin, "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("startup configuration is explicit, bounded and Copilot-first", () => {
  assert.equal(parseConfig(["--help"]), null);
  assert.deepEqual(parseConfig([]), config());
  const selected = parseConfig([
    "--source",
    "capture",
    "--source",
    "second",
    "--model",
    "chosen-model",
    "--copilot-path",
    "/custom/copilot",
  ]);
  assert.deepEqual(selected?.sources, ["capture", "second"]);
  assert.equal(selected?.model, "chosen-model");
  assert.equal(selected?.copilotPath, "/custom/copilot");
  for (const args of [
    ["--source", ""],
    ["--port", "-1"],
    ["--port", "1.5"],
    ["--port", "65536"],
    ["--harness", "unimplemented"],
    ["--model", ""],
    ["--unexpected"],
    ["positional"],
  ])
    assert.throws(() => parseConfig(args), RuntimeError);
});

test("HTTP default-port normalization accepts valid loopback forms without broadening the host policy", () => {
  assert.equal(loopbackOrigin(80), "http://127.0.0.1");
  assert.equal(allowedHost("127.0.0.1", loopbackOrigin(80)), true);
  assert.equal(allowedHost("127.0.0.1:80", loopbackOrigin(80)), true);
  assert.equal(allowedHost("127.0.0.1:1234", loopbackOrigin(1234)), true);
  for (const host of [
    undefined,
    "localhost",
    "unapproved.invalid",
    "user@127.0.0.1",
    "127.0.0.1/path",
    "127.0.0.1:65536",
    "127.0.0.1:1234",
  ]) {
    assert.equal(allowedHost(host, loopbackOrigin(80)), false);
  }
});

test("source grants reject traversal, prefix siblings, absolute paths and unknown grants", async (t) => {
  const data = await fixture(t);
  const access = await SourceAccess.create([data.allowed]);
  const signal = new AbortController().signal;
  for (const [sourceId, relativePath] of [
    ["source-1", "../allowed-sibling/private.txt"],
    ["source-1", data.file],
    ["source-1", "\0"],
    ["unknown", "capture.jsonl"],
  ]) {
    assert.ok(sourceId !== undefined && relativePath !== undefined);
    await assert.rejects(access.read(sourceId, relativePath, signal), {
      code: "SOURCE_SCOPE",
    });
  }
  await assert.rejects(access.read("source-1", "", signal), {
    code: "NOT_A_FILE",
  });
  await assert.rejects(SourceAccess.create([""]), { code: "INVALID_SOURCES" });
});

test("symlink escapes and changed configured targets are rejected", async (t) => {
  const data = await fixture(t);
  const escape = path.join(data.allowed, "escape");
  const alias = path.join(data.root, "alias");
  await symlink(data.outside, escape, "junction");
  await symlink(data.allowed, alias, "junction");
  const access = await SourceAccess.create([data.allowed, alias]);
  await assert.rejects(
    access.read("source-1", "escape/private.txt", new AbortController().signal),
    { code: "SOURCE_SCOPE" },
  );
  await unlink(alias);
  await symlink(data.outside, alias, "junction");
  await assert.rejects(
    access.read("source-2", "private.txt", new AbortController().signal),
    { code: "ROOT_CHANGED" },
  );
  assert.equal((await access.list())[1]?.available, false);
});

test("a configured root retargeted after opening a file cannot return old-target bytes", async (t) => {
  const data = await fixture(t);
  const alias = path.join(data.root, "in-flight-alias");
  await symlink(data.allowed, alias, "junction");
  const access = await SourceAccess.create([alias]);
  const target = await realpath(data.file);
  const originalOpen = fsPromises.open;
  let retargeted = false;
  const mock = t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (!retargeted && args[0] === target) {
        await unlink(alias);
        await symlink(data.outside, alias, "junction");
        retargeted = true;
      }
      return handle;
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      access.read("source-1", "capture.jsonl", new AbortController().signal),
      { code: "ROOT_CHANGED" },
    );
    assert.equal(retargeted, true);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("file grants read in place without creating a source replica or modifying content", async (t) => {
  const data = await fixture(t);
  const before = createHash("sha256")
    .update(await readFile(data.file))
    .digest("hex");
  const entries = await readdir(data.allowed);
  const access = await SourceAccess.create([
    data.file,
    path.join(data.root, "missing"),
  ]);
  const captured = await access.read(
    "source-1",
    "",
    new AbortController().signal,
  );
  assert.equal(
    Buffer.from(captured.bytes).toString("utf8"),
    "SYNTHETIC_SOURCE_CONTENT",
  );
  assert.equal(captured.changed, false);
  assert.ok(captured.finishedAtMs >= captured.startedAtMs);
  await assert.rejects(
    access.read("source-1", "../private.txt", new AbortController().signal),
    { code: "SOURCE_SCOPE" },
  );
  assert.equal((await access.list())[1]?.available, false);
  assert.equal(
    createHash("sha256")
      .update(await readFile(data.file))
      .digest("hex"),
    before,
  );
  assert.deepEqual(await readdir(data.allowed), entries);
  await unlink(data.file);
  assert.equal((await access.list())[0]?.available, false);
});

test("default service reports absent readers and analyzer honestly", async (t) => {
  const data = await fixture(t);
  const service = new RuntimeService(
    await SourceAccess.create([data.file]),
    config([data.file]),
  );
  const status = await service.status();
  assert.deepEqual(status.readers, []);
  assert.equal(status.analysis.available, false);
  assert.equal(status.analysis.harness, "copilot");
  assert.equal(status.analysis.remoteProcessing, true);
  assert.equal(service.view, null);
  await assert.rejects(
    service.read(
      { sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" },
      new AbortController().signal,
    ),
    { code: "READER_UNAVAILABLE" },
  );
});

test("post-read identity checks notice replacement or disappearance of an open source", async (t) => {
  const data = await fixture(t);
  const canonical = await realpath(data.file);
  const handle = await open(data.file, "r");
  try {
    const identity = await handle.stat({ bigint: true });
    assert.equal(
      await pointsToOpenedFile(data.file, canonical, identity),
      true,
    );
    await rename(data.file, data.file + ".rotated");
    await writeFile(data.file, "REPLACEMENT");
    assert.equal(
      await pointsToOpenedFile(data.file, canonical, identity),
      false,
    );
    await unlink(data.file);
    assert.equal(
      await pointsToOpenedFile(data.file, canonical, identity),
      false,
    );
  } finally {
    await handle.close();
  }
});

test("the source byte limit accepts exactly 64 MiB and rejects one additional byte", async (t) => {
  const data = await fixture(t);
  const access = await SourceAccess.create([data.file]);
  await truncate(data.file, MAX_SOURCE_BYTES);
  const atLimit = await access.read(
    "source-1",
    "",
    new AbortController().signal,
  );
  assert.equal(atLimit.bytes.length, MAX_SOURCE_BYTES);
  await truncate(data.file, MAX_SOURCE_BYTES + 1);
  await assert.rejects(
    access.read("source-1", "", new AbortController().signal),
    { code: "SOURCE_TOO_LARGE" },
  );
});

test("registered readers produce only a transient current generation", async (t) => {
  const data = await fixture(t);
  const sources = await SourceAccess.create([data.file]);
  const service = new RuntimeService(sources, config([data.file]), [
    syntheticReader,
  ]);
  const view = await service.read(
    { sourceId: "source-1", relativePath: "", format: "vscode-otel-jsonl" },
    new AbortController().signal,
  );
  const event = view.events[0];
  assert.ok(event?.kind === "message");
  assert.equal(event.text, "SYNTHETIC_SOURCE_CONTENT");
  assert.equal(service.view?.id, view.id);
  service.invalidate();
  assert.equal(service.view, null);
  const restarted = new RuntimeService(
    await SourceAccess.create([data.file]),
    config([data.file]),
    [syntheticReader],
  );
  assert.equal(restarted.view, null);
  assert.throws(
    () =>
      new RuntimeService(sources, config(), [syntheticReader, syntheticReader]),
    /Expected one reader/,
  );
});

test("read completion includes adapter work while retaining the actual input observation bounds", async (t) => {
  const data = await fixture(t);
  let adapterStartedAt = 0;
  let adapterFinishedAt = 0;
  const reader: EvidenceReader = {
    format: "vscode-otel-jsonl",
    async read(input) {
      adapterStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const view = readerView(input, "SYNTHETIC");
      adapterFinishedAt = Date.now();
      return view;
    },
  };
  const service = new RuntimeService(
    await SourceAccess.create([data.file]),
    config([data.file]),
    [reader],
  );
  const view = await service.read(
    { sourceId: "source-1", relativePath: "", format: reader.format },
    new AbortController().signal,
  );
  const timing = (await service.status()).readTiming;
  assert.ok(timing);
  assert.equal(timing.readId, view.id);
  assert.ok(timing.inputFinishedAtMs <= adapterStartedAt);
  assert.ok(view.finishedAtMs >= adapterFinishedAt);
  assert.equal(timing.finishedAtMs, view.finishedAtMs);
  assert.ok(timing.inputFinishedAtMs < timing.finishedAtMs);
  service.invalidate();
  assert.equal((await service.status()).readTiming, null);
});

test("an in-flight selection cannot be relabeled by mutating the caller's request", async (t) => {
  const data = await fixture(t);
  const service = new RuntimeService(
    await SourceAccess.create([data.file]),
    config([data.file]),
    [syntheticReader],
  );
  const selection = {
    sourceId: "source-1",
    relativePath: "",
    format: syntheticReader.format,
  };
  const pending = service.read(selection, new AbortController().signal);
  selection.sourceId = "other-source";
  selection.relativePath = "different.jsonl";
  const view = await pending;
  assert.equal(view.sources[0]?.id, "source-1");
  assert.equal(service.selection?.sourceId, "source-1");
  assert.equal(service.selection?.relativePath, "");
  assert.ok(Object.isFrozen(service.selection));
  service.invalidate();
  assert.equal(service.selection, null);
});

test("readers cannot return another generation, source or format", async (t) => {
  const data = await fixture(t);
  for (const mismatch of ["generation", "source", "format"]) {
    const reader: EvidenceReader = {
      format: "vscode-otel-jsonl",
      async read(input) {
        const scopedInput =
          mismatch === "source" ? { ...input, sourceId: "unrelated" } : input;
        const view = readerView(scopedInput, "SYNTHETIC");
        if (mismatch === "generation")
          return parseReadView({ ...view, id: "old-generation" });
        if (mismatch === "format")
          return parseReadView({
            ...view,
            sources: view.sources.map((source) => ({
              ...source,
              format: "vscode-chat-v3-json",
            })),
          });
        return view;
      },
    };
    const service = new RuntimeService(
      await SourceAccess.create([data.file]),
      config([data.file]),
      [reader],
    );
    await assert.rejects(
      service.read(
        { sourceId: "source-1", relativePath: "", format: reader.format },
        new AbortController().signal,
      ),
      { code: "INVALID_READER_RESULT" },
    );
    assert.equal(service.view, null);
  }
});

test("cancelled or superseded reads cannot publish a late result", async (t) => {
  const data = await fixture(t);
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked: EvidenceReader = {
    format: "vscode-otel-jsonl",
    async read(input) {
      entered?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return readerView(input, "LATE_SYNTHETIC_RESULT");
    },
  };
  const service = new RuntimeService(
    await SourceAccess.create([data.file]),
    config([data.file]),
    [blocked],
  );
  const pending = service.read(
    { sourceId: "source-1", relativePath: "", format: blocked.format },
    new AbortController().signal,
  );
  await started;
  service.invalidate();
  await assert.rejects(pending, { code: "READ_CANCELLED" });
  release?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.view, null);
});

test("adapter abort errors are normalized without exposing their payloads", async (t) => {
  const data = await fixture(t);
  let began: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const reader: EvidenceReader = {
    format: "vscode-otel-jsonl",
    read(input) {
      return new Promise<ReadView>((_, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("PRIVATE_ABORT_DETAIL")),
          { once: true },
        );
        began?.();
      });
    },
  };
  const service = new RuntimeService(
    await SourceAccess.create([data.file]),
    config([data.file]),
    [reader],
  );
  const controller = new AbortController();
  const pending = service.read(
    { sourceId: "source-1", relativePath: "", format: reader.format },
    controller.signal,
  );
  const rejected = assert.rejects(pending, { code: "READ_CANCELLED" });
  await started;
  controller.abort();
  await rejected;
  assert.equal(service.view, null);
});

test("a reader that ignores cancellation is bounded by the runtime deadline", async (t) => {
  const data = await fixture(t);
  const reader: EvidenceReader = {
    format: "vscode-otel-jsonl",
    read: () => new Promise<ReadView>(() => {}),
  };
  const service = new RuntimeService(
    await SourceAccess.create([data.file]),
    config([data.file]),
    [reader],
    10,
  );
  const keepAlive = setInterval(() => {}, 50);
  try {
    await assert.rejects(
      service.read(
        { sourceId: "source-1", relativePath: "", format: reader.format },
        new AbortController().signal,
      ),
      { code: "READ_TIMEOUT" },
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(service.view, null);
});

test("a superseded operation cannot overwrite or cancel a newer completed read", async (t) => {
  const data = await fixture(t);
  let release: (() => void) | undefined;
  let began: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let calls = 0;
  const reader: EvidenceReader = {
    format: "vscode-otel-jsonl",
    async read(input) {
      if (++calls === 1) {
        began?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return readerView(input, "OLD");
      }
      return readerView(input, "NEW");
    },
  };
  const service = new RuntimeService(
    await SourceAccess.create([data.file]),
    config([data.file]),
    [reader],
  );
  const selection = {
    sourceId: "source-1",
    relativePath: "",
    format: reader.format,
  };
  const old = service.read(selection, new AbortController().signal);
  const oldRejected = assert.rejects(old, { code: "READ_CANCELLED" });
  await started;
  const latest = await service.read(selection, new AbortController().signal);
  await oldRejected;
  release?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.view?.id, latest.id);
});

test("HTTP boundary requires launch access and approved origins without exposing credentials", async (t) => {
  const data = await fixture(t);
  const runtime = await startRuntime(config([data.file]));
  t.after(() => runtime.close());
  const page = await fetch(runtime.origin);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(html.includes(runtime.token), false);
  assert.equal(html.includes(data.file), false);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.equal((await fetch(runtime.origin + "/api/status")).status, 401);
  assert.equal(
    (
      await fetch(runtime.origin + "/api/refresh", {
        method: "POST",
        headers: {
          "X-Agent-Insights-Token": runtime.token,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(runtime.origin + "/api/status", {
        headers: {
          "X-Agent-Insights-Token": runtime.token,
          Origin: "https://unapproved.invalid",
        },
      })
    ).status,
    403,
  );
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      runtime.origin + "/api/status",
      {
        headers: {
          Host: "unapproved.invalid",
          "X-Agent-Insights-Token": runtime.token,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(wrongHost, 403);
  const status = statusSchema.parse(
    await (await api(runtime, "/api/status")).json(),
  );
  assert.equal(status.sources[0]?.path, data.file);
  assert.equal((await api(runtime, "/api/view")).status, 404);
  assert.equal((await api(runtime, "/api/refresh", {})).status, 200);
  assert.equal(
    (await api(runtime, "/api/refresh", { capture: "not-an-upload" })).status,
    400,
  );
  assert.equal(
    (
      await api(runtime, "/api/read", {
        sourceId: "source-1",
        relativePath: "",
        format: "vscode-otel-jsonl",
      })
    ).status,
    501,
  );
});

test("HTTP source reads preserve scope and do not persist or log payloads", async (t) => {
  const data = await fixture(t);
  const diagnostics: unknown[] = [];
  const runtime = await startRuntime(config([data.allowed]), {
    readers: [syntheticReader],
    onDiagnostic: (event) => diagnostics.push(event),
  });
  t.after(() => runtime.close());
  const payload = {
    sourceId: "source-1",
    relativePath: "capture.jsonl",
    format: "vscode-otel-jsonl",
  };
  const response = await api(runtime, "/api/read", payload);
  assert.equal(response.status, 200);
  const view = parseReadView(await response.json());
  assert.equal(view.sources[0]?.id, "source-1");
  assert.equal(
    (
      await api(runtime, "/api/read", {
        ...payload,
        relativePath: "../allowed-sibling/private.txt",
      })
    ).status,
    403,
  );
  assert.equal(
    (await api(runtime, "/api/read", { ...payload, extra: true })).status,
    400,
  );
  assert.equal(
    (
      await api(runtime, "/api/read", {
        ...payload,
        relativePath: "x".repeat(9000),
      })
    ).status,
    413,
  );
  await api(runtime, "/api/refresh", {});
  assert.equal((await api(runtime, "/api/view")).status, 404);
  assert.deepEqual(await readdir(data.allowed), ["capture.jsonl"]);
  assert.deepEqual(diagnostics, []);
});

test("unexpected adapter errors are explicit but never echo captured payloads", async (t) => {
  const data = await fixture(t);
  const marker = "SYNTHETIC_PRIVATE_ERROR_MARKER";
  const diagnostics: unknown[] = [];
  const reader: EvidenceReader = {
    format: "vscode-otel-jsonl",
    async read() {
      throw new Error(marker);
    },
  };
  const runtime = await startRuntime(config([data.file]), {
    readers: [reader],
    onDiagnostic: (event) => diagnostics.push(event),
  });
  t.after(() => runtime.close());
  const response = await api(runtime, "/api/read", {
    sourceId: "source-1",
    relativePath: "",
    format: reader.format,
  });
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes(marker), false);
  assert.deepEqual(diagnostics, [
    { code: "UNEXPECTED_ERROR", operation: "request" },
  ]);
});

test("control bodies enforce the exact 8192-byte boundary", async (t) => {
  const runtime = await startRuntime(config());
  t.after(() => runtime.close());
  for (const [size, expectedStatus, expectedCode] of [
    [8192, 400, "INVALID_CONTROL"],
    [8193, 413, "REQUEST_TOO_LARGE"],
  ] as const) {
    const body = JSON.stringify({
      padding: "x".repeat(size - JSON.stringify({ padding: "" }).length),
    });
    assert.equal(Buffer.byteLength(body), size);
    const response = await fetch(runtime.origin + "/api/refresh", {
      method: "POST",
      headers: {
        Origin: runtime.origin,
        "Content-Type": "application/json",
        "X-Agent-Insights-Token": runtime.token,
      },
      body,
    });
    assert.equal(response.status, expectedStatus);
    const error = errorSchema.parse(await response.json());
    assert.equal(error.error.code, expectedCode);
  }
});

test("the packaged CLI starts a responsive loopback service and shuts down without saved state", async (t) => {
  const child = spawn(process.execPath, [".build/src/runtime/cli.js"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await exited;
  });
  let output = "";
  const signal = AbortSignal.timeout(10_000);
  while (!output.includes("\n")) {
    const [chunk] = await once(child.stdout, "data", { signal });
    output += String(chunk);
  }
  const match = output.match(
    /^Agent Insights: (http:\/\/127\.0\.0\.1:\d+\/#access=\S+)/,
  );
  assert.ok(match?.[1]);
  const launch = new URL(match[1]);
  const token = new URLSearchParams(launch.hash.slice(1)).get("access");
  assert.ok(token);
  const response = await fetch(launch.origin + "/api/status", {
    headers: { "X-Agent-Insights-Token": token },
  });
  assert.equal(response.status, 200);
  assert.equal(statusSchema.parse(await response.json()).sources.length, 0);
  child.kill("SIGTERM");
  const [code, termination] = await exited;
  assert.ok(
    code === 0 || (process.platform === "win32" && termination === "SIGTERM"),
  );
});
test("the packaged CLI prints usage and rejects unsupported configuration without starting a service", async () => {
  for (const [args, expected] of [
    [["--help"], 0],
    [["--harness", "unsupported"], 1],
  ] as const) {
    const child = spawn(
      process.execPath,
      [".build/src/runtime/cli.js", ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const [code] = await once(child, "exit");
    assert.equal(code, expected);
    assert.match(
      output,
      expected === 0 ? /--source PATH/ : /UNSUPPORTED_HARNESS/,
    );
  }
});
