import type { Environment } from "./environment.js";

export type { Environment };

/** Phases an input event is grouped into. A drag is down → move… → up. */
export type Phase = "down" | "move" | "up" | "click" | "key" | "wheel";

/**
 * What `measure` reports, in ms unless named otherwise:
 * - `frame.max`: longest gap between two frames while the interaction ran
 * - `frame.p95`: 95th percentile of those gaps
 * - `frame.slow`: frames longer than two display frames (> 33.4 ms)
 * - `frame.long`: long animation frames (> 50 ms) from the LoAF API; Chromium only
 * - `input.<phase>`: worst time from an input event to the next frame, per phase
 * - `cpu.main`: time the main thread spent running while the interaction ran, other
 *   processes' time left out, so it holds still on a busy machine; Chromium only
 */
export type InteractionMetric = "frame.max" | "frame.p95" | "frame.slow" | "frame.long" | `input.${Phase}` | "cpu.main";

/**
 * What `cycles` reports: what stayed behind after the cycles, compared with
 * the baseline taken after the warm-up.
 * - `memory.heapMB`: JS heap, in MB
 * - `memory.nodes`: DOM nodes, detached ones included
 * - `memory.listeners`: event listeners
 */
export type MemoryMetric = "memory.heapMB" | "memory.nodes" | "memory.listeners";

export type MetricName = InteractionMetric | MemoryMetric;

/** Metric name → value. Only the metrics a scenario produced are present. */
export type Metrics = Partial<Record<MetricName, number>>;

export const INTERACTION_METRICS: readonly InteractionMetric[] = [
  "frame.max",
  "frame.p95",
  "frame.slow",
  "frame.long",
  "input.down",
  "input.move",
  "input.up",
  "input.click",
  "input.key",
  "input.wheel",
  "cpu.main",
];

export const MEMORY_METRICS: readonly MemoryMetric[] = ["memory.heapMB", "memory.nodes", "memory.listeners"];

export interface MeasureOptions {
  /** Measured repetitions; the reported value of each metric is the median. Default 5. */
  runs?: number;
  /** Unmeasured repetitions first, to warm up JIT and caches. Default 1. */
  warmup?: number;
  /** Runs before every repetition (warm-up included), unmeasured: put the page back in its starting state. */
  before?: () => Promise<void>;
  /** Time to keep recording after the action returns, so trailing work (debounces, commits) counts. Default 300. */
  settleMs?: number;
  /** Fixed limits, checked against the medians on top of the recorded budget: `{ "frame.max": 50 }`. */
  budget?: Partial<Record<InteractionMetric, number>>;
  /** CPU-profile one extra run when a budget is missed (Chromium only). Default true. */
  profileOnFail?: boolean;
}

export interface CyclesOptions {
  /** Measured cycles. Default 5. */
  cycles?: number;
  /** Cycles before the baseline, so lazy caches are already filled. Default 1. */
  warmup?: number;
  /** Fixed limits, as in `MeasureOptions.budget`: `{ "memory.nodes": 0 }`. */
  budget?: Partial<Record<MemoryMetric, number>>;
}

export interface MemorySample {
  heapMB: number;
  domNodes: number;
  listeners: number;
}

export interface Violation {
  metric: MetricName;
  value: number;
  limit: number;
  source: "budget" | "fixed";
}

/** A metric over the value it should stay under to feel smooth (`TARGETS`): a warning, not a failure. */
export interface TargetMiss {
  metric: MetricName;
  value: number;
  target: number;
}

/** What the main thread's CPU time went into, in ms. Tasks also hold work none of these name (paint, GC, input). */
export interface CpuBreakdown {
  scriptMs: number;
  layoutMs: number;
  styleMs: number;
}

export interface HotFunction {
  fn: string;
  selfMs: number;
}

/** What a test attaches for the reporter, one per `measure` / `cycles` call. */
export interface ScenarioResult {
  kind: "interaction" | "memory";
  key: string;
  test: string;
  name: string;
  project: string;
  metrics: Metrics;
  budget: Metrics | null;
  /**
   * `measured`: inside a `zerospikes compare` session, where budgets play no part.
   * `unchecked`: the budget was recorded on another machine, so it wasn't compared
   * (fixed limits still were).
   */
  status: "pass" | "fail" | "recorded" | "updated" | "measured" | "unchecked";
  violations: Violation[];
  /** Metrics over their target. Reported, never failed for. */
  overTarget?: TargetMiss[];
  /** Limits that recording now would lower by more than 10%, at their new value: `-u` applies them. */
  tighter?: Metrics;
  /** The whole budget recording this run would save, for accepting a slower scenario later without running it again. */
  derived?: Metrics;
  /** The budgets file the scenario's budget lives in. */
  budgetFile?: string;
  /** Where the scenario ran. */
  environment?: Environment;
  /** For `unchecked`: what differs from where the budget was recorded, as `field: recorded → current`. */
  otherMachine?: string[];
  /** Each measured run's metrics; `metrics` holds their medians. */
  runs?: Metrics[];
  /** Median split of `cpu.main` across the measured runs. */
  cpu?: CpuBreakdown;
  samples?: MemorySample[];
  hot?: HotFunction[];
  profilePath?: string;
  longFrameScripts?: string[];
}
