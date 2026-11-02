/**
 * Test the production Copilot provider through an injected SDK-compatible transport.
 *
 * The provider still creates/removes real test-owned operational directories, but
 * the transport below only simulates process state and authentication. Native CLI
 * process-exit/persistence checks live in the separate qualification tests.
 * Environment-token cases temporarily use synthetic values and restore this test
 * process's environment; no real credential is printed or sent to a model.
 */
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

/**
 * Controlled SDK stand-in for cancellation and cleanup recovery.
 * running is simulated state, not a process probe. failStop deliberately leaves
 * that state and its pending rejection handle intact so retention can be asserted.
 * No actual CLI, network inference or account lookup occurs here.
 */
class ControlledTransport extends EventEmitter implements CopilotTransport {
  running = false;
  failStop = false;
  stops = 0;
  modelId: string | undefined = "synthetic";
  private rejectPending: ((error: Error) => void) | null = null;

  /**
   * Select the point at which a test will observe and cancel outstanding work.
   * @param waitAt - connection or response blocks that phase; null completes immediately.
   */
  constructor(readonly waitAt: "connection" | "response" | null) {
    super();
  }

  /**
   * Mark simulated ownership active and optionally wait at connection setup.
   * @returns Resolves immediately unless connection is selected; that wait rejects
   * only when a successful forceStop confirms the simulated termination.
   */
  async start(): Promise<void> {
    this.running = true;
    if (this.waitAt === "connection") await this.wait();
  }

  /** Resolve fixed version/protocol metadata so tests reach the intended later lifecycle phase. */
  async getStatus() {
    return { version: QUALIFIED_COPILOT_VERSION, protocolVersion: 3 };
  }
  /** Resolve a synthetic authenticated state; the injected credential dependency supplies only a fake token. */
  async getAuthStatus() {
    return { isAuthenticated: true };
  }
  /** Resolve one synthetic catalog entry with a finite context budget and no account lookup. */
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

  /**
   * Check isolation/authentication setup and provide a controllable fake session.
   * @param config - Must carry managed policy, locked model defaults and the synthetic session token.
   * @returns A session that reports modelId but emits no usage events, isolating
   * model-identity fallback from token accounting. Invalid configuration rejects.
   */
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

  /**
   * Attempt simulated termination and count each attempt.
   * @returns Resolves after clearing running/rejecting pending work, or rejects when
   * failStop is true without changing ownership. This is not a native process kill.
   */
  async forceStop(): Promise<void> {
    this.stops++;
    if (this.failStop) throw new Error("SYNTHETIC_STOP_FAILURE");
    this.running = false;
    this.rejectPending?.(new Error("SYNTHETIC_TRANSPORT_STOPPED"));
    this.rejectPending = null;
  }

  /**
   * Install the pending rejection path before emitting the test's waiting event.
   * @returns A promise left pending until successful simulated termination rejects it.
   */
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

/**
 * Construct a provider with deterministic executable/auth/SDK dependencies.
 * @param transport - Test-controlled SDK stand-in whose wait/stop behavior the case can change.
 * @returns The real provider, allocated directory paths and a client-creation counter.
 * Production allocation/cleanup still executes; executable lookup and credentials are fake.
 */
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
