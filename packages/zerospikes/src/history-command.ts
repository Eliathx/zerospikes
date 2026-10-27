import { existsSync, unwatchFile, watchFile } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readIndex, type IndexedRun } from "./history.js";
import { branchesOf, header, scenarioDetail, scenarioHistories, scenarioList } from "./history-view.js";
import { dim } from "./terminal.js";

export const HISTORY_USAGE = `Usage: zerospikes history [options]

Shows how each scenario did across past runs. In a terminal it's interactive
and updates when a run finishes; otherwise (or with --print) it prints once.

  --dir <path>       The reporter's results folder (default zerospikes-results)
  --branch <name>    Only runs on this branch
  --print            Print the scenario list and exit`;

const DEFAULT_DIR = "zerospikes-results";
const DEFAULT_WIDTH = 120;
/** How often the index is checked for a new run. */
const WATCH_INTERVAL_MS = 1000;
/** Lines above and below the list: header, blank lines, column titles, key help. */
const CHROME_LINES = 5;

const SCREEN = {
  enter: "\x1b[?1049h\x1b[?25l",
  leave: "\x1b[?25h\x1b[?1049l",
  clear: "\x1b[H\x1b[2J",
};
export const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", backspace: "\x7f", ctrlC: "\x03" };

export interface State {
  runs: IndexedRun[];
  /** undefined: every branch. */
  branch?: string;
  /** The open scenario, or undefined on the list. */
  openKey?: string;
  selected: number;
  selectedMetric: number;
}

const visibleRuns = (state: State) => (state.branch ? state.runs.filter((run) => run.git?.branch === state.branch) : state.runs);

/** Keeps the selected line on screen: the slice of `lines` (after `fixed` header lines) that holds it. */
function scrolled(lines: string[], fixed: number, selected: number, height: number): string[] {
  const room = Math.max(1, height - fixed - CHROME_LINES);
  const start = Math.max(0, Math.min(selected - Math.floor(room / 2), lines.length - fixed - room));
  return [...lines.slice(0, fixed), ...lines.slice(fixed + start, fixed + start + room)];
}

export function screen(state: State, width: number, height: number): string {
  const runs = visibleRuns(state);
  const histories = scenarioHistories(runs);
  const open = histories.find((history) => history.key === state.openKey);
  const body = open
    ? scenarioDetail(open, state.selectedMetric, width)
    : histories.length
      ? scrolled(scenarioList(histories, state.selected, width), 1, state.selected, height)
      : [dim("    No runs on this branch yet.")];
  const keys = open ? "↑↓ metric · esc back · b branch · q quit" : "↑↓ select · enter open · b branch · q quit";
  return [header(runs, state.branch), "", ...body, "", dim(`  ${keys}`)].join("\n");
}

export function onKey(state: State, key: string): "quit" | void {
  const histories = scenarioHistories(visibleRuns(state));
  const open = histories.find((history) => history.key === state.openKey);
  const count = open ? Object.keys(open.entries.at(-1)!.scenario.metrics).length : histories.length;
  const move = (by: number) => Math.min(Math.max(0, (open ? state.selectedMetric : state.selected) + by), Math.max(0, count - 1));
  if (key === "q" || key === KEY.ctrlC) return "quit";
  if (key === KEY.up || key === KEY.down) {
    const next = move(key === KEY.up ? -1 : 1);
    if (open) state.selectedMetric = next;
    else state.selected = next;
  } else if (key === KEY.enter && !open && histories[state.selected]) {
    state.openKey = histories[state.selected].key;
    state.selectedMetric = 0;
  } else if ((key === KEY.escape || key === KEY.backspace) && open) {
    state.openKey = undefined;
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
  const state: State = { runs: readIndex(dir).runs, branch: values.branch, selected: -1, selectedMetric: 0 };
  if (values.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    console.log(screen(state, process.stdout.columns || DEFAULT_WIDTH, Infinity).replace(/\n\n[^\n]*$/, ""));
    return;
  }
  state.selected = 0;
  interactive(dir, state);
}
