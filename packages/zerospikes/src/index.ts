import { test as base, expect, type CDPSession, type Page, type TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { BudgetStore, check, deriveBudget, unitOf, validateLimits } from "./budgets.js";
import { collectGarbage, enableCpuClock, hotFunctions, readCpuClock, sampleMemory, startProfiler, stopProfiler } from "./cdp.js";
import { finishRecording, nextFrame, startRecording } from "./in-page.js";
import { SESSION_ENV, inCompareSession } from "./session.js";
import { aggregate, median, metricNames, round, runMetrics, worstOf } from "./stats.js";
import {
  INTERACTION_METRICS,
  MEMORY_METRICS,
  type CpuBreakdown,
  type CyclesOptions,
  type MeasureOptions,
  type MemorySample,
  type MetricName,
  type Metrics,
  type ScenarioResult,
  type Violation,
} from "./types.js";

export type * from "./types.js";
export { expect };

type Point = [x: number, y: number];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export class ZeroSpikes {
  private cdpSession: CDPSession | null = null;
  private cpuClockEnabled = false;
  /** Scenarios over budget, thrown together when the test ends. */
  private readonly failures: Error[] = [];
  private readonly store: BudgetStore;

  constructor(
    readonly page: Page,
    private readonly testInfo: TestInfo,
    private readonly chromium: boolean,
  ) {
    this.store = new BudgetStore(testInfo.file);
  }

  /**
   * Runs `act` (after `warmup` unmeasured runs) `runs` times while recording
   * frames and input latency, takes the median of each metric and checks it
   * against the budget recorded for this scenario. When over budget it
   * CPU-profiles one more run to say what the time went into and fails the
   * test once it ends, like `expect.soft`: the scenarios after it still run.
   * In Chromium every run starts after a forced GC, so garbage left by the
   * previous run isn't collected inside this one, and main-thread CPU time is
   * recorded too.
   */
  async measure(name: string, act: () => Promise<void>, opts: MeasureOptions = {}): Promise<ScenarioResult> {
    const { runs = 5, warmup = 1, before, settleMs = 300, profileOnFail = true } = opts;
    const perRun: Metrics[] = [];
    const cpuPerRun: CpuBreakdown[] = [];
    // How many long frames each script showed up in, across the measured runs.
    const longFrameScripts = new Map<string, number>();
    for (let i = 0; i < warmup + runs; i++) {
      if (before) await before();
      const cpuAtStart = this.chromium ? await this.startCpuClock() : null;
      await this.page.evaluate(startRecording);
      await act();
      const recording = await this.page.evaluate(finishRecording, settleMs);
      const cpuAtEnd = cpuAtStart ? await readCpuClock(await this.cdp()) : null;
      if (i < warmup) continue;
      const metrics = runMetrics(recording);
      if (cpuAtStart && cpuAtEnd) {
        metrics["cpu.main"] = round(cpuAtEnd.mainMs - cpuAtStart.mainMs);
        cpuPerRun.push({
          scriptMs: cpuAtEnd.scriptMs - cpuAtStart.scriptMs,
          layoutMs: cpuAtEnd.layoutMs - cpuAtStart.layoutMs,
          styleMs: cpuAtEnd.styleMs - cpuAtStart.styleMs,
        });
      }
      perRun.push(metrics);
      for (const frame of recording.longFrames ?? []) {
        for (const script of frame.scripts) longFrameScripts.set(script, (longFrameScripts.get(script) ?? 0) + 1);
      }
    }
    const metrics = aggregate(perRun);
    if (opts.budget) validateLimits(name, opts.budget, INTERACTION_METRICS, metrics);
    const result = this.decide("interaction", name, metrics, worstOf(perRun), opts.budget);
    result.runs = perRun;
    if (cpuPerRun.length) {
      result.cpu = {
        scriptMs: round(median(cpuPerRun.map((c) => c.scriptMs))),
        layoutMs: round(median(cpuPerRun.map((c) => c.layoutMs))),
        styleMs: round(median(cpuPerRun.map((c) => c.styleMs))),
      };
    }
    if (longFrameScripts.size) {
      result.longFrameScripts = [...longFrameScripts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([script]) => script);
    }

    if (result.status === "fail" && profileOnFail && this.chromium) {
      const cdp = await this.cdp();
      if (before) await before();
      await collectGarbage(cdp);
      await startProfiler(cdp);
      await act();
      await this.page.waitForTimeout(settleMs);
      const profile = await stopProfiler(cdp);
      result.hot = hotFunctions(profile);
      result.profilePath = this.testInfo.outputPath(`${slug(name)}.cpuprofile`);
      writeFileSync(result.profilePath, JSON.stringify(profile));
      await this.testInfo.attach(`${name}.cpuprofile`, { path: result.profilePath, contentType: "application/json" });
    }
    return this.finish(result);
  }

  /**
   * Memory check for a repeated cycle (open → edit → close): forces GC and
   * samples heap and DOM counters after every cycle, and checks how much
   * stayed behind compared with the baseline taken after the warm-up.
   * Chromium only; skipped with an annotation elsewhere. Fails softly, like `measure`.
   */
  async cycles(name: string, cycle: () => Promise<void>, opts: CyclesOptions = {}): Promise<ScenarioResult | null> {
    if (!this.chromium) {
      this.testInfo.annotations.push({ type: "zerospikes", description: `"${name}" skipped: memory needs Chromium` });
      return null;
    }
    const { cycles = 5, warmup = 1 } = opts;
    const cdp = await this.cdp();
    for (let i = 0; i < warmup; i++) await cycle();
    const samples: MemorySample[] = [await sampleMemory(cdp)];
    for (let i = 0; i < cycles; i++) {
      await cycle();
      samples.push(await sampleMemory(cdp));
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    const metrics: Metrics = {
      "memory.heapMB": round(last.heapMB - first.heapMB),
      "memory.nodes": last.domNodes - first.domNodes,
      "memory.listeners": last.listeners - first.listeners,
    };
    if (opts.budget) validateLimits(name, opts.budget, MEMORY_METRICS, metrics);
    const result = this.decide("memory", name, metrics, metrics, opts.budget);
    result.samples = samples;
    return this.finish(result);
  }

  /** A drag paced like a hand: one pointermove per frame, so slow frames slow the gesture down too. */
  async drag(from: Point, to: Point, { steps = 20 }: { steps?: number } = {}): Promise<void> {
    const { mouse } = this.page;
    await mouse.move(from[0], from[1]);
    await mouse.down();
    for (let i = 1; i <= steps; i++) {
      await mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
      await this.frame();
    }
    await mouse.up();
  }

  /** Resolves on the page's next animation frame: pace scripted input like a person would. */
  frame(): Promise<void> {
    return this.page.evaluate(nextFrame);
  }

  /** Forces GC, then reads the main thread's CPU clock: the start of a measured window. */
  private async startCpuClock() {
    const cdp = await this.cdp();
    if (!this.cpuClockEnabled) {
      await enableCpuClock(cdp);
      this.cpuClockEnabled = true;
    }
    await collectGarbage(cdp);
    return readCpuClock(cdp);
  }

  private async cdp(): Promise<CDPSession> {
    this.cdpSession ??= await this.page.context().newCDPSession(this.page);
    return this.cdpSession;
  }

  /**
   * Compares `metrics` with the recorded budget, recording or updating it as
   * `-u` / `ZS_UPDATE` say. New budgets are derived from `worst`, so they
   * already cover the run-to-run spread seen while recording.
   */
  private decide(kind: ScenarioResult["kind"], name: string, metrics: Metrics, worst: Metrics, fixed?: Metrics): ScenarioResult {
    const test = this.testInfo.titlePath.slice(1).join(" › ");
    const project = this.testInfo.project.name || "default";
    const key = `${project} › ${test} › ${name}`;
    if (inCompareSession()) return { kind, key, test, name, project, metrics, budget: null, status: "measured", violations: [] };
    const mode = process.env.ZS_UPDATE ? "all" : this.testInfo.config.updateSnapshots;
    const stored = this.store.get(key);
    let budget: Metrics | null = stored ?? null;
    let status: ScenarioResult["status"];
    let violations: Violation[] = [];

    if (!stored) {
      if (mode === "none") {
        status = "pass";
      } else {
        budget = deriveBudget(worst);
        this.store.set(key, budget);
        status = "recorded";
      }
    } else {
      violations = check(metrics, stored, "budget");
      if (mode === "all" || (mode === "changed" && violations.length)) {
        budget = deriveBudget(worst);
        this.store.set(key, budget);
        violations = [];
        status = "updated";
      } else {
        // A metric seen for the first time (a new input phase) gets a budget without failing.
        const added = metricNames(metrics).filter((name: MetricName) => !(name in stored));
        if (added.length && mode !== "none") {
          const derived = deriveBudget(worst);
          budget = { ...stored };
          for (const metric of added) budget[metric] = derived[metric];
          this.store.set(key, budget);
        }
        status = violations.length ? "fail" : "pass";
      }
    }
    if (fixed) {
      const over = check(metrics, fixed, "fixed");
      violations.push(...over);
      if (over.length) status = "fail";
    }
    return { kind, key, test, name, project, metrics, budget, status, violations };
  }

  private async finish(result: ScenarioResult): Promise<ScenarioResult> {
    await this.testInfo.attach("zerospikes", { body: JSON.stringify(result), contentType: "application/json" });
    // Created here so its stack points at the scenario's line in the test, not at the fixture.
    if (result.status === "fail") this.failures.push(new Error(formatFailure(result, this.store.path)));
    return result;
  }

  /** Throws every over-budget scenario of the test at once; called by the fixture after the test body. */
  assertWithinBudgets(): void {
    if (!this.failures.length) return;
    const [first] = this.failures;
    const message = this.failures.map((e) => e.message).join("\n\n");
    first.stack = first.stack?.replace(first.message, () => message);
    first.message = message;
    throw first;
  }
}

/** The failure message of a scenario over budget, shown under the test in Playwright's output. */
function formatFailure(r: ScenarioResult, budgetPath: string): string {
  const lines = [`zerospikes: "${r.name}" is over budget`];
  for (const v of r.violations) {
    lines.push(`  ${v.metric.padEnd(16)} ${String(v.value).padStart(8)}${unitOf(v.metric)}  > ${v.limit}${v.source === "fixed" ? " (fixed limit)" : ""}`);
  }
  if (r.cpu) {
    lines.push("", `  main-thread CPU, median run: script ${r.cpu.scriptMs} ms · layout ${r.cpu.layoutMs} ms · style ${r.cpu.styleMs} ms`);
  }
  if (r.hot?.length) {
    lines.push("", "  self time in one profiled run:");
    for (const h of r.hot) lines.push(`  ${String(h.selfMs).padStart(8)} ms  ${h.fn}`);
  }
  if (r.longFrameScripts?.length) lines.push("", `  long frames came from: ${r.longFrameScripts.join(", ")}`);
  if (r.samples) lines.push("", `  per cycle: ${r.samples.map((s) => `${s.heapMB} MB / ${s.domNodes} nodes`).join(" → ")}`);
  if (r.profilePath) lines.push("", `  CPU profile: ${r.profilePath}  (DevTools › Performance › Load profile)`);
  if (r.violations.some((v) => v.source === "budget")) {
    lines.push(`  budgets: ${budgetPath}. If the change is intended: npx playwright test -u`);
  }
  return lines.join("\n");
}

export const test = base.extend<{ zs: ZeroSpikes }>({
  baseURL: async ({ baseURL }, use) => use(process.env[SESSION_ENV.baseURL] || baseURL),
  zs: async ({ page, browserName }, use, testInfo) => {
    const zs = new ZeroSpikes(page, testInfo, browserName === "chromium");
    await use(zs);
    zs.assertWithinBudgets();
  },
});
