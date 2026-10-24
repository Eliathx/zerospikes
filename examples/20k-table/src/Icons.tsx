const base = { width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true } as const;

export function ArrowIcon({ dir }: { dir: 1 | -1 }) {
  return (
    <svg {...base} className="icon">
      <path d={dir === 1 ? "M6 10V2M2.5 5.5 6 2l3.5 3.5" : "M6 2v8M2.5 6.5 6 10l3.5-3.5"} />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...base} className="icon">
      <path d="M2 2l8 8M10 2l-8 8" />
    </svg>
  );
}
