import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Aside, Hint, PanelCard } from "@/components/app/Panel";
import { ReviewCanvas } from "@/components/canvas/ReviewCanvas";
import { Button } from "@/components/ui/button";
import {
  API_BASE,
  ApiError,
  exportLines,
  pageImageUrl,
  useMushaf,
  usePage,
  type ExportResult,
} from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId/finalize")({
  validateSearch: (s: Record<string, unknown>) => ({ page: Math.max(1, Number(s.page) || 1) }),
  component: FinalizePage,
});

function FinalizePage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/finalize" });
  const { page } = Route.useSearch();
  const navigate = useNavigate({ from: "/mushafs/$mushafId/finalize" });

  const { data: mushaf } = useMushaf(mushafId);
  const { data: pageData } = usePage(mushafId, page);
  const [result, setResult] = useState<ExportResult | null>(null);

  const exportMutation = useMutation({
    mutationFn: () => exportLines(mushafId, page),
    onSuccess: (res) => {
      setResult(res);
      toast.success(`Exported ${res.exported} line PNG${res.exported === 1 ? "" : "s"}.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Export failed."),
  });

  if (!mushaf) return null;
  const logicalCount = mushaf.logical_page_count;
  const processed = !!pageData && pageData.lines.length > 0;

  function goto(n: number) {
    setResult(null);
    navigate({ search: { page: Math.max(1, Math.min(logicalCount, n)) } });
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <ReviewCanvas
        imageUrl={pageImageUrl(mushafId, page, mushaf.updated_at)}
        lines={pageData?.lines ?? []}
        bbox={pageData?.bbox ?? null}
        selected={null}
        onSelect={() => {}}
        page={page}
        pageCount={logicalCount}
        onPageChange={goto}
      />

      <Aside
        footer={
          <Button
            onClick={() => exportMutation.mutate()}
            disabled={!processed || exportMutation.isPending}
          >
            {exportMutation.isPending ? "Exporting…" : "Export line PNGs"}
          </Button>
        }
      >
        <Hint>
          Each line is cropped from the rendered page into a transparent PNG (white made
          see-through). Eraser strokes and per-line box overrides are coming next.
        </Hint>

        {!processed ? (
          <Hint tone="warning">Page {page} has no processed lines to export.</Hint>
        ) : result ? (
          <PanelCard title={`Exported ${result.exported} lines`}>
            <div className="flex flex-col gap-2">
              {result.lines.map((l) => (
                <a
                  key={l.line_number}
                  href={`${API_BASE}${l.line_png}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded border border-border p-1.5 hover:border-border-strong"
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-bg-muted text-[10px] font-semibold text-text-secondary">
                    {l.line_number}
                  </span>
                  <img
                    src={`${API_BASE}${l.line_png}`}
                    alt={`Line ${l.line_number}`}
                    className="max-h-8 flex-1 bg-[repeating-conic-gradient(#eee_0_25%,transparent_0_50%)] bg-[length:10px_10px] object-contain"
                  />
                </a>
              ))}
            </div>
          </PanelCard>
        ) : (
          <Hint>Click “Export line PNGs” to generate transparent line images for this page.</Hint>
        )}
      </Aside>
    </div>
  );
}
