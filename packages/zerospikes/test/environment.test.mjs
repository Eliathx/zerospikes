import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayRateOf, environmentDifferences, environmentId } from "../dist/environment.js";
import { LimitStore } from "../dist/limits.js";
import { describeRuntime } from "../dist/connect.js";

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

test("LimitStore records where each scenario's limits were recorded and drops machines no scenario uses", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-"));
  const store = LimitStore.forSpec(join(dir, "grid.perf.ts"));
  const ci = { ...pc, cpu: "AMD EPYC 7763", cores: 4, platform: "linux-x64" };
  store.set("a", { "frame.max": 41 }, pc);
  store.set("a", { "frame.max": 60 }, ci);
  const file = JSON.parse(readFileSync(store.path, "utf8"));
  assert.equal(file.version, 1);
  assert.deepEqual(Object.values(file.environments), [ci]);
  assert.deepEqual(store.get("a"), { limits: { "frame.max": 60 }, environment: ci });
});

test("describeRuntime tells WebView2, Electron and Chrome apart", () => {
  const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
  assert.deepEqual(describeRuntime({ userAgent: edge, webview2: true }), { name: "webview2", headless: false });
  assert.deepEqual(describeRuntime({ userAgent: `${edge} Electron/33.0.0`, webview2: false }), { name: "electron", headless: false });
  assert.deepEqual(describeRuntime({ userAgent: "Mozilla/5.0 HeadlessChrome/130.0.0.0", webview2: false }), { name: "chromium", headless: true });
});
