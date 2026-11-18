/**
 * Production React report rendered from actual native-reader/calculator fixtures.
 * Only transport is shimmed: catalog projections are synthetic, not a released-helper
 * qualification. The guarded native integration case runs in source-discovery.test.ts.
 */
import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { startRuntime } from "../../.build/src/runtime/server.js";
import { recordedReport } from "../../.build/src/runtime/report.js";
import {
  nativeReportView,
  nativeReportRecords,
  reportCommand,
} from "../../.build/tests/fixtures/native-report.js";

/** Mount the real local UI, routing source transport through the real native adapters and calculator, never hard-coded metric values. */
async function openNativeReport(page) {
  const root = await mkdtemp(
    path.join(tmpdir(), "agent-insights-report-browser-"),
  );
  const file = path.join(root, "events.jsonl");
  await writeFile(
    file,
    nativeReportRecords()
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  const runtime = await startRuntime({
    sources: [file],
    port: 0,
    harness: "copilot",
    model: null,
    copilotPath: path.join(root, "no-model"),
  });
  let view = await nativeReportView();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  /** Keep the test-only reader selection consistent across status and explicit refresh controls. */
  const statusResponse = async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      json: { ...status, readers: ["copilot-sdk-events-jsonl"] },
    });
  };
  await page.route("**/api/status", statusResponse);
  await page.route("**/api/refresh", statusResponse);
  await page.route("**/api/read", async (route) => {
    await route.fulfill({ json: view });
  });
  await page.route("**/api/report", async (route) => {
    try {
      await route.fulfill({
        json: recordedReport(view, route.request().postDataJSON()),
      });
    } catch (failure) {
      await route.fulfill({
        status: failure.status ?? 500,
        json: {
          error: {
            code: failure.code ?? "TEST_REPORT_FAILURE",
            message: failure.message,
          },
        },
      });
    }
  });
  try {
    await page.goto(runtime.launchUrl);
    await page
      .getByRole("button", { name: "Read source", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Session report", exact: true }),
    ).toBeVisible();
    return {
      runtime,
      requests,
      /** Replace only the explicitly synthetic source transport for the next user-triggered read. */
      setView(next) {
        view = next;
      },
      /** Stop only this test's server, then remove its exact owned temporary root. */
      async close() {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (failure) {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
    throw failure;
  }
}

test("native report numbers reach exact original commands/messages and return to preserved context", async ({
  page,
}, testInfo) => {
  const fixture = await openNativeReport(page);
  try {
    const report = page.getByRole("region", {
      name: "Session report",
      exact: true,
    });
    await expect(
      report.getByText("Copilot Agent Host", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      report.getByRole("button", {
        name: "Tool calls: 2; partial coverage",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      report.getByRole("button", {
        name: "Recorded input tokens: Unavailable; unavailable coverage",
        exact: true,
      }),
    ).toBeVisible();
    await expect(report.getByText("Not analyzed", { exact: true })).toHaveCount(
      4,
    );
    const metric = report.getByRole("button", {
      name: "Tool calls: 2; partial coverage",
      exact: true,
    });
    await metric.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Tool calls: 2", exact: true }),
    ).toBeFocused();
    await dialog.getByRole("button", { name: /shell-call/ }).click();
    await dialog.getByText("Captured toolArguments", { exact: true }).click();
    await expect(
      dialog.locator("pre").filter({ hasText: "printf" }).first(),
    ).toHaveText(
      JSON.stringify({ command: reportCommand, cwd: "/fictional/project" }),
    );
    await dialog.getByText("Captured toolResult", { exact: true }).click();
    await expect(
      dialog.locator("pre").filter({ hasText: "stdout: fictional" }),
    ).toContainText("<script>window.reportInjected=true</script>");
    await expect(dialog.locator(".source-anchors pre").first()).toContainText(
      '"line": 4',
    );
    await expect(dialog.locator(".source-anchors pre").last()).toContainText(
      '"line": 7',
    );
    expect(await page.evaluate(() => window.reportInjected)).toBeUndefined();
    await expect(dialog.locator("a[href], script, img")).toHaveCount(0);
    await page.goBack();
    await expect(
      dialog.getByRole("heading", { name: "Tool calls: 2", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(metric).toBeFocused();

    await report.getByLabel("Tool filter").selectOption({ label: "shell" });
    const tools = report.getByRole("region", { name: "Tools", exact: true });
    await expect(
      tools.getByRole("button", {
        name: "Tool calls: 2; partial coverage",
        exact: true,
      }),
    ).toBeVisible();
    const invocations = report.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Tools & commands",
        exact: true,
      }),
    });
    const shell = invocations.getByRole("button", { name: /shell-call/ });
    await shell.click();
    await dialog
      .getByRole("button", { name: "Full-width detail", exact: true })
      .click();
    await expect(dialog).toHaveClass(/wide/);
    await dialog.getByRole("button", { name: "Close evidence" }).click();
    await expect(report.getByLabel("Tool filter")).toHaveValue('"shell"');
    await expect(shell).toBeFocused();
    await report.getByRole("button", { name: /user message.*request/ }).click();
    await expect(
      dialog.getByText(
        '<img src=x onerror="window.reportInjected=true">Please inspect the fictional fixture.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(dialog.getByText(/Native identity:/)).toContainText("request");
    await page.keyboard.press("Escape");
    await report
      .getByRole("button", { name: "Inspect activity lanes", exact: true })
      .click();
    await expect(
      dialog.getByRole("heading", { name: "model-call", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Unavailable: no qualified lifecycle classification.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: testInfo.outputPath("recorded-report.png"),
      fullPage: true,
    });
    expect(
      fixture.requests.every((url) =>
        url.startsWith(fixture.runtime.origin + "/"),
      ),
    ).toBe(true);
    expect(
      fixture.requests.some((url) => url.endsWith("/api/analysis/start")),
    ).toBe(false);
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
    await expect(
      report.getByRole("button", {
        name: /save|confirm|correct|edit|rename|exclude/i,
      }),
    ).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test("every reported number opens contributors or an honest unavailable explanation; narrow modal traps focus", async ({
  page,
}) => {
  const fixture = await openNativeReport(page);
  try {
    const report = page.getByRole("region", {
      name: "Session report",
      exact: true,
    });
    await expect(report.locator(".metric-card").first()).toBeVisible();
    for (const card of await report.locator(".metric-card").all()) {
      await card.click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("heading", {
          name: "Contributing records",
          exact: true,
        }),
      ).toBeVisible();
      await expect(dialog.locator(".metric-definition")).not.toBeEmpty();
      expect(
        (await dialog
          .getByRole("button", {
            name: /message|tool-call|assistant-turn|usage-observation/,
          })
          .count()) > 0 ||
          (await dialog
            .getByText(/No attributable interaction content/)
            .isVisible()),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(card).toBeFocused();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const metric = report.getByRole("button", {
      name: "Tool calls: 2; partial coverage",
      exact: true,
    });
    await metric.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /shell-call/ }).click();
    await dialog.getByText("Captured toolArguments", { exact: true }).click();
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press("Tab");
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await dialog.getByRole("button", { name: "Back to contributors" }).click();
    await dialog.getByRole("button", { name: "Close evidence" }).click();
    await expect(metric).toBeFocused();
  } finally {
    await fixture.close();
  }
});

test("invalid/stale evidence links, missing catalog and wrong-runtime sources never substitute another record", async ({
  page,
}) => {
  const fixture = await openNativeReport(page);
  try {
    const report = page.getByRole("region", {
      name: "Session report",
      exact: true,
    });
    await expect(report.locator(".metric-card").first()).toBeVisible();
    for (const hash of [
      "#report?read=report-read&session=report-read%3Asdk-session&panel=event&id=does-not-exist",
      "#report?read=older-read&session=report-read%3Asdk-session&panel=metric&id=tools",
      "#report?read=report-read&session=other-session&panel=event&id=request",
      "#report?read=report-read&session=report-read%3Asdk-session&panel=metric&id=not-a-metric",
      "#report?read=report-read&session=report-read%3Asdk-session&panel=event&id=request&from=tools",
      "#report?read=x&read=y&session=s&panel=event",
    ]) {
      await page.evaluate((value) => {
        window.location.hash = value;
      }, hash);
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(
        dialog.getByRole("heading", { name: "Original source anchors" }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await report
      .getByRole("button", {
        name: "Inspect source identity and capture coverage",
        exact: true,
      })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByText(/Processing completion is not an input-observation bound/),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Refresh sources", exact: true })
      .click();
    await expect(report).toHaveCount(0);
    for (const view of [
      await nativeReportView({ raw: "" }),
      await nativeReportView({
        raw: '{"traceId":"extension-is-not-agent-host"}\n',
      }),
      await nativeReportView({ catalogAvailable: false }),
    ]) {
      fixture.setView(view);
      await page
        .getByRole("button", { name: "Read source", exact: true })
        .click();
      await expect(
        report.getByRole("heading", {
          name: "No attributable session is available",
        }),
      ).toBeVisible();
      await expect(report.locator(".metric-card")).toHaveCount(0);
    }
  } finally {
    await fixture.close();
  }
});

test("refresh discards an outstanding metric response instead of resurrecting the old report", async ({
  page,
}) => {
  const fixture = await openNativeReport(page);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  try {
    const view = await nativeReportView({ readId: "replacement-read" });
    fixture.setView(view);
    await page.route("**/api/report", async (route) => {
      const report = recordedReport(view, route.request().postDataJSON());
      entered();
      await gate;
      await route.fulfill({ json: report });
    });
    await page
      .getByRole("button", { name: "Read source", exact: true })
      .click();
    await waiting;
    await page
      .getByRole("button", { name: "Refresh sources", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Session report", exact: true }),
    ).toHaveCount(0);
    const completed = page.waitForResponse("**/api/report");
    release();
    await completed;
    await expect(
      page.getByRole("region", { name: "Session report", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
  } finally {
    release();
    await fixture.close();
  }
});
