import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, PackageSearch } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { MushafStatusBadge } from "@/components/app/MushafStatusBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ApiError,
  importBundle,
  inspectBundle,
  queryKeys,
  type BundleMatch,
  type BundleSource,
  type InspectResult,
} from "@/lib/api";

/** Import a work bundle without knowing which mushaf it came from.
 *
 * A bundle is tied to one PDF by checksum, which makes the checksum a perfectly
 * good *finder* as well as the guard it already is: drop the zip here and the
 * server names the mushafs it fits. The detection is only a shortlist — the
 * import re-checks the hash against whichever one is approved here.
 */
export function ImportBundleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [detected, setDetected] = useState<InspectResult | null>(null);
  const [targetId, setTargetId] = useState("");
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setDetected(null);
      setTargetId("");
      setReplace(false);
      setError(null);
    }
  }, [open]);

  const inspect = useMutation({
    mutationFn: (chosen: File) => inspectBundle(chosen),
    onSuccess: (result) => {
      setDetected(result);
      // One candidate is the ordinary case, so preselect it. With several the
      // user chooses: the same PDF can be registered more than once on purpose.
      setTargetId(result.matches.length === 1 ? result.matches[0].id : "");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("bundle.detect.invalid")),
  });

  const target = detected?.matches.find((m) => m.id === targetId) ?? null;
  const overwrites = target?.processed_page_count ?? 0;

  const apply = useMutation({
    mutationFn: () => importBundle(target!.id, file!, replace),
    onSuccess: (result) => {
      const id = target!.id;
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.processedPages(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(id) });
      toast.success(
        t("bundle.imported", { pages: result.pages_imported, name: result.source_name }),
      );
      if (result.warnings.bounds_differ) toast.warning(t("bundle.warnBounds"));
      if (result.warnings.page_count_differs) toast.warning(t("bundle.warnPageCount"));
      onOpenChange(false);
      void navigate({ to: "/mushafs/$mushafId", params: { mushafId: id } });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("bundle.importFailed")),
  });

  function onChoose(chosen: File | null) {
    setFile(chosen);
    setDetected(null);
    setTargetId("");
    setReplace(false);
    setError(null);
    if (chosen) inspect.mutate(chosen);
  }

  const busy = inspect.isPending || apply.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("bundle.detect.title")}</DialogTitle>
          <DialogDescription>{t("bundle.detect.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto py-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bundle-zip">{t("bundle.detect.fileLabel")}</Label>
            <Input
              id="bundle-zip"
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => onChoose(e.target.files?.[0] ?? null)}
              className="cursor-pointer file:me-3 file:cursor-pointer file:rounded file:border-0 file:bg-bg-muted file:px-2 file:py-1 file:text-xs file:font-medium"
            />
            {file && (
              <span className="text-xs text-text-muted">
                {t("bundle.selected", { name: file.name, size: Math.round(file.size / 1024) })}
              </span>
            )}
          </div>

          {inspect.isPending && (
            <p className="text-[11.5px] text-text-muted">{t("bundle.detect.inspecting")}</p>
          )}

          {detected && <BundleSummary bundle={detected.bundle} />}

          {detected && detected.matches.length === 0 && (
            <div className="rounded-[10px] border border-warning-border bg-warning-bg px-3 py-2.5">
              <p className="text-[12px] font-bold text-[#8a4b0d]">
                {t("bundle.detect.noMatchTitle")}
              </p>
              <p className="mt-1 text-[11px] leading-[1.55] text-[#8a4b0d]">
                {t("bundle.detect.noMatchBody", {
                  pdf: detected.bundle.pdf_original_name || t("common.dash"),
                })}
              </p>
            </div>
          )}

          {detected && detected.matches.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
                {detected.matches.length === 1
                  ? t("bundle.detect.matchOne")
                  : t("bundle.detect.matchMany", { count: detected.matches.length })}
              </span>
              {detected.matches.map((match) => (
                <MatchRow
                  key={match.id}
                  match={match}
                  selected={match.id === targetId}
                  onSelect={() => {
                    setTargetId(match.id);
                    setReplace(false);
                    setError(null);
                  }}
                />
              ))}
            </div>
          )}

          {overwrites > 0 && (
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-2.5 py-2">
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
                className="mt-0.5 cursor-pointer"
              />
              <span className="text-[10.5px] leading-[1.5] text-[#8a4b0d]">
                <b className="block">{t("bundle.replaceLabel")}</b>
                {t("bundle.replaceWarning", { count: overwrites })}
              </span>
            </label>
          )}

          {error && (
            <div className="rounded-md border border-error-border bg-error-bg px-3 py-2 text-[11.5px] leading-[1.5] text-error">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={apply.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              setError(null);
              apply.mutate();
            }}
            disabled={!target || busy || (overwrites > 0 && !replace)}
          >
            {apply.isPending
              ? t("bundle.importing")
              : target
                ? t("bundle.detect.importInto", { name: target.name })
                : t("bundle.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the zip claims to be, so the user can recognise their own work. */
function BundleSummary({ bundle }: { bundle: BundleSource }) {
  const { t, i18n } = useTranslation();
  const exported = bundle.exported_at ? new Date(bundle.exported_at) : null;

  return (
    <div className="rounded-[10px] border border-border bg-bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <PackageSearch className="h-3.5 w-3.5 text-orange" />
        <span className="truncate text-[12.5px] font-bold text-text-primary">
          {bundle.name || t("bundle.detect.unnamed")}
        </span>
        {exported && !Number.isNaN(exported.valueOf()) && (
          <span className="ms-auto shrink-0 text-[10.5px] text-text-muted">
            {t("bundle.detect.exportedAt", { date: exported.toLocaleDateString(i18n.language) })}
          </span>
        )}
      </div>
      <dl className="mt-2 flex flex-col gap-1">
        <SummaryRow
          k={t("bundle.detect.fromPdf")}
          v={bundle.pdf_original_name || t("common.dash")}
        />
        <SummaryRow
          k={t("bundle.detect.checksum")}
          v={`${bundle.pdf_sha256.slice(0, 12) || "?"}…`}
        />
        <SummaryRow
          k={t("bundle.detect.contents")}
          v={t("bundle.detect.contentsValue", { pages: bundle.pages, lines: bundle.lines })}
        />
      </dl>
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <dt className="shrink-0 text-text-muted">{k}</dt>
      <dd className="truncate font-mono text-[10.5px] font-semibold text-text-primary">{v}</dd>
    </div>
  );
}

/** One candidate target. A radio rather than a confirm button: the same PDF may
 * back several mushafs, and only the user knows which one this work is for. */
function MatchRow({
  match,
  selected,
  onSelect,
}: {
  match: BundleMatch;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const diverges = match.bounds_differ || match.page_count_differs;

  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-[10px] border p-3 transition ${
        selected ? "border-orange bg-orange-tint" : "border-border hover:border-border-strong"
      }`}
    >
      <input
        type="radio"
        name="bundle-target"
        checked={selected}
        onChange={onSelect}
        className="mt-1 cursor-pointer"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-text-primary">{match.name}</span>
          <MushafStatusBadge mushaf={match} className="ms-auto shrink-0" />
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2.5 text-[11px] text-text-muted">
          <span>
            {t("home.pages", {
              done: match.processed_page_count,
              total: match.logical_page_count,
            })}
          </span>
          {match.qiraa && <span className="capitalize">{match.qiraa}</span>}
        </span>
        {diverges && (
          <span className="mt-1.5 flex items-start gap-1 text-[10.5px] leading-[1.5] text-[#8a4b0d]">
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
            {match.bounds_differ
              ? t("bundle.detect.boundsDiffer")
              : t("bundle.detect.pageCountDiffers")}
          </span>
        )}
      </span>
    </label>
  );
}
