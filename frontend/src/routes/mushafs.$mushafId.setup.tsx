import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Check, Flag, FlagOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Aside, Field, Hint, PanelCard, StatusLine, StepBody } from "@/components/app/Panel";
import { CanvasHelp } from "@/components/app/CanvasHelp";
import { InfoTip } from "@/components/app/InfoTip";
import { BusyLabel } from "@/components/app/SatrLoader";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { FilmstripViewer } from "@/components/canvas/FilmstripViewer";
import { ApiError, queryKeys, updateMushaf, useMushaf } from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId/setup")({ component: SetupPage });

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function SetupPage() {
  const { t } = useTranslation();
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/setup" });
  const { data: mushaf } = useMushaf(mushafId);
  const queryClient = useQueryClient();

  const [preview, setPreview] = useState(1); // logical page index (1-based)
  const [first, setFirst] = useState(1);
  const [last, setLast] = useState(1);
  const [marking, setMarking] = useState<"first" | "last" | null>(null);
  const [markedFirst, setMarkedFirst] = useState(false);
  const [markedLast, setMarkedLast] = useState(false);
  const [saved, setSaved] = useState(false);

  // Initialise local state once per mushaf (NOT on our own save's cache update,
  // which would clobber `saved`). Only a locked (already-processed) mushaf starts
  // marked/saved; otherwise the user's clicks and a successful save set these.
  const initedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!mushaf || initedRef.current === mushafId) return;
    initedRef.current = mushafId;
    setFirst(mushaf.first_quran_pdf_page);
    setLast(mushaf.last_quran_pdf_page);
    const locked = mushaf.processed_page_count > 0;
    setMarkedFirst(locked);
    setMarkedLast(locked);
    setSaved(locked);
  }, [mushaf, mushafId]);

  const save = useMutation({
    mutationFn: () =>
      updateMushaf(mushafId, { first_quran_pdf_page: first, last_quran_pdf_page: last }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.mushaf(mushafId), updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      setPreview(1);
      setMarking(null);
      setSaved(true);
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
  const tour = useStepTour("setup", tourSteps, (mushaf?.processed_page_count ?? 1) === 0);

  if (!mushaf) return null;

  const pdfPages = mushaf.pdf_page_count;
  const logicalCount = mushaf.logical_page_count;
  const physical = mushaf.first_quran_pdf_page + preview - 1;
  const processed = mushaf.processed_page_count > 0;

  const valid = first >= 1 && first <= last && last <= pdfPages;
  const changed = first !== mushaf.first_quran_pdf_page || last !== mushaf.last_quran_pdf_page;
  const canSave = valid && changed && !processed && !save.isPending;
  // A step counts as done when the user actually did it (marked a page / saved a
  // valid range) — page 1 as first or the last PDF page as last is perfectly
  // normal, so the numbers themselves say nothing.
  const done1 = processed || (valid && markedFirst);
  const done2 = processed || (valid && markedLast);
  const done3 = processed || (valid && saved);

  // Plain instructions, not a checklist — the marking chips below already say
  // where you are, and a second tick-list only repeated them.
  const guideItems = [t("guide.setup.s1"), t("guide.setup.s2"), t("guide.setup.s3")];
  const status = processed ? (
    <StatusLine tone="success">{t("stepStatus.setupLocked")}</StatusLine>
  ) : !valid ? (
    <StatusLine tone="warning">{t("setup.rangeError", { max: pdfPages })}</StatusLine>
  ) : done3 ? (
    <StatusLine tone="success">{t("stepStatus.setupSaved")}</StatusLine>
  ) : !changed ? (
    <StatusLine tone="info">{t("stepStatus.setupAlreadySaved")}</StatusLine>
  ) : (
    <StatusLine>{t("stepStatus.setupUnsaved")}</StatusLine>
  );

  function markFirst() {
    setFirst(clamp(physical, 1, pdfPages));
    setMarkedFirst(true);
    setSaved(false);
    // Cool flourish: fly to the last page so the user immediately marks the end.
    setMarking("last");
    setPreview(logicalCount);
    toast.success(t("setup.firstSetToast"));
  }

  function markLast() {
    const p = clamp(physical, 1, pdfPages);
    setLast(p);
    setMarkedLast(true);
    setSaved(false);
    setMarking(null);
    toast.success(t("setup.lastSetToast", { page: p }));
  }

  // The range so far, in the filmstrip's own (logical) page numbers.
  const toLogical = (pdf: number) => clamp(pdf - mushaf.first_quran_pdf_page + 1, 1, logicalCount);
  const marks = [
    markedFirst || processed ? toLogical(first) : null,
    markedLast || processed ? toLogical(last) : null,
  ].filter((n): n is number => n !== null);

  return (
    <StepBody>
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
          hint={t("setup.flipHint")}
          badge={(logical) => {
            const pdf = mushaf.first_quran_pdf_page + logical - 1;
            if (pdf === first && (markedFirst || processed)) return t("setup.badgeFirst");
            if (pdf === last && (markedLast || processed)) return t("setup.badgeLast");
            return null;
          }}
          scrub={{
            range: valid ? [toLogical(first), toLogical(last)] : null,
            marks,
            startLabel: t("setup.scrubEnd", { page: mushaf.first_quran_pdf_page }),
            endLabel: t("setup.scrubEnd", { page: mushaf.first_quran_pdf_page + logicalCount - 1 }),
            summary: valid
              ? t("setup.scrubSummary", { first, last, count: last - first + 1 })
              : t("setup.rangeError", { max: pdfPages }),
          }}
        />
        <CanvasHelp
          guideItems={guideItems}
          coachText={t("coach.setup")}
          onReplayTour={tour.start}
        />
      </div>

      <Aside
        intro={t("setup.intro")}
        status={status}
        footer={
          <div data-tour="setup-save" className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={!canSave}
              className="inline-flex h-11 cursor-pointer items-center justify-center rounded-control bg-lapis text-[14px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {save.isPending ? <BusyLabel>{t("common.saving")}</BusyLabel> : t("setup.saveRange")}
            </button>
            <Link
              to="/mushafs/$mushafId/templates"
              params={{ mushafId }}
              className="inline-flex h-11 items-center justify-center rounded-control border border-rule-2 text-[14px] font-semibold text-ink-3 no-underline transition-colors hover:bg-card hover:text-ink"
            >
              {t("setup.continueTemplates")}
            </Link>
          </div>
        }
      >
        {!processed && (
          <div data-tour="setup-mark">
            <PanelCard title={t("setup.markFromCurrent")}>
              <span className="text-[13.5px] text-ink-2">
                {t("setup.viewing")}{" "}
                <strong className="font-mono text-ink">
                  {t("setup.scrubEnd", { page: physical })}
                </strong>
              </span>
              <div className="flex flex-wrap gap-1.5">
                <ProgressChip label={t("setup.chipFirst")} value={`p. ${first}`} done={done1} />
                <ProgressChip label={t("setup.chipLast")} value={`p. ${last}`} done={done2} />
                <ProgressChip label={t("setup.chipSaved")} done={done3} />
              </div>
              <MarkButton primary={marking === "first" || marking === null} onClick={markFirst}>
                {done1 ? <Check size={15} /> : <Flag size={15} />} {t("setup.setFirst")}
              </MarkButton>
              <MarkButton primary={marking === "last"} onClick={markLast}>
                {done2 ? <Check size={15} /> : <FlagOff size={15} />} {t("setup.setLast")}
              </MarkButton>
            </PanelCard>
          </div>
        )}

        <PanelCard title={t("setup.rangeTitle")}>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={t("setup.firstPage")}>
              <NumberInput
                value={first}
                min={1}
                max={pdfPages}
                onChange={(v) => {
                  setFirst(v);
                  setSaved(false);
                }}
                disabled={processed}
              />
            </Field>
            <Field label={t("setup.lastPage")}>
              <NumberInput
                value={last}
                min={1}
                max={pdfPages}
                onChange={(v) => {
                  setLast(v);
                  setSaved(false);
                }}
                disabled={processed}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span className="text-ink-2">
              {valid ? (
                <>
                  <strong className="font-display text-[18px] text-ink">{last - first + 1}</strong>{" "}
                  {t("setup.logicalPagesShort")}
                </>
              ) : (
                <span className="text-stop-text">{t("setup.rangeError", { max: pdfPages })}</span>
              )}
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                disabled={processed}
                onClick={() => {
                  setFirst(1);
                  setLast(pdfPages);
                  setSaved(false);
                }}
                className="cursor-pointer font-semibold text-lapis-text hover:underline disabled:cursor-default disabled:text-ink-3 disabled:no-underline"
              >
                {t("setup.resetFull")}
              </button>
              <InfoTip text={t("setup.resetFullTip")} />
            </span>
          </div>
        </PanelCard>

        {processed && (
          <Hint tone="warning">
            {t("setup.lockedWarning", { count: mushaf.processed_page_count })}
          </Hint>
        )}
      </Aside>

      <TourOverlay tour={tour} />
    </StepBody>
  );
}

/** The two marking buttons: the one to press next is solid lapis, the other
 * outlined. */
function MarkButton({
  primary,
  onClick,
  children,
}: {
  primary: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-[42px] cursor-pointer items-center justify-center gap-2 rounded-control text-[14px] font-semibold transition-colors ${
        primary
          ? "bg-lapis text-on-lapis hover:bg-lapis/90"
          : "border border-ink bg-transparent text-ink hover:bg-sunk"
      }`}
    >
      {children}
    </button>
  );
}

function ProgressChip({ label, value, done }: { label: string; value?: string; done: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-[5px] rounded-pill px-2.5 py-[3px] text-[12.5px] ${
        done
          ? "bg-done-wash font-semibold text-done-text"
          : "border border-rule-2 font-medium text-ink-3"
      }`}
    >
      {done ? (
        <Check size={12} strokeWidth={3} aria-hidden="true" />
      ) : (
        <span className="h-2 w-2 rounded-full border-[1.5px] border-current" aria-hidden="true" />
      )}
      {value ? `${label}: ${value}` : label}
    </span>
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
      className="h-10 w-full rounded-control border border-rule-2 bg-card px-2.5 font-mono text-[14px] font-medium text-ink outline-none focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)] disabled:bg-sheet disabled:text-ink-3"
    />
  );
}
