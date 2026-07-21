import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Flag, FlagOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Aside, Field, Hint, PanelCard, StatusLine } from "@/components/app/Panel";
import { StepGuide } from "@/components/app/StepGuide";
import { CanvasCoach } from "@/components/app/CanvasCoach";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { FilmstripViewer } from "@/components/canvas/FilmstripViewer";
import { Button } from "@/components/ui/button";
import { ApiError, queryKeys, updateMushaf, useMushaf } from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId/setup")({ component: SetupPage });

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function SetupPage() {
  const { t, i18n } = useTranslation();
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
        t("setup.savedToast", {
          first: updated.first_quran_pdf_page,
          last: updated.last_quran_pdf_page,
        }),
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("setup.saveFailed")),
  });

  const tourSteps: TourStep[] = [
    { target: "setup-filmstrip", title: t("tour.setup.t1_title"), body: t("tour.setup.t1_body") },
    { target: "setup-mark", title: t("tour.setup.t2_title"), body: t("tour.setup.t2_body") },
    { target: "setup-save", title: t("tour.setup.t3_title"), body: t("tour.setup.t3_body") },
  ];
  const tour = useStepTour("setup", tourSteps);

  if (!mushaf) return null;

  const pdfPages = mushaf.pdf_page_count;
  const logicalCount = mushaf.logical_page_count;
  const physical = mushaf.first_quran_pdf_page + preview - 1;
  const processed = mushaf.processed_page_count > 0;

  const valid = first >= 1 && first <= last && last <= pdfPages;
  const changed = first !== mushaf.first_quran_pdf_page || last !== mushaf.last_quran_pdf_page;
  const canSave = valid && changed && !processed && !save.isPending;

  const guideItems = [
    { label: t("guide.setup.s1"), done: processed || first !== 1 },
    { label: t("guide.setup.s2"), done: processed || (valid && last !== pdfPages) },
    {
      label: t("guide.setup.s3"),
      done: processed || (valid && !changed && !(first === 1 && last === pdfPages)),
    },
  ];
  const status = processed ? (
    <StatusLine tone="success">{t("stepStatus.setupLocked")}</StatusLine>
  ) : !valid ? (
    <StatusLine tone="warning">{t("setup.rangeError", { max: pdfPages })}</StatusLine>
  ) : changed ? (
    <StatusLine>{t("stepStatus.setupUnsaved")}</StatusLine>
  ) : (
    <StatusLine tone="success">{t("stepStatus.setupSaved")}</StatusLine>
  );

  function markFirst() {
    setFirst(clamp(physical, 1, pdfPages));
    // Cool flourish: fly to the last page so the user immediately marks the end.
    setMarking("last");
    setPreview(logicalCount);
    toast.info(t("setup.firstSetToast"));
  }

  function markLast() {
    setLast(clamp(physical, 1, pdfPages));
    setMarking(null);
  }

  return (
    <div
      className={`flex ${i18n.language === "ar" ? "flex-row-reverse" : "flex-row"} flex-1 overflow-hidden`}
    >
      <div data-tour="setup-filmstrip" className="relative flex flex-1 overflow-hidden">
        <FilmstripViewer
          mushafId={mushafId}
          pageCount={logicalCount}
          page={preview}
          onPageChange={(n) => setPreview(clamp(n, 1, logicalCount))}
          version={mushaf.updated_at}
          renderLabel={(logical) =>
            t("process.pdfPageLabel", {
              pdf: mushaf.first_quran_pdf_page + logical - 1,
              total: pdfPages,
            })
          }
        />
        <CanvasCoach storageKey="setup" text={t("coach.setup")} />
      </div>

      <Aside
        status={status}
        footer={
          <div data-tour="setup-save" className="flex flex-col gap-2">
            <Button onClick={() => save.mutate()} disabled={!canSave}>
              {save.isPending ? t("common.saving") : t("setup.saveRange")}
            </Button>
            <Button asChild variant="outline">
              <Link to="/mushafs/$mushafId/templates" params={{ mushafId }}>
                {t("setup.continueTemplates")}
              </Link>
            </Button>
          </div>
        }
      >
        <StepGuide items={guideItems} storageKey="setup" onReplayTour={tour.start} />

        {!processed && (
          <div data-tour="setup-mark">
            <PanelCard title={t("setup.markFromCurrent")}>
              <div className="text-[12px] text-text-secondary">
                {t("setup.currentlyViewing", { page: physical })}
              </div>
              <Button
                variant={marking === "first" || marking === null ? "default" : "outline"}
                onClick={markFirst}
              >
                <Flag size={14} /> {t("setup.setFirst")}
              </Button>
              <Button variant={marking === "last" ? "default" : "outline"} onClick={markLast}>
                <FlagOff size={14} /> {t("setup.setLast")}
              </Button>
            </PanelCard>
          </div>
        )}

        <PanelCard title={t("setup.rangeTitle")}>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("setup.firstPage")}>
              <NumberInput
                value={first}
                min={1}
                max={pdfPages}
                onChange={setFirst}
                disabled={processed}
              />
            </Field>
            <Field label={t("setup.lastPage")}>
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
                t("setup.logicalPages", { count: last - first + 1 })
              ) : (
                <span className="text-error">{t("setup.rangeError", { max: pdfPages })}</span>
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
              {t("setup.resetFull")}
            </button>
          </div>
        </PanelCard>

        {processed && (
          <Hint tone="warning">
            {t("setup.lockedWarning", { count: mushaf.processed_page_count })}
          </Hint>
        )}
      </Aside>

      <TourOverlay tour={tour} />
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
