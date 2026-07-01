type Props = {
  page: number;
  pageCount: number;
  onPageChange: (n: number) => void;
  /** Logical pages that have been processed (shown with an indicator bar). */
  processed?: Set<number>;
  /** Processed pages that have also been reviewed (a different indicator). */
  reviewed?: Set<number>;
};

/** Page numbers to show: first, …, current±3, …, last. */
function pagerItems(current: number, total: number): (number | "gap")[] {
  const wanted = new Set<number>([1, total]);
  for (let i = current - 3; i <= current + 3; i++) if (i >= 1 && i <= total) wanted.add(i);
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push("gap");
    out.push(n);
  });
  return out;
}

/**
 * Compact page-number rail (like the Setup filmstrip's), reusable across steps.
 * When `processed`/`reviewed` sets are given, each page number carries a small
 * indicator bar (navy = processed, green = reviewed).
 */
export function PageRail({ page, pageCount, onPageChange, processed, reviewed }: Props) {
  return (
    <div className="flex h-11 flex-shrink-0 items-center justify-center gap-1 overflow-x-auto border-t border-border bg-white px-3">
      {pagerItems(page, pageCount).map((item, i) =>
        item === "gap" ? (
          <span key={`gap-${i}`} className="px-1 text-[12px] text-text-muted">
            …
          </span>
        ) : (
          <Chip
            key={item}
            n={item}
            active={item === page}
            onClick={() => onPageChange(item)}
            state={reviewed?.has(item) ? "reviewed" : processed?.has(item) ? "processed" : "none"}
          />
        ),
      )}
    </div>
  );
}

function Chip({
  n,
  active,
  onClick,
  state,
}: {
  n: number;
  active: boolean;
  onClick: () => void;
  state: "reviewed" | "processed" | "none";
}) {
  const color =
    state === "reviewed" ? "var(--success)" : state === "processed" ? "var(--navy-light)" : null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={state === "none" ? `Page ${n}` : `Page ${n} · ${state}`}
      className={[
        "relative h-7 min-w-7 flex-shrink-0 rounded px-2 text-[12px] font-medium tabular-nums transition-colors",
        active
          ? "bg-orange text-white"
          : "bg-bg-surface text-text-secondary hover:bg-bg-muted hover:text-text-primary",
      ].join(" ")}
    >
      {n}
      {color && (
        <span
          className="absolute inset-x-1.5 bottom-[3px] h-[2.5px] rounded-full"
          style={{ background: color }}
        />
      )}
    </button>
  );
}
