import { unitOf } from "./budgets.js";
import type { IndexedRun, IndexedScenario } from "./history.js";
import { bold, dim, formatNumber, green, MARK, padEnd, padStart, red, sparkline, truncate } from "./terminal.js";
import type { MetricName } from "./types.js";

/** Runs a trend covers. */
export const TREND_RUNS = 30;
/** Smaller run-to-run changes are noise, so they aren't coloured. Same threshold as `zerospikes compare`. */
const NOTICEABLE_CHANGE = 0.1;
const RECENT_RUNS = 10;
const SHORT_COMMIT_LENGTH = 7;
/** Metrics a scenario is summed up by, when it has them. */
const MAIN_METRICS: MetricName[] = ["cpu.main", "frame.max", "memory.heapMB"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const COLUMN_GAP = "  ";
/** Every line starts this far in; the selected one puts its marker there. */
const INDENT = "    ";
const SELECTED = `  ${bold("›")} `;
const MIN_FIRST_COLUMN_WIDTH = 10;
/** Past this, the detail view's tables only spread their columns apart. */
const DETAIL_MAX_WIDTH = 100;
const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };

export interface ScenarioHistory {
  key: string;
  /** The scenario in each run that measured it, oldest first. */
  entries: { run: IndexedRun; scenario: IndexedScenario }[];
}

/** Every scenario in `runs`, sorted by key. */
export function scenarioHistories(runs: IndexedRun[]): ScenarioHistory[] {
  const byKey = new Map<string, ScenarioHistory["entries"]>();
  for (const run of runs) {
    for (const [key, scenario] of Object.entries(run.scenarios)) byKey.set(key, [...(byKey.get(key) ?? []), { run, scenario }]);
  }
  return [...byKey].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => ({ key, entries }));
}

export const branchesOf = (runs: IndexedRun[]) => [...new Set(runs.flatMap((run) => (run.git?.branch ? [run.git.branch] : [])))].sort();

export function mainMetric(scenario: IndexedScenario): MetricName {
  const metrics = Object.keys(scenario.metrics) as MetricName[];
  return MAIN_METRICS.find((metric) => metrics.includes(metric)) ?? metrics[0];
}

export function relativeTime(iso: string, now = Date.now()): string {
  const elapsed = now - Date.parse(iso);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.round(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.round(elapsed / HOUR)} h ago`;
  return `${Math.round(elapsed / DAY)} d ago`;
}

const shortCommit = (run: IndexedRun) => (run.git ? run.git.commit.slice(0, SHORT_COMMIT_LENGTH) + (run.git.dirty ? "*" : "") : "no commit");

const withUnit = (value: number | undefined, metric: MetricName) => (value === undefined ? "—" : `${formatNumber(value)}${unitOf(metric)}`);

/** The change from `previous` as a signed percentage, red when worse by more than noise, green when better. */
export function formatChange(current: number | undefined, previous: number | undefined): string {
  if (current === undefined || !previous) return dim("—");
  const change = (current - previous) / previous;
  const text = `${change >= 0 ? "+" : ""}${Math.round(change * 100)}%`;
  if (change > NOTICEABLE_CHANGE) return red(text);
  if (change < -NOTICEABLE_CHANGE) return green(text);
  return dim(text);
}

function trendOf(history: ScenarioHistory, metric: MetricName): string {
  const values = history.entries
    .slice(-TREND_RUNS)
    .map(({ scenario }) => scenario.metrics[metric])
    .filter((value): value is number => value !== undefined);
  return sparkline(values, NOTICEABLE_CHANGE);
}

const PROJECT_SEPARATOR = " › ";

/** Scenario keys without their `project › ` prefix when every scenario is in the same project. */
function labelsOf(histories: ScenarioHistory[]): string[] {
  const projects = new Set(histories.map((history) => history.key.split(PROJECT_SEPARATOR)[0]));
  if (projects.size > 1) return histories.map((history) => history.key);
  return histories.map((history) => history.key.split(PROJECT_SEPARATOR).slice(1).join(PROJECT_SEPARATOR));
}

function valueAt(history: ScenarioHistory, fromEnd: number, metric: MetricName) {
  return history.entries.at(-fromEnd)?.scenario.metrics[metric];
}

/** Lays out rows of cells as columns; the first column takes whatever width the others leave. */
function table(rows: string[][], widths: number[], width: number, alignRight: boolean[]): string[] {
  const fixed = widths.slice(1).reduce((total, w) => total + w + COLUMN_GAP.length, 0);
  const first = Math.max(MIN_FIRST_COLUMN_WIDTH, width - fixed - INDENT.length);
  return rows.map((cells) =>
    cells
      .map((cell, i) => {
        const columnWidth = i === 0 ? first : widths[i];
        const fitted = i === 0 ? truncate(cell, columnWidth) : cell;
        return alignRight[i] ? padStart(fitted, columnWidth) : padEnd(fitted, columnWidth);
      })
      .join(COLUMN_GAP),
  );
}

export function header(runs: IndexedRun[], branch: string | undefined): string {
  const latest = runs.at(-1);
  const where = latest ? `last run ${relativeTime(latest.date)} · ${shortCommit(latest)}${latest.git?.branch ? ` ${latest.git.branch}` : ""}` : "no runs yet";
  const count = `${runs.length} ${runs.length === 1 ? "run" : "runs"}`;
  return `  ${bold("zerospikes history")}  ${dim(`${count} · ${branch ?? "all branches"} · ${where}`)}`;
}

/** Each scenario's latest status and its main metric's last value, change and trend. */
export function scenarioList(histories: ScenarioHistory[], selected: number, width: number): string[] {
  const labels = labelsOf(histories);
  const rows = histories.map((history, i) => {
    const latest = history.entries.at(-1)!.scenario;
    const metric = mainMetric(latest);
    const last = valueAt(history, 1, metric);
    return [labels[i], MARK[latest.status], metric, withUnit(last, metric), formatChange(last, valueAt(history, 2, metric)), trendOf(history, metric)];
  });
  const head = ["Scenario", "Status", "Metric", "Last", "Δ", `Last ${TREND_RUNS} runs`];
  const lines = table([head, ...rows], [0, 8, 13, 10, 7, TREND_RUNS], width, [false, false, false, true, true, false]);
  return [dim(INDENT + lines[0]), ...lines.slice(1).map((line, i) => (i === selected ? SELECTED : INDENT) + line)];
}

/** Every metric of one scenario with its trend, then its recent runs for the selected metric. */
export function scenarioDetail(history: ScenarioHistory, selectedMetric: number, width: number): string[] {
  const latest = history.entries.at(-1)!.scenario;
  const metrics = Object.keys(latest.metrics) as MetricName[];
  const metric = metrics[Math.min(selectedMetric, metrics.length - 1)];
  const metricRows = metrics.map((m) => {
    const last = valueAt(history, 1, m);
    return [m, withUnit(last, m), withUnit(latest.budget?.[m], m), formatChange(last, valueAt(history, 2, m)), trendOf(history, m)];
  });
  const metricLines = table(
    [["Metric", "Last", "Budget", "Δ", `Last ${TREND_RUNS} runs`], ...metricRows],
    [0, 10, 10, 7, TREND_RUNS],
    Math.min(width, DETAIL_MAX_WIDTH),
    [false, true, true, true, false],
  );
  const runRows = history.entries
    .slice(-RECENT_RUNS)
    .reverse()
    .map(({ run, scenario }) => {
      const value = scenario.metrics[metric];
      const limit = scenario.budget?.[metric];
      const shown = withUnit(value, metric);
      return [new Date(run.date).toLocaleString("en", DATE_FORMAT), shortCommit(run), run.git?.branch ?? "—", MARK[scenario.status], value !== undefined && limit !== undefined && value > limit ? red(shown) : shown];
    });
  const runLines = table([["Date", "Commit", "Branch", "Status", metric], ...runRows], [0, 9, 16, 8, 12], Math.min(width, DETAIL_MAX_WIDTH), [
    false,
    false,
    false,
    false,
    true,
  ]);
  return [
    `  ${bold(history.key)}  ${MARK[latest.status]}`,
    "",
    dim(INDENT + metricLines[0]),
    ...metricLines.slice(1).map((line, i) => (i === metrics.indexOf(metric) ? SELECTED : INDENT) + line),
    "",
    `  ${bold(`Recent runs · ${metric}`)}`,
    dim(INDENT + runLines[0]),
    ...runLines.slice(1).map((line) => INDENT + line),
  ];
}
