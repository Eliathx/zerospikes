import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayRateOf, environmentDifferences, environmentId } from "../dist/environment.js";
import { BudgetStore } from "../dist/budgets.js";

const pc = { cpu: "AMD Ryzen 5 3600", cores: 12, platform: "win32-x64", browser: "chromium 140", headless: true };

test("environmentDifferences names each field that changed", () => {
  assert.deepEqual(environmentDifferences(pc, pc), []);
  assert.deepEqual(environmentDifferences(pc, { ...pc, cpu: "AMD EPYC 7763", cores: 4 }), [
    "cpu: AMD Ryzen 5 3600 → AMD EPYC 7763",
    "cores: 12 → 4",
  ]);
});

test("environmentDifferences compares display rates only when both runs had a display", () => {
  assert.deepEqual(environmentDifferences({ ...pc, displayHz: 165 }, pc), []);
  assert.deepEqual(environmentDifferences({ ...pc, displayHz: 165 }, { ...pc, displayHz: 60 }), ["displayHz: 165 → 60"]);
});

test("displayRateOf snaps a measured frame interval to a display rate", () => {
  assert.equal(displayRateOf(16.9), 60);
  assert.equal(displayRateOf(6.1), 165);
  assert.equal(displayRateOf(8.4), 120);
});

test("environmentId is stable and tells machines apart", () => {
  assert.equal(environmentId(pc), environmentId({ ...pc }));
  assert.notEqual(environmentId(pc), environmentId({ ...pc, cores: 4 }));
});

test("BudgetStore reads version 1 files, whose budgets have no machine", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  mkdirSync(join(dir, "__budgets__"));
  writeFileSync(join(dir, "__budgets__", "grid.perf.ts.json"), JSON.stringify({ version: 1, budgets: { a: { "frame.max": 41 } } }));
  assert.deepEqual(new BudgetStore(join(dir, "grid.perf.ts")).get("a"), { budget: { "frame.max": 41 }, environment: undefined });
});

test("BudgetStore records where each budget was recorded and drops machines no budget uses", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const store = new BudgetStore(join(dir, "grid.perf.ts"));
  const ci = { ...pc, cpu: "AMD EPYC 7763", cores: 4, platform: "linux-x64" };
  store.set("a", { "frame.max": 41 }, pc);
  store.set("a", { "frame.max": 60 }, ci);
  const file = JSON.parse(readFileSync(store.path, "utf8"));
  assert.equal(file.version, 2);
  assert.deepEqual(Object.values(file.environments), [ci]);
  assert.deepEqual(store.get("a"), { budget: { "frame.max": 60 }, environment: ci });
});
