/**
 * Exercise the production discovery gate and UI controls in the real local shell.
 * The second phase supplies explicitly fictional discovery transport responses;
 * native discovery-to-reader integration is tested separately with the verified helper.
 */
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("discovery preserves production gates, exposes explicit roots and drops stale source lists", async ({
  page,
}) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-insights-discovery-browser-"),
  );
  const child = spawn(
    process.execPath,
    [
      ".build/src/runtime/cli.js",
      "--source",
      directory,
      "--copilot-path",
      path.join(directory, "no-model"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  try {
    let output = "";
    while (!output.includes("\n")) {
      const [chunk] = await once(child.stdout, "data", {
        signal: AbortSignal.timeout(15000),
      });
      output += String(chunk);
    }
    const launch = output.match(
      /^Agent Insights: (http:\/\/127\.0\.0\.1:\d+\/#access=\S+)/,
    )?.[1];
    expect(launch).toBeTruthy();
    const origin = new URL(launch).origin;
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(launch);
    const panel = page.getByRole("region", {
      name: "Discover Agent Host sessions",
    });
    await expect(panel.getByText(/native-helper-v0.1.0/)).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Discover sessions", exact: true }),
    ).toBeDisabled();
    expect(requests.some((url) => url.endsWith("/api/discover"))).toBe(false);

    await page.route("**/api/status", async (route) => {
      const response = await route.fetch();
      const status = await response.json();
      await route.fulfill({
        json: {
          ...status,
          multiSourceReaders: status.multiSourceReaders.map((reader) =>
            reader.id === "agent-host-sessions"
              ? { ...reader, available: true, reason: null }
              : reader,
          ),
        },
      });
    });
    const selections = [];
    let refresh = false;
    await page.route("**/api/discover", async (route) => {
      selections.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          id: "fictional-discovery",
          startedAtMs: 1,
          finishedAtMs: 2,
          issues: [],
          observations: [],
          sessions: [
            {
              id: "fictional-chat",
              sdkSessionId: "fictional-native-id",
              runtime: "copilot-agent-host",
              mode: null,
              executionLocation: "unknown",
              archived: false,
              state: refresh ? "unavailable" : "ready",
              reason: refresh
                ? "Retained native history is missing or rotated; no archive fallback."
                : "Fictional matching source identities.",
              references: [],
              selection: refresh
                ? null
                : {
                    readerId: "agent-host-sessions",
                    sources: [
                      {
                        key: "history",
                        sourceId: "source-1",
                        relativePath: "native/events.jsonl",
                      },
                      {
                        key: "catalog",
                        sourceId: "source-1",
                        relativePath: "catalog.db",
                      },
                    ],
                  },
            },
          ],
        },
      });
    });
    await page.goto("about:blank");
    await page.goto(launch);
    await panel.getByLabel("Source role 1").selectOption("catalog");
    await panel.getByLabel(/Relative path 1/).fill("catalog.db");
    await panel.getByRole("button", { name: "Add discovery root" }).click();
    await panel.getByLabel(/Relative path 2/).fill("native");
    await panel
      .getByRole("button", { name: "Discover sessions", exact: true })
      .click();
    const results = panel.getByRole("region", { name: "Discovered sessions" });
    await expect(
      results.getByText("fictional-native-id", { exact: true }),
    ).toBeVisible();
    await expect(
      results.getByText(
        /Mode: unknown.*Execution location: unknown.*Analysis provider: separate/,
      ),
    ).toBeVisible();
    expect(selections[0]).toEqual({
      roots: [
        { sourceId: "source-1", relativePath: "catalog.db", layout: "catalog" },
        { sourceId: "source-1", relativePath: "native", layout: "history" },
      ],
    });
    await expect(
      results.getByRole("button", { name: "Open retained session" }),
    ).toBeEnabled();
    refresh = true;
    await panel
      .getByRole("button", { name: "Refresh discovered sessions" })
      .click();
    await expect(results.getByText(/missing or rotated/)).toBeVisible();
    await expect(
      results.getByRole("button", { name: "Open retained session" }),
    ).toBeDisabled();
    await panel.getByLabel(/Relative path 1/).fill("other-catalog.db");
    await expect(results).toHaveCount(0);
    await panel
      .getByRole("button", { name: "Discover sessions", exact: true })
      .click();
    await expect(results).toBeVisible();
    await page
      .getByRole("button", { name: "Refresh sources", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Discovered sessions" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
    expect(requests.every((url) => url.startsWith(origin + "/"))).toBe(true);
    expect(requests.some((url) => url.endsWith("/api/analysis/start"))).toBe(
      false,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
