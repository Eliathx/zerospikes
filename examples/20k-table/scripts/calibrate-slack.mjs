// Checks the slack zerospikes leaves when it records limits (SLACK in the
// library's src/defaults.ts) against sessions of the clean build: every
// session in turn records the limits, and each other session is a check
// that must pass. Prints the false alarms with the shipped values, and the
// smallest values that would give none.
//
//   node scripts/calibrate-slack.mjs [files…]
//
// Files are calibration/*.json (the default) or reports from
// scripts/reliability.mjs, whose clean configuration is used. Sessions on a
// machine busy with something heavy are in calibration/busy: pass them to see
// that no slack covers them.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Not part of the package's API: SLACK and deriveLimits come straight from its build.
import { SLACK } from "../../../packages/zerospikes/dist/defaults.js";
import { deriveLimits } from "../../../packages/zerospikes/dist/limits.js";
import { exampleDir } from "./suite.mjs";

const RATIO_STEP = 0.05;
const MAX_RATIO = 3;
const calibrationDir = join(exampleDir, "calibration");

const files = process.argv.slice(2);
const paths = files.length ? files : readdirSync(calibrationDir).filter((f) => f.endsWith(".json")).map((f) => join(calibrationDir, f));

/** Each scenario's sessions, as { metrics: medians, runs: every measured run }. */
function sessionsOf(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (data.scenarios) return Object.values(data.scenarios);
  return Object.values(data.configurations.clean.scenarios).map((scenario) => scenario.measurements);
}

const datasets = paths.map((path) => ({ path, scenarios: sessionsOf(path) }));

const worstOf = (runs) => {
  const out = {};
  for (const run of runs) for (const [metric, value] of Object.entries(run)) out[metric] = Math.max(out[metric] ?? -Infinity, value);
  return out;
};

/**
 * Reports keep frame gaps only as metrics, so the display frame is taken as
 * the lowest frame.p95 of the session: an idle frame, with nothing to drop.
 */
const frameOf = (session) => Math.min(...(session.runs ?? []).map((run) => run["frame.p95"] ?? Infinity));

/** Memory cycles have no separate runs: their one measurement is the worst. */
const worstOfSession = (session) => (session.runs?.length ? worstOf(session.runs) : session.metrics);

const FAMILY = {
  time: (metric) => /^(frame\.(max|p95)|input\.)/.test(metric),
  cpu: (metric) => metric === "cpu.main",
  count: (metric) => /^frame\.(slow|long)$/.test(metric),
  memory: (metric) => metric.startsWith("memory."),
};

/** False alarms of `family`'s metrics: [failed checks, checks, the metric that failed most]. */
function falseAlarms(family) {
  let failed = 0;
  let checks = 0;
  const byMetric = {};
  for (const { scenarios } of datasets) {
    for (const sessions of scenarios) {
      sessions.forEach((recording, i) => {
        const limits = deriveLimits(worstOfSession(recording), frameOf(recording));
        sessions.forEach((other, j) => {
          if (i === j) return;
          for (const [metric, value] of Object.entries(other.metrics)) {
            if (!FAMILY[family](metric) || limits[metric] === undefined) continue;
            checks++;
            if (value > limits[metric]) {
              failed++;
              byMetric[metric] = (byMetric[metric] ?? 0) + 1;
            }
          }
        });
      });
    }
  }
  const worst = Object.entries(byMetric).sort((a, b) => b[1] - a[1])[0];
  return { failed, checks, worst: worst ? `${worst[0]} ×${worst[1]}` : "" };
}

/** The smallest value of `SLACK[key]` with no false alarm in `family`, searched in steps; SLACK is restored after. */
function smallestRatio(key, family) {
  const shipped = SLACK[key];
  try {
    for (let ratio = 1; ratio <= MAX_RATIO + 1e-9; ratio += RATIO_STEP) {
      SLACK[key] = ratio;
      if (falseAlarms(family).failed === 0) return ratio;
    }
    return null;
  } finally {
    SLACK[key] = shipped;
  }
}

const sessions = datasets.reduce((total, { scenarios }) => total + Math.max(...scenarios.map((s) => s.length)), 0);
console.log(`${sessions} sessions from ${datasets.length} files\n`);
console.log("With the shipped slack:");
for (const family of Object.keys(FAMILY)) {
  const { failed, checks, worst } = falseAlarms(family);
  console.log(`  ${family.padEnd(7)} ${failed}/${checks} checks failed${worst ? `  (most: ${worst})` : ""}`);
}

console.log("\nSmallest ratio with no false alarm:");
const time = smallestRatio("timeRatio", "time");
console.log(`  timeRatio  ${time?.toFixed(2) ?? `none up to ${MAX_RATIO}`}  (shipped ${SLACK.timeRatio}, with ${SLACK.timeFrames} frames)`);
const cpu = smallestRatio("cpuRatio", "cpu");
console.log(`  cpuRatio   ${cpu?.toFixed(2) ?? `none up to ${MAX_RATIO}`}  (shipped ${SLACK.cpuRatio})`);
console.log("\nCounts and memory are only checked: the example's barely vary, too little to fit them on.");
