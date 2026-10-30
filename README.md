# zerospikes

Interaction performance limits for Playwright, a kind of performance budget.
Write a scenario and measure every frame while it runs, record its limits the
first time like a snapshot, and the test will fail when a later change makes it slower.

```ts
import { test } from "zerospikes";

test("filter as you type", async ({ page, zs }) => {
  await page.goto("/");
  const search = page.getByRole("searchbox");
  await zs.measure("type «mar»", () => search.pressSequentially("mar"), {
    before: () => search.fill(""), // unmeasured: back to the start before each run
  });
});
```

```
  PASS    filter as you type (4.1s)
  FAIL    sort by client (3.8s)
  ...

  zerospikes  6 scenarios · 1 over limits · 1 limits recorded
  FAIL    sort by client › click the header   input down/move/up/click 351 ms > 87, frame.max 346 ms > 83

  Details, trends and limits: npx zerospikes
```

The test itself fails with the same detail, the path of the limits file and
how to accept an intended change (`npx playwright test -u`).

## The zerospikes command

`npx zerospikes` opens every scenario's history in the terminal: its status in
the latest run, each metric against its limit, and its trend across past runs
and branches. Open a scenario to see where its time went (the hottest functions
of a profiled run, the `.cpuprofile` to load in DevTools › Performance) and which targets it lags behind.

| Key | What it does |
|---|---|
| `r` | Runs the suite; the view updates when it ends |
| `t` | Lowers the limits the latest run beat |
| `w` | Saves a failed scenario's numbers as its limits, when it's slower on purpose |
| `b` | Shows one branch's runs, or all |

`r` runs `npx playwright test`, or the command your package.json names:

```json
"zerospikes": { "run": "npm run build && playwright test" }
```

Without a terminal, or with `--print`, it prints the scenario list once.
`npx zerospikes compare` checks two served builds against each other.

## What it measures

| Metric | What it is |
|---|---|
| `frame.max` | Longest gap between two frames while the scenario ran |
| `frame.p95` | 95th percentile of the frame gaps |
| `frame.slow` | Frames longer than two display frames (> 33.4 ms) |
| `frame.long` | Long animation frames (> 50 ms) from the LoAF API, Chromium only |
| `input.down` / `input.move` / `input.up` | Worst time from a pointer event to the next frame, per phase of a gesture. `pointermove` is included |
| `input.click` / `input.key` / `input.wheel` | Same for clicks, key presses and wheel steps |
| `memory.heapMB` / `memory.nodes` / `memory.listeners` | For `zs.cycles`: what stays behind after N cycles, with GC forced before every sample. Chromium only |

## Limits

1. Run `npx playwright test`. The first time, each scenario saves how fast it
   is to `__limits__/<spec>.json`. Commit that file.
2. From then on, a scenario fails if it gets slower than what was saved. In
   your CI pipeline, run `npx playwright test --update-snapshots=none` so it
   only checks and never saves.
3. If you made it slower on purpose, press `w` on it in `npx zerospikes` (or
   run `npx playwright test -u`) to save the new numbers, and commit them.
4. If you made it faster, press `t` in `npx zerospikes` (or run
   `npx playwright test --update-snapshots=all`) so the faster numbers become
   the new limits.

You can also set fixed limits yourself: `{ limits: { "frame.max": 50 } }`.

## Errors in the page

A scenario that throws halfway can look faster than one that works. If the
page logs a `console.error` or an uncaught exception while a scenario runs, it
shows as `ERROR` instead of `PASS` or `FAIL`. Its numbers aren't compared with
its limits and can't set or lower them; its history shows them greyed out. The
test fails and lists the errors: fix
them and run again. An error in the test's own steps counts against the
scenarios after it, which start from what those steps left; one after the last
scenario fails the test.

Errors you expect, such as a warning from React's development build, can be
left out by their message or the file they come from. A missing `favicon.ico`,
which the browser asks for on its own, is left out already.

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";
import type { ZeroSpikesOptions } from "zerospikes";

export default defineConfig<ZeroSpikesOptions>({
  use: { zsIgnoreErrors: ["ResizeObserver loop", /^Warning: Each child in a list/] },
});
```

## API

```ts
zs.measure(name, act, { runs, warmup, before, settleMs, limits, profileOnFail })
zs.cycles(name, cycle, { cycles, warmup, limits })   // memory
zs.drag([x, y], [x2, y2], { steps })                 // one pointermove per frame
zs.frame()                                           // wait for the next frame
```

Add the reporter for the summary and the history `npx zerospikes` shows:

```ts
// playwright.config.ts
reporter: [["list"], ["zerospikes/reporter"]],
workers: 1, // perf scenarios shouldn't compete for the CPU
```

## Desktop apps: Tauri and Electron

To measure an app that is already running instead of a browser Playwright
launches, import `test` from `zerospikes/app` and give the project the app's
Chrome DevTools Protocol endpoint. `page` is then the app's window: the same
one in every test, so put the app back in its starting state in `beforeEach`
(a `page.goto("/")` reloads it). A project without `zsConnect` runs the same
spec in a browser.

```ts
// app.perf.ts
import { test } from "zerospikes/app";
```

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";
import type { ZeroSpikesAppOptions } from "zerospikes/app";

export default defineConfig<ZeroSpikesAppOptions>({
  workers: 1, // the app has one window: zerospikes stops a second worker
  use: { baseURL: "http://localhost:1420" },
  projects: [{ name: "tauri", use: { zsConnect: "http://127.0.0.1:9222" } }],
  webServer: {
    command: "npx tauri dev",
    env: { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
    url: "http://127.0.0.1:9222/json/version", // up once the app's webview answers
    reuseExistingServer: true,
    timeout: 900_000,
  },
});
```

- **Tauri** on Windows runs in WebView2, which opens the port when
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` says so. macOS (WKWebView) and Linux
  (WebKitGTK) have no CDP: measure the frontend in a browser there.
- **Electron**: start it with `--remote-debugging-port=9222`.

Limits recorded this way say `webview2` or `electron` where a browser run says
`chromium`, so they are never compared with a browser's.

## Example

[examples/20k-table](https://github.com/Eliathx/zerospikes/tree/main/examples/20k-table)
is a 20,000-row data grid with six scenarios. Its `src/mistakes.ts` holds four
performance mistakes, all off. From the repository root:

```bash
npm install
npx playwright install chromium
npm run example:perf
```

The first run records the limits and passes. Set `sort: true` in
`examples/20k-table/src/mistakes.ts`, run it again, and the sort scenario fails.
`npx zerospikes` in `examples/20k-table` opens it, with the profile pointing at
`sortRows`, and `r` there runs the suite again. `npm run example` opens the app with a
live meter, to feel the mistakes by hand.

| Mistake | What it does | What fails |
|---|---|---|
| `filter` | Serializes every row on each key press instead of using the search index | `input.key`, `frame.max` (~2x) |
| `sort` | Strips accents on every comparison instead of once per row | `input.click`, `frame.max` (~4x) |
| `resize` | Re-measures every cell each time a column drag starts | `input.down` only (~7x) |
| `leak` | The detail panel leaves its listener and DOM behind when it closes | `memory.nodes`, `memory.listeners` |

Limits belong to the machine that recorded them: on another machine, record
your own with `npm run perf:update` in the example's folder.

## Development

```bash
npm install                      # the library and the example (npm workspaces)
npx playwright install chromium
npm test                         # builds the library, runs its unit tests
```

MIT License
