import { useEffect, useRef } from "react";
import type { Row } from "./data";
import { CloseIcon } from "./Icons";
import { MISTAKES } from "./mistakes";

/** Where the leaky panel parks what it should have let go. */
const recentlyViewed: { row: Row; node: HTMLElement | null }[] = [];

interface Props {
  row: Row;
  onClose: () => void;
}

export function Drawer({ row, onClose }: Props) {
  const ref = useRef<HTMLElement>(null);

  // Stands in for the work a real panel does on window resize (re-measuring its
  // layout); what matters here is the listener and what it keeps alive.
  useEffect(() => {
    const node = ref.current;
    const onResize = () => node?.setAttribute("data-viewport-width", String(innerWidth));
    addEventListener("resize", onResize);
    if (MISTAKES.leak) {
      return () => {
        recentlyViewed.push({ row, node });
      };
    }
    return () => removeEventListener("resize", onResize);
  }, [row]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="drawer" ref={ref} aria-label="Invoice detail">
      <header>
        <h2>Invoice #{row.id}</h2>
        <button onClick={onClose} aria-label="Close detail">
          <CloseIcon />
        </button>
      </header>
      <dl>
        <dt>Client</dt>
        <dd>{row.name}</dd>
        <dt>Company</dt>
        <dd>{row.company}</dd>
        <dt>City</dt>
        <dd>{row.city}</dd>
        <dt>Status</dt>
        <dd>
          <span className={`pill ${row.status}`}>{row.status}</span>
        </dd>
        <dt>Amount</dt>
        <dd>{row.amount.toLocaleString("en-US", { style: "currency", currency: "USD" })}</dd>
        <dt>Date</dt>
        <dd>{row.date}</dd>
      </dl>
      <h3>Activity</h3>
      <ul className="history">
        {Array.from({ length: 40 }, (_, i) => (
          <li key={i}>
            <span>{new Date(Date.parse(row.date) - i * 86400000 * 3).toISOString().slice(0, 10)}</span>
            <span>{i % 3 === 0 ? "Reminder sent" : i % 3 === 1 ? "Partial payment" : "Internal note"}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
