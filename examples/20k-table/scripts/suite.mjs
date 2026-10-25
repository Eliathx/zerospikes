import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const exampleDir = dirname(import.meta.dirname);
const resultsDir = join(exampleDir, "zerospikes-results");

function shell(command, env = {}) {
  return spawnSync(command, {
    cwd: exampleDir,
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

export function build(env = {}) {
  const result = shell("npm run build", env);
  if (result.status !== 0) throw new Error(`Build failed:\n${result.stdout}\n${result.stderr}`);
}

function suiteResultFiles() {
  try {
    return new Set(readdirSync(resultsDir).filter((file) => file.startsWith("run-")));
  } catch {
    return new Set();
  }
}

/** Runs the perf suite against the committed budgets, never recording; returns the scenario results the reporter saved. */
export function runSuite(testTitle) {
  const before = suiteResultFiles();
  const run = shell(`npx playwright test --update-snapshots=none${testTitle ? ` --grep "${testTitle}"` : ""}`);
  const created = [...suiteResultFiles()].filter((file) => !before.has(file));
  if (created.length !== 1) {
    throw new Error(`Expected one new results file from the suite, found ${created.length}. Playwright said:\n${run.stdout}\n${run.stderr}`);
  }
  return JSON.parse(readFileSync(join(resultsDir, created[0]), "utf8")).results;
}

/**
 * The scenarios src/slowdown.ts can slow down: each one's test, the event the
 * slowdown is added to, and the latency that slowdown scales.
 */
export const SLOWDOWN_TARGETS = [
  { id: "filter", test: "filter as you type", event: "keydown", metric: "input.key" },
  { id: "sort", test: "sort by client", event: "click", metric: "input.click" },
  { id: "resize", test: "resize a column", event: "pointermove", metric: "input.move" },
  { id: "scroll", test: "scroll the grid", event: "wheel", metric: "input.wheel" },
  { id: "detail", test: "open the detail panel", event: "click", metric: "input.click" },
];

/** Median latency of each target over `runs` suite runs of the current build: target id → ms. */
export function measureLatencies(targets, runs) {
  const latencies = Object.fromEntries(targets.map((target) => [target.id, []]));
  for (let run = 0; run < runs; run++) {
    const results = runSuite();
    for (const target of targets) {
      const value = results.find((result) => result.test === target.test)?.metrics[target.metric];
      if (value !== undefined) latencies[target.id].push(value);
    }
    progress(`${run + 1} `);
  }
  return Object.fromEntries(targets.map((target) => [target.id, median(latencies[target.id])]));
}

export function saveReport(name, report) {
  mkdirSync(resultsDir, { recursive: true });
  const file = join(resultsDir, `${name}-${report.date.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

export const progress = (text) => process.stdout.write(text);

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const roundTo = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;
