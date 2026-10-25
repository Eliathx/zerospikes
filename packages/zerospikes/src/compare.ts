import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareMetrics, scenarioVerdict, type CompareThresholds, type MetricComparison, type Verdict } from "./compare-stats.js";
import { SESSION_ENV } from "./session.js";
import type { Metrics, ScenarioResult } from "./types.js";

export type Side = "baseline" | "candidate";

export interface CompareOptions {
  baseline: string;
  candidate: string;
  /** Sessions per side before deciding. */
  sessions: number;
  /** Sessions per side at most, for scenarios still inconclusive. */
  maxSessions: number;
  thresholds: CompareThresholds;
  /** Arguments passed on to `playwright test`, such as a project or a file. */
  playwrightArgs: string[];
  /** The project folder: where `playwright test` runs. */
  cwd: string;
  /** Called after each session, for progress output. */
  onSession?: (side: Side, round: number, scenarios: number) => void;
}

export interface ScenarioComparison {
  key: string;
  test: string;
  name: string;
  verdict: Verdict;
  sessions: Record<Side, number>;
  metrics: MetricComparison[];
}

/** Each scenario's session medians, per side: scenario key → metric → one value per session. */
type Samples = Map<string, { test: string; name: string } & Record<Side, Record<string, number[]>>>;

/**
 * Runs the Playwright suite against the baseline and the candidate in
 * alternating sessions (ABBA, so a machine slowly getting busier weighs on both
 * alike), compares each scenario's session medians, and runs more sessions for
 * the scenarios still inconclusive, up to `maxSessions`.
 */
export function compare(options: CompareOptions): ScenarioComparison[] {
  const samples: Samples = new Map();
  const workDir = join(options.cwd, "zerospikes-results", `compare-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const playwrightCli = createRequire(join(options.cwd, "package.json")).resolve("@playwright/test/cli");

  const runSession = (side: Side, round: number, tests: string[] | null) => {
    const resultsFile = join(workDir, `${round}-${side}.json`);
    // Last, so it narrows a --grep of the user's to the tests still pending.
    const grep = tests ? ["--grep", tests.map(escapeRegExp).join("|")] : [];
    const result = spawnSync(process.execPath, [playwrightCli, "test", `--reporter=${reporterPath()}`, ...options.playwrightArgs, ...grep], {
      cwd: options.cwd,
      encoding: "utf8",
      env: { ...process.env, [SESSION_ENV.resultsFile]: resultsFile, [SESSION_ENV.baseURL]: options[side] },
    });
    let results: ScenarioResult[];
    try {
      results = (JSON.parse(readFileSync(resultsFile, "utf8")) as { results: ScenarioResult[] }).results;
    } catch {
      throw new Error(`zerospikes compare: the ${side} session produced no results.\n${result.stdout}\n${result.stderr}`);
    }
    for (const r of results) {
      const entry = samples.get(r.key) ?? { test: r.test, name: r.name, baseline: {}, candidate: {} };
      for (const [metric, value] of Object.entries(r.metrics as Metrics)) (entry[side][metric] ??= []).push(value);
      samples.set(r.key, entry);
    }
    options.onSession?.(side, round, results.length);
  };

  const runRound = (round: number, tests: string[] | null) => {
    const order: Side[] = round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const side of order) runSession(side, round, tests);
  };

  let round = 0;
  for (; round < options.sessions; round++) runRound(round, null);
  let comparisons = compareAll(samples, options.thresholds);
  for (; round < options.maxSessions; round++) {
    const pending = comparisons.filter((c) => c.verdict === "inconclusive");
    if (!pending.length) break;
    runRound(round, [...new Set(pending.map((c) => c.test))]);
    comparisons = compareAll(samples, options.thresholds);
  }
  rmSync(workDir, { recursive: true, force: true });
  return comparisons;
}

function compareAll(samples: Samples, thresholds: CompareThresholds): ScenarioComparison[] {
  return [...samples].map(([key, s]) => {
    const metrics = compareMetrics(s.baseline, s.candidate, thresholds);
    const sessions = { baseline: sessionCount(s.baseline), candidate: sessionCount(s.candidate) };
    return { key, test: s.test, name: s.name, verdict: scenarioVerdict(metrics), sessions, metrics };
  });
}

const sessionCount = (metrics: Record<string, number[]>) => Math.max(0, ...Object.values(metrics).map((values) => values.length));

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const reporterPath = () => fileURLToPath(new URL("./reporter.js", import.meta.url));
