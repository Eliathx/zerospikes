import { test as browserTest } from "./index.js";
import { connectToApp, describeRuntime, runtimeHints } from "./connect.js";

/**
 * `zerospikes/app`: the same `test`, able to measure an app that is already
 * running (Tauri on Windows, Electron) instead of a browser Playwright launches.
 * A spec that imports `test` from here runs in both kinds of project: with
 * `zsConnect` set in the project it measures the app, without it a browser.
 * Kept apart from `zerospikes` because it replaces Playwright's own `browser`
 * fixture, which only the specs that ask for it should get.
 */
export * from "./index.js";

export interface ZeroSpikesAppOptions {
  /**
   * The running app's Chrome DevTools Protocol endpoint, such as
   * `http://127.0.0.1:9222`. A Tauri app on Windows exposes one when started with
   * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, an
   * Electron app with `--remote-debugging-port=9222`. `page` is then the app's
   * window, the same one in every test. Unset, the project launches a browser.
   */
  zsConnect: string | undefined;
}

/** How Playwright writes the launch options header: HTTP headers are ASCII only. */
const forceASCII = (json: string) =>
  json.replace(/[\u007f-￿]/g, (c) => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4));

export const test = browserTest.extend<object, ZeroSpikesAppOptions & { _reuseContext: boolean }>({
  zsConnect: [undefined, { scope: "worker", option: true }],
  // Playwright's own browser fixture with connecting to a running app added.
  // Without zsConnect it does what Playwright's does (playwright/lib/index.js);
  // `_browserOptions`, Playwright's too, holds the launch options.
  browser: [
    async ({ playwright, browserName, connectOptions, zsConnect, _browserOptions }: any, use, workerInfo) => {
      if (zsConnect) {
        if (browserName !== "chromium") throw new Error(`zerospikes: zsConnect needs a chromium project, not ${browserName}`);
        if (workerInfo.parallelIndex > 0) {
          throw new Error("zerospikes: the app has one window, and a second worker would drive it at the same time. Run with workers: 1.");
        }
        const browser = await connectToApp(playwright.chromium, zsConnect);
        await use(browser);
        // Over CDP this disconnects: the app keeps running.
        await browser.close();
        return;
      }
      const browser = connectOptions
        ? await playwright[browserName].connect(connectOptions.wsEndpoint, {
            ...connectOptions,
            headers: { "x-playwright-launch-options": forceASCII(JSON.stringify(_browserOptions)), ...connectOptions.headers },
          })
        : await playwright[browserName].launch();
      if (!connectOptions && process.env.PLAYWRIGHT_DASHBOARD) await browser.bind(`worker-${workerInfo.parallelIndex}`);
      await use(browser);
      await browser.close({ reason: "Test ended." });
    },
    { scope: "worker", timeout: 0 },
  ],
  // Reusing a context (VS Code's "Show browser") would make Playwright create one
  // of its own in the app instead of using its window, which is reused anyway.
  _reuseContext: [async ({ _reuseContext, zsConnect }, use) => use(zsConnect ? false : _reuseContext), { scope: "worker" }],
  // The app's window belongs to a context Playwright didn't create, so it has no
  // baseURL: resolve relative URLs here, and the same spec runs in both kinds of project.
  page: async ({ page, baseURL, zsConnect }, use) => {
    if (!zsConnect || !baseURL) return use(page);
    const goto = page.goto;
    page.goto = (url, options) => goto.call(page, new URL(url, baseURL).href, options);
    await use(page);
    page.goto = goto;
  },
  _zsRuntime: async ({ page, zsConnect }, use) => use(zsConnect ? describeRuntime(await page.evaluate(runtimeHints)) : null),
});
