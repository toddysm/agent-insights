/** Exercise the real offline HTML in three browser engines; failures retain synthetic-only traces. */
const { test, expect } = require("@playwright/test");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");
const entry = pathToFileURL(resolve(__dirname, "..", "index.html")).href;
const pageErrors = new WeakMap();
const remoteRequests = new WeakMap();

/** Open a local deep link without a server or any test-only application hooks. */
async function open(page, hash = "report") {
  await page.goto(`${entry}#${hash}`);
  await expect(page.locator("#main h1")).toBeVisible();
}

/** Load scenarios through the same control used by reviewers; edits reset explicitly. */
async function scenario(page, name) {
  await page.locator("#scenario").selectOption(name);
}

test.beforeEach(async ({ page }) => {
  pageErrors.set(page, []);
  remoteRequests.set(page, []);
  page.on("pageerror", (error) => pageErrors.get(page).push(error.message));
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url()))
      remoteRequests.get(page).push(request.url());
  });
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "No browser runtime errors").toEqual([]);
  expect(
    remoteRequests.get(page),
    "No remote requests, fonts, analytics or model calls",
  ).toEqual([]);
});

test("uses only the project name in the page title and brand link", async ({
  page,
}) => {
  await open(page);
  await expect(page).toHaveTitle("Agent Insights");
  await expect(page.locator(".brand")).toHaveAccessibleName("agent insights");
});

test("S2 opens directly from disk and shows reconciled report totals", async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByRole("heading", { name: "Reporting improvements", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("#metric-steering-session .metric-value"),
  ).toHaveText("4");
  await expect(
    page.locator("#metric-artifacts-session .metric-value"),
  ).toHaveText("6");
  await expect(page.locator("#metric-tools-session .metric-value")).toHaveText(
    "27",
  );
  await expect(page.locator("#metric-tokens-session .metric-value")).toHaveText(
    "12.4k / 1.8k",
  );
  await expect(page.locator(".table-wrap tbody tr")).toHaveCount(3);
  await expect(
    page.getByText("Human typing: unavailable", { exact: true }),
  ).toBeVisible();
});

test("S1 supports explicit synthetic import, search and unsupported-format recovery", async ({
  page,
}) => {
  await open(page);
  await scenario(page, "empty");
  await expect(
    page.getByRole("heading", { name: "A report starts with evidence." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import a synthetic example", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Try unsupported-format error" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Unsupported example format" }),
  ).toBeVisible();
  await expect(page.locator("#detail [role=alert]")).toContainText(
    "No successful session totals",
  );
  await page.getByRole("button", { name: "Choose another example" }).click();
  await page
    .getByRole("button", { name: "Load content + traces example" })
    .click();
  await expect(page.locator("#detail")).not.toBeVisible();
  await page
    .getByRole("navigation", { name: "Main", exact: true })
    .getByRole("link", { name: "Sessions", exact: true })
    .click();
  await page
    .getByRole("searchbox", { name: "Search sessions" })
    .fill("no matching session");
  await expect(page.locator("#search-empty")).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search sessions" })
    .fill("reporting");
  await expect(page.locator("tr[data-search]:visible")).toHaveCount(1);
});

test("S3 follows a count to context, preserves scope, and recalculates a correction", async ({
  page,
}) => {
  await open(page);
  await page.locator("#metric-steering-session").click();
  await expect(
    page.getByRole("heading", { name: "4 steering messages" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Export the filtered rows, not all rows/ })
    .click();
  await expect(page.locator("#detail")).toContainText(
    "Count contribution: 1 steering message",
  );
  await expect(page.locator("#detail")).toContainText(
    "The agent describes exporting every row",
  );
  await page.getByRole("button", { name: "Back to contributors" }).click();
  await expect(
    page.getByRole("heading", { name: "4 steering messages" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Export the filtered rows, not all rows/ })
    .click();
  await page
    .getByLabel("Interpretation category")
    .selectOption("New requirement");
  await page.getByRole("button", { name: "Save classification" }).click();
  await expect(page.locator("#detail")).not.toBeVisible();
  await expect(
    page.locator("#metric-steering-session .metric-value"),
  ).toHaveText("3");
  await page.getByRole("link", { name: "Add CSV export", exact: true }).click();
  await expect(page.locator("#metric-steering-t1 .metric-value")).toHaveText(
    "1",
  );
  await page.locator("#metric-tools-t1").click();
  await expect(
    page.getByRole("heading", { name: "14 recorded tool calls" }),
  ).toBeVisible();
});

test("S4 filters helpers, inspects their lifecycle, and updates a purpose label", async ({
  page,
}) => {
  await open(page);
  await scenario(page, "artifacts");
  await page
    .getByLabel("Purpose", { exact: true })
    .selectOption("Temporary helper");
  await expect(page.locator(".table-wrap tbody tr")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Inspect temp/make-fixtures.py" })
    .click();
  await expect(page.locator("#detail")).toContainText("Deleted");
  await page.getByLabel("Artifact purpose").selectOption("Unknown");
  await page.getByRole("button", { name: "Save purpose" }).click();
  await expect(page.locator(".table-wrap tbody tr")).toHaveCount(1);
  await page.getByLabel("Purpose", { exact: true }).selectOption("All");
  await expect(page.locator(".table-wrap tbody tr")).toHaveCount(6);
  await page
    .getByRole("button", { name: "Inspect tests/export.test.ts" })
    .click();
  await expect(page.locator("#detail")).toContainText(
    "Add CSV export; Fix date filtering",
  );
});

test("S5 request evidence returns to the same scope and timing exposes overlap", async ({
  page,
}) => {
  await open(page);
  await page.locator("#metric-tokens-session").click();
  await expect(page.locator("#detail tbody tr")).toHaveCount(12);
  await expect(page.locator("#detail")).toContainText("Input: 12,400");
  await page
    .locator("#detail")
    .getByRole("button", { name: "Inspect", exact: true })
    .first()
    .click();
  await expect(page.locator("#detail pre")).toContainText(
    '"inputTokens": 1200',
  );
  await page.getByRole("button", { name: "Back to request ledger" }).click();
  await expect(page.locator("#detail tbody tr")).toHaveCount(12);
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.getByRole("button", { name: "Inspect time", exact: true }).click();
  await expect(page.locator("#detail")).toContainText(
    "18m interval-union activity",
  );
  await expect(page.locator("#detail")).toContainText("20m cumulative spans");
  await expect(page.locator("#detail")).toContainText(
    "Human typing: unavailable",
  );
});

test("S6 distinguishes canned ratings, inherited context and suggested rewrites", async ({
  page,
}) => {
  await open(page);
  await scenario(page, "prompts");
  await expect(
    page.getByRole("heading", { name: "A better next instruction" }),
  ).toBeVisible();
  await expect(page.locator("#rewrite")).toHaveValue(
    /currently filtered table rows/,
  );
  await page.getByText("What context was available?", { exact: true }).click();
  await expect(
    page.getByText(/Assessment uses submission-time context/),
  ).toBeVisible();
  await expect(page.getByText(/These are canned ratings/)).toBeVisible();
  await page.getByRole("button", { name: "Later clarification / U08" }).click();
  await expect(page.locator("#detail")).toContainText(
    "Export the filtered rows",
  );
});

test("S7 merges tasks without changing recorded totals and resets all edits", async ({
  page,
}) => {
  await open(page);
  await scenario(page, "review");
  await page
    .getByRole("checkbox", { name: "Select Add CSV export", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Select Fix date filtering", exact: true })
    .check();
  await page.getByRole("button", { name: "Merge selected" }).click();
  await expect(page.locator("#detail")).toContainText("Active tasks: 3 to 2");
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Reporting behavior");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(page.locator(".table-wrap tbody tr")).toHaveCount(2);
  await page.getByRole("link", { name: "Back to report", exact: true }).click();
  await expect(page.locator("#metric-tools-session .metric-value")).toHaveText(
    "27",
  );
  await expect(page.locator("#metric-tokens-session .metric-value")).toHaveText(
    "12.4k / 1.8k",
  );
  await expect(
    page.getByRole("link", { name: "Reporting behavior", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset all demo changes" }).click();
  await expect(page.locator(".table-wrap tbody tr")).toHaveCount(3);
});

test("S7 supports splits, segment edits, exclusion and safe text rendering", async ({
  page,
}) => {
  await open(page, "review");
  await page
    .getByRole("checkbox", { name: "Select Add CSV export", exact: true })
    .check();
  await page.getByRole("button", { name: "Split selected" }).click();
  await page
    .getByLabel("Task title", { exact: true })
    .fill("<img src=x onerror=alert(1)>");
  await page.getByLabel("New task starts at turn").fill("9");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(page.locator(".table-wrap tbody tr")).toHaveCount(4);
  await expect(page.locator("main img")).toHaveCount(0);
  await expect(
    page.getByText("<img src=x onerror=alert(1)>", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Select Add CSV export", exact: true })
    .check();
  await page.getByRole("button", { name: "Adjust segments" }).click();
  await page.getByLabel("First turn", { exact: true }).fill("3");
  await page.getByLabel("Last turn, inclusive").fill("7");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(page.locator(".table-wrap tbody tr").first()).toContainText(
    "U3-U7",
  );
  await page
    .locator(".table-wrap tbody tr")
    .first()
    .getByRole("button", { name: "Exclude", exact: true })
    .click();
  await expect(page.locator("#detail")).toContainText(
    "recorded evidence remains in session totals",
  );
  await page.getByRole("button", { name: "Save corrections" }).click();
  await page
    .locator(".table-wrap tbody tr")
    .first()
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect(page.locator(".table-wrap tbody tr").first()).not.toContainText(
    "excluded; evidence retained",
  );
});

test("S8 missing content and usage remain unavailable rather than becoming zero", async ({
  page,
}) => {
  await open(page);
  await scenario(page, "partial");
  await expect(page.locator("#metric-tokens-session .metric-value")).toHaveText(
    "Unavailable",
  );
  await expect(
    page.locator("#metric-steering-session .metric-value"),
  ).toHaveText("Unavailable");
  await expect(page.locator("#metric-tools-session .metric-value")).toHaveText(
    "27",
  );
  await page.locator("#metric-tokens-session").click();
  await expect(page.locator("#detail")).toContainText(
    "3 of 12 model calls lack usage",
  );
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.getByRole("link", { name: "Explore prompt coaching" }).click();
  await expect(
    page.getByRole("heading", { name: "Message content was not captured." }),
  ).toBeVisible();
});

test("S8 analysis is optional, explicit and simulated", async ({ page }) => {
  await open(page);
  await scenario(page, "analysis-off");
  await expect(
    page.getByRole("heading", { name: "Tasks have not been analyzed." }),
  ).toBeVisible();
  await expect(page.locator("#metric-tokens-session .metric-value")).toHaveText(
    "12.4k / 1.8k",
  );
  await page
    .getByRole("button", { name: "Analysis setup", exact: true })
    .click();
  await expect(page.locator("#detail")).toContainText(
    "No API key, model connection, or external transmission",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Tasks have not been analyzed." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Analysis setup", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: /Show canned example interpretations/ })
    .check();
  await page.getByRole("button", { name: "Show simulated analysis" }).click();
  await expect(page.locator(".table-wrap tbody tr")).toHaveCount(3);
});

test("keyboard close restores focus and deep links preserve the task scope", async ({
  page,
}) => {
  await open(page);
  const trigger = page.locator("#metric-steering-session");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#detail")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#detail")).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await open(page, "task/t1?panel=steering&task=t1");
  await expect(
    page.getByRole("heading", { name: "2 steering messages" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(
    page.getByRole("heading", { name: "Add CSV export", exact: true }),
  ).toBeVisible();
});

test("invalid evidence links explain the failure instead of showing the wrong record", async ({
  page,
}) => {
  await open(page, "report?panel=tool&id=missing");
  await expect(
    page.getByRole("heading", { name: "This detail is unavailable" }),
  ).toBeVisible();
  await expect(page.locator("#detail [role=alert]")).toContainText(
    "does not exist",
  );
  await page
    .getByRole("button", { name: "Return to the report", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reporting improvements", exact: true }),
  ).toBeVisible();
});

test("deep links cannot bypass missing capture or unavailable task attribution", async ({
  page,
}) => {
  await open(page);
  await scenario(page, "empty");
  await page.evaluate(() => {
    location.hash = "report?panel=tokens";
  });
  await expect(
    page.getByRole("heading", { name: "No session imported" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close detail" }).click();
  await scenario(page, "analysis-off");
  await page.locator("#metric-tools-session").click();
  await expect(page.locator("#detail")).toContainText("Not analyzed");
  await expect(page.locator("#detail")).not.toContainText("Add CSV export");
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.evaluate(() => {
    location.hash = "report?panel=tokens&task=t1";
  });
  await expect(
    page.getByRole("heading", { name: "Task attribution is not analyzed" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close detail" }).click();
  await page
    .getByRole("navigation", { name: "Main", exact: true })
    .getByRole("link", { name: "Sessions", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Open transcript-only demonstration",
      exact: true,
    })
    .click();
  await page.evaluate(() => {
    location.hash = "report?panel=request&id=m1";
  });
  await expect(
    page.getByRole("heading", { name: "Usage record unavailable" }),
  ).toBeVisible();
});

test("outcome corrections update the summary without inventing remaining work", async ({
  page,
}) => {
  await open(page, "review");
  await page
    .locator(".table-wrap tbody tr")
    .last()
    .getByRole("button", { name: "Outcome", exact: true })
    .click();
  await page.getByLabel("Outcome", { exact: true }).selectOption("Completed");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await page.getByRole("link", { name: "Back to report", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /All active outcomes are complete/ }),
  ).toBeVisible();
});

test("correction previews reject disjoint merges and overlapping ranges", async ({
  page,
}) => {
  await open(page, "review");
  await page
    .getByRole("checkbox", { name: "Select Add CSV export", exact: true })
    .check();
  await page
    .getByRole("checkbox", {
      name: "Select Document the workflow",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Merge selected" }).click();
  await expect(page.locator("#announcement")).toContainText(
    "only adjacent task ranges",
  );
  await expect(page.locator("#detail")).not.toBeVisible();
  await page
    .getByRole("checkbox", {
      name: "Select Document the workflow",
      exact: true,
    })
    .uncheck();
  await page.getByRole("button", { name: "Adjust segments" }).click();
  await page.getByLabel("Last turn, inclusive").fill("20");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(page.locator("#detail [role=alert]")).toContainText(
    'overlaps "Fix date filtering"',
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".table-wrap tbody tr").nth(1)).toContainText(
    "U15-U22",
  );
  await expect(page.locator(".table-wrap tbody tr").nth(1)).toContainText(
    "Completed",
  );
  await expect(page.locator(".table-wrap tbody tr").nth(1)).toContainText(
    "User-confirmed",
  );
});

test("accessible metric names include values and missing-data status", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator("#metric-steering-session")).toHaveAccessibleName(
    /Inspect Human steering: 4.*inferred categories/,
  );
  await expect(page.locator("#row-steering-t1")).toHaveAccessibleName(
    /Add CSV export: 2/,
  );
  await scenario(page, "partial");
  await expect(page.locator("#metric-tokens-session")).toHaveAccessibleName(
    /Model tokens: Unavailable.*recorded usage/,
  );
  await expect(page.locator("#metric-steering-session")).toHaveAccessibleName(
    /Human steering: Unavailable.*Not analyzed/,
  );
});

test("original instruction drawers keep session and task source anchors after edits", async ({
  page,
}) => {
  await open(page, "review");
  await page
    .getByRole("checkbox", { name: "Select Add CSV export", exact: true })
    .check();
  await page.getByRole("button", { name: "Split selected" }).click();
  await page.getByLabel("Task title", { exact: true }).fill("Later CSV work");
  await page.getByLabel("New task starts at turn").fill("9");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await page.getByRole("link", { name: "Back to report", exact: true }).click();
  await page.getByRole("link", { name: "Later CSV work", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Inspect originating instruction and interpretation",
    })
    .click();
  await expect(page.locator("#detail .source-instruction")).toHaveCount(1);
  await expect(page.locator("#detail .source-instruction")).toContainText(
    "Human / U01",
  );
  await expect(page.locator("#detail .source-instruction")).not.toContainText(
    "Human / U09",
  );
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.getByRole("button", { name: "Reset all demo changes" }).click();
  await scenario(page, "review");
  await page
    .getByRole("checkbox", { name: "Select Add CSV export", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Select Fix date filtering", exact: true })
    .check();
  await page.getByRole("button", { name: "Merge selected" }).click();
  await page.getByLabel("Task title", { exact: true }).fill("Reporting work");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await page.getByRole("link", { name: "Back to report", exact: true }).click();
  await page.getByRole("link", { name: "Reporting work", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Inspect originating instruction and interpretation",
    })
    .click();
  await expect(page.locator("#detail .source-instruction")).toHaveCount(2);
  await expect(
    page.locator("#detail .source-instruction").nth(0),
  ).toContainText("Human / U01");
  await expect(
    page.locator("#detail .source-instruction").nth(1),
  ).toContainText("Human / U15");
  await page.getByRole("button", { name: "Close detail" }).click();
  await page
    .getByRole("navigation", { name: "Main", exact: true })
    .getByRole("link", { name: "Prompt coaching", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Original session instruction", exact: true })
    .click();
  await expect(page.locator("#detail")).toContainText(
    "Help me improve reporting in this app.",
  );
  await expect(page.locator("#detail .source-instruction")).toHaveCount(1);
  await expect(page.locator("#detail .source-instruction")).not.toContainText(
    "Add CSV export",
  );
});

test("invalid base routes recover without stale report content or a blocking drawer", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    location.hash = "task/missing";
  });
  await expect(
    page.getByRole("heading", { name: "This view is unavailable." }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Return to report", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reporting improvements", exact: true }),
  ).toBeVisible();
  await page.locator("#metric-steering-session").click();
  await page.evaluate(() => {
    location.hash = "task/missing?panel=tools";
  });
  await expect(page.locator("#detail")).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "This view is unavailable." }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Return to report", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reporting improvements", exact: true }),
  ).toBeVisible();
});

test("the keyboard skip link focuses the current main view without routing to an error", async ({
  page,
}) => {
  await open(page);
  const skip = page.getByRole("link", { name: "Skip to report", exact: true });
  await skip.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  await expect(page).toHaveURL(/#report$/);
  await expect(
    page.getByRole("heading", { name: "Reporting improvements", exact: true }),
  ).toBeVisible();
});

test("desktop report and evidence drawer screenshots", async ({
  page,
}, testInfo) => {
  await open(page);
  await page.screenshot({
    path: testInfo.outputPath("report-desktop.png"),
    fullPage: true,
  });
  await page.locator("#metric-steering-session").click();
  await page
    .getByRole("button", { name: /Export the filtered rows, not all rows/ })
    .click();
  await page.screenshot({
    path: testInfo.outputPath("evidence-desktop.png"),
    fullPage: true,
  });
});

test("narrow viewport keeps navigation and full-screen detail usable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("report-mobile.png"),
    fullPage: true,
  });
  await page.locator("#metric-steering-session").click();
  await expect(
    page.getByRole("heading", { name: "4 steering messages" }),
  ).toBeVisible();
  const box = await page.locator("#detail").boundingBox();
  expect(Math.round(box.width)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(page.locator("#detail")).not.toBeVisible();
});
