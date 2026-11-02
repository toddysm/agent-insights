/**
 * Execute prepared analysis through an installed GitHub Copilot command-line
 * interface (CLI), using its software development kit (SDK).
 *
 * This is an analysis-provider adapter, not a capture-source reader. The first
 * planned evidence source is Visual Studio Code Copilot Chat, whose traces and
 * saved conversations are handled by separate readers. This file neither imports
 * Copilot CLI history nor attaches to, exports, or controls a VS Code chat.
 *
 * Only analyze() starts a session: it validates the installed runtime, authenticates
 * the reported account, supplies selected evidence over standard input/output and
 * collects a response. SDK session files stay in a bounded virtual memory store.
 * A private physical directory holds operational metadata until cleanup succeeds.
 * Harness capture files are never opened by this adapter; model inference normally occurs
 * remotely after the runner has obtained the user's acknowledgement.
 */
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
  type SessionEvent,
  type GetAuthStatusResponse,
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

/** Exact installed CLI version covered by qualification; newer versions are not silently accepted. */
export const QUALIFIED_COPILOT_VERSION = "1.0.104";
const execute = promisify(execFile);

/**
 * Minimal session surface consumed by the provider, implemented by the real SDK
 * or a controlled lifecycle test double. It exposes no source-discovery or file tools.
 */
export interface CopilotSessionPort {
  readonly rpc: {
    readonly model: {
      /**
       * Read the current selection without starting inference.
       * @returns Model metadata when known; an omitted ID or Auto routing is not a concrete identity.
       */
      getCurrent(): Promise<{ modelId?: string }>;
    };
  };
  /**
   * Subscribe to session events while inference is active.
   * @param handler - Observer that must not throw or persist raw event payloads.
   * @returns Unsubscribe function; the provider calls it when response waiting ends.
   */
  on(handler: (event: SessionEvent) => void): () => void;
  /**
   * Send one prepared message and await the SDK's assistant response.
   * @param input - Prompt text already selected and bounded by the analysis caller.
   * @param timeout - Response-wait budget in milliseconds, separate from the runner's full-run budget.
   * @returns Response text wrapper, or undefined if no assistant message is available; failures reject.
   */
  sendAndWait(
    input: { prompt: string },
    timeout: number,
  ): Promise<{ data: { content: string } } | undefined>;
}

/**
 * SDK transport owned by one analysis. Inherited methods start the process,
 * inspect runtime/auth/model metadata and stop it. forceStop() must reject when
 * termination is unconfirmed so the owning provider can retain and retry it.
 * This narrower surface also permits fault tests without invoking a real model.
 */
export interface CopilotTransport extends Pick<
  CopilotClient,
  "start" | "getStatus" | "getAuthStatus" | "listModels" | "forceStop"
> {
  /**
   * Create a fresh session; never resume an unrelated conversation.
   * @param config - Isolation settings, trusted system instructions and session-scoped authentication.
   * @returns Session port after bootstrap; invalid settings/authentication reject.
   */
  createSession(config: SessionConfig): Promise<CopilotSessionPort>;
}

/**
 * Trusted constructor-supplied dependencies for platform access and lifecycle tests.
 * Browser input and captured instructions cannot replace these functions. Overrides
 * must preserve cancellation, ownership and credential-redaction obligations.
 */
export interface CopilotDependencies {
  /**
   * @param configured - Explicit executable preference, or null to search the native PATH.
   * @returns Canonical candidate path or null when unavailable; unexpected lookup failures reject.
   */
  locate(configured: string | null): Promise<string | null>;
  /**
   * @param executable - Located candidate to probe without starting a chat.
   * @returns Parsed version or null for an unrecognized banner; execution failures reject.
   */
  version(executable: string): Promise<string | null>;
  /**
   * @param options - Process, environment, authentication and virtual-filesystem configuration.
   * @returns An unstarted SDK-compatible client whose resources will belong to the provider.
   */
  client(options: CopilotClientOptions): CopilotTransport;
  /**
   * @param auth - Authenticated account metadata reported by this client, not browser-supplied identity.
   * @param signal - Cancels credential retrieval before a model request is sent.
   * @returns Session credential held only in memory; unavailable/unsupported authentication rejects.
   */
  credentials(
    auth: GetAuthStatusResponse,
    signal: AbortSignal,
  ): Promise<string>;
}

/**
 * Retained ownership record for one SDK process and its storage.
 * A cleanup failure must not discard this record: the process may still be alive,
 * or termination may have succeeded while operational-directory removal failed.
 */
interface OwnedCopilot {
  /** Client used again by shutdown if its first forceStop attempt fails. */
  readonly client: CopilotTransport;
  /** Session storage; disposed only after the transport confirms termination. */
  readonly memory: MemorySessionFilesystem;
  /** Physical, test/application-owned operational directory, not a capture-payload staging area. */
  readonly directory: string;
  /** True after confirmed transport stop; directory removal can still need a retry. */
  stopped: boolean;
}

/**
 * Await an SDK operation without waiting indefinitely for it after cancellation.
 * @param operation - Lazy asynchronous call; it is not invoked if the signal is already aborted.
 * @param signal - Run-owned cancellation signal whose reason rejects this wait.
 * @returns The operation's value or rejection, unless cancellation wins first.
 *
 * This helper observes late settlement to avoid unhandled rejections, but does not
 * itself terminate a process. The provider's abort handler owns transport cleanup.
 */
async function waitForCopilot<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const pending = operation();
  return new Promise<T>((resolve, reject) => {
    /** Reject only this wait; the provider independently owns process termination. */
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Build SDK client options without creating directories, spawning a process or connecting.
 * @param executable - Resolved installed CLI path; discovery/version validation belongs to the caller.
 * @param directory - Private physical root owned by this run for operational metadata and temporary files.
 * @param authenticate - Defaults to true for supported existing-user authentication; false excludes
 * credential environment variables and login reuse in synthetic qualification.
 * @returns Explicit standard-input/output transport, virtual session paths, quiet logging and a
 * restricted environment retaining platform/auth/proxy needs rather than ambient customization.
 */
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
    names.push("GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN");
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

/**
 * Build a fresh tool-free session configuration; this does not send the evidence prompt.
 * @param memory - This run's virtual filesystem; it must remain owned until the client is stopped.
 * @param input - Uses system as trusted instructions here; prompt is sent separately by analyze().
 * @param model - Requested model ID, or null to let the harness resolve its default.
 * @param gitHubToken - Session-scoped credential from the reported account, held only in memory.
 * @returns Sensitive SDK configuration with managed policy enabled and optional CLI features disabled.
 * Do not log or persist the returned object because it contains the session credential.
 * @throws RuntimeError when the credential is empty or contains whitespace/NUL.
 */
export function copilotSessionOptions(
  memory: MemorySessionFilesystem,
  input: ProviderInput,
  model: string | null,
  gitHubToken: string,
): SessionConfig {
  if (!gitHubToken || /\s|\0/.test(gitHubToken))
    throw new RuntimeError(
      "COPILOT_SESSION_AUTH_REQUIRED",
      "Valid session-scoped Copilot authentication is required.",
      401,
    );
  return {
    gitHubToken,
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
    enforceManagedModelDefaults: true,
    capi: { enableWebSocketResponses: false },
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

/**
 * Reject input that exceeds a model's conservative admission budget without truncating it.
 * @param input - Trusted instructions and selected evidence; lengths are measured as UTF-8 bytes.
 * @param model - Catalog entry supplying prompt, context-window and optional output-token limits.
 * @throws RuntimeError when the derived budget is unusable or input plus overhead exceeds it.
 *
 * The guard reserves overhead/output space; it is not a tokenizer or measured usage
 * and does not guarantee provider acceptance. The runtime still enforces actual context limits.
 */
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

/**
 * Check context admission without inventing or changing the harness's model selection.
 * @param input - Prepared strings to check against applicable catalog budgets.
 * @param models - Current account catalog; disabled models are excluded for an unresolved default.
 * @param currentId - Concrete requested/reported model, or undefined/auto while routing is unresolved.
 * @throws RuntimeError for an unknown concrete model, no usable candidates or an exceeded budget.
 * Auto is a routing entry, not a concrete model with its own positive context limit.
 */
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

/**
 * Locate an installed CLI candidate through read-only path/access checks.
 * @param configured - Explicit path resolved from the process working directory, or null for PATH search.
 * @returns First accessible canonical path, or null after missing/inaccessible candidates are exhausted.
 * Unexpected filesystem errors reject. This does not prove that the candidate is a
 * compatible executable; installedVersion performs that separate process probe.
 */
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

/**
 * Run the candidate's version command, not its chat/session mode.
 * @param executable - Located path passed directly to execFile, never a shell command string.
 * @returns Parsed numeric version or null for an unrecognized banner. Spawn failures,
 * a five-second timeout or output exceeding the 4 KiB buffer reject the promise.
 */
async function installedVersion(executable: string): Promise<string | null> {
  const { stdout } = await execute(
    executable,
    ["--version", "--no-auto-update"],
    {
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true,
    },
  );
  return /GitHub Copilot CLI (\d+\.\d+\.\d+)\./.exec(stdout)?.[1] ?? null;
}

/**
 * Obtain session authentication through the reported existing account's supported flow.
 * @param auth - Client-reported authenticated identity. Only environment-token and GitHub CLI modes
 * are handled; reported host/user constrain GitHub CLI retrieval when present.
 * @param signal - Cancels before retrieval or aborts the bounded GitHub CLI subprocess.
 * @returns A nonempty credential string for SDK authentication only, never model prompt text.
 * Rejects with controlled authentication errors for unsupported, invalid or unavailable
 * credentials; cancellation propagates so the runner can report it as cancellation.
 *
 * The application does not copy authentication files, log the token or write it to
 * payload files. GitHub CLI may refresh its own login as part of its supported token
 * command. Callers must keep the returned value and SDK session configuration private.
 */
export async function managedSessionToken(
  auth: GetAuthStatusResponse,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (!auth.isAuthenticated)
    throw new RuntimeError(
      "COPILOT_SESSION_AUTH_REQUIRED",
      "Authenticate the intended Copilot account before requesting session credentials.",
      401,
    );
  let token: string | undefined;
  if (auth.authType === "env") {
    token =
      process.env.COPILOT_GITHUB_TOKEN ||
      process.env.GH_TOKEN ||
      process.env.GITHUB_TOKEN;
  } else if (auth.authType === "gh-cli") {
    const args = ["auth", "token"];
    try {
      if (auth.host) {
        const host = new URL(
          auth.host.includes("://") ? auth.host : `https://${auth.host}`,
        );
        if (
          host.protocol !== "https:" ||
          host.username ||
          host.password ||
          host.pathname !== "/" ||
          host.search ||
          host.hash
        )
          throw new Error("Invalid authentication host.");
        args.push(`--hostname=${host.host}`);
      }
      if (auth.login) args.push(`--user=${auth.login}`);
      const result = await execute("gh", args, {
        signal,
        timeout: 5000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      });
      token = result.stdout.trim();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RuntimeError(
        "COPILOT_SESSION_AUTH_REQUIRED",
        "GitHub CLI could not supply the reported account's session credential. Check gh auth status.",
        401,
      );
    }
  }
  if (!token || token.length > 16 * 1024 || /\s|\0/.test(token))
    throw new RuntimeError(
      "COPILOT_SESSION_AUTH_REQUIRED",
      "Session-scoped authentication requires the supported GitHub CLI login or token environment.",
      401,
    );
  return token;
}

/**
 * Copilot CLI-backed executor for source-independent, already-normalized evidence.
 * It is not a VS Code extension integration and does not parse either VS Code or CLI history.
 *
 * Availability probes are cached, but each analysis rechecks the installed runtime.
 * Every run owns a fresh client, virtual session store and physical operational
 * directory. Cleanup releases ownership only after process stop and directory removal
 * both succeed; failed cleanup makes the provider unavailable until close() succeeds.
 */
export class CopilotAnalysisProvider implements AnalysisProvider {
  private metadata: ReturnType<AnalysisProvider["status"]> | null = null;
  private readonly dependencies: CopilotDependencies;
  private owned: OwnedCopilot | null = null;
  private cleaning: Promise<void> | null = null;
  private cleanupFailed = false;

  /**
   * Retain stable startup preferences and trusted platform/test dependencies.
   * @param config - Executable preference and requested model; the caller must not mutate it mid-run.
   * @param dependencies - Optional internal overrides for probing, SDK construction or credentials.
   * Construction alone does not authenticate, start the CLI or read session sources.
   */
  constructor(
    private readonly config: Pick<RuntimeConfig, "copilotPath" | "model">,
    dependencies: Partial<CopilotDependencies> = {},
  ) {
    this.dependencies = {
      locate: installedExecutable,
      version: installedVersion,
      client: (options) => new CopilotClient(options),
      credentials: managedSessionToken,
      ...dependencies,
    };
  }

  /**
   * Report cleanup blocking or the cached installation probe without creating an analysis.
   * @returns Availability/version/reason. Missing, incompatible or failed version probes
   * resolve as unavailable; unexpected path-resolution errors may reject.
   * Installing/changing the CLI requires restart to refresh this cached display state.
   */
  status(): ReturnType<AnalysisProvider["status"]> {
    if (this.cleanupFailed)
      return Promise.resolve({
        available: false,
        version: null,
        reason:
          "Copilot cleanup is unconfirmed. Stop the application to retry owned-resource cleanup.",
      });
    return (this.metadata ??= this.inspect());
  }

  /**
   * Retry any process/storage cleanup retained by a completed or cancelled analysis.
   * @returns Resolves when no owned resources remain; rejects while ownership must be retained.
   * It does not authenticate, send a prompt or create a replacement client.
   */
  close(): Promise<void> {
    return this.cleanupOwned();
  }

  /**
   * Serialize cleanup attempts against the retained ownership record.
   * @returns The shared in-flight cleanup promise, or a resolved promise when nothing is owned.
   * Stop is confirmed before memory disposal and directory removal. Failure rejects
   * with COPILOT_CLEANUP_FAILED and retains enough state for a later close() retry.
   */
  private cleanupOwned(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    const owned = this.owned;
    if (!owned) return Promise.resolve();
    this.cleaning = Promise.resolve()
      .then(async () => {
        if (!owned.stopped) {
          await owned.client.forceStop();
          owned.stopped = true;
        }
        owned.memory.dispose();
        await rm(owned.directory, { recursive: true, force: true });
        this.owned = null;
        this.cleanupFailed = false;
      })
      .catch(() => {
        this.cleanupFailed = true;
        throw new RuntimeError(
          "COPILOT_CLEANUP_FAILED",
          "Copilot cleanup is unconfirmed. New analyses are blocked; stop the application to retry cleanup.",
          500,
        );
      })
      .finally(() => {
        this.cleaning = null;
      });
    return this.cleaning;
  }

  /**
   * Re-run location/version checks without consulting the cached status result.
   * @returns Explicit compatibility metadata; an unqualified newer version stays unavailable.
   * Version-command failures are redacted to an unavailable reason. Unexpected
   * filesystem lookup failures reject rather than selecting a different provider.
   */
  private async inspect() {
    const executable = await this.dependencies.locate(this.config.copilotPath);
    if (!executable)
      return {
        available: false,
        version: null,
        reason:
          "Copilot was not found. Install it separately or set --copilot-path.",
      };
    try {
      const version = await this.dependencies.version(executable);
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

  /**
   * Execute one acknowledged analysis through the installed CLI, not through a VS Code chat.
   * @param input - Selected normalized evidence and trusted instructions already bounded/authorized
   * by the runner. This method is not a source reader or a substitute for the consent boundary.
   * @param callbacks - Owned cancellation signal and nonthrowing progress/usage observers.
   * @returns Raw bounded assistant text after confirmed cleanup. The runner, not this
   * adapter, validates the common envelope, operation data and evidence citations.
   *
   * Execution creates an operational directory and SDK process, obtains session
   * credentials, enforces runtime/model/policy checks and sends the prompt remotely.
   * Reported analysis usage never modifies usage in the captured source session.
   * Unavailable runtime/auth/model/context, missing/oversized output and SDK failures
   * reject; cleanup failure can override an otherwise successful/cancelled result and
   * retains ownership. Call close() to retry that cleanup, not analyze() to bypass it.
   */
  async analyze(
    input: ProviderInput,
    callbacks: ProviderCallbacks,
  ): Promise<string> {
    if (this.owned || this.cleanupFailed)
      throw new RuntimeError(
        "COPILOT_CLEANUP_FAILED",
        "An earlier Copilot process still requires cleanup.",
        503,
      );
    const status = await this.inspect();
    if (!status.available)
      throw new RuntimeError("COPILOT_UNAVAILABLE", status.reason, 503);
    const executable = await this.dependencies.locate(this.config.copilotPath);
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
    let client: CopilotTransport;
    try {
      client = this.dependencies.client(
        copilotClientOptions(executable, directory),
      );
    } catch (error) {
      memory.dispose();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    this.owned = { client, memory, directory, stopped: false };
    let stopFailure: unknown;
    let abortedStop: Promise<void> | null = null;
    /**
     * Start owned cleanup when the run signal aborts. Errors are retained for the
     * awaited finalizer; firing this callback alone is not confirmation of process exit.
     */
    const abort = () => {
      abortedStop = this.cleanupOwned().catch((error: unknown) => {
        stopFailure = error;
      });
    };
    callbacks.signal.addEventListener("abort", abort, { once: true });
    try {
      callbacks.signal.throwIfAborted();
      await memory.mkdir("/workspace", true);
      await memory.mkdir("/sessions", true);
      callbacks.progress("connecting");
      await waitForCopilot(() => client.start(), callbacks.signal);
      const actual = await waitForCopilot(
        () => client.getStatus(),
        callbacks.signal,
      );
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
      const auth = await waitForCopilot(
        () => client.getAuthStatus(),
        callbacks.signal,
      );
      if (!auth.isAuthenticated)
        throw new RuntimeError(
          "COPILOT_AUTH_REQUIRED",
          "Copilot authentication is unavailable. Authenticate through its supported GitHub CLI or token flow, then retry.",
          401,
        );
      const gitHubToken = await waitForCopilot(
        () => this.dependencies.credentials(auth, callbacks.signal),
        callbacks.signal,
      );
      const models = await waitForCopilot(
        () => client.listModels(),
        callbacks.signal,
      );
      if (
        this.config.model !== null &&
        !models.some((model) => model.id === this.config.model)
      )
        throw new RuntimeError(
          "COPILOT_MODEL_UNAVAILABLE",
          "The requested model is not available to this Copilot account.",
          422,
        );
      const session = await waitForCopilot(
        () =>
          client.createSession(
            copilotSessionOptions(
              memory,
              input,
              this.config.model,
              gitHubToken,
            ),
          ),
        callbacks.signal,
      );
      const current = await waitForCopilot(
        () => session.rpc.model.getCurrent(),
        callbacks.signal,
      );
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
      let usage: AnalysisUsage = {
        input: null,
        output: null,
        model:
          current.modelId && current.modelId !== "auto"
            ? current.modelId
            : null,
      };
      callbacks.usage({ ...usage });
      let seenUsage = false;
      const seen = new Set<string>();
      const unsubscribe = session.on((event) => {
        if (event.type !== "assistant.usage" || seen.has(event.id)) return;
        seen.add(event.id);
        const reported = event.data;
        /**
         * Accumulate one reported token component without converting absence into zero.
         * @param previous - Aggregate from earlier events; null may mean unknown coverage.
         * @param value - This event's reported count, or undefined when absent.
         * @returns A safe nonnegative sum, or null after any missing/invalid component.
         * seenUsage distinguishes an initially empty aggregate from an already-unknown total.
         */
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
        const response = await waitForCopilot(
          () => session.sendAndWait({ prompt: input.prompt }, 110_000),
          callbacks.signal,
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
      await abortedStop;
      if (stopFailure !== undefined) throw stopFailure;
      await this.cleanupOwned();
    }
  }
}
