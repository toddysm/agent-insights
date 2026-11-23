/**
 * Walk through the real loopback interface using only test-owned synthetic locations.
 * Playwright's page parameter controls the isolated browser; testInfo supplies
 * case-specific screenshot destinations, never a capture or application archive.
 *
 * Analysis cases inject a fixture reader and mock provider so consent, progress,
 * cancellation and fresh-page recovery can be tested before production definitions
 * exist. Runtime/model storage and provider qualification are tested separately.
 */
import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRuntime } from "../../.build/src/runtime/server.js";
import { productionReaders } from "../../.build/src/evidence/readers/index.js";
import {
  syntheticOperation,
  syntheticProvider,
  syntheticReader,
  syntheticResponse,
} from "../../.build/tests/fixtures/analysis.js";

test("source selection, cloud disclosure and memory-only access work on desktop and narrow screens", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-insights-browser-"),
  );
  const file = path.join(directory, "synthetic.jsonl");
  await writeFile(file, "SYNTHETIC_CAPTURE");
  const runtime = await startRuntime({
    sources: [file],
    port: 0,
    harness: "copilot",
    model: "requested-example",
    copilotPath: null,
  });
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  try {
    await page.goto(runtime.launchUrl);
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#content")).toBeFocused();
    await page.getByText("Advanced file tools and configured access", { exact: true }).click();
    await page.getByText("Analysis availability and privacy", { exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Configured locations" }),
    ).toBeVisible();
    await expect(page.getByText(file, { exact: true }).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Read source" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("heading", {
        name: "Analysis sends selected content to a remote service",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("requested-example", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/Analysis definitions are not installed yet/i),
    ).toBeVisible();
    await expect(page).toHaveTitle("Agent Insights");
    await expect
      .poll(() =>
        page.evaluate(() =>
          new URLSearchParams(location.hash.slice(1)).has("access"),
        ),
      )
      .toBe(false);
    expect(page.url()).not.toContain(runtime.token);
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.length + sessionStorage.length),
      )
      .toBe(0);
    await page.getByRole("button", { name: "Refresh sources" }).click();
    await expect(page.getByText("Accessible", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("sources-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("heading", { name: "Find your sessions", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("sources-mobile.png"),
      fullPage: true,
    });
    expect(requests.every((url) => url.startsWith(runtime.origin + "/"))).toBe(
      true,
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Access required" }),
    ).toBeVisible();
    await expect(page.getByText(file, { exact: true })).toHaveCount(0);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an empty configuration stays explicit instead of rendering example sessions", async ({
  page,
}) => {
  const runtime = await startRuntime({
    sources: [],
    port: 0,
    harness: "copilot",
    model: null,
    copilotPath: null,
  });

  try {
    await page.goto(runtime.launchUrl);
    await page.getByText("Advanced file tools and configured access", { exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "No sources configured" }),
    ).toBeVisible();
    await expect(
      page.getByText(/Source readers are not installed yet/),
    ).toBeVisible();
    await expect(page.getByText(/Native SQLite: unavailable/)).toBeVisible();
    await expect(
      page.getByText(/File-only sources and analysis are independent/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Analyze" })).toHaveCount(0);
  } finally {
    await runtime.close();
  }
});

test("analysis consent counts direct and associated evidence once, including agreeing inherited membership", async ({ page }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-insights-associated-consent-"));
  const file = path.join(directory, "synthetic.jsonl");
  const records = Array.from({ length: 5 }, (_, index) => ({
    traceId: "1".repeat(32), spanId: (index + 1).toString(16).padStart(16, "0"),
    name: "fictional", kind: 2, startTime: [1760000000 + index, 0],
    endTime: [1760000001 + index, 0], ended: true, status: { code: 1 },
    resource: { attributes: { "service.name": "fictional" } }, instrumentationScope: { name: "fictional" },
    ...(index === 4 ? { parentSpanContext: { traceId: "1".repeat(32), spanId: "0000000000000001" } } : {}),
    attributes: {
      "gen_ai.operation.name": "chat", "gen_ai.request.model": "fictional",
      "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 2,
      ...(index !== 2 && index !== 4 ? { "copilot_chat.chat_session_id": ["parent", "child", "", "unrelated"][index] } : {}),
      ...(index === 1 || index === 2 || index === 4 ? { "copilot_chat.parent_chat_session_id": "parent" } : {}),
    },
  }));
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  let observed;
  const runtime = await startRuntime(
    { sources: [file], port: 0, harness: "copilot", model: null, copilotPath: null },
    {
      readers: productionReaders,
      analysisOperations: [syntheticOperation],
      analysisProvider: {
        ...syntheticProvider,
        async analyze(input) {
          observed = JSON.parse(input.prompt);
          return JSON.stringify({
            readId: observed.readId, sessionId: observed.sessionId, operationId: observed.operationId,
            eventIds: [observed.events[0].id], data: { answer: "synthetic" },
          });
        },
      },
    },
  );
  try {
    await page.goto(runtime.launchUrl);
    await page.getByText("Advanced file tools and configured access", { exact: true }).click();
    await page.getByRole("button", { name: "Read source", exact: true }).click();
    await page.getByLabel("Session to analyze").selectOption({ index: 1 });
    await page.getByRole("combobox", { name: "Analysis", exact: true }).selectOption("synthetic");
    await expect(page.getByText("4 captured records will be sent: 2 direct members and 2 explicit associates.")).toBeVisible();
    await expect(page.getByText(/Associated records can have no direct session membership or belong directly to another session/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Analyze", exact: true })).toBeDisabled();
    expect(observed).toBeUndefined();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Analyze", exact: true }).click();
    await expect(page.getByText("Analysis succeeded: finished.")).toBeVisible();
    expect(observed.events.map((event) => event.references[0].location.line)).toEqual([1, 2, 3, 5]);
    expect(observed.contributions).toEqual({ directEvents: 2, associatedEvents: 2 });
    expect(observed.events[0].sessionId).toBe(observed.sessionId);
    expect(observed.events[1].sessionId).not.toBe(observed.sessionId);
    expect(observed.events[1].sessionId).not.toBeNull();
    expect(observed.events[2].sessionId).toBeNull();
    expect(observed.events[3].sessionId).toBe(observed.sessionId);
    for (const event of observed.events.slice(1)) expect(event.parentChat.sessionId).toBe(observed.sessionId);
    await page.getByLabel("Session to analyze").selectOption({ index: 2 });
    await expect(page.getByText("1 captured records will be sent: 1 direct members and 0 explicit associates.")).toBeVisible();
    await expect(page.getByText(/Associated records can have no direct session membership or belong directly to another session/)).toHaveCount(0);
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Analyze", exact: true })).toBeDisabled();
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true });
  }
});

test("analysis requires fresh acknowledgement, reports separate usage and supports cancellation", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-insights-analysis-browser-"),
  );
  const file = path.join(directory, "synthetic.jsonl");
  await writeFile(file, "SYNTHETIC_CAPTURE");
  let calls = 0;
  let failStatusOnce = false;
  await page.route("**/api/status", async (route) => {
    if (failStatusOnce) {
      failStatusOnce = false;
      await route.abort("failed");
    } else await route.continue();
  });
  const runtime = await startRuntime(
    {
      sources: [file],
      port: 0,
      harness: "copilot",
      model: null,
      copilotPath: null,
    },
    {
      readers: [syntheticReader],
      analysisOperations: [syntheticOperation],
      analysisProvider: {
        ...syntheticProvider,
        async analyze(input, callbacks) {
          calls++;
          callbacks.progress("running");
          if (calls > 1) {
            await new Promise((_resolve, reject) => {
              callbacks.signal.addEventListener(
                "abort",
                () => reject(new Error("SYNTHETIC_ABORT")),
                { once: true },
              );
            });
          }
          callbacks.usage({ input: 7, output: 3, model: "synthetic" });
          return syntheticResponse(input);
        },
      },
    },
  );
  try {
    await page.goto(runtime.launchUrl);
    await page.getByText("Advanced file tools and configured access", { exact: true }).click();
    await page.getByRole("button", { name: "Refresh sources" }).click();
    expect(calls).toBe(0);
    await page.getByRole("button", { name: "Read source" }).click();
    await page.getByLabel("Session to analyze").selectOption("session-fixture");
    await page
      .getByRole("combobox", { name: "Analysis", exact: true })
      .selectOption("synthetic");
    await expect(
      page.getByRole("button", { name: "Analyze", exact: true }),
    ).toBeDisabled();
    expect(calls).toBe(0);
    await page.getByRole("checkbox").check();
    failStatusOnce = true;
    await page.getByRole("button", { name: "Analyze", exact: true }).click();
    await expect(page.getByText(/Retrying analysis status/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Read source", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Cancel analysis" }),
    ).toBeEnabled();
    await expect(page.getByText("Analysis succeeded: finished.")).toBeVisible();
    await expect(page.getByText(/Retrying analysis status/)).toHaveCount(0);
    await expect(
      page.getByText(/Analysis input tokens: 7; output tokens: 3/),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Model-generated result" }),
    ).toBeVisible();
    expect(calls).toBe(1);
    await page.getByLabel("Session to analyze").selectOption("");
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    await expect(
      page.getByRole("heading", { name: "Model-generated result" }),
    ).toHaveCount(0);
    await page.getByLabel("Session to analyze").selectOption("session-fixture");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Analyze", exact: true }).click();
    await page.goto("about:blank");
    await page.goto(runtime.launchUrl);
    await page.getByText("Advanced file tools and configured access", { exact: true }).click();
    await expect(page.getByLabel("Session to analyze")).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Cancel analysis" }),
    ).toBeVisible();
    expect(calls).toBe(2);
    await page.getByRole("button", { name: "Cancel analysis" }).click();
    await expect(page.getByText("Analysis was cancelled.")).toBeVisible();
    await expect(page.getByText(/Analysis input tokens:/)).toHaveCount(0);
    expect(calls).toBe(2);
    await page.getByRole("button", { name: "Refresh sources" }).click();
    await expect(page.getByRole("button", { name: "Refresh sources" })).toBeEnabled();
    if (!(await page.locator(".analysis-details").evaluate((element) => element.open))) {
      await page.getByText("Analysis availability and privacy", { exact: true }).click();
    }
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Analyze", exact: true }),
    ).toBeDisabled();
    expect(calls).toBe(2);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("analysis-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
