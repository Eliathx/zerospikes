import { existsSync } from "node:fs";
import { relative } from "node:path";
import { LimitStore } from "./limits.js";
import { readRun, type IndexedRun, type IndexedScenario } from "./history.js";
import { metricNames } from "./stats.js";
import { bold, cyan } from "./terminal.js";
import type { Metrics } from "./types.js";

/**
 * Limit changes the history view makes from a finished run, so a scenario
 * doesn't have to be measured again to save what was just measured: lowering a
 * limits the run beat, or accepting a scenario that is slower on purpose.
 */

const sameLimits = (a: Metrics | null | undefined, b: Metrics | null | undefined) =>
  !!a && !!b && metricNames(a).length === metricNames(b).length && metricNames(a).every((metric) => a[metric] === b[metric]);

/** What a change saved, in the actions' colour, ending on the limits file it changed, bold so it stands out. */
const saved = (what: string, path: string) => `${cyan(`${what} in`)} ${bold(cyan(relative(process.cwd(), path) || path))}`;

/**
 * Limits as last read, by file and scenario. The view asks for them on every
 * key, and reading the files that often makes moving through the list lag
 * (on Windows above all, where each open is scanned): they're read again only
 * after `t` or `w` changes one, or `forgetLimits`.
 */
const readLimits = new Map<string, Metrics | undefined>();

/** Reads the limits files again on the next look: a new run may have recorded or changed them. */
export const forgetLimits = () => readLimits.clear();

/** The scenario's limits in its file now, which a `t` or `w` may have changed since the run. */
export function currentLimits(key: string, scenario: IndexedScenario): Metrics | undefined {
  if (!scenario.limitsFile) return undefined;
  const cacheKey = `${scenario.limitsFile}\0${key}`;
  if (!readLimits.has(cacheKey)) {
    readLimits.set(cacheKey, existsSync(scenario.limitsFile) ? new LimitStore(scenario.limitsFile).get(key)?.limits : undefined);
  }
  return readLimits.get(cacheKey);
}

export interface Outcome {
  done: boolean;
  message: string;
}

/**
 * The run's tighter limits, while the limits in the file are still the ones the
 * run was checked against. Once lowered, or replaced since (another machine's,
 * pulled from git), the run says nothing about them any more.
 */
export function pendingTighter(key: string, scenario: IndexedScenario): Metrics {
  return scenario.tighter && sameLimits(currentLimits(key, scenario), scenario.limits) ? scenario.tighter : {};
}

/** Lowers each limit the run beat to what it would record now. */
export function applyTighter(key: string, scenario: IndexedScenario): Outcome {
  const pending = pendingTighter(key, scenario);
  if (!metricNames(pending).length) return { done: false, message: "Nothing to lower." };
  const store = new LimitStore(scenario.limitsFile!);
  const stored = store.get(key)!;
  store.set(key, { ...stored.limits, ...pending }, stored.environment);
  forgetLimits();
  return { done: true, message: saved(`Lowered ${metricNames(pending).join(", ")}`, store.path) };
}

/**
 * Saves the limits `run` would have recorded for a scenario that failed in it,
 * as `ZS_ALLOW_WORSE=1 … -u` would. Refused when the limits changed since that
 * run, since the run was judged against the old one.
 */
export function acceptSlower(dir: string, entry: IndexedRun, key: string): string {
  const result = readRun(dir, entry)?.results.find((r) => r.key === key);
  if (!result?.derived || !result.limitsFile || !result.environment) {
    return "This run has no numbers to accept: run the tests again.";
  }
  const store = new LimitStore(result.limitsFile);
  if (!sameLimits(store.get(key)?.limits, result.limits)) {
    return "The limits changed since this run: run the tests again before accepting.";
  }
  store.set(key, result.derived, result.environment);
  forgetLimits();
  return saved("Saved the slower numbers as the limits", store.path);
}
