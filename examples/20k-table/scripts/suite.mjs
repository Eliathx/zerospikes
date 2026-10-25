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
  shell(`npx playwright test --update-snapshots=none${testTitle ? ` --grep "${testTitle}"` : ""}`);
  const created = [...suiteResultFiles()].filter((file) => !before.has(file));
  if (created.length !== 1) throw new Error(`Expected one new results file from the suite, found ${created.length}`);
  return JSON.parse(readFileSync(join(resultsDir, created[0]), "utf8")).results;
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
