/** Exercise revision-2 scenarios in the real offline HTML; traces contain synthetic evidence only. */
const { test, expect } = require("@playwright/test");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");
const entry = pathToFileURL(resolve(__dirname, "..", "index.html")).href;
const pageErrors = new WeakMap();
const remoteRequests = new WeakMap();

/** Open a local route without a server or test-only application hooks. */
async function open(page, hash = "report") {
  await page.goto(`${entry}#${hash}`);
  await expect(page.locator("#main h1")).toBeVisible();
}

/** Replace the synthetic source through the reviewer-facing scenario selector. */
async function scenario(page, name) {
  await page.locator("#scenario").selectOption(name);
}

/** Start an explicitly acknowledged simulation, leaving completion to the reviewer controls. */
async function startAnalysis(page) {
  await page.getByRole("button", { name: "Analysis setup", exact: true }).click();
  await page.getByRole("checkbox", { name: /I reviewed the scope/ }).check();
  await page.getByRole("button", { name: "Start simulated analysis" }).click();
  await expect(page.getByRole("heading", { name: "Analysis running / simulation" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  pageErrors.set(page, []);
  remoteRequests.set(page, []);
  page.on("pageerror", (error) => pageErrors.get(page).push(error.message));
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url())) remoteRequests.get(page).push(request.url());
  });
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "No browser runtime errors").toEqual([]);
  expect(remoteRequests.get(page), "No remote requests, fonts, telemetry or model calls").toEqual([]);
});

test("S2 read-only report uses only the project name and reconciles totals", async ({ page }) => {
  await open(page);
  await expect(page).toHaveTitle("Agent Insights");
  await expect(page.locator(".brand")).toHaveAccessibleName("agent insights");
  for (const [key, value] of Object.entries({ steering: "4", artifacts: "6", tools: "27", tokens: "12.4k / 1.8k" })) {
    await expect(page.locator(`#metric-${key}-session .metric-value`)).toHaveText(value);
  }
  await expect(page.locator("#main tbody tr")).toHaveCount(3);
  await expect(page.getByText("Human typing: unavailable", { exact: true })).toBeVisible();
  await expect(page.locator("#main")).toContainText("Source acceptance");
  await expect(page.locator("#main")).toContainText("source read 1:");
});

test("S1 explicitly opens a source and recovers from unsupported formats without fabricated totals", async ({ page }) => {
  await open(page);
  await scenario(page, "empty");
  await page.getByRole("button", { name: "Open a synthetic example", exact: true }).click();
  await page.getByRole("button", { name: "Try unsupported-format error" }).click();
  await expect(page.locator("#detail [role=alert]")).toContainText("No successful session totals");
  await page.getByRole("button", { name: "Choose another example" }).click();
  await page.getByRole("button", { name: "Load content + traces example" }).click();
  await expect(page.locator("#detail")).not.toBeVisible();
  await page.locator("[data-nav=sessions]").click();
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("no matching session");
  await expect(page.locator("#search-empty")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("reporting");
  await expect(page.locator("tr[data-search]:visible")).toHaveCount(1);
});

test("S3 follows distinct-message counts to original context and read-only rationale", async ({ page }) => {
  await open(page);
  await page.locator("#metric-steering-session").click();
  await expect(page.getByRole("heading", { name: "4 steering messages" })).toBeVisible();
  await page.getByRole("button", { name: /Export the filtered rows, not all rows/ }).click();
  await expect(page.locator("#detail")).toContainText("Count contribution: 1 steering message");
  await expect(page.locator("#detail")).toContainText("The agent describes exporting every row");
  await page.getByText("Why this category?", { exact: true }).click();
  await expect(page.locator("#detail")).toContainText("two tags still describe one message");
  await expect(page.locator("#detail select, #detail form")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to contributors" }).click();
  await expect(page.getByRole("heading", { name: "4 steering messages" })).toBeVisible();
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.getByRole("link", { name: "Add CSV export", exact: true }).click();
  await page.locator("#metric-steering-t1").click();
  await expect(page.getByRole("heading", { name: "2 steering messages" })).toBeVisible();
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.locator("#metric-tools-t1").click();
  await expect(page.getByRole("heading", { name: "14 recorded tool calls" })).toBeVisible();
});

test("S4 filters helpers without changing labels or shared-identity counts", async ({ page }) => {
  await open(page);
  await scenario(page, "artifacts");
  await page.getByLabel("Purpose", { exact: true }).selectOption("Temporary helper");
  await expect(page.locator("#main tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Inspect temp/make-fixtures.py" }).click();
  await expect(page.locator("#detail")).toContainText("Deleted");
  await page.getByText("Inspect purpose rationale", { exact: true }).click();
  await expect(page.locator("#detail")).toContainText("not file extension");
  await expect(page.locator("#detail select, #detail form")).toHaveCount(0);
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(page.getByLabel("Purpose", { exact: true })).toHaveValue("Temporary helper");
  await expect(page.locator("#main tbody tr")).toHaveCount(2);
  await page.getByLabel("Purpose", { exact: true }).selectOption("All");
  await expect(page.locator("#main tbody tr")).toHaveCount(6);
  await page.getByRole("button", { name: "Inspect tests/export.test.ts" }).click();
  await expect(page.locator("#detail")).toContainText("Add CSV export; Fix date filtering");
});

test("S5 request evidence returns to the same scope and timing exposes overlap", async ({ page }) => {
  await open(page);
  await page.locator("#metric-tokens-session").click();
  await expect(page.locator("#detail tbody tr")).toHaveCount(12);
  await expect(page.locator("#detail")).toContainText("Input: 12,400");
  await page.locator("#detail").getByRole("button", { name: "Inspect", exact: true }).first().click();
  await expect(page.locator("#detail pre")).toContainText('"inputTokens": 1200');
  await page.getByRole("button", { name: "Back to request ledger" }).click();
  await expect(page.locator("#detail tbody tr")).toHaveCount(12);
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.getByRole("button", { name: "Inspect time", exact: true }).click();
  await expect(page.locator("#detail")).toContainText("18m interval-union activity");
  await expect(page.locator("#detail")).toContainText("20m cumulative spans");
  await expect(page.locator("#detail")).toContainText("Human typing: unavailable");
});

test("artifact filters do not hide recorded identities after cancelled or failed analysis", async ({ page }) => {
  await open(page, "artifacts");
  await page.getByLabel("Purpose", { exact: true }).selectOption("Temporary helper");
  await page.getByLabel("Task", { exact: true }).selectOption("t1");
  await expect(page.locator("#main tbody tr")).toHaveCount(1);
  for (const result of ["Cancel analysis", "Simulate analysis failure", "Show synthetic completion"]) {
    await page.locator("[data-nav=report]").click();
    await startAnalysis(page);
    await page.getByRole("button", { name: result, exact: true }).click();
    await expect(page.locator("#detail")).not.toBeVisible();
    await page.locator("[data-nav=artifacts]").click();
    const complete = result === "Show synthetic completion";
    await expect(page.locator("#main tbody tr")).toHaveCount(complete ? 1 : 6);
    await expect(page.getByLabel("Purpose", { exact: true })).toHaveValue(complete ? "Temporary helper" : "All");
    if (!complete) {
      await expect(page.getByLabel("Purpose", { exact: true })).toBeDisabled();
      await expect(page.getByLabel("Task", { exact: true })).toBeDisabled();
    }
  }
});

test("S6 separates submission context, learned clarifications and suggested assumptions", async ({ page }) => {
  await open(page);
  await scenario(page, "prompts");
  await expect(page.locator("#rewrite")).toHaveValue(/currently filtered table rows/);
  await page.getByText("What context was available?", { exact: true }).click();
  await expect(page.getByText(/Assessment uses submission-time context/)).toBeVisible();
  await expect(page.getByText(/These are canned ratings/)).toBeVisible();
  await expect(page.getByText(/Suggested assumptions: preserve row order/)).toBeVisible();
  await expect(page.locator("#rewrite")).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "Later clarification / U08" }).click();
  await expect(page.locator("#detail")).toContainText("Export the filtered rows");
});

test("source acceptance opens the original human record, not a dashboard confirmation", async ({ page }) => {
  await open(page, "task/t2");
  await page.getByRole("button", { name: "Inspect outcome evidence" }).click();
  await expect(page.locator("#detail")).toContainText("Human / source C02");
  await expect(page.locator("#detail blockquote")).toHaveText("Date filtering now includes the end date; that is what I needed.");
  await expect(page.locator("#detail form, #detail input, #detail select")).toHaveCount(0);
  await open(page, "task/t3?panel=outcome&task=t3");
  await expect(page.locator("#detail")).toContainText("task remains partial");
});

test("evidence-backed completion links actual synthetic passing tests alongside artifact operations", async ({ page }) => {
  await open(page, "task/t1");
  await page.getByRole("button", { name: "Inspect outcome evidence" }).click();
  await page.getByRole("button", { name: "Inspect recorded test result" }).click();
  await expect(page.locator("#detail pre")).toContainText("8 passed, 0 failed");
  await expect(page.locator("#detail pre")).toContainText("Deleted: temp/make-fixtures.py");
});

test("S8 missing content and usage remain unavailable rather than becoming zero", async ({ page }) => {
  await open(page);
  await scenario(page, "partial");
  await expect(page.locator("#metric-tokens-session .metric-value")).toHaveText("Unavailable");
  await expect(page.locator("#metric-steering-session .metric-value")).toHaveText("Unavailable");
  await expect(page.locator("#metric-tools-session .metric-value")).toHaveText("27");
  await page.locator("#metric-tokens-session").click();
  await expect(page.locator("#detail")).toContainText("3 of 12 model calls lack usage");
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.getByRole("link", { name: "Explore prompt coaching" }).click();
  await expect(page.getByRole("heading", { name: "Message content was not captured." })).toBeVisible();
});

test("S8 acknowledged analysis supports cancellation, failure, explicit retry and completion", async ({ page }) => {
  await open(page);
  await scenario(page, "analysis-off");
  await page.getByRole("button", { name: "Analysis setup", exact: true }).click();
  await expect(page.locator("#detail")).toContainText("Copilot / remote model service");
  await page.getByRole("button", { name: "Start simulated analysis" }).click();
  await expect(page.getByRole("heading", { name: "Before an interpretation" })).toBeVisible();
  await expect(page.locator("#detail [role=alert]")).toHaveText("Acknowledge the selected scope and destination first.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#detail")).not.toBeVisible();
  await startAnalysis(page);
  await page.getByRole("button", { name: "Cancel analysis", exact: true }).click();
  await expect(page.locator("#main")).toContainText("Analysis: cancelled");
  await expect(page.locator("#main tbody tr")).toHaveCount(0);
  await startAnalysis(page);
  await page.getByRole("button", { name: "Simulate analysis failure" }).click();
  await expect(page.locator("#main")).toContainText("Analysis: failed");
  await expect(page.locator("#metric-tokens-session .metric-value")).toHaveText("12.4k / 1.8k");
  await startAnalysis(page);
  await page.getByRole("button", { name: "Show synthetic completion" }).click();
  await expect(page.locator("#main")).toContainText("Analysis: complete");
  await expect(page.locator("#main tbody tr")).toHaveCount(3);
});

test("refresh supersedes analysis, invalidates old evidence links and never starts another run", async ({ page }) => {
  await open(page);
  await page.locator("#metric-steering-session").click();
  const oldLink = page.url();
  await page.getByRole("button", { name: "Close detail" }).click();
  await startAnalysis(page);
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(page.locator("#detail")).not.toBeVisible();
  await expect(page.locator("#metric-tools-session .metric-value")).toHaveText("27");
  const refresh = page.getByRole("button", { name: "Refresh source", exact: true });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(refresh).toBeFocused();
  await expect(page.locator("#main")).toContainText("source read 2:");
  await expect(page.locator("#main")).toContainText("Analysis: superseded");
  await expect(page.locator("#main tbody tr")).toHaveCount(0);
  await page.evaluate((hash) => { location.hash = hash; }, new URL(oldLink).hash);
  await expect(page.locator("#detail [role=alert]")).toContainText("older evidence link is unavailable");
});

test("source replacements cannot reuse an old evidence link's read identity", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Refresh source", exact: true }).click();
  await page.evaluate(() => { location.hash = "report?panel=request&read=2&id=m4"; });
  await expect(page.locator("#detail pre")).toContainText('"inputTokens": 1500');
  const oldLink = new URL(page.url()).hash;
  await page.getByRole("button", { name: "Close detail" }).click();
  await scenario(page, "partial");
  await page.getByRole("button", { name: "Refresh source", exact: true }).click();
  await page.evaluate((hash) => { location.hash = hash; }, oldLink);
  await expect(page.locator("#detail [role=alert]")).toContainText("older evidence link is unavailable");
  await page.getByRole("button", { name: "Return to the report", exact: true }).click();
  await page.locator("[data-nav=sessions]").click();
  await page.getByRole("button", { name: "Open demo source", exact: true }).click();
  await page.getByRole("button", { name: "Load content + traces example" }).click();
  await expect(page.locator("#detail")).not.toBeVisible();
  await page.evaluate((hash) => { location.hash = hash; }, oldLink);
  await expect(page.locator("#detail [role=alert]")).toContainText("older evidence link is unavailable");
});

test("S8 unavailable and changing sources remove old reports and block evidence deep links", async ({ page }) => {
  await open(page);
  for (const name of ["source-changed", "source-unavailable"]) {
    await scenario(page, name);
    await expect(page.locator("#main [role=alert]")).toContainText("No successful totals");
    await expect(page.locator("#main tbody tr, #metric-tools-session")).toHaveCount(0);
    await page.locator("[data-nav=sessions]").click();
    await expect(page.locator("#main h1")).toHaveText("Your sessions");
    await expect(page.locator("#main .breadcrumb")).toHaveCount(1);
    await expect(page.locator('#main [data-action="refresh"]')).toHaveCount(1);
    await page.evaluate(() => { location.hash = "report?panel=tool&id=c1"; });
    await expect(page.getByRole("heading", { name: "Source evidence unavailable" })).toBeVisible();
    await page.locator("#detail").getByRole("button", { name: "Retry synthetic read" }).click();
    await expect(page.getByRole("heading", { name: "Tasks have not been analyzed." })).toBeVisible();
    await expect(page.locator("#metric-tools-session .metric-value")).toHaveText("27");
  }
});

test("revision 2 has no correction surfaces and historical edit links fail explicitly", async ({ page }) => {
  for (const hash of ["report", "task/t1", "artifacts", "prompts/t1", "report?panel=interaction&event=u08", "report?panel=artifact&id=a3"]) {
    await open(page, hash);
    await expect(page.locator("button, a").filter({ hasText: /^(Rename|Merge selected|Split selected|Adjust segments|Exclude|Restore|Correct outcome|Save purpose|Save classification|Save corrections|Review interpretations)$/ })).toHaveCount(0);
    await expect(page.locator('[data-form="task"], [data-form="signal"], [data-form="purpose"]')).toHaveCount(0);
  }
  await open(page, "review");
  await expect(page.getByRole("heading", { name: "This view is unavailable." })).toBeVisible();
  await open(page, "report?panel=edit&op=rename&task=t1");
  await expect(page.getByRole("heading", { name: "This detail is unavailable" })).toBeVisible();
});

test("keyboard close restores focus and task deep links preserve scope", async ({ page }) => {
  await open(page);
  const trigger = page.locator("#metric-steering-session");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#detail")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await open(page, "task/t1?panel=steering&task=t1");
  await expect(page.getByRole("heading", { name: "2 steering messages" })).toBeVisible();
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(page.getByRole("heading", { name: "Add CSV export", exact: true })).toBeVisible();
});

test("deep links cannot bypass missing sources, usage or unavailable task attribution", async ({ page }) => {
  await open(page);
  await scenario(page, "empty");
  await page.evaluate(() => { location.hash = "report?panel=tokens"; });
  await expect(page.getByRole("heading", { name: "No source selected" })).toBeVisible();
  await page.getByRole("button", { name: "Close detail" }).click();
  await scenario(page, "analysis-off");
  await page.evaluate(() => { location.hash = "report?panel=tokens&task=t1"; });
  await expect(page.getByRole("heading", { name: "Task attribution is not analyzed" })).toBeVisible();
  await page.evaluate(() => { location.hash = "report?panel=interaction&event=u08"; });
  await expect(page.getByRole("heading", { name: "Task attribution is not analyzed" })).toBeVisible();
  await expect(page.locator("#detail")).not.toContainText("1 steering message");
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.locator("[data-nav=sessions]").click();
  await page.getByRole("button", { name: "Open transcript-only demonstration", exact: true }).click();
  await page.evaluate(() => { location.hash = "report?panel=request&id=m1"; });
  await expect(page.getByRole("heading", { name: "Usage record unavailable" })).toBeVisible();
});

test("accessible metric names include scope, values and missing-data status", async ({ page }) => {
  await open(page);
  await expect(page.locator("#metric-steering-session")).toHaveAccessibleName(/Inspect Human steering: 4.*inferred categories.*whole session/);
  await expect(page.locator("#row-steering-t1")).toHaveAccessibleName(/Add CSV export: 2/);
  await scenario(page, "partial");
  await expect(page.locator("#metric-tokens-session")).toHaveAccessibleName(/Model tokens: Unavailable.*recorded usage/);
  await expect(page.locator("#metric-steering-session")).toHaveAccessibleName(/Human steering: Unavailable.*Not analyzed/);
});

test("original session/task anchors remain separate and safe evidence is rendered as text", async ({ page }) => {
  await open(page, "task/t1");
  await page.getByRole("button", { name: "Inspect originating instruction and interpretation" }).click();
  await expect(page.locator("#detail .source-instruction")).toHaveCount(1);
  await expect(page.locator("#detail .source-instruction")).toContainText("Human / U01");
  await open(page, "prompts");
  await page.getByRole("button", { name: "Original session instruction", exact: true }).click();
  await expect(page.locator("#detail")).toContainText("Help me improve reporting in this app.");
  await expect(page.locator("#detail .source-instruction")).not.toContainText("Add CSV export");
  await open(page, "report?panel=tool&id=%3Cimg%20src=x%20onerror=alert(1)%3E");
  await expect(page.getByRole("heading", { name: "This detail is unavailable" })).toBeVisible();
  await expect(page.locator("main img, #detail img")).toHaveCount(0);
});

test("invalid routes and evidence references recover without stale content", async ({ page }) => {
  await open(page, "report?panel=tool&id=missing");
  await expect(page.locator("#detail [role=alert]")).toContainText("does not exist");
  await page.getByRole("button", { name: "Return to the report", exact: true }).click();
  await page.evaluate(() => { location.hash = "task/missing?panel=tools"; });
  await expect(page.locator("#detail")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "This view is unavailable." })).toBeVisible();
  await page.getByRole("link", { name: "Return to report", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reporting improvements", exact: true })).toBeVisible();
});

test("skip link focuses the current main view without changing routes", async ({ page }) => {
  await open(page);
  await page.getByRole("link", { name: "Skip to report", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  await expect(page).toHaveURL(/#report$/);
});

test("reload discards derived run state without browser storage", async ({ page }) => {
  await open(page);
  await startAnalysis(page);
  await page.getByRole("button", { name: "Simulate analysis failure" }).click();
  await page.reload();
  await expect(page.locator("#main")).not.toContainText("Analysis: failed");
  await expect(page.locator("#main")).toContainText("source read 1:");
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test("desktop and narrow evidence layouts remain usable", async ({ page }, testInfo) => {
  await open(page);
  await page.screenshot({ path: testInfo.outputPath("report-desktop.png"), fullPage: true });
  await page.locator("#metric-steering-session").click();
  await page.screenshot({ path: testInfo.outputPath("evidence-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("report-mobile.png"), fullPage: true });
  await page.locator("#metric-steering-session").click();
  expect(Math.round((await page.locator("#detail").boundingBox()).width)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(page.locator("#detail")).not.toBeVisible();
});
