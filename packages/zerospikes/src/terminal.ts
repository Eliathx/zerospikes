import { round } from "./stats.js";
import type { ScenarioResult } from "./types.js";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const dim = paint(2);
export const bold = paint(1);

/** Status words, padded to the widest (`UPDATED`) plus a space, so the names after them line up. */
export const MARK: Record<ScenarioResult["status"], string> = {
  pass: green("PASS".padEnd(8)),
  fail: red("FAIL".padEnd(8)),
  recorded: yellow("NEW".padEnd(8)),
  updated: yellow("UPDATED".padEnd(8)),
  measured: dim("MEASURED"),
  unchecked: yellow("SKIP".padEnd(8)),
};

const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleWidth = (s: string) => [...s.replace(ANSI, "")].length;
export const padEnd = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleWidth(s)));
export const padStart = (s: string, n: number) => " ".repeat(Math.max(0, n - visibleWidth(s))) + s;
export const truncate = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

/** Whole numbers from 100 up, one decimal below: `1515`, `6.2`. */
export const formatNumber = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : String(round(v)));

const SPARK_LEVELS = "▁▂▃▄▅▆▇█";

const MIDDLE_LEVEL = SPARK_LEVELS[Math.floor(SPARK_LEVELS.length / 2) - 1];

/**
 * `values` as one block character each, from the lowest to the highest. When
 * they spread less than `flatBelow` of the highest, the line is drawn flat:
 * stretching noise to full height would make it look like a change.
 */
export function sparkline(values: number[], flatBelow: number): string {
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (!values.length || high <= 0 || (high - low) / high < flatBelow) return MIDDLE_LEVEL.repeat(values.length);
  const top = SPARK_LEVELS.length - 1;
  return values.map((v) => SPARK_LEVELS[Math.round(((v - low) / (high - low)) * top)]).join("");
}
