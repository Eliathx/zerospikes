import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate, median, quantile, runMetrics, worstOf } from "../dist/stats.js";
import { LimitStore, check, deriveLimit, overTargets, tighten, tighterLimits, validateLimits } from "../dist/limits.js";
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

test("worstOf keeps the highest value per metric, the basis for new limits", () => {
  const out = worstOf([{ "frame.max": 16 }, { "frame.max": 40, "input.key": 30 }, { "frame.max": 17 }]);
  assert.deepEqual(out, { "frame.max": 40, "input.key": 30 });
});

test("median and quantile", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(quantile([], 0.95), 0);
});

test("derived time limits leave two measured frames, or 60% on heavy interactions", () => {
  assert.equal(deriveLimit("frame.max", 6.2, 6.2), 19);
  assert.equal(deriveLimit("frame.max", 16.7, 16.7), 51);
  assert.equal(deriveLimit("input.click", 200, 16.7), 320);
  assert.equal(deriveLimit("frame.slow", 0, 16.7), 1);
  assert.equal(deriveLimit("frame.long", 2, 16.7), 5);
  assert.equal(deriveLimit("memory.heapMB", -0.4, 16.7), 2);
  assert.equal(deriveLimit("memory.nodes", 0, 16.7), 50);
});

test("cpu.main slack is proportional, with a floor for light interactions", () => {
  assert.equal(deriveLimit("cpu.main", 4, 16.7), 16);
  assert.equal(deriveLimit("cpu.main", 100, 16.7), 145);
});

test("recording again only lowers limits, and keeps ones the scenario didn't produce this time", () => {
  const stored = { "frame.max": 40, "input.click": 30, "input.key": 20 };
  assert.deepEqual(tighten(stored, { "frame.max": 25, "input.click": 45, "frame.slow": 1 }), {
    "frame.max": 25,
    "input.click": 30,
    "input.key": 20,
    "frame.slow": 1,
  });
});

test("tighterLimits names only limits that would drop by more than 10%", () => {
  assert.deepEqual(tighterLimits({ "frame.max": 40, "input.click": 30 }, { "frame.max": 37, "input.click": 20 }), { "input.click": 20 });
});

test("overTargets warns about frames and inputs over 50 ms, not about counts or CPU", () => {
  assert.deepEqual(overTargets({ "frame.max": 72, "input.click": 50, "cpu.main": 300, "frame.long": 3 }), [
    { metric: "frame.max", value: 72, target: 50 },
  ]);
});

test("check reports only metrics over their limit", () => {
  const v = check({ "frame.max": 40, "input.move": 10 }, { "frame.max": 34, "input.move": 34, "input.key": 1 }, "recorded");
  assert.deepEqual(v, [{ metric: "frame.max", value: 40, limit: 34, source: "recorded" }]);
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

test("LimitStore keeps limits sorted next to the spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const store = LimitStore.forSpec(join(dir, "grid.perf.ts"));
  const machine = { cpu: "test", cores: 1, platform: "linux-x64", browser: "chromium 140", headless: true };
  store.set("b", { "frame.max": 1 }, machine);
  store.set("a", { "frame.max": 2 }, machine);
  assert.equal(store.path, join(dir, "__limits__", "grid.perf.ts.json"));
  assert.deepEqual(store.get("a"), { limits: { "frame.max": 2 }, environment: machine });
  assert.deepEqual(LimitStore.forSpec(join(dir, "grid.perf.ts")).get("b")?.limits, { "frame.max": 1 });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(store.path, "utf8")).limits), ["a", "b"]);
});
