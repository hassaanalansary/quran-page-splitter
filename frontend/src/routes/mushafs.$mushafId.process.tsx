import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { TemplatePreview } from "@/components/canvas/TemplatePreview";
import { Aside, Field, Hint, Section, StatusLine } from "@/components/app/Panel";
import { CanvasHelp } from "@/components/app/CanvasHelp";
import { InfoTip } from "@/components/app/InfoTip";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { AbortDiagnostics } from "@/components/app/AbortDiagnostics";
import { CropPreview } from "@/components/canvas/CropPreview";
import { PageStage } from "@/components/canvas/PageStage";
import { RectInputs } from "@/components/canvas/RectInputs";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  DEFAULT_PROCESS_SETTINGS,
  pageImageUrl,
  processMushaf,
  queryKeys,
  useMushaf,
  useProcessedPages,
  useRuns,
  useSuras,
  type ProcessResult,
  type ProcessSettings,
  type Rect,
} from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId/process")({
  component: ProcessPage,
  // Optional `?run=<id>` pre-fills the form from a stored run's settings;
  // optional `?from=<page>` overrides the start page (used by "Resume").
  validateSearch: (s: Record<string, unknown>): { run?: string; from?: number } => {
    const run = typeof s.run === "string" && s.run ? s.run : undefined;
    const fromNum = Math.floor(Number(s.from));
    const from = Number.isFinite(fromNum) && fromNum >= 1 ? fromNum : undefined;
    return { run, from };
  },
});

const CHUNK_SIZE = 50;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

type RunState = {
  running: boolean;
  done: number;
  total: number;
  finished: boolean;
  abort: ProcessResult | null;
  error: string | null;
};

function ProcessPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/process" });
  const { run: runId, from: resumeFrom } = Route.useSearch();
  const { data: mushaf } = useMushaf(mushafId);
  const { data: suras } = useSuras(mushaf?.qiraa);
  const { data: pages } = useProcessedPages(mushafId);
  const { data: runs } = useRuns(mushafId);
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();

  const logicalCount = mushaf?.logical_page_count ?? 1;

  const [preview, setPreview] = useState(1);
  const [bounds, setBounds] = useState<Rect | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(logicalCount);
  const [startSura, setStartSura] = useState(1);
  const [startAya, setStartAya] = useState(1);
  const [settings, setSettings] = useState<ProcessSettings>(DEFAULT_PROCESS_SETTINGS);
  const [run, setRun] = useState<RunState | null>(null);
  const [loadedRun, setLoadedRun] = useState<{ label: string; from?: number } | null>(null);
  const appliedRunRef = useRef<string | null>(null);

  // Pre-fill the form from a stored run when arriving via `?run=<id>` (Runs tab
  // → "Re-run with these settings"). Applied once per run id so later manual
  // edits are never clobbered by a query refetch.
  useEffect(() => {
    if (!runId || !runs || !mushaf) return;
    if (appliedRunRef.current === runId) return;
    const target = runs.find((r) => r.id === runId);
    if (!target) return;
    appliedRunRef.current = runId;

    const s = target.settings;
    const numOr = (v: unknown, fallback: number) =>
      v == null || Number.isNaN(Number(v)) ? fallback : Number(v);
    setSettings({
      padding: numOr(s.padding, DEFAULT_PROCESS_SETTINGS.padding),
      expected_lines: numOr(s.expected_lines, DEFAULT_PROCESS_SETTINGS.expected_lines),
      sura_header_slots: numOr(s.sura_header_slots, DEFAULT_PROCESS_SETTINGS.sura_header_slots),
      sura_header_threshold: numOr(
        s.sura_header_threshold,
        DEFAULT_PROCESS_SETTINGS.sura_header_threshold,
      ),
      max_sura_headers: numOr(s.max_sura_headers, DEFAULT_PROCESS_SETTINGS.max_sura_headers),
      match_threshold: numOr(s.match_threshold, DEFAULT_PROCESS_SETTINGS.match_threshold),
      alternate_horizontal_margin: Boolean(s.alternate_horizontal_margin),
      prefer_acceleration:
        s.prefer_acceleration == null
          ? DEFAULT_PROCESS_SETTINGS.prefer_acceleration
          : Boolean(s.prefer_acceleration),
    });
    if (s.start_sura != null) setStartSura(Number(s.start_sura));
    if (s.start_aya != null) setStartAya(Number(s.start_aya));
    setRangeStart(clamp(resumeFrom ?? target.page_range_start, 1, logicalCount));
    setRangeEnd(clamp(target.page_range_end, 1, logicalCount));
    const b = s.bounds as Rect | undefined;
    if (b && typeof b.x === "number") setBounds({ x: b.x, y: b.y, w: b.w, h: b.h });

    const label = `#${String(target.run_number).padStart(2, "0")}`;
    setLoadedRun({ label, from: resumeFrom });
    toast.success(
      resumeFrom
        ? t("process.loadedToastResume", { label, from: resumeFrom })
        : t("process.loadedToast", { label }),
    );
  }, [runId, runs, mushaf, resumeFrom, logicalCount, t]);

  const tourSteps: TourStep[] = [
    {
      target: "process-bounds",
      title: t("tour.process.t1_title"),
      body: t("tour.process.t1_body"),
    },
    { target: "process-range", title: t("tour.process.t2_title"), body: t("tour.process.t2_body") },
    { target: "process-start", title: t("tour.process.t3_title"), body: t("tour.process.t3_body") },
    {
      target: "process-settings",
      title: t("tour.process.settings_title"),
      body: t("tour.process.settings_body"),
    },
    { target: "process-run", title: t("tour.process.t4_title"), body: t("tour.process.t4_body") },
  ];
  const tour = useStepTour("process", tourSteps, (mushaf?.processed_page_count ?? 1) === 0);

  if (!mushaf) return null;

  const ayaMax = suras?.find((s) => s.number === startSura)?.aya_count ?? 286;
  const boundsOk = !!bounds && bounds.w >= 10 && bounds.h >= 10;
  const rangeOk = rangeStart >= 1 && rangeStart <= rangeEnd && rangeEnd <= logicalCount;
  const canProcess = boundsOk && rangeOk && !run?.running;

  // Preview the alternate-margin flip exactly as the engine applies it: the
  // engine anchors the mirror to the first page of the batch (page_index starts
  // at 1) and swaps every other page from there — so a page flips when its
  // offset from the start page is odd. Chunking by 50 (even) preserves parity,
  // so anchoring the preview to `rangeStart` matches every chunk. See
  // core/line_detector.py (`should_swap`) and core/pipeline.py (`enumerate`, start=1).
  const flipPreview = settings.alternate_horizontal_margin && (preview - rangeStart) % 2 !== 0;

  const guideItems = [
    { label: t("guide.process.s1"), done: boundsOk },
    { label: t("guide.process.s2"), done: rangeOk },
    { label: t("guide.process.s3"), done: boundsOk && rangeOk },
    { label: t("guide.process.s4"), done: !!run?.finished && !run.error },
  ];
  const status = run?.running ? (
    <StatusLine>{t("process.processing")}</StatusLine>
  ) : run?.finished && !run.error ? (
    <StatusLine tone="success">{t("stepStatus.processDone")}</StatusLine>
  ) : !boundsOk ? (
    <StatusLine tone="warning">{t("stepStatus.processNoBounds")}</StatusLine>
  ) : !rangeOk ? (
    <StatusLine tone="warning">{t("process.rangeError", { max: logicalCount })}</StatusLine>
  ) : (
    <StatusLine tone="success">
      {t("stepStatus.processReady", { start: rangeStart, end: rangeEnd })}
    </StatusLine>
  );

  async function runProcess() {
    if (!bounds) return;
    const total = rangeEnd - rangeStart + 1;
    setRun({ running: true, done: 0, total, finished: false, abort: null, error: null });
    let curSura = startSura;
    let curAya = startAya;
    try {
      for (let from = rangeStart; from <= rangeEnd; from += CHUNK_SIZE) {
        const to = Math.min(from + CHUNK_SIZE - 1, rangeEnd);
        const out = await processMushaf(mushafId, {
          ...settings,
          page_range_start: from,
          page_range_end: to,
          start_sura: curSura,
          start_aya: curAya,
          bounds,
        });
        setRun((r) => (r ? { ...r, done: to - rangeStart + 1 } : r));
        if (out.status !== "completed") {
          setRun((r) => (r ? { ...r, running: false, finished: true, abort: out } : r));
          return;
        }
        curSura = out.end_sura;
        curAya = out.end_aya;
      }
      setRun((r) => (r ? { ...r, running: false, finished: true } : r));
      toast.success(t("process.processedToast", { start: rangeStart, end: rangeEnd }));
    } catch (e) {
      const message = e instanceof ApiError ? e.message : t("process.processFailed");
      setRun((r) => (r ? { ...r, running: false, error: message } : r));
      toast.error(message);
    } finally {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(mushafId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      queryClient.invalidateQueries({ queryKey: queryKeys.processedPages(mushafId) });
    }
  }

  return (
    <div
      className={`flex ${i18n.language === "ar" ? "flex-row-reverse" : "flex-row"} flex-1 overflow-hidden`}
    >
      <div data-tour="process-bounds" className="relative flex flex-1 overflow-hidden">
        <PageStage
          imageUrl={pageImageUrl(mushafId, preview, mushaf.updated_at)}
          page={preview}
          pageCount={logicalCount}
          onPageChange={(n) => setPreview(clamp(n, 1, logicalCount))}
          renderLabel={(p) =>
            t("process.pdfPageLabel", {
              pdf: mushaf.first_quran_pdf_page + p - 1,
              total: mushaf.pdf_page_count,
            })
          }
          crop={{
            label: t("process.boundsLabel"),
            rect: bounds,
            onRectChange: setBounds,
            mirrored: flipPreview,
          }}
          onNatural={setNatural}
          processed={pages?.processed}
          reviewed={pages?.reviewed}
        />
        <CanvasHelp
          guideItems={guideItems}
          coachText={t("coach.process")}
          onReplayTour={tour.start}
        />
      </div>

      <div className="flex w-[400px] flex-shrink-0 flex-col gap-3 overflow-auto border-s border-border bg-white p-4">
        <h3 className="text-[12px] font-semibold capitalize text-text-primary">
          {t("process.boundsTitle")}
        </h3>
        <TemplatePreview
          mode="bounds"
          pageUrl={pageImageUrl(mushafId, preview, mushaf.updated_at)}
          working={bounds}
          mirrored={flipPreview}
        />
      </div>

      <Aside
        status={status}
        footer={
          <div data-tour="process-run" className="flex flex-col gap-2">
            {run && <ProgressFooter run={run} />}
            <Button onClick={runProcess} disabled={!canProcess}>
              {run?.running
                ? t("process.processing")
                : t("process.processButton", { start: rangeStart, end: rangeEnd })}
            </Button>
            {run?.finished && !run.error && (
              <Button asChild variant="outline">
                <Link
                  to="/mushafs/$mushafId/review"
                  params={{ mushafId }}
                  search={{ page: rangeStart }}
                >
                  {t("process.continueReview")}
                </Link>
              </Button>
            )}
          </div>
        }
      >
        {run?.abort && <AbortCard abort={run.abort} />}
        {run?.error && <Hint tone="warning">{run.error}</Hint>}

        {loadedRun && (
          <Hint>
            {loadedRun.from
              ? t("process.loadedRunResume", { label: loadedRun.label, from: loadedRun.from })
              : t("process.loadedRun", { label: loadedRun.label })}
          </Hint>
        )}

        <Section title={t("process.boundsTitle")}>
          <div className="flex items-center justify-between text-[12px]">
            <span className="flex items-center gap-1 text-text-secondary">
              {t("process.region")}
              <InfoTip text={t("process.boundsHelp")} />
            </span>
            <span className="font-mono text-text-primary">
              {bounds
                ? `${Math.round(bounds.w)}×${Math.round(bounds.h)} @ ${Math.round(bounds.x)},${Math.round(bounds.y)}`
                : "—"}
            </span>
          </div>
          <RectInputs rect={bounds} onChange={setBounds} max={natural} />
          {!boundsOk && <span className="text-[12px] text-error">{t("process.boundsError")}</span>}
          {flipPreview && (
            <span className="text-[12px]" style={{ color: "var(--navy)" }}>
              {t("process.flipHint", { page: preview, start: rangeStart })}
            </span>
          )}
        </Section>

        <div data-tour="process-range">
          <Section title={t("process.pageRange")}>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("process.startPage")} info={t("tips.pageRange")}>
                <NumInput value={rangeStart} min={1} max={logicalCount} onChange={setRangeStart} />
              </Field>
              <Field label={t("process.endPage")}>
                <NumInput value={rangeEnd} min={1} max={logicalCount} onChange={setRangeEnd} />
              </Field>
            </div>
            {!rangeOk && (
              <span className="text-[12px] text-error">
                {t("process.rangeError", { max: logicalCount })}
              </span>
            )}
          </Section>
        </div>

        <div data-tour="process-start">
          <Section title={t("process.startingPosition")}>
            <Field label={t("process.startSura")} info={t("tips.startSura")}>
              <select
                value={startSura}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setStartSura(n);
                  const max = suras?.find((s) => s.number === n)?.aya_count ?? 286;
                  setStartAya((a) => clamp(a, 1, max));
                }}
                className={selectClass}
              >
                {(suras ?? []).map((s) => (
                  <option key={s.number} value={s.number}>
                    {s.number}. {s.name_arabic} — {s.transliteration}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("process.startAya")} info={t("tips.startAya")}>
              <select
                value={startAya}
                onChange={(e) => setStartAya(Number(e.target.value))}
                className={selectClass}
              >
                {Array.from({ length: ayaMax }, (_, i) => i + 1).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>
          </Section>
        </div>

        <div data-tour="process-settings">
          <SettingsCard settings={settings} onChange={setSettings} />
        </div>
      </Aside>

      <TourOverlay tour={tour} />
    </div>
  );
}

const selectClass =
  "h-9 w-full cursor-pointer rounded-md border-[1.5px] border-border-strong bg-white px-2.5 text-[13px] text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]";

function ProgressFooter({ run }: { run: RunState }) {
  const { t } = useTranslation();
  const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-muted">
        <div
          className={`h-full rounded-full ${run.abort ? "bg-warning" : "bg-orange"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11.5px] text-text-muted">
        {run.running
          ? t("process.progressActive", { done: run.done, total: run.total })
          : t("process.progress", { done: run.done, total: run.total })}
      </span>
    </div>
  );
}

function AbortCard({ abort }: { abort: ProcessResult }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-[color:var(--warning-border)] bg-warning-bg px-3 py-2.5 text-[12px] text-[#92400E]">
      <div className="font-semibold">{t("process.abortTitle")}</div>
      <div className="mb-2.5 mt-1">{t("process.abortBody", { count: abort.pages_processed })}</div>
      {abort.abort_info && <AbortDiagnostics info={abort.abort_info} logUrl={abort.log_url} />}
    </div>
  );
}

function SettingsCard({
  settings,
  onChange,
}: {
  settings: ProcessSettings;
  onChange: (s: ProcessSettings) => void;
}) {
  const { t } = useTranslation();
  const u = (patch: Partial<ProcessSettings>) => onChange({ ...settings, ...patch });
  return (
    <Section title={t("process.detectionSettings")} defaultOpen={false}>
      <Row label={t("process.padding")} hint={t("process.paddingHint")} info={t("tips.padding")}>
        <NumInput value={settings.padding} min={0} onChange={(v) => u({ padding: v })} compact />
      </Row>
      <Row
        label={t("process.linesPerPage")}
        hint={t("process.linesPerPageHint")}
        info={t("tips.expectedLines")}
      >
        <NumInput
          value={settings.expected_lines}
          min={1}
          onChange={(v) => u({ expected_lines: v })}
          compact
        />
      </Row>
      <Row label={t("process.headerSlots")} info={t("tips.headerSlots")}>
        <NumInput
          value={settings.sura_header_slots}
          min={1}
          onChange={(v) => u({ sura_header_slots: v })}
          compact
        />
      </Row>
      <Row
        label={t("process.headerThreshold")}
        hint={t("process.headerThresholdHint")}
        info={t("tips.headerThreshold")}
      >
        <NumInput
          value={settings.sura_header_threshold}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => u({ sura_header_threshold: v })}
          compact
        />
      </Row>
      <Row label={t("process.maxHeaders")} info={t("tips.maxHeaders")}>
        <NumInput
          value={settings.max_sura_headers}
          min={1}
          onChange={(v) => u({ max_sura_headers: v })}
          compact
        />
      </Row>
      <Row
        label={t("process.ayaThreshold")}
        hint={t("process.ayaThresholdHint")}
        info={t("tips.ayaThreshold")}
      >
        <NumInput
          value={settings.match_threshold}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => u({ match_threshold: v })}
          compact
        />
      </Row>
      <Row
        label={t("process.altMargins")}
        hint={t("process.altMarginsHint")}
        info={t("tips.altMargins")}
      >
        <Toggle
          value={settings.alternate_horizontal_margin}
          onChange={(v) => u({ alternate_horizontal_margin: v })}
        />
      </Row>
      <Row
        label={t("process.preferAccel")}
        hint={t("process.preferAccelHint")}
        info={t("tips.preferAccel")}
        last
      >
        <Toggle
          value={settings.prefer_acceleration}
          onChange={(v) => u({ prefer_acceleration: v })}
        />
      </Row>
    </Section>
  );
}

function Row({
  label,
  hint,
  info,
  children,
  last,
}: {
  label: string;
  hint?: string;
  info?: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-2 py-1 ${last ? "" : "border-b border-border"}`}
    >
      <div className="flex flex-col">
        <span className="flex items-center gap-1 text-[13px] text-text-primary">
          {label}
          {info && <InfoTip text={info} />}
        </span>
        {hint && <span className="text-[10.5px] text-text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function NumInput({
  value,
  onChange,
  min,
  max,
  step,
  compact,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  compact?: boolean;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step ?? 1}
      onChange={(e) => onChange(Number(e.target.value))}
      className={[
        compact ? "h-[30px] w-[68px]" : "h-9 w-full",
        "rounded-md border-[1.5px] border-border-strong bg-white px-2 text-right text-[13px] text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]",
      ].join(" ")}
    />
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="relative h-5 w-9 flex-shrink-0 cursor-pointer rounded-[10px] transition-colors"
      style={{ background: value ? "var(--orange)" : "var(--border-strong)" }}
    >
      <span
        className="absolute top-[3px] h-[14px] w-[14px] rounded-full bg-white transition-all"
        style={{ left: value ? "19px" : "3px", boxShadow: "0 1px 3px rgba(0,0,0,.2)" }}
      />
    </button>
  );
}
