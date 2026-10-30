/** Real runtime browser checks; no mock report data, external model or private source is used. */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.spec.mjs",
  workers: 1,
  use: { browserName: "chromium", viewport: { width: 1200, height: 900 } },
});
