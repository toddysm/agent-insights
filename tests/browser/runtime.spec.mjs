/** Browser walkthrough of the real loopback shell using owned synthetic source locations. */
import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRuntime } from "../../.build/src/runtime/server.js";

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
    await expect(page.getByText(/no analyzer is connected/i)).toBeVisible();
    await expect(page).toHaveTitle("Agent Insights");
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to content" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#content")).toBeFocused();
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
      page.getByRole("heading", { name: "Sources", exact: true }),
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
    await expect(
      page.getByRole("heading", { name: "No sources configured" }),
    ).toBeVisible();
    await expect(
      page.getByText(/Source readers are not installed yet/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Analyze" })).toHaveCount(0);
  } finally {
    await runtime.close();
  }
});
