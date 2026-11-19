import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { BusyLabel } from "@/components/app/SatrLoader";
import {
  DIALOG_DESTRUCTIVE,
  DIALOG_PRIMARY,
  DIALOG_SECONDARY,
  FileCard,
  SatrDialog,
} from "@/components/app/SatrDialog";
import { humanSize } from "@/components/app/details/helpers";
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
  const picker = useRef<HTMLInputElement>(null);

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
  const replacing = overwrites > 0;

  return (
    <SatrDialog
      open={open}
      onOpenChange={(next) => !apply.isPending && onOpenChange(next)}
      title={t("bundle.detect.title")}
      description={t("bundle.detect.description")}
      width={620}
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={apply.isPending}
            className={DIALOG_SECONDARY}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              apply.mutate();
            }}
            disabled={!target || busy || (replacing && !replace)}
            className={replacing ? DIALOG_DESTRUCTIVE : DIALOG_PRIMARY}
          >
            {apply.isPending ? (
              <BusyLabel>{t("bundle.importing")}</BusyLabel>
            ) : target ? (
              replacing ? (
                t("bundle.detect.replaceInto", { name: target.name })
              ) : (
                t("bundle.detect.importInto", { name: target.name })
              )
            ) : (
              t("bundle.import")
            )}
          </button>
        </>
      }
    >
      <input
        ref={picker}
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => onChoose(e.target.files?.[0] ?? null)}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      {file ? (
        <FileCard
          badge="ZIP"
          tone="lapis"
          name={file.name}
          detail={`${humanSize(file.size)} · ${t("bundle.schema")}`}
          action={
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={busy}
              className="h-9 flex-none cursor-pointer rounded-control border border-rule-2 bg-card px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-sheet disabled:cursor-default disabled:opacity-60"
            >
              {t("bundle.detect.chooseAnother")}
            </button>
          }
        />
      ) : (
        <button
          type="button"
          onClick={() => picker.current?.click()}
          className="flex h-[76px] cursor-pointer items-center justify-center gap-2.5 rounded-lg border-2 border-dashed border-rule-2 bg-sheet text-[14px] font-semibold text-ink-2 transition-colors hover:border-lapis hover:text-lapis-text"
        >
          <FileUp className="h-[18px] w-[18px]" aria-hidden="true" />
          {t("bundle.chooseFile")}
        </button>
      )}

      {inspect.isPending && (
        <p className="m-0 text-[13px] text-ink-3">
          <BusyLabel>{t("bundle.detect.inspecting")}</BusyLabel>
        </p>
      )}

      {detected && <BundleSummary bundle={detected.bundle} />}

      {detected && detected.matches.length === 0 && (
        <Warning
          title={t("bundle.detect.noMatchTitle")}
          body={t("bundle.detect.noMatchBody", {
            pdf: detected.bundle.pdf_original_name || t("common.dash"),
          })}
        />
      )}

      {detected && detected.matches.length > 0 && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="pb-2 text-[13px] font-semibold text-ink-2">
            {detected.matches.length === 1
              ? t("bundle.detect.matchOne")
              : t("bundle.detect.matchMany", { count: detected.matches.length })}
          </legend>
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
        </fieldset>
      )}

      {target && replacing && (
        <div className="flex flex-col gap-2.5 rounded-[10px] bg-stop-wash px-4 py-3.5 text-stop-text">
          <label className="flex cursor-pointer items-center gap-2.5 text-[14px] font-semibold">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
              className="h-[18px] w-[18px] cursor-pointer accent-stop"
            />
            {t("bundle.replaceLabel")}
          </label>
          <span className="text-[13.5px] leading-normal">
            {t("bundle.detect.replaceBody", {
              name: target.name,
              count: overwrites,
              pages: detected?.bundle.pages ?? 0,
            })}
          </span>
        </div>
      )}

      {target && (target.bounds_differ || target.page_count_differs) && (
        <Warning
          body={[
            target.bounds_differ ? t("bundle.detect.boundsDiffer") : null,
            target.page_count_differs ? t("bundle.detect.pageCountDiffers") : null,
            t("bundle.detect.checkMapping"),
          ]
            .filter(Boolean)
            .join(" ")}
        />
      )}

      {error && (
        <div className="rounded-lg border border-stop/20 bg-stop-wash px-3.5 py-2.5 text-[13.5px] leading-normal text-stop-text">
          {error}
        </div>
      )}
    </SatrDialog>
  );
}

function Warning({ title, body }: { title?: string; body: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-warn-wash px-3.5 py-[11px] text-[13.5px] leading-[1.45] text-warn-text">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
      <span>
        {title && <strong className="block">{title}</strong>}
        {body}
      </span>
    </div>
  );
}

/** "3f9c 7a20 … e14b a21b": enough of the checksum to recognise, not to read. */
function shortChecksum(sha: string): string {
  if (sha.length < 16) return sha || "?";
  return `${sha.slice(0, 4)} ${sha.slice(4, 8)} … ${sha.slice(-8, -4)} ${sha.slice(-4)}`;
}

/** What the zip claims to be, so the user can recognise their own work. */
function BundleSummary({ bundle }: { bundle: BundleSource }) {
  const { t, i18n } = useTranslation();
  const exported = bundle.exported_at ? new Date(bundle.exported_at) : null;
  const rows: [string, string, boolean?][] = [
    [t("bundle.detect.mushafName"), bundle.name || t("bundle.detect.unnamed")],
    [t("bundle.detect.fromPdf"), bundle.pdf_original_name || t("common.dash")],
    [t("bundle.detect.checksum"), shortChecksum(bundle.pdf_sha256), true],
    [
      t("bundle.detect.contents"),
      t("bundle.detect.contentsValue", { pages: bundle.pages, lines: bundle.lines }),
    ],
  ];
  if (exported && !Number.isNaN(exported.valueOf())) {
    rows.push([
      t("bundle.detect.exported"),
      exported.toLocaleString(`${i18n.language}-u-nu-latn`, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    ]);
  }

  return (
    <dl className="m-0 grid grid-cols-[130px_1fr] gap-x-4 gap-y-[9px] px-0.5 py-1 text-[14px]">
      {rows.map(([label, value, mono]) => (
        <div key={label} className="contents">
          <dt className="text-ink-3">{label}</dt>
          <dd className={`m-0 min-w-0 truncate ${mono ? "font-mono text-[13px]" : "font-medium"}`}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
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
  const detail = t("bundle.detect.matchDetail", {
    pages: match.logical_page_count,
    processed: match.processed_page_count,
    reviewed: match.reviewed_page_count,
  });

  return (
    <label
      className={`flex cursor-pointer items-center gap-3.5 rounded-[10px] px-4 py-3.5 transition ${
        selected ? "border-2 border-lapis bg-lapis-wash" : "border border-rule hover:border-rule-2"
      }`}
    >
      <input
        type="radio"
        name="bundle-target"
        checked={selected}
        onChange={onSelect}
        className="h-[18px] w-[18px] flex-none cursor-pointer accent-lapis"
      />
      <span className="h-[46px] w-[34px] flex-none overflow-hidden bg-page shadow-[0_2px_6px_rgba(0,0,0,0.2)]">
        {match.thumbnail_url && (
          <img
            src={match.thumbnail_url}
            alt=""
            draggable={false}
            className="h-full w-full object-cover object-top"
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-semibold text-ink">{match.name}</span>
        <span className="text-[13px] text-ink-2">
          {match.qiraa ? (
            <>
              <span className="capitalize">{match.qiraa}</span> · {detail}
            </>
          ) : (
            detail
          )}
        </span>
      </span>
    </label>
  );
}
