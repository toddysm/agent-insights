/** Browser checks load the actual HTML through file://; no preview server or backend is involved. */
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.cjs",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    viewport: { width: 1440, height: 1100 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1100 },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1440, height: 1100 },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 1100 },
      },
    },
  ],
});
