import { round } from "./stats.js";
import type { ScenarioResult } from "./types.js";

const color = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
/** Whether the helpers below paint: off outside a terminal and with NO_COLOR. */
export const hasColor = color;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);
export const dim = paint(2);
export const bold = paint(1);
/** The lines of a tree under a row: a muted green, the one colour picked by hand rather than left to the theme. */
export const treeLine = (s: string) => (color ? `\x1b[38;2;91;150;107m${s}\x1b[0m` : s);

const RESET = "\x1b[0m";
/** A dark grey from the 256-colour palette: visible on dark and light themes without drowning the colours on top. */
const HIGHLIGHT_BACKGROUND = "\x1b[48;5;237m";
/** A fainter grey, for a selection in a part of the screen that doesn't have the focus. */
const FAINT_BACKGROUND = "\x1b[48;5;235m";
/**
 * `s` on a grey background end to end, fainter when `faint`. Every painted
 * part ends in a full reset, so the background is set again after each.
 */
export function highlight(s: string, faint = false): string {
  if (!color) return s;
  const background = faint ? FAINT_BACKGROUND : HIGHLIGHT_BACKGROUND;
  return background + s.replaceAll(RESET, RESET + background) + RESET;
}

/** Status words, coloured. */
export const STATUS_WORD: Record<ScenarioResult["status"], string> = {
  pass: green("PASS"),
  fail: red("FAIL"),
  error: red("ERROR"),
  // Grey, not yellow: these say limits weren't checked, and yellow warns of lag.
  recorded: dim("NEW"),
  updated: dim("UPDATED"),
  measured: dim("MEASURED"),
  unchecked: dim("SKIP"),
};

const ANSI = /\x1b\[[0-9;]*m/g;
/**
 * `line` without the first `n` characters of its indent, after any colour
 * codes it opens with. A `>` marking the selection without colours stays, at
 * the start, so the text lines up with the lines around it.
 */
function dedented(line: string, n: number): string {
  const [, codes, indent] = line.match(/^((?:\x1b\[[0-9;]*m)*)([ >]*)/)!;
  const kept = indent.slice(n);
  const marked = indent.slice(0, n).includes(">") ? ">" + kept.slice(1) : kept;
  return codes + marked + line.slice(codes.length + indent.length);
}

/**
 * `lines` in a grey box `width` wide, borders included, `height` lines tall
 * inside. Each line gives up `dedent` of its indent to the border, so its text
 * stays where it was, and is padded out to the border on the right.
 */
export function boxed(lines: string[], width: number, height = lines.length, dedent = 0): string[] {
  const inner = width - 2;
  const rows = Array.from({ length: height }, (_, i) => padEnd(dedented(lines[i] ?? "", dedent), inner));
  return [dim(`┌${"─".repeat(inner)}┐`), ...rows.map((row) => `${dim("│")}${row}${dim("│")}`), dim(`└${"─".repeat(inner)}┘`)];
}
export const visibleWidth = (s: string) => [...s.replace(ANSI, "")].length;
export const padEnd = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleWidth(s)));
export const padStart = (s: string, n: number) => " ".repeat(Math.max(0, n - visibleWidth(s))) + s;

export const truncate = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

/** Status words, padded to the widest (`MEASURED`), so the names after them line up. */
export const MARK = Object.fromEntries(Object.entries(STATUS_WORD).map(([status, word]) => [status, padEnd(word, 8)])) as Record<
  ScenarioResult["status"],
  string
>;

/** Whole numbers from 100 up, one decimal below: `1515`, `6.2`. */
export const formatNumber = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : String(round(v)));

/**
 * Up to six eighths: taller blocks come close to the line above, and trends
 * stacked one per line would run into each other.
 */
const SPARK_LEVELS = "▁▂▃▄▅▆";

const MIDDLE_LEVEL = Math.floor((SPARK_LEVELS.length - 1) / 2);

export type Paint = (s: string) => string;

/**
 * `values` as one block character each, from the lowest to the highest. When
 * they spread less than `flatBelow` of the highest, the line is drawn flat:
 * stretching noise to full height would make it look like a change. Each
 * block takes its colour from `paints`, dim when it has none.
 */
export function sparkline(values: number[], flatBelow: number, paints: Paint[] = []): string {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const flat = high <= 0 || (high - low) / high < flatBelow;
  const top = SPARK_LEVELS.length - 1;
  return values
    .map((v, i) => {
      const level = flat ? MIDDLE_LEVEL : Math.round(((v - low) / (high - low)) * top);
      return (paints[i] ?? dim)(SPARK_LEVELS[level]);
    })
    .join("");
}
