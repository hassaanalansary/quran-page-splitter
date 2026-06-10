import { useState } from "react";
import type { Rect, Settings, TargetName } from "@/lib/api/raqam";
import { SURAS, getSura } from "@/lib/data/suras";

type TargetState = {
  rect: Rect | null;
};

type Props = {
  targets: Record<TargetName, TargetState>;
  activeTarget: TargetName | null;
  setActiveTarget: (t: TargetName) => void;
  currentRect: Rect | null;
  setCurrentRect: (r: Rect | null) => void;
  onStartDrawing: () => void;
  onApply: () => void;
  settings: Settings;
  setSettings: (s: Settings) => void;
  pageCount: number;
  onProcess: () => void;
  processing: boolean;
};

type Tab = "targets" | "settings" | "numbering";

const REQUIRED: TargetName[] = ["bounds", "sura_header", "aya_separator"];
const OPTIONAL: TargetName[] = ["sura_header_ignore", "aya_separator_ignore"];

export function RightPanel(props: Props) {
  const [tab, setTab] = useState<Tab>("targets");

  const missing = REQUIRED.filter((t) => !props.targets[t].rect);
  const canProcess = missing.length === 0 && props.pageCount > 0 && !props.processing;

  return (
    <aside className="flex w-[320px] flex-shrink-0 flex-col overflow-hidden border-l border-border bg-white">
      {/* Tabs */}
      <div className="flex border-b border-border bg-white">
        {(["targets", "settings", "numbering"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={[
              "-mb-px flex-1 cursor-pointer px-[6px] py-3 text-center text-[12.5px] capitalize transition-colors",
              tab === t
                ? "border-b-2 border-orange font-semibold text-orange"
                : "border-b-2 border-transparent font-medium text-text-secondary hover:bg-bg-page hover:text-text-primary",
            ].join(" ")}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-[14px]">
        {tab === "targets" && <TargetsTab {...props} />}
        {tab === "settings" && (
          <SettingsTab settings={props.settings} setSettings={props.setSettings} />
        )}
        {tab === "numbering" && (
          <NumberingTab settings={props.settings} setSettings={props.setSettings} />
        )}
      </div>

      {/* Action Bar */}
      <div className="flex-shrink-0 border-t border-border bg-white px-[14px] py-3">
        {missing.length > 0 && (
          <div className="mb-2 flex items-center gap-[7px] rounded-sm border border-error-border bg-error-bg px-[11px] py-2 text-[12px] text-error">
            <span aria-hidden>⚠</span>
            <span>
              {missing.length} required target
              {missing.length > 1 ? "s" : ""} missing
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={props.onProcess}
          disabled={!canProcess}
          className={[
            "h-11 w-full rounded-md text-[14px] font-semibold text-white transition-colors",
            canProcess
              ? "bg-navy hover:bg-navy-hover"
              : "cursor-not-allowed bg-border-strong text-text-muted",
          ].join(" ")}
          style={{ letterSpacing: "0.02em" }}
        >
          {props.processing
            ? "Processing…"
            : `Process ${props.pageCount} Page${props.pageCount === 1 ? "" : "s"}  →`}
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {REQUIRED.map((t) => (
            <span
              key={t}
              className="flex items-center gap-1 text-[11.5px] text-text-secondary"
            >
              <span
                className="h-[6px] w-[6px] rounded-full"
                style={{
                  background: props.targets[t].rect
                    ? "var(--success)"
                    : "var(--error)",
                }}
              />
              {t}
            </span>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-white">
      <div
        className="border-b border-border bg-white px-[13px] py-[9px] text-[12px] font-semibold text-text-primary"
        style={{ letterSpacing: "0.02em" }}
      >
        {title}
      </div>
      <div className="flex flex-col gap-2 p-3">{children}</div>
    </div>
  );
}

function TargetsTab(props: Props) {
  const { targets, activeTarget, setActiveTarget, currentRect, setCurrentRect } =
    props;

  function setField(key: keyof Rect, value: number) {
    const r = currentRect ?? { x: 0, y: 0, w: 0, h: 0 };
    setCurrentRect({ ...r, [key]: value });
  }

  return (
    <div className="flex flex-col gap-3">
      <Card title="Required Targets">
        <div className="grid grid-cols-2 gap-[6px]">
          <TargetCard
            name="bounds"
            state={targetCardState(targets, "bounds", activeTarget, true)}
            onClick={() => setActiveTarget("bounds")}
          />
          <TargetCard
            name="sura_header"
            state={targetCardState(targets, "sura_header", activeTarget, true)}
            onClick={() => setActiveTarget("sura_header")}
          />
          <div className="col-span-2">
            <TargetCard
              name="aya_separator"
              state={targetCardState(targets, "aya_separator", activeTarget, true)}
              onClick={() => setActiveTarget("aya_separator")}
              wide
            />
          </div>
          {OPTIONAL.map((t) => (
            <TargetCard
              key={t}
              name={t}
              state={targetCardState(targets, t, activeTarget, false)}
              onClick={() => setActiveTarget(t)}
              dashed
            />
          ))}
        </div>
      </Card>

      <Card title="Crop Coordinates">
        <div className="flex flex-col gap-1">
          <label className="text-[11.5px] font-semibold text-text-secondary" style={{ letterSpacing: "0.03em" }}>
            Target
          </label>
          <select
            value={activeTarget ?? ""}
            onChange={(e) => setActiveTarget(e.target.value as TargetName)}
            className="h-9 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-[10px] text-[13px] text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]"
          >
            {[...REQUIRED, ...OPTIONAL].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {(["x", "y", "w", "h"] as const).map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <label
                className="text-[11.5px] font-semibold text-text-secondary"
                style={{ letterSpacing: "0.03em" }}
              >
                {k === "w" ? "Width" : k === "h" ? "Height" : `${k.toUpperCase()} (px)`}
              </label>
              <input
                type="number"
                value={currentRect?.[k] ?? 0}
                onChange={(e) => setField(k, Number(e.target.value) || 0)}
                className="h-9 w-full rounded-sm border-[1.5px] border-border-strong bg-white px-[10px] text-right text-[13px] text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]"
              />
            </div>
          ))}
        </div>

        <div className="mt-1 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={props.onStartDrawing}
            className="h-8 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-[13px] text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary"
          >
            ⊕ Start Drawing
          </button>
          <button
            type="button"
            onClick={props.onApply}
            disabled={!currentRect || currentRect.w < 2 || currentRect.h < 2}
            className="h-8 cursor-pointer rounded-sm bg-orange px-[13px] text-[12.5px] font-semibold text-white transition-colors hover:bg-orange-hover disabled:cursor-not-allowed disabled:bg-border-strong disabled:text-text-muted"
            style={{ boxShadow: "0 2px 6px color-mix(in oklab, var(--orange) 30%, transparent)" }}
          >
            ✓ Apply Crop
          </button>
        </div>
      </Card>
    </div>
  );
}

type CardState = "default" | "active" | "done" | "missing";

function targetCardState(
  targets: Record<TargetName, TargetState>,
  name: TargetName,
  active: TargetName | null,
  required: boolean,
): CardState {
  if (name === active) return "active";
  if (targets[name].rect) return "done";
  if (required) return "missing";
  return "default";
}

function TargetCard({
  name,
  state,
  onClick,
  wide,
  dashed,
}: {
  name: TargetName;
  state: CardState;
  onClick: () => void;
  wide?: boolean;
  dashed?: boolean;
}) {
  const styles: Record<CardState, { box: string; title: string; sub: string; subText: string }> = {
    default: {
      box: "bg-white border-border hover:border-border-strong hover:bg-bg-surface",
      title: "text-text-primary",
      sub: "text-text-muted",
      subText: "Not set",
    },
    active: {
      box: "bg-orange-tint border-orange shadow-[0_0_0_3px_var(--orange-glow)]",
      title: "text-orange",
      sub: "text-orange",
      subText: "Currently editing",
    },
    done: {
      box: "bg-success-bg border-[color:var(--success-border)]",
      title: "text-success",
      sub: "text-success",
      subText: "✓ Template set",
    },
    missing: {
      box: "bg-error-bg border-[color:var(--error-border)]",
      title: "text-error",
      sub: "text-error",
      subText: "! Required",
    },
  };
  const s = styles[state];
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "cursor-pointer rounded-md border-[1.5px] px-[10px] py-2 text-left transition-all",
        dashed ? "border-dashed" : "",
        s.box,
        wide ? "w-full" : "",
      ].join(" ")}
    >
      <div
        className={["text-[11px] font-semibold", s.title].join(" ")}
        style={{ letterSpacing: "0.02em" }}
      >
        {name}
      </div>
      <div className={["mt-[2px] text-[9.5px]", s.sub].join(" ")}>{s.subText}</div>
    </button>
  );
}

function SettingsRow({
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
      className={[
        "flex items-center justify-between py-[5px]",
        last ? "" : "border-b border-border",
      ].join(" ")}
    >
      <div className="flex flex-col">
        <span className="text-[13px] text-text-primary">{label}</span>
        {hint && (
          <span className="block text-[10.5px] text-text-muted">{hint}</span>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  step,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      step={step ?? 1}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-[30px] w-[72px] rounded-sm border-[1.5px] border-border-strong bg-white px-2 text-right text-[13px] text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]"
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
      className="relative h-5 w-9 cursor-pointer rounded-[10px] transition-colors"
      style={{ background: value ? "var(--orange)" : "var(--border-strong)" }}
    >
      <span
        className="absolute top-[3px] h-[14px] w-[14px] rounded-full bg-white transition-all"
        style={{
          left: value ? "19px" : "3px",
          boxShadow: "0 1px 3px rgba(0,0,0,.20)",
        }}
      />
    </button>
  );
}

function SettingsTab({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: (s: Settings) => void;
}) {
  const u = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });
  return (
    <Card title="Detection Parameters">
      <SettingsRow label="Padding" hint="px added above and below each line box">
        <NumberInput value={settings.padding} onChange={(v) => u({ padding: v })} min={0} />
      </SettingsRow>
      <SettingsRow label="Lines / page" hint="Expected line slots including headers">
        <NumberInput
          value={settings.expected_lines}
          onChange={(v) => u({ expected_lines: v })}
          min={1}
        />
      </SettingsRow>
      <SettingsRow label="Header slots" hint="Slots one sura header consumes">
        <NumberInput
          value={settings.sura_header_slots}
          onChange={(v) => u({ sura_header_slots: v })}
          min={1}
        />
      </SettingsRow>
      <SettingsRow label="Header threshold" hint="Match confidence 0–1, higher = stricter">
        <NumberInput
          value={settings.sura_header_threshold}
          onChange={(v) => u({ sura_header_threshold: v })}
          step={0.05}
          min={0}
          max={1}
        />
      </SettingsRow>
      <SettingsRow label="Max headers / page" hint="Prevents excess header detections">
        <NumberInput
          value={settings.max_sura_headers}
          onChange={(v) => u({ max_sura_headers: v })}
          min={1}
        />
      </SettingsRow>
      <SettingsRow label="Aya threshold" hint="Separator match confidence 0–1">
        <NumberInput
          value={settings.match_threshold}
          onChange={(v) => u({ match_threshold: v })}
          step={0.05}
          min={0}
          max={1}
        />
      </SettingsRow>
      <SettingsRow label="Alternate margins" hint="Mirrors bounds on even-numbered pages">
        <Toggle
          value={settings.alternate_horizontal_margin}
          onChange={(v) => u({ alternate_horizontal_margin: v })}
        />
      </SettingsRow>
      <SettingsRow
        label="Prefer acceleration"
        hint="Uses OpenCL when available"
        last
      >
        <Toggle
          value={settings.prefer_acceleration}
          onChange={(v) => u({ prefer_acceleration: v })}
        />
      </SettingsRow>
    </Card>
  );
}

function NumberingTab({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: (s: Settings) => void;
}) {
  const u = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });
  const currentSura = getSura(settings.start_sura);
  const ayaMax = currentSura.aya_count;
  const ayaValue = Math.min(Math.max(1, settings.start_aya), ayaMax);

  const selectClass =
    "h-9 w-full cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-[10px] text-[13px] text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]";

  return (
    <div className="flex flex-col gap-3">
      <Card title="Starting Position">
        <div className="flex flex-col gap-1">
          <label
            className="text-[11.5px] font-semibold text-text-secondary"
            style={{ letterSpacing: "0.03em" }}
          >
            Start Sura
          </label>
          <select
            value={settings.start_sura}
            onChange={(e) => {
              const n = Number(e.target.value) || 1;
              const next = getSura(n);
              u({
                start_sura: n,
                start_aya: Math.min(Math.max(1, settings.start_aya), next.aya_count),
              });
            }}
            className={selectClass}
          >
            {SURAS.map((s) => (
              <option key={s.number} value={s.number}>
                {s.number}. {s.name} — {s.transliteration}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label
            className="text-[11.5px] font-semibold text-text-secondary"
            style={{ letterSpacing: "0.03em" }}
          >
            Start Aya
          </label>
          <select
            value={ayaValue}
            onChange={(e) => u({ start_aya: Number(e.target.value) || 1 })}
            className={selectClass}
          >
            {Array.from({ length: ayaMax }, (_, i) => i + 1).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <div className="rounded-md border border-[color:var(--warning-border)] bg-warning-bg px-[11px] py-[9px] text-[12px] leading-[1.5]" style={{ color: "#92400E" }}>
        <span className="mb-[3px] block text-[12px] font-semibold">Tip</span>
        These apply to the whole batch. Use the Review page to correct per-page
        numbering issues after processing.
      </div>
    </div>
  );
}
