/** Installed Copilot adapter: explicit stdio transport, isolated memory-only sessions, no tool execution. */
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type SessionConfig,
  type ModelInfo,
} from "@github/copilot-sdk";
import { RuntimeError } from "../runtime/errors.js";
import type { RuntimeConfig } from "../runtime/config.js";
import {
  ANALYSIS_OUTPUT_LIMIT,
  type AnalysisProvider,
  type AnalysisUsage,
  type ProviderCallbacks,
  type ProviderInput,
} from "./contracts.js";
import { MemorySessionFilesystem } from "./memory-filesystem.js";

export const QUALIFIED_COPILOT_VERSION = "1.0.104";
const execute = promisify(execFile);

/** Preserve platform/auth/proxy requirements, not ambient tracing, debug, plugin or tool settings. */
export function copilotClientOptions(
  executable: string,
  directory: string,
  authenticate = true,
): CopilotClientOptions {
  const env: Record<string, string | undefined> = {};
  const names = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "GH_CONFIG_DIR",
    "GH_HOST",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ];
  if (authenticate)
    names.push(
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "COPILOT_GITHUB_TOKEN",
      "COPILOT_SDK_AUTH_TOKEN",
    );
  for (const name of names)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, {
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory,
    COPILOT_OTEL_ENABLED: "false",
    OTEL_SDK_DISABLED: "true",
  });
  return {
    mode: "empty",
    connection: RuntimeConnection.forStdio({
      path: executable,
      args: ["--disable-client-telemetry"],
    }),
    workingDirectory: directory,
    baseDirectory: path.join(directory, "home"),
    logLevel: "none",
    useLoggedInUser: authenticate,
    env,
    sessionFs: {
      initialCwd: "/workspace",
      sessionStatePath: "/sessions",
      conventions: "posix",
      capabilities: { sqlite: false, binary: false },
    },
  };
}

/** Defense-in-depth settings supplement empty mode; only trusted analysis instructions are supplied. */
export function copilotSessionOptions(
  memory: MemorySessionFilesystem,
  input: ProviderInput,
  model: string | null,
): SessionConfig {
  return {
    ...(model === null ? {} : { model, allowedModels: [model] }),
    availableTools: [],
    excludedTools: ["builtin:*", "mcp:*", "custom:*"],
    tools: [],
    mcpServers: {},
    customAgents: [],
    enableConfigDiscovery: false,
    enableSessionTelemetry: false,
    enableFileChangeTracking: false,
    enableManagedSettings: true,
    enableSkills: false,
    includedBuiltinSkills: [],
    enableFileHooks: false,
    hookDirectories: [],
    enableHostGitOperations: false,
    enableSessionStore: false,
    skipCustomInstructions: true,
    skipEmbeddingRetrieval: true,
    enableOnDemandInstructionDiscovery: false,
    embeddingCacheStorage: "in-memory",
    memory: { enabled: false },
    infiniteSessions: { enabled: false },
    createSessionFsProvider: () => memory,
    onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }),
    systemMessage: { mode: "replace", content: input.system },
  };
}

/** Conservative byte-based admission is not measured token usage; the runtime still enforces its limit. */
export function checkModelContext(
  input: ProviderInput,
  model: ModelInfo,
): void {
  const limits = model.capabilities.limits;
  const bound =
    Buffer.byteLength(input.system) + Buffer.byteLength(input.prompt) + 4096;
  const limit = Math.min(
    limits.max_prompt_tokens ?? limits.max_context_window_tokens,
    limits.max_context_window_tokens -
      Math.min(limits.max_output_tokens ?? 4096, 4096),
  );
  if (!Number.isFinite(limit) || limit <= 0 || bound > limit)
    throw new RuntimeError(
      "ANALYSIS_CONTEXT_LIMIT",
      "Selected evidence exceeds the model's conservative context budget; nothing was sent.",
      413,
    );
}

/** An unresolved harness default is admitted against every available model, never silently selected here. */
export function checkAvailableContext(
  input: ProviderInput,
  models: readonly ModelInfo[],
  currentId?: string,
): void {
  const current =
    currentId === "auto"
      ? undefined
      : models.find((model) => model.id === currentId);
  if (currentId && currentId !== "auto" && !current)
    throw new RuntimeError(
      "COPILOT_CONTEXT_UNKNOWN",
      "Copilot did not report context limits for the selected model.",
      422,
    );
  const candidates = current
    ? [current]
    : models.filter(
        (model) => model.id !== "auto" && model.policy?.state !== "disabled",
      );
  if (!candidates.length)
    throw new RuntimeError(
      "COPILOT_CONTEXT_UNKNOWN",
      "Copilot did not report usable model context limits.",
      422,
    );
  for (const model of candidates) checkModelContext(input, model);
}

/** Resolve explicit paths or native PATH executables without invoking a shell or bundled fallback. */
async function installedExecutable(
  configured: string | null,
): Promise<string | null> {
  const candidates =
    configured === null
      ? (process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) =>
            path.join(
              directory,
              process.platform === "win32" ? "copilot.exe" : "copilot",
            ),
          )
      : [path.resolve(configured)];
  for (const candidate of candidates) {
    try {
      await access(
        candidate,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return await realpath(candidate);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
      )
        continue;
      throw error;
    }
  }
  return null;
}

/** Each analysis owns a fresh process and virtual filesystem; metadata probes never send source content. */
export class CopilotAnalysisProvider implements AnalysisProvider {
  private metadata: ReturnType<AnalysisProvider["status"]> | null = null;

  /** Retain startup preferences without connecting to Copilot or handling credential material. */
  constructor(
    private readonly config: Pick<RuntimeConfig, "copilotPath" | "model">,
  ) {}

  /** Cache startup installation metadata; actual analysis independently rechecks the executable. */
  status(): ReturnType<AnalysisProvider["status"]> {
    return (this.metadata ??= this.inspect());
  }

  /** Require the qualified version; detecting a newer executable is not permission to upgrade support. */
  private async inspect() {
    const executable = await installedExecutable(this.config.copilotPath);
    if (!executable)
      return {
        available: false,
        version: null,
        reason:
          "Copilot was not found. Install it separately or set --copilot-path.",
      };
    try {
      const { stdout } = await execute(
        executable,
        ["--version", "--no-auto-update"],
        {
          timeout: 5000,
          maxBuffer: 4096,
          windowsHide: true,
        },
      );
      const version =
        /GitHub Copilot CLI (\d+\.\d+\.\d+)\./.exec(stdout)?.[1] ?? null;
      const available = version === QUALIFIED_COPILOT_VERSION;
      return {
        available,
        version,
        reason: available
          ? `Copilot ${version} is qualified. Account access is checked only when analysis starts.`
          : `This build requires qualified Copilot ${QUALIFIED_COPILOT_VERSION}; the selected executable is not qualified.`,
      };
    } catch {
      return {
        available: false,
        version: null,
        reason:
          "Copilot version checking failed. Check the executable path and permissions.",
      };
    }
  }

  /** Connect only after consent; always stop the owned process before removing operational metadata. */
  async analyze(
    input: ProviderInput,
    callbacks: ProviderCallbacks,
  ): Promise<string> {
    const status = await this.inspect();
    if (!status.available)
      throw new RuntimeError("COPILOT_UNAVAILABLE", status.reason, 503);
    const executable = await installedExecutable(this.config.copilotPath);
    if (!executable)
      throw new RuntimeError(
        "COPILOT_UNAVAILABLE",
        "Copilot is no longer available.",
        503,
      );
    callbacks.signal.throwIfAborted();
    const directory = await mkdtemp(
      path.join(tmpdir(), "agent-insights-copilot-"),
    );
    const memory = new MemorySessionFilesystem();
    const client = new CopilotClient(
      copilotClientOptions(executable, directory),
    );
    let stopFailure: unknown;
    let abortedStop: Promise<void> | null = null;
    /** Abort the owned transport immediately; retain cleanup errors for the awaited finalizer. */
    const abort = () => {
      abortedStop = client.forceStop().catch((error: unknown) => {
        stopFailure = error;
      });
    };
    callbacks.signal.addEventListener("abort", abort, { once: true });
    try {
      callbacks.signal.throwIfAborted();
      await memory.mkdir("/workspace", true);
      await memory.mkdir("/sessions", true);
      callbacks.progress("connecting");
      await client.start();
      const actual = await client.getStatus();
      if (
        actual.version !== QUALIFIED_COPILOT_VERSION ||
        actual.protocolVersion !== 3
      )
        throw new RuntimeError(
          "COPILOT_UNQUALIFIED",
          "The connected Copilot runtime is not qualified.",
          503,
        );
      callbacks.signal.throwIfAborted();
      if (!(await client.getAuthStatus()).isAuthenticated)
        throw new RuntimeError(
          "COPILOT_AUTH_REQUIRED",
          "Copilot authentication is unavailable. Authenticate through its supported GitHub CLI or token flow, then retry.",
          401,
        );
      const models = await client.listModels();
      if (
        this.config.model !== null &&
        !models.some((model) => model.id === this.config.model)
      )
        throw new RuntimeError(
          "COPILOT_MODEL_UNAVAILABLE",
          "The requested model is not available to this Copilot account.",
          422,
        );
      const session = await client.createSession(
        copilotSessionOptions(memory, input, this.config.model),
      );
      const current = await session.rpc.model.getCurrent();
      if (
        this.config.model !== null &&
        current.modelId !== undefined &&
        current.modelId !== this.config.model
      )
        throw new RuntimeError(
          "COPILOT_MODEL_CHANGED",
          "Copilot did not select the requested model; nothing was sent.",
          409,
        );
      checkAvailableContext(
        input,
        models,
        this.config.model ?? current.modelId,
      );
      let usage: AnalysisUsage = { input: null, output: null, model: null };
      let seenUsage = false;
      const seen = new Set<string>();
      const unsubscribe = session.on((event) => {
        if (event.type !== "assistant.usage" || seen.has(event.id)) return;
        seen.add(event.id);
        const reported = event.data;
        /** Missing components poison the total instead of becoming measured zero. */
        const total = (
          previous: number | null,
          value: number | undefined,
        ): number | null =>
          value === undefined ||
          !Number.isSafeInteger(value) ||
          value < 0 ||
          (seenUsage && previous === null) ||
          !Number.isSafeInteger((previous ?? 0) + value)
            ? null
            : (previous ?? 0) + value;
        usage = {
          input: total(usage.input, reported.inputTokens),
          output: total(usage.output, reported.outputTokens),
          model:
            seenUsage && usage.model !== reported.model ? null : reported.model,
        };
        seenUsage = true;
        callbacks.usage(usage);
      });
      try {
        callbacks.signal.throwIfAborted();
        callbacks.progress("running");
        const response = await session.sendAndWait(
          { prompt: input.prompt },
          110_000,
        );
        callbacks.signal.throwIfAborted();
        const output = response?.data.content;
        if (
          typeof output !== "string" ||
          Buffer.byteLength(output) > ANALYSIS_OUTPUT_LIMIT
        )
          throw new RuntimeError(
            "ANALYSIS_OUTPUT_LIMIT",
            "Copilot returned no bounded text result.",
            502,
          );
        return output;
      } finally {
        unsubscribe();
      }
    } catch (error) {
      if (error instanceof RuntimeError || callbacks.signal.aborted)
        throw error;
      throw new RuntimeError(
        "COPILOT_REQUEST_FAILED",
        "Copilot could not complete analysis. Check account access, model availability and context limits.",
        502,
      );
    } finally {
      callbacks.signal.removeEventListener("abort", abort);
      try {
        await abortedStop;
        await client.forceStop();
        if (stopFailure !== undefined) throw stopFailure;
      } catch {
        throw new RuntimeError(
          "COPILOT_CLEANUP_FAILED",
          "Copilot cleanup could not be confirmed. Stop and restart the local application.",
          500,
        );
      } finally {
        memory.dispose();
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          throw new RuntimeError(
            "COPILOT_CLEANUP_FAILED",
            "Copilot operational metadata could not be removed. Stop and restart the local application.",
            500,
          );
        }
      }
    }
  }
}
