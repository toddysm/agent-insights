/**
 * Serve the local interface and authenticated control endpoints on IPv4 loopback.
 *
 * This boundary validates launch access/origins, bounds small JSON control bodies
 * and delegates source reads and acknowledged analysis to their respective services.
 * It serves only fixed built assets, not arbitrary capture or workspace paths.
 *
 * Normal startup configures the Copilot CLI analysis provider but registers no
 * production readers or interpretation definitions yet. Those are code-owned
 * extension points; the first planned evidence source remains VS Code Copilot Chat.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { EvidenceReader } from "../evidence/contracts.js";
import type { MultiSourceReader } from "../evidence/source-access.js";
import type { RuntimeConfig } from "./config.js";
import { RuntimeError } from "./errors.js";
import { readRequestSchema, readSetRequestSchema } from "./protocol.js";
import { RuntimeService } from "./service.js";
import { SourceAccess } from "./sources.js";
import type { NativeHelperResolver } from "./sqlite.js";
import { z } from "zod";
import {
  analysisRequestSchema,
  type AnalysisOperation,
  type AnalysisProvider,
} from "../analysis/contracts.js";
import { AnalysisRunner } from "../analysis/runner.js";
import { CopilotAnalysisProvider } from "../analysis/copilot.js";

/**
 * Payload-free request diagnostic sent to the embedding application's observer.
 * It intentionally carries neither raw exceptions nor source text, credentials,
 * launch tokens or request bodies.
 */
export interface Diagnostic {
  readonly code: "UNEXPECTED_ERROR";
  readonly operation: "request" | "source-status";
}

/**
 * Handle owned by the launcher for one listening local runtime.
 * The launcher must call close() and handle failure; dropping this object does not
 * confirm that network connections or an analysis process have been stopped.
 */
export interface RunningRuntime {
  /** Canonical listening origin including the actual operating-system-selected port. */
  readonly origin: string;
  /** Sensitive browser bootstrap URL containing the launch credential in its fragment. */
  readonly launchUrl: string;
  /** In-memory request credential; do not log, persist or share it. */
  readonly token: string;
  /** Trusted in-process service handle, not an unauthenticated network access path. */
  readonly service: RuntimeService;
  /**
   * Stop admission/network connections and cancel reads/analysis owned by this runtime.
   * @returns Resolves after cleanup; rejects on failure while retaining a retry path.
   * Repeated calls share active shutdown or retry unconfirmed cleanup without deleting source files.
   */
  close(): Promise<void>;
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Insights</title><link rel="stylesheet" href="/assets/app.css"></head>
<body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`;

/**
 * Format the origin used by Host/Origin checks.
 * @param port - Listening port, including 80 whose default suffix URL normalization omits.
 * @returns Canonical literal-loopback origin; malformed URL/port inputs throw.
 */
export function loopbackOrigin(port: number): string {
  return new URL(`http://127.0.0.1:${port}`).origin;
}

/**
 * Compare an incoming Host header with the bound literal-loopback origin.
 * @param host - Header value; undefined, nonliteral hosts and URL-like syntax are rejected.
 * @param origin - Canonical origin produced for this server's actual listening port.
 * @returns Whether normalized host/port matches. Malformed URL syntax returns false;
 * unexpected parser failures propagate.
 */
export function allowedHost(host: string | undefined, origin: string): boolean {
  if (host === undefined || !/^127\.0\.0\.1(?::\d{1,5})?$/.test(host))
    return false;
  try {
    return new URL(`http://${host}`).origin === origin;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/**
 * Serialize one route response after its access/cache/security headers have been applied.
 * @param response - Open outgoing message that has not already sent headers.
 * @param status - HTTP status chosen by the route, including 202 for accepted asynchronous work.
 * @param body - JSON-serializable validated data or a controlled error envelope.
 * Ends the response; encoding/write failures propagate to the request boundary.
 */
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

/**
 * Check the launch credential without comparing equal-length values byte by byte in JavaScript.
 * @param request - Incoming request carrying X-Agent-Insights-Token.
 * @param token - This runtime's private launch credential, never a GitHub authentication token.
 * @returns False for absent/nonstring/wrong-length values; equal-length values use timingSafeEqual.
 * Origin and operation authorization remain separate checks.
 */
function authorized(request: IncomingMessage, token: string): boolean {
  const provided = request.headers["x-agent-insights-token"];
  return (
    typeof provided === "string" &&
    Buffer.byteLength(provided) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(token))
  );
}

/**
 * Decode a small application/json control body without treating it as a capture upload.
 * @param request - Incoming stream; early rejection does not destroy it so the outer handler can drain it.
 * @returns Parsed unknown JSON for route-specific schema validation.
 * Rejects with controlled errors for wrong content type, undecodable chunks, invalid
 * JSON or more than 8,192 bytes; stream failures propagate to the request boundary.
 */
async function controlBody(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    throw new RuntimeError(
      "INVALID_CONTENT_TYPE",
      "Control requests require application/json.",
      415,
    );
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk))
      throw new RuntimeError(
        "INVALID_BODY",
        "The control request could not be decoded.",
        400,
      );
    const bytes = chunk;
    length += bytes.length;
    if (length > 8192)
      throw new RuntimeError(
        "REQUEST_TOO_LARGE",
        "The control request is too large.",
        413,
      );
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new RuntimeError(
        "INVALID_JSON",
        "The control request is not valid JSON.",
        400,
      );
    throw error;
  }
}

/**
 * Create source grants, services and the loopback listener without starting model analysis.
 * @param config - Validated launch settings: approved source locations, requested port and provider preferences.
 * @param options - Trusted embedding/test overrides. readers registers source parsers;
 * analysisOperations registers instruction/validation definitions; both default empty.
 * multiSourceReaders registers code-owned role/schema/query definitions for the
 * composite read endpoint; it does not expose a generic SQL or filesystem API.
 * analysisProvider defaults to installed Copilot. readTimeoutMs configures the read
 * budget; onDiagnostic observes payload-free request failures and must not throw.
 * @returns Owned runtime handle and private launch URL after the server is listening.
 * Rejects on missing build assets, unexpected grant setup failure or inability to bind.
 * Missing captures can instead remain explicitly unavailable in source status.
 */
export async function startRuntime(
  config: RuntimeConfig,
  options: {
    readers?: readonly EvidenceReader[];
    multiSourceReaders?: readonly MultiSourceReader[];
    nativeHelper?: NativeHelperResolver;
    onDiagnostic?: (event: Diagnostic) => void;
    readTimeoutMs?: number;
    analysisProvider?: AnalysisProvider;
    analysisOperations?: readonly AnalysisOperation[];
  } = {},
): Promise<RunningRuntime> {
  const assets = new Map([
    [
      "/assets/app.js",
      {
        type: "text/javascript; charset=utf-8",
        body: await readFile(new URL("../../public/app.js", import.meta.url)),
      },
    ],
    [
      "/assets/app.css",
      {
        type: "text/css; charset=utf-8",
        body: await readFile(new URL("../../public/app.css", import.meta.url)),
      },
    ],
  ]);
  const sources = await SourceAccess.create(config.sources);
  const service = new RuntimeService(
    sources,
    config,
    options.readers,
    options.readTimeoutMs,
    new AnalysisRunner(
      options.analysisProvider ?? new CopilotAnalysisProvider(config),
      options.analysisOperations,
    ),
    options.multiSourceReaders,
    options.nativeHelper,
  );
  const token = randomBytes(32).toString("base64url");
  let origin = "";
  /**
   * Report only fixed request diagnostic fields through the supplied observer or stderr.
   * Raw exception text can contain captured content and is intentionally not included.
   * @param event - Controlled diagnostic code and operation, never an exception/request object.
   */
  const report =
    options.onDiagnostic ??
    ((event: Diagnostic) => {
      process.stderr.write(
        `[agent-insights] ${event.code} (${event.operation})\n`,
      );
    });

  /**
   * Process one fixed asset/status/control route within this runtime's access boundary.
   * @param request - Incoming headers/body; user-provided paths never become arbitrary static-file paths.
   * @param response - Outgoing message receiving no-store/security headers and the route result.
   * @returns Resolves after responding. Controlled/unknown failures reject to the outer
   * handler for redaction. Accepted analysis continues asynchronously and is observed
   * through status, rather than keeping the start request open until inference ends.
   */
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (
      !allowedHost(request.headers.host, origin) ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin)
    ) {
      throw new RuntimeError(
        "ORIGIN_DENIED",
        "The request origin is not permitted.",
        403,
      );
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", origin);
    } catch (error) {
      if (error instanceof TypeError)
        throw new RuntimeError(
          "INVALID_TARGET",
          "The request target is invalid.",
          400,
        );
      throw error;
    }
    if (url.origin !== origin)
      throw new RuntimeError(
        "ORIGIN_DENIED",
        "The request origin is not permitted.",
        403,
      );
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    const asset = assets.get(url.pathname);
    if (request.method === "GET" && asset !== undefined) {
      response.writeHead(200, { "Content-Type": asset.type });
      response.end(asset.body);
      return;
    }
    if (!authorized(request, token))
      throw new RuntimeError(
        "ACCESS_REQUIRED",
        "Open the full launch URL printed by the local server.",
        401,
      );
    if (request.method === "GET" && url.pathname === "/api/status") {
      json(response, 200, await service.status());
    } else if (request.method === "GET" && url.pathname === "/api/view") {
      if (service.view === null)
        throw new RuntimeError(
          "VIEW_UNAVAILABLE",
          "No current read view is available.",
          404,
        );
      json(response, 200, service.view);
    } else if (
      request.method === "POST" &&
      [
        "/api/refresh",
        "/api/cancel",
        "/api/read",
        "/api/read-set",
        "/api/analysis/start",
        "/api/analysis/cancel",
      ].includes(url.pathname)
    ) {
      if (request.headers.origin !== origin)
        throw new RuntimeError(
          "ORIGIN_REQUIRED",
          "An approved origin is required for this operation.",
          403,
        );
      const body = await controlBody(request);
      if (url.pathname.startsWith("/api/analysis/")) {
        if (response.destroyed)
          throw new RuntimeError(
            "ANALYSIS_CANCELLED",
            "The analysis request was disconnected.",
            409,
          );
        const analysis = service.analysis;
        if (!analysis)
          throw new RuntimeError(
            "ANALYSIS_UNAVAILABLE",
            "Analysis is not configured.",
            501,
          );
        if (url.pathname === "/api/analysis/start") {
          const selection = analysisRequestSchema.safeParse(body);
          if (!selection.success)
            throw new RuntimeError(
              "ANALYSIS_SELECTION_INVALID",
              "Select a current session and acknowledge remote processing.",
              400,
            );
          json(
            response,
            202,
            analysis.start(service.view, selection.data, service.readTiming),
          );
        } else {
          const selection = z
            .strictObject({ id: z.string().min(1).max(256) })
            .safeParse(body);
          if (!selection.success)
            throw new RuntimeError(
              "ANALYSIS_SELECTION_INVALID",
              "Select the current analysis to cancel.",
              400,
            );
          await analysis.cancel(selection.data.id);
          json(response, 200, await service.status());
        }
        return;
      }
      if (url.pathname !== "/api/read" && url.pathname !== "/api/read-set") {
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).length !== 0
        ) {
          throw new RuntimeError(
            "INVALID_CONTROL",
            "This operation accepts an empty control object only.",
            400,
          );
        }
        await service.close();
        json(response, 200, await service.status());
        return;
      }
      const input =
        url.pathname === "/api/read" ? readRequestSchema.safeParse(body) : null;
      const composite =
        url.pathname === "/api/read-set"
          ? readSetRequestSchema.safeParse(body)
          : null;
      if ((input && !input.success) || (composite && !composite.success))
        throw new RuntimeError(
          "INVALID_SELECTION",
          "Select a configured source, relative path and installed format.",
          400,
        );
      const controller = new AbortController();
      /**
       * Abort this source read only when the response closes before completion.
       * A normal close event after sending the result must not invalidate that successful read.
       */
      const disconnect = () => {
        if (!response.writableEnded) controller.abort();
      };
      response.once("close", disconnect);
      if (response.destroyed) controller.abort();
      try {
        if (input?.success)
          json(
            response,
            200,
            await service.read(input.data, controller.signal),
          );
        else if (composite?.success)
          json(
            response,
            200,
            await service.readSet(composite.data, controller.signal),
          );
        else
          throw new RuntimeError(
            "INVALID_SELECTION",
            "The source selection is invalid.",
            400,
          );
      } finally {
        response.removeListener("close", disconnect);
      }
    } else {
      throw new RuntimeError(
        "NOT_FOUND",
        "This operation is not available.",
        404,
      );
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const failure =
        error instanceof RuntimeError
          ? error
          : new RuntimeError(
              "UNEXPECTED_ERROR",
              "The operation failed unexpectedly. Check the server diagnostic code.",
              500,
            );
      if (!(error instanceof RuntimeError))
        report({ code: "UNEXPECTED_ERROR", operation: "request" });
      if (!response.destroyed && !response.headersSent) {
        if (failure.status === 413) response.setHeader("Connection", "close");
        json(response, failure.status, {
          error: { code: failure.code, message: failure.message },
        });
      }
      request.resume();
    });
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Loopback address is unavailable"));
        return;
      }
      origin = loopbackOrigin(address.port);
      resolve();
    });
  });
  let closing: Promise<void> | null = null;
  let stopped: Promise<void> | null = null;
  return {
    origin,
    token,
    launchUrl: `${origin}/#access=${token}`,
    service,
    /**
     * Reuse network shutdown and await analysis cleanup before resolving.
     * A rejected attempt clears only the in-flight shutdown promise so retained
     * provider resources can be retried without reopening the listener.
     */
    close() {
      if (closing !== null) return closing;
      service.invalidate();
      stopped ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      closing = Promise.all([
        stopped,
        service.close(),
        service.analysis?.close(),
      ])
        .then(() => undefined)
        .catch((error: unknown) => {
          closing = null;
          throw error;
        });
      return closing;
    },
  };
}
