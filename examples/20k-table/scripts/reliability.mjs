// Checks how far the committed limits can be trusted. With no mistake on, every
// failure is a false alarm. With one mistake on, the scenario it slows down must
// fail and every other scenario must pass.
//
//   node scripts/reliability.mjs [--clean-runs 20] [--mistake-runs 5] [--only clean,sort]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { build, exampleDir, median, progress, runSuite, saveReport } from "./suite.mjs";

const DEFAULT_CLEAN_RUNS = 20;
const DEFAULT_MISTAKE_RUNS = 5;
const NO_MISTAKE = "clean";
const EXIT_CODE_INTERRUPTED = 130;

/** Each mistake in src/mistakes.ts and the test it should make fail. */
const MISTAKE_TARGETS = {
  filter: "filter as you type",
  sort: "sort by client",
  resize: "resize a column",
  leak: "memory when opening and closing details",
};

const { values: options } = parseArgs({
  options: {
    "clean-runs": { type: "string", default: String(DEFAULT_CLEAN_RUNS) },
    "mistake-runs": { type: "string", default: String(DEFAULT_MISTAKE_RUNS) },
    only: { type: "string" },
  },
});

const configurations = [
  { name: NO_MISTAKE, mistake: null, runs: Number(options["clean-runs"]) },
  ...Object.keys(MISTAKE_TARGETS).map((mistake) => ({ name: mistake, mistake, runs: Number(options["mistake-runs"]) })),
].filter((configuration) => !options.only || options.only.split(",").includes(configuration.name));

// Mistakes are switched on by editing src/mistakes.ts, exactly as a developer would.
const mistakesFile = join(exampleDir, "src", "mistakes.ts");
const originalMistakes = readFileSync(mistakesFile, "utf8");
const restoreMistakes = () => writeFileSync(mistakesFile, originalMistakes);
process.on("SIGINT", () => {
  restoreMistakes();
  process.exit(EXIT_CODE_INTERRUPTED);
});

function buildWithMistake(mistake) {
  const source = mistake ? originalMistakes.replace(new RegExp(`^(\\s*${mistake}): false,`, "m"), "$1: true,") : originalMistakes;
  writeFileSync(mistakesFile, source);
  build();
}

function emptyTally(test) {
  return { test, runs: 0, failures: 0, failedMetrics: {}, limitsUse: {}, measurements: [] };
}

/**
 * Adds one run of a scenario: whether it failed, which metrics failed, value ÷ limit
 * for each metric, and the raw measurements, so other limit rules can be tried on them later.
 */
function tally(scenario, result) {
  scenario.runs++;
  scenario.measurements.push({ metrics: result.metrics, runs: result.runs, samples: result.samples });
  if (result.status === "fail") scenario.failures++;
  for (const violation of result.violations) {
    scenario.failedMetrics[violation.metric] = (scenario.failedMetrics[violation.metric] ?? 0) + 1;
  }
  for (const [metric, value] of Object.entries(result.metrics)) {
    const limit = result.limits?.[metric];
    if (limit) (scenario.limitsUse[metric] ??= []).push(value / limit);
  }
}

const report = { date: new Date().toISOString(), configurations: {} };

try {
  for (const configuration of configurations) {
    progress(`\n${configuration.name}: `);
    buildWithMistake(configuration.mistake);
    const scenarios = {};
    report.configurations[configuration.name] = { ...configuration, scenarios };
    for (let run = 0; run < configuration.runs; run++) {
      for (const result of runSuite()) {
        tally((scenarios[`${result.test} › ${result.name}`] ??= emptyTally(result.test)), result);
      }
      progress(`${run + 1} `);
    }
  }
} finally {
  restoreMistakes();
  build();
  // Saved even when a run fails partway, so the runs already made aren't lost.
  console.log(`\n${saveReport("reliability", report)}`);
}

const percent = (ratio) => `${Math.round(ratio * 100)}%`;

/** The metric that came closest to its limit, as "metric 66% (worst 80%)". */
function closestToLimit(limitsUse) {
  const [metric, ratios] = Object.entries(limitsUse).sort(([, a], [, b]) => median(b) - median(a))[0] ?? [];
  return metric ? `${metric} ${percent(median(ratios))} (worst ${percent(Math.max(...ratios))})` : "no limits";
}

console.log("\n");
for (const configuration of Object.values(report.configurations)) {
  const target = configuration.mistake && MISTAKE_TARGETS[configuration.mistake];
  console.log(
    target
      ? `${configuration.name} on, ${configuration.runs} runs: only «${target}» should fail`
      : `${configuration.name}, ${configuration.runs} runs: every failure is a false alarm`,
  );
  for (const [name, scenario] of Object.entries(configuration.scenarios)) {
    const marker = scenario.test === target ? "  ← should fail" : "";
    const failedMetrics = Object.entries(scenario.failedMetrics).map(([metric, count]) => `${metric}×${count}`).join(" ");
    console.log(`  ${scenario.failures}/${scenario.runs} failed  ${name}${marker}${failedMetrics ? `  [${failedMetrics}]` : ""}`);
    console.log(`      closest to limit: ${closestToLimit(scenario.limitsUse)}`);
  }
  console.log("");
}
