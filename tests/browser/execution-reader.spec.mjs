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
    await expect(page.getByLabel("Report session (from source read)")).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to Scan JSONL source" })).toHaveCount(0);
    expect(requests.some((url) => url.endsWith("/api/scan"))).toBe(false);
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

    const raw = JSON.parse(bytes.toString().split("\n")[0]);
    const hookRecords = Array.from({ length: 11 }, (_, index) => ({
      ...raw,
      spanId: (index + 1).toString(16).padStart(16, "0"),
      name: "execute_hook misleading span label",
      attributes: {
        "gen_ai.conversation.id": "synthetic-session",
        ...(index < 9
          ? {
              "gen_ai.operation.name": "execute_hook",
              "copilot_chat.hook_type": "PreToolUse",
              "copilot_chat.hook_input":
                '{"command":"PRIVATE_HOOK_MARKER_DO_NOT_EXECUTE"}',
            }
          : {}),
      },
    }));
    const hookBytes = Buffer.from(
      hookRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    await writeFile(file, hookBytes);
    await page
      .getByRole("button", { name: "Read source", exact: true })
      .click();
    await expect(
      page.getByText(/Partial read: 1 session and 9 records/),
    ).toBeVisible();
    const classification = coverage.getByRole("group", {
      name: "Operation classification",
    });
    await expect(classification).toBeVisible();
    await expect(
      classification
        .locator("div")
        .filter({
          has: page.locator("dt", { hasText: /^Hook executions$/ }),
        })
        .locator("dd"),
    ).toHaveText("9");
    await expect(
      classification
        .locator("div")
        .filter({
          has: page.locator("dt", {
            hasText: /^Unclassified spans \(operation missing\)$/,
          }),
        })
        .locator("dd"),
    ).toHaveText("2");
    await expect(
      classification
        .locator("div")
        .filter({
          has: page.locator("dt", { hasText: /^Model calls$|^Tool calls$/ }),
        })
        .locator("dd"),
    ).toHaveText(["0", "0"]);
    await expect(
      coverage.getByText(/Unsupported execution operation/),
    ).toHaveCount(0);
    await coverage.getByText(/Read limitations \(/).click();
    await expect(
      coverage.getByText(/span unclassified \(2 occurrence/),
    ).toBeVisible();
    await expect(
      page.getByText("PRIVATE_HOOK_MARKER", { exact: false }),
    ).toHaveCount(0);
    expect(await readFile(file)).toEqual(hookBytes);
    expect(await readdir(directory)).toEqual(["fictional.jsonl"]);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);

    const toolRecords = [1, 2].map((index) => ({
      ...raw,
      spanId: index.toString(16).padStart(16, "0"),
      attributes: {
        "gen_ai.conversation.id": "synthetic-session",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "synthetic_tool",
        "gen_ai.tool.call.id": "",
      },
    }));
    const model = {
      ...raw,
      spanId: "3".repeat(16),
      attributes: {
        "gen_ai.conversation.id": "synthetic-session",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "synthetic-model",
        "gen_ai.usage.input_tokens": 20,
        "gen_ai.usage.output_tokens": 5,
      },
    };
    await writeFile(file, [...toolRecords, model].map((record) => JSON.stringify(record)).join("\n") + "\n");
    await page.getByRole("button", { name: "Read source", exact: true }).click();
    await expect(page.getByText(/Read completed: 1 session and 3 records/)).toBeVisible();
    await expect(
      coverage.locator("dl").first().locator("div")
        .filter({ has: page.locator("dt", { hasText: /^(Timing|Tools|Tokens)$/ }) }).locator("dd"),
    ).toHaveText(["complete", "complete", "complete"]);
    await coverage.getByText(/Read limitations \(/).click();
    await expect(
      coverage.getByText("Tool-call identifier unavailable: empty value (2 occurrence(s); first line 1).", { exact: true }),
    ).toBeVisible();
    await expect(coverage.getByText(/Invalid reported gen_ai.tool.call.id/)).toHaveCount(0);

    const scanPanel = page.getByRole("region", { name: "Bounded JSONL scan" });
    await scanPanel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect(scanPanel.getByText("complete", { exact: true })).toBeVisible();
    await expect(scanPanel.getByText(/Coverage is partial; malformed/)).toHaveCount(0);

    toolRecords[1].attributes["gen_ai.tool.call.id"] = { value: "PRIVATE_TOOL_ID_MARKER" };
    const toolBytes = Buffer.from([...toolRecords, model].map((record) => JSON.stringify(record)).join("\n") + "\n");
    await writeFile(file, toolBytes);
    await page.getByRole("button", { name: "Read source", exact: true }).click();
    await expect(page.getByText(/Partial read: 1 session and 3 records/)).toBeVisible();
    if (await coverage.locator("details:not([open])").count())
      await coverage.getByText(/Read limitations \(/).click();
    await expect(
      coverage.getByText("Invalid reported gen_ai.tool.call.id: expected a string (1 occurrence(s); first line 2).", { exact: true }),
    ).toBeVisible();
    await scanPanel.getByRole("button", { name: "Scan JSONL source", exact: true }).click();
    await expect(scanPanel.getByText("partial", { exact: true })).toBeVisible();
    await expect(page.getByText("PRIVATE_TOOL_ID_MARKER", { exact: false })).toHaveCount(0);
    expect(await readFile(file)).toEqual(toolBytes);
    expect(await readdir(directory)).toEqual(["fictional.jsonl"]);

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
