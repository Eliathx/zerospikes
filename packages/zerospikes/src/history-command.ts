import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { acceptSlower, applyTighter, currentBudget, forgetBudgets, pendingTighter } from "./budget-actions.js";
import { readIndex, readRun, type IndexedRun, type Run } from "./history.js";
import {
  branchesOf,
  METRICS_PANE_WIDTH,
  metricsPane,
  PANE_HEADER_LINES,
  missesOf,
  relativeTime,
  runsPane,
  summaryParts,
  scenarioDetails,
  scenarioHistories,
  scenarioList,
  scenarioTitle,
  type ScenarioHistory,
} from "./history-view.js";
import { metricNames } from "./stats.js";
import type { MetricName, ScenarioResult } from "./types.js";
import { bold, boxed, cyan, dim, green, red, truncate, visibleWidth, yellow } from "./terminal.js";

export const HISTORY_USAGE = `Usage: zerospikes [options]

Shows how each scenario did across past runs. In a terminal it's interactive:
it runs the suite (r) and updates when a run finishes, wherever it was started.
From the latest run it can lower the budgets a scenario beat (t), or save a
scenario that failed as its new budget when it is slower on purpose (w).
Otherwise (or with --print) it prints the scenario list once.

  --run <command>    What r runs. Default: "zerospikes": { "run": "…" } in
                     package.json, or else npx playwright test
  --dir <path>       The reporter's results folder (default zerospikes-results)
  --branch <name>    Only runs on this branch
  --print            Print the scenario list and exit`;

const DEFAULT_DIR = "zerospikes-results";
const DEFAULT_RUN = "npx playwright test";
const DEFAULT_WIDTH = 120;
/** How often the index is checked for a new run. */
const WATCH_INTERVAL_MS = 1000;
/** Lines above and below the list: blank lines, column titles, the last action's message, key help. */
const CHROME_LINES = 5;
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
  home: "\x1b[H",
  clearLine: "\x1b[K",
  clearBelow: "\x1b[J",
};
export const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", space: " ", escape: "\x1b", backspace: "\x7f", ctrlC: "\x03" };

/** The keys in one read from the terminal: an escape sequence (an arrow), a lone escape, or a character each. */
export const keysIn = (data: string) => data.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? [];

/** A suite run started with r, as far as its output tells. */
export interface RunningSuite {
  command: string;
  started: number;
  /** From the reporter's `Running N tests`, when it said. */
  total?: number;
  done: number;
  /** Its last line of output: what it's doing. */
  last?: string;
}

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
  /** The suite run going on, started with r. */
  running?: RunningSuite;
  /** Full runs read from the history files, by date: the open scenario's details come from its latest. */
  loaded?: Map<string, Run | undefined>;
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

/** A run in full, read once from the history files. */
function fullRun(state: State, run: IndexedRun): Run | undefined {
  state.loaded ??= new Map();
  if (!state.loaded.has(run.date)) state.loaded.set(run.date, existsSync(join(state.dir, run.file)) ? readRun(state.dir, run) : undefined);
  return state.loaded.get(run.date);
}

/** A scenario's full result in its latest run. */
const latestResult = (state: State, history: ScenarioHistory): ScenarioResult | undefined =>
  fullRun(state, latestOf(history).run)?.results.find((result) => result.key === history.key);

/** A braille spinner, one frame per `SPINNER_FRAME_MS`, as the reporter draws it. */
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const SPINNER_FRAME_MS = 80;

/** The run going on, in one line: a spinner, how far it is and its last line, cut to fit. */
function runningLine(running: RunningSuite, width: number): string {
  const now = Date.now();
  const secs = Math.round((now - running.started) / 1000);
  const frame = SPINNER[Math.floor(now / SPINNER_FRAME_MS) % SPINNER.length];
  const count = running.total ? `${running.done}/${running.total} tests` : running.done ? `${running.done} tests` : running.command;
  const status = `  ${yellow(frame)} Running ${dim(`${count} · ${secs}s`)}`;
  const room = width - count.length - String(secs).length - 22;
  return running.last && room > 10 ? `${status}  ${dim(truncate(running.last, room))}` : status;
}

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
    lines.push(`  ${cyan(LOWER_MARK)} ${cyan("Faster than its budget:")} ${limits.join(", ")}  ${bold("t")} ${dim("lower")}`);
  }
  if (scenario.status === "fail") {
    lines.push(`  ${red("Slower than its budget.")} ${dim("On purpose?")} ${bold("w")} ${dim("save the last run as its budget")}`);
  }
  return lines.length ? ["", ...lines] : [];
}

/** Marks what can be lowered, as the list does. */
const LOWER_MARK = "↓";

/** The last run's box is as wide as the list, at most. */
const LAST_RUN_MAX_WIDTH = 100;
/** Failed scenarios the box names, two lines each; the list marks them all. */
const SHOWN_FAILURES = 3;

/**
 * Under the list, the latest run on view in a box titled with when it ran:
 * its verdict first, then each scenario that failed with what it went over,
 * and how many budgets it beat, with the key that lowers them. It stays until
 * the next run, whoever ran it.
 */
function lastRunBox(state: State, runs: IndexedRun[], lowerable: number, width: number): string[] {
  const latest = runs.at(-1);
  if (!latest) return [];
  const results = fullRun(state, latest)?.results ?? [];
  const failed = results.filter((result) => result.status === "fail");
  const overTarget = results.filter((result) => result.overTarget?.length).length;
  const [count, verdict, ...rest] = summaryParts(Object.values(latest.scenarios), overTarget, false);
  const boxWidth = Math.min(width - BOX_MARGIN.length - 1, LAST_RUN_MAX_WIDTH);
  // Inside the borders, a space of padding on each side.
  const room = boxWidth - 4;
  const mark = Object.values(latest.scenarios).some((scenario) => scenario.status === "fail") ? red("✗") : green("✓");
  const lines = [`${mark} ${bold(verdict)}   ${[count, ...rest].map((part) => dim(part)).join(dim(" · "))}`];
  for (const result of failed.slice(0, SHOWN_FAILURES)) {
    lines.push("", `${red("✗")} ${bold(truncate(`${result.test} › ${result.name}`, room - 2))}`, `  ${red(truncate(missesOf(result), room - 2))}`);
  }
  if (failed.length > SHOWN_FAILURES) lines.push("", dim(`+${failed.length - SHOWN_FAILURES} more failed, marked in the list`));
  if (lowerable) {
    const budgets = lowerable === 1 ? "1 faster than its budget" : `${lowerable} faster than their budgets`;
    lines.push("", `${cyan(`${LOWER_MARK} ${budgets}`)}   ${bold("t")} ${dim("lower")}`);
  }
  const [, ...box] = boxed(lines.map((line) => ` ${line}`), boxWidth);
  const title = `${dim("┌─")} ${bold("Last run")} ${dim(relativeTime(latest.date))} `;
  const top = title + dim("─".repeat(Math.max(0, boxWidth - visibleWidth(title) - 1)) + "┐");
  return [top, ...box, ""].map((line) => (line ? BOX_MARGIN + line : line));
}

export function screen(state: State, width: number, height: number): string {
  const runs = visibleRuns(state);
  const histories = scenarioHistories(runs);
  const open = histories.find((history) => history.key === state.openKey);
  // No actions offered while a run holds the list, nor a selection to act on.
  const lowerable = open || state.printed || state.running ? [] : tightenable(histories);
  const lastRun = open ? [] : lastRunBox(state, runs, lowerable.length, width);
  // With no header above, the branch on view shows by the key that changes it.
  const branch = `b branch: ${state.branch ?? "all"}`;
  const keys = state.running
    ? "q stop the run and quit"
    : open
      ? `↑↓ move · ←→ metrics / runs · esc back · ${branch} · q quit`
      : `↑↓ select · space metrics · enter open · r run · ${branch} · q quit`;
  const status = state.running ? [runningLine(state.running, width)] : state.message ? [`  ${state.message}`] : [];
  const footer = state.confirming
    ? [yellow(`  Save the last run's numbers as the budget of "${state.confirming}"?`), dim("  y yes · any other key no")]
    : [...status, dim(`  ${keys}`)];
  const body = open
    ? scenarioPanes(state, open, width, height - footer.length - 1)
    : histories.length
      ? scrolled(
          scenarioList(
            histories,
            state.running ? -1 : state.selected,
            width,
            new Map(lowerable.map((h) => [h.key, pendingTighter(h.key, latestOf(h).scenario)])),
            new Map(histories.map((h) => [h.key, currentBudget(h.key, latestOf(h).scenario)])),
            state.expanded,
          ),
          1,
          selectedLine(histories, state),
          height - lastRun.length,
        )
      : [dim(state.runs.length ? "    No runs on this branch yet." : state.printed ? "    No runs yet." : "    No runs yet: press r to run the suite.")];
  return ["", ...body, "", ...lastRun, ...footer].join("\n");
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
  const result = latestResult(state, history);
  const actions = [...(result ? scenarioDetails(result, width) : []), ...actionLines(history)];
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

export function onKey(state: State, key: string): "quit" | "run" | void {
  // A run holds the list still until it ends: nothing to wander off to while it goes.
  if (state.running) return key === "q" || key === KEY.ctrlC ? "quit" : undefined;
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
  // From the list only, where the run's outcome shows.
  if (key === "r" && !open) return "run";
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

/** Stops a run and whatever it started: the shell, npm, Playwright and its browsers. */
function stopRun(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(-child.pid, "SIGTERM");
}

/** The reporter's line for a test that ended, with its time: `PASS    filter as you type (3.2s)`. */
const TEST_DONE = /^(PASS|FAIL)\s.*\(\d+(\.\d+)?s\)$/;
const RUNNING_TESTS = /^Running (\d+) tests?$/;

/**
 * Runs the suite under the view, following its output for the footer. The
 * reporter saves the run like any other; when it ends, the view says how it
 * went, or why it saved nothing.
 */
export function startRun(state: State, command: string, draw: () => void): ChildProcess {
  const before = state.runs.at(-1)?.date;
  const running: RunningSuite = { command, started: Date.now(), done: 0 };
  state.running = running;
  // Detached on POSIX so stopping it reaches its whole process group.
  const child = spawn(command, { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const output: string[] = [];
  const onOutput = (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
      const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
      if (!line) continue;
      output.push(line);
      const total = RUNNING_TESTS.exec(line);
      if (total) running.total = Number(total[1]);
      if (TEST_DONE.test(line)) running.done++;
      running.last = line;
    }
    draw();
  };
  child.stdout!.on("data", onOutput);
  child.stderr!.on("data", onOutput);
  child.on("close", (code) => {
    state.running = undefined;
    state.runs = readIndex(state.dir).runs;
    forgetBudgets();
    // A run that saved shows under the list as the last run; one that didn't says why.
    if (state.runs.at(-1)?.date === before) {
      const why = [...output].reverse().find((line) => /error/i.test(line)) ?? output.at(-1) ?? "no output";
      state.message = `${red(`The run saved nothing (exit code ${code}).`)} ${dim(truncate(why, 120))}`;
    }
    draw();
  });
  return child;
}

function interactive(dir: string, state: State, command: string): void {
  const { stdin, stdout } = process;
  // Over the old screen, each line clearing what's left of the old one: no blank frame in between, so no flicker.
  const draw = () => {
    const lines = screen(state, stdout.columns || DEFAULT_WIDTH, stdout.rows).split("\n");
    stdout.write(SCREEN.home + lines.join(SCREEN.clearLine + "\n") + SCREEN.clearLine + SCREEN.clearBelow);
  };
  const indexPath = join(dir, "index.json");
  const reload = () => {
    state.runs = readIndex(dir).runs;
    forgetBudgets();
    draw();
  };
  let run: ChildProcess | undefined;
  // The spinner turns, and the time goes up, even while a build or a long scenario prints nothing.
  const ticker = setInterval(() => state.running && draw(), SPINNER_FRAME_MS);
  const quit = () => {
    if (run) stopRun(run);
    clearInterval(ticker);
    unwatchFile(indexPath, reload);
    stdout.write(SCREEN.leave);
    stdin.setRawMode(false);
    stdin.pause();
  };
  stdout.write(SCREEN.enter + SCREEN.clear);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("data", (data: string) => {
    // A held arrow sends keys faster than they're drawn: they arrive together, and each one counts. One draw for them all.
    for (const key of keysIn(data)) {
      const action = onKey(state, key);
      if (action === "quit") return quit();
      if (action === "run") run = startRun(state, command, draw);
    }
    draw();
  });
  stdout.on("resize", () => {
    stdout.write(SCREEN.clear);
    draw();
  });
  watchFile(indexPath, { interval: WATCH_INTERVAL_MS }, reload);
  draw();
}

/** What r runs when --run doesn't say: the command the project's package.json names, or Playwright on its own. */
function defaultRunCommand(): string {
  try {
    const run = JSON.parse(readFileSync("package.json", "utf8")).zerospikes?.run;
    if (typeof run === "string" && run) return run;
  } catch {
    // No package.json here, or one that isn't JSON.
  }
  return DEFAULT_RUN;
}

export function runHistoryCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string", default: DEFAULT_DIR },
      branch: { type: "string" },
      run: { type: "string" },
      print: { type: "boolean", default: false },
    },
  });
  const dir = resolve(values.dir);
  const state: State = { dir, runs: readIndex(dir).runs, branch: values.branch, selected: -1, selectedMetric: 0 };
  if (values.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    if (!existsSync(dir)) console.warn(`  No history in ${dir} yet: run the perf suite first.`);
    state.printed = true;
    console.log(screen(state, process.stdout.columns || DEFAULT_WIDTH, Infinity).replace(/\n\n[^\n]*$/, ""));
    return;
  }
  state.selected = 0;
  interactive(dir, state, values.run ?? defaultRunCommand());
}
