import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptSlower } from "../dist/budget-actions.js";
import { BudgetStore } from "../dist/budgets.js";
import { readIndex, recordRun } from "../dist/history.js";

const KEY = "chromium › sort › click";
const machine = { cpu: "test", cores: 1, platform: "linux-x64", browser: "chromium 140", headless: true };

function failedRun(dir, budget) {
  const budgetFile = join(dir, "grid.perf.ts.json");
  new BudgetStore(budgetFile).set(KEY, budget, machine);
  const result = {
    kind: "interaction",
    key: KEY,
    test: "sort",
    name: "click",
    project: "chromium",
    metrics: { "cpu.main": 300 },
    budget,
    status: "fail",
    violations: [{ metric: "cpu.main", value: 300, limit: 100, source: "budget" }],
    environment: machine,
    derived: { "cpu.main": 450 },
    budgetFile,
  };
  recordRun(dir, { date: "2026-10-28T10:00:00.000Z", results: [result] });
  return { budgetFile, entry: readIndex(dir).runs.at(-1) };
}

test("accepting a slower scenario saves the budget its run would have recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const { budgetFile, entry } = failedRun(dir, { "cpu.main": 100 });
  assert.match(acceptSlower(dir, entry, KEY), /Saved the slower numbers/);
  assert.deepEqual(new BudgetStore(budgetFile).get(KEY).budget, { "cpu.main": 450 });
});

test("accepting is refused when the budget changed since the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const { budgetFile, entry } = failedRun(dir, { "cpu.main": 100 });
  new BudgetStore(budgetFile).set(KEY, { "cpu.main": 90 }, machine);
  assert.match(acceptSlower(dir, entry, KEY), /changed since this run/);
  assert.deepEqual(new BudgetStore(budgetFile).get(KEY).budget, { "cpu.main": 90 });
});

test("a run's lower limits no longer apply once the budget was replaced, by another machine's say", async () => {
  const { pendingTighter } = await import("../dist/budget-actions.js");
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const budgetFile = join(dir, "grid.perf.ts.json");
  const scenario = { status: "pass", metrics: { "cpu.main": 40 }, budget: { "cpu.main": 100 }, tighter: { "cpu.main": 60 }, budgetFile };
  new BudgetStore(budgetFile).set(KEY, { "cpu.main": 100 }, machine);
  assert.deepEqual(pendingTighter(KEY, scenario), { "cpu.main": 60 });
  new BudgetStore(budgetFile).set(KEY, { "cpu.main": 300 }, { ...machine, cpu: "other" });
  assert.deepEqual(pendingTighter(KEY, scenario), {});
});
