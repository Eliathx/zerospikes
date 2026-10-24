import { expect, test } from "zerospikes";

// Each scenario gets a fresh page. hud=0 hides the live meter so it isn't measured too.
test.beforeEach(async ({ page }) => {
  await page.goto("/?hud=0");
  await expect(page.getByRole("grid")).toBeVisible();
});

test("filter as you type", async ({ page, zs }) => {
  const search = page.getByRole("searchbox", { name: "Search" });
  await zs.measure("type «mar»", () => search.pressSequentially("mar"), {
    before: () => search.fill(""),
  });
});

test("sort by client", async ({ page, zs }) => {
  const header = page.getByRole("button", { name: /^Client/ });
  await zs.measure("click the header", () => header.click());
});

test("resize a column", async ({ page, zs }) => {
  const box = (await page.getByTestId("resize-name").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  let widened = false;
  await zs.measure("drag the «Client» border", () => zs.drag([x, y], [x + 160, y]), {
    // Put the column back between runs, unmeasured.
    before: async () => {
      if (widened) await zs.drag([x + 160, y], [x, y], { steps: 2 });
      widened = true;
    },
  });
});

test("scroll the grid", async ({ page, zs }) => {
  const body = page.getByTestId("grid-body");
  await body.hover();
  await zs.measure(
    "15 wheel steps",
    async () => {
      for (let i = 0; i < 15; i++) {
        await page.mouse.wheel(0, 400);
        await zs.frame();
      }
    },
    { before: () => body.evaluate((el) => void (el.scrollTop = 0)) },
  );
});

test("open the detail panel", async ({ page, zs }) => {
  const close = page.getByRole("button", { name: "Close detail" });
  await zs.measure("click a row", () => page.locator(".grid-row").nth(3).click(), {
    before: async () => {
      if (await close.isVisible()) await close.click();
    },
  });
});

test("memory when opening and closing details", async ({ page, zs }) => {
  await zs.cycles(
    "open and close 10 invoices",
    async () => {
      for (let i = 0; i < 10; i++) {
        await page.locator(".grid-row").nth(i).click();
        await page.getByRole("button", { name: "Close detail" }).click();
      }
    },
    { cycles: 5 },
  );
});
