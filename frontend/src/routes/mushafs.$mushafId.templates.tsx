import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Aside, Hint, PanelCard } from "@/components/app/Panel";
import { CropPreview } from "@/components/canvas/CropPreview";
import { FilmstripViewer } from "@/components/canvas/FilmstripViewer";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  pageImageUrl,
  upsertTemplate,
  useMushaf,
  type Rect,
  type TemplateType,
} from "@/lib/api";
import { cropUrlToBlob } from "@/lib/image";

export const Route = createFileRoute("/mushafs/$mushafId/templates")({ component: TemplatesPage });

type Target = TemplateType | "sura_header_ignore" | "aya_separator_ignore";

const TEMPLATES: { type: TemplateType; label: string; hint: string }[] = [
  { type: "sura_header", label: "Sura header", hint: "The ornamental sura-title band." },
  { type: "aya_separator", label: "Aya separator", hint: "A single end-of-aya marker (۝)." },
];

type Capture = { blob: Blob; url: string; rect: Rect };

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

  const [preview, setPreview] = useState(1);
  const [activeTarget, setActiveTarget] = useState<Target>("sura_header");
  const [working, setWorking] = useState<Rect | null>(null);
  const [captures, setCaptures] = useState<Partial<Record<TemplateType, Capture>>>({});
  const [ignores, setIgnores] = useState<Partial<Record<TemplateType, Rect>>>({});
  const [savedAt, setSavedAt] = useState<Partial<Record<TemplateType, boolean>>>({});

  const urlsRef = useRef<string[]>([]);
  useEffect(() => () => urlsRef.current.forEach((u) => URL.revokeObjectURL(u)), []);

  function switchTarget(t: Target) {
    setActiveTarget(t);
    const parent = parentOf(t);
    setWorking(parent ? (ignores[parent] ?? null) : (captures[t as TemplateType]?.rect ?? null));
  }

  async function apply() {
    if (!working || !mushaf) return;
    const parent = parentOf(activeTarget);
    if (parent) {
      const tpl = captures[parent];
      if (!tpl) return toast.error(`Crop the ${parent.replace("_", " ")} first.`);
      const inside =
        working.x >= tpl.rect.x &&
        working.y >= tpl.rect.y &&
        working.x + working.w <= tpl.rect.x + tpl.rect.w &&
        working.y + working.h <= tpl.rect.y + tpl.rect.h;
      if (!inside) return toast.error("The ignore region must sit inside the template crop.");
      setIgnores((p) => ({ ...p, [parent]: { ...working } }));
      toast.success("Ignore region set.");
      return;
    }

    const type = activeTarget as TemplateType;
    try {
      const blob = await cropUrlToBlob(pageImageUrl(mushafId, preview, mushaf.updated_at), working);
      const url = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      setCaptures((p) => {
        if (p[type]?.url) URL.revokeObjectURL(p[type]!.url);
        return { ...p, [type]: { blob, url, rect: { ...working } } };
      });
      setIgnores((p) => ({ ...p, [type]: undefined }));
      setSavedAt((p) => ({ ...p, [type]: false }));
      toast.success(`${type.replace("_", " ")} captured.`);
    } catch {
      toast.error("Failed to capture crop from the page.");
    }
  }

  const saveMutation = useMutation({
    mutationFn: async (type: TemplateType) => {
      const cap = captures[type]!;
      const ignoreRect = ignores[type];
      const relIgnore: Rect | null = ignoreRect
        ? {
            x: ignoreRect.x - cap.rect.x,
            y: ignoreRect.y - cap.rect.y,
            w: ignoreRect.w,
            h: ignoreRect.h,
          }
        : null;
      await upsertTemplate(mushafId, type, { image: cap.blob, ignore: relIgnore });
      return type;
    },
    onSuccess: (type) => {
      setSavedAt((p) => ({ ...p, [type]: true }));
      toast.success(`Saved ${type.replace("_", " ")} template.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to save template."),
  });

  if (!mushaf) return null;
  const logicalCount = mushaf.logical_page_count;

  return (
    <div className="flex flex-1 overflow-hidden">
      <FilmstripViewer
        mushafId={mushafId}
        pageCount={logicalCount}
        page={preview}
        onPageChange={(n) => setPreview(clamp(n, 1, logicalCount))}
        version={mushaf.updated_at}
        renderLabel={(logical) =>
          `PDF page ${mushaf.first_quran_pdf_page + logical - 1} of ${mushaf.pdf_page_count}`
        }
        crop={{ label: activeTarget, rect: working, onRectChange: setWorking }}
      />

      <Aside
        footer={
          <Button asChild variant="outline">
            <Link to="/mushafs/$mushafId/process" params={{ mushafId }}>
              Continue to Process →
            </Link>
          </Button>
        }
      >
        <Hint>
          Navigate (Prev/Next) to a page that clearly shows each element — a{" "}
          <strong>sura header</strong> band and an <strong>aya separator</strong> (۝) — draw a tight
          crop, then <strong>Capture</strong> and <strong>Save</strong>. Templates are matched
          against every page during processing.
        </Hint>

        <PanelCard title="Selection preview">
          <CropPreview
            imageUrl={pageImageUrl(mushafId, preview, mushaf.updated_at)}
            rect={working}
            caption={`Drawing: ${activeTarget.replace(/_/g, " ")}`}
          />
          <Button onClick={apply} disabled={!working || working.w < 2}>
            {parentOf(activeTarget)
              ? "Set ignore region"
              : `Capture ${activeTarget.replace(/_/g, " ")}`}
          </Button>
        </PanelCard>

        {TEMPLATES.map(({ type, label, hint }) => {
          const cap = captures[type];
          const ignore = ignores[type];
          const saved = savedAt[type];
          return (
            <PanelCard key={type} title={label}>
              <p className="text-[12px] text-text-muted">{hint}</p>

              <div className="flex items-center gap-3">
                <div className="flex h-16 w-24 items-center justify-center overflow-hidden rounded border border-border bg-bg-surface">
                  {cap ? (
                    <img
                      src={cap.url}
                      alt={label}
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-[10px] text-text-muted">no crop</span>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Button
                    size="sm"
                    variant={activeTarget === type ? "default" : "outline"}
                    onClick={() => switchTarget(type)}
                  >
                    {cap ? "Re-crop" : "Crop on page"}
                  </Button>
                  <Button
                    size="sm"
                    variant={activeTarget === `${type}_ignore` ? "default" : "outline"}
                    onClick={() => switchTarget(`${type}_ignore` as Target)}
                    disabled={!cap}
                  >
                    {ignore ? "Edit ignore region" : "Add ignore region"}
                  </Button>
                </div>
              </div>

              <Button
                onClick={() => saveMutation.mutate(type)}
                disabled={!cap || saveMutation.isPending}
              >
                {saved ? (
                  <>
                    <Check size={14} /> Saved
                  </>
                ) : (
                  `Save ${label.toLowerCase()} template`
                )}
              </Button>
            </PanelCard>
          );
        })}
      </Aside>
    </div>
  );
}
