// Checks `zerospikes compare` on the example. The clean build compared with
// itself must never come out slower. Builds slowed by src/slowdown.ts must come
// out slower, and the table shows from which factor and after how many sessions.
//
//   node scripts/compare-reliability.mjs [--same-build 3] [--factors 1.1,1.25,1.5,2] [--baseline-runs 3]
//                                        [--sessions n] [--max-sessions n]   (passed on to zerospikes compare)

import { spawn, spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { SLOWDOWN_TARGETS, build, exampleDir, measureLatencies, progress, roundTo, saveReport } from "./suite.mjs";

const DEFAULT_SAME_BUILD_COMPARISONS = 3;
const DEFAULT_FACTORS = "1.1,1.25,1.5,2";
const DEFAULT_BASELINE_RUNS = 3;
const BASELINE_PORT = 4174;
/** The port playwright.config.ts loads; the config reuses a server already listening there. */
const CANDIDATE_PORT = 4173;
const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 250;
const TABLE_COLUMN_WIDTH = 22;
const SCENARIO_NAME_WIDTH = 48;

const { values: options } = parseArgs({
  options: {
    "same-build": { type: "string", default: String(DEFAULT_SAME_BUILD_COMPARISONS) },
    factors: { type: "string", default: DEFAULT_FACTORS },
    "baseline-runs": { type: "string", default: String(DEFAULT_BASELINE_RUNS) },
    sessions: { type: "string" },
    "max-sessions": { type: "string" },
  },
});
const factors = options.factors.split(",").map(Number);

const zerospikesCli = join(dirname(createRequire(import.meta.url).resolve("zerospikes")), "cli.js");
const baselineDist = join(exampleDir, "zerospikes-results", "compare-baseline-dist");
const comparisonFile = join(exampleDir, "zerospikes-results", "compare-latest.json");
const urlOf = (port) => `http://localhost:${port}`;

async function serve(distDir, port) {
  const server = spawn(`npx vite preview --outDir "${distDir}" --port ${port} --strictPort`, { cwd: exampleDir, shell: true, stdio: "ignore" });
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(urlOf(port))).ok) return server;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
  }
  stop(server);
  throw new Error(`The preview server on port ${port} didn't start`);
}

/** Stops a server and the processes it started (npx, vite). */
function stop(server) {
  if (!server?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill("SIGTERM");
}

/** Runs `zerospikes compare` against the served builds; returns its comparisons. */
function compareBuilds(grepTests) {
  const playwrightArgs = grepTests ? ["--", "--grep", grepTests.join("|")] : [];
  const sessionArgs = ["sessions", "max-sessions"].flatMap((name) => (options[name] ? [`--${name}`, options[name]] : []));
  rmSync(comparisonFile, { force: true });
  const run = spawnSync(
    process.execPath,
    [zerospikesCli, "compare", "--baseline", urlOf(BASELINE_PORT), "--candidate", urlOf(CANDIDATE_PORT), "--json", comparisonFile, ...sessionArgs, ...playwrightArgs],
    { cwd: exampleDir, encoding: "utf8" },
  );
  try {
    return JSON.parse(readFileSync(comparisonFile, "utf8")).comparisons;
  } catch {
    throw new Error(`zerospikes compare wrote no comparisons. It said:\n${run.stdout}\n${run.stderr}`);
  }
}

/** Splits targets into groups whose events differ, so one build can slow a whole group down. */
function groupByDistinctEvent(targets) {
  const groups = [];
  for (const target of targets) {
    const group = groups.find((candidate) => candidate.every((other) => other.event !== target.event));
    if (group) group.push(target);
    else groups.push([target]);
  }
  return groups;
}

const summarize = (comparison) => ({
  verdict: comparison.verdict,
  sessions: comparison.sessions.candidate,
  slowerMetrics: comparison.metrics.filter((metric) => metric.verdict === "slower").map((metric) => metric.metric),
});
const report = { date: new Date().toISOString(), factors, sameBuild: [], slowed: {} };
let baselineServer;
let candidateServer;

try {
  progress("baseline: ");
  build();
  cpSync(join(exampleDir, "dist"), baselineDist, { recursive: true });
  const latencies = measureLatencies(SLOWDOWN_TARGETS, Number(options["baseline-runs"]));
  baselineServer = await serve(baselineDist, BASELINE_PORT);

  candidateServer = await serve(join(exampleDir, "dist"), CANDIDATE_PORT);
  for (let i = 0; i < Number(options["same-build"]); i++) {
    progress(`\nsame build ${i + 1}: `);
    const comparisons = compareBuilds(null);
    report.sameBuild.push(Object.fromEntries(comparisons.map((c) => [`${c.test} › ${c.name}`, summarize(c)])));
    progress(comparisons.map((c) => c.verdict).join(" "));
  }
  stop(candidateServer);

  for (const factor of factors) {
    for (const group of groupByDistinctEvent(SLOWDOWN_TARGETS)) {
      const slowdown = Object.fromEntries(group.map((target) => [target.event, roundTo((factor - 1) * latencies[target.id], 1)]));
      progress(`\n×${factor} ${group.map((target) => target.id).join(", ")}: `);
      build({ VITE_SLOWDOWN: JSON.stringify(slowdown) });
      candidateServer = await serve(join(exampleDir, "dist"), CANDIDATE_PORT);
      const comparisons = compareBuilds(group.map((target) => target.test));
      stop(candidateServer);
      for (const target of group) {
        const comparison = comparisons.find((c) => c.test === target.test);
        ((report.slowed[target.id] ??= {})[factor] = comparison ? summarize(comparison) : null);
        progress(`${target.id} ${comparison?.verdict ?? "missing"} `);
      }
    }
  }
} finally {
  stop(baselineServer);
  stop(candidateServer);
  rmSync(baselineDist, { recursive: true, force: true });
  build();
  console.log(`\n${saveReport("compare-reliability", report)}`);
}

const column = (text) => text.padEnd(TABLE_COLUMN_WIDTH);

console.log("\nsame build compared with itself (slower would be a false alarm):");
const scenarioNames = [...new Set(report.sameBuild.flatMap((run) => Object.keys(run)))];
for (const name of scenarioNames) {
  const verdicts = report.sameBuild.map((run) => run[name] ? `${run[name].verdict} (${run[name].sessions})` : "missing");
  console.log(`  ${name.slice(0, SCENARIO_NAME_WIDTH - 1).padEnd(SCENARIO_NAME_WIDTH)}${verdicts.join("  ")}`);
}

console.log("\nslowed builds (verdict, sessions per side):");
console.log("  " + column("scenario") + factors.map((factor) => column(`×${factor}`)).join(""));
for (const [id, byFactor] of Object.entries(report.slowed)) {
  const cells = factors.map((factor) => column(byFactor[factor] ? `${byFactor[factor].verdict} (${byFactor[factor].sessions})` : "—"));
  console.log("  " + column(id) + cells.join(""));
}
