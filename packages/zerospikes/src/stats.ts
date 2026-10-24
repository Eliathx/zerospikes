import type { RawRecording } from "./in-page.js";
import type { Metrics, MetricName, Phase } from "./types.js";

/** Two display frames at 60 Hz: a frame longer than this was visibly late. */
const SLOW_FRAME_MS = 33.4;

const PHASE: Record<string, Phase> = {
  pointerdown: "down",
  pointermove: "move",
  pointerup: "up",
  click: "click",
  keydown: "key",
  wheel: "wheel",
};

/** One decimal: finer than any of these measurements can resolve. */
export const round = (n: number) => Math.round(n * 10) / 10;

export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The metrics of one run: frame gaps, plus the worst input latency of each phase that happened. */
export function runMetrics(recording: RawRecording): Metrics {
  const gaps: number[] = [];
  for (let i = 1; i < recording.frames.length; i++) gaps.push(recording.frames[i] - recording.frames[i - 1]);
  const metrics: Metrics = {
    "frame.max": round(gaps.length ? Math.max(...gaps) : 0),
    "frame.p95": round(quantile(gaps, 0.95)),
    "frame.slow": gaps.filter((g) => g > SLOW_FRAME_MS).length,
  };
  if (recording.longFrames) metrics["frame.long"] = recording.longFrames.length;
  for (const { type, ms } of recording.inputs) {
    const phase = PHASE[type];
    if (phase) metrics[`input.${phase}`] = round(Math.max(metrics[`input.${phase}`] ?? 0, ms));
  }
  return metrics;
}

/** Metric names present in a set of metrics, typed. */
export const metricNames = (metrics: Metrics) => Object.keys(metrics) as MetricName[];

/** Combines every metric across runs with `pick`, skipping runs that didn't have it. */
function combine(runs: Metrics[], pick: (values: number[]) => number): Metrics {
  const names = new Set(runs.flatMap(metricNames));
  const out: Metrics = {};
  for (const name of names) {
    out[name] = round(pick(runs.map((r) => r[name]).filter((v): v is number => v !== undefined)));
  }
  return out;
}

/** Median of every metric across runs: one GC pause in one run doesn't decide the verdict. */
export const aggregate = (runs: Metrics[]) => combine(runs, median);

/** Worst value of every metric across runs: budgets start from it, so they cover the spread seen while recording. */
export const worstOf = (runs: Metrics[]) => combine(runs, (values) => Math.max(...values));
