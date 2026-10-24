import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "perf",
  testMatch: "**/*.perf.ts",
  // Perf scenarios share the machine: run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  reporter: [["zerospikes/reporter"]],
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      // "chromium" is the real browser in new headless mode; the default headless
      // shell renders differently and isn't what users run.
      use: { ...devices["Desktop Chrome"], channel: "chromium", viewport: { width: 1280, height: 900 } },
    },
  ],
  // Production build: dev-mode React would measure React's own checks, not the app.
  webServer: {
    command: "npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
});
