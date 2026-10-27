import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { LoadingState } from "@/components/app/SatrLoader";
import {
  calibrationKeys,
  setCalibrationSettings,
  setLibraryCheck,
  useCalibrationLibrary,
  useLibraryMembers,
} from "@/lib/api";
import type {
  CalibrationBlob,
  CalibrationLine,
  CalibrationSettings,
  LibraryCompare,
  LibraryGroup,
  LibraryKind,
  LibraryShape,
} from "@/lib/calibration/types";
import { revealInScroller } from "@/lib/reveal";

import { BlobCrop } from "./BlobDetails";
import { GALLERY_ZOOMS, InkCell } from "./InkCell";
import { useTypeName } from "./labels";
import { subtypeGlyph } from "./subtypes";

/** The fingerprint library's LIMIT is refused above this — the server's `LIMIT_CEILING`. */
const LIMIT_CEILING = 10;
/** Where the last look at a mushaf's library is kept, for "new since you last looked". */
const seenKey = (mushafId: string) => `qps.library.seen.${mushafId}`;

const SMALL =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-control border border-rule-2 bg-card px-2.5 text-[12.5px] font-semibold text-ink transition-colors hover:bg-sheet disabled:cursor-default disabled:opacity-50";

/** Where the Library was when a source was opened: what to come back to. */
export type LibraryPlace = { group: string | null; scroll: number };

/**
 * The fingerprint library, as the page on screen sees it: every other confirmed
 * page's examples, kind by kind — each mark type, the untyped marks, then the letters
 * (folded; smallest ink first, since a mark learned as a letter is small).
 *
 *     limit [0.27] Preview · as page 15 sees it · 14 pages
 *     selected  p15 l4 · blob 37 → mark · kasra 0.31 ★ · runner-up fatha 0.58
 *     this page [0.29] [0.44]
 *     fatha  ×20 ×3 ×1 …        a fingerprint, how many it stands for
 *       ▸ the one chosen: its members kept beside it, all of them on demand
 *
 * Nothing here changes the library: a wrong fingerprint is a wrong label on its page,
 * fixed there — "Open its source". With a blob selected on the page, every cell says
 * how far it is from it and each kind is ordered nearest first.
 */
export function LibraryView({
  mushafId,
  page,
  settings,
  selected,
  compare,
  previewLimit,
  onPreviewLimit,
  zoom,
  onZoom,
  scroller,
  restore,
  onOpenSource,
}: {
  mushafId: string;
  page: number;
  settings: CalibrationSettings | undefined;
  /** The one blob selected on the page, pinned at the top with its answer. */
  selected: { line: CalibrationLine; blob: CalibrationBlob } | null;
  compare: { data: LibraryCompare | null; loading: boolean } | null;
  /** A LIMIT being previewed: the library rebuilt at it, nothing saved. */
  previewLimit: number | null;
  onPreviewLimit: (limit: number | null) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  scroller: RefObject<HTMLDivElement | null>;
  /** Where to come back to, after a source was opened from here. */
  restore: LibraryPlace | null;
  onOpenSource: (shape: LibraryShape, place: LibraryPlace) => void;
}) {
  const { t, i18n } = useTranslation();
  const typeName = useTypeName();
  const client = useQueryClient();

  const saved = useCalibrationLibrary(mushafId, page, null, true);
  const previewed = useCalibrationLibrary(mushafId, page, previewLimit, previewLimit !== null);
  const library = previewLimit !== null ? previewed.data : saved.data;
  const loading = previewLimit !== null ? previewed.isLoading : saved.isLoading;
  const failure = (previewLimit !== null ? previewed.error : saved.error) as Error | null;

  const [limitDraft, setLimitDraft] = useState(() => String(settings?.limit ?? ""));
  const [chosen, setChosen] = useState<{ group: string; shape: LibraryShape } | null>(null);
  const [lettersOpen, setLettersOpen] = useState(false);
  const [listed, setListed] = useState<string | null>(null);
  const members = useLibraryMembers(mushafId, page, listed, previewLimit);

  // New since the last look: when that was is kept in the browser, per mushaf. Losing
  // it only means every example shows as new once.
  const [seen] = useState<number | null>(() => {
    try {
      const value = localStorage.getItem(seenKey(mushafId));
      return value ? Date.parse(value) : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(seenKey(mushafId), new Date().toISOString());
    } catch {
      // Private window or blocked storage: nothing shows as seen, which is harmless.
    }
  }, [mushafId]);
  const isNew = (shape: LibraryShape) =>
    !!shape.confirmed_at && (seen === null || Date.parse(shape.confirmed_at) > seen);

  const limitMutation = useMutation({
    mutationFn: (limit: number | null) =>
      setCalibrationSettings(mushafId, settings!.revision, {
        experimental: settings!.experimental,
        limit,
      }),
    onSuccess: (next) => {
      setLimitDraft(String(next.limit));
      onPreviewLimit(null);
      void client.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, page) });
      void client.invalidateQueries({ queryKey: calibrationKeys.libraries(mushafId) });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const checkMutation = useMutation({
    mutationFn: ({ shape, kind }: { shape: LibraryShape; kind: LibraryKind | null }) =>
      setLibraryCheck(
        mushafId,
        shape,
        kind && !shape.looks_right ? { role: kind.role, subtype: kind.subtype } : null,
      ),
    onSuccess: () => {
      setChosen((current) =>
        current
          ? { ...current, shape: { ...current.shape, looks_right: !current.shape.looks_right } }
          : current,
      );
      void client.invalidateQueries({ queryKey: calibrationKeys.libraries(mushafId) });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const typedLimit = Number(limitDraft);
  const limitValid =
    limitDraft.trim() !== "" &&
    Number.isFinite(typedLimit) &&
    typedLimit > 0 &&
    typedLimit <= LIMIT_CEILING;

  // With a blob selected: each kind nearest first, the kinds by their nearest, the
  // letters still last — and opened when a letter is what answers.
  const distances = compare?.data?.distances ?? null;
  const far = (shape: LibraryShape) => distances?.[shape.key] ?? Infinity;
  const kinds = useMemo(() => {
    if (!library) return [];
    if (!distances) return library.kinds;
    const sorted = library.kinds.map((kind) => ({
      ...kind,
      groups: [...kind.groups].sort((a, b) => far(a.fingerprint) - far(b.fingerprint)),
    }));
    const nearest = (kind: LibraryKind) =>
      kind.groups.length ? far(kind.groups[0].fingerprint) : Infinity;
    return sorted.sort(
      (a, b) => Number(a.role === "body") - Number(b.role === "body") || nearest(a) - nearest(b),
    );
    // `far` reads `distances`, which is in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, distances]);
  const answeredByLetter = compare?.data?.answer?.role === "body";
  useEffect(() => {
    if (answeredByLetter) setLettersOpen(true);
  }, [answeredByLetter]);

  // Coming back from a source: the same fingerprint chosen, the same scroll.
  const restored = useRef(false);
  useEffect(() => {
    if (!restore || restored.current || !library) return;
    restored.current = true;
    const group = library.kinds
      .flatMap((kind) => kind.groups)
      .find((candidate) => candidate.id === restore.group);
    if (group) {
      setChosen({ group: group.id, shape: group.fingerprint });
      if (library.kinds.some((kind) => kind.role === "body" && kind.groups.includes(group)))
        setLettersOpen(true);
    }
    requestAnimationFrame(() => {
      if (scroller.current) scroller.current.scrollTop = restore.scroll;
    });
  }, [restore, library, scroller]);

  // The keys: ← onward and → back through the fingerprints (rows run right to left,
  // as the page does), ↓ ↑ by kind, Enter opens the chosen one's source.
  const visible = kinds.filter((kind) => kind.role !== "body" || lettersOpen);
  const place = (): LibraryPlace => ({
    group: chosen?.group ?? null,
    scroll: scroller.current?.scrollTop ?? 0,
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName ?? "";
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tag) || event.ctrlKey || event.metaKey) return;
      const cells = visible.flatMap((kind, row) => kind.groups.map((group) => ({ group, row })));
      if (!cells.length) return;
      const at = cells.findIndex((cell) => cell.group.id === chosen?.group);
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = at < 0 ? 0 : Math.min(cells.length - 1, at + 1);
      else if (event.key === "ArrowRight") next = at < 0 ? 0 : Math.max(0, at - 1);
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const row = at < 0 ? -1 : cells[at].row;
        const target = event.key === "ArrowDown" ? row + 1 : Math.max(0, row - 1);
        const found = cells.findIndex((cell) => cell.row === target);
        next = found < 0 ? at : found;
      } else if (event.key === "Enter" && chosen) {
        event.preventDefault();
        onOpenSource(chosen.shape, place());
        return;
      } else return;
      event.preventDefault();
      if (next === null || next < 0) return;
      const group = cells[next].group;
      setChosen({ group: group.id, shape: group.fingerprint });
      requestAnimationFrame(() =>
        revealInScroller(
          scroller.current,
          scroller.current?.querySelector<HTMLElement>(
            `[data-gallery="${CSS.escape(group.fingerprint.key)}"]`,
          ),
          { margin: 24 },
        ),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const kindName = (kind: LibraryKind) =>
    kind.role === "body"
      ? t("calibration.library.letters")
      : kind.subtype
        ? typeName(kind.subtype)
        : t("calibration.library.untypedMarks");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <LoadingState className="text-[12.5px] text-ink-3">
          {t("calibration.library.loading")}
        </LoadingState>
      </div>
    );
  }
  if (failure || !library) {
    return (
      <p role="alert" className="p-8 text-center text-[13px] text-stop-text">
        {failure?.message ?? t("calibration.library.loading")}
      </p>
    );
  }

  const type = compare?.data?.type ?? null;
  const winner = (kind: LibraryKind) =>
    kind.role === "mark" && !!type && kind.subtype === type.subtype;
  const runnerUp = (kind: LibraryKind) =>
    kind.role === "mark" && !!type?.runner_up && kind.subtype === type.runner_up;
  const older =
    library.draft_pages !== null &&
    (library.draft_pages.length !== library.pages.length ||
      library.draft_pages.some((n) => !library.pages.includes(n)));
  const changes =
    library.preview && saved.data
      ? library.kinds
          .map((kind) => {
            const before = saved.data.kinds.find(
              (other) => other.role === kind.role && other.subtype === kind.subtype,
            );
            return { kind, delta: kind.groups.length - (before?.groups.length ?? 0) };
          })
          .filter((change) => change.delta !== 0)
      : [];

  const cell = (kind: LibraryKind, group: LibraryGroup, shape: LibraryShape, count?: number) => {
    const distance = distances?.[shape.key];
    // The nearest fingerprint of its kind, with a blob selected: ★ for the type that
    // answers, ² for the runner-up.
    const first = count !== undefined && !!distances && kind.groups[0]?.id === group.id;
    const title = [
      `${kindName(kind)}${count && count > 1 ? ` · ×${count}` : ""}`,
      t("calibration.library.from", { page: shape.page_number, line: shape.line_number }),
      distance !== undefined
        ? t("calibration.library.distance", { distance: distance.toFixed(2) })
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return (
      <InkCell
        key={shape.key}
        data={shape.key}
        imageUrl={shape.image_url}
        imageSize={shape.image_size}
        crop={shape.crop}
        zoom={zoom}
        ring={chosen?.shape.key === shape.key ? "chosen" : first && winner(kind) ? "gold" : null}
        title={title}
        onClick={() => setChosen({ group: group.id, shape })}
        onOpen={() => onOpenSource(shape, place())}
      >
        {count !== undefined && count > 1 && (
          <Badge className="start-0 top-0 bg-ink/75 text-paper">×{count}</Badge>
        )}
        {isNew(shape) && (
          <span
            className="absolute end-1 top-1 h-2 w-2 rounded-full bg-gold"
            title={t("calibration.library.new")}
          />
        )}
        {shape.looks_right && (
          <Badge className="bottom-0 start-0 bg-done text-on-done">
            <Check size={10} aria-hidden="true" />
          </Badge>
        )}
        {distance !== undefined && (
          <Badge className="bottom-0 end-0 bg-card/90 font-mono text-ink-2">
            {first && winner(kind) ? "★ " : first && runnerUp(kind) ? "² " : ""}
            {distance.toFixed(2)}
          </Badge>
        )}
      </InkCell>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      {/* Which library this is, and its LIMIT. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[13px] text-ink-2">
          {library.pages.length
            ? t("calibration.library.asSeen", { page, count: library.pages.length })
            : t("calibration.library.nothingConfirmed")}
          {library.left_out !== null && ` · ${t("calibration.library.leftOut", { page })}`}
        </span>
        <span className="font-mono text-[12px] text-ink-3">
          {t("calibration.library.counts", {
            fingerprints: library.fingerprints,
            examples: library.examples,
          })}
        </span>
        <span className="ms-auto flex flex-wrap items-center gap-1.5">
          <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
            {t("calibration.libraryLimit")}
            <input
              type="number"
              inputMode="decimal"
              step={0.01}
              min={0.01}
              max={LIMIT_CEILING}
              value={limitDraft}
              aria-invalid={!limitValid}
              onChange={(event) => setLimitDraft(event.target.value)}
              className="h-8 w-20 rounded-control border border-rule-2 bg-card px-2 font-mono text-[13px] text-ink outline-none focus:border-lapis aria-[invalid=true]:border-stop"
            />
          </label>
          <button
            type="button"
            className={SMALL}
            disabled={!limitValid || typedLimit === library.saved_limit}
            onClick={() => onPreviewLimit(typedLimit)}
            title={t("calibration.library.previewHelp")}
          >
            {t("calibration.library.preview")}
          </button>
          <button
            type="button"
            className={`${SMALL} border-transparent bg-transparent text-ink-2`}
            disabled={
              !settings || limitMutation.isPending || library.saved_limit === library.default_limit
            }
            onClick={() => limitMutation.mutate(null)}
          >
            {t("calibration.defaultLimit")}
          </button>
          <label className="ms-2 flex items-center gap-1.5 text-[12px] text-ink-2">
            {t("calibration.gallery.zoom")}
            <select
              className="h-8 rounded-control border border-rule-2 bg-card px-1.5 text-[12px]"
              value={zoom}
              onChange={(event) => onZoom(Number(event.target.value))}
            >
              {GALLERY_ZOOMS.map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </label>
        </span>
      </div>
      <p className="-mt-2 m-0 text-[12px] leading-snug text-ink-3">
        {t("calibration.libraryLimitHelp", { value: library.default_limit })}
      </p>

      {older && library.draft_pages && (
        <p className="m-0 rounded-control bg-sunk px-3 py-2 text-[12.5px] leading-snug text-ink-2">
          {t("calibration.library.older", {
            then: library.draft_pages.length,
            now: library.pages.length,
          })}
        </p>
      )}

      {library.preview && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border-s-4 border-gold bg-gold-wash px-3.5 py-2.5"
        >
          <span className="min-w-[220px] flex-1 text-[12.5px] leading-snug text-ink">
            <strong>{t("calibration.library.previewing", { limit: library.limit })}</strong>
            {saved.data && (
              <>
                {" · "}
                {t("calibration.library.previewFingerprints", {
                  delta: signed(library.fingerprints - saved.data.fingerprints),
                })}
                {changes.map(({ kind, delta }) => ` · ${kindName(kind)} ${signed(delta)}`).join("")}
              </>
            )}
          </span>
          <button
            type="button"
            className={`${SMALL} border-lapis bg-lapis text-on-lapis hover:bg-lapis/90`}
            disabled={!settings || limitMutation.isPending}
            onClick={() =>
              limitMutation.mutate(library.limit === library.default_limit ? null : library.limit)
            }
          >
            {t("calibration.applyLimit")}
          </button>
          <button
            type="button"
            className={SMALL}
            onClick={() => {
              onPreviewLimit(null);
              setLimitDraft(String(library.saved_limit));
            }}
          >
            {t("calibration.library.discard")}
          </button>
        </div>
      )}

      {/* The blob selected on the page, and what the library answers for it. */}
      {selected && (
        <section className="flex flex-col gap-2.5 rounded-card border border-lapis/40 bg-lapis-wash p-3">
          <div className="flex flex-wrap items-center gap-3">
            {selected.line.image_url && (
              <BlobCrop
                url={selected.line.image_url}
                x={selected.blob.x - selected.line.bbox.x}
                y={selected.blob.y - selected.line.bbox.y}
                w={selected.blob.w}
                h={selected.blob.h}
                box={48}
              />
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px] leading-snug">
              <span className="font-mono text-[12px] text-ink-3">
                {t("calibration.library.selected", {
                  page,
                  line: selected.line.line_number,
                  id: selected.blob.id,
                })}
              </span>
              {!compare || (compare.loading && !compare.data) ? (
                <span className="text-ink-3">{t("calibration.library.asking")}</span>
              ) : !compare.data?.answer ? (
                <span className="text-ink-3">{t("calibration.library.nothingYet")}</span>
              ) : (
                <span className="text-ink">
                  <strong>{t(`calibration.role.${compare.data.answer.role}`)}</strong>
                  <span className="font-mono text-[12px] text-ink-3">
                    {" · "}
                    {t("calibration.library.nearestMark", {
                      distance: compare.data.answer.nearest_mark.toFixed(2),
                    })}
                    {" · "}
                    {t("calibration.library.nearestLetter", {
                      distance: compare.data.answer.nearest_letter.toFixed(2),
                    })}
                  </span>
                  {type && (
                    <>
                      {" · "}
                      <span dir="rtl" className="font-quran text-mark-text">
                        {subtypeGlyph(type.subtype)}
                      </span>{" "}
                      <strong>{typeName(type.subtype)}</strong>
                      {type.sure && " ★"}{" "}
                      <span className="font-mono text-[12px] text-ink-3">
                        {type.distance?.toFixed(2)}
                      </span>
                      {type.runner_up &&
                        ` · ${t("calibration.library.runnerUp", {
                          type: typeName(type.runner_up),
                          distance: type.runner_distance?.toFixed(2) ?? "—",
                        })}`}
                    </>
                  )}
                </span>
              )}
            </span>
          </div>
          {!!compare?.data?.own.length && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-ink-2">
                {t("calibration.library.thisPage")}
              </span>
              <div dir="rtl" className="flex flex-wrap items-end gap-1.5">
                {compare.data.own.map((shape) => (
                  <InkCell
                    key={shape.key}
                    imageUrl={shape.image_url}
                    imageSize={shape.image_size}
                    crop={shape.crop}
                    zoom={zoom}
                    settled={false}
                    title={`${typeName(shape.subtype)}\n${t("calibration.library.distance", {
                      distance: shape.distance.toFixed(2),
                    })}`}
                  >
                    <Badge className="bottom-0 end-0 bg-card/90 font-mono text-ink-2">
                      {shape.distance.toFixed(2)}
                    </Badge>
                    <Badge className="start-0 top-0 bg-card/90 text-mark-text">
                      <span dir="rtl" className="font-quran">
                        {subtypeGlyph(shape.subtype)}
                      </span>
                    </Badge>
                  </InkCell>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {library.kinds.length === 0 && (
        <p className="m-0 text-[12.5px] text-ink-3">{t("calibration.library.empty")}</p>
      )}

      {kinds.map((kind) => {
        const open = kind.role !== "body" || lettersOpen;
        const group = kind.groups.find((candidate) => candidate.id === chosen?.group) ?? null;
        return (
          <section key={`${kind.role}:${kind.subtype}`} className="flex flex-col gap-2">
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule bg-well/95 py-1.5 backdrop-blur-sm">
              <span className="text-[13px] font-semibold text-ink">
                {kind.role === "mark" && kind.subtype && (
                  <span dir="rtl" className="me-1 font-quran text-[16px] text-mark-text">
                    {subtypeGlyph(kind.subtype)}
                  </span>
                )}
                {kindName(kind)}
              </span>
              <span className="text-[11.5px] tabular-nums text-ink-3">
                {t("calibration.library.kindCount", {
                  count: kind.groups.length,
                  examples: kind.examples,
                })}
              </span>
              {kind.role === "body" && (
                <button
                  type="button"
                  className={`${SMALL} h-7`}
                  aria-expanded={lettersOpen}
                  onClick={() => setLettersOpen((value) => !value)}
                >
                  {lettersOpen
                    ? t("calibration.library.hideLetters")
                    : t("calibration.library.showLetters")}
                </button>
              )}
            </div>
            {open && (
              <div dir="rtl" className="flex flex-wrap items-end gap-1.5">
                {kind.groups.map((item) => cell(kind, item, item.fingerprint, item.count))}
              </div>
            )}
            {open && group && chosen && (
              <GroupDetail
                kindName={kindName(kind)}
                group={group}
                shape={chosen.shape}
                language={i18n.language}
                members={listed === group.id ? members : null}
                onList={() => setListed(listed === group.id ? null : group.id)}
                onCheck={() => checkMutation.mutate({ shape: chosen.shape, kind })}
                checking={checkMutation.isPending}
                onOpenSource={() => onOpenSource(chosen.shape, place())}
                cell={(shape) => cell(kind, group, shape)}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

/** The chosen fingerprint — or one of its members — and the rest of its group. */
function GroupDetail({
  kindName,
  group,
  shape,
  language,
  members,
  onList,
  onCheck,
  checking,
  onOpenSource,
  cell,
}: {
  kindName: string;
  group: LibraryGroup;
  shape: LibraryShape;
  language: string;
  members: ReturnType<typeof useLibraryMembers> | null;
  onList: () => void;
  onCheck: () => void;
  checking: boolean;
  onOpenSource: () => void;
  cell: (shape: LibraryShape) => ReactNode;
}) {
  const { t } = useTranslation();
  const isFingerprint = shape.key === group.fingerprint.key;
  return (
    <div className="flex flex-col gap-3 rounded-card border border-rule bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <BlobCrop url={shape.image_url} {...shape.crop} box={84} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-[14px]">
            {isFingerprint
              ? t("calibration.library.fingerprintOf", { kind: kindName, count: group.count })
              : t("calibration.library.memberOf", { kind: kindName })}
          </strong>
          <span className="font-mono text-[12px] text-ink-3">
            {t("calibration.library.from", { page: shape.page_number, line: shape.line_number })}
            {shape.confirmed_at &&
              ` · ${t("calibration.library.confirmedOn", {
                date: new Date(shape.confirmed_at).toLocaleDateString(language),
              })}`}
            {!isFingerprint &&
              shape.distance !== undefined &&
              ` · ${t("calibration.library.toFingerprint", { distance: shape.distance.toFixed(2) })}`}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={shape.looks_right}
            disabled={checking}
            onClick={onCheck}
            title={t("calibration.library.looksRightHelp")}
            className={`${SMALL} ${shape.looks_right ? "border-done bg-done text-on-done hover:bg-done/90" : ""}`}
          >
            <Check size={14} aria-hidden="true" />
            {t("calibration.library.looksRight")}
          </button>
          <button
            type="button"
            onClick={onOpenSource}
            className={`${SMALL} border-lapis bg-lapis text-on-lapis hover:bg-lapis/90`}
          >
            <ExternalLink size={14} aria-hidden="true" />
            {t("calibration.library.openSource")}
          </button>
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold text-ink-2">
          {group.kept.length
            ? t("calibration.library.kept", { count: group.kept.length })
            : t("calibration.library.keptNone")}
        </span>
        {group.kept.length > 0 && (
          <div dir="rtl" className="flex flex-wrap items-end gap-1.5">
            {cell(group.fingerprint)}
            {group.kept.map((member) => cell(member))}
          </div>
        )}
        {group.count > 1 && (
          <button type="button" className={`${SMALL} self-start`} onClick={onList}>
            {members
              ? t("calibration.library.hideAll")
              : t("calibration.library.showAll", { count: group.count })}
          </button>
        )}
        {members &&
          (members.isLoading ? (
            <span className="text-[12px] text-ink-3">{t("calibration.library.loading")}</span>
          ) : members.data ? (
            <>
              <span className="text-[12px] text-ink-3">
                {t("calibration.library.allFarthest", {
                  shown: members.data.members.length,
                  count: members.data.total,
                })}
              </span>
              <div dir="rtl" className="flex flex-wrap items-end gap-1.5">
                {members.data.members.map((member) => cell(member))}
              </div>
            </>
          ) : null)}
      </div>
    </div>
  );
}

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span
      className={`pointer-events-none absolute flex items-center rounded-[3px] px-1 text-[10px] font-semibold leading-[14px] ${className}`}
    >
      {children}
    </span>
  );
}

function signed(value: number) {
  return value > 0 ? `+${value}` : String(value);
}
