import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ErrorTally, stackLocation, watchErrors } from "../dist/page-errors.js";

/** Just enough of a Playwright page to log to. */
const fakePage = () => Object.assign(new EventEmitter(), {
  error(text, url = "", lineNumber = 0) {
    this.emit("console", { type: () => "error", text: () => text, location: () => ({ url, lineNumber }) });
  },
});

test("errors are counted once per message and place, ignored ones and the browser's favicon left out, and taken once", () => {
  const page = fakePage();
  const watch = watchErrors(page, ["ResizeObserver loop", /^Warning:/]);
  page.error("boom", "http://localhost:5173/src/grid.ts?t=123", 11);
  page.error("boom", "http://localhost:5173/src/grid.ts?t=123", 11);
  page.error("Failed to load resource: 404", "http://localhost:5173/favicon.ico");
  page.error("ResizeObserver loop completed with undelivered notifications.");
  page.error("Warning: Each child in a list should have a unique key\n    at Row");
  page.emit("console", { type: () => "warning", text: () => "not an error", location: () => ({ url: "", lineNumber: 0 }) });
  const thrown = new TypeError("x is undefined");
  thrown.stack = "TypeError: x is undefined\n    at sortRows (http://localhost:5173/src/sort.ts:40:7)";
  page.emit("pageerror", thrown);
  assert.deepEqual(watch.take(), [
    { message: "boom", location: "src/grid.ts:12", count: 2 },
    { message: "TypeError: x is undefined", location: "src/sort.ts:40", count: 1 },
  ]);
  assert.deepEqual(watch.take(), []);
  watch.stop();
  page.error("after");
  assert.deepEqual(watch.take(), []);
});

test("a tally adds up the same error from different takes, and doesn't change what it was given", () => {
  const tally = new ErrorTally();
  const boom = { message: "boom", location: "src/grid.ts:12", count: 2 };
  tally.add(boom);
  tally.add({ message: "boom", location: "src/grid.ts:12", count: 3 });
  tally.add({ message: "boom", count: 1 });
  assert.deepEqual(tally.list(), [{ message: "boom", location: "src/grid.ts:12", count: 5 }, { message: "boom", count: 1 }]);
  assert.equal(boom.count, 2);
  assert.ok(tally.has({ message: "boom", count: 9 }));
  assert.ok(!tally.has({ message: "other", count: 1 }));
});

test("stackLocation finds the first frame, named or not", () => {
  assert.equal(stackLocation("Error: a\n    at http://localhost:1420/src/app.tsx:7:3"), "src/app.tsx:7");
  assert.equal(stackLocation("Error: a"), undefined);
});
