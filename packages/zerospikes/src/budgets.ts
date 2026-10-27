import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { environmentId, type Environment } from "./environment.js";
import { metricNames } from "./stats.js";
import type { MetricName, Metrics, Violation } from "./types.js";

/** One display frame at 60 Hz. */
const FRAME_MS = 17;

/**
 * CPU time isn't quantized to display frames and holds still on a busy machine,
 * so its slack is proportional, with a floor for the millisecond or two of
 * noise that light interactions show. The ratio covers how much a scenario's
 * CPU time moves from one browser session to the next (up to about ±20% on the
 * example), which is far more than its runs within one session vary.
 */
const CPU_SLACK_RATIO = 1.35;
const CPU_SLACK_FLOOR_MS = 3;

/**
 * Turns a measured value into a budget with room for run-to-run noise. Frame
 * and latency times are quantized to display frames and can land a frame early
 * or late on a busy machine, so the slack is at least two frames; counts and
 * memory get their own floors.
 */
export function deriveLimit(metric: MetricName, value: number): number {
  const v = Math.max(0, value);
  switch (metric) {
    case "memory.heapMB":
      return Math.ceil(Math.max(v * 1.25, v + 2));
    case "memory.nodes":
      return Math.ceil(v + 50);
    case "memory.listeners":
      return Math.ceil(v + 5);
    case "cpu.main":
      return Math.ceil(Math.max(v * CPU_SLACK_RATIO, v + CPU_SLACK_FLOOR_MS));
    case "frame.slow":
    case "frame.long":
      return Math.ceil(v * 1.5) + 2;
    default:
      return Math.ceil(Math.max(v * 1.5, v + 2 * FRAME_MS));
  }
}

/** Unit suffix a metric is printed with: counts have none. */
export function unitOf(metric: MetricName): string {
  if (metric === "memory.heapMB") return " MB";
  if (metric === "memory.nodes" || metric === "memory.listeners" || metric === "frame.slow" || metric === "frame.long") return "";
  return " ms";
}

export function deriveBudget(metrics: Metrics): Metrics {
  const out: Metrics = {};
  for (const name of metricNames(metrics)) out[name] = deriveLimit(name, metrics[name]!);
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
  readonly path: string;

  constructor(specFile: string) {
    this.path = join(dirname(specFile), "__budgets__", basename(specFile) + ".json");
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
