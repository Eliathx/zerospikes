import { relative } from "node:path";
import { unitOf } from "./budgets.js";
import { TARGETS } from "./defaults.js";
import type { IndexedRun, IndexedScenario } from "./history.js";
import { metricNames } from "./stats.js";
import { bold, cyan, dim, formatNumber, green, hasColor, highlight, padEnd, padStart, red, sparkline, STATUS_WORD, treeLine, truncate, visibleWidth, yellow, type Paint } from "./terminal.js";
import type { MetricName, Metrics, PageError, ScenarioResult, Violation } from "./types.js";

/** A trend that spreads less than this is drawn flat: noise. Same threshold as `zerospikes compare`. */
const NOTICEABLE_CHANGE = 0.1;
const SHORT_COMMIT_LENGTH = 7;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const COLUMN_GAP = "  ";
/** Every line starts this far in. */
const INDENT = "    ";
/** The selected line stands out by its background; without colours, a plain `>` in the indent does it. */
const SELECTED = hasColor ? INDENT : "  > ";
const MIN_FIRST_COLUMN_WIDTH = 10;
/** The fewest runs a narrow terminal shows a trend over, before the scenario names give way instead. */
const MIN_TREND_RUNS = 10;
/** Statuses whose run was checked against its budget, so counting the metrics within it means something. */
const CHECKED: IndexedScenario["status"][] = ["pass", "fail", "updated"];
/** `Oct 28, 10:27`, the dates in DATE_FORMAT. */
const DATE_WIDTH = 13;
/** Where the branch sits in a table of runs: the column that gives way when the terminal is narrow. */
const BRANCH_COLUMN = 2;
/** Enough of a branch name to tell `main` from `feat…` in an 80-column terminal. */
const MIN_BRANCH_WIDTH = 4;
const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };

export interface ScenarioHistory {
  key: string;
  /** The scenario in each run that measured it, oldest first. */
  entries: { run: IndexedRun; scenario: IndexedScenario }[];
}

/**
 * Every scenario in `runs`, by key: first those the latest run measured, then
 * the ones it didn't (removed from the suite, or left out by a --grep).
 */
export function scenarioHistories(runs: IndexedRun[]): ScenarioHistory[] {
  const byKey = new Map<string, ScenarioHistory["entries"]>();
  for (const run of runs) {
    for (const [key, scenario] of Object.entries(run.scenarios)) byKey.set(key, [...(byKey.get(key) ?? []), { run, scenario }]);
  }
  const latest = runs.at(-1);
  const notInLatest = (key: string) => Number(latest !== undefined && !(key in latest.scenarios));
  return [...byKey].sort(([a], [b]) => notInLatest(a) - notInLatest(b) || a.localeCompare(b)).map(([key, entries]) => ({ key, entries }));
}

export const branchesOf = (runs: IndexedRun[]) => [...new Set(runs.flatMap((run) => (run.git?.branch ? [run.git.branch] : [])))].sort();

export function relativeTime(iso: string, now = Date.now()): string {
  const elapsed = now - Date.parse(iso);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.round(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.round(elapsed / HOUR)} h ago`;
  return `${Math.round(elapsed / DAY)} d ago`;
}

const shortCommit = (run: IndexedRun) => (run.git ? run.git.commit.slice(0, SHORT_COMMIT_LENGTH) + (run.git.dirty ? "*" : "") : "no commit");

const withUnit = (value: number | undefined, metric: MetricName) => (value === undefined ? "—" : `${formatNumber(value)}${unitOf(metric)}`);

/**
 * The colour of one run in a trend, as the rest of the view uses them: red
 * over the budget it was checked against (it failed on this metric), yellow
 * within it but over the metric's target (it passes, and lags), green within
 * both. Dim for a run that wasn't checked against a budget.
 */
function paintOf(scenario: IndexedScenario, metric: MetricName): Paint {
  const value = scenario.metrics[metric]!;
  const limit = scenario.budget?.[metric];
  const target = TARGETS[metric];
  if (limit === undefined || !CHECKED.includes(scenario.status)) return dim;
  if (value > limit) return red;
  return target !== undefined && value > target ? yellow : green;
}

/** A run's value of `metric`, red or yellow like its block in a trend, plain when it's fine. */
function shownValue(scenario: IndexedScenario, metric: MetricName, unit = true): string {
  const value = scenario.metrics[metric];
  const shown = unit ? withUnit(value, metric) : value === undefined ? "—" : formatNumber(value);
  if (scenario.metrics[metric] === undefined) return shown;
  const paint = paintOf(scenario, metric);
  return paint === red || paint === yellow ? paint(shown) : shown;
}

/** One block per run of `entries` that measured `metric`: height for the trend, colour for how each run did. */
function trendLine(entries: ScenarioHistory["entries"], metric: MetricName): string {
  const measured = entries.filter(({ scenario }) => scenario.metrics[metric] !== undefined);
  return sparkline(
    measured.map(({ scenario }) => scenario.metrics[metric]!),
    NOTICEABLE_CHANGE,
    measured.map(({ scenario }) => paintOf(scenario, metric)),
  );
}

const PROJECT_SEPARATOR = " › ";

/** Scenario keys without their `project › ` prefix when every scenario is in the same project. */
function labelsOf(histories: ScenarioHistory[]): string[] {
  const projects = new Set(histories.map((history) => history.key.split(PROJECT_SEPARATOR)[0]));
  if (projects.size > 1) return histories.map((history) => history.key);
  return histories.map((history) => history.key.split(PROJECT_SEPARATOR).slice(1).join(PROJECT_SEPARATOR));
}

/**
 * Lays out rows of cells as columns. Column `flexible` (the first, unless
 * told) takes whatever width the others leave, at least `minFlexible`, and is
 * cut short to fit it.
 */
function table(rows: string[][], widths: number[], width: number, alignRight: boolean[], flexible = 0, minFlexible = MIN_FIRST_COLUMN_WIDTH): string[] {
  const fixed = widths.reduce((total, w, i) => (i === flexible ? total : total + w + COLUMN_GAP.length), 0);
  const rest = Math.max(minFlexible, width - fixed - INDENT.length);
  return rows.map((cells) =>
    cells
      .map((cell, i) => {
        const columnWidth = i === flexible ? rest : widths[i];
        const fitted = i === flexible ? truncate(cell, columnWidth) : cell;
        return alignRight[i] ? padStart(fitted, columnWidth) : padEnd(fitted, columnWidth);
      })
      .join(COLUMN_GAP),
  );
}

/** Marks a scenario, or a metric, whose budget can be lowered. */
const LOWER_MARK = "↓";
/** Past this, the scenario list only pushes its status away from the names. */
const LIST_MAX_WIDTH = 100;

/**
 * A scenario's metrics in its latest run, as a tree under its row: each value
 * coloured as in its trend, against `budget` (the budget now, or that run's),
 * and `LOWER_MARK` on the ones in `lowerable`.
 */
function metricTree(history: ScenarioHistory, budget: Metrics | null | undefined, lowerable: Metrics): string[] {
  const latest = history.entries.at(-1)!.scenario;
  const metrics = Object.keys(latest.metrics) as MetricName[];
  // The unit once, after the budget: `0.2 / 3 MB`, with every column lined up across the tree.
  const values = metrics.map((metric) => shownValue(latest, metric, false));
  const limits = metrics.map((metric) => (budget?.[metric] === undefined ? "—" : formatNumber(budget[metric]!)));
  const units = metrics.map((metric) => unitOf(metric).trim());
  const widest = (cells: string[]) => Math.max(...cells.map((cell) => visibleWidth(cell)));
  return metrics.map((metric, i) => {
    const branch = treeLine(i === metrics.length - 1 ? "└" : "├");
    const limit = padStart(limits[i], widest(limits)) + (units[i] ? ` ${units[i]}` : "");
    const mark = lowerable[metric] !== undefined ? ` ${cyan(LOWER_MARK)}` : "";
    return `${INDENT}  ${branch} ${padEnd(metric, widest(metrics))}  ${padStart(values[i], widest(values))} ${dim("/")} ${limit}${mark}`;
  });
}

/**
 * Each scenario with its latest status and how many metrics stayed within
 * budget. Scenarios with metrics in `lowerable` (by key) get `LOWER_MARK`
 * after their status; the ones in `expanded` show their metrics in a tree
 * under them, against `budgets` (the budgets now, by key). A scenario the
 * latest run didn't measure is greyed, with when it last ran in place of a
 * status that is no longer news.
 */
export function scenarioList(
  histories: ScenarioHistory[],
  selected: number,
  width: number,
  lowerable = new Map<string, Metrics>(),
  budgets = new Map<string, Metrics | undefined>(),
  expanded = new Set<string>(),
): string[] {
  const labels = labelsOf(histories);
  const lastRun = histories.reduce((date, history) => (history.entries.at(-1)!.run.date > date ? history.entries.at(-1)!.run.date : date), "");
  const stale = histories.map((history) => history.entries.at(-1)!.run.date !== lastRun);
  const canLower = (key: string) => metricNames(lowerable.get(key) ?? {}).length > 0;
  const rows = histories.map((history, i) => {
    const { run, scenario: latest } = history.entries.at(-1)!;
    if (stale[i]) return [labels[i], relativeTime(run.date)];
    return [labels[i], canLower(history.key) ? `${statusOf(latest)} ${cyan(LOWER_MARK)}` : statusOf(latest)];
  });
  // Wide enough for `UPDATED 12/12 ↓`.
  const lines = table([["Scenario", "Status"], ...rows], [0, 15], Math.min(width, LIST_MAX_WIDTH), [false, false]);
  return [
    dim(INDENT + lines[0]),
    ...lines.slice(1).flatMap((line, i) => {
      const history = histories[i];
      // Greyed whole, after the name is cut to fit: greying the name first could cut it inside its colour code.
      const shown = stale[i] ? dim(line) : line;
      const row = i === selected ? highlight(SELECTED + shown) : INDENT + shown;
      if (!expanded.has(history.key)) return [row];
      return [row, ...metricTree(history, budgets.get(history.key) ?? history.entries.at(-1)!.scenario.budget, lowerable.get(history.key) ?? {})];
    }),
  ];
}

/**
 * A scenario's status in a run and how many of its metrics stayed within their
 * budget, as `FAIL 5/6`: the count green when all did, red otherwise, so a
 * failure says how far it went. Just the status for a run that wasn't checked
 * against a budget (`NEW`, `SKIP`).
 */
function statusOf(scenario: IndexedScenario): string {
  const word = STATUS_WORD[scenario.status];
  const budget = scenario.budget;
  if (!budget || !CHECKED.includes(scenario.status)) return word;
  const checked = (Object.keys(budget) as MetricName[]).filter((metric) => scenario.metrics[metric] !== undefined);
  const within = checked.filter((metric) => scenario.metrics[metric]! <= budget[metric]!).length;
  const count = `${within}/${checked.length}`;
  return `${word} ${within === checked.length ? green(count) : red(count)}`;
}

/** A metric's name, last value and budget now: the metrics pane's columns. */
const METRIC_COLUMNS = [16, 9, 9];
/** After the budget: ` ↓ `, the mark one space from it and one from the pane's edge. */
const MARK_ROOM = 3;
/** The metrics pane's width: its columns, the gaps between them, the indent before and the mark after. */
export const METRICS_PANE_WIDTH = INDENT.length + METRIC_COLUMNS.reduce((total, w) => total + w, 0) + COLUMN_GAP.length * (METRIC_COLUMNS.length - 1) + MARK_ROOM;
/** Lines above a pane's rows that stay put while the rows scroll: the runs' title, a blank, the column titles. */
export const PANE_HEADER_LINES = 3;

/**
 * The scenario view's title: its key and its latest status, as in the list.
 */
export const scenarioTitle = (history: ScenarioHistory) => `  ${bold(history.key)}  ${statusOf(history.entries.at(-1)!.scenario)}`;

/** The line of a pane's selected row: highlighted when the pane has the focus, faintly when not. */
function selectedLine(line: string, width: number, focused: boolean): string {
  return highlight(padEnd(SELECTED + line, width), !focused);
}

/**
 * The left pane of a scenario: each metric with its latest value, coloured as
 * in its trend, its budget now and `LOWER_MARK` when it can be lowered.
 * `budget` is the budget now, when it changed since the latest run; by
 * default, that run's.
 */
export function metricsPane(
  history: ScenarioHistory,
  selectedMetric: number,
  focused: boolean,
  budget?: Metrics | null,
  lowerable: Metrics = {},
): string[] {
  const latest = history.entries.at(-1)!.scenario;
  const budgetNow = budget ?? latest.budget;
  const metrics = Object.keys(latest.metrics) as MetricName[];
  const rows = metrics.map((m) => [m, shownValue(latest, m), withUnit(budgetNow?.[m], m)]);
  const [head, ...cells] = table([["Metric", "Last", "Budget"], ...rows], METRIC_COLUMNS, METRICS_PANE_WIDTH - MARK_ROOM, [false, true, true]);
  const lines = cells.map((line, i) => (lowerable[metrics[i]] !== undefined ? `${line} ${cyan(LOWER_MARK)}` : line));
  const selected = Math.min(selectedMetric, metrics.length - 1);
  return [
    dim(INDENT + head),
    ...lines.map((line, i) => (i === selected ? selectedLine(line, METRICS_PANE_WIDTH, focused) : INDENT + line)),
  ];
}

/**
 * The right pane of a scenario: every run of one metric, newest first, under
 * its trend across them. Each row has the value, coloured as in the trend, and
 * the budget that run was checked against. A narrow pane cuts the branch name
 * short, the one column of any length.
 */
export function runsPane(history: ScenarioHistory, metric: MetricName, selectedRun: number, focused: boolean, width: number): string[] {
  const entries = [...history.entries].reverse();
  const count = `${entries.length} ${entries.length === 1 ? "run" : "runs"}`;
  // The trend keeps to the newest runs the title line can hold.
  const room = Math.max(MIN_TREND_RUNS, width - INDENT.length - metric.length - count.length - 6);
  const rows = entries.map(({ run, scenario }) => [
    new Date(run.date).toLocaleString("en", DATE_FORMAT),
    shortCommit(run),
    run.git?.branch ?? "—",
    shownValue(scenario, metric),
    withUnit(scenario.budget?.[metric], metric),
  ]);
  const head = ["Date", "Commit", "Branch", metric, "Budget then"];
  // The metric's name heads its column: as wide as the longest, `memory.listeners`.
  const lines = table([head, ...rows], [DATE_WIDTH, 9, 0, Math.max(13, metric.length), 11], width, [false, false, false, true, true], BRANCH_COLUMN, MIN_BRANCH_WIDTH);
  return [
    `${INDENT}${bold(metric)} ${dim(`· ${count}`)}  ${trendLine(history.entries.slice(-room), metric)}`,
    "",
    dim(INDENT + lines[0]),
    ...lines.slice(1).map((line, i) => (i === selectedRun ? selectedLine(line, width, focused) : INDENT + line)),
  ];
}

/**
 * How a run went, in one line: how many scenarios, how many over budget, and
 * whatever else needs a look. Both the reporter and the view say it this way;
 * the view says what can be lowered on its own line, with the key for it, so
 * it leaves that out with `withLowerable` false.
 */
export const runSummary = (scenarios: Pick<IndexedScenario, "status" | "tighter">[], overTarget = 0, withLowerable = true) =>
  summaryParts(scenarios, overTarget, withLowerable).join(dim(" · "));

/**
 * `runSummary`'s parts, the second always the verdict: over budget, with
 * errors, or all within budget, which a run with errors can't claim.
 */
export function summaryParts(scenarios: Pick<IndexedScenario, "status" | "tighter">[], overTarget = 0, withLowerable = true): string[] {
  const count = (status: IndexedScenario["status"]) => scenarios.filter((scenario) => scenario.status === status).length;
  const lowerable = scenarios.filter((scenario) => scenario.tighter && metricNames(scenario.tighter).length).length;
  const parts = [`${scenarios.length} ${scenarios.length === 1 ? "scenario" : "scenarios"}`];
  const withErrors = red(`${count("error")} with errors`);
  parts.push(count("fail") ? red(`${count("fail")} over budget`) : count("error") ? withErrors : green("all within budget"));
  if (count("fail") && count("error")) parts.push(withErrors);
  // Grey like their statuses: yellow is kept for lag.
  if (count("recorded")) parts.push(dim(`${count("recorded")} budgets recorded`));
  if (count("updated")) parts.push(dim(`${count("updated")} budgets updated`));
  if (count("unchecked")) parts.push(dim(`${count("unchecked")} not compared (budgets from another machine)`));
  if (overTarget) parts.push(yellow(`${overTarget} over target`));
  if (lowerable && withLowerable) parts.push(cyan(`${lowerable} can be lowered`));
  return parts;
}

/** Most over-budget metrics a failure line names: the rest are in the scenario's own view. */
const SHOWN_VIOLATIONS = 3;
/** Past this, a failed scenario's name is cut short so its misses stay on the line. */
const MAX_FAILURE_NAME_WIDTH = 48;

type Miss = Pick<Violation, "metric" | "value" | "limit">;

/** Limits gone over, worst first: `frame.max 442 ms > 146, input down/up 444 ms > 157`. */
function formatMisses(misses: Miss[]): string {
  // Input phases of one click or drag often share a number: one entry for them, `input down/up`.
  const byKey = new Map<string, { names: string[]; miss: Miss }>();
  for (const miss of misses) {
    const phase = miss.metric.startsWith("input.") ? miss.metric.slice("input.".length) : null;
    const key = phase ? `input:${formatNumber(miss.value)}` : miss.metric;
    const entry = byKey.get(key);
    if (entry && phase) entry.names.push(phase);
    else byKey.set(key, { names: [phase ?? miss.metric], miss });
  }
  const ratio = (m: Miss) => m.value / Math.max(m.limit, 1);
  const worst = [...byKey.values()].sort((a, b) => ratio(b.miss) - ratio(a.miss));
  const shown = worst.slice(0, SHOWN_VIOLATIONS).map(({ names, miss: m }) => {
    const name = m.metric.startsWith("input.") ? `input ${names.join("/")}` : m.metric;
    return `${name} ${formatNumber(m.value)}${unitOf(m.metric)} > ${formatNumber(m.limit)}`;
  });
  if (worst.length > SHOWN_VIOLATIONS) shown.push(`+${worst.length - SHOWN_VIOLATIONS} more`);
  return shown.join(", ");
}

/**
 * What went wrong with a scenario, in one line: the limits it went over, worst
 * first, or the error its page logged most, and how many others.
 */
export function missesOf(r: ScenarioResult): string {
  if (r.status !== "error") return formatMisses(r.violations);
  const [first, ...others] = r.errors ?? [];
  if (!first) return "the page logged errors";
  return `${first.count > 1 ? `${first.count}× ` : ""}${first.message}${others.length ? `  +${others.length} more` : ""}`;
}

/** Scenarios that went wrong: over budget, or broken by errors. */
export const isFailure = (r: Pick<ScenarioResult, "status">) => r.status === "fail" || r.status === "error";

/** `ERROR`, the wider of the two words a failure line starts with: the names after them line up. */
const FAILURE_WORD_WIDTH = 5;
/** An error's message runs on where a list of misses doesn't: cut here. */
const MAX_FAILURE_TEXT_WIDTH = 120;

/** One line per failed or broken scenario in `results`, names lined up, each after `indent`. */
export function failureLines(results: ScenarioResult[], indent: string): string[] {
  const failed = results.filter(isFailure);
  const label = (r: ScenarioResult) => `${r.test} › ${r.name}`;
  const width = Math.min(MAX_FAILURE_NAME_WIDTH, Math.max(0, ...failed.map((r) => [...label(r)].length)));
  return failed.map((r) => {
    const word = padEnd(STATUS_WORD[r.status], FAILURE_WORD_WIDTH);
    return `${indent}${word}  ${padEnd(truncate(label(r), width), width)}   ${red(truncate(missesOf(r), MAX_FAILURE_TEXT_WIDTH))}`;
  });
}

/** Functions the open scenario names from its profiled run. */
const SHOWN_HOT_FUNCTIONS = 3;
/** Errors the open scenario lists; the test's own failure has them all. */
const SHOWN_ERRORS = 5;
/** A profile names a function as `name @ file:line`. */
const LOCATION_SEPARATOR = " @ ";

/**
 * What the latest run of an open scenario found beyond its numbers, each
 * under a label that says what it is, cut to `width`: limits it missed that
 * the budget column doesn't show, targets it lags behind, why it wasn't
 * compared, and, for a failure, the functions it spent its time in. A
 * scenario whose page logged errors shows them alone: nothing else it measured holds.
 */
export function scenarioDetails(result: ScenarioResult, width: number): string[] {
  if (result.status === "error") return errorDetails(result.errors ?? [], width);
  const lines: string[] = [];
  // A label, then its text cut to what's left of the line: cut before colouring, so no colour code is cut.
  const labelled = (label: string, paint: Paint, text: string) =>
    `  ${paint(label)}  ${truncate(text, Math.max(10, width - label.length - 5))}`;
  const fixed = result.violations.filter((violation) => violation.source === "fixed");
  if (fixed.length) lines.push(labelled("Over its fixed limit", red, formatMisses(fixed)));
  if (result.overTarget?.length) {
    const misses = result.overTarget.map(({ metric, value, target }) => ({ metric, value, limit: target }));
    lines.push(labelled("Over target", yellow, formatMisses(misses)), dim("  A warning only: the budget decides pass or fail."));
  }
  if (result.otherMachine?.length) lines.push(labelled("Not compared", dim, `its budget is from another machine (${result.otherMachine.join(", ")})`));
  if (result.samples?.length) lines.push(labelled("Per cycle", dim, result.samples.map((sample) => `${sample.domNodes} nodes`).join(" → ")));
  if (result.hot?.length) {
    const hot = result.hot.slice(0, SHOWN_HOT_FUNCTIONS).map((h) => ({ ms: `${formatNumber(h.selfMs)} ms`, ...splitLocation(h.fn) }));
    const nameWidth = Math.max(...hot.map((h) => h.name.length));
    if (lines.length) lines.push("");
    lines.push(
      `  ${bold("Where the time went")}`,
      dim(`  ${truncate("Time in each function's own code, from one more run profiled because it failed.", width - 3)}`),
    );
    for (const h of hot) lines.push(`    ${padStart(h.ms, 9)}  ${padEnd(h.name, nameWidth)}  ${dim(h.location)}`);
  }
  if (result.profilePath) {
    const path = relative(process.cwd(), result.profilePath) || result.profilePath;
    lines.push("", dim("  The whole profile, to load in DevTools › Performance:"), dim(`    ${truncate(path, width - 5)}`));
  }
  return lines.length ? ["", ...lines] : [];
}

/** The errors a broken scenario's page logged, each with how many times and where. */
function errorDetails(errors: PageError[], width: number): string[] {
  const label = "Errors in the page:";
  const lines = ["", `  ${red(label)} ${truncate("its numbers weren't compared with its budget. Fix them and run again.", Math.max(10, width - label.length - 4))}`];
  const shown = errors.slice(0, SHOWN_ERRORS);
  const countWidth = Math.max(...shown.map((e) => `${e.count}×`.length));
  for (const e of shown) {
    lines.push(`  ${padStart(`${e.count}×`, countWidth)}  ${truncate(e.message, width - countWidth - 5)}`);
    if (e.location) lines.push(dim(`  ${" ".repeat(countWidth)}    at ${truncate(e.location, width - countWidth - 10)}`));
  }
  if (errors.length > SHOWN_ERRORS) lines.push(dim(`  +${errors.length - SHOWN_ERRORS} more, in the test's failure`));
  return lines;
}

/** `foldText @ index.js:11721` as its name and where it is. */
function splitLocation(fn: string): { name: string; location: string } {
  const at = fn.lastIndexOf(LOCATION_SEPARATOR);
  return at === -1 ? { name: fn, location: "" } : { name: fn.slice(0, at), location: fn.slice(at + LOCATION_SEPARATOR.length) };
}
