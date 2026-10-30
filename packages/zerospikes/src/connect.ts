import type { Browser, BrowserContext, BrowserType, Page } from "@playwright/test";

/**
 * Connecting to an app that is already running and exposes Chrome DevTools
 * Protocol, instead of launching a browser: a Tauri app on Windows (WebView2
 * started with `--remote-debugging-port`), an Electron app started with
 * `--remote-debugging-port`, or a Chrome started by hand.
 */

/** How long to keep retrying while the app is still starting. */
const CONNECT_TIMEOUT_MS = 60_000;
const RETRY_GAP_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Connects to `endpoint` and makes the browser hand out the app's own window
 * where Playwright asks for a new context and page: the app has one window, and
 * a context of Playwright's own would open none. That context is never closed,
 * so the app keeps running between tests; each test starts where the last one
 * left it, so put the app back in its starting state in `beforeEach`.
 */
export async function connectToApp(chromium: BrowserType, endpoint: string): Promise<Browser> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let browser: Browser;
  for (;;) {
    try {
      browser = await chromium.connectOverCDP(endpoint);
      break;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`zerospikes: nothing answered at ${endpoint}. Is the app running with --remote-debugging-port?\n${error}`);
      }
      await sleep(RETRY_GAP_MS);
    }
  }
  const [context] = browser.contexts();
  if (!context) throw new Error(`zerospikes: ${endpoint} has no window to measure`);
  let page: Page | undefined;
  browser.newContext = async () => context;
  context.newPage = async () => (page ??= await appWindow(context));
  context.close = async () => {};
  return browser;
}

/** The app's window: the first page that isn't DevTools, waiting for it while the app starts. */
async function appWindow(context: BrowserContext): Promise<Page> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  for (;;) {
    const page = context.pages().find((p) => !p.url().startsWith("devtools://"));
    if (page) return page;
    if (Date.now() > deadline) throw new Error("zerospikes: the app opened no window");
    await sleep(RETRY_GAP_MS);
  }
}

/** What the connected page runs in, read from inside it. */
export interface AppRuntime {
  /** `webview2`, `electron` or `chromium`, the name limits are recorded under. */
  name: string;
  headless: boolean;
}

/** Runs in the page: what tells the runtimes apart. */
export function runtimeHints(): { userAgent: string; webview2: boolean } {
  return { userAgent: navigator.userAgent, webview2: Boolean((window as any).chrome?.webview) };
}

export function describeRuntime({ userAgent, webview2 }: { userAgent: string; webview2: boolean }): AppRuntime {
  // WebView2 exposes chrome.webview to talk to its host; its user agent is plain Edge.
  const name = webview2 ? "webview2" : /\bElectron\//.test(userAgent) ? "electron" : "chromium";
  return { name, headless: /\bHeadlessChrome\//.test(userAgent) };
}
