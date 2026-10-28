import { existsSync, unwatchFile, watchFile } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { acceptSlower, applyTighter, currentBudget, pendingTighter } from "./budget-actions.js";
import { readIndex, type IndexedRun } from "./history.js";
import {
  branchesOf,
  header,
  METRICS_PANE_WIDTH,
  metricsPane,
  PANE_HEADER_LINES,
  runsPane,
  scenarioHistories,
  scenarioList,
  scenarioTitle,
  type ScenarioHistory,
} from "./history-view.js";
import { metricNames } from "./stats.js";
import type { MetricName } from "./types.js";
import { bold, boxed, cyan, dim, yellow } from "./terminal.js";

export const HISTORY_USAGE = `Usage: zerospikes history [options]

Shows how each scenario did across past runs. In a terminal it's interactive
and updates when a run finishes; otherwise (or with --print) it prints once.
From the latest run it can lower the budgets a scenario beat (t), or save a
scenario that failed as its new budget when it is slower on purpose (w).

  --dir <path>       The reporter's results folder (default zerospikes-results)
  --branch <name>    Only runs on this branch
  --print            Print the scenario list and exit`;

const DEFAULT_DIR = "zerospikes-results";
const DEFAULT_WIDTH = 120;
/** How often the index is checked for a new run. */
const WATCH_INTERVAL_MS = 1000;
/** Lines above and below the list: header, blank lines, column titles, the last action's message, key help. */
const CHROME_LINES = 6;
/** Below this, the runs pane goes under the metrics pane instead of beside it: beside, its columns wouldn't fit. */
const SIDE_BY_SIDE_MIN_WIDTH = 110;
/** Where a pane's box starts, under the scenario's title. */
const BOX_MARGIN = "  ";
/** Between the metrics pane's box and the runs pane's. */
const BOX_GAP = " ";
/** Of a pane's indent, what its box's border takes: the text keeps its place. */
const BOX_DEDENT = 3;
/** A box's top and bottom borders. */
const BOX_BORDERS = 2;

const SCREEN = {
  enter: "\x1b[?1049h\x1b[?25l",
  leave: "\x1b[?25h\x1b[?1049l",
  clear: "\x1b[H\x1b[2J",
};
export const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", space: " ", escape: "\x1b", backspace: "\x7f", ctrlC: "\x03" };

export interface State {
  /** The results folder: where accepting a slower scenario reads the run from. */
  dir: string;
  runs: IndexedRun[];
  /** undefined: every branch. */
  branch?: string;
  /** Scenarios whose metrics the list shows under them, opened with space. */
  expanded?: Set<string>;
  /** The open scenario, or undefined on the list. */
  openKey?: string;
  selected: number;
  /** In the open scenario: the selected metric, in the left pane, whose runs the right pane lists. */
  selectedMetric: number;
  /** The selected run in the right pane, newest first. */
  selectedRun?: number;
  /** Which pane of the open scenario ↑↓ move in: its metrics (the default) or the selected metric's runs. */
  focus?: "metrics" | "runs";
  /** Set by `w`: the scenario waiting for y / n before its slower numbers become the budget. */
  confirming?: string;
  /** The outcome of the last action, shown above the keys until the next key. */
  message?: string;
  /** Printed once (--print, or no terminal): no keys to press, so no actions are offered. */
  printed?: boolean;
}

const visibleRuns = (state: State) => (state.branch ? state.runs.filter((run) => run.git?.branch === state.branch) : state.runs);

/**
 * Keeps the selected line in view: `lines` cut to `height`, keeping their
 * first `fixed` (column titles and such) and the slice of the rest around
 * `selected`.
 */
function inView(lines: string[], fixed: number, selected: number, height: number): string[] {
  const room = Math.max(1, height - fixed);
  const start = Math.max(0, Math.min(selected - Math.floor(room / 2), lines.length - fixed - room));
  return [...lines.slice(0, fixed), ...lines.slice(fixed + start, fixed + start + room)];
}

/** The scenario list in view, with room left for the lines around it. */
const scrolled = (lines: string[], fixed: number, selected: number, height: number) => inView(lines, fixed, selected, height - CHROME_LINES);

/** The list line of the selected scenario: its index, plus the metric lines of the expanded scenarios above it. */
function selectedLine(histories: ScenarioHistory[], state: State): number {
  return histories
    .slice(0, state.selected)
    .reduce((line, history) => line + (state.expanded?.has(history.key) ? Object.keys(latestOf(history).scenario.metrics).length : 0), state.selected);
}

/** A pane drawn `width` wide in its box, `height` lines tall inside. */
const paneBox = (lines: string[], width: number, height = lines.length) => boxed(lines, width, height, BOX_DEDENT).map((line) => BOX_MARGIN + line);

/** Two panes in boxes side by side, as tall as the taller one. */
function besides(left: string[], right: string[], rightWidth: number): string[] {
  const height = Math.max(left.length, right.length);
  const rightBox = boxed(right, rightWidth, height, BOX_DEDENT);
  return paneBox(left, METRICS_PANE_WIDTH, height).map((line, i) => line + BOX_GAP + rightBox[i]);
}

const latestOf = (history: ScenarioHistory) => history.entries.at(-1)!;

/** Scenarios whose latest run beat their budget by enough to lower it, not lowered yet. */
const tightenable = (histories: ScenarioHistory[]) =>
  histories.filter((history) => metricNames(pendingTighter(history.key, latestOf(history).scenario)).length);

/** What the open scenario's latest run allows: lowering the limits it beat, or accepting it if it failed. */
function actionLines(history: ScenarioHistory): string[] {
  const { scenario } = latestOf(history);
  const pending = pendingTighter(history.key, scenario);
  const lines: string[] = [];
  if (metricNames(pending).length) {
    const limits = metricNames(pending).map((metric) => `${metric} ${scenario.budget?.[metric] ?? "?"} → ${pending[metric]}`);
    const several = limits.length > 1;
    lines.push(
      cyan(several ? "  These metrics got faster than their budgets." : "  This metric got faster than its budget."),
      `  ${cyan("Press")} ${bold("t")} ${cyan(several ? "to lower them:" : "to lower it:")} ${limits.join(", ")}`,
    );
  }
  if (scenario.status === "fail") {
    if (lines.length) lines.push("");
    lines.push(
      cyan("  This test got slower than its budget."),
      `  ${cyan("If that's on purpose, press")} ${bold("w")} ${cyan("to save the last run's numbers as its budget.")}`,
    );
  }
  return lines.length ? ["", ...lines] : [];
}

/** The list's call to lower every budget a scenario beat, when there are any. */
function tightenAllLines(count: number): string[] {
  if (!count) return [];
  const tests = count === 1 ? `1 test got faster than its budget.` : `${count} tests got faster than their budgets.`;
  const all = count === 1 ? "to lower it, or open it first to see by how much." : "to lower them all, or open one to lower just that one.";
  return [cyan(`  ${tests}`), `  ${cyan("Press")} ${bold("t")} ${cyan(all)}`, ""];
}

export function screen(state: State, width: number, height: number): string {
  const runs = visibleRuns(state);
  const histories = scenarioHistories(runs);
  const open = histories.find((history) => history.key === state.openKey);
  const lowerable = open || state.printed ? [] : tightenable(histories);
  const tightenAll = tightenAllLines(lowerable.length);
  const keys = open
    ? "↑↓ move · ←→ metrics / runs · esc back · b branch · q quit"
    : "↑↓ select · space metrics · enter open · b branch · q quit";
  const footer = state.confirming
    ? [yellow(`  Save the last run's numbers as the budget of "${state.confirming}"?`), dim("  y yes · any other key no")]
    : [...(state.message ? [`  ${state.message}`] : []), dim(`  ${keys}`)];
  const body = open
    ? scenarioPanes(state, open, width, height - footer.length - 1)
    : histories.length
      ? scrolled(
          scenarioList(
            histories,
            state.selected,
            width,
            new Map(lowerable.map((h) => [h.key, pendingTighter(h.key, latestOf(h).scenario)])),
            new Map(histories.map((h) => [h.key, currentBudget(h.key, latestOf(h).scenario)])),
            state.expanded,
          ),
          1,
          selectedLine(histories, state),
          height - tightenAll.length,
        )
      : [dim("    No runs on this branch yet.")];
  return [header(runs, state.branch), "", ...body, "", ...tightenAll, ...footer].join("\n");
}

/**
 * An open scenario: its title, its metrics on the left and the selected
 * metric's runs on the right, each pane scrolled to keep its selection in view
 * within `height`, then what its latest run allows. A narrow terminal puts the
 * runs under the metrics.
 */
function scenarioPanes(state: State, history: ScenarioHistory, width: number, height: number): string[] {
  const { scenario } = latestOf(history);
  const metrics = Object.keys(scenario.metrics) as MetricName[];
  const metric = metrics[Math.min(state.selectedMetric, metrics.length - 1)];
  const onRuns = state.focus === "runs";
  const actions = actionLines(history);
  const title = [scenarioTitle(history), ""];
  const left = metricsPane(history, state.selectedMetric, !onRuns, currentBudget(history.key, scenario), pendingTighter(history.key, scenario));
  const sideBySide = width >= SIDE_BY_SIDE_MIN_WIDTH;
  // One column short of the edge: a line that fills the terminal wraps in some of them.
  const runsWidth = (sideBySide ? width - METRICS_PANE_WIDTH - BOX_GAP.length : width) - BOX_MARGIN.length - 1;
  const right = runsPane(history, metric, state.selectedRun ?? 0, onRuns, runsWidth);
  const room = height - title.length - actions.length - 2 - BOX_BORDERS;
  if (sideBySide) {
    return [...title, ...besides(left, inView(right, PANE_HEADER_LINES, state.selectedRun ?? 0, room), runsWidth), ...actions];
  }
  // Stacked, the metrics keep their lines (a scenario has a dozen at most) and the runs scroll in what's left.
  const runsRoom = room - left.length - BOX_BORDERS;
  return [...title, ...paneBox(left, METRICS_PANE_WIDTH), ...paneBox(inView(right, PANE_HEADER_LINES, state.selectedRun ?? 0, runsRoom), runsWidth), ...actions];
}

export function onKey(state: State, key: string): "quit" | void {
  const histories = scenarioHistories(visibleRuns(state));
  const open = histories.find((history) => history.key === state.openKey);
  if (state.confirming) {
    const history = histories.find((h) => h.key === state.confirming);
    state.message = key === "y" && history ? acceptSlower(state.dir, latestOf(history).run, history.key) : "Kept the budget as it was.";
    state.confirming = undefined;
    return;
  }
  state.message = undefined;
  const onRuns = open && state.focus === "runs";
  const count = onRuns ? open.entries.length : open ? Object.keys(latestOf(open).scenario.metrics).length : histories.length;
  const current = onRuns ? (state.selectedRun ?? 0) : open ? state.selectedMetric : state.selected;
  const move = (by: number) => Math.min(Math.max(0, current + by), Math.max(0, count - 1));
  if (key === "q" || key === KEY.ctrlC) return "quit";
  if (key === KEY.up || key === KEY.down) {
    const next = move(key === KEY.up ? -1 : 1);
    if (onRuns) state.selectedRun = next;
    else if (open) {
      // Another metric lists other runs: start them from the newest.
      if (next !== state.selectedMetric) state.selectedRun = 0;
      state.selectedMetric = next;
    } else state.selected = next;
  } else if (key === KEY.space && !open && histories[state.selected]) {
    const key = histories[state.selected].key;
    state.expanded ??= new Set();
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
  } else if (key === KEY.enter && !open && histories[state.selected]) {
    state.openKey = histories[state.selected].key;
    state.selectedMetric = 0;
    state.selectedRun = 0;
    state.focus = "metrics";
  } else if (open && (key === KEY.right || key === KEY.enter)) {
    state.focus = "runs";
  } else if (open && key === KEY.left) {
    state.focus = "metrics";
  } else if ((key === KEY.escape || key === KEY.backspace) && open) {
    state.openKey = undefined;
  } else if (key === "t") {
    const targets = open ? [open] : tightenable(histories);
    const outcomes = targets.map((history) => applyTighter(history.key, latestOf(history).scenario));
    const lowered = outcomes.filter((outcome) => outcome.done).length;
    // One outcome says the most in its own words; several add up to a count, with the first refusal if any.
    if (outcomes.length <= 1) state.message = outcomes[0]?.message ?? "Nothing to lower.";
    else {
      const count = lowered === outcomes.length ? `${lowered}` : `${lowered} of ${outcomes.length}`;
      state.message = [cyan(`Lowered the budgets of ${count} scenarios.`), outcomes.find((o) => !o.done)?.message].filter(Boolean).join(" ");
    }
  } else if (key === "w" && open) {
    if (latestOf(open).scenario.status === "fail") state.confirming = open.key;
    else state.message = "Its last run passed: nothing to accept.";
  } else if (key === "b") {
    const choices = [undefined, ...branchesOf(state.runs)];
    state.branch = choices[(choices.indexOf(state.branch) + 1) % choices.length];
    state.selected = 0;
  }
}

function interactive(dir: string, state: State): void {
  const { stdin, stdout } = process;
  const draw = () => stdout.write(SCREEN.clear + screen(state, stdout.columns || DEFAULT_WIDTH, stdout.rows));
  const indexPath = join(dir, "index.json");
  const reload = () => {
    state.runs = readIndex(dir).runs;
    draw();
  };
  const quit = () => {
    unwatchFile(indexPath, reload);
    stdout.write(SCREEN.leave);
    stdin.setRawMode(false);
    stdin.pause();
  };
  stdout.write(SCREEN.enter);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("data", (key: string) => {
    if (onKey(state, key) === "quit") quit();
    else draw();
  });
  stdout.on("resize", draw);
  watchFile(indexPath, { interval: WATCH_INTERVAL_MS }, reload);
  draw();
}

export function runHistoryCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string", default: DEFAULT_DIR },
      branch: { type: "string" },
      print: { type: "boolean", default: false },
    },
  });
  const dir = resolve(values.dir);
  if (!existsSync(dir)) console.warn(`  No history in ${dir} yet: run the perf suite first.`);
  const state: State = { dir, runs: readIndex(dir).runs, branch: values.branch, selected: -1, selectedMetric: 0 };
  if (values.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    state.printed = true;
    console.log(screen(state, process.stdout.columns || DEFAULT_WIDTH, Infinity).replace(/\n\n[^\n]*$/, ""));
    return;
  }
  state.selected = 0;
  interactive(dir, state);
}
