import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Flag, FlagOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Aside, Field, Hint, PanelCard } from "@/components/app/Panel";
import { FilmstripViewer } from "@/components/canvas/FilmstripViewer";
import { Button } from "@/components/ui/button";
import { ApiError, queryKeys, updateMushaf, useMushaf } from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId/setup")({ component: SetupPage });

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function SetupPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/setup" });
  const { data: mushaf } = useMushaf(mushafId);
  const queryClient = useQueryClient();

  const [preview, setPreview] = useState(1); // logical page index (1-based)
  const [first, setFirst] = useState(1);
  const [last, setLast] = useState(1);
  const [marking, setMarking] = useState<"first" | "last" | null>(null);

  useEffect(() => {
    if (mushaf) {
      setFirst(mushaf.first_quran_pdf_page);
      setLast(mushaf.last_quran_pdf_page);
    }
  }, [mushaf?.first_quran_pdf_page, mushaf?.last_quran_pdf_page]);

  const save = useMutation({
    mutationFn: () =>
      updateMushaf(mushafId, { first_quran_pdf_page: first, last_quran_pdf_page: last }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.mushaf(mushafId), updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      setPreview(1);
      setMarking(null);
      toast.success(
        `Quran content set to PDF pages ${updated.first_quran_pdf_page}–${updated.last_quran_pdf_page}.`,
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to save bounds."),
  });

  if (!mushaf) return null;

  const pdfPages = mushaf.pdf_page_count;
  const logicalCount = mushaf.logical_page_count;
  const physical = mushaf.first_quran_pdf_page + preview - 1;
  const processed = mushaf.processed_page_count > 0;

  const valid = first >= 1 && first <= last && last <= pdfPages;
  const changed = first !== mushaf.first_quran_pdf_page || last !== mushaf.last_quran_pdf_page;
  const canSave = valid && changed && !processed && !save.isPending;

  function markFirst() {
    setFirst(clamp(physical, 1, pdfPages));
    // Cool flourish: fly to the last page so the user immediately marks the end.
    setMarking("last");
    setPreview(logicalCount);
    toast.info("First page set — now mark the last Quran page.");
  }

  function markLast() {
    setLast(clamp(physical, 1, pdfPages));
    setMarking(null);
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <FilmstripViewer
        mushafId={mushafId}
        pageCount={logicalCount}
        page={preview}
        onPageChange={(n) => setPreview(clamp(n, 1, logicalCount))}
        version={mushaf.updated_at}
        renderLabel={(logical) =>
          `PDF page ${mushaf.first_quran_pdf_page + logical - 1} of ${pdfPages}`
        }
      />

      <Aside
        footer={
          <div className="flex flex-col gap-2">
            <Button onClick={() => save.mutate()} disabled={!canSave}>
              {save.isPending ? "Saving…" : "Save page range"}
            </Button>
            <Button asChild variant="outline">
              <Link to="/mushafs/$mushafId/templates" params={{ mushafId }}>
                Continue to Templates →
              </Link>
            </Button>
          </div>
        }
      >
        <Hint>
          Flip through the PDF with the filmstrip, then mark the <strong>first</strong> and{" "}
          <strong>last</strong> pages that contain Quran text. Front/back matter is ignored.
        </Hint>

        {!processed && (
          <PanelCard title="Mark from current page">
            <div className="text-[12px] text-text-secondary">
              Currently viewing <strong className="text-text-primary">PDF page {physical}</strong>.
            </div>
            <Button
              variant={marking === "first" || marking === null ? "default" : "outline"}
              onClick={markFirst}
            >
              <Flag size={14} /> Set as first Quran page
            </Button>
            <Button variant={marking === "last" ? "default" : "outline"} onClick={markLast}>
              <FlagOff size={14} /> Set as last Quran page
            </Button>
          </PanelCard>
        )}

        <PanelCard title="Quran content range">
          <div className="grid grid-cols-2 gap-2">
            <Field label="First page (PDF)">
              <NumberInput
                value={first}
                min={1}
                max={pdfPages}
                onChange={setFirst}
                disabled={processed}
              />
            </Field>
            <Field label="Last page (PDF)">
              <NumberInput
                value={last}
                min={1}
                max={pdfPages}
                onChange={setLast}
                disabled={processed}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between text-[12px] text-text-secondary">
            <span>
              {valid ? (
                <>
                  <strong className="text-text-primary">{last - first + 1}</strong> logical pages
                </>
              ) : (
                <span className="text-error">Require 1 ≤ first ≤ last ≤ {pdfPages}</span>
              )}
            </span>
            <button
              type="button"
              disabled={processed}
              onClick={() => {
                setFirst(1);
                setLast(pdfPages);
              }}
              className="font-medium text-orange hover:underline disabled:text-text-muted disabled:no-underline"
            >
              Reset to full PDF
            </button>
          </div>
        </PanelCard>

        {processed && (
          <Hint tone="warning">
            Page bounds are locked because {mushaf.processed_page_count} page
            {mushaf.processed_page_count === 1 ? "" : "s"} have been processed. Delete those pages
            (or the mushaf) and reprocess to change the range.
          </Hint>
        )}
      </Aside>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
      className="h-9 w-full rounded-md border-[1.5px] border-border-strong bg-white px-2.5 text-right text-sm text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)] disabled:bg-bg-surface disabled:text-text-muted"
    />
  );
}
