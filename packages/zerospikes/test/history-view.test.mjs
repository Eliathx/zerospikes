import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY, onKey, screen } from "../dist/history-command.js";
import { scenarioHistories, scenarioList } from "../dist/history-view.js";
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
  assert.equal(sparkline([10, 20, 30], NOISE), "▁▄▆");
  assert.equal(sparkline([100, 103, 98], NOISE), "▃▃▃");
});

test("the scenario list shows each scenario's latest status, without a lone project's name", () => {
  const lines = scenarioList(scenarioHistories(runs), 0, WIDE);
  assert.match(lines[0], /Scenario\s+Status\s*$/);
  const sort = lines.find((line) => line.includes("sort › click"));
  assert.ok(!sort.includes("chromium"));
  assert.match(sort, /FAIL\s+2\/2/);
  assert.doesNotMatch(sort, /cpu\.main|ms/);
});

test("keys move the selection, open a scenario, filter by branch and quit", () => {
  const state = { dir: ".", runs, selected: 0, selectedMetric: 0 };
  onKey(state, KEY.down);
  assert.equal(state.selected, 1);
  onKey(state, KEY.enter);
  assert.equal(state.openKey, SORT);
  assert.match(screen(state, WIDE, Infinity), /cpu\.main · 3 runs/);
  onKey(state, KEY.down);
  assert.match(screen(state, WIDE, Infinity), /frame\.max · 3 runs/);
  onKey(state, KEY.escape);
  assert.equal(state.openKey, undefined);
  onKey(state, "b");
  assert.equal(state.branch, "feat");
  assert.match(screen(state, WIDE, Infinity), /1 run · feat/);
  assert.equal(onKey(state, "q"), "quit");
});

test("t lowers the budgets the latest run beat, and only lowers", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { BudgetStore } = await import("../dist/budgets.js");
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const budgetFile = join(dir, "grid.perf.ts.json");
  const machine = { cpu: "test", cores: 1, platform: "linux-x64", browser: "chromium 140", headless: true };
  new BudgetStore(budgetFile).set(SORT, { "cpu.main": 100, "frame.max": 51 }, machine);
  const latest = run("2026-10-28T10:00:00.000Z", "main", 40);
  latest.scenarios[SORT] = { ...latest.scenarios[SORT], tighter: { "cpu.main": 60 }, budgetFile };
  const state = { dir, runs: [...runs, latest], selected: 0, selectedMetric: 0 };
  assert.match(screen(state, WIDE, Infinity), /1 test got faster than its budget\.\n\s+Press t to lower it/);
  onKey(state, "t");
  assert.match(state.message, /Lowered cpu\.main/);
  assert.deepEqual(JSON.parse(readFileSync(budgetFile, "utf8")).budgets[SORT], { "cpu.main": 60, "frame.max": 51 });
  assert.doesNotMatch(screen(state, WIDE, Infinity), /got faster/);
});

test("w asks before accepting a failed scenario, and any key but y keeps the budget", () => {
  const state = { dir: ".", runs, selected: 1, selectedMetric: 0 };
  onKey(state, KEY.enter);
  assert.equal(state.openKey, SORT);
  assert.match(screen(state, WIDE, Infinity), /If that's on purpose, press w/);
  onKey(state, "w");
  assert.equal(state.confirming, SORT);
  assert.match(screen(state, WIDE, Infinity), /Save the last run's numbers/);
  onKey(state, "n");
  assert.equal(state.confirming, undefined);
  assert.equal(state.message, "Kept the budget as it was.");
});

test("an open scenario lists its metrics on the left and the selected one's runs on the right, ← → moving between them", () => {
  const state = { dir: ".", runs, selected: 1, selectedMetric: 0 };
  onKey(state, KEY.enter);
  const lines = screen(state, WIDE, Infinity).split("\n");
  assert.match(lines.find((line) => line.includes("Metric")), /│ +Metric.*Last.*Budget +│ │/);
  assert.match(lines.find((line) => line.includes("Date")), /│ │ +Date.*Commit.*Branch.*cpu\.main.*Budget then +│/);
  // The runs pane speaks of this metric alone: the scenario failed in its last run, but not on cpu.main.
  assert.doesNotMatch(lines.slice(3).join("\n"), /FAIL|PASS/);
  const runsPane = lines.map((line) => line.split("│")[3] ?? "").join("\n");
  assert.equal((runsPane.match(/ms {2,}100 ms/g) ?? []).length, 3);
  onKey(state, KEY.right);
  assert.equal(state.focus, "runs");
  onKey(state, KEY.down);
  onKey(state, KEY.down);
  onKey(state, KEY.down);
  assert.equal(state.selectedRun, 2);
  assert.equal(state.selectedMetric, 0);
  onKey(state, KEY.left);
  onKey(state, KEY.down);
  assert.equal(state.selectedMetric, 1);
  assert.equal(state.selectedRun, 0, "another metric starts its runs from the newest");
  onKey(state, KEY.escape);
  assert.equal(state.openKey, undefined);
});

test("a narrow terminal puts the runs under the metrics", () => {
  const state = { dir: ".", runs, selected: 1, selectedMetric: 0 };
  onKey(state, KEY.enter);
  const shown = screen(state, 80, Infinity);
  assert.doesNotMatch(shown, /Metric.*Date/);
  assert.match(shown, /Metric[\s\S]*└─+┘\n\s+┌─+┐\n[^\n]*cpu\.main · 3 runs/);
});

test("a scenario the latest run didn't measure goes last, greyed, with when it last ran", () => {
  const dropped = run("2026-10-28T10:00:00.000Z", "main", 50);
  delete dropped.scenarios[FILTER];
  const lines = scenarioList(scenarioHistories([...runs, dropped]), -1, WIDE);
  assert.match(lines[1], /sort › click\s+PASS/);
  assert.match(lines[2], /filter › type\s+\d+ (min|h|d) ago|filter › type\s+just now/);
});

test("space opens a scenario's metrics as a tree under it, and the selection keeps to the scenarios", () => {
  const state = { dir: ".", runs, selected: 1, selectedMetric: 0 };
  onKey(state, KEY.space);
  const shown = screen(state, WIDE, Infinity);
  assert.match(shown, /sort › click[^\n]*\n\s+├ cpu\.main   90 \/ 100 ms\n\s+└ frame\.max  40 \/  51 ms/);
  onKey(state, KEY.up);
  assert.equal(state.selected, 0);
  onKey(state, KEY.down);
  onKey(state, KEY.space);
  assert.doesNotMatch(screen(state, WIDE, Infinity), /├/);
});
