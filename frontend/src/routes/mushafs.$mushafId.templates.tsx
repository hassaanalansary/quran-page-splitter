import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Check, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Aside, StatusLine } from "@/components/app/Panel";
import { CanvasHelp } from "@/components/app/CanvasHelp";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { CroppableImage } from "@/components/canvas/CroppableImage";
import { PageStage } from "@/components/canvas/PageStage";
import { RectInputs } from "@/components/canvas/RectInputs";
import { ImageWithRedBox, TemplatePreview } from "@/components/canvas/TemplatePreview";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  pageImageUrl,
  queryKeys,
  upsertTemplate,
  useMushaf,
  useTemplates,
  type Rect,
  type Template,
  type TemplateType,
} from "@/lib/api";
import { cropUrlToBlob } from "@/lib/image";
import { getTemplateDraft, setTemplateDraft } from "@/lib/templateDraft";

export const Route = createFileRoute("/mushafs/$mushafId/templates")({ component: TemplatesPage });

const TEMPLATE_TYPES: TemplateType[] = ["sura_header", "aya_separator"];

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function TemplatesPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/templates" });
  const { data: mushaf } = useMushaf(mushafId);
  const { data: serverTemplates } = useTemplates(mushafId);
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();
  const label = (type: TemplateType) => t(`templates.label_${type}`);

  const draft0 = useMemo(() => getTemplateDraft(mushafId), [mushafId]);
  const [preview, setPreview] = useState(1);
  const [activeType, setActiveType] = useState<TemplateType>("sura_header");
  const [working, setWorking] = useState<Rect | null>(null); // template crop, page coords
  const [captures, setCaptures] = useState(draft0.captures);
  const [ignores, setIgnores] = useState(draft0.ignores); // relative to the template crop
  const [savedAt, setSavedAt] = useState(draft0.savedAt);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [editingIgnore, setEditingIgnore] = useState(false);

  // Persist the draft so leaving and returning within the app keeps captures.
  useEffect(() => {
    setTemplateDraft(mushafId, { captures, ignores, savedAt });
  }, [mushafId, captures, ignores, savedAt]);

  // Seed the selected template's saved ignore region into local state so it shows
  // on load, and survives a re-save even if the user doesn't touch it.
  useEffect(() => {
    if (!serverTemplates) return;
    const srv = serverTemplates.find((s) => s.type === activeType);
    if (srv && "x" in srv.ignore_rects) {
      setIgnores((p) => (p[activeType] ? p : { ...p, [activeType]: srv.ignore_rects as Rect }));
    }
  }, [serverTemplates, activeType]);

  const server = (type: TemplateType): Template | undefined =>
    serverTemplates?.find((s) => s.type === type);
  const templateUrlOf = (type: TemplateType): string | null =>
    captures[type]?.url ?? server(type)?.image_url ?? null;
  const isSaved = (type: TemplateType): boolean =>
    captures[type] ? !!savedAt[type] : !!server(type);
  const hasIgnore = (type: TemplateType): boolean => {
    if (ignores[type]) return true;
    const srv = server(type);
    return !!srv && "x" in srv.ignore_rects;
  };

  // Card click selects a template to work on (never jumps into ignore mode). The
  // ignore region is seeded from the saved template (its coords are already
  // relative to the template crop) so revisiting shows it.
  function selectType(type: TemplateType) {
    setActiveType(type);
    setWorking(captures[type]?.rect ?? null);
    setEditingIgnore(false);
  }

  async function capture() {
    if (!working || !mushaf) return;
    try {
      const blob = await cropUrlToBlob(pageImageUrl(mushafId, preview, mushaf.updated_at), working);
      const url = URL.createObjectURL(blob);
      setCaptures((p) => {
        if (p[activeType]?.url) URL.revokeObjectURL(p[activeType]!.url);
        return { ...p, [activeType]: { blob, url, rect: { ...working } } };
      });
      // Re-cropping invalidates the previous ignore (its coords are template-relative).
      setIgnores((p) => ({ ...p, [activeType]: undefined }));
      setEditingIgnore(false);
      setSavedAt((p) => ({ ...p, [activeType]: false }));
      toast.success(t("templates.captured", { label: label(activeType) }));
    } catch {
      toast.error(t("templates.captureFailed"));
    }
  }

  const saveMutation = useMutation({
    mutationFn: async (type: TemplateType) => {
      const cap = captures[type];
      if (!cap) throw new Error("Nothing to save.");
      // The ignore is already relative to the template crop.
      await upsertTemplate(mushafId, type, { image: cap.blob, ignore: ignores[type] ?? null });
      return type;
    },
    onSuccess: (type) => {
      setSavedAt((p) => ({ ...p, [type]: true }));
      queryClient.invalidateQueries({ queryKey: queryKeys.templates(mushafId) });
      toast.success(t("templates.savedTemplateToast", { label: label(type) }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("templates.saveFailed")),
  });

  const tourSteps: TourStep[] = [
    {
      target: "tpl-canvas",
      title: t("tour.templates.t1_title"),
      body: t("tour.templates.t1_body"),
    },
    {
      target: "canvas-toolbar",
      title: t("tour.templates.tools_title"),
      body: t("tour.templates.tools_body"),
    },
    {
      target: "tpl-capture",
      title: t("tour.templates.t2_title"),
      body: t("tour.templates.t2_body"),
    },
    {
      target: "tpl-targets",
      title: t("tour.templates.t3_title"),
      body: t("tour.templates.t3_body"),
    },
  ];
  const tour = useStepTour(
    "templates",
    tourSteps,
    !!serverTemplates && serverTemplates.length === 0,
  );

  if (!mushaf) return null;
  const logicalCount = mushaf.logical_page_count;
  const pageUrl = pageImageUrl(mushafId, preview, mushaf.updated_at);

  const headerSaved = isSaved("sura_header");
  const sepSaved = isSaved("aya_separator");
  const guideItems = [
    { label: t("guide.templates.s1"), done: headerSaved },
    { label: t("guide.templates.s2"), done: sepSaved },
    { label: t("guide.templates.s3") },
    { label: t("guide.templates.s4"), done: headerSaved && sepSaved },
  ];
  const status =
    headerSaved && sepSaved ? (
      <StatusLine tone="success">{t("stepStatus.templatesDone")}</StatusLine>
    ) : headerSaved || sepSaved ? (
      <StatusLine>{t("stepStatus.templatesPartial")}</StatusLine>
    ) : (
      <StatusLine>{t("stepStatus.templatesNone")}</StatusLine>
    );

  const cap = captures[activeType];
  const templateUrl = templateUrlOf(activeType);
  const ignoreRect = ignores[activeType] ?? null;

  return (
    <div
      className={`flex ${i18n.language === "ar" ? "flex-row-reverse" : "flex-row"} flex-1 overflow-hidden`}
    >
      {/* Left: crop the selected template on the page */}
      <div data-tour="tpl-canvas" className="relative flex flex-1 overflow-hidden">
        <PageStage
          imageUrl={pageUrl}
          page={preview}
          pageCount={logicalCount}
          onPageChange={(n) => setPreview(clamp(n, 1, logicalCount))}
          renderLabel={(p) =>
            t("process.pdfPageLabel", {
              pdf: mushaf.first_quran_pdf_page + p - 1,
              total: mushaf.pdf_page_count,
            })
          }
          crop={{ label: label(activeType), rect: working, onRectChange: setWorking }}
          onNatural={setNatural}
        />
        <CanvasHelp
          guideItems={guideItems}
          coachText={t("coach.templates")}
          onReplayTour={tour.start}
        />
      </div>

      {/* Center: handle the selected template fully — capture, ignore, save */}
      <div
        data-tour="tpl-capture"
        className="flex w-[400px] flex-shrink-0 flex-col gap-3 overflow-auto border-s border-border bg-white p-4"
      >
        <div className="text-[12px] font-semibold capitalize text-text-primary">
          {label(activeType)}
        </div>

        <TemplatePreview mode="template" pageUrl={pageUrl} working={working} />
        <RectInputs rect={working} onChange={setWorking} max={natural} />
        <Button onClick={capture} disabled={!working || working.w < 2}>
          {cap ? t("templates.recrop") : t("templates.capture", { label: label(activeType) })}
        </Button>

        <IgnoreSection
          templateUrl={templateUrl}
          ignoreRect={ignoreRect}
          editing={editingIgnore}
          onEdit={() => setEditingIgnore(true)}
          onDone={() => {
            setEditingIgnore(false);
            if (ignores[activeType]) toast.success(t("templates.ignoreSetToast"));
          }}
          onChange={(r) => setIgnores((p) => ({ ...p, [activeType]: r ?? undefined }))}
          onClear={() => {
            setIgnores((p) => ({ ...p, [activeType]: undefined }));
            setEditingIgnore(false);
            toast.success(t("templates.ignoreCleared"));
          }}
        />

        <Button
          className="mt-auto"
          onClick={() => saveMutation.mutate(activeType)}
          disabled={!cap || saveMutation.isPending}
        >
          {savedAt[activeType] ? (
            <>
              <Check size={14} /> {t("templates.savedBtn")}
            </>
          ) : (
            t("templates.saveNamed", { label: label(activeType) })
          )}
        </Button>
      </div>

      {/* Right: selection cards */}
      <Aside
        status={status}
        footer={
          <Button asChild variant="outline">
            <Link to="/mushafs/$mushafId/process" params={{ mushafId }}>
              {t("templates.continueProcess")}
            </Link>
          </Button>
        }
      >
        <p className="flex gap-1.5 rounded-md border border-[color:var(--warning-border)] bg-warning-bg px-2.5 py-2 text-[11px] leading-snug text-[#92400E]">
          <TriangleAlert size={13} className="mt-[1px] flex-none" />
          <span>{t("templates.cropTip")}</span>
        </p>
        <div data-tour="tpl-targets" className="flex flex-col gap-3">
          {TEMPLATE_TYPES.map((type) => {
            const name = t(`templates.name_${type}`);
            const hint = t(`templates.hint_${type}`);
            const url = templateUrlOf(type);
            const dirty = !!captures[type] && !savedAt[type];
            const saved = isSaved(type);
            const active = activeType === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => selectType(type)}
                className={`overflow-hidden cursor-pointer rounded-xl border p-3 text-start transition-colors ${
                  active
                    ? "border-orange ring-2 ring-orange/30 bg-white"
                    : saved
                      ? "border-success/80 ring-1 ring-success/30 bg-success/5 hover:bg-success/10"
                      : "border-border hover:border-border-strong"
                }`}
              >
                <div className="mb-2 flex items-start gap-2">
                  <span className="flex-1 text-[13px] font-semibold text-text-primary">{name}</span>
                  <span className="flex flex-col items-end gap-1">
                    {dirty ? (
                      <span className="text-[11px] font-medium text-orange">
                        {t("templates.unsaved")}
                      </span>
                    ) : saved ? (
                      <span className="px-1.5 py-[1px] text-[10px] border-success/40 bg-success-bg rounded-pill border flex items-center gap-1 text-[11px] font-medium text-success">
                        <Check size={12} /> {t("templates.saved")}
                      </span>
                    ) : (
                      <span className="text-[11px] text-text-muted">{t("templates.notSet")}</span>
                    )}
                    {hasIgnore(type) && (
                      <span className="rounded-pill border border-error/40 bg-error-bg px-1.5 py-[1px] text-[10px] font-medium text-error">
                        {t("templates.ignoreChip")}
                      </span>
                    )}
                  </span>
                </div>
                <p className="mb-2 text-[11px] text-text-muted">{hint}</p>
                <div className="flex h-16 w-full items-center justify-center overflow-hidden rounded border border-border bg-bg-surface">
                  {url ? (
                    <img src={url} alt={name} className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-[10px] text-text-muted">{t("templates.noCrop")}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </Aside>

      <TourOverlay tour={tour} />
    </div>
  );
}

/** The in-workspace ignore-region editor: a red box dragged on the captured
 * template itself (not the main page), so switching pages can't disturb it. */
function IgnoreSection({
  templateUrl,
  ignoreRect,
  editing,
  onEdit,
  onDone,
  onChange,
  onClear,
}: {
  templateUrl: string | null;
  ignoreRect: Rect | null;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onChange: (r: Rect | null) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  if (!templateUrl) {
    return (
      <p className="rounded-md border border-border bg-bg-surface px-3 py-2 text-[11px] text-text-muted">
        {t("templates.captureFirstToIgnore")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
          {t("templates.ignoreLabel")}
          {ignoreRect && (
            <span className="inline-flex items-center gap-1 rounded-pill border border-success/40 bg-success/10 px-1.5 py-[1px] text-[10px] font-medium text-success">
              <Check size={10} strokeWidth={3} />
              {Math.round(ignoreRect.w)}×{Math.round(ignoreRect.h)}
            </span>
          )}
        </span>
        <div className="flex gap-1.5">
          {ignoreRect && (
            <button
              type="button"
              onClick={onClear}
              className="rounded-sm border border-border-strong bg-white px-2 py-[3px] text-[11px] font-medium text-text-secondary hover:bg-bg-surface"
            >
              {t("templates.clearIgnore")}
            </button>
          )}
          {editing ? (
            <button
              type="button"
              onClick={onDone}
              className="rounded-sm bg-orange px-2.5 py-[3px] text-[11px] font-semibold text-white hover:bg-orange-hover"
            >
              {t("templates.ignoreDone")}
            </button>
          ) : (
            <button
              type="button"
              onClick={onEdit}
              className="rounded-sm border border-border-strong bg-white px-2 py-[3px] text-[11px] font-medium text-orange hover:bg-orange-tint"
            >
              {ignoreRect ? t("templates.editIgnoreRegion") : t("templates.addIgnoreRegion")}
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <>
          <p className="text-[10.5px] leading-snug text-text-muted">
            {t("templates.ignoreEditHint")}
          </p>
          <div className="raqam-canvas-grid h-[200px] overflow-hidden rounded-md border border-border">
            <CroppableImage
              imageUrl={templateUrl}
              rect={ignoreRect}
              onRectChange={onChange}
              label={t("templates.ignoreLabel")}
              tone="red"
            />
          </div>
        </>
      ) : ignoreRect ? (
        <ImageWithRedBox imageUrl={templateUrl} red={ignoreRect} height={200} />
      ) : (
        <p className="text-[11px] text-text-muted">{t("templates.noIgnore")}</p>
      )}
    </div>
  );
}
