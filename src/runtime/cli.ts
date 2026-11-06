/**
 * Executable entry point for the local web application.
 * Parses launch preferences, starts the loopback server and prints its private
 * bootstrap URL. It does not discover captures, parse VS Code chats or start a
 * model session. Provider/source-reader behavior belongs to the runtime services.
 */
import { parseConfig } from "./config.js";
import { RuntimeError } from "./errors.js";
import { startRuntime } from "./server.js";
import { productionReaders } from "../evidence/readers/index.js";

/**
 * Launch from process arguments, or print usage when help was requested.
 * @returns Resolves once the listener and signal handlers are installed, not when
 * the server shuts down. Startup failures reject to the top-level redacted reporter.
 */
async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  if (config === null) {
    process.stdout.write(
      "Agent Insights\n\nnpm start -- [--source PATH] [--port 0] [--harness copilot] [--model ID] [--copilot-path PATH]\n\nRepeat --source for approved files/directories. No sources are selected automatically.\n",
    );
    return;
  }
  const runtime = await startRuntime(config, { readers: productionReaders });
  process.stdout.write(
    `Agent Insights: ${runtime.launchUrl}\nKeep this launch URL private. Access stays in memory; reopen the full URL after a page reload.\n`,
  );
  /**
   * Schedule shutdown of this owned runtime in response to a process signal.
   * Returns immediately; cleanup is asynchronous. Failures emit only a fixed code
   * and set exitCode, while a later signal can retry retained cleanup resources.
   */
  const stop = () => {
    void runtime.close().catch(() => {
      process.stderr.write("[agent-insights] SHUTDOWN_FAILED\n");
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof RuntimeError
      ? `${error.code}: ${error.message}\n`
      : "STARTUP_FAILED: Check the build, requested port and source configuration.\n",
  );
  process.exitCode = 1;
});
