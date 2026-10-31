/** Exercise production provider ownership/cancellation with injected transport faults and real owned temp directories. */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ModelInfo, SessionConfig } from "@github/copilot-sdk";
import {
  CopilotAnalysisProvider,
  QUALIFIED_COPILOT_VERSION,
  type CopilotTransport,
  type CopilotSessionPort,
  managedSessionToken,
} from "../src/analysis/copilot.js";
import { AnalysisRunner } from "../src/analysis/runner.js";
import {
  ANALYSIS_ACKNOWLEDGEMENT,
  type AnalysisUsage,
  type AnalysisRequest,
} from "../src/analysis/contracts.js";
import { exampleReadView } from "./fixtures/read-view.js";
import { syntheticOperation } from "./fixtures/analysis.js";

/** Deterministic owned-process stand-in; blocked calls remain observable after a failed stop. */
class ControlledTransport extends EventEmitter implements CopilotTransport {
  running = false;
  failStop = false;
  stops = 0;
  modelId: string | undefined = "synthetic";
  private rejectPending: ((error: Error) => void) | null = null;

  /** Select which SDK phase waits for cancellation rather than completing immediately. */
  constructor(readonly waitAt: "connection" | "response" | null) {
    super();
  }

  /** Mark the process alive before exposing a controllably blocked connection. */
  async start(): Promise<void> {
    this.running = true;
    if (this.waitAt === "connection") await this.wait();
  }

  /** Report only the qualified protocol; no real executable or account is consulted. */
  async getStatus() {
    return { version: QUALIFIED_COPILOT_VERSION, protocolVersion: 3 };
  }
  /** Supply a synthetic authenticated state without credential material. */
  async getAuthStatus() {
    return { isAuthenticated: true };
  }
  /** Supply a finite model budget so cancellation reaches the intended phase. */
  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "synthetic",
        name: "Synthetic",
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_context_window_tokens: 128_000 },
        },
      },
    ];
  }

  /** Return no usage events so the runtime-reported model fallback is independently exercised. */
  async createSession(config: SessionConfig): Promise<CopilotSessionPort> {
    assert.equal(config.enableManagedSettings, true);
    assert.equal(config.gitHubToken, "synthetic-session-token");
    assert.equal(config.enforceManagedModelDefaults, true);
    return {
      rpc: {
        model: {
          getCurrent: async () =>
            this.modelId === undefined ? {} : { modelId: this.modelId },
        },
      },
      on: () => () => {},
      sendAndWait: async () => {
        if (this.waitAt === "response") await this.wait();
        return { data: { content: '{"answer":"synthetic"}' } };
      },
    };
  }

  /** Fail without changing ownership, or confirm the stop and reject the outstanding SDK call. */
  async forceStop(): Promise<void> {
    this.stops++;
    if (this.failStop) throw new Error("SYNTHETIC_STOP_FAILURE");
    this.running = false;
    this.rejectPending?.(new Error("SYNTHETIC_TRANSPORT_STOPPED"));
    this.rejectPending = null;
  }

  /** Expose the wait only after its rejection path is installed, avoiding a cancellation race. */
  private wait(): Promise<void> {
    return new Promise((_resolve, reject) => {
      this.rejectPending = reject;
      this.emit("waiting");
    });
  }
}

test("session credentials use supported environment precedence and reject missing or unsupported authentication", async () => {
  const names = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  try {
    process.env.COPILOT_GITHUB_TOKEN = "synthetic-primary";
    process.env.GH_TOKEN = "synthetic-secondary";
    process.env.GITHUB_TOKEN = "synthetic-tertiary";
    const auth = { isAuthenticated: true, authType: "env" as const };
    const signal = new AbortController().signal;
    assert.equal(await managedSessionToken(auth, signal), "synthetic-primary");
    delete process.env.COPILOT_GITHUB_TOKEN;
    assert.equal(
      await managedSessionToken(auth, signal),
      "synthetic-secondary",
    );
    delete process.env.GH_TOKEN;
    assert.equal(await managedSessionToken(auth, signal), "synthetic-tertiary");
    delete process.env.GITHUB_TOKEN;
    await assert.rejects(
      managedSessionToken(auth, signal),
      /Session-scoped authentication/,
    );
    await assert.rejects(
      managedSessionToken({ isAuthenticated: true, authType: "hmac" }, signal),
      /Session-scoped authentication/,
    );
    await assert.rejects(
      managedSessionToken({ isAuthenticated: false }, signal),
      /Authenticate/,
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

/** Inject only probing and the SDK boundary; production allocation/cleanup code still runs unchanged. */
function controlledProvider(transport: ControlledTransport) {
  const directories: string[] = [];
  let clients = 0;
  const provider = new CopilotAnalysisProvider(
    { copilotPath: null, model: null },
    {
      locate: async () => "/synthetic/copilot",
      version: async () => QUALIFIED_COPILOT_VERSION,
      credentials: async () => "synthetic-session-token",
      client: (options) => {
        assert.ok(options.baseDirectory);
        directories.push(path.dirname(options.baseDirectory));
        clients++;
        return transport;
      },
    },
  );
  return { provider, directories, clients: () => clients };
}

for (const phase of ["connection", "response"] as const) {
  test(`production provider cancellation during ${phase} confirms stop and removes its directory`, async (t) => {
    const transport = new ControlledTransport(phase);
    const { provider, directories } = controlledProvider(transport);
    t.after(() => provider.close());
    const controller = new AbortController();
    const waiting = once(transport, "waiting");
    const pending = provider.analyze(
      { system: "synthetic", prompt: "synthetic" },
      {
        signal: controller.signal,
        progress: () => {},
        usage: () => {},
      },
    );
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await waiting;
    assert.equal(transport.running, true);
    controller.abort();
    await rejected;
    assert.equal(transport.running, false);
    assert.equal(transport.stops, 1);
    assert.equal(directories.length, 1);
    const directory = directories[0];
    assert.ok(directory);
    await assert.rejects(access(directory), { code: "ENOENT" });
  });
}

test("failed production cleanup keeps ownership and blocks admission across invalidation until shutdown retries", async (t) => {
  const transport = new ControlledTransport("response");
  transport.failStop = true;
  const { provider, directories, clients } = controlledProvider(transport);
  const runner = new AnalysisRunner(provider, [syntheticOperation]);
  t.after(async () => {
    transport.failStop = false;
    await runner.close();
  });
  const selection: AnalysisRequest = {
    readId: "read-fixture",
    sessionId: "session-fixture",
    operationId: "synthetic",
    acknowledgement: ANALYSIS_ACKNOWLEDGEMENT,
  };
  const waiting = once(transport, "waiting");
  const run = runner.start(exampleReadView(), selection);
  await waiting;
  await runner.cancel(run.id);
  assert.equal(runner.run?.error?.code, "COPILOT_CLEANUP_FAILED");
  assert.equal(transport.running, true);
  assert.equal((await runner.availability()).available, false);
  assert.equal((await provider.status()).available, false);
  const directory = directories[0];
  assert.ok(directory);
  await access(directory);
  assert.throws(
    () => runner.start(exampleReadView(), selection),
    /cleanup|shutdown/,
  );
  runner.invalidate();
  assert.equal(runner.run, null);
  assert.throws(
    () => runner.start(exampleReadView(), selection),
    /cleanup|shutdown/,
  );
  assert.equal(clients(), 1);
  await assert.rejects(runner.close(), /cleanup/i);
  assert.equal(transport.running, true);
  transport.failStop = false;
  await runner.close();
  assert.equal(transport.running, false);
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("runtime-reported concrete model survives absent usage events without inventing tokens", async () => {
  for (const model of ["synthetic", "auto", undefined]) {
    const transport = new ControlledTransport(null);
    transport.modelId = model;
    const { provider } = controlledProvider(transport);
    const usage: AnalysisUsage[] = [];
    await provider.analyze(
      { system: "synthetic", prompt: "synthetic" },
      {
        signal: new AbortController().signal,
        progress: () => {},
        usage: (value) => usage.push(value),
      },
    );
    assert.deepEqual(usage, [
      {
        input: null,
        output: null,
        model: model === "synthetic" ? model : null,
      },
    ]);
    assert.equal(transport.running, false);
  }
});
