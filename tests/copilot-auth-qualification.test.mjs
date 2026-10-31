/** Opt-in authenticated CAPI qualification: intercept every prompt-bearing request locally; never invoke a remote model. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CopilotClient, CopilotRequestHandler } from "@github/copilot-sdk";
import { CopilotAnalysisProvider } from "../.build/src/analysis/copilot.js";

/** Return a synthetic response in the native request's format; no request is forwarded here. */
function syntheticResponse(input, marker) {
  const content = JSON.stringify({ reply: marker });
  const model = input.model ?? "synthetic";
  if ("messages" in input) {
    const base = { id: "synthetic-chat", created: 1, model };
    if (!input.stream)
      return Response.json({
        ...base,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    const chunks = [
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ];
    return new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
        "data: [DONE]\n\n",
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  }
  assert.ok(
    "input" in input,
    "Unrecognized authenticated inference format; nothing forwarded.",
  );
  const part = { type: "output_text", text: content, annotations: [] };
  const item = {
    id: "synthetic-message",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [part],
  };
  const response = {
    id: "synthetic-response",
    object: "response",
    created_at: 1,
    status: "completed",
    model,
    output: [item],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  if (!input.stream) return Response.json(response);
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: "" },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: content,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: content,
    },
    {
      type: "response.content_part.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(
    events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
      )
      .join(""),
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

/** Fulfill model requests locally or reject them; this handler never forwards an inference request. */
class InterceptedInference extends CopilotRequestHandler {
  armed = false;
  calls = 0;
  constructor(marker) {
    super();
    this.marker = marker;
  }
  async sendRequest(request, context) {
    const text = await request.clone().text();
    if (!this.armed) {
      assert.ok(
        ["GET", "HEAD"].includes(request.method) && text.length === 0,
        "Only read-only bootstrap metadata may be forwarded before interception is armed.",
      );
      return super.sendRequest(request, context);
    }
    assert.ok(
      text.includes(this.marker),
      "Unexpected request during intercepted inference; nothing forwarded.",
    );
    this.calls++;
    return syntheticResponse(JSON.parse(text), this.marker);
  }
  async openWebSocket() {
    throw new Error("WebSocket inference is disabled; nothing forwarded.");
  }
}

/** Inspect only the owned directory and never print marker or credential values. */
async function audit(directory, markers) {
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    assert.ok(!entry.isSymbolicLink());
    if (!entry.isFile()) continue;
    const bytes = await readFile(path.join(entry.parentPath, entry.name));
    for (const marker of markers)
      assert.ok(
        !bytes.includes(marker),
        "Authenticated payload or credential persisted to operational storage.",
      );
  }
}

test(
  "authenticated inference keeps synthetic payloads and credentials off disk",
  { timeout: 60_000 },
  async (t) => {
    assert.equal(
      process.env.COPILOT_AUTH_QUALIFICATION,
      "1",
      "Opt in to metadata authentication with COPILOT_AUTH_QUALIFICATION=1.",
    );
    const executable = process.env.COPILOT_QUALIFICATION_PATH;
    assert.ok(executable);
    const marker = `SYNTHETIC_AUTH_${randomUUID()}`;
    const interceptor = new InterceptedInference(marker);
    let sdk;
    let directory;
    let token;
    let liveAudits = 0;
    let stoppedAudits = 0;
    const provider = new CopilotAnalysisProvider(
      { copilotPath: executable, model: null },
      {
        client: (options) => {
          assert.ok(options.baseDirectory);
          directory = path.dirname(options.baseDirectory);
          const client = new CopilotClient({
            ...options,
            requestHandler: interceptor,
          });
          sdk = client;
          return {
            start: () => client.start(),
            getStatus: () => client.getStatus(),
            getAuthStatus: () => client.getAuthStatus(),
            listModels: () => client.listModels(),
            createSession: async (config) => {
              assert.ok(config.gitHubToken);
              assert.equal(config.enableManagedSettings, true);
              assert.equal(config.enforceManagedModelDefaults, true);
              token = config.gitHubToken;
              const session = await client.createSession(config);
              return {
                rpc: session.rpc,
                on: (handler) => session.on(handler),
                sendAndWait: (input, timeout) => {
                  interceptor.armed = true;
                  return session.sendAndWait(input, timeout);
                },
              };
            },
            forceStop: async () => {
              const markers = token ? [marker, token] : [marker];
              await audit(directory, markers);
              liveAudits++;
              await client.forceStop();
              await audit(directory, markers);
              stoppedAudits++;
            },
          };
        },
      },
    );
    const controller = new AbortController();
    t.signal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
    try {
      const output = await provider.analyze(
        {
          system:
            "Synthetic qualification only. Return the requested JSON and do not call tools.",
          prompt: `Return JSON with reply equal to ${marker}.`,
        },
        { signal: controller.signal, progress: () => {}, usage: () => {} },
      );
      assert.equal(JSON.parse(output).reply, marker);
      assert.equal(interceptor.calls, 1);
      assert.ok(liveAudits > 0 && stoppedAudits > 0);
    } finally {
      controller.abort();
      try {
        if (sdk) await sdk.forceStop();
        await provider.close();
      } finally {
        if (directory) {
          assert.ok(
            path.basename(directory).startsWith("agent-insights-copilot-"),
          );
          await rm(directory, { recursive: true, force: true });
        }
        token = undefined;
      }
    }
  },
);
