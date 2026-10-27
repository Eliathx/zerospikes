import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { compare, type ScenarioComparison } from "./compare.js";
import { unitOf } from "./budgets.js";
import type { MetricName } from "./types.js";

export const COMPARE_USAGE = `Usage: zerospikes compare --baseline <url> --candidate <url> [options] [-- playwright args]

Runs the perf suite against two served builds in alternating sessions and
reports, per scenario, whether the candidate is slower, the same, or still
inconclusive.

  --baseline <url>          The build to compare against, already served
  --candidate <url>         The build under test, already served
  --sessions <n>            Sessions per side before deciding (default 5)
  --max-sessions <n>        Sessions per side at most for inconclusive scenarios (default 10)
  --min-change <ratio>      Smallest slowdown worth failing for, 0.1 = 10% (default 0.1)
  --alpha <p>               Accepted chance of a false alarm per scenario (default 0.05)
  --fail-on-inconclusive    Exit 1 when a scenario stays inconclusive, not only when slower
  --json <file>             Also write the comparisons to a JSON file`;

const DEFAULTS = { sessions: 5, maxSessions: 10, minChange: 0.1, alpha: 0.05 };

/** Smallest absolute slowdown worth failing for, by unit: a 10% change of a 3 ms interaction is noise. */
const MIN_DELTA_BY_UNIT: Record<string, number> = { " ms": 2, " MB": 1, "": 1 };

export const EXIT = { same: 0, slower: 1, usage: 2 } as const;

export function runCompareCommand(rest: string[]): never {
  const separator = rest.indexOf("--");
  const { values } = parseArgs({
    args: separator === -1 ? rest : rest.slice(0, separator),
    options: {
      baseline: { type: "string" },
      candidate: { type: "string" },
      sessions: { type: "string", default: String(DEFAULTS.sessions) },
      "max-sessions": { type: "string", default: String(DEFAULTS.maxSessions) },
      "min-change": { type: "string", default: String(DEFAULTS.minChange) },
      alpha: { type: "string", default: String(DEFAULTS.alpha) },
      "fail-on-inconclusive": { type: "boolean", default: false },
      json: { type: "string" },
    },
  });
  if (!values.baseline || !values.candidate) {
    console.error(COMPARE_USAGE);
    process.exit(EXIT.usage);
  }

  const comparisons = compare({
    baseline: values.baseline,
    candidate: values.candidate,
    sessions: Number(values.sessions),
    maxSessions: Number(values["max-sessions"]),
    thresholds: {
      alpha: Number(values.alpha),
      minChange: Number(values["min-change"]),
      minDelta: (metric) => MIN_DELTA_BY_UNIT[unitOf(metric as MetricName)],
    },
    playwrightArgs: separator === -1 ? [] : rest.slice(separator + 1),
    cwd: process.cwd(),
    onSession: (side, round) => process.stdout.write(`\r  session ${round + 1} ${side}…   `),
  });

  console.log("\n" + formatComparisons(comparisons));
  if (values.json) {
    writeFileSync(values.json, JSON.stringify({ baseline: values.baseline, candidate: values.candidate, comparisons }, null, 2));
  }
  const slower = comparisons.some((c) => c.verdict === "slower");
  const inconclusive = comparisons.some((c) => c.verdict === "inconclusive");
  process.exit(slower || (inconclusive && values["fail-on-inconclusive"]) ? EXIT.slower : EXIT.same);
}

function formatComparisons(list: ScenarioComparison[]): string {
  const label = { slower: "SLOWER", same: "SAME  ", inconclusive: "UNSURE" } as const;
  const lines: string[] = [];
  for (const c of list) {
    lines.push(`  ${label[c.verdict]}  ${c.test} › ${c.name}  (${c.sessions.baseline} vs ${c.sessions.candidate} sessions)`);
    const shown = c.verdict === "same" ? [] : c.metrics.filter((m) => m.verdict !== "same");
    for (const m of shown) {
      const unit = unitOf(m.metric as MetricName);
      const change = `${m.change >= 0 ? "+" : ""}${Math.round(m.change * 100)}%`;
      lines.push(`      ${m.metric.padEnd(14)} ${m.baseline}${unit} → ${m.candidate}${unit}  ${change}  p ${m.pValue.toFixed(3)}`);
    }
  }
  return lines.join("\n");
}
