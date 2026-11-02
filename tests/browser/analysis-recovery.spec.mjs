/**
 * Browser regressions for accepted starts with lost responses, selection-scoped
 * terminal data and untruncated citation layout. Playwright supplies the isolated
 * page used by each test callback; testInfo supplies case-scoped screenshot paths.
 *
 * Each case owns its temporary capture placeholders and local runtime, injecting
 * synthetic readers/operations/providers rather than invoking Copilot. Route
 * interception introduces transport failures; finally blocks stop the runtime
 * and remove only the case's files. Nothing here runs during normal application startup.
 */
import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRuntime } from "../../.build/src/runtime/server.js";
import { RuntimeError } from "../../.build/src/runtime/errors.js";
import { parseReadView } from "../../.build/src/evidence/contracts.js";
import {
  syntheticOperation,
  syntheticProvider,
  syntheticReader,
} from "../../.build/tests/fixtures/analysis.js";

test("a lost accepted-start response is reconciled without resubmitting analysis", async ({
  page,
}) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-insights-start-recovery-"),
  );
  const file = path.join(directory, "synthetic.jsonl");
  await writeFile(file, "SYNTHETIC");
  let calls = 0;
  let starts = 0;
  let failStatus = false;
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
        async analyze(_input, callbacks) {
          calls++;
          await new Promise((_resolve, reject) => {
            callbacks.signal.addEventListener(
              "abort",
              () => reject(new Error("SYNTHETIC_CANCEL")),
              { once: true },
            );
          });
          return "";
        },
      },
    },
  );
  try {
    await page.route("**/api/analysis/start", async (route) => {
      starts++;
      const accepted = await route.fetch();
      expect(accepted.status()).toBe(202);
      failStatus = true;
      await route.abort("failed");
    });
    await page.route("**/api/status", async (route) => {
      if (failStatus) {
        failStatus = false;
        await route.abort("failed");
      } else await route.continue();
    });
    await page.goto(runtime.launchUrl);
    await page.getByRole("button", { name: "Read source" }).click();
    await page.getByLabel("Session to analyze").selectOption("session-fixture");
    await page
      .getByRole("combobox", { name: "Analysis", exact: true })
      .selectOption("synthetic");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Analyze", exact: true }).click();
    await expect(
      page.getByText(/Checking whether analysis started/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Analyze", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("Source location", { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Cancel analysis" }),
    ).toBeVisible();
    expect(starts).toBe(1);
    expect(calls).toBe(1);
    await page.getByRole("button", { name: "Cancel analysis" }).click();
    await expect(page.getByText("Analysis cancelled: finished.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Analyze", exact: true }),
    ).toBeEnabled();
    expect(starts).toBe(1);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed analysis errors and usage do not follow a different operation or source selection", async ({
  page,
}) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-insights-terminal-scope-"),
  );
  const files = [
    path.join(directory, "first.jsonl"),
    path.join(directory, "second.jsonl"),
  ];
  await Promise.all(files.map((file) => writeFile(file, "SYNTHETIC")));
  const runtime = await startRuntime(
    {
      sources: files,
      port: 0,
      harness: "copilot",
      model: null,
      copilotPath: null,
    },
    {
      readers: [syntheticReader],
      analysisOperations: [
        syntheticOperation,
        {
          ...syntheticOperation,
          id: "other",
          label: "Other synthetic analysis",
        },
      ],
      analysisProvider: {
        ...syntheticProvider,
        async analyze(_input, callbacks) {
          callbacks.usage({ input: 5, output: 1, model: "synthetic" });
          throw new RuntimeError(
            "SYNTHETIC_FAILURE",
            "Synthetic terminal failure.",
            502,
          );
        },
      },
    },
  );
  try {
    await page.goto(runtime.launchUrl);
    await page.getByRole("button", { name: "Read source" }).click();
    await page.getByLabel("Session to analyze").selectOption("session-fixture");
    await page
      .getByRole("combobox", { name: "Analysis", exact: true })
      .selectOption("synthetic");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Analyze", exact: true }).click();
    await expect(page.getByText("Synthetic terminal failure.")).toBeVisible();
    await expect(page.getByText(/Analysis input tokens: 5/)).toBeVisible();
    await page
      .getByRole("combobox", { name: "Analysis", exact: true })
      .selectOption("other");
    await expect(page.getByText("Synthetic terminal failure.")).toHaveCount(0);
    await expect(page.getByText(/Analysis input tokens:/)).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "Analysis", exact: true })
      .selectOption("synthetic");
    await expect(page.getByText("Synthetic terminal failure.")).toBeVisible();
    await page
      .getByLabel("Source location", { exact: true })
      .selectOption({ label: files[1] });
    await expect(page.getByText("Synthetic terminal failure.")).toHaveCount(0);
    await expect(page.getByText(/Analysis input tokens:/)).toHaveCount(0);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("long evidence citations remain intact without horizontal overflow", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-insights-citation-layout-"),
  );
  const file = path.join(directory, "synthetic.jsonl");
  await writeFile(file, "SYNTHETIC");
  const eventIds = ["event-" + "x".repeat(320), "event-" + "y".repeat(512)];
  const runtime = await startRuntime(
    {
      sources: [file],
      port: 0,
      harness: "copilot",
      model: null,
      copilotPath: null,
    },
    {
      readers: [
        {
          ...syntheticReader,
          /**
           * Retain valid fixture provenance while replacing normalized IDs with long values.
           * @param {import("../../src/evidence/contracts.js").ReaderInput} input - Granted source/read identity.
           * @returns {Promise<import("../../src/evidence/contracts.js").ReadView>} Fictional evidence; no capture-format parsing occurs.
           */
          async read(input) {
            const view = await syntheticReader.read(input);
            expect(view.events).toHaveLength(eventIds.length);
            return parseReadView({
              ...view,
              events: view.events.map((event, index) => ({
                ...event,
                id: eventIds[index],
              })),
            });
          },
        },
      ],
      analysisOperations: [syntheticOperation],
      analysisProvider: {
        ...syntheticProvider,
        /**
         * Cite both long identifiers through the normal response-validation path.
         * @param {import("../../src/analysis/contracts.js").ProviderInput} input - Runner-prepared synthetic evidence.
         * @param {import("../../src/analysis/contracts.js").ProviderCallbacks} callbacks - Receive synthetic progress/usage.
         * @returns {Promise<string>} Valid synthetic result; no Copilot or remote model is invoked.
         */
        async analyze(input, callbacks) {
          const response = JSON.parse(
            await syntheticProvider.analyze(input, callbacks),
          );
          return JSON.stringify({ ...response, eventIds });
        },
      },
    },
  );
  try {
    await page.goto(runtime.launchUrl);
    await page.getByRole("button", { name: "Read source" }).click();
    await page.getByLabel("Session to analyze").selectOption("session-fixture");
    await page
      .getByRole("combobox", { name: "Analysis", exact: true })
      .selectOption("synthetic");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Analyze", exact: true }).click();
    await expect(page.getByText("Analysis succeeded: finished.")).toBeVisible();
    const citations = page
      .locator(".analysis-result p")
      .filter({ hasText: "Evidence records:" });
    await expect(citations).toHaveText(
      `Evidence records: ${eventIds.join(", ")}`,
    );
    for (const width of [390, 320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          citations.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        )
        .toBe(true);
      await expect(citations).toHaveText(
        `Evidence records: ${eventIds.join(", ")}`,
      );
      if (width === 390)
        await page.screenshot({
          path: testInfo.outputPath("long-citations-mobile.png"),
          fullPage: true,
        });
    }
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
