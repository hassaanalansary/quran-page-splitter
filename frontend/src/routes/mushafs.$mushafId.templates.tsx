import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { MouseEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Aside, Hint } from "@/components/app/Panel";
import { PageStage } from "@/components/canvas/PageStage";
import { RectInputs } from "@/components/canvas/RectInputs";
import { TemplatePreview } from "@/components/canvas/TemplatePreview";
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

type Target = TemplateType | "sura_header_ignore" | "aya_separator_ignore";

const TEMPLATE_TYPES: TemplateType[] = ["sura_header", "aya_separator"];

function parentOf(t: Target): TemplateType | null {
  if (t === "sura_header_ignore") return "sura_header";
  if (t === "aya_separator_ignore") return "aya_separator";
  return null;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function TemplatesPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/templates" });
  const { data: mushaf } = useMushaf(mushafId);
  const { data: serverTemplates } = useTemplates(mushafId);
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();
  const label = (target: Target) => t(`templates.label_${target}`);

  const draft0 = useMemo(() => getTemplateDraft(mushafId), [mushafId]);
  const [preview, setPreview] = useState(1);
  const [activeTarget, setActiveTarget] = useState<Target>("sura_header");
  const [working, setWorking] = useState<Rect | null>(null);
  const [captures, setCaptures] = useState(draft0.captures);
  const [ignores, setIgnores] = useState(draft0.ignores);
  const [savedAt, setSavedAt] = useState(draft0.savedAt);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // Persist the draft so leaving and returning within the app keeps captures.
  useEffect(() => {
    setTemplateDraft(mushafId, { captures, ignores, savedAt });
  }, [mushafId, captures, ignores, savedAt]);

  const server = (type: TemplateType): Template | undefined =>
    serverTemplates?.find((t) => t.type === type);
  const displayUrl = (type: TemplateType): string | null =>
    captures[type]?.url ?? server(type)?.image_url ?? null;
  const isSaved = (type: TemplateType): boolean =>
    captures[type] ? !!savedAt[type] : !!server(type);

  function switchTarget(t: Target, e: MouseEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setActiveTarget(t);
    const parent = parentOf(t);
    if (!parent) {
      setWorking(captures[t as TemplateType]?.rect ?? null);
      return;
    }
    const existing = ignores[parent];
    if (existing) {
      setWorking(existing);
      return;
    }
    const pr = captures[parent]?.rect;
    setWorking(
      pr
        ? {
            x: Math.round(pr.x + pr.w * 0.35),
            y: Math.round(pr.y + pr.h * 0.3),
            w: Math.round(pr.w * 0.3),
            h: Math.round(pr.h * 0.4),
          }
        : null,
    );
  }

  async function apply() {
    if (!working || !mushaf) return;
    const parent = parentOf(activeTarget);
    if (parent) {
      const cap = captures[parent];
      if (!cap?.rect) {
        return toast.error(t("templates.recropIgnore", { label: label(parent) }));
      }
      const inside =
        working.x >= cap.rect.x &&
        working.y >= cap.rect.y &&
        working.x + working.w <= cap.rect.x + cap.rect.w &&
        working.y + working.h <= cap.rect.y + cap.rect.h;
      if (!inside) return toast.error(t("templates.ignoreInside"));
      setIgnores((p) => ({ ...p, [parent]: { ...working } }));
      toast.success(t("templates.ignoreSet"));
      return;
    }

    const type = activeTarget as TemplateType;
    try {
      const blob = await cropUrlToBlob(pageImageUrl(mushafId, preview, mushaf.updated_at), working);
      const url = URL.createObjectURL(blob);
      setCaptures((p) => {
        if (p[type]?.url) URL.revokeObjectURL(p[type]!.url);
        return { ...p, [type]: { blob, url, rect: { ...working } } };
      });
      setIgnores((p) => ({ ...p, [type]: undefined }));
      setSavedAt((p) => ({ ...p, [type]: false }));
      toast.success(t("templates.captured", { label: label(type) }));
    } catch {
      toast.error(t("templates.captureFailed"));
    }
  }

  const saveMutation = useMutation({
    mutationFn: async (type: TemplateType) => {
      const cap = captures[type];
      if (!cap) throw new Error("Nothing to save.");
      const ig = ignores[type];
      const relIgnore: Rect | null = ig
        ? { x: ig.x - cap.rect.x, y: ig.y - cap.rect.y, w: ig.w, h: ig.h }
        : null;
      await upsertTemplate(mushafId, type, { image: cap.blob, ignore: relIgnore });
      return type;
    },
    onSuccess: (type) => {
      setSavedAt((p) => ({ ...p, [type]: true }));
      queryClient.invalidateQueries({ queryKey: queryKeys.templates(mushafId) });
      toast.success(t("templates.savedTemplateToast", { label: label(type) }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("templates.saveFailed")),
  });

  if (!mushaf) return null;
  const logicalCount = mushaf.logical_page_count;
  const pageUrl = pageImageUrl(mushafId, preview, mushaf.updated_at);
  const activeParent = parentOf(activeTarget);

  let previewNode;
  if (activeParent) {
    const cap = captures[activeParent];
    const srv = server(activeParent);
    let ignoreRelative: Rect | null = null;
    if (working && cap?.rect) {
      ignoreRelative = {
        x: working.x - cap.rect.x,
        y: working.y - cap.rect.y,
        w: working.w,
        h: working.h,
      };
    } else if (srv && "x" in srv.ignore_rects) {
      ignoreRelative = srv.ignore_rects as Rect;
    }
    previewNode = (
      <TemplatePreview
        mode="ignore"
        pageUrl={pageUrl}
        working={working}
        parentLabel={label(activeParent)}
        parentImageUrl={cap?.url ?? srv?.image_url ?? null}
        ignoreRelative={ignoreRelative}
      />
    );
  } else {
    previewNode = <TemplatePreview mode="template" pageUrl={pageUrl} working={working} />;
  }

  return (
    <div
      className={`flex ${i18n.language === "ar" ? "flex-row-reverse" : "flex-row"} flex-1 overflow-hidden`}
    >
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
        crop={{ label: label(activeTarget), rect: working, onRectChange: setWorking }}
        onNatural={setNatural}
      />

      {/* Center: the active-cut workspace */}
      <div className="flex w-[400px] flex-shrink-0 flex-col gap-3 overflow-auto border-s border-border bg-white p-4">
        <div className="text-[12px] font-semibold capitalize text-text-primary">
          {label(activeTarget)}
        </div>
        {previewNode}
        <RectInputs rect={working} onChange={setWorking} max={natural} />
        <Button onClick={apply} disabled={!working || working.w < 2}>
          {activeParent
            ? t("templates.setIgnore")
            : t("templates.capture", { label: label(activeTarget) })}
        </Button>
      </div>

      {/* Right: per-target cards */}
      <Aside
        footer={
          <Button asChild variant="outline">
            <Link to="/mushafs/$mushafId/process" params={{ mushafId }}>
              {t("templates.continueProcess")}
            </Link>
          </Button>
        }
      >
        <Hint>{t("templates.intro")}</Hint>

        {TEMPLATE_TYPES.map((type) => {
          const name = t(`templates.name_${type}`);
          const hint = t(`templates.hint_${type}`);
          const url = displayUrl(type);
          const cap = captures[type];
          const dirty = !!cap && !savedAt[type];
          const saved = isSaved(type);
          const active = activeTarget === type || activeTarget === `${type}_ignore`;
          return (
            <div
              key={type}
              onClick={(e) => switchTarget(`${type}_ignore` as Target, e)}
              className={`overflow-hidden rounded-xl border bg-white p-3 ${active ? "border-orange" : "border-border"}`}
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="flex-1 text-[13px] font-semibold text-text-primary">{name}</span>
                {dirty ? (
                  <span className="text-[11px] font-medium text-orange">
                    {t("templates.unsaved")}
                  </span>
                ) : saved ? (
                  <span className="flex items-center gap-1 text-[11px] font-medium text-success">
                    <Check size={12} /> {t("templates.saved")}
                  </span>
                ) : (
                  <span className="text-[11px] text-text-muted">{t("templates.notSet")}</span>
                )}
              </div>
              <p className="mb-2 text-[11px] text-text-muted">{hint}</p>

              <div className="flex gap-3">
                <div className="flex h-16 w-24 flex-shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-bg-surface">
                  {url ? (
                    <img src={url} alt={name} className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-[10px] text-text-muted">{t("templates.noCrop")}</span>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Button
                    size="sm"
                    variant={active && !activeParent ? "default" : "outline"}
                    onClick={(e) => switchTarget(type, e)}
                  >
                    {url ? t("templates.recrop") : t("templates.cropOnPage")}
                  </Button>
                  <Button
                    size="sm"
                    variant={activeTarget === `${type}_ignore` ? "default" : "outline"}
                    onClick={(e) => switchTarget(`${type}_ignore` as Target, e)}
                    disabled={!cap?.rect}
                  >
                    {ignores[type] ? t("templates.editIgnore") : t("templates.addIgnore")}
                  </Button>
                </div>
              </div>

              <Button
                className="mt-2 w-full"
                onClick={() => saveMutation.mutate(type)}
                disabled={!cap || saveMutation.isPending}
              >
                {savedAt[type] ? (
                  <>
                    <Check size={14} /> {t("templates.savedBtn")}
                  </>
                ) : (
                  t("templates.saveNamed", { label: label(type) })
                )}
              </Button>
            </div>
          );
        })}
      </Aside>
    </div>
  );
}
