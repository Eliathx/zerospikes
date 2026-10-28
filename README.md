# zerospikes

Interaction performance budgets for Playwright. Write a scenario and
measure every frame while it runs, record a budget the first
time like a snapshot, and the test will fail when a later change makes it slower.

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

  zerospikes  6 scenarios · 1 over budget · 1 budgets recorded
  FAIL    sort by client › click the header   input down/move/up/click 351 ms > 87, frame.max 346 ms > 83

  Details, trends and budgets: npx zerospikes
```

The test itself fails with the same detail, the path of the budgets file and
how to accept an intended change (`npx playwright test -u`).

## The zerospikes command

`npx zerospikes` opens every scenario's history in the terminal: its status in
the latest run, each metric against its budget, and its trend across past runs
and branches. Open a scenario to see where its time went (the hottest functions
of a profiled run, the `.cpuprofile` to load in DevTools › Performance) and which targets it lags behind.

| Key | What it does |
|---|---|
| `r` | Runs the suite; the view updates when it ends |
| `t` | Lowers the budgets the latest run beat |
| `w` | Saves a failed scenario's numbers as its budget, when it's slower on purpose |
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

## Budgets

1. Run `npx playwright test`. The first time, each scenario saves how fast it
   is to `__budgets__/<spec>.json`. Commit that file.
2. From then on, a scenario fails if it gets slower than what was saved. In
   your CI pipeline, run `npx playwright test --update-snapshots=none` so it
   only checks and never saves.
3. If you made it slower on purpose, press `w` on it in `npx zerospikes` (or
   run `npx playwright test -u`) to save the new numbers, and commit them.
4. If you made it faster, press `t` in `npx zerospikes` (or run
   `npx playwright test --update-snapshots=all`) so the faster numbers become
   the new limit.

You can also set a fixed limit yourself: `{ budget: { "frame.max": 50 } }`.

## API

```ts
zs.measure(name, act, { runs, warmup, before, settleMs, budget, profileOnFail })
zs.cycles(name, cycle, { cycles, warmup, budget })   // memory
zs.drag([x, y], [x2, y2], { steps })                 // one pointermove per frame
zs.frame()                                           // wait for the next frame
```

Add the reporter for the summary and the history `npx zerospikes` shows:

```ts
// playwright.config.ts
reporter: [["list"], ["zerospikes/reporter"]],
workers: 1, // perf scenarios shouldn't compete for the CPU
```

## Example

[examples/20k-table](https://github.com/Eliathx/zerospikes/tree/main/examples/20k-table)
is a 20,000-row data grid with six scenarios. Its `src/mistakes.ts` holds four
performance mistakes, all off. From the repository root:

```bash
npm install
npx playwright install chromium
npm run example:perf
```

The first run records the budgets and passes. Set `sort: true` in
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

Budgets belong to the machine that recorded them: on another machine, record
your own with `npm run perf:update` in the example's folder.

## Development

```bash
npm install                      # the library and the example (npm workspaces)
npx playwright install chromium
npm test                         # builds the library, runs its unit tests
```

MIT License
