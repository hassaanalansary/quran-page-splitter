import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Check, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Aside, StatusLine, StepBody } from "@/components/app/Panel";
import { CanvasHelp } from "@/components/app/CanvasHelp";
import { BusyLabel } from "@/components/app/SatrLoader";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { CroppableImage } from "@/components/canvas/CroppableImage";
import { PageStage } from "@/components/canvas/PageStage";
import { RectInputs } from "@/components/canvas/RectInputs";
import { ImageWithRedBox, TemplatePreview } from "@/components/canvas/TemplatePreview";
import { ZoomPane } from "@/components/canvas/ZoomPane";
import {
  ApiError,
  pageImageUrl,
  queryKeys,
  upsertTemplate,
  useMushaf,
  useTemplates,
  type Rect,
  type Template,
  REQUIRED_TEMPLATE_TYPES,
  TEMPLATE_TYPES,
  type TemplateType,
} from "@/lib/api";
import { cropUrlToBlob } from "@/lib/image";
import { getTemplateDraft, setTemplateDraft } from "@/lib/templateDraft";

export const Route = createFileRoute("/mushafs/$mushafId/templates")({ component: TemplatesPage });

/** Logical pages whose sura band and aya markers are drawn as a one-off: the
 * Fatiha opening and the start of al-Baqara sit inside an ornamental frame, so
 * a template cut from them matches nothing on the pages that follow. */
const OPENING_PAGES = 2;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** Rect equality at save precision (coords are rounded before upload). */
function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.w) === Math.round(b.w) &&
    Math.round(a.h) === Math.round(b.h)
  );
}

function TemplatesPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/templates" });
  const { data: mushaf } = useMushaf(mushafId);
  const { data: serverTemplates } = useTemplates(mushafId);
  const queryClient = useQueryClient();
  const { t } = useTranslation();
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

  const server = (type: TemplateType): Template | undefined =>
    serverTemplates?.find((s) => s.type === type);
  const templateUrlOf = (type: TemplateType): string | null =>
    captures[type]?.url ?? server(type)?.image_url ?? null;

  /** The variable area as currently saved on the server. */
  const serverIgnore = (type: TemplateType): Rect | null => {
    const srv = server(type);
    return srv && "x" in srv.ignore_rects ? (srv.ignore_rects as Rect) : null;
  };
  /** What the user is looking at: their edit if they made one, else what's saved.
   * (`null` in local state means "cleared", which must not fall back.) */
  const effectiveIgnore = (type: TemplateType): Rect | null => {
    const local = ignores[type];
    return local !== undefined ? local : serverIgnore(type);
  };
  const hasIgnore = (type: TemplateType): boolean => !!effectiveIgnore(type);

  // What "unsaved" means: a capture that was never saved, or a variable area that
  // no longer matches the saved one. Both drive the Save button and the card chip,
  // so the two can never disagree.
  const hasTemplate = (type: TemplateType): boolean => !!captures[type] || !!server(type);
  const isDirty = (type: TemplateType): boolean =>
    hasTemplate(type) &&
    ((!!captures[type] && !savedAt[type]) || !sameRect(effectiveIgnore(type), serverIgnore(type)));
  const isSaved = (type: TemplateType): boolean => hasTemplate(type) && !isDirty(type);

  // Card click selects a template to work on (never jumps into ignore mode).
  // Its variable area comes from `effectiveIgnore`, so a saved region shows up
  // on revisit without being copied into local state.
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
      // Re-cropping invalidates the previous ignore (its coords are template-relative),
      // so it is explicitly cleared rather than left to fall back to the saved one.
      setIgnores((p) => ({ ...p, [activeType]: null }));
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
      if (!cap && !server(type)) throw new Error("Nothing to save.");
      // Image-less saves are allowed for an already-stored template, so a
      // variable-area change alone can be saved after a reload. The ignore rect
      // is already relative to the template crop.
      const template = await upsertTemplate(mushafId, type, {
        image: cap?.blob ?? null,
        ignore: effectiveIgnore(type),
      });
      return { type, template };
    },
    onSuccess: ({ type, template }) => {
      setSavedAt((p) => ({ ...p, [type]: true }));
      // Fold the server's answer in right away, so "unsaved" clears without
      // waiting on the refetch.
      queryClient.setQueryData<Template[]>(queryKeys.templates(mushafId), (old) => [
        ...(old ?? []).filter((x) => x.type !== type),
        template,
      ]);
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

  // Only the two required ones decide the step's status. The symbols are optional
  // — they affect just the lines that print them — so a mushaf without them is
  // not incomplete, and saying otherwise would mark every existing one unfinished.
  const requiredSaved = REQUIRED_TEMPLATE_TYPES.filter(isSaved).length;
  // Plain instructions, not a checklist: a saved template still gets re-cropped
  // once detection disagrees with it, so "done" was never the whole truth. The
  // card chips already report what is saved.
  const guideItems = [
    t("guide.templates.s1"),
    t("guide.templates.s2"),
    t("guide.templates.s2b"),
    t("guide.templates.s3"),
    t("guide.templates.s4"),
  ];
  const status =
    requiredSaved === REQUIRED_TEMPLATE_TYPES.length ? (
      <StatusLine tone="success">{t("stepStatus.templatesDone")}</StatusLine>
    ) : requiredSaved > 0 ? (
      <StatusLine>{t("stepStatus.templatesPartial")}</StatusLine>
    ) : (
      <StatusLine>{t("stepStatus.templatesNone")}</StatusLine>
    );

  const cap = captures[activeType];
  const templateUrl = templateUrlOf(activeType);
  const ignoreRect = effectiveIgnore(activeType);
  const activeDirty = isDirty(activeType);
  const canSave = activeDirty && !saveMutation.isPending;

  const activeName = t(`templates.name_${activeType}`);
  const stateOf = (type: TemplateType) =>
    isDirty(type)
      ? { label: t("templates.unsaved"), tone: "text-gold-text" }
      : isSaved(type)
        ? { label: t("templates.saved"), tone: "text-done-text" }
        : { label: t("templates.notSet"), tone: "text-ink-3" };

  return (
    <StepBody>
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

      <Aside
        wide
        status={activeDirty ? <StatusLine>{t("templates.dirtyHint")}</StatusLine> : status}
        footer={
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => saveMutation.mutate(activeType)}
              disabled={!canSave}
              className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-control bg-lapis text-[14px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90 disabled:cursor-default disabled:opacity-50"
            >
              {saveMutation.isPending ? (
                <BusyLabel>{t("common.saving")}</BusyLabel>
              ) : activeDirty || !hasTemplate(activeType) ? (
                t("templates.saveNamed", { label: label(activeType) })
              ) : (
                <>
                  <Check size={15} aria-hidden="true" /> {t("templates.savedBtn")}
                </>
              )}
            </button>
            <Link
              to="/mushafs/$mushafId/process"
              params={{ mushafId }}
              className="inline-flex h-11 items-center justify-center rounded-control border border-rule-2 text-[14px] font-semibold text-ink-3 no-underline transition-colors hover:bg-card hover:text-ink"
            >
              {t("templates.continueProcess")}
            </Link>
          </div>
        }
      >
        <div
          data-tour="tpl-targets"
          role="radiogroup"
          aria-label={t("templates.pickerLabel")}
          className="flex flex-col gap-1.5"
        >
          {TEMPLATE_TYPES.map((type) => {
            const url = templateUrlOf(type);
            const state = stateOf(type);
            const active = activeType === type;
            return (
              <label
                key={type}
                className={`flex cursor-pointer items-center gap-3 rounded-card border px-3 py-2.5 transition-colors ${
                  active ? "border-lapis bg-lapis-wash" : "border-rule bg-card hover:border-rule-2"
                }`}
              >
                <input
                  type="radio"
                  name="template"
                  checked={active}
                  onChange={() => selectType(type)}
                  className="h-4 w-4 flex-none cursor-pointer accent-lapis"
                />
                <span className="min-w-0 flex-1 text-[14px] font-semibold">
                  {t(`templates.name_${type}`)}
                </span>
                {/* A crop of the scan: it stays on white, as the page does. */}
                <span className="flex h-8 w-16 flex-none items-center justify-center overflow-hidden rounded-[4px] border border-rule-2 bg-white">
                  {url && <img src={url} alt="" className="max-h-full max-w-full object-contain" />}
                </span>
                <span className="flex w-[74px] flex-none flex-col items-end gap-0.5">
                  <span className={`text-[12px] font-semibold ${state.tone}`}>{state.label}</span>
                  {hasIgnore(type) && (
                    <span className="text-[11px] text-stop-text">{t("templates.ignoreChip")}</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        <section
          data-tour="tpl-capture"
          className="flex flex-col gap-3 rounded-card border border-rule bg-card p-4"
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="m-0 text-[15px] font-semibold">{activeName}</h2>
            <span className={`text-[12px] font-semibold ${stateOf(activeType).tone}`}>
              {stateOf(activeType).label}
            </span>
          </div>
          <p className="m-0 text-[12.5px] leading-normal text-ink-3">
            {t(`templates.hint_${activeType}`)}
          </p>
          <TemplatePreview mode="template" pageUrl={pageUrl} working={working} />
          <RectInputs rect={working} onChange={setWorking} max={natural} />
          {preview <= OPENING_PAGES && <WarnNote>{t("templates.openingPageWarning")}</WarnNote>}
          <button
            type="button"
            onClick={capture}
            disabled={!working || working.w < 2}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-control border border-ink text-[13.5px] font-semibold text-ink transition-colors hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-40"
          >
            {cap ? t("templates.recrop") : t("templates.capture", { label: label(activeType) })}
          </button>

          <IgnoreSection
            templateUrl={templateUrl}
            ignoreRect={ignoreRect}
            editing={editingIgnore}
            onEdit={() => setEditingIgnore(true)}
            onDone={() => {
              setEditingIgnore(false);
              if (ignores[activeType]) toast.success(t("templates.ignoreSetToast"));
            }}
            onChange={(r) => setIgnores((p) => ({ ...p, [activeType]: r ?? null }))}
            onClear={() => {
              setIgnores((p) => ({ ...p, [activeType]: null }));
              setEditingIgnore(false);
              toast.success(t("templates.ignoreCleared"));
            }}
          />
        </section>

        <WarnNote>{t("templates.openingPagesTip")}</WarnNote>
        <WarnNote>{t("templates.cropTip")}</WarnNote>
      </Aside>

      <TourOverlay tour={tour} />
    </StepBody>
  );
}

function WarnNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 flex gap-2 rounded-lg bg-warn-wash px-3.5 py-2.5 text-[12.5px] leading-normal text-warn-text">
      <TriangleAlert size={14} className="mt-0.5 flex-none" aria-hidden="true" />
      <span>{children}</span>
    </p>
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
      <p className="m-0 rounded-lg border border-rule-soft bg-sheet px-3 py-2.5 text-[12.5px] text-ink-3">
        {t("templates.captureFirstToIgnore")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-rule-soft bg-sheet p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold capitalize text-ink">
          {t("templates.ignoreLabel")}
          {ignoreRect && (
            <span className="inline-flex items-center gap-1 rounded-pill border border-done/40 bg-done/10 px-1.5 py-[1px] text-[10px] font-medium text-done-text">
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
              className="rounded-sm border border-rule-2 bg-card px-2 py-[3px] text-[11px] font-medium text-ink-2 hover:bg-sheet cursor-pointer"
            >
              {t("templates.clearIgnore")}
            </button>
          )}
          {editing ? (
            <button
              type="button"
              onClick={onDone}
              className="rounded-sm bg-lapis px-2.5 py-[3px] text-[11px] font-semibold text-on-lapis hover:bg-lapis/90 cursor-pointer"
            >
              {t("templates.ignoreDone")}
            </button>
          ) : (
            <button
              type="button"
              onClick={onEdit}
              className="rounded-sm border border-rule-2 bg-card px-2 py-[3px] text-[11px] font-medium text-lapis-text hover:bg-lapis-wash cursor-pointer"
            >
              {ignoreRect ? t("templates.editIgnoreRegion") : t("templates.addIgnoreRegion")}
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <>
          <p className="text-[10.5px] leading-snug text-ink-3">{t("templates.ignoreEditHint")}</p>
          <ZoomPane imageUrl={templateUrl} height={240}>
            <CroppableImage
              imageUrl={templateUrl}
              rect={ignoreRect}
              onRectChange={onChange}
              label={t("templates.ignoreLabel")}
              tone="red"
            />
          </ZoomPane>
        </>
      ) : ignoreRect ? (
        <ZoomPane imageUrl={templateUrl} height={240}>
          <ImageWithRedBox imageUrl={templateUrl} red={ignoreRect} />
        </ZoomPane>
      ) : (
        <p className="text-[11px] text-ink-3">{t("templates.noIgnore")}</p>
      )}
    </div>
  );
}
