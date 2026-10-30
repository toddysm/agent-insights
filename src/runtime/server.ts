/** Authenticated loopback HTTP boundary with fixed assets and explicit source-read operations. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { EvidenceReader } from "../evidence/contracts.js";
import type { RuntimeConfig } from "./config.js";
import { RuntimeError } from "./errors.js";
import { readRequestSchema } from "./protocol.js";
import { RuntimeService } from "./service.js";
import { SourceAccess } from "./sources.js";

/** Safe diagnostics contain operation codes only, not request bodies, tokens or source data. */
export interface Diagnostic {
  readonly code: "UNEXPECTED_ERROR";
  readonly operation: "request" | "source-status";
}

/** A server owned by the caller; the launch secret is in memory and expires at shutdown. */
export interface RunningRuntime {
  readonly origin: string;
  readonly launchUrl: string;
  readonly token: string;
  readonly service: RuntimeService;
  /** Cancel owned reads and close this server's connections. */
  close(): Promise<void>;
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Insights</title><link rel="stylesheet" href="/assets/app.css"></head>
<body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`;

/** Canonicalize loopback origins, including omission of the default HTTP port. */
export function loopbackOrigin(port: number): string {
  return new URL(`http://127.0.0.1:${port}`).origin;
}

/** Accept only the bound literal loopback host, not URL-like Host values or rebinding names. */
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

/** Write an uncached structured response; callers supply only validated data or controlled errors. */
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

/** Compare a bounded opaque launch secret without leaking which portion matched. */
function authorized(request: IncomingMessage, token: string): boolean {
  const provided = request.headers["x-agent-insights-token"];
  return (
    typeof provided === "string" &&
    Buffer.byteLength(provided) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(token))
  );
}

/** Read a small control message, never a capture upload; malformed/oversized messages fail explicitly. */
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

/** Start on IPv4 loopback only. No reader or model adapter is installed implicitly. */
export async function startRuntime(
  config: RuntimeConfig,
  options: {
    readers?: readonly EvidenceReader[];
    onDiagnostic?: (event: Diagnostic) => void;
    readTimeoutMs?: number;
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
  );
  const token = randomBytes(32).toString("base64url");
  let origin = "";
  /** Emit only fixed diagnostic fields; raw exception messages may contain captured content. */
  const report =
    options.onDiagnostic ??
    ((event: Diagnostic) => {
      process.stderr.write(
        `[agent-insights] ${event.code} (${event.operation})\n`,
      );
    });

  /** Handle only fixed routes; never resolve request paths into static or source filesystem paths. */
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
      ["/api/refresh", "/api/cancel", "/api/read"].includes(url.pathname)
    ) {
      if (request.headers.origin !== origin)
        throw new RuntimeError(
          "ORIGIN_REQUIRED",
          "An approved origin is required for this operation.",
          403,
        );
      const body = await controlBody(request);
      if (url.pathname !== "/api/read") {
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
        service.invalidate();
        json(response, 200, await service.status());
        return;
      }
      const input = readRequestSchema.safeParse(body);
      if (!input.success)
        throw new RuntimeError(
          "INVALID_SELECTION",
          "Select a configured source, relative path and installed format.",
          400,
        );
      const controller = new AbortController();
      /** Normal completion also emits close; cancel only an abandoned request. */
      const disconnect = () => {
        if (!response.writableEnded) controller.abort();
      };
      response.once("close", disconnect);
      if (response.destroyed) controller.abort();
      try {
        json(response, 200, await service.read(input.data, controller.signal));
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
  return {
    origin,
    token,
    launchUrl: `${origin}/#access=${token}`,
    service,
    close() {
      if (closing !== null) return closing;
      service.invalidate();
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
