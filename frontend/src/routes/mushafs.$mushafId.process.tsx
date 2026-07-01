import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { TemplatePreview } from "@/components/canvas/TemplatePreview";
import { Aside, Field, Hint, Section } from "@/components/app/Panel";
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
  useSuras,
  type ProcessResult,
  type ProcessSettings,
  type Rect,
} from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId/process")({ component: ProcessPage });

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
  const { data: mushaf } = useMushaf(mushafId);
  const { data: suras } = useSuras(mushaf?.qiraa);
  const { data: pages } = useProcessedPages(mushafId);
  const queryClient = useQueryClient();

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

  if (!mushaf) return null;

  const ayaMax = suras?.find((s) => s.number === startSura)?.aya_count ?? 286;
  const boundsOk = !!bounds && bounds.w >= 10 && bounds.h >= 10;
  const rangeOk = rangeStart >= 1 && rangeStart <= rangeEnd && rangeEnd <= logicalCount;
  const canProcess = boundsOk && rangeOk && !run?.running;

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
      toast.success(`Processed pages ${rangeStart}–${rangeEnd}.`);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "Processing failed.";
      setRun((r) => (r ? { ...r, running: false, error: message } : r));
      toast.error(message);
    } finally {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(mushafId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      queryClient.invalidateQueries({ queryKey: queryKeys.processedPages(mushafId) });
    }
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <PageStage
        imageUrl={pageImageUrl(mushafId, preview, mushaf.updated_at)}
        page={preview}
        pageCount={logicalCount}
        onPageChange={(n) => setPreview(clamp(n, 1, logicalCount))}
        renderLabel={(p) =>
          `PDF page ${mushaf.first_quran_pdf_page + p - 1} of ${mushaf.pdf_page_count}`
        }
        crop={{ label: "bounds", rect: bounds, onRectChange: setBounds }}
        onNatural={setNatural}
        processed={pages?.processed}
        reviewed={pages?.reviewed}
      />

      <div className="flex w-[400px] flex-shrink-0 flex-col gap-3 overflow-auto border-l border-border bg-white p-4">
        <div className="text-[12px] font-semibold capitalize text-text-primary">
          <Hint>Bounds</Hint>
          <TemplatePreview
            mode="template"
            pageUrl={pageImageUrl(mushafId, preview, mushaf.updated_at)}
            working={bounds}
          />
        </div>
      </div>

      <Aside
        footer={
          <div className="flex flex-col gap-2">
            {run && <ProgressFooter run={run} />}
            <Button onClick={runProcess} disabled={!canProcess}>
              {run?.running ? "Processing…" : `Process pages ${rangeStart}–${rangeEnd}`}
            </Button>
            {run?.finished && !run.error && (
              <Button asChild variant="outline">
                <Link
                  to="/mushafs/$mushafId/review"
                  params={{ mushafId }}
                  search={{ page: rangeStart }}
                >
                  Continue to Review →
                </Link>
              </Button>
            )}
          </div>
        }
      >
        <Hint>
          Set the <strong>bounds</strong>, choose the page range and where it starts, then process.
          Save the templates first.
        </Hint>

        <Section title="Bounds">
          <p className="text-[12px] text-text-muted">
            Draw the text region on the page — the orange box. Exclude margins and decorations; line
            detection runs inside it.
          </p>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-text-secondary">Region</span>
            <span className="font-mono text-text-primary">
              {bounds
                ? `${Math.round(bounds.w)}×${Math.round(bounds.h)} @ ${Math.round(bounds.x)},${Math.round(bounds.y)}`
                : "—"}
            </span>
          </div>
          <CropPreview
            imageUrl={pageImageUrl(mushafId, preview, mushaf.updated_at)}
            rect={bounds}
          />
          <RectInputs rect={bounds} onChange={setBounds} max={natural} />
          {!boundsOk && (
            <span className="text-[12px] text-error">
              Draw a bounds box on the page to enable processing.
            </span>
          )}
        </Section>

        <Section title="Page range">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start page">
              <NumInput value={rangeStart} min={1} max={logicalCount} onChange={setRangeStart} />
            </Field>
            <Field label="End page">
              <NumInput value={rangeEnd} min={1} max={logicalCount} onChange={setRangeEnd} />
            </Field>
          </div>
          {!rangeOk && (
            <span className="text-[12px] text-error">
              Require 1 ≤ start ≤ end ≤ {logicalCount}.
            </span>
          )}
        </Section>

        <Section title="Starting position">
          <Field label="Start sura">
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
          <Field label="Start aya">
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

        <SettingsCard settings={settings} onChange={setSettings} />

        {run?.abort && <AbortCard abort={run.abort} />}
        {run?.error && <Hint tone="warning">{run.error}</Hint>}
      </Aside>
    </div>
  );
}

const selectClass =
  "h-9 w-full cursor-pointer rounded-md border-[1.5px] border-border-strong bg-white px-2.5 text-[13px] text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]";

function ProgressFooter({ run }: { run: RunState }) {
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
        {run.done} / {run.total} pages {run.running ? "processed…" : "processed"}
      </span>
    </div>
  );
}

function AbortCard({ abort }: { abort: ProcessResult }) {
  const info = abort.abort_info ?? {};
  return (
    <div className="rounded-md border border-[color:var(--warning-border)] bg-warning-bg px-3 py-2 text-[12px] text-[#92400E]">
      <div className="font-semibold">Stopped on a line-count mismatch</div>
      <div className="mt-1">
        {abort.pages_processed} page{abort.pages_processed === 1 ? "" : "s"} were saved before the
        stop. Adjust the bounds or expected-lines, then reprocess from where it stopped.
      </div>
      {Object.keys(info).length > 0 && (
        <pre className="mt-1.5 overflow-x-auto rounded bg-white/60 p-1.5 text-[11px] leading-tight">
          {JSON.stringify(info, null, 2)}
        </pre>
      )}
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
  const u = (patch: Partial<ProcessSettings>) => onChange({ ...settings, ...patch });
  return (
    <Section title="Detection settings" defaultOpen={false}>
      <Row label="Padding" hint="px above/below each line">
        <NumInput value={settings.padding} min={0} onChange={(v) => u({ padding: v })} compact />
      </Row>
      <Row label="Lines / page" hint="Expected slots incl. headers">
        <NumInput
          value={settings.expected_lines}
          min={1}
          onChange={(v) => u({ expected_lines: v })}
          compact
        />
      </Row>
      <Row label="Header slots">
        <NumInput
          value={settings.sura_header_slots}
          min={1}
          onChange={(v) => u({ sura_header_slots: v })}
          compact
        />
      </Row>
      <Row label="Header threshold" hint="0–1, higher = stricter">
        <NumInput
          value={settings.sura_header_threshold}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => u({ sura_header_threshold: v })}
          compact
        />
      </Row>
      <Row label="Max headers / page">
        <NumInput
          value={settings.max_sura_headers}
          min={1}
          onChange={(v) => u({ max_sura_headers: v })}
          compact
        />
      </Row>
      <Row label="Aya threshold" hint="0–1 separator match">
        <NumInput
          value={settings.match_threshold}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => u({ match_threshold: v })}
          compact
        />
      </Row>
      <Row label="Alternate margins" hint="Mirror bounds on even pages">
        <Toggle
          value={settings.alternate_horizontal_margin}
          onChange={(v) => u({ alternate_horizontal_margin: v })}
        />
      </Row>
      <Row label="Prefer acceleration" hint="Use OpenCL when available" last>
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
  children,
  last,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-2 py-1 ${last ? "" : "border-b border-border"}`}
    >
      <div className="flex flex-col">
        <span className="text-[13px] text-text-primary">{label}</span>
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
