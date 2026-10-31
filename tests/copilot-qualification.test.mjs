/** Qualify a selected real Copilot runtime using only a loopback synthetic model and owned test files. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CopilotClient } from "@github/copilot-sdk";
import { MemorySessionFilesystem } from "../.build/src/analysis/memory-filesystem.js";
import {
  copilotClientOptions,
  copilotSessionOptions,
  CopilotAnalysisProvider,
} from "../.build/src/analysis/copilot.js";

/**
 * Scan only the owned test directory; symlinks must never redirect the audit into user data.
 * @param {string} directory - Temporary root owned by this qualification case.
 * @param {string} canary - Synthetic prompt/response marker forbidden in disk content.
 */
async function auditDisk(directory, canary) {
  const files = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  for (const file of files) {
    assert.ok(
      !file.isSymbolicLink(),
      "Unexpected qualification-directory symlink.",
    );
    if (file.isFile()) {
      const content = await readFile(path.join(file.parentPath, file.name));
      assert.ok(
        !content.includes(canary),
        `Payload persisted in ${file.name}.`,
      );
    }
  }
}

for (const attemptTool of [false, true]) {
  test(
    `installed Copilot keeps payloads off disk and ${attemptTool ? "rejects unadvertised tool calls" : "excludes custom instructions"}`,
    { timeout: 45_000 },
    async () => {
      const executable = process.env.COPILOT_QUALIFICATION_PATH;
      assert.ok(
        executable,
        "Set COPILOT_QUALIFICATION_PATH to the installed Copilot executable.",
      );
      const installation = await new CopilotAnalysisProvider({
        copilotPath: executable,
        model: null,
      }).status();
      assert.equal(installation.available, true, installation.reason);
      const directory = await mkdtemp(
        path.join(tmpdir(), "agent-insights-copilot-"),
      );
      const canary = `SYNTHETIC_${randomUUID()}`;
      const customization = `UNRELATED_INSTRUCTIONS_${randomUUID()}`;
      const memory = new MemorySessionFilesystem();
      await memory.mkdir("/workspace", true);
      await memory.mkdir("/sessions", true);
      await memory.writeFile("/workspace/AGENTS.md", customization);
      await writeFile(path.join(directory, "AGENTS.md"), customization);
      let calls = 0;
      let toolExecuted = false;
      let providerFailure;
      const server = createServer(async (request, response) => {
        try {
          let body = "";
          for await (const chunk of request) body += chunk;
          const input = JSON.parse(body);
          calls++;
          assert.equal(input.model, "synthetic-qualification");
          assert.ok(!input.tools?.length, "Tools were exposed to the model.");
          assert.ok(JSON.stringify(input.messages).includes(canary));
          assert.ok(
            !JSON.stringify(input.messages).includes(customization),
            "Unrelated instructions reached the model.",
          );
          const content = JSON.stringify({ reply: canary });
          if (attemptTool && calls === 1) {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                id: "synthetic-tool",
                object: "chat.completion",
                created: 1,
                model: "synthetic-qualification",
                choices: [
                  {
                    index: 0,
                    finish_reason: "tool_calls",
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "forbidden",
                          type: "function",
                          function: {
                            name: "qualification_probe",
                            arguments: "{}",
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
            return;
          }
          if (!input.stream) {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                id: "synthetic",
                object: "chat.completion",
                created: 1,
                model: "synthetic-qualification",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 8,
                  total_tokens: 18,
                },
              }),
            );
            return;
          }
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          const chunk = {
            id: "synthetic",
            object: "chat.completion.chunk",
            created: 1,
            model: "synthetic-qualification",
          };
          response.end(
            `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n` +
              `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\n` +
              "data: [DONE]\n\n",
          );
        } catch (error) {
          providerFailure = error;
          response.writeHead(500);
          response.end();
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const input = {
        system: "Return the requested JSON. Never use tools.",
        prompt: canary,
      };
      const client = new CopilotClient(
        copilotClientOptions(executable, directory, false),
      );
      try {
        const session = await client.createSession({
          ...copilotSessionOptions(memory, input, "synthetic-qualification"),
          ...(attemptTool
            ? {
                tools: [
                  {
                    name: "qualification_probe",
                    description:
                      "This excluded test handler must never execute.",
                    parameters: {
                      type: "object",
                      properties: {},
                      additionalProperties: false,
                    },
                    handler: () => {
                      toolExecuted = true;
                      return "UNEXPECTED_EXECUTION";
                    },
                  },
                ],
              }
            : {}),
          provider: {
            type: "openai",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "synthetic-no-credentials",
            wireApi: "completions",
          },
        });
        let result;
        try {
          result = await session.sendAndWait({ prompt: canary }, 15_000);
        } catch (error) {
          if (!attemptTool) throw error;
          assert.ok(error instanceof Error);
          assert.match(error.message, /tool|permission|available/i);
        }
        assert.equal(providerFailure, undefined);
        assert.equal(toolExecuted, false);
        if (result) assert.ok(result.data.content.includes(canary));
        assert.ok(calls >= 1 && calls <= (attemptTool ? 2 : 1));
        if (!attemptTool) assert.ok(result);
      } finally {
        await client.forceStop();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        try {
          await auditDisk(directory, canary);
        } finally {
          memory.dispose();
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  );
}
