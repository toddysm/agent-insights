/** Real Sources-page scan, bounded paging and cancellation against owned fictional captures only. */
import { test, expect } from "@playwright/test";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRuntime } from "../../.build/src/runtime/server.js";
import { productionReaders } from "../../.build/src/evidence/readers/index.js";

/** Start an owned loopback runtime with production readers and an intentionally absent model executable. */
async function fixture(text) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-insights-stream-browser-"));
  const file = path.join(root, "fictional.jsonl");
  await writeFile(file, text);
  const runtime = await startRuntime({ sources: [file], port: 0, harness: "copilot",
    model: null, copilotPath: path.join(root, "no-model") }, { readers: productionReaders });
  return { root, file, runtime };
}

test("scan keeps payloads out of discovery, replaces pages, refreshes generations and remains usable on mobile", async ({ page }, testInfo) => {
  const raw = JSON.parse((await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8")).split("\n")[0]);
  raw.attributes["gen_ai.input.messages"] = "FICTIONAL_DETAIL_AFTER_SELECTION";
  const rows = [...Array.from({ length: 25 }, () => raw),
    ...Array.from({ length: 22 }, (_, index) => ({ ...raw,
      spanId: (index + 2).toString(16).padStart(16, "0"),
      attributes: { ...raw.attributes, "gen_ai.conversation.id": `fictional-${index}` } }))];
  const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const { root, file, runtime } = await fixture(text);
  const requests = [];
  const errors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(runtime.launchUrl);
    const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect(panel.getByText("complete", { exact: true })).toBeVisible();
    await expect(panel.getByText("FICTIONAL_DETAIL_AFTER_SELECTION", { exact: false })).toHaveCount(0);
    await expect(panel.getByLabel("Scanned session").locator("option")).toHaveCount(21);
    await panel.getByLabel("Scanned session").selectOption({ index: 1 });
    await panel.getByRole("button", { name: "Load original evidence" }).click();
    await expect(panel.getByRole("heading", { name: "Original line 1", exact: true })).toBeVisible();
    await expect(panel.locator("article")).toHaveCount(20);
    await panel.getByRole("button", { name: "Next evidence page" }).click();
    await expect(panel.getByRole("heading", { name: "Original line 21", exact: true })).toBeVisible();
    await expect(panel.locator("article")).toHaveCount(5);
    await expect(panel.getByRole("heading", { name: "Original line 1", exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("bounded-evidence-mobile.png"), fullPage: true });
    await panel.getByRole("button", { name: "Next session page" }).click();
    await expect(panel.getByLabel("Scanned session").locator("option")).toHaveCount(4);
    await expect(panel.locator("article")).toHaveCount(0);
    expect(await readFile(file, "utf8")).toBe(text);
    expect(await readdir(root)).toEqual(["fictional.jsonl"]);
    await writeFile(file, '{"scopeMetrics":[]}\n');
    await panel.getByRole("button", { name: "Rescan JSONL source" }).click();
    await expect(panel.getByText("partial", { exact: true })).toBeVisible();
    await expect(panel.getByText(/Timing\/tools\/tokens are unavailable, not zero/)).toBeVisible();
    await expect(panel.locator("article")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    expect(requests.every((url) => url.startsWith(runtime.origin + "/"))).toBe(true);
    expect(requests.some((url) => url.includes("/api/analysis/start"))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true });
  }
});

test("cancel acknowledges a running bounded-record scan within one second and never publishes stale evidence", async ({ page }) => {
  test.setTimeout(60_000);
  const raw = JSON.parse((await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8")).split("\n")[0]);
  raw.padding = "";
  raw.padding = "x".repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(raw)) - 1);
  const bytes = Buffer.from(JSON.stringify(raw) + "\n");
  expect(bytes.length).toBe(64 * 1024);
  const { root, file, runtime } = await fixture("");
  try {
    const handle = await open(file, "w");
    try {
      for (let index = 0; index < 384 * 1024 * 1024 / bytes.length; index++) {
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written);
          expect(result.bytesWritten).toBeGreaterThan(0);
          written += result.bytesWritten;
        }
      }
    } finally { await handle.close(); }
    await page.goto(runtime.launchUrl);
    const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Cancel scan" })).toBeVisible();
    const response = page.waitForResponse((response) => response.url().endsWith("/api/scan/cancel"));
    const started = Date.now();
    await panel.getByRole("button", { name: "Cancel scan" }).click();
    expect((await response).status()).toBe(202);
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(panel.getByText("cancelled", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Rescan JSONL source" })).toBeEnabled();
    await expect(panel.getByLabel("Scanned session")).toHaveCount(0);
    expect(runtime.service.view).toBeNull();
    expect(runtime.service.scanCatalog.status.cleanupPending).toBe(false);
    expect((await stat(file)).size).toBe(384 * 1024 * 1024);
    expect(await readdir(root)).toEqual(["fictional.jsonl"]);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true });
  }
});

test("a delayed initial catalog response cannot resurrect a cancelled generation", async ({ page }) => {
  const text = await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8");
  const { root, runtime } = await fixture(text);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let arrived;
  const catalogArrived = new Promise((resolve) => { arrived = resolve; });
  await page.route("**/api/scan/catalog", async (route) => {
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(runtime.launchUrl);
    const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await catalogArrived;
    await panel.getByRole("button", { name: "Cancel scan" }).click();
    await expect(panel.getByText("cancelled", { exact: true })).toBeVisible();
    const response = page.waitForResponse((response) => response.url().endsWith("/api/scan/catalog"));
    release();
    await response;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(panel.getByLabel("Scanned session")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Rescan JSONL source" })).toBeEnabled();
  } finally {
    release();
    await runtime.close();
    await rm(root, { recursive: true });
  }
});

test("late reconciliation from an unmounted panel cannot relock its parent", async ({ page }) => {
  const text = await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8");
  const { root, runtime } = await fixture(text);
  let holding = true;
  const pending = [];
  await page.route("**/api/scan/status", async (route) => {
    if (!holding) { await route.continue(); return; }
    const response = await route.fetch();
    let finish;
    const choice = new Promise((resolve) => { finish = resolve; });
    pending.push(finish);
    if (await choice) await route.abort("failed");
    else await route.fulfill({ response });
  });
  try {
    await page.goto(runtime.launchUrl);
    const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect.poll(() => pending.length).toBeGreaterThanOrEqual(3);
    holding = false;
    pending.forEach((finish, index) => { if (index !== 1) finish(false); });
    await expect(page.getByRole("button", { name: "Read source", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Read source", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Scan JSONL source", exact: true })).toBeEnabled();
    const failed = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url().endsWith("/api/scan/status"),
    });
    pending[1](true);
    await failed;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole("button", { name: "Read source", exact: true })).toBeEnabled();
    await expect(panel.getByRole("button", { name: "Scan JSONL source", exact: true })).toBeEnabled();
  } finally {
    holding = false;
    pending.forEach((finish) => finish(false));
    await runtime.close();
    await rm(root, { recursive: true });
  }
});

test("a start request lost before admission cannot restore the previous scan catalog", async ({ page }) => {
  const text = await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8");
  const { root, runtime } = await fixture(text);
  try {
    await page.goto(runtime.launchUrl);
    const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Rescan JSONL source" })).toBeEnabled();
    const previous = runtime.service.scanCatalog.status.id;
    await page.route("**/api/scan", (route) => route.abort("failed"));
    await panel.getByRole("button", { name: "Rescan JSONL source" }).click();
    await expect(panel.getByRole("alert")).toHaveText(/not accepted or was superseded/);
    await expect(panel.getByLabel("Scanned session")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Scan JSONL source", exact: true })).toBeEnabled();
    expect(runtime.service.scanCatalog.status.id).toBe(previous);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true });
  }
});

for (const lostRoute of ["/api/scan", "/api/scan/catalog"]) {
  test(`a lost ${lostRoute} response restores the completed catalog without rescanning`, async ({ page }) => {
    const text = await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8");
    const { root, runtime } = await fixture(text);
    let lost = false;
    let scans = 0;
    page.on("request", (request) => { if (request.url().endsWith("/api/scan")) scans++; });
    await page.route(`**${lostRoute}`, async (route) => {
      if (lost) { await route.continue(); return; }
      lost = true;
      await route.fetch();
      await route.abort("failed");
    });
    try {
      await page.goto(runtime.launchUrl);
      const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
      await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
      await expect(panel.getByLabel("Scanned session")).toBeEnabled();
      await panel.getByLabel("Scanned session").selectOption({ index: 1 });
      await panel.getByRole("button", { name: "Load original evidence" }).click();
      await expect(panel.locator("article")).not.toHaveCount(0);
      expect(scans).toBe(1);
      expect(lost).toBe(true);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true });
    }
  });
}

test("unknown initial cleanup keeps reconciling until status transport recovers", async ({ page }) => {
  const text = await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8");
  const { root, runtime } = await fixture(text);
  let recover = false;
  let polls = 0;
  await page.route("**/api/scan", async (route) => { await route.fetch(); await route.abort("failed"); });
  await page.route("**/api/scan/status", async (route) => {
    polls++;
    if (recover) await route.continue();
    else await route.abort("failed");
  });
  try {
    await page.goto(runtime.launchUrl);
    const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect(panel.getByText("Checking source cleanup before accepting new work…")).toBeVisible();
    await expect(page.getByRole("button", { name: "Read source", exact: true })).toBeDisabled();
    recover = true;
    await expect(panel.getByLabel("Scanned session")).toBeEnabled();
    await expect(panel.getByRole("button", { name: "Rescan JSONL source" })).toBeEnabled();
    expect(polls).toBeGreaterThan(1);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true });
  }
});

test("expired catalog pagination clears cached sessions and evidence before allowing a rescan", async ({ page }) => {
  const raw = JSON.parse((await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8")).split("\n")[0]);
  const text = Array.from({ length: 22 }, (_, index) => JSON.stringify({ ...raw,
    spanId: (index + 1).toString(16).padStart(16, "0"),
    attributes: { ...raw.attributes, "gen_ai.conversation.id": `fictional-expiry-${index}` } })).join("\n") + "\n";
  const { root, runtime } = await fixture(text);
  let expired = false;
  await page.route("**/api/scan/catalog", async (route) => {
    if (expired) await route.fulfill({ status: 409, json: { error: { code: "SCAN_EXPIRED", message: "The scan expired; refresh." } } });
    else await route.continue();
  });
  await page.route("**/api/scan/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (expired) body.scan = { ...body.scan, phase: "budget-exceeded", reason: "The scan exceeded its lifetime budget.",
      sessions: null, unassigned: null, classification: null, cleanupPending: false };
    await route.fulfill({ response, json: body });
  });
  try {
    await page.goto(runtime.launchUrl);
    const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Next session page" })).toBeEnabled();
    await panel.getByLabel("Scanned session").selectOption({ index: 1 });
    await panel.getByRole("button", { name: "Load original evidence" }).click();
    await expect(panel.getByLabel("Original evidence page")).toBeVisible();
    expired = true;
    await panel.getByRole("button", { name: "Next session page" }).click();
    await expect(panel.getByLabel("Scanned session")).toHaveCount(0);
    await expect(panel.getByLabel("Original evidence page")).toHaveCount(0);
    await expect(panel.getByText("budget-exceeded", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Rescan JSONL source" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Read source", exact: true })).toBeEnabled();
  } finally {
    await runtime.close();
    await rm(root, { recursive: true });
  }
});

test("an expired status after a lost scan response does not restore a catalog or lock the rescan control", async ({ page }) => {
  const text = await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8");
  const { root, runtime } = await fixture(text);
  let catalogRequests = 0;
  await page.route("**/api/scan", async (route) => { await route.fetch(); await route.abort("failed"); });
  await page.route("**/api/scan/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.scan = { ...body.scan, phase: "budget-exceeded", reason: "The scan exceeded its lifetime budget.",
      sessions: null, unassigned: null, classification: null, cleanupPending: false };
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/scan/catalog", async (route) => { catalogRequests++; await route.continue(); });
  try {
    await page.goto(runtime.launchUrl);
    const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect(panel.getByText("budget-exceeded", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Rescan JSONL source" })).toBeEnabled();
    await expect(panel.getByLabel("Scanned session")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Read source", exact: true })).toBeEnabled();
    expect(catalogRequests).toBe(0);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true });
  }
});

test("a source-changed detail failure clears the invalidated catalog and evidence before allowing a rescan", async ({ page }) => {
  const text = await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8");
  const { root, file, runtime } = await fixture(text);
  try {
    await page.goto(runtime.launchUrl);
    const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Rescan JSONL source" })).toBeEnabled();
    await panel.getByLabel("Scanned session").selectOption({ index: 1 });
    await panel.getByRole("button", { name: "Load original evidence" }).click();
    await expect(panel.getByLabel("Original evidence page")).toBeVisible();
    await writeFile(file, '{"scopeMetrics":[]}\n');
    await panel.getByRole("button", { name: "Load original evidence" }).click();
    await expect(panel.getByText("source-changed", { exact: true })).toBeVisible();
    await expect(panel.getByLabel("Scanned session")).toHaveCount(0);
    await expect(panel.getByLabel("Original evidence page")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Load original evidence" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Read source", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "Rescan JSONL source" }).click();
    await expect(panel.getByText("partial", { exact: true })).toBeVisible();
    await expect(panel.getByLabel("Scanned session")).toHaveValue("");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true });
  }
});

test("failed detail responses reconcile cleanup before unlocking even when a progress response is delayed", async ({ page }) => {
  const text = await readFile(new URL("../fixtures/otel.jsonl", import.meta.url), "utf8");
  const { root, runtime } = await fixture(text);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let statusRequests = 0;
  let recovered = false;
  try {
    await page.goto(runtime.launchUrl);
    const panel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await panel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Rescan JSONL source" })).toBeEnabled();
    await panel.getByLabel("Scanned session").selectOption({ index: 1 });
    await page.route("**/api/scan/status", async (route) => {
      const response = await route.fetch();
      if (++statusRequests === 1) {
        await held;
        await route.fulfill({ response });
      } else {
        const body = await response.json();
        if (!recovered) body.scan = { ...body.scan, phase: "cleanup-failed", cleanupPending: true };
        await route.fulfill({ response, json: body });
      }
    });
    await page.route("**/api/scan/details", async (route) => {
      await route.fulfill({ status: 503, json: { error: { code: "SOURCE_CLEANUP_FAILED", message: "Fictional detail cleanup failure." } } });
    });
    await page.route("**/api/cancel", async (route) => { recovered = true; await route.continue(); });
    await panel.getByRole("button", { name: "Load original evidence" }).click();
    await expect(panel.getByRole("button", { name: "Retry source cleanup" })).toBeVisible();
    await expect(panel.getByLabel("Scanned session")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Rescan JSONL source" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Read source", exact: true })).toBeDisabled();
    release();
    await panel.getByRole("button", { name: "Retry source cleanup" }).click();
    await expect(panel.getByRole("button", { name: "Rescan JSONL source" })).toBeEnabled();
    expect(statusRequests).toBeGreaterThan(1);
  } finally {
    release();
    await runtime.close();
    await rm(root, { recursive: true });
  }
});
