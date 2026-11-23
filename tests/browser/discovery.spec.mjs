/**
 * Exercise the approved wizard in the real loopback shell. Qualified discovery
 * responses and the registration-only Local reader below are explicitly synthetic;
 * these checks do not qualify the production Agent Host helper or any real capture.
 */
import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRuntime } from "../../.build/src/runtime/server.js";
import { productionMultiSourceReaders } from "../../.build/src/evidence/readers/index.js";
import {
  syntheticOperation,
  syntheticProvider,
  syntheticReader,
} from "../../.build/tests/fixtures/analysis.js";

/** Own all test grants and teardown; no private source or external model is used. */
async function withWizard(page, run, multiple = false) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-insights-wizard-"),
  );
  const file = path.join(directory, "synthetic.jsonl");
  const second = path.join(directory, "other", "User");
  await mkdir(second, { recursive: true });
  await writeFile(file, "SYNTHETIC_CAPTURE");
  const runtime = await startRuntime(
    {
      sources: multiple ? [directory, second] : [directory],
      port: 0,
      harness: "copilot",
      model: null,
      copilotPath: path.join(directory, "no-model"),
    },
    {
      readers: [
        {
          ...syntheticReader,
          /** A second fictional session proves that Open report does not silently choose the first session. */
          async read(input) {
            const view = await syntheticReader.read(input);
            return {
              ...view,
              sessions: [
                ...view.sessions,
                {
                  ...view.sessions[0],
                  id: "second-session",
                  nativeId: "second-native",
                },
              ],
            };
          },
        },
      ],
      multiSourceReaders: productionMultiSourceReaders,
      analysisOperations: [syntheticOperation],
      analysisProvider: syntheticProvider,
    },
  );
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  try {
    await page.goto(runtime.launchUrl);
    await run({
      wizard: page.getByRole("region", {
        name: "Find your sessions",
        exact: true,
      }),
      runtime,
      directory,
      requests,
    });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Native radios only select; the explicit Next action confirms each branch. */
async function choose(wizard, name) {
  await wizard.getByRole("radio", { name }).check();
  await wizard.getByRole("button", { name: "Next", exact: true }).click();
}

/** Pass through configured access without inventing installation detection or browser permission grants. */
async function reviewHost(wizard) {
  await choose(wizard, /^Copilot Choose/);
  await choose(wizard, /^Agent Host/);
  await wizard.getByRole("button", { name: "Next", exact: true }).click();
  await wizard.getByRole("checkbox").check();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
}

test("decisions stay separate from Next; unsupported branches and the real Agent Host gate do not read", async ({
  page,
}) => {
  await withWizard(page, async ({ wizard, requests }) => {
    await expect(
      wizard.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    for (const name of [/^Claude Code/, /^Codex/]) {
      await choose(wizard, name);
      await expect(wizard.getByRole("status")).toContainText("not supported");
      await expect(
        wizard.getByRole("button", { name: "Next", exact: true }),
      ).toHaveCount(0);
      await wizard.getByRole("button", { name: "Back", exact: true }).click();
    }
    await wizard.getByRole("radio", { name: /^Copilot Choose/ }).focus();
    await page.keyboard.press("Space");
    await expect(
      wizard.getByRole("heading", {
        name: "Which coding assistant did you use?",
      }),
    ).toBeVisible();
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await choose(wizard, /^Cloud Hosted/);
    await expect(wizard.getByRole("status")).toContainText("not supported");
    await wizard.getByRole("button", { name: "Back", exact: true }).click();
    await choose(wizard, /^I'm not sure/);
    await expect(
      wizard.getByText(/does not distinguish Local from Agent Host/),
    ).toBeVisible();
    await wizard.getByRole("button", { name: "Back", exact: true }).click();
    await choose(wizard, /^Agent Host/);
    await expect(wizard.getByRole("combobox")).toHaveCount(0);
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await expect(
      wizard.getByRole("button", { name: "Continue", exact: true }),
    ).toBeDisabled();
    await wizard.getByRole("checkbox").check();
    await wizard.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(wizard.getByRole("status")).toContainText("not available");
    await wizard.getByText("Availability details", { exact: true }).click();
    await expect(wizard.getByText(/native-helper-v0.1.0/)).toBeVisible();
    await expect(
      wizard.getByRole("button", { name: "Find sessions", exact: true }),
    ).toBeDisabled();
    expect(
      requests.some((url) =>
        /\/api\/(discover|read|read-set|analysis\/start)$/.test(url),
      ),
    ).toBe(false);
  });
});

test("explicit custom/profile roots retain stable identity; refresh and edits discard stale sessions", async ({
  page,
}) => {
  await withWizard(page, async ({ wizard, runtime, directory, requests }) => {
    await page.route("**/api/status", async (route) => {
      const status = await (await route.fetch()).json();
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
    const opened = [];
    let state = "ready";
    const selection = {
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
          relativePath: "profiles/example/globalStorage/agent-host.db",
        },
      ],
    };
    await page.route("**/api/read-set", async (route) => {
      opened.push(route.request().postDataJSON());
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: "SOURCE_CHANGED",
            message: "Synthetic retained history changed. Find sessions again.",
          },
        },
      });
    });
    await page.route("**/api/discover", async (route) => {
      selections.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          id: "fictional-discovery",
          startedAtMs: 1,
          finishedAtMs: 2,
          issues:
            state === "empty"
              ? [
                  {
                    sourceId: "source-1",
                    relativePath: "missing",
                    code: "SOURCE_MISSING",
                    message: "Synthetic selected history is missing.",
                  },
                ]
              : [],
          observations: [],
          locators: [],
          sessions:
            state === "empty"
              ? []
              : [
                  {
                    id: "fictional-chat",
                    sdkSessionId: "fictional-native-id",
                    runtime: "copilot-agent-host",
                    mode: null,
                    executionLocation: "unknown",
                    archived: false,
                    state,
                    reason:
                      state === "ready"
                        ? "Fictional matching identities."
                        : "Missing or ambiguous synthetic history.",
                    references: [],
                    selection: state === "ready" ? selection : null,
                  },
                ],
        },
      });
    });
    await page.goto("about:blank");
    await page.goto(runtime.launchUrl);
    await choose(wizard, /^Copilot Choose/);
    await choose(wizard, /^Agent Host/);
    await wizard
      .getByText("Folder guidance and custom selection", { exact: true })
      .click();
    await wizard
      .getByLabel("File or folder inside this directory")
      .fill("profiles/example/globalStorage/agent-host.db");
    await wizard.getByRole("checkbox").check();
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await wizard
      .getByRole("button", { name: "Add saved session folder" })
      .click();
    await choose(wizard, /^VS Code saved session details/);
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await wizard
      .getByRole("button", { name: "Add saved session folder" })
      .click();
    await choose(wizard, /^Copilot saved session history/);
    await wizard
      .getByText("Folder guidance and custom selection", { exact: true })
      .click();
    await wizard
      .getByLabel("File or folder inside this directory")
      .fill("native");
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await wizard
      .getByRole("button", { name: /^Remove.*VS Code saved session details/ })
      .click();
    await expect(
      wizard
        .locator(".wizard-searches code")
        .filter({ hasText: / \/ native$/ }),
    ).toBeVisible();
    await wizard.getByRole("checkbox").check();
    await wizard.getByRole("button", { name: "Continue", exact: true }).click();
    expect(selections).toHaveLength(0);
    await wizard
      .getByRole("button", { name: "Find sessions", exact: true })
      .click();
    await expect(
      wizard.getByRole("radio", { name: /^fictional-native-id/ }),
    ).toBeVisible();
    expect(selections[0]).toEqual({
      roots: [
        {
          sourceId: "source-1",
          relativePath: "profiles/example/globalStorage/agent-host.db",
          layout: "catalog",
        },
        { sourceId: "source-1", relativePath: "native", layout: "history" },
      ],
    });
    await expect(
      wizard.getByRole("button", { name: "Open report" }),
    ).toBeDisabled();
    await wizard.getByRole("radio", { name: /^fictional-native-id/ }).check();
    expect(opened).toHaveLength(0);
    await wizard.getByRole("button", { name: "Open report" }).click();
    await expect(
      page.getByText(/Synthetic retained history changed/).first(),
    ).toBeVisible();
    expect(opened).toEqual([selection]);
    for (state of ["ambiguous", "unavailable", "empty"]) {
      await wizard.getByRole("button", { name: "Find sessions again" }).click();
      await expect(
        wizard.getByRole("button", { name: "Open report" }),
      ).toBeDisabled();
      if (state !== "empty")
        await expect(wizard.getByRole("radio")).toBeDisabled();
      else
        await expect(wizard.getByRole("status").last()).toContainText(
          "No qualified retained sessions",
        );
    }
    await wizard.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      wizard.getByRole("button", { name: "Find sessions", exact: true }),
    ).toBeEnabled();
    await wizard.getByRole("button", { name: "Back", exact: true }).click();
    await wizard
      .getByRole("button", { name: new RegExp(`^Edit.*${directory} native`) })
      .click();
    await wizard
      .getByText("Folder guidance and custom selection", { exact: true })
      .click();
    await wizard
      .getByLabel("File or folder inside this directory")
      .fill("changed");
    await wizard.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      wizard.getByRole("button", { name: "Continue", exact: true }),
    ).toBeDisabled();
    await wizard.getByRole("button", { name: "Start over" }).click();
    await reviewHost(wizard);
    expect(
      requests.every((url) =>
        url.startsWith(new URL(runtime.launchUrl).origin + "/"),
      ),
    ).toBe(true);
    expect(requests.some((url) => url.endsWith("/api/analysis/start"))).toBe(
      false,
    );
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
  });
});

test("Local recording needs an explicit filename/read/open and preserves large-file tool selection", async ({
  page,
}) => {
  await withWizard(page, async ({ wizard, requests }) => {
    await choose(wizard, /^Copilot Choose/);
    await choose(wizard, /^Local/);
    await choose(wizard, /^Help me record/);
    await expect(
      wizard.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    await wizard.getByRole("checkbox").check();
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await wizard
      .getByText("Show Local recording settings", { exact: true })
      .click();
    await expect(wizard.locator("pre")).toContainText(
      '"github.copilot.chat.otel.captureContent": false',
    );
    await expect(
      wizard.getByText(/verify effective User, profile, Workspace/),
    ).toBeVisible();
    await expect(
      wizard.getByText(/Confirm content capture is off and output goes/),
    ).toBeVisible();
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await wizard.getByRole("button", { name: "Back to file choice" }).click();
    await expect(wizard.getByRole("combobox")).toHaveCount(0);
    await expect(
      wizard.getByRole("button", { name: "Find sessions", exact: true }),
    ).toBeDisabled();
    await wizard
      .getByLabel("Recording filename inside this folder")
      .fill("synthetic.jsonl");
    expect(requests.some((url) => url.endsWith("/api/read"))).toBe(false);
    await page.route("**/api/read", (route) =>
      route.fulfill({
        status: 413,
        json: {
          error: {
            code: "SOURCE_TOO_LARGE",
            message: "Synthetic oversized recording: use the bounded scan.",
          },
        },
      }),
    );
    await wizard
      .getByRole("button", { name: "Find sessions", exact: true })
      .click();
    await expect(wizard.getByRole("alert")).toContainText("bounded scan");
    await wizard
      .getByRole("button", { name: "Large recordings and file tools" })
      .click();
    await expect(page.getByLabel("File inside this directory")).toHaveValue(
      "synthetic.jsonl",
    );
    await expect(page.getByLabel("Reader format")).toHaveValue(
      "vscode-otel-jsonl",
    );
    await expect(
      page.getByRole("region", { name: "Bounded JSONL scan" }),
    ).toBeVisible();
    await page.unroute("**/api/read");
    await wizard
      .getByRole("button", { name: "Find sessions", exact: true })
      .click();
    await expect(
      wizard.getByRole("radio", { name: /^native-session/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Session report", exact: true }),
    ).toHaveCount(0);
    await page
      .getByText("Analysis availability and privacy", { exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Analysis", exact: true })
      .selectOption("synthetic");
    const consent = page.getByRole("checkbox", {
      name: /I understand that selected content/,
    });
    await consent.check();
    await wizard.getByRole("radio", { name: /^second-native/ }).check();
    await wizard.getByRole("button", { name: "Open report" }).click();
    await expect(
      page.getByRole("region", { name: "Session report", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Report session (from source read)"),
    ).toHaveValue("second-session");
    await expect(
      page.getByRole("heading", { name: "Session report", exact: true }),
    ).toBeFocused();
    await expect(consent).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Analyze", exact: true }),
    ).toBeDisabled();
    await consent.check();
    await expect(
      page.getByRole("button", { name: "Analyze", exact: true }),
    ).toBeEnabled();
    await expect(wizard).toHaveCount(0);
    expect(requests.some((url) => url.endsWith("/api/analysis/start"))).toBe(
      false,
    );
    await page.getByRole("button", { name: "Find another session" }).click();
    await expect(
      wizard.getByRole("heading", {
        name: "Which coding assistant did you use?",
      }),
    ).toBeVisible();
    await expect(
      wizard.getByRole("heading", {
        name: "Which coding assistant did you use?",
      }),
    ).toBeFocused();
  });
});

test("sibling reads and scans invalidate a cached Local selection even when the new read fails", async ({
  page,
}) => {
  for (const sibling of ["manual", "scan"]) {
    await withWizard(page, async ({ wizard }) => {
      await choose(wizard, /^Copilot Choose/);
      await choose(wizard, /^Local/);
      await choose(wizard, /^I have a recorded/);
      await wizard
        .getByLabel("Recording filename inside this folder")
        .fill("synthetic.jsonl");
      await wizard
        .getByRole("button", { name: "Find sessions", exact: true })
        .click();
      await wizard.getByRole("radio", { name: /^second-native/ }).check();
      await expect(
        wizard.getByRole("button", { name: "Open report" }),
      ).toBeEnabled();
      await page
        .getByText("Advanced file tools and configured access", { exact: true })
        .click();
      await page
        .getByLabel("File inside this directory")
        .fill(sibling === "manual" ? "missing.jsonl" : "synthetic.jsonl");
      if (sibling === "manual") {
        await page
          .getByRole("button", { name: "Read source", exact: true })
          .click();
        await expect(page.getByRole("alert").first()).toBeVisible();
      } else {
        await page
          .getByRole("button", { name: "Scan JSONL source", exact: true })
          .click();
      }
      await expect(
        wizard.getByRole("button", { name: "Open report" }),
      ).toHaveCount(0);
      await expect(
        wizard.getByRole("heading", {
          name: "Which coding assistant did you use?",
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Session report", exact: true }),
      ).toHaveCount(0);
    });
  }
});

test("multiple grants are readable choices; unavailable paths stay visible and source changes reset contained paths", async ({
  page,
}) => {
  await withWizard(
    page,
    async ({ wizard, runtime }) => {
      await page.route("**/api/status", async (route) => {
        const status = await (await route.fetch()).json();
        await route.fulfill({
          json: {
            ...status,
            sources: status.sources.map((source, index) =>
              index === 1
                ? {
                    ...source,
                    available: false,
                    reason: "Synthetic access denied.",
                  }
                : source,
            ),
          },
        });
      });
      await page.goto("about:blank");
      await page.goto(runtime.launchUrl);
      await choose(wizard, /^Copilot Choose/);
      await choose(wizard, /^Agent Host/);
      await wizard
        .getByText("Folder guidance and custom selection", { exact: true })
        .click();
      await wizard
        .getByLabel("File or folder inside this directory")
        .fill("custom");
      const sources = wizard.getByRole("combobox");
      await expect(sources.locator("option")).not.toContainText([
        "source-1",
        "source-2",
      ]);
      await sources.selectOption("source-2");
      await expect(wizard.getByRole("alert")).toContainText(
        "Synthetic access denied.",
      );
      await expect(
        wizard.getByRole("button", { name: "Next", exact: true }),
      ).toBeDisabled();
      await sources.selectOption("source-1");
      await expect(
        wizard.getByLabel("File or folder inside this directory"),
      ).toHaveValue("");
      await wizard.getByRole("button", { name: "Back", exact: true }).click();
      await choose(wizard, /^Local/);
      await choose(wizard, /^I have a recorded/);
      await expect(
        wizard.getByLabel("Recording filename inside this folder"),
      ).toHaveValue("");
    },
    true,
  );
});

test("short and highly zoomed viewports keep wizard header and footer visible without a hard minimum height", async ({
  page,
}) => {
  await withWizard(page, async ({ wizard }) => {
    for (const viewport of [
      { width: 1200, height: 480 },
      { width: 320, height: 225 },
    ]) {
      await page.setViewportSize(viewport);
      await wizard.getByRole("button", { name: "Start over" }).click();
      await choose(wizard, /^Copilot Choose/);
      const header = wizard.locator(".wizard-header");
      const footer = wizard.locator(".wizard-footer");
      const headerBounds = await header.boundingBox();
      const footerBounds = await footer.boundingBox();
      expect(headerBounds.y).toBeGreaterThanOrEqual(0);
      expect(footerBounds.y + footerBounds.height).toBeLessThanOrEqual(
        viewport.height,
      );
      await expect(
        wizard.getByRole("button", { name: "Back", exact: true }),
      ).toBeInViewport();
      await expect(
        wizard.getByRole("button", { name: "Next", exact: true }),
      ).toBeInViewport();
      const body = wizard.locator(".wizard-body");
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(await footer.boundingBox()).toEqual(footerBounds);
      expect(await header.boundingBox()).toEqual(headerBounds);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await choose(wizard, /^Local/);
    await choose(wizard, /^I have a recorded/);
    await wizard
      .getByLabel("Recording filename inside this folder")
      .fill("synthetic.jsonl");
    await wizard
      .getByRole("button", { name: "Large recordings and file tools" })
      .click();
    await expect(
      page.getByText("Advanced file tools and configured access", {
        exact: true,
      }),
    ).toBeFocused();
    await expect(
      page.getByRole("region", { name: "Bounded JSONL scan" }),
    ).toBeVisible();
  });
});

test("normal steps fit desktop and mobile; expanded details scroll inside a stationary navigation footer", async ({
  page,
}) => {
  await withWizard(page, async ({ wizard }) => {
    for (const viewport of [
      { width: 1200, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await wizard.getByRole("button", { name: "Start over" }).click();
      await choose(wizard, /^Copilot Choose/);
      const body = wizard.locator(".wizard-body");
      const dimensions = await body.evaluate((element) => ({
        content: element.scrollHeight,
        body: element.clientHeight,
      }));
      expect(
        dimensions.content,
        `${viewport.width}px step height`,
      ).toBeLessThanOrEqual(dimensions.body + 1);
      await choose(wizard, /^Agent Host/);
      await wizard
        .getByText("Folder guidance and custom selection", { exact: true })
        .click();
      const footer = wizard.locator(".wizard-footer");
      const before = await footer.boundingBox();
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(await footer.boundingBox()).toEqual(before);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        wizard.getByRole("button", { name: "Next", exact: true }),
      ).toBeInViewport();
    }
  });
});
