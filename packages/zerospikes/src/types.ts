/** Phases an input event is grouped into. A drag is down → move… → up. */
export type Phase = "down" | "move" | "up" | "click" | "key" | "wheel";

/**
 * What `measure` reports, in ms unless named otherwise:
 * - `frame.max`: longest gap between two frames while the interaction ran
 * - `frame.p95`: 95th percentile of those gaps
 * - `frame.slow`: frames longer than two display frames (> 33.4 ms)
 * - `frame.long`: long animation frames (> 50 ms) from the LoAF API; Chromium only
 * - `input.<phase>`: worst time from an input event to the next frame, per phase
 */
export type InteractionMetric = "frame.max" | "frame.p95" | "frame.slow" | "frame.long" | `input.${Phase}`;

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
  status: "pass" | "fail" | "recorded" | "updated";
  violations: Violation[];
  /** Each measured run's metrics; `metrics` holds their medians. */
  runs?: Metrics[];
  samples?: MemorySample[];
  hot?: HotFunction[];
  profilePath?: string;
  longFrameScripts?: string[];
}
