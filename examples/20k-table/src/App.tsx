import { useCallback, useMemo, useState } from "react";
import { makeRows, type ColumnKey, type Row } from "./data";
import { Drawer } from "./Drawer";
import { Grid } from "./Grid";
import { Hud } from "./Hud";
import { buildSearchIndex, filterRows, sortRows } from "./table";

// ?rows=5000 changes the data size; ?hud=0 hides the live meter (the perf tests do).
const params = new URLSearchParams(location.search);
const ROW_COUNT = Number(params.get("rows")) || 20000;
const SHOW_HUD = params.get("hud") !== "0";

export function App() {
  const rows = useMemo(() => makeRows(ROW_COUNT), []);
  const searchIndex = useMemo(() => buildSearchIndex(rows), [rows]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: ColumnKey; dir: 1 | -1 }>({ key: "id", dir: 1 });
  const [openRow, setOpenRow] = useState<Row | null>(null);

  const filtered = useMemo(() => filterRows(rows, searchIndex, query), [rows, searchIndex, query]);
  const visible = useMemo(
    () => (sort.key === "id" && sort.dir === 1 ? filtered : sortRows(filtered, sort.key, sort.dir)),
    [filtered, sort],
  );

  const onSort = useCallback(
    (key: ColumnKey) => setSort((current) => ({ key, dir: current.key === key ? (current.dir === 1 ? -1 : 1) : 1 })),
    [],
  );
  const onClose = useCallback(() => setOpenRow(null), []);

  return (
    <div className="page">
      <p className="intro">
        {rows.length.toLocaleString("en-US")} rows. Turn on a mistake in <code>src/mistakes.ts</code>, feel it here, then
        run <code>npm run perf</code>.
      </p>

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search client, company, city…"
          aria-label="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="count">{visible.length.toLocaleString("en-US")} rows</span>
        {SHOW_HUD && <Hud />}
      </div>

      <Grid rows={visible} sort={sort} onSort={onSort} onOpen={setOpenRow} />
      {openRow && <Drawer row={openRow} onClose={onClose} />}
    </div>
  );
}
