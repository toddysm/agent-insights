/** Verify flat-config coverage and type-aware diagnostics using in-memory positive/negative fixtures. */
import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

test("generated outputs are ignored while native and browser scripts remain covered", async () => {
  const lint = new ESLint();
  for (const file of [
    ".build/tests/example.js",
    "native/sqlite-guard/target/example.js",
    "playwright-report/example.js",
    "test-results/example.js",
  ])
    assert.equal(await lint.isPathIgnored(file), true, file);
  for (const file of [
    "native/sqlite-guard/tests/fixtures/writer.mjs",
    "design/session-insights/app.js",
    "tests/browser/runtime.spec.mjs",
  ])
    assert.equal(await lint.isPathIgnored(file), false, file);
  const [script] = await lint.lintText("console.log(process.platform);", {
    filePath: "native/sqlite-guard/tests/fixtures/writer.mjs",
  });
  assert.equal(script.errorCount, 0);
});

test("type-aware lint permits node:test registrations but rejects other floating promises", async () => {
  const lint = new ESLint();
  const [result] = await lint.lintText(
    'import test from "node:test"; test("fixture", async () => {}); Promise.resolve(1);',
    { filePath: "tests/analysis.test.ts" },
  );
  assert.equal(result.fatalErrorCount, 0);
  assert.deepEqual(
    result.messages.map(({ ruleId }) => ruleId),
    ["@typescript-eslint/no-floating-promises"],
  );
});

test("browser scripts and React hooks receive their intended configuration", async () => {
  const lint = new ESLint();
  const [browser] = await lint.lintText(
    "console.log(window.location, process.platform);",
    {
      filePath: "tests/browser/runtime.spec.mjs",
    },
  );
  assert.equal(browser.errorCount, 0);
  const react = await lint.calculateConfigForFile("src/web/app.tsx");
  assert.equal(react.languageOptions.parserOptions.projectService, true);
  assert.equal(react.rules["react-hooks/rules-of-hooks"][0], 2);
  assert.equal(react.rules["@typescript-eslint/no-unsafe-assignment"][0], 2);
});
