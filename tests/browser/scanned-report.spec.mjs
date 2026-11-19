/** Real >64 MiB scan/report/browser regressions using independently generated owned exporter-shaped data. */
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, stat, appendFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRuntime } from "../../.build/src/runtime/server.js";
import { productionReaders } from "../../.build/src/evidence/readers/index.js";

test("browser Forward locks source controls until its metric request settles even after the drawer closes", async ({
  page,
}) => {
  const source = await fixture(0);
  let arrived;
  const responseArrived = new Promise((resolve) => {
    arrived = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await page.goto(source.runtime.launchUrl);
    const scan = page.getByRole("region", { name: "Bounded JSONL scan" });
    const rescan = scan.getByRole("button", { name: "Rescan JSONL source" });
    const session = scan.getByLabel("Scanned session");
    await scan
      .getByRole("button", { name: "Scan JSONL source", exact: true })
      .click();
    await expect(rescan).toBeEnabled();
    await session.selectOption({ index: 1 });
    await scan.getByRole("button", { name: "Open session report" }).click();
    const report = page.getByRole("region", {
      name: "Session report",
      exact: true,
    });
    const input = report.getByRole("button", {
      name: "Recorded input tokens: 27; partial coverage",
      exact: true,
    });
    await input.click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: /^Original line / }),
    ).toHaveCount(20);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(rescan).toBeEnabled();
    await page.route("**/api/scan/metric", async (route) => {
      const response = await route.fetch();
      arrived();
      await held;
      await route.fulfill({ response });
    });
    await page.goForward();
    await responseArrived;
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(rescan).toBeDisabled();
    await expect(session).toBeDisabled();
    await expect(
      scan.getByRole("button", { name: "Load original evidence" }),
    ).toBeDisabled();
    await expect(
      report.getByRole("button", { name: "Cancel report operation" }),
    ).toBeVisible();
    release();
    await expect(rescan).toBeEnabled();
    await expect(session).toBeEnabled();
    await expect(input).toBeEnabled();
    await expect(
      report.getByRole("button", { name: "Cancel report operation" }),
    ).toHaveCount(0);
  } finally {
    release();
    await source.close();
  }
});

test("lost cancellation cannot publish a late report even when the backend generation remains valid", async ({
  page,
}) => {
  const source = await fixture(0);
  let arrived;
  const responseArrived = new Promise((resolve) => {
    arrived = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await page.goto(source.runtime.launchUrl);
    const scan = page.getByRole("region", { name: "Bounded JSONL scan" });
    await scan
      .getByRole("button", { name: "Scan JSONL source", exact: true })
      .click();
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeEnabled();
    await scan.getByLabel("Scanned session").selectOption({ index: 1 });
    await page.route("**/api/scan/report", async (route) => {
      const response = await route.fetch();
      arrived();
      await held;
      await route.fulfill({ response });
    });
    await page.route("**/api/scan/cancel", (route) => route.abort("failed"));
    await scan.getByRole("button", { name: "Open session report" }).click();
    await responseArrived;
    await page.getByRole("button", { name: "Cancel report operation" }).click();
    release();
    const report = page.getByRole("region", {
      name: "Session report",
      exact: true,
    });
    await expect(report.getByRole("alert")).toContainText(/cancelled/);
    await expect(report.locator(".metric-card")).toHaveCount(0);
    expect(source.runtime.service.scanCatalog.status.phase).toBe("partial");
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeEnabled();
  } finally {
    release();
    await source.close();
  }
});

test("failed report cleanup exposes an explicit runtime cleanup retry before unlocking", async ({
  page,
}) => {
  const source = await fixture(0);
  let failedCleanup = false;
  await page.route("**/api/scan/status", async (route) => {
    if (failedCleanup)
      await route.fulfill({
        json: {
          scan: {
            ...source.runtime.service.scanCatalog.status,
            phase: "cleanup-failed",
            cleanupPending: true,
            reason: "Synthetic descriptor cleanup remains unconfirmed.",
          },
        },
      });
    else await route.continue();
  });
  await page.route("**/api/cancel", async (route) => {
    failedCleanup = false;
    await route.continue();
  });
  try {
    await page.goto(source.runtime.launchUrl);
    const scan = page.getByRole("region", { name: "Bounded JSONL scan" });
    await scan
      .getByRole("button", { name: "Scan JSONL source", exact: true })
      .click();
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeEnabled();
    await scan.getByLabel("Scanned session").selectOption({ index: 1 });
    failedCleanup = true;
    await page.route("**/api/scan/report", (route) => route.abort("failed"));
    await scan.getByRole("button", { name: "Open session report" }).click();
    const report = page.getByRole("region", {
      name: "Session report",
      exact: true,
    });
    await expect(
      report.getByRole("button", { name: "Retry source cleanup" }),
    ).toBeVisible();
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeDisabled();
    await report.getByRole("button", { name: "Retry source cleanup" }).click();
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeEnabled();
    await expect(report.locator(".metric-card")).toHaveCount(0);
  } finally {
    failedCleanup = false;
    await source.close();
  }
});

/** Fictional supported exporter records, generated without production normalization or a private capture. */
function execution(index, attributes = {}) {
  return {
    traceId: "a".repeat(32),
    spanId: index.toString(16).padStart(16, "0"),
    name: "fictional",
    kind: 2,
    startTime: [1760000000 + index, 0],
    endTime: [1760000001 + index, 0],
    ended: true,
    status: { code: 1 },
    events: [],
    links: [],
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.conversation.id": "selected",
      "gen_ai.usage.input_tokens": 20,
      "gen_ai.usage.output_tokens": 5,
      ...attributes,
    },
    resource: { attributes: { "service.name": "synthetic-browser" } },
    instrumentationScope: { name: "synthetic" },
  };
}

/** Write over 64 MiB incrementally, interleaving sessions and distant conflicts without a file-sized buffer. */
async function fixture(minBytes = 64 * 1024 * 1024) {
  const root = await mkdtemp(
    path.join(tmpdir(), "agent-insights-scanned-report-"),
  );
  const file = path.join(root, "large.jsonl");
  const handle = await open(file, "wx");
  let bytes = 0;
  let line = 0;
  /** Charge exact physical coordinates while handling short writes. */
  async function write(record) {
    const data = Buffer.from(JSON.stringify(record) + "\n");
    const position = {
      line: ++line,
      byteOffset: bytes,
      byteLength: data.length - 1,
      fingerprint: createHash("sha256")
        .update(data.subarray(0, -1))
        .digest("hex"),
    };
    for (let offset = 0; offset < data.length;) {
      const result = await handle.write(data, offset, data.length - offset);
      expect(result.bytesWritten).toBeGreaterThan(0);
      offset += result.bytesWritten;
    }
    bytes += data.length;
    return position;
  }
  let last;
  try {
    for (let index = 0; index < 25; index++) await write(execution(1));
    await write(
      execution(2, {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "shell",
        "gen_ai.tool.call.arguments":
          "<script>window.reportInjected=true</script>\nprintf fictional",
      }),
    );
    await write(
      execution(9, {
        "gen_ai.conversation.id": "foreign",
        "gen_ai.usage.input_tokens": undefined,
      }),
    );
    await write(execution(4, { "gen_ai.input.messages": "conflict first" }));
    const padding = { scopeMetrics: [], padding: "x".repeat(64 * 1024 - 33) };
    while (bytes <= minBytes) await write(padding);
    await write(execution(4, { "gen_ai.input.messages": "conflict other" }));
    last = await write(
      execution(3, {
        "gen_ai.usage.input_tokens": 7,
        "gen_ai.usage.output_tokens": 0,
        "gen_ai.input.messages": "FICTIONAL_LAST_CONTRIBUTOR",
      }),
    );
  } finally {
    await handle.close();
  }
  const runtime = await startRuntime(
    {
      sources: [file],
      port: 0,
      harness: "copilot",
      model: null,
      copilotPath: path.join(root, "no-model"),
    },
    { readers: productionReaders },
  );
  return {
    root,
    file,
    runtime,
    bytes,
    last,
    /** Shut down this runtime before deleting its exact owned synthetic root. */
    async close() {
      await runtime.close();
      await rm(root, { recursive: true });
    },
  };
}

test("large scan opens exact whole-session totals and paged original metrics without Read source", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const source = await fixture();
  const requests = [];
  const errors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    expect(source.bytes).toBeGreaterThan(64 * 1024 * 1024);
    await page.goto(source.runtime.launchUrl);
    const scan = page.getByRole("region", { name: "Bounded JSONL scan" });
    await scan
      .getByRole("button", { name: "Scan JSONL source", exact: true })
      .click();
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeEnabled({ timeout: 30_000 });
    await scan.getByLabel("Scanned session").selectOption({ index: 1 });
    await scan.getByLabel("Recorded start from").fill("1760000003000");
    await scan.getByRole("button", { name: "Open session report" }).click();
    const report = page.getByRole("region", {
      name: "Session report",
      exact: true,
    });
    const input = report.getByRole("button", {
      name: "Recorded input tokens: 27; partial coverage",
      exact: true,
    });
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await expect(
      report.getByRole("button", {
        name: "Tool calls: 1; partial coverage",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      report.getByRole("button", {
        name: "Observed elapsed: 3,000 ms; partial coverage",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      report.getByRole("button", {
        name: "Recorded agent activity: 3,000 ms; partial coverage",
        exact: true,
      }),
    ).toBeVisible();
    let reopenArrived;
    const reopened = new Promise((resolve) => {
      reopenArrived = resolve;
    });
    let releaseReopen;
    const gate = new Promise((resolve) => {
      releaseReopen = resolve;
    });
    await page.route("**/api/scan/report", async (route) => {
      const response = await route.fetch();
      reopenArrived();
      await gate;
      await route.fulfill({ response });
    });
    await scan.getByRole("button", { name: "Open session report" }).click();
    await reopened;
    await expect(report.locator(".metric-card")).toHaveCount(0);
    await expect(
      scan.getByRole("button", { name: "Open session report" }),
    ).toBeDisabled();
    releaseReopen();
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await page.unroute("**/api/scan/report");
    await input.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", {
        name: "Recorded input tokens: 27",
        exact: true,
      }),
    ).toBeFocused();
    await expect(
      dialog.getByRole("button", { name: /^Original line / }),
    ).toHaveCount(20, { timeout: 30_000 });
    await dialog.getByRole("button", { name: "Next contributor page" }).click();
    await expect(
      dialog.getByRole("button", { name: /^Original line / }),
    ).toHaveCount(6, { timeout: 30_000 });
    await expect(
      dialog.getByRole("button", { name: /^Original line 1 ·/ }),
    ).toHaveCount(0);
    await dialog
      .getByRole("button", {
        name: new RegExp(`^Original line ${source.last.line} ·`),
      })
      .click();
    await expect(
      dialog.getByText("FICTIONAL_LAST_CONTRIBUTOR", { exact: false }),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        new RegExp(
          `byte offset ${source.last.byteOffset}; ${source.last.byteLength} bytes`,
        ),
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(source.last.fingerprint, { exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(
      dialog.getByRole("button", { name: /^Original line / }),
    ).toHaveCount(6);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(scan.getByLabel("Recorded start from")).toHaveValue(
      "1760000003000",
    );
    await report
      .getByRole("button", {
        name: "Tool calls: 1; partial coverage",
        exact: true,
      })
      .click();
    await dialog.getByRole("button", { name: /^Original line 26 ·/ }).click();
    await expect(dialog.locator("pre")).toContainText(
      "<script>window.reportInjected=true</script>",
    );
    expect(await page.evaluate(() => window.reportInjected)).toBeUndefined();
    await expect(dialog.locator("a[href], script, img")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await scan.getByLabel("Scanned session").selectOption({ index: 2 });
    await expect(report).toHaveCount(0);
    await scan.getByRole("button", { name: "Open session report" }).click();
    await expect(
      report.getByRole("button", {
        name: "Recorded input tokens: Unavailable; unavailable coverage",
        exact: true,
      }),
    ).toBeEnabled({ timeout: 30_000 });
    await report
      .getByRole("button", {
        name: "Recorded input tokens: Unavailable; unavailable coverage",
        exact: true,
      })
      .click();
    await expect(
      dialog.getByRole("button", { name: /^Original line / }),
    ).toHaveCount(1);
    await expect(dialog.locator(".notice")).toContainText(
      "coverage witnesses for a measured zero or unavailable measurement, not additive contributors",
    );
    await page.keyboard.press("Escape");
    expect(source.runtime.service.view).toBeNull();
    expect(
      requests.some((url) => /\/api\/(read|analysis\/start)$/.test(url)),
    ).toBe(false);
    expect(
      requests.every((url) => url.startsWith(source.runtime.origin + "/")),
    ).toBe(true);
    expect(await readdir(source.root)).toEqual(["large.jsonl"]);
    expect((await stat(source.file)).size).toBe(source.bytes);
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
    expect(errors).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await source.close();
  }
});

test("unknown report cleanup retains its lock until status recovers", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const source = await fixture();
  let loseStatus = false;
  await page.route("**/api/scan/status", async (route) => {
    if (loseStatus) await route.abort("failed");
    else await route.continue();
  });
  try {
    await page.goto(source.runtime.launchUrl);
    const scan = page.getByRole("region", { name: "Bounded JSONL scan" });
    await scan
      .getByRole("button", { name: "Scan JSONL source", exact: true })
      .click();
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeEnabled({ timeout: 30_000 });
    await scan.getByLabel("Scanned session").selectOption({ index: 1 });
    loseStatus = true;
    await scan.getByRole("button", { name: "Open session report" }).click();
    const report = page.getByRole("region", {
      name: "Session report",
      exact: true,
    });
    await expect(report.getByRole("alert")).toBeVisible();
    await expect(report.locator(".metric-card")).toHaveCount(0);
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeDisabled();
    loseStatus = false;
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeEnabled();
    await scan.getByRole("button", { name: "Open session report" }).click();
    await expect(
      report.getByRole("button", {
        name: "Recorded input tokens: 27; partial coverage",
        exact: true,
      }),
    ).toBeEnabled({ timeout: 30_000 });
  } finally {
    loseStatus = false;
    await source.close();
  }
});

test("large report rejects prefix changes and a delayed report cannot resurrect cancelled evidence", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const source = await fixture();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let arrived;
  const responseArrived = new Promise((resolve) => {
    arrived = resolve;
  });
  try {
    await page.goto(source.runtime.launchUrl);
    const scan = page.getByRole("region", { name: "Bounded JSONL scan" });
    await scan
      .getByRole("button", { name: "Scan JSONL source", exact: true })
      .click();
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeEnabled({ timeout: 30_000 });
    await scan.getByLabel("Scanned session").selectOption({ index: 1 });
    await page.route("**/api/scan/report", async (route) => {
      const response = await route.fetch();
      arrived();
      await held;
      await route.fulfill({ response });
    });
    await scan.getByRole("button", { name: "Open session report" }).click();
    await responseArrived;
    await page.getByRole("button", { name: "Cancel report operation" }).click();
    release();
    const report = page.getByRole("region", {
      name: "Session report",
      exact: true,
    });
    await expect(
      report.getByText(/stale numbers and evidence are not retained/),
    ).toBeVisible();
    await expect(report.locator(".metric-card")).toHaveCount(0);
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeEnabled();
    await page.unroute("**/api/scan/report");
    await scan.getByRole("button", { name: "Rescan JSONL source" }).click();
    await expect(
      scan.getByRole("button", { name: "Rescan JSONL source" }),
    ).toBeEnabled({ timeout: 30_000 });
    await scan.getByLabel("Scanned session").selectOption({ index: 1 });
    await scan.getByRole("button", { name: "Open session report" }).click();
    const input = report.getByRole("button", {
      name: "Recorded input tokens: 27; partial coverage",
      exact: true,
    });
    await expect(input).toBeEnabled({ timeout: 30_000 });
    // Same-size in-place change to an admitted contributor, not append beyond its boundary.
    const handle = await open(source.file, "r+");
    try {
      await handle.write(Buffer.from("b"), 0, 1, 13);
    } finally {
      await handle.close();
    }
    await input.click();
    await expect(report.locator(".metric-card")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(
      report.getByText(/stale numbers and evidence are not retained/),
    ).toBeVisible();
    expect(source.runtime.service.scanCatalog.status.phase).toBe(
      "source-changed",
    );
    await appendFile(source.file, "\n");
    expect((await stat(source.file)).size).toBe(source.bytes + 1);
  } finally {
    release();
    await source.close();
  }
});
