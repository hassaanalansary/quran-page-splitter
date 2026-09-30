import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { mediaUrl } from "@/lib/api";
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

import { useTypeName } from "./labels";
import { subtypeGlyph } from "./subtypes";

/** Page px shown around each blob, so a mark keeps a little of what it sits on. */
const PAD = 6;
/** Screen px a cell may take; a larger body is cut to its middle, never shrunk. */
const MAX_W = 180;
const MAX_H = 120;
export const GALLERY_ZOOMS = [1.5, 2, 3] as const;

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
          className="flex h-[26px] flex-none overflow-hidden rounded-sm border border-border-strong"
        >
          {(["types", "roles"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => onKind(value)}
              className={`cursor-pointer px-2.5 text-[11.5px] font-medium transition-colors ${
                kind === value
                  ? "bg-navy text-white"
                  : "bg-white text-text-secondary hover:bg-bg-surface"
              }`}
            >
              {t(value === "types" ? "calibration.gallery.byType" : "calibration.gallery.byRole")}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[11.5px] text-text-secondary">
          {t("calibration.gallery.zoom")}
          <select
            className="h-7 rounded-sm border border-border-strong bg-white px-1.5 text-[11.5px]"
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
        <span className="text-[11px] text-text-muted">
          {t(kind === "types" ? "calibration.gallery.typesHint" : "calibration.gallery.rolesHint")}
        </span>
      </div>

      {groups.length === 0 && (
        <p className="text-[12px] text-text-muted">{t("calibration.gallery.empty")}</p>
      )}

      {groups.map((group) => (
        <section key={group.key || "untyped"} className="flex flex-col gap-2">
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-white/95 py-1.5 backdrop-blur-sm">
            <span className="text-[13px] font-semibold text-text-primary">
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
            <span className="text-[11px] tabular-nums text-text-muted">
              {kind === "types" && group.key
                ? t("calibration.gallery.typeCount", {
                    count: group.items.length,
                    typed: group.typed,
                    expected: group.expected,
                  })
                : t("calibration.gallery.count", { count: group.items.length })}
            </span>
            {kind === "types" && group.key && group.expected > 0 && (
              <Button
                variant="outline"
                className="h-7 px-2 text-[11.5px]"
                disabled={!editable}
                onClick={() => onAcceptGroup(group.key)}
                title={t("calibration.filter.acceptShownHelp")}
              >
                {t("calibration.filter.acceptShown", { count: group.expected })}
              </Button>
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
                <Cell
                  key={`${line.snapshot_id}:${blob.id}`}
                  line={line}
                  blob={blob}
                  zoom={zoom}
                  chosen={isSelected(selection, line.snapshot_id, blob.id)}
                  settled={blob.role !== "mark" || !!shown?.typed}
                  doubtful={!!doubt}
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

/** One blob, cut from its line's image at the gallery's zoom and centred in its cell,
 * its own box outlined so a mark beside other ink is still the one meant. */
function Cell({
  line,
  blob,
  zoom,
  chosen,
  settled,
  doubtful,
  title,
  onClick,
  onOpen,
}: {
  line: CalibrationLine;
  blob: CalibrationBlob;
  zoom: number;
  chosen: boolean;
  /** Typed (or a body): drawn solid. A guess nobody accepted is dashed. */
  settled: boolean;
  doubtful: boolean;
  title: string;
  onClick: (event: MouseEvent) => void;
  onOpen: () => void;
}) {
  const w = Math.min(MAX_W, (blob.w + 2 * PAD) * zoom);
  const h = Math.min(MAX_H, (blob.h + 2 * PAD) * zoom);
  // The blob's middle, in zoomed line-image px, lands in the cell's middle.
  const left = w / 2 - (blob.x - line.bbox.x + blob.w / 2) * zoom;
  const top = h / 2 - (blob.y - line.bbox.y + blob.h / 2) * zoom;
  return (
    <button
      type="button"
      data-gallery={`${line.snapshot_id}:${blob.id}`}
      title={title}
      aria-label={title}
      aria-pressed={chosen}
      onClick={onClick}
      onDoubleClick={onOpen}
      className={`relative flex-none cursor-pointer overflow-hidden rounded-sm border bg-white ${
        settled ? "border-border-strong" : "border-dashed border-border-strong"
      } ${chosen ? "ring-2 ring-orange" : doubtful ? "ring-2 ring-warning" : ""}`}
      style={{
        width: w,
        height: h,
        contentVisibility: "auto",
        containIntrinsicSize: `${w}px ${h}px`,
      }}
    >
      {line.image_url && (
        <img
          src={mediaUrl(line.image_url)}
          alt=""
          draggable={false}
          loading="lazy"
          className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
          style={{
            transform: `translate(${left}px, ${top}px) scale(${zoom})`,
            transformOrigin: "0 0",
            imageRendering: zoom > 1.6 ? "pixelated" : undefined,
          }}
        />
      )}
      <span
        className="pointer-events-none absolute rounded-[1px] border border-orange/60"
        style={{
          left: w / 2 - (blob.w * zoom) / 2 - 1,
          top: h / 2 - (blob.h * zoom) / 2 - 1,
          width: blob.w * zoom + 2,
          height: blob.h * zoom + 2,
        }}
      />
    </button>
  );
}
