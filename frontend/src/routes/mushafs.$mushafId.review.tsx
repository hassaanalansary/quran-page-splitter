import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Aside, Hint } from "@/components/app/Panel";
import { ReviewCanvas } from "@/components/canvas/ReviewCanvas";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  pageImageUrl,
  queryKeys,
  savePage,
  useMushaf,
  usePage,
  useProcessedPages,
  useSuras,
  type Line,
  type LineType,
  type Sura,
} from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId/review")({
  validateSearch: (s: Record<string, unknown>) => ({ page: Math.max(1, Number(s.page) || 1) }),
  component: ReviewPage,
});

const LINE_TYPES: { value: LineType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "sura_header", label: "Sura header" },
  { value: "besmella", label: "Besmella" },
];

function ReviewPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/review" });
  const { page } = Route.useSearch();
  const navigate = useNavigate({ from: "/mushafs/$mushafId/review" });
  const queryClient = useQueryClient();

  const { data: mushaf } = useMushaf(mushafId);
  const { data: suras } = useSuras(mushaf?.qiraa);
  const { data: pages } = useProcessedPages(mushafId);
  const { data: pageData, isPending } = usePage(mushafId, page);

  const [draft, setDraft] = useState<Line[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    setDraft(pageData ? pageData.lines.map((l) => structuredClone(l)) : null);
    setSelected(null);
  }, [pageData]);

  const save = useMutation({
    mutationFn: () => savePage(mushafId, page, { bbox: pageData!.bbox!, lines: draft! }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.page(mushafId, page), result);
      queryClient.invalidateQueries({ queryKey: queryKeys.processedPages(mushafId) });
      toast.success(`Saved page ${page}. Aya numbers recomputed.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to save page."),
  });

  if (!mushaf) return null;
  const logicalCount = mushaf.logical_page_count;
  const processed = !!pageData && pageData.lines.length > 0 && pageData.bbox != null;

  function goto(n: number) {
    navigate({ search: { page: Math.max(1, Math.min(logicalCount, n)) } });
  }

  function updateLine(lineNumber: number, patch: Partial<Line>) {
    setDraft((d) =>
      d ? d.map((l) => (l.line_number === lineNumber ? { ...l, ...patch } : l)) : d,
    );
  }

  function toggleSeparator(lineNumber: number, order: number) {
    setDraft((d) =>
      d
        ? d.map((l) =>
            l.line_number === lineNumber
              ? {
                  ...l,
                  segments: l.segments.map((s) =>
                    s.segment_order === order ? { ...s, has_separator: !s.has_separator } : s,
                  ),
                }
              : l,
          )
        : d,
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <ReviewCanvas
        imageUrl={pageImageUrl(mushafId, page, mushaf.updated_at)}
        lines={draft ?? []}
        bbox={pageData?.bbox ?? null}
        selected={selected}
        onSelect={setSelected}
        page={page}
        pageCount={logicalCount}
        onPageChange={goto}
        processed={pages?.processed}
        reviewed={pages?.reviewed}
      />

      <Aside
        footer={
          <div className="flex flex-col gap-2">
            <Button onClick={() => save.mutate()} disabled={!processed || !draft || save.isPending}>
              {save.isPending ? "Saving…" : "Save page"}
            </Button>
            <Button asChild variant="outline">
              <Link to="/mushafs/$mushafId/finalize" params={{ mushafId }} search={{ page }}>
                Continue to Finalize →
              </Link>
            </Button>
          </div>
        }
      >
        {isPending ? (
          <Hint>Loading page…</Hint>
        ) : !processed ? (
          <Hint tone="warning">
            Page {page} has not been processed yet. Process this page range first, or use the page
            arrows to find a processed page.
          </Hint>
        ) : (
          <>
            <Hint>
              Fix line types, sura assignments, and aya separators. Aya numbers are recomputed on
              the server when you save.
            </Hint>
            <div className="flex flex-col gap-2">
              {(draft ?? []).map((line) => (
                <LineEditor
                  key={line.line_number}
                  line={line}
                  suras={suras ?? []}
                  selected={selected === line.line_number}
                  onSelect={() => setSelected(line.line_number)}
                  onChangeType={(type) =>
                    updateLine(line.line_number, {
                      type,
                      segments: type === "text" ? line.segments : [],
                    })
                  }
                  onChangeSura={(sura_number) => updateLine(line.line_number, { sura_number })}
                  onToggleSeparator={(order) => toggleSeparator(line.line_number, order)}
                />
              ))}
            </div>
          </>
        )}
      </Aside>
    </div>
  );
}

function LineEditor({
  line,
  suras,
  selected,
  onSelect,
  onChangeType,
  onChangeSura,
  onToggleSeparator,
}: {
  line: Line;
  suras: Sura[];
  selected: boolean;
  onSelect: () => void;
  onChangeType: (t: LineType) => void;
  onChangeSura: (n: number) => void;
  onToggleSeparator: (order: number) => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={[
        "cursor-pointer rounded-md border bg-white p-2.5 transition-colors",
        selected
          ? "border-orange shadow-[0_0_0_3px_var(--orange-glow)]"
          : "border-border hover:border-border-strong",
      ].join(" ")}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-bg-muted text-[10px] font-semibold text-text-secondary">
          {line.line_number}
        </span>
        <select
          value={line.type}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChangeType(e.target.value as LineType)}
          className="h-7 flex-1 cursor-pointer rounded border border-border-strong bg-white px-1.5 text-[12px] outline-none focus:border-orange"
        >
          {LINE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {(line.type === "sura_header" || line.type === "besmella") && (
        <select
          value={line.sura_number ?? ""}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChangeSura(Number(e.target.value))}
          className="mt-2 h-7 w-full cursor-pointer rounded border border-border-strong bg-white px-1.5 text-[12px] outline-none focus:border-orange"
        >
          <option value="">— sura —</option>
          {suras.map((s) => (
            <option key={s.number} value={s.number}>
              {s.number}. {s.transliteration}
            </option>
          ))}
        </select>
      )}

      {line.type === "text" && line.segments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {line.segments.map((seg) => (
            <button
              key={seg.segment_order}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSeparator(seg.segment_order);
              }}
              title={`Segment ${seg.segment_order} · aya ${seg.aya_number ?? "?"}${seg.has_separator ? " · ends aya" : ""}`}
              className={[
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                seg.has_separator
                  ? "bg-orange text-white"
                  : "bg-bg-muted text-text-secondary hover:bg-bg-surface",
              ].join(" ")}
            >
              {seg.aya_number ?? "?"}
              {seg.has_separator && <span aria-hidden>۝</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
