import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Aside, Field, Hint, PanelCard } from "@/components/app/Panel";
import { CropStudio } from "@/components/canvas/CropStudio";
import { Button } from "@/components/ui/button";
import { ApiError, pageImageUrl, queryKeys, updateMushaf, useMushaf } from "@/lib/api";

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
      toast.success(`Quran content set to PDF pages ${updated.first_quran_pdf_page}–${updated.last_quran_pdf_page}.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to save bounds."),
  });

  if (!mushaf) return null;

  const pdfPages = mushaf.pdf_page_count;
  const logicalCount = mushaf.logical_page_count;
  const physical = mushaf.first_quran_pdf_page + preview - 1;
  const processed = mushaf.processed_page_count > 0;

  const valid = first >= 1 && first <= last && last <= pdfPages;
  const changed =
    first !== mushaf.first_quran_pdf_page || last !== mushaf.last_quran_pdf_page;
  const canSave = valid && changed && !processed && !save.isPending;

  return (
    <div className="flex flex-1 overflow-hidden">
      <CropStudio
        imageUrl={pageImageUrl(mushafId, preview, mushaf.updated_at)}
        page={preview}
        pageCount={logicalCount}
        onPageChange={(n) => setPreview(clamp(n, 1, logicalCount))}
        statusText={`PDF page ${physical} of ${pdfPages}  ·  preview ${preview} / ${logicalCount}`}
        emptyHint="Rendering page…"
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
          Flip through the PDF and mark the <strong>first</strong> and <strong>last</strong> pages
          that contain Quran text. Front/back matter outside this range is ignored.
        </Hint>

        <PanelCard title="Quran content range">
          <Field label="First Quran page (PDF)">
            <div className="flex gap-2">
              <NumberInput
                value={first}
                min={1}
                max={pdfPages}
                onChange={setFirst}
                disabled={processed}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={processed}
                onClick={() => setFirst(clamp(physical, 1, pdfPages))}
                title="Use the currently previewed page"
              >
                Use page {physical}
              </Button>
            </div>
          </Field>

          <Field label="Last Quran page (PDF)">
            <div className="flex gap-2">
              <NumberInput
                value={last}
                min={1}
                max={pdfPages}
                onChange={setLast}
                disabled={processed}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={processed}
                onClick={() => setLast(clamp(physical, 1, pdfPages))}
                title="Use the currently previewed page"
              >
                Use page {physical}
              </Button>
            </div>
          </Field>

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
              className="text-[12px] font-medium text-orange hover:underline disabled:text-text-muted disabled:no-underline"
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
