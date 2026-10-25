import { test } from "node:test";
import assert from "node:assert/strict";
import { compareMetrics, holm, mannWhitneyGreater, scenarioVerdict } from "../dist/compare-stats.js";

const thresholds = { alpha: 0.05, minChange: 0.1, minDelta: () => 2 };

test("mannWhitneyGreater: complete separation has probability 1 in C(m+n, m)", () => {
  assert.equal(mannWhitneyGreater([1, 2, 3], [4, 5, 6]), 1 / 20);
  assert.equal(mannWhitneyGreater([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]), 1 / 252);
});

test("mannWhitneyGreater: a candidate below the baseline is no evidence of slower", () => {
  assert.equal(mannWhitneyGreater([4, 5, 6], [1, 2, 3]), 1);
});

test("mannWhitneyGreater: ties don't count as slower", () => {
  assert.equal(mannWhitneyGreater([5, 5, 5], [5, 5, 5]), 1);
});

test("holm multiplies the smallest p by the number of tests and keeps the order", () => {
  assert.deepEqual(holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
});

test("compareMetrics: clear and large is slower", () => {
  const [c] = compareMetrics({ "cpu.main": [20, 21, 19, 20, 22] }, { "cpu.main": [30, 31, 29, 32, 30] }, thresholds);
  assert.equal(c.verdict, "slower");
  assert.equal(c.candidate, 30);
});

test("compareMetrics: clear but smaller than minChange or minDelta is the same", () => {
  const relative = compareMetrics({ "cpu.main": [100, 100, 100, 100, 100] }, { "cpu.main": [105, 105, 105, 105, 105] }, thresholds);
  const absolute = compareMetrics({ "input.click": [5, 5, 5, 5, 5] }, { "input.click": [6, 6, 6, 6, 6] }, thresholds);
  assert.equal(relative[0].verdict, "same");
  assert.equal(absolute[0].verdict, "same");
});

test("compareMetrics: large but overlapping is inconclusive", () => {
  const [c] = compareMetrics({ "cpu.main": [20, 35, 22, 40, 25] }, { "cpu.main": [30, 24, 38, 26, 33] }, thresholds);
  assert.equal(c.verdict, "inconclusive");
});

test("scenarioVerdict: slower wins over inconclusive, inconclusive over same", () => {
  assert.equal(scenarioVerdict([{ verdict: "same" }, { verdict: "inconclusive" }, { verdict: "slower" }]), "slower");
  assert.equal(scenarioVerdict([{ verdict: "same" }, { verdict: "inconclusive" }]), "inconclusive");
  assert.equal(scenarioVerdict([{ verdict: "same" }]), "same");
});
