/** Startup-only configuration; no credential lookup, editor changes or settings persistence. */
import { parseArgs } from "node:util";
import { RuntimeError } from "./errors.js";

/** Immutable operator-approved locations and requested analysis preferences. */
export interface RuntimeConfig {
  readonly sources: readonly string[];
  readonly port: number;
  readonly harness: "copilot";
  readonly model: string | null;
  readonly copilotPath: string | null;
}

/** Parse command-line options without treating source content as arguments. */
export function parseConfig(args: readonly string[]): RuntimeConfig | null {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        source: { type: "string", multiple: true },
        port: { type: "string", default: "0" },
        harness: { type: "string", default: "copilot" },
        model: { type: "string" },
        "copilot-path": { type: "string" },
      },
    }));
  } catch (error) {
    if (
      error instanceof TypeError &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("ERR_PARSE_ARGS_")
    ) {
      throw new RuntimeError(
        "INVALID_OPTIONS",
        "Invalid startup options. Run with --help.",
        400,
      );
    }
    throw error;
  }
  if (values.help) return null;
  const sources = values.source ?? [];
  if (
    sources.length > 32 ||
    sources.some((value) => value.length === 0 || value.includes("\0"))
  ) {
    throw new RuntimeError(
      "INVALID_SOURCES",
      "Supply at most 32 non-empty source paths.",
      400,
    );
  }
  const port = values.port;
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) {
    throw new RuntimeError(
      "INVALID_PORT",
      "Port must be an integer from 0 to 65535.",
      400,
    );
  }
  if (values.harness !== "copilot") {
    throw new RuntimeError(
      "UNSUPPORTED_HARNESS",
      "This build configures Copilot only; no fallback is performed.",
      400,
    );
  }
  for (const value of [values.model, values["copilot-path"]]) {
    if (
      value !== undefined &&
      (value.length === 0 || value.length > 4096 || value.includes("\0"))
    ) {
      throw new RuntimeError(
        "INVALID_ANALYSIS_OPTION",
        "Analysis options must be non-empty values.",
        400,
      );
    }
  }
  return Object.freeze({
    sources: Object.freeze([...sources]),
    port: Number(port),
    harness: "copilot",
    model: values.model ?? null,
    copilotPath: values["copilot-path"] ?? null,
  });
}
