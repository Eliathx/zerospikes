import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY, onKey, screen } from "../dist/history-command.js";
import { formatChange, scenarioHistories, scenarioList } from "../dist/history-view.js";
import { sparkline } from "../dist/terminal.js";

const NOISE = 0.1;
const WIDE = 140;
const SORT = "chromium › sort › click";
const FILTER = "chromium › filter › type";
const run = (date, branch, sortCpu, status = "pass") => ({
  date,
  git: { commit: "ae42f99aaaaaaa", branch, dirty: false },
  file: "runs-0001.ndjson.br",
  scenarios: {
    [SORT]: { status, metrics: { "cpu.main": sortCpu, "frame.max": 40 }, budget: { "cpu.main": 100, "frame.max": 51 } },
    [FILTER]: { status: "pass", metrics: { "cpu.main": 30 }, budget: null },
  },
});
const runs = [run("2026-10-25T10:00:00.000Z", "main", 60), run("2026-10-26T10:00:00.000Z", "main", 62), run("2026-10-27T10:00:00.000Z", "feat", 90, "fail")];

test("sparkline spreads values from the lowest to the highest, and stays flat within noise", () => {
  assert.equal(sparkline([10, 20, 30], NOISE), "▁▅█");
  assert.equal(sparkline([100, 103, 98], NOISE), "▄▄▄");
});

test("formatChange gives the change as a signed percentage", () => {
  assert.equal(formatChange(90, 60), "+50%");
  assert.equal(formatChange(61, 60), "+2%");
  assert.equal(formatChange(60, undefined), "—");
});

test("the scenario list shows each scenario's latest status, value and change, without a lone project's name", () => {
  const lines = scenarioList(scenarioHistories(runs), 0, WIDE);
  const sort = lines.find((line) => line.includes("sort › click"));
  assert.ok(!sort.includes("chromium"));
  assert.match(sort, /FAIL/);
  assert.match(sort, /90 ms/);
  assert.match(sort, /\+45%/);
});

test("keys move the selection, open a scenario, filter by branch and quit", () => {
  const state = { runs, selected: 0, selectedMetric: 0 };
  onKey(state, KEY.down);
  assert.equal(state.selected, 1);
  onKey(state, KEY.enter);
  assert.equal(state.openKey, SORT);
  assert.match(screen(state, WIDE, Infinity), /Recent runs · cpu\.main/);
  onKey(state, KEY.down);
  assert.match(screen(state, WIDE, Infinity), /Recent runs · frame\.max/);
  onKey(state, KEY.escape);
  assert.equal(state.openKey, undefined);
  onKey(state, "b");
  assert.equal(state.branch, "feat");
  assert.match(screen(state, WIDE, Infinity), /1 run · feat/);
  assert.equal(onKey(state, "q"), "quit");
});
