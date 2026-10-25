import type { CDPSession } from "@playwright/test";
import { round } from "./stats.js";
import type { CpuBreakdown, HotFunction, MemorySample } from "./types.js";

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
export interface CpuProfile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

const NOISE = /^\((idle|program|root)\)$/;

/** Self time per function, busiest first. */
export function hotFunctions(profile: CpuProfile, top = 8): HotFunction[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  // Callbacks (sort comparators, filter predicates) are usually anonymous: name
  // them after the nearest named caller so the line says where they live.
  const nameOf = (id: number): string => {
    const own = byId.get(id)!.callFrame.functionName;
    if (own) return own;
    for (let p = parent.get(id); p !== undefined; p = parent.get(p)) {
      const fn = byId.get(p)!.callFrame.functionName;
      if (fn && !NOISE.test(fn)) return `(anonymous in ${fn})`;
    }
    return "(anonymous)";
  };
  const self = new Map<string, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    const cf = byId.get(profile.samples[i])?.callFrame;
    if (!cf) continue;
    const fn = nameOf(profile.samples[i]);
    if (NOISE.test(fn)) continue;
    const file = cf.url.split("/").pop()?.split("?")[0] ?? "";
    const name = file ? `${fn} @ ${file}:${cf.lineNumber + 1}` : fn;
    self.set(name, (self.get(name) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  return [...self]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([fn, ms]) => ({ fn, selfMs: round(ms) }));
}

export async function startProfiler(cdp: CDPSession): Promise<void> {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
}

export async function stopProfiler(cdp: CDPSession): Promise<CpuProfile> {
  const { profile } = await cdp.send("Profiler.stop");
  await cdp.send("Profiler.disable");
  return profile as unknown as CpuProfile;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pause between the two GC passes, so finalizers queued by the first can run. */
const GC_PASS_GAP_MS = 100;

/** Forces GC twice: one pass doesn't always reach a steady heap. */
export async function collectGarbage(cdp: CDPSession): Promise<void> {
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(GC_PASS_GAP_MS);
  await cdp.send("HeapProfiler.collectGarbage");
}

/**
 * Makes the renderer's performance counters report time the main thread spent
 * running (thread ticks) rather than time on the clock, so other processes
 * taking the CPU away don't count.
 */
export async function enableCpuClock(cdp: CDPSession): Promise<void> {
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
}

/**
 * Main-thread CPU time so far, in ms. `mainMs` is every task the main thread ran
 * except DevTools commands, which are the test driving the page, not the app.
 */
export async function readCpuClock(cdp: CDPSession): Promise<CpuBreakdown & { mainMs: number }> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const ms = (name: string) => (metrics.find((m) => m.name === name)?.value ?? 0) * 1000;
  return {
    mainMs: ms("TaskDuration") - ms("DevToolsCommandDuration"),
    scriptMs: ms("ScriptDuration"),
    layoutMs: ms("LayoutDuration"),
    styleMs: ms("RecalcStyleDuration"),
  };
}

/**
 * JS heap and DOM counters after forcing GC. Counts are steadier than bytes, so
 * leaks of nodes and listeners show even when the heap is noisy.
 */
export async function sampleMemory(cdp: CDPSession): Promise<MemorySample> {
  await collectGarbage(cdp);
  const heap = await cdp.send("Runtime.getHeapUsage");
  const dom = await cdp.send("Memory.getDOMCounters");
  return {
    heapMB: round(heap.usedSize / 1048576),
    domNodes: dom.nodes,
    listeners: dom.jsEventListeners,
  };
}
