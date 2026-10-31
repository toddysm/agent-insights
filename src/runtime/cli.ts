/** Local entry point: show a private launch URL and stop only this runtime's resources on signals. */
import { parseConfig } from "./config.js";
import { RuntimeError } from "./errors.js";
import { startRuntime } from "./server.js";

/** Launch from explicit startup configuration; no source scanning or model connection occurs. */
async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  if (config === null) {
    process.stdout.write(
      "Agent Insights\n\nnpm start -- [--source PATH] [--port 0] [--harness copilot] [--model ID] [--copilot-path PATH]\n\nRepeat --source for approved files/directories. No sources are selected automatically.\n",
    );
    return;
  }
  const runtime = await startRuntime(config);
  process.stdout.write(
    `Agent Insights: ${runtime.launchUrl}\nKeep this launch URL private. Access stays in memory; reopen the full URL after a page reload.\n`,
  );
  /** Stop only this runtime; repeated signals retry unconfirmed cleanup without exposing private state. */
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
