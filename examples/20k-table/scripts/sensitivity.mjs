// Finds how large a regression must be before the committed budgets catch it.
// Measures each scenario's input latency on a clean build, then rebuilds with
// src/slowdown.ts adding (factor − 1) × that latency of main-thread work to each
// of the scenario's events, and counts how often the scenario fails per factor.
//
//   node scripts/sensitivity.mjs [--factors 1.25,1.5,2,3,5] [--runs 5] [--baseline-runs 3] [--only sort,filter]

import { parseArgs } from "node:util";
import { build, median, progress, roundTo, runSuite, saveReport } from "./suite.mjs";

const DEFAULT_FACTORS = "1.25,1.5,2,3,5";
const DEFAULT_RUNS = 5;
const DEFAULT_BASELINE_RUNS = 3;
/** A factor counts as caught when the scenario fails at least this share of its runs. */
const CAUGHT_FAILURE_RATE = 0.8;
const TABLE_COLUMN_WIDTH = 16;

/** Each scenario: its test, the event the slowdown is added to, and the latency that slowdown scales. */
const SCENARIOS = [
  { id: "filter", test: "filter as you type", event: "keydown", metric: "input.key" },
  { id: "sort", test: "sort by client", event: "click", metric: "input.click" },
  { id: "resize", test: "resize a column", event: "pointermove", metric: "input.move" },
  { id: "scroll", test: "scroll the grid", event: "wheel", metric: "input.wheel" },
  { id: "detail", test: "open the detail panel", event: "click", metric: "input.click" },
];

const { values: options } = parseArgs({
  options: {
    factors: { type: "string", default: DEFAULT_FACTORS },
    runs: { type: "string", default: String(DEFAULT_RUNS) },
    "baseline-runs": { type: "string", default: String(DEFAULT_BASELINE_RUNS) },
    only: { type: "string" },
  },
});
const factors = options.factors.split(",").map(Number);
const runsPerFactor = Number(options.runs);
const scenarios = SCENARIOS.filter((scenario) => !options.only || options.only.split(",").includes(scenario.id));

const buildWithSlowdown = (event, milliseconds) => build({ VITE_SLOWDOWN: JSON.stringify({ [event]: milliseconds }) });

function measureBaselines() {
  progress("baseline: ");
  build();
  const latencies = Object.fromEntries(scenarios.map((scenario) => [scenario.id, []]));
  for (let run = 0; run < Number(options["baseline-runs"]); run++) {
    const results = runSuite();
    for (const scenario of scenarios) {
      const value = results.find((result) => result.test === scenario.test)?.metrics[scenario.metric];
      if (value !== undefined) latencies[scenario.id].push(value);
    }
    progress(`${run + 1} `);
  }
  return Object.fromEntries(scenarios.map((scenario) => [scenario.id, median(latencies[scenario.id])]));
}

function measureFactor(scenario, factor, baseline) {
  const addedMs = roundTo((factor - 1) * baseline, 1);
  progress(`\n${scenario.id} ×${factor} (+${addedMs} ms per ${scenario.event}): `);
  buildWithSlowdown(scenario.event, addedMs);
  const outcome = { addedMs, runs: 0, failures: 0, failedMetrics: {}, latencies: [], budget: null };
  for (let run = 0; run < runsPerFactor; run++) {
    const result = runSuite(scenario.test).find((candidate) => candidate.test === scenario.test);
    outcome.runs++;
    outcome.budget ??= result.budget?.[scenario.metric] ?? null;
    outcome.latencies.push(result.metrics[scenario.metric]);
    if (result.status === "fail") outcome.failures++;
    for (const violation of result.violations) {
      outcome.failedMetrics[violation.metric] = (outcome.failedMetrics[violation.metric] ?? 0) + 1;
    }
    progress(result.status === "fail" ? "F" : ".");
  }
  return outcome;
}

const report = { date: new Date().toISOString(), factors, runsPerFactor, scenarios: {} };

try {
  const baselines = measureBaselines();
  for (const scenario of scenarios) {
    const entry = { ...scenario, baselineMs: baselines[scenario.id], factors: {} };
    for (const factor of factors) entry.factors[factor] = measureFactor(scenario, factor, entry.baselineMs);
    entry.budgetMs = Object.values(entry.factors)[0]?.budget ?? null;
    report.scenarios[scenario.id] = entry;
  }
} finally {
  build();
}

const reportFile = saveReport("sensitivity", report);

const isCaught = (outcome) => outcome.failures / outcome.runs >= CAUGHT_FAILURE_RATE;
const column = (text) => text.padEnd(TABLE_COLUMN_WIDTH);

console.log("\n");
console.log(column("scenario") + column("baseline→budget") + factors.map((factor) => column(`×${factor}`)).join("") + "caught from");
for (const entry of Object.values(report.scenarios)) {
  const cells = factors.map((factor) => {
    const outcome = entry.factors[factor];
    return column(`${outcome.failures}/${outcome.runs} ${roundTo(median(outcome.latencies), 1)}ms`);
  });
  const caughtFrom = factors.find((factor) => isCaught(entry.factors[factor]));
  console.log(
    column(entry.id) + column(`${roundTo(entry.baselineMs, 1)}→${entry.budgetMs} ms`) + cells.join("") + (caughtFrom ? `×${caughtFrom}` : "never"),
  );
}
console.log("\ncells: failed runs / runs, median input latency reached");
console.log(reportFile);
