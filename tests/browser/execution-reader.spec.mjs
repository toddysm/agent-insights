/**
 * Exercise the packaged CLI's production reader through the actual Sources page.
 * Only a test-owned fictional capture is read; the model executable is deliberately
 * unavailable. Playwright supplies the page and test-owned screenshot destination.
 */
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("the normal application reads execution evidence, shows coverage and clears stale evidence", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-insights-reader-browser-"),
  );
  const file = path.join(directory, "fictional.jsonl");
  let child;
  let exited;
  try {
    const bytes = await readFile(
      new URL("../fixtures/otel.jsonl", import.meta.url),
    );
    await writeFile(file, bytes);
    child = spawn(
      process.execPath,
      [
        ".build/src/runtime/cli.js",
        "--source",
        file,
        "--copilot-path",
        path.join(directory, "no-model-runtime"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    exited = once(child, "exit");
    const signal = AbortSignal.timeout(15_000);
    let output = "";
    while (!output.includes("\n")) {
      const [chunk] = await once(child.stdout, "data", { signal });
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
    await expect(page.getByLabel("Reader format")).toHaveValue(
      "vscode-otel-jsonl",
    );
    await expect(
      page.getByRole("heading", { name: "Read coverage" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Read source", exact: true })
      .click();
    await expect(
      page.getByText("Read completed: 1 session and 2 records.", {
        exact: false,
      }),
    ).toBeVisible();
    const coverage = page.getByRole("region", { name: "Read coverage" });
    await expect(coverage).toBeVisible();
    await expect(
      coverage.getByText(
        "unavailable: Execution content is not a reconstructed conversation",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Session to analyze")).toHaveCount(0);
    await expect(
      page.getByText(/Analysis definitions are not installed yet/i),
    ).toBeVisible();
    expect(await readFile(file)).toEqual(bytes);
    expect(await readdir(directory)).toEqual(["fictional.jsonl"]);
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("execution-coverage-mobile.png"),
      fullPage: true,
    });

    await writeFile(
      file,
      Buffer.concat([
        bytes,
        Buffer.from('{"unfinished":"PRIVATE_PARSE_MARKER'),
      ]),
    );
    await page
      .getByRole("button", { name: "Read source", exact: true })
      .click();
    await expect(
      page.getByText(/Partial read: 1 session and 2 records/),
    ).toBeVisible();
    await page.getByText(/Read limitations \(/).click();
    await expect(
      coverage
        .getByRole("listitem")
        .filter({ hasText: "Malformed JSON record" }),
    ).toBeVisible();
    await expect(
      page.getByText("PRIVATE_PARSE_MARKER", { exact: false }),
    ).toHaveCount(0);

    await writeFile(file, '{"version":"unsupported"}');
    await page
      .getByRole("button", { name: "Read source", exact: true })
      .click();
    await expect(
      page.getByText(/No session evidence is available from this read/),
    ).toBeVisible();
    await expect(page.getByText(/Read completed:|Partial read:/)).toHaveCount(
      0,
    );
    await expect(
      coverage.locator("dd").filter({ hasText: /^unavailable/ }),
    ).toHaveCount(4);
    await expect(page.getByLabel("Session to analyze")).toHaveCount(0);
    expect(requests.every((url) => url.startsWith(origin + "/"))).toBe(true);
    expect(requests.some((url) => url.endsWith("/api/analysis/start"))).toBe(
      false,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    if (exited) await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
