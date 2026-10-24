import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate, median, quantile, runMetrics, worstOf } from "../dist/stats.js";
import { BudgetStore, check, deriveLimit, validateLimits } from "../dist/budgets.js";
import { INTERACTION_METRICS } from "../dist/types.js";

test("runMetrics turns frame timestamps and inputs into per-phase numbers", () => {
  const m = runMetrics({
    frames: [0, 16.7, 33.4, 133.4, 150.1],
    inputs: [
      { type: "pointerdown", ms: 20 },
      { type: "pointermove", ms: 12 },
      { type: "pointermove", ms: 90 },
      { type: "pointerup", ms: 15 },
    ],
    longFrames: [{ duration: 98, scripts: ["onMove @ grid.js"] }],
  });
  assert.equal(m["frame.max"], 100);
  assert.equal(m["frame.slow"], 1);
  assert.equal(m["frame.long"], 1);
  assert.equal(m["input.down"], 20);
  assert.equal(m["input.move"], 90);
  assert.equal(m["input.up"], 15);
  assert.equal(m["input.key"], undefined);
});

test("runMetrics leaves frame.long out when the browser has no LoAF", () => {
  assert.equal("frame.long" in runMetrics({ frames: [0, 16], inputs: [], longFrames: null }), false);
});

test("aggregate takes the median per metric, ignoring runs without it", () => {
  const out = aggregate([{ "frame.max": 16 }, { "frame.max": 200, "input.key": 30 }, { "frame.max": 17, "input.key": 40 }]);
  assert.deepEqual(out, { "frame.max": 17, "input.key": 35 });
});

test("worstOf keeps the highest value per metric, the basis for new budgets", () => {
  const out = worstOf([{ "frame.max": 16 }, { "frame.max": 40, "input.key": 30 }, { "frame.max": 17 }]);
  assert.deepEqual(out, { "frame.max": 40, "input.key": 30 });
});

test("median and quantile", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(quantile([], 0.95), 0);
});

test("derived limits leave at least two frames of slack", () => {
  assert.equal(deriveLimit("frame.max", 16.7), 51);
  assert.equal(deriveLimit("frame.max", 200), 300);
  assert.equal(deriveLimit("memory.heapMB", -0.4), 2);
  assert.equal(deriveLimit("memory.nodes", 0), 50);
  assert.equal(deriveLimit("frame.slow", 0), 2);
});

test("check reports only metrics over their limit", () => {
  const v = check({ "frame.max": 40, "input.move": 10 }, { "frame.max": 34, "input.move": 34, "input.key": 1 }, "budget");
  assert.deepEqual(v, [{ metric: "frame.max", value: 40, limit: 34, source: "budget" }]);
});

test("validateLimits rejects a misspelled metric", () => {
  assert.throws(() => validateLimits("sort", { frameMax: 50 }, INTERACTION_METRICS, { "frame.max": 10 }), /unknown metric "frameMax"/);
});

test("validateLimits rejects a limit on a metric the scenario didn't produce", () => {
  assert.throws(
    () => validateLimits("click", { "input.move": 50 }, INTERACTION_METRICS, { "frame.max": 10, "input.click": 5 }),
    /no such metric \(it produced: frame.max, input.click\)/,
  );
  validateLimits("click", { "input.click": 50 }, INTERACTION_METRICS, { "input.click": 5 });
});

test("BudgetStore keeps budgets sorted next to the spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const store = new BudgetStore(join(dir, "grid.perf.ts"));
  store.set("b", { "frame.max": 1 });
  store.set("a", { "frame.max": 2 });
  assert.equal(store.path, join(dir, "__budgets__", "grid.perf.ts.json"));
  assert.deepEqual(store.get("a"), { "frame.max": 2 });
  assert.deepEqual(new BudgetStore(join(dir, "grid.perf.ts")).get("b"), { "frame.max": 1 });
});
