import type { Column, ColumnKey, Row } from "./data";
import { MISTAKES } from "./mistakes";

/** Lowercase without accents, so "medellin" finds "Medellín". */
const foldText = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();

// ── filter ─────────────────────────────────────────────────────────────

/** Built once per data set: one folded string per row. */
export function buildSearchIndex(rows: Row[]): string[] {
  return rows.map((r) => foldText(`${r.id} ${r.name} ${r.company} ${r.city} ${r.status} ${r.amount} ${r.date}`));
}

export function filterRows(rows: Row[], searchIndex: string[], query: string): Row[] {
  const needle = foldText(query.trim());
  if (!needle) return rows;
  if (MISTAKES.filter) return rows.filter((r) => foldText(JSON.stringify(r)).includes(needle));
  const matches: Row[] = [];
  for (let i = 0; i < rows.length; i++) if (searchIndex[i].includes(needle)) matches.push(rows[i]);
  return matches;
}

// ── sort ───────────────────────────────────────────────────────────────

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function sortRows(rows: Row[], key: ColumnKey, direction: 1 | -1): Row[] {
  if (typeof rows[0]?.[key] === "number") {
    return [...rows].sort((a, b) => ((a[key] as number) - (b[key] as number)) * direction);
  }
  if (MISTAKES.sort) {
    return [...rows].sort((a, b) => {
      const x = foldText(String(a[key]));
      const y = foldText(String(b[key]));
      return (x < y ? -1 : x > y ? 1 : 0) * direction;
    });
  }
  return [...rows].sort((a, b) => collator.compare(String(a[key]), String(b[key])) * direction);
}

// ── column auto-fit ────────────────────────────────────────────────────

/** Horizontal padding of a cell, both sides (matches the CSS). */
const CELL_PADDING = 24;
/** Auto-fit never asks for more than this, so a long name can't block shrinking. */
const MAX_FIT_WIDTH = 120;

let textMeasurer: CanvasRenderingContext2D | null = null;
const fitCache = new WeakMap<Row[], Record<string, number>>();

/**
 * Narrowest each column can get without cutting its widest text. Measuring
 * every cell is slow, so it's done once per set of rows and reused.
 */
export function minColumnWidths(rows: Row[], columns: Column[]): Record<string, number> {
  const cached = fitCache.get(rows);
  if (cached && !MISTAKES.resize) return cached;
  textMeasurer ??= document.createElement("canvas").getContext("2d")!;
  textMeasurer.font = "14px system-ui, sans-serif";
  const widths: Record<string, number> = {};
  for (const row of rows) {
    for (const c of columns) widths[c.key] = Math.max(widths[c.key] ?? 0, textMeasurer.measureText(String(row[c.key])).width);
  }
  for (const c of columns) widths[c.key] = Math.min(widths[c.key] + CELL_PADDING, MAX_FIT_WIDTH);
  fitCache.set(rows, widths);
  return widths;
}
