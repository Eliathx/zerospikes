import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SLACK, TARGETS, TIGHTEN_MIN_GAIN } from "./defaults.js";
import { environmentId, type Environment } from "./environment.js";
import { metricNames } from "./stats.js";
import type { MetricName, Metrics, TargetMiss, Violation } from "./types.js";

/**
 * Turns the worst value seen while recording into a budget, with the room
 * `SLACK` leaves for session-to-session noise. `frameMs` is the display frame
 * measured while recording: frame and input times move by whole frames.
 */
export function deriveLimit(metric: MetricName, value: number, frameMs: number): number {
  const v = Math.max(0, value);
  switch (metric) {
    case "memory.heapMB":
      return Math.ceil(Math.max(v * SLACK.heapRatio, v + SLACK.heapMB));
    case "memory.nodes":
      return Math.ceil(v + SLACK.nodes);
    case "memory.listeners":
      return Math.ceil(v + SLACK.listeners);
    case "cpu.main":
      return Math.ceil(Math.max(v * SLACK.cpuRatio, v + SLACK.cpuMs));
    case "frame.slow":
    case "frame.long":
      return Math.ceil(v * SLACK.timeRatio) + SLACK.countExtra;
    default:
      return Math.ceil(Math.max(v * SLACK.timeRatio, v + SLACK.timeFrames * frameMs));
  }
}

/** Unit suffix a metric is printed with: counts have none. */
export function unitOf(metric: MetricName): string {
  if (metric === "memory.heapMB") return " MB";
  if (metric === "memory.nodes" || metric === "memory.listeners" || metric === "frame.slow" || metric === "frame.long") return "";
  return " ms";
}

export function deriveBudget(worst: Metrics, frameMs: number): Metrics {
  const out: Metrics = {};
  for (const name of metricNames(worst)) out[name] = deriveLimit(name, worst[name]!, frameMs);
  return out;
}

/** Each metric's lower limit of the two, so recording again can only tighten a budget. */
export function tighten(stored: Metrics, derived: Metrics): Metrics {
  const out: Metrics = { ...derived };
  for (const name of metricNames(stored)) out[name] = Math.min(stored[name]!, derived[name] ?? Infinity);
  return out;
}

/** The limits a budget recorded now would lower by more than `TIGHTEN_MIN_GAIN`, at their new value. */
export function tighterLimits(stored: Metrics, derived: Metrics): Metrics {
  const out: Metrics = {};
  for (const name of metricNames(stored)) {
    const next = derived[name];
    if (next !== undefined && next < stored[name]! * (1 - TIGHTEN_MIN_GAIN)) out[name] = next;
  }
  return out;
}

/** Metrics over their `TARGETS`. */
export function overTargets(metrics: Metrics): TargetMiss[] {
  const out: TargetMiss[] = [];
  for (const metric of metricNames(metrics)) {
    const target = TARGETS[metric];
    if (target !== undefined && metrics[metric]! > target) out.push({ metric, value: metrics[metric]!, target });
  }
  return out;
}

export function check(metrics: Metrics, limits: Metrics, source: Violation["source"]): Violation[] {
  const out: Violation[] = [];
  for (const metric of metricNames(limits)) {
    const value = metrics[metric];
    const limit = limits[metric]!;
    if (value !== undefined && value > limit) out.push({ metric, value, limit, source });
  }
  return out;
}

/**
 * Fixed limits must name metrics that exist and that the scenario produced:
 * a typo, or a limit on `input.move` for a click, would otherwise never fail.
 */
export function validateLimits(scenario: string, limits: Metrics, known: readonly MetricName[], produced: Metrics): void {
  for (const name of Object.keys(limits)) {
    if (!known.includes(name as MetricName)) {
      throw new Error(`zerospikes: "${scenario}" has a limit on unknown metric "${name}". Known: ${known.join(", ")}`);
    }
    if (produced[name as MetricName] === undefined) {
      const seen = metricNames(produced).join(", ") || "none";
      throw new Error(`zerospikes: "${scenario}" has a limit on "${name}", but the scenario produced no such metric (it produced: ${seen})`);
    }
  }
}

/**
 * Version 2 adds where each budget was recorded: `environments` names each
 * machine once, `recordedOn` points every budget at one. Version 1 files have
 * neither and still read: their budgets just have no machine to check.
 */
interface BudgetFile {
  version: 2;
  environments: Record<string, Environment>;
  budgets: Record<string, Metrics>;
  recordedOn: Record<string, string>;
}

export interface StoredBudget {
  budget: Metrics;
  /** Where it was recorded; undefined for budgets written before this was stored. */
  environment?: Environment;
}

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));

/**
 * Budgets for one spec file, stored next to it in `__budgets__/<spec>.json` and
 * meant to be committed, like Playwright's snapshot folders.
 */
export class BudgetStore {
  constructor(readonly path: string) {}

  static forSpec(specFile: string): BudgetStore {
    return new BudgetStore(join(dirname(specFile), "__budgets__", basename(specFile) + ".json"));
  }

  private read(): BudgetFile {
    if (!existsSync(this.path)) return { version: 2, environments: {}, budgets: {}, recordedOn: {} };
    const file = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BudgetFile>;
    return { version: 2, environments: file.environments ?? {}, budgets: file.budgets ?? {}, recordedOn: file.recordedOn ?? {} };
  }

  get(key: string): StoredBudget | undefined {
    const file = this.read();
    const budget = file.budgets[key];
    if (!budget) return undefined;
    const id = file.recordedOn[key];
    return { budget, environment: id ? file.environments[id] : undefined };
  }

  /** Read-modify-write, so several scenarios of one file can record in turn. */
  set(key: string, budget: Metrics, environment: Environment): void {
    const file = this.read();
    const id = environmentId(environment);
    file.budgets[key] = budget;
    file.recordedOn[key] = id;
    file.environments[id] = environment;
    // Machines no budget points at any more are dropped.
    const used = new Set(Object.values(file.recordedOn));
    const environments = Object.fromEntries(Object.entries(file.environments).filter(([envId]) => used.has(envId)));
    mkdirSync(dirname(this.path), { recursive: true });
    const out: BudgetFile = { version: 2, environments: sortedByKey(environments), budgets: sortedByKey(file.budgets), recordedOn: sortedByKey(file.recordedOn) };
    writeFileSync(this.path, JSON.stringify(out, null, 2) + "\n");
  }
}
