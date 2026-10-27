import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  doubtOf,
  isSelected,
  selectIds,
  shownType,
  type BlobSelection,
  type Doubts,
  type Expectations,
  type GalleryGroup,
  type GalleryKind,
} from "@/lib/calibration/model";
import type { CalibrationBlob, CalibrationLine } from "@/lib/calibration/types";

import { GALLERY_ZOOMS, InkCell } from "./InkCell";
import { useTypeName } from "./labels";
import { subtypeGlyph } from "./subtypes";

/**
 * The page's marks side by side, one group per type — or all its ink by role — so
 * the odd one out stands out at a glance instead of being hunted for line by line.
 *
 * Every crop is at **one zoom**: a madda stays wider than a fatha, a dot smaller than
 * a letter. The matcher stretches every mark to the same square — which is how it
 * came to take maddas for fathas — so the gallery must not. Within a group what most
 * needs a look comes first (see `galleryGroups`); the flow runs right to left, as the
 * page does, so ← is onward here too.
 *
 * A click selects a blob for the bar and the keys; a double-click (or Enter) shows it
 * in its line, for the cases the crop alone cannot settle.
 */
export function MarkGallery({
  groups,
  kind,
  onKind,
  zoom,
  onZoom,
  expectations,
  doubts,
  selection,
  editable,
  onSelect,
  onOpen,
  onAcceptGroup,
}: {
  groups: GalleryGroup[];
  kind: GalleryKind;
  onKind: (kind: GalleryKind) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  expectations: Expectations;
  doubts: Doubts;
  selection: BlobSelection;
  editable: boolean;
  onSelect: (selection: BlobSelection) => void;
  onOpen: (selection: BlobSelection) => void;
  /** Give every mark of this type that is only expected its type. */
  onAcceptGroup: (subtype: string) => void;
}) {
  const { t } = useTranslation();
  const typeName = useTypeName();
  const pick = (line: CalibrationLine, blob: CalibrationBlob, event: MouseEvent) => {
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const current = selection.snapshot === line.snapshot_id ? selection.ids : [];
    onSelect({
      snapshot: line.snapshot_id,
      // A selection never spans lines: adding from another line starts over there.
      ids: selectIds(current, [blob.id], additive, additive),
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label={t("calibration.gallery.kindLabel")}
          className="flex h-[26px] flex-none overflow-hidden rounded-sm border border-rule-2"
        >
          {(["types", "roles"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => onKind(value)}
              className={`cursor-pointer px-2.5 text-[11.5px] font-medium transition-colors ${
                kind === value ? "bg-lapis text-on-lapis" : "bg-card text-ink-2 hover:bg-sheet"
              }`}
            >
              {t(value === "types" ? "calibration.gallery.byType" : "calibration.gallery.byRole")}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
          {t("calibration.gallery.zoom")}
          <select
            className="h-7 rounded-sm border border-rule-2 bg-card px-1.5 text-[11.5px]"
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
        <span className="text-[11px] text-ink-3">
          {t(kind === "types" ? "calibration.gallery.typesHint" : "calibration.gallery.rolesHint")}
        </span>
      </div>

      {groups.length === 0 && (
        <p className="text-[12px] text-ink-3">{t("calibration.gallery.empty")}</p>
      )}

      {groups.map((group) => (
        <section key={group.key || "untyped"} className="flex flex-col gap-2">
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule bg-card/95 py-1.5 backdrop-blur-sm">
            <span className="text-[13px] font-semibold text-ink">
              {kind === "roles" ? (
                t(`calibration.role.${group.key as "body" | "mark"}`)
              ) : group.key ? (
                <>
                  <span dir="rtl">{subtypeGlyph(group.key)}</span> {typeName(group.key)}
                </>
              ) : (
                t("calibration.gallery.noType")
              )}
            </span>
            <span className="text-[11px] tabular-nums text-ink-3">
              {kind === "types" && group.key
                ? t("calibration.gallery.typeCount", {
                    count: group.items.length,
                    typed: group.typed,
                    expected: group.expected,
                  })
                : t("calibration.gallery.count", { count: group.items.length })}
            </span>
            {kind === "types" && group.key && group.expected > 0 && (
              <button
                type="button"
                className="inline-flex cursor-pointer items-center justify-center rounded-control border border-rule-2 bg-card font-semibold text-ink transition-colors hover:bg-sheet disabled:cursor-default disabled:opacity-50 h-7 px-2.5 text-[12px]"
                disabled={!editable}
                onClick={() => onAcceptGroup(group.key)}
                title={t("calibration.filter.acceptShownHelp")}
              >
                {t("calibration.filter.acceptShown", { count: group.expected })}
              </button>
            )}
          </div>
          <div dir="rtl" className="flex flex-wrap items-end gap-1.5">
            {group.items.map(({ line, blob }) => {
              const shown = shownType(blob, line.snapshot_id, expectations);
              const doubt = doubtOf(blob, line.snapshot_id, doubts);
              const title = [
                t("calibration.bar.where", {
                  line: line.line_number,
                  id: blob.id,
                  w: blob.w,
                  h: blob.h,
                }),
                blob.role === "mark"
                  ? shown
                    ? `${typeName(shown.subtype)} — ${t(
                        shown.typed
                          ? "calibration.bar.typed"
                          : shown.sure
                            ? "calibration.bar.expectedSure"
                            : "calibration.bar.expectedLikely",
                      )}`
                    : t("calibration.bar.noType")
                  : t("calibration.bar.engineRead", {
                      role: t(`calibration.role.${blob.initial_role}`),
                      score: blob.body_score,
                    }),
                doubt
                  ? t("calibration.types.doubtTitle", {
                      type: typeName(doubt.typed),
                      other: typeName(doubt.subtype),
                    })
                  : "",
              ]
                .filter(Boolean)
                .join("\n");
              return (
                <InkCell
                  key={`${line.snapshot_id}:${blob.id}`}
                  data={`${line.snapshot_id}:${blob.id}`}
                  imageUrl={line.image_url ?? null}
                  crop={{
                    x: blob.x - line.bbox.x,
                    y: blob.y - line.bbox.y,
                    w: blob.w,
                    h: blob.h,
                  }}
                  zoom={zoom}
                  ring={
                    isSelected(selection, line.snapshot_id, blob.id)
                      ? "chosen"
                      : doubt
                        ? "doubt"
                        : null
                  }
                  settled={blob.role !== "mark" || !!shown?.typed}
                  title={title}
                  onClick={(event) => pick(line, blob, event)}
                  onOpen={() => onOpen({ snapshot: line.snapshot_id, ids: [blob.id] })}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
