import { cpus } from "node:os";

/**
 * Where a budget was recorded. Times depend on the hardware, not just the
 * platform: two Linux machines can be twice as fast as each other, and CI
 * runners change CPU from one run to the next. A budget recorded on one of
 * these is no limit for another.
 */
export interface Environment {
  cpu: string;
  cores: number;
  /** `process.platform-process.arch`, such as `win32-x64`. */
  platform: string;
  /** Browser name and major version, such as `chromium 140`. */
  browser: string;
  headless: boolean;
  /** Refresh rate of the display, in Hz. Only headed runs have one: headless frames follow the browser's own clock. */
  displayHz?: number;
}

/** Refresh rates displays come in; a measured rate is snapped to the nearest. */
const DISPLAY_RATES_HZ = [30, 50, 60, 75, 90, 100, 120, 144, 165, 175, 240, 360];

export function describeEnvironment(browser: { name: string; version: string }, headless: boolean): Environment {
  const cores = cpus();
  return {
    cpu: cores[0]?.model.trim() ?? "unknown",
    cores: cores.length,
    platform: `${process.platform}-${process.arch}`,
    browser: `${browser.name} ${browser.version.split(".")[0]}`,
    headless,
  };
}

/** The display rate closest to a measured frame interval. */
export function displayRateOf(frameIntervalMs: number): number {
  const hz = 1000 / frameIntervalMs;
  return DISPLAY_RATES_HZ.reduce((best, rate) => (Math.abs(rate - hz) < Math.abs(best - hz) ? rate : best));
}

/** What differs between two environments, as `field: recorded → current`. Empty when they match. */
export function environmentDifferences(recorded: Environment, current: Environment): string[] {
  const fields: (keyof Environment)[] = ["cpu", "cores", "platform", "browser", "headless", "displayHz"];
  const out: string[] = [];
  for (const field of fields) {
    // A display rate only matters when both runs had a display.
    if (field === "displayHz" && (recorded.displayHz === undefined || current.displayHz === undefined)) continue;
    if (recorded[field] !== current[field]) out.push(`${field}: ${recorded[field]} → ${current[field]}`);
  }
  return out;
}

/** A short stable id for an environment, to name it once in a budgets file. */
export function environmentId(env: Environment): string {
  const text = JSON.stringify([env.cpu, env.cores, env.platform, env.browser, env.headless, env.displayHz ?? null]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}
