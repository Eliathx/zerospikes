import type { FullConfig, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readGitState } from "./git.js";
import { recordRun } from "./history.js";
import { failureLines, isFailure, runSummary } from "./history-view.js";
import { inCompareSession, SESSION_ENV } from "./session.js";
import { bold, dim, MARK, padEnd, truncate, yellow } from "./terminal.js";
import type { ScenarioResult } from "./types.js";

export interface ZeroSpikesReporterOptions {
  /** Folder for the run history, relative to the config. Default `zerospikes-results`. */
  outputDir?: string;
}

const HIDE_CURSOR = "\x1b[?25l";
const showCursor = () => process.stdout.write("\x1b[?25h");

/**
 * A line per test as it ends and a short summary at the end: the details,
 * trends and budget actions are in `npx zerospikes`, from the history this
 * saves.
 */
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
    // Without a terminal there is no progress line to count on: say up front how many there are.
    if (!process.stdout.isTTY && this.total && !inCompareSession()) console.log(`  Running ${this.total} ${this.total === 1 ? "test" : "tests"}`);
  }

  /**
   * The running scenario in the list, lined up with the finished ones and its
   * time so far, over a line pinned at the bottom with a braille spinner and
   * how far the run is. TTY only.
   */
  onTestBegin(test: TestCase): void {
    if (!process.stdout.isTTY) return;
    this.clearProgress();
    const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    const started = Date.now();
    let i = 0;
    const draw = () => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      // Kept within the terminal: a line that wraps would leave the cursor short of the block's top.
      const room = (process.stdout.columns || 120) - 1;
      const running = `  ${padEnd(dim("RUNNING"), 8)}${truncate(test.title, room - 18)} ${dim(`(${secs}s)`)}`;
      const count = this.total ? ` ${dim(`(${this.done + 1}/${this.total})`)}` : "";
      const footer = `  ${yellow(frames[i++ % frames.length])} Running tests${count}`;
      // Drawn from the block's top, which the cursor goes back to after each draw.
      process.stdout.write(`\r\x1b[0J${running}\n\n${footer}\x1b[2A\r`);
    };
    // The cursor hidden while it sits at the block's top; shown again on the way out, even on Ctrl+C.
    process.stdout.write(HIDE_CURSOR);
    process.once("exit", showCursor);
    draw();
    this.spinner = setInterval(draw, 80);
  }

  /** Clears the running scenario and the line under it, leaving the cursor where the next result goes. */
  private clearProgress(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    process.stdout.write("\r\x1b[0J");
    showCursor();
    process.off("exit", showCursor);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const own: ScenarioResult[] = [];
    for (const a of result.attachments) {
      if (a.name === "zerospikes" && a.body) own.push(JSON.parse(a.body.toString()) as ScenarioResult);
    }
    this.results.push(...own);
    this.done++;
    this.clearProgress();
    const failed = (result.status !== "passed" && result.status !== "skipped") || own.some((r) => r.status === "fail");
    const secs = (result.duration / 1000).toFixed(1);
    // A broken scenario before a slow one: its numbers say nothing until it's fixed.
    const mark = own.some((r) => r.status === "error") ? MARK.error : failed ? MARK.fail : MARK.pass;
    console.log(`  ${mark}${test.title} ${dim(`(${secs}s)`)}`);
    // A failure no scenario explains: the test's own error says why.
    if (failed && !own.some(isFailure) && result.error?.message) console.log(dim(result.error.message.split("\n")[0]));
  }

  onEnd(): void {
    this.clearProgress();
    const sessionFile = process.env[SESSION_ENV.resultsFile];
    if (sessionFile) {
      writeFileSync(sessionFile, JSON.stringify({ results: this.results }));
      return;
    }
    if (!this.results.length) return;
    const overTarget = this.results.filter((r) => r.overTarget?.length).length;
    const lines = ["", `  ${bold("zerospikes")}  ${runSummary(this.results, overTarget)}`, ...failureLines(this.results, "  ")];
    lines.push("", dim("  Details, trends and budgets: npx zerospikes"), "");

    const dir = resolve(this.rootDir, this.options.outputDir ?? "zerospikes-results");
    mkdirSync(dir, { recursive: true });
    recordRun(dir, { date: new Date().toISOString(), git: readGitState(this.rootDir), results: this.results });
    console.log(lines.join("\n"));
  }

  printsToStdio(): boolean {
    return true;
  }
}
