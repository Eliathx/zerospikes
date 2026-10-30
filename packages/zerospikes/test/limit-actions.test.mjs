import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptSlower } from "../dist/limit-actions.js";
import { LimitStore } from "../dist/limits.js";
import { readIndex, recordRun } from "../dist/history.js";

const KEY = "chromium › sort › click";
const machine = { cpu: "test", cores: 1, platform: "linux-x64", browser: "chromium 140", headless: true };

function failedRun(dir, limits) {
  const limitsFile = join(dir, "grid.perf.ts.json");
  new LimitStore(limitsFile).set(KEY, limits, machine);
  const result = {
    kind: "interaction",
    key: KEY,
    test: "sort",
    name: "click",
    project: "chromium",
    metrics: { "cpu.main": 300 },
    limits,
    status: "fail",
    violations: [{ metric: "cpu.main", value: 300, limit: 100, source: "recorded" }],
    environment: machine,
    derived: { "cpu.main": 450 },
    limitsFile,
  };
  recordRun(dir, { date: "2026-10-28T10:00:00.000Z", results: [result] });
  return { limitsFile, entry: readIndex(dir).runs.at(-1) };
}

test("accepting a slower scenario saves the limits its run would have recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const { limitsFile, entry } = failedRun(dir, { "cpu.main": 100 });
  assert.match(acceptSlower(dir, entry, KEY), /Saved the slower numbers/);
  assert.deepEqual(new LimitStore(limitsFile).get(KEY).limits, { "cpu.main": 450 });
});

test("accepting is refused when the limits changed since the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const { limitsFile, entry } = failedRun(dir, { "cpu.main": 100 });
  new LimitStore(limitsFile).set(KEY, { "cpu.main": 90 }, machine);
  assert.match(acceptSlower(dir, entry, KEY), /changed since this run/);
  assert.deepEqual(new LimitStore(limitsFile).get(KEY).limits, { "cpu.main": 90 });
});

test("a run's lower limits no longer apply once the limits were replaced, by another machine's say", async () => {
  const { forgetLimits, pendingTighter } = await import("../dist/limit-actions.js");
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const limitsFile = join(dir, "grid.perf.ts.json");
  const scenario = { status: "pass", metrics: { "cpu.main": 40 }, limits: { "cpu.main": 100 }, tighter: { "cpu.main": 60 }, limitsFile };
  new LimitStore(limitsFile).set(KEY, { "cpu.main": 100 }, machine);
  assert.deepEqual(pendingTighter(KEY, scenario), { "cpu.main": 60 });
  new LimitStore(limitsFile).set(KEY, { "cpu.main": 300 }, { ...machine, cpu: "other" });
  // Changed outside the view: it reads the files again when a new run lands.
  forgetLimits();
  assert.deepEqual(pendingTighter(KEY, scenario), {});
});
