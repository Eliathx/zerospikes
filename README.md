<h1><img src="https://raw.githubusercontent.com/Eliathx/zerospikes/main/.github/banner.png" alt="zerospikes" width="830"></h1>

**Interaction performance limits for Playwright.**

[![npm](https://img.shields.io/npm/v/zerospikes)](https://www.npmjs.com/package/zerospikes)
[![license](https://img.shields.io/npm/l/zerospikes?cacheSeconds=86400)](LICENSE)

zerospikes measures every frame, the input latency and the main thread's CPU time while
a Playwright scenario runs. The first run records its limits, like a snapshot, and later
runs fail when a change makes the interaction slower. The failure names the functions
that took the time.

```ts
import { test } from "zerospikes";

test("filter as you type", async ({ page, zs }) => {
  await page.goto("/");
  const search = page.getByRole("searchbox");
  await zs.measure("type 'mar'", () => search.pressSequentially("mar"), {
    before: () => search.fill(""), // unmeasured: back to the start before each run
  });
});
```

```bash
npm install -D zerospikes @playwright/test
```

## Documentation

- [Getting started](https://zerospikes.eliath.dev/docs)
- [Writing scenarios](https://zerospikes.eliath.dev/docs/scenarios)
- [Limits](https://zerospikes.eliath.dev/docs/limits)
- [CLI and CI](https://zerospikes.eliath.dev/docs/cli)
- [API reference](https://zerospikes.eliath.dev/docs/api)

## Example

[examples/20k-table](https://github.com/Eliathx/zerospikes/tree/main/examples/20k-table)
is a 20,000-row data grid with four performance mistakes to turn on, one at a time,
and watch zerospikes catch them. From a clone of this repository:

```bash
npm install
npx playwright install chromium
npm run example:perf
```

## License

[MIT](LICENSE)
