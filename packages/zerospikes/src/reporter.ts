import type { FullConfig, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unitOf } from "./budgets.js";
import { readGitState } from "./git.js";
import { recordRun } from "./history.js";
import { SESSION_ENV } from "./session.js";
import { metricNames, round } from "./stats.js";
import type { MetricName, Metrics, ScenarioResult } from "./types.js";

export interface ZeroSpikesReporterOptions {
  /** Folder for the run history, relative to the config. Default `zerospikes-results`. */
  outputDir?: string;
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

/** Status words, padded to the widest (`UPDATED`) plus a space, so the names after them line up. */
const MARK: Record<ScenarioResult["status"], string> = {
  pass: green("PASS".padEnd(8)),
  fail: red("FAIL".padEnd(8)),
  recorded: yellow("NEW".padEnd(8)),
  updated: yellow("UPDATED".padEnd(8)),
  measured: dim("MEASURED"),
  unchecked: yellow("SKIP".padEnd(8)),
};

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleWidth = (s: string) => [...s.replace(ANSI, "")].length;
const padEnd = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleWidth(s)));
const padStart = (s: string, n: number) => " ".repeat(Math.max(0, n - visibleWidth(s))) + s;
const truncate = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

/** Whole numbers from 100 up, one decimal below: `1515`, `6.2`. */
const formatNumber = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : String(round(v)));

interface Cell {
  /** Left-aligned word before the value, such as the input phase. */
  tag?: string;
  text: string;
  limit?: number;
  over: boolean;
}

interface Widths {
  tag: number;
  value: number;
  limit: number;
}

const cellWidth = (w: Widths) => (w.tag ? w.tag + 1 : 0) + w.value + w.limit + 3;

/** `value ≤ limit`, the limit dimmed and the whole cell red when over. */
function cell(metrics: Metrics, budget: Metrics | null, r: ScenarioResult, metric: MetricName, tag?: string): Cell | null {
  const value = metrics[metric];
  if (value === undefined) return null;
  const violation = r.violations.find((v) => v.metric === metric);
  // An unchecked scenario's budget belongs to another machine: showing it as the limit would mislead.
  const limit = violation?.limit ?? (r.status === "unchecked" ? undefined : budget?.[metric]);
  return { tag, text: formatNumber(value), limit, over: !!violation };
}

function renderCell(content: Cell | null, widths: Widths): string {
  if (!content) return padEnd(dim("—"), cellWidth(widths));
  const tag = widths.tag ? padEnd(content.tag ?? "", widths.tag) + " " : "";
  const value = padStart(content.text, widths.value);
  if (content.limit === undefined) return padEnd(tag + value, cellWidth(widths));
  const limit = padEnd(formatNumber(content.limit), widths.limit);
  return content.over ? red(`${tag}${value} > ${limit}`) : `${tag}${value} ${dim("≤ " + limit)}`;
}

/** The input phase closest to (or furthest over) its budget: the one worth reading. */
function worstInput(r: ScenarioResult): Cell | null {
  const phases = metricNames(r.metrics).filter((name) => name.startsWith("input."));
  if (!phases.length) return null;
  const value = (name: MetricName) => r.metrics[name] ?? 0;
  const ratio = (name: MetricName) => value(name) / (r.budget?.[name] ?? (value(name) || 1));
  const worst = phases.sort((a, b) => ratio(b) - ratio(a) || value(b) - value(a))[0];
  return cell(r.metrics, r.budget, r, worst, worst.slice("input.".length));
}

interface Column {
  title: string;
  get: (r: ScenarioResult) => Cell | null;
}

const GAP = "   ";

interface Table {
  title: string;
  rows: ScenarioResult[];
  cells: (Cell | null)[][];
  columns: Column[];
  widths: Widths[];
  columnWidths: number[];
}

function layout(title: string, rows: ScenarioResult[], columns: Column[]): Table {
  const cells = rows.map((r) => columns.map((c) => c.get(r)));
  const widths = columns.map((_, i) => {
    const col = cells.map((row) => row[i]).filter((c): c is Cell => !!c);
    return {
      tag: Math.max(0, ...col.map((c) => visibleWidth(c.tag ?? ""))),
      value: Math.max(1, ...col.map((c) => visibleWidth(c.text))),
      limit: Math.max(1, ...col.map((c) => (c.limit !== undefined ? formatNumber(c.limit).length : 0))),
    };
  });
  const columnWidths = columns.map((c, i) => Math.max(visibleWidth(c.title), cellWidth(widths[i])));
  return { title, rows, cells, columns, widths, columnWidths };
}

/** Tables share one name column so they line up; it shrinks (with …) to fit the terminal. */
function render(tables: Table[], termWidth: number): string[] {
  // Everything on a row but the name: the columns, the indent and the status word.
  const fixed = Math.max(...tables.map((t) => t.columnWidths.reduce((a, b) => a + b, 0) + GAP.length * t.columnWidths.length)) + 2 + 8;
  const longest = Math.max(...tables.flatMap((t) => t.rows.map((r) => [...label(r)].length)));
  const labelWidth = Math.max(24, Math.min(longest, termWidth - fixed));
  const out: string[] = [];
  for (const t of tables) {
    out.push(`  ${bold(padEnd(t.title, labelWidth + 8))}${t.columns.map((c, i) => GAP + dim(padEnd(c.title, t.columnWidths[i]))).join("")}`);
    t.rows.forEach((r, ri) => {
      const name = padEnd(fitLabel(r, labelWidth), labelWidth);
      const tail = t.cells[ri].map((c, i) => GAP + padEnd(renderCell(c, t.widths[i]), t.columnWidths[i])).join("");
      out.push(`  ${MARK[r.status]}${name}${tail}`.trimEnd());
    });
    out.push("");
  }
  return out;
}

const INTERACTION: Column[] = [
  { title: "frame max", get: (r) => cell(r.metrics, r.budget, r, "frame.max") },
  { title: "frame p95", get: (r) => cell(r.metrics, r.budget, r, "frame.p95") },
  { title: "worst input → frame", get: worstInput },
  { title: "slow frames", get: (r) => cell(r.metrics, r.budget, r, "frame.slow") },
  { title: "main-thread CPU", get: (r) => cell(r.metrics, r.budget, r, "cpu.main") },
];

const MEMORY: Column[] = [
  { title: "heap growth MB", get: (r) => cell(r.metrics, r.budget, r, "memory.heapMB") },
  { title: "DOM nodes", get: (r) => cell(r.metrics, r.budget, r, "memory.nodes") },
  { title: "listeners", get: (r) => cell(r.metrics, r.budget, r, "memory.listeners") },
];

function label(r: ScenarioResult): string {
  return `${r.test} › ${r.name}`;
}

/** Shortens the test title before the scenario name, which says what was measured. */
function fitLabel(r: ScenarioResult, n: number): string {
  const full = label(r);
  if ([...full].length <= n) return full;
  const room = n - [...r.name].length - 3;
  return room >= 6 ? `${truncate(r.test, room)} › ${r.name}` : truncate(full, n);
}

/** Everything that went over, worst first, plus where the time went. */
function failureDetail(r: ScenarioResult): string[] {
  const out = [`  ${MARK.fail}${bold(label(r))}`];
  // Input phases of one click or drag often share a number: one line for them.
  const linesByKey = new Map<string, { names: string[]; value: number; limit: number; fixed: boolean; metric: MetricName }>();
  for (const v of r.violations) {
    const phase = v.metric.startsWith("input.") ? v.metric.slice("input.".length) : null;
    const key = phase ? `input:${formatNumber(v.value)}:${v.source}` : v.metric;
    const line = linesByKey.get(key);
    if (line && phase) {
      line.names.push(phase);
      line.limit = Math.min(line.limit, v.limit);
    } else {
      linesByKey.set(key, { names: [phase ?? v.metric], value: v.value, limit: v.limit, fixed: v.source === "fixed", metric: v.metric });
    }
  }
  const lines = [...linesByKey.values()]
    .map((line) => ({ ...line, label: line.metric.startsWith("input.") ? `input ${line.names.join("/")}` : line.metric }))
    .sort((a, b) => b.value / Math.max(b.limit, 1) - a.value / Math.max(a.limit, 1));
  const labelWidth = Math.max(...lines.map((line) => line.label.length));
  const valueWidth = Math.max(...lines.map((line) => (formatNumber(line.value) + unitOf(line.metric)).length));
  const limitWidth = Math.max(...lines.map((line) => formatNumber(line.limit).length));
  for (const line of lines) {
    const times = line.limit > 0 ? `${(line.value / line.limit).toFixed(1)}x over` : "";
    const budget = `budget ${padEnd(formatNumber(line.limit), limitWidth)}${line.fixed ? " (fixed)" : ""}`;
    const value = padStart(formatNumber(line.value) + unitOf(line.metric), valueWidth);
    out.push(`      ${padEnd(line.label, labelWidth)}   ${red(value)}   ${dim(budget)}   ${dim(times)}`);
  }
  if (r.cpu) {
    out.push(`      ${dim("main-thread CPU, median run:")} script ${formatNumber(r.cpu.scriptMs)} ms · layout ${formatNumber(r.cpu.layoutMs)} ms · style ${formatNumber(r.cpu.styleMs)} ms`);
  }
  if (r.hot?.length) {
    out.push(`      ${dim("self time, one profiled run:")}`);
    for (const h of r.hot.slice(0, 3)) out.push(`      ${padStart(formatNumber(h.selfMs) + " ms", 10)}  ${h.fn}`);
  }
  if (r.samples) out.push(`      ${dim("per cycle:")} ${r.samples.map((s) => `${s.domNodes} nodes`).join(dim(" → "))}`);
  if (r.profilePath) out.push(`      ${dim("profile: " + r.profilePath)}`);
  return out;
}

/** Why some scenarios were skipped: one line per distinct difference, usually one for the whole run. */
function otherMachineNote(results: ScenarioResult[]): string[] {
  const byDifference = new Map<string, number>();
  for (const r of results) {
    if (r.status !== "unchecked" || !r.otherMachine) continue;
    const difference = r.otherMachine.join(", ");
    byDifference.set(difference, (byDifference.get(difference) ?? 0) + 1);
  }
  if (!byDifference.size) return [];
  const out: string[] = [];
  for (const [difference, count] of byDifference) {
    out.push(`  ${MARK.unchecked}${count} scenario${count === 1 ? "" : "s"}: budgets recorded on another machine (${difference})`);
  }
  out.push(dim("      not compared: their numbers are no limit here. Record this machine's with -u, or compare two builds with zerospikes compare"), "");
  return out;
}

/** One table per kind of scenario at the end of the run, details of the failures, and a JSON of it all. */
export default class ZeroSpikesReporter implements Reporter {
  private readonly results: ScenarioResult[] = [];
  private rootDir = process.cwd();
  private total = 0;
  private done = 0;
  private spinner?: NodeJS.Timeout;

  constructor(private readonly options: ZeroSpikesReporterOptions = {}) {}

  onBegin(config: FullConfig, suite?: Suite): void {
    this.rootDir = config.configFile ? join(config.configFile, "..") : config.rootDir;
    this.total = suite?.allTests().length ?? 0;
  }

  /** A braille spinner with elapsed time on the running scenario's line, TTY only. */
  onTestBegin(test: TestCase): void {
    if (!process.stdout.isTTY) return;
    const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    const started = Date.now();
    let i = 0;
    const draw = () => {
      const progress = this.total ? dim(`[${this.done + 1}/${this.total}] `) : "";
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(`\r\x1b[2K  ${yellow(frames[i++ % frames.length])} ${progress}${test.title} ${dim(`(${secs}s)`)}`);
    };
    draw();
    this.spinner = setInterval(draw, 80);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const own: ScenarioResult[] = [];
    for (const a of result.attachments) {
      if (a.name === "zerospikes" && a.body) own.push(JSON.parse(a.body.toString()) as ScenarioResult);
    }
    this.results.push(...own);
    this.done++;
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = undefined;
      process.stdout.write("\r\x1b[2K");
    }
    const failed = (result.status !== "passed" && result.status !== "skipped") || own.some((r) => r.status === "fail");
    const secs = (result.duration / 1000).toFixed(1);
    console.log(`  ${failed ? MARK.fail : MARK.pass}${test.title} ${dim(`(${secs}s)`)}`);
    if (failed && !own.length && result.error?.message) console.log(dim(result.error.message.split("\n")[0]));
  }

  onEnd(): void {
    const sessionFile = process.env[SESSION_ENV.resultsFile];
    if (sessionFile) {
      writeFileSync(sessionFile, JSON.stringify({ results: this.results }));
      return;
    }
    if (!this.results.length) return;
    const termWidth = process.stdout.columns || Number(process.env.COLUMNS) || 120;
    const count = (s: ScenarioResult["status"]) => this.results.filter((r) => r.status === s).length;
    const parts = [`${this.results.length} scenarios`];
    parts.push(count("fail") ? red(`${count("fail")} over budget`) : green("all within budget"));
    if (count("recorded")) parts.push(yellow(`${count("recorded")} budgets recorded`));
    if (count("updated")) parts.push(yellow(`${count("updated")} budgets updated`));
    if (count("unchecked")) parts.push(yellow(`${count("unchecked")} with budgets from another machine`));

    const lines = ["", `  ${bold("zerospikes")}  ${parts.join(dim(" · "))}`, ""];
    const interactions = this.results.filter((r) => r.kind === "interaction");
    const memory = this.results.filter((r) => r.kind === "memory");
    const tables: Table[] = [];
    if (interactions.length) tables.push(layout("Interactions", interactions, INTERACTION));
    if (memory.length) tables.push(layout("Memory", memory, MEMORY));
    lines.push(...render(tables, termWidth));
    for (const r of this.results.filter((x) => x.status === "fail")) lines.push(...failureDetail(r), "");
    lines.push(...otherMachineNote(this.results));

    const dir = join(this.rootDir, this.options.outputDir ?? "zerospikes-results");
    mkdirSync(dir, { recursive: true });
    const file = recordRun(dir, { date: new Date().toISOString(), git: readGitState(this.rootDir), results: this.results });
    lines.push(dim("  ms unless named · value ≤ budget"), dim(`  ${file}`), "");
    console.log(lines.join("\n"));
  }

  printsToStdio(): boolean {
    return true;
  }
}
