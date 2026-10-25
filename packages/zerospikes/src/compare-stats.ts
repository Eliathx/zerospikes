import { median, round } from "./stats.js";

const uDistributions = new Map<string, number[]>();

/**
 * How many orderings of `candidates` and `baselines` samples give each value of
 * U (the number of candidate-above-baseline pairs), by Mann and Whitney's
 * recurrence: the largest sample is either a candidate, above every baseline,
 * or a baseline, above no candidate.
 */
function uDistribution(candidates: number, baselines: number): number[] {
  const key = `${candidates},${baselines}`;
  const cached = uDistributions.get(key);
  if (cached) return cached;
  let counts: number[];
  if (candidates === 0 || baselines === 0) {
    counts = [1];
  } else {
    counts = new Array<number>(candidates * baselines + 1).fill(0);
    uDistribution(candidates - 1, baselines).forEach((ways, u) => (counts[u + baselines] += ways));
    uDistribution(candidates, baselines - 1).forEach((ways, u) => (counts[u] += ways));
  }
  uDistributions.set(key, counts);
  return counts;
}

/**
 * One-sided Mann-Whitney test: the probability, if both samples came from the
 * same distribution, of `candidate` ranking at least this far above `baseline`.
 * Uses the exact distribution of U, so it holds for the handful of samples a
 * comparison has. A tie doesn't count as the candidate being above, which
 * leans towards calling no difference.
 */
export function mannWhitneyGreater(baseline: number[], candidate: number[]): number {
  if (!baseline.length || !candidate.length) return 1;
  let u = 0;
  for (const c of candidate) for (const b of baseline) if (c > b) u++;
  const counts = uDistribution(candidate.length, baseline.length);
  const total = counts.reduce((sum, ways) => sum + ways, 0);
  const atLeastU = counts.reduce((sum, ways, value) => (value >= u ? sum + ways : sum), 0);
  return atLeastU / total;
}

/** Holm's step-down adjustment: p-values corrected for testing several metrics at once. */
export function holm(pValues: number[]): number[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, p * (pValues.length - rank)));
    adjusted[i] = running;
  });
  return adjusted;
}

export type Verdict = "slower" | "same" | "inconclusive";

export interface CompareThresholds {
  /** Chance of calling an unchanged scenario slower that is accepted, after correcting for the number of metrics. */
  alpha: number;
  /** Smallest relative slowdown worth failing for: 0.1 is 10%. */
  minChange: number;
  /** Smallest absolute slowdown worth failing for, in the metric's unit. */
  minDelta: (metric: string) => number;
}

export interface MetricComparison {
  metric: string;
  baseline: number;
  candidate: number;
  /** candidate ÷ baseline − 1, on the medians. */
  change: number;
  pValue: number;
  verdict: Verdict;
}

/**
 * Compares each metric's session medians. A metric is slower only when the
 * difference is both large enough to matter and unlikely to be noise; large
 * enough but not yet clear is inconclusive, which more sessions can settle.
 */
export function compareMetrics(
  baseline: Record<string, number[]>,
  candidate: Record<string, number[]>,
  thresholds: CompareThresholds,
): MetricComparison[] {
  const metrics = Object.keys(baseline).filter((metric) => candidate[metric]?.length && baseline[metric].length);
  const raw = metrics.map((metric) => mannWhitneyGreater(baseline[metric], candidate[metric]));
  const adjusted = holm(raw);
  return metrics.map((metric, i) => {
    const before = median(baseline[metric]);
    const after = median(candidate[metric]);
    const change = before > 0 ? after / before - 1 : after > 0 ? Infinity : 0;
    const matters = change >= thresholds.minChange && after - before >= thresholds.minDelta(metric);
    const verdict: Verdict = !matters ? "same" : adjusted[i] <= thresholds.alpha ? "slower" : "inconclusive";
    return { metric, baseline: round(before), candidate: round(after), change, pValue: adjusted[i], verdict };
  });
}

/** A scenario is slower if any metric is, inconclusive if any metric still might be. */
export function scenarioVerdict(comparisons: MetricComparison[]): Verdict {
  if (comparisons.some((c) => c.verdict === "slower")) return "slower";
  if (comparisons.some((c) => c.verdict === "inconclusive")) return "inconclusive";
  return "same";
}
