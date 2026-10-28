import { existsSync } from "node:fs";
import { relative } from "node:path";
import { BudgetStore } from "./budgets.js";
import { readRun, type IndexedRun, type IndexedScenario } from "./history.js";
import { metricNames } from "./stats.js";
import { bold, cyan } from "./terminal.js";
import type { Metrics } from "./types.js";

/**
 * Budget changes the history view makes from a finished run, so a scenario
 * doesn't have to be measured again to save what was just measured: lowering a
 * budget the run beat, or accepting a scenario that is slower on purpose.
 */

const sameLimits = (a: Metrics | null | undefined, b: Metrics | null | undefined) =>
  !!a && !!b && metricNames(a).length === metricNames(b).length && metricNames(a).every((metric) => a[metric] === b[metric]);

/** What a change saved, in the actions' colour, ending on the budgets file it changed, bold so it stands out. */
const saved = (what: string, path: string) => `${cyan(`${what} in`)} ${bold(cyan(relative(process.cwd(), path) || path))}`;

/** The scenario's budget in its file now, which a `t` or `w` may have changed since the run. */
export function currentBudget(key: string, scenario: IndexedScenario): Metrics | undefined {
  return scenario.budgetFile && existsSync(scenario.budgetFile) ? new BudgetStore(scenario.budgetFile).get(key)?.budget : undefined;
}

export interface Outcome {
  done: boolean;
  message: string;
}

/**
 * The run's tighter limits, while the budget in the file is still the one the
 * run was checked against. Once lowered, or replaced since (another machine's,
 * pulled from git), the run says nothing about it any more.
 */
export function pendingTighter(key: string, scenario: IndexedScenario): Metrics {
  return scenario.tighter && sameLimits(currentBudget(key, scenario), scenario.budget) ? scenario.tighter : {};
}

/** Lowers each limit the run beat to what it would record now. */
export function applyTighter(key: string, scenario: IndexedScenario): Outcome {
  const pending = pendingTighter(key, scenario);
  if (!metricNames(pending).length) return { done: false, message: "Nothing to lower." };
  const store = new BudgetStore(scenario.budgetFile!);
  const stored = store.get(key)!;
  // Budgets from before machines were stored have none to keep.
  if (!stored.environment) return { done: false, message: "This budget doesn't say which machine it's from: use npx playwright test -u." };
  store.set(key, { ...stored.budget, ...pending }, stored.environment);
  return { done: true, message: saved(`Lowered ${metricNames(pending).join(", ")}`, store.path) };
}

/**
 * Saves the budget `run` would have recorded for a scenario that failed in it,
 * as `ZS_ALLOW_WORSE=1 … -u` would. Refused when the budget changed since that
 * run, since the run was judged against the old one.
 */
export function acceptSlower(dir: string, entry: IndexedRun, key: string): string {
  const result = readRun(dir, entry)?.results.find((r) => r.key === key);
  if (!result?.derived || !result.budgetFile || !result.environment) {
    return "This run didn't save a budget to accept: run the tests again with this version of zerospikes.";
  }
  const store = new BudgetStore(result.budgetFile);
  if (!sameLimits(store.get(key)?.budget, result.budget)) {
    return "The budget changed since this run: run the tests again before accepting.";
  }
  store.set(key, result.derived, result.environment);
  return saved("Saved the slower numbers as the budget", store.path);
}
