import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { metricNames } from "./stats.js";
import type { MetricName, Metrics, Violation } from "./types.js";

/** One display frame at 60 Hz. */
const FRAME_MS = 17;

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

interface BudgetFile {
  version: 1;
  budgets: Record<string, Metrics>;
}

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
    if (!existsSync(this.path)) return { version: 1, budgets: {} };
    return JSON.parse(readFileSync(this.path, "utf8")) as BudgetFile;
  }

  get(key: string): Metrics | undefined {
    return this.read().budgets[key];
  }

  /** Read-modify-write, so several scenarios of one file can record in turn. */
  set(key: string, budget: Metrics): void {
    const file = this.read();
    file.budgets[key] = budget;
    const sorted: Record<string, Metrics> = {};
    for (const k of Object.keys(file.budgets).sort()) sorted[k] = file.budgets[k];
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ version: 1, budgets: sorted }, null, 2) + "\n");
  }
}
