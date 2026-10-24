import { memo, useRef, useState } from "react";
import { COLUMNS, type Column, type ColumnKey, type Row } from "./data";
import { ArrowIcon } from "./Icons";
import { minColumnWidths } from "./table";

export const ROW_HEIGHT = 34;
const VIEW_HEIGHT = 544;
/** Rows rendered above and below the visible ones, so fast scrolling doesn't show gaps. */
const OVERSCAN = 6;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

interface Props {
  rows: Row[];
  sort: { key: ColumnKey; dir: 1 | -1 };
  onSort: (key: ColumnKey) => void;
  onOpen: (row: Row) => void;
}

/** Virtualized grid: only the rows in view (plus a few) are in the DOM. */
export function Grid({ rows, sort, onSort, onOpen }: Props) {
  const [widths, setWidths] = useState<Record<string, number>>(() => Object.fromEntries(COLUMNS.map((c) => [c.key, c.width])));
  const [scrollTop, setScrollTop] = useState(0);
  const resizing = useRef<{ column: Column; startX: number; startWidth: number; minWidth: number } | null>(null);

  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(rows.length, Math.ceil((scrollTop + VIEW_HEIGHT) / ROW_HEIGHT) + OVERSCAN);
  const template = COLUMNS.map((c) => `${widths[c.key]}px`).join(" ");
  // Header and body share one width so they scroll sideways together on narrow screens.
  const totalWidth = COLUMNS.reduce((sum, c) => sum + widths[c.key], 0);

  const onResizeDown = (e: React.PointerEvent, column: Column) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const minWidth = minColumnWidths(rows, COLUMNS)[column.key];
    resizing.current = { column, startX: e.clientX, startWidth: widths[column.key], minWidth };
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const active = resizing.current;
    if (!active) return;
    const width = Math.max(active.minWidth, active.startWidth + e.clientX - active.startX);
    setWidths((current) => ({ ...current, [active.column.key]: width }));
  };
  const onResizeUp = () => {
    resizing.current = null;
  };

  return (
    <div className="grid" role="grid" aria-rowcount={rows.length}>
      <div style={{ minWidth: totalWidth }}>
        <div className="grid-head" role="row" style={{ gridTemplateColumns: template }}>
          {COLUMNS.map((c) => (
            <div key={c.key} role="columnheader" className={c.numeric ? "num" : ""} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
              <button className="sort" onClick={() => onSort(c.key)}>
                {c.label}
                {sort.key === c.key && <ArrowIcon dir={sort.dir} />}
              </button>
              <span
                className="resize"
                data-testid={`resize-${c.key}`}
                onPointerDown={(e) => onResizeDown(e, c)}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
              />
            </div>
          ))}
        </div>
        <div className="grid-body" data-testid="grid-body" style={{ height: VIEW_HEIGHT }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
            {rows.slice(firstRow, lastRow).map((r, i) => (
              <GridRow key={r.id} row={r} top={(firstRow + i) * ROW_HEIGHT} template={template} onOpen={onOpen} />
            ))}
          </div>
        </div>
      </div>
      {rows.length === 0 && <p className="empty">No results</p>}
    </div>
  );
}

const GridRow = memo(function GridRow({ row, top, template, onOpen }: { row: Row; top: number; template: string; onOpen: (r: Row) => void }) {
  return (
    <div className="grid-row" role="row" style={{ transform: `translateY(${top}px)`, gridTemplateColumns: template }} onClick={() => onOpen(row)}>
      <div className="num muted">{row.id}</div>
      <div>{row.name}</div>
      <div>{row.company}</div>
      <div>{row.city}</div>
      <div>
        <span className={`pill ${row.status}`}>{row.status}</span>
      </div>
      <div className="num">{money.format(row.amount)}</div>
      <div className="muted">{row.date}</div>
    </div>
  );
});
