import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  expectedType,
  isFusedBody,
  isTyped,
  subtypeParts,
  wordCount,
  type Expectations,
} from "@/lib/calibration/model";
import {
  belongsAt,
  bodyPieces,
  inkColor,
  wordBlobs,
  wordCrop,
  type PlaybackWord,
} from "@/lib/calibration/playback";
import type { CalibrationBlob } from "@/lib/calibration/types";

import { paint, type Raster } from "./inkPaint";
import { useTypeName } from "./labels";
import { subtypeGlyph } from "./subtypes";

/** Screen px: the header; a row of labels; the room the lines cross between the ink
 * and a row; the white round the ink; the margin at the sides. */
const HEADER = 76;
const ROW = 76;
const REACH = 48;
const SHEET = 16;
const MARGIN = 28;
const MAX_SCALE = 16;
const LABEL_MAX = 168;
const LABEL_GAP = 8;

type Callout = {
  blob: CalibrationBlob;
  above: boolean;
  /** Where the line leaves the ink: the middle of the blob's top or bottom edge. */
  ax: number;
  ay: number;
  /** The label's middle, once the row is spread. */
  x: number;
  colour: string;
};

/**
 * One word, as large as the view allows, with a line from each of its blobs to what
 * it is — the way a game shows its controller, a line out of every button:
 *
 *            ◌َ fatha     ◌ّ shadda        ← marks above the writing line
 *               ╲          │
 *          ┌─────────────────────┐
 *          │      the word's ink │
 *          └─────────────────────┘
 *               ╱          ╲
 *          لرَّ PAW 2     ◌ِ kasra       ← its bodies, and the marks below
 *
 * A mark says its type — typed, or what it is expected to be; a body the piece of the
 * text it prints. The bodies take whichever row has fewer marks. Read-only.
 */
export function WordAnatomy({
  entry,
  raster,
  expectations,
  byType,
  onClose,
}: {
  entry: PlaybackWord;
  /** The word's line's label raster; undefined while it loads or when it failed. */
  raster: Raster | undefined;
  expectations: Expectations;
  /** Each mark type in its own colour, as the player shows them. */
  byType: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const typeName = useTypeName();
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { line, word } = entry;

  useEffect(() => {
    if (!frame) return;
    const measure = () => setBox({ w: frame.clientWidth, h: frame.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);

  const blobs = useMemo(() => wordBlobs(entry), [entry]);
  const pieces = useMemo(() => bodyPieces(entry), [entry]);
  const crop = wordCrop(entry);
  const count = wordCount(line, word);

  // A mark's type: typed, else expected; and whether it is only expected.
  const typeOf = useCallback(
    (blob: CalibrationBlob) =>
      isTyped(blob)
        ? { subtype: blob.subtype, typed: true }
        : {
            subtype: expectedType(blob, line.snapshot_id, expectations)?.subtype ?? "",
            typed: false,
          },
    [line.snapshot_id, expectations],
  );

  // The ink, as large as the room left by the two rows of labels.
  const roomW = box.w - 2 * MARGIN - 2 * SHEET;
  const roomH = box.h - HEADER - 2 * (ROW + REACH + SHEET) - MARGIN;
  const scale = Math.max(0.25, Math.min(roomW / crop.w, roomH / crop.h, MAX_SCALE));
  const inkW = crop.w * scale;
  const inkH = crop.h * scale;
  const inkLeft = (box.w - inkW) / 2;
  const inkTop = HEADER + ROW + REACH + SHEET + Math.max(0, (roomH - inkH) / 2);
  const topRow = inkTop - SHEET - REACH - ROW;
  const bottomRow = inkTop + inkH + SHEET + REACH;

  const callouts = useMemo(() => {
    const middle = (line.band[0] + line.band[1]) / 2;
    const marks = blobs.filter((blob) => blob.role === "mark");
    const above = (blob: CalibrationBlob) => blob.y + blob.h / 2 < middle;
    const upper = marks.filter(above).length;
    // The bodies go to the row with fewer marks, so neither crowds.
    const bodiesAbove = upper < marks.length - upper;
    const found: Callout[] = blobs.map((blob) => {
      const top = blob.role === "body" ? bodiesAbove : above(blob);
      const left = blob.x - line.bbox.x - crop.x;
      const edge = top ? blob.y : blob.y + blob.h;
      const rgb =
        blob.role === "mark" ? inkColor(blob, typeOf(blob).subtype, byType).join(",") : null;
      return {
        blob,
        above: top,
        ax: (left + blob.w / 2) * scale + inkLeft,
        ay: (edge - line.bbox.y - crop.y) * scale + inkTop,
        x: 0,
        colour: rgb ? `rgb(${rgb})` : "var(--color-ink-2)",
      };
    });
    // Each row spread under its blobs, left to right, so no two lines cross.
    const span = Math.max(0, box.w - 2 * MARGIN);
    for (const top of [true, false]) {
      const row = found.filter((callout) => callout.above === top).sort((a, b) => a.ax - b.ax);
      if (!row.length) continue;
      const width = Math.min(LABEL_MAX, span / row.length);
      const left = MARGIN + width / 2;
      const right = MARGIN + span - width / 2;
      row.forEach((callout, i) => {
        callout.x = Math.max(callout.ax, left, i ? row[i - 1].x + width : left);
      });
      for (let i = row.length - 1; i >= 0; i--) {
        row[i].x = Math.min(row[i].x, i < row.length - 1 ? row[i + 1].x - width : right);
      }
    }
    return found;
  }, [blobs, line, crop.x, crop.y, scale, inkLeft, inkTop, box.w, typeOf, byType]);
  const rowWidth = (top: boolean) => {
    const n = callouts.filter((callout) => callout.above === top).length;
    return Math.min(LABEL_MAX, Math.max(0, box.w - 2 * MARGIN) / Math.max(1, n)) - LABEL_GAP;
  };

  // Only this word's ink, in the player's colours.
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, crop.w, crop.h);
    if (!raster) return;
    const byId = new Map(line.blobs.map((blob) => [blob.id, blob]));
    paint(context, raster, -crop.x, -crop.y, (id, x) => {
      const blob = byId.get(id);
      if (!blob || blob.erased || !belongsAt(blob, word, line.bbox.x + x)) return null;
      return inkColor(blob, blob.role === "mark" ? typeOf(blob).subtype : "", byType);
    });
  }, [raster, line, word, crop.x, crop.y, crop.w, crop.h, byType, typeOf]);

  return (
    <div
      ref={setFrame}
      dir="ltr"
      className="absolute inset-0 z-10 overflow-hidden bg-well"
      role="dialog"
      aria-label={t("wordPlayback.anatomy.title", { word: word.text })}
    >
      {/* The word, where it is, and the way back. */}
      <div
        className="absolute inset-x-0 top-0 flex items-center gap-4 px-6"
        style={{ height: HEADER }}
      >
        <span lang="ar" dir="rtl" className="font-quran text-[34px] leading-tight text-ink">
          {word.text || t("wordPlayback.unlabelled")}
        </span>
        <span className="font-mono text-[12px] text-ink-3">
          {[
            t("wordPlayback.aya", { aya: word.aya }),
            t("wordPlayback.line", { line: line.line_number }),
          ].join(" · ")}
        </span>
        {count && (
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[12px] font-semibold ${
              count.ok ? "text-ink-3" : "bg-warn text-on-warn"
            }`}
          >
            {t("wordPlayback.paws", count)}
          </span>
        )}
        <span dir="auto" className="ms-auto text-[12px] text-ink-3">
          {t("wordPlayback.anatomy.hint")}
        </span>
        <button
          type="button"
          onClick={onClose}
          title={`${t("wordPlayback.anatomy.close")} (Esc)`}
          aria-label={t("wordPlayback.anatomy.close")}
          className="flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-control border border-rule-2 bg-card text-ink transition-colors hover:bg-sheet"
        >
          <X size={18} />
        </button>
      </div>

      {!blobs.length ? (
        <p className="absolute inset-x-0 top-1/2 text-center text-[13px] text-ink-3">
          {t("wordPlayback.noInk")}
        </p>
      ) : (
        box.w > 0 && (
          <>
            <div
              className="absolute rounded-[10px] bg-white shadow-[0_8px_24px_rgba(0,0,0,0.14)]"
              style={{
                left: inkLeft - SHEET,
                top: inkTop - SHEET,
                width: inkW + 2 * SHEET,
                height: inkH + 2 * SHEET,
              }}
            >
              <canvas
                ref={canvas}
                width={crop.w}
                height={crop.h}
                className="absolute block"
                style={{
                  left: SHEET,
                  top: SHEET,
                  width: inkW,
                  height: inkH,
                  imageRendering: scale > 1.6 ? "pixelated" : undefined,
                }}
              />
              {!raster && (
                <span className="absolute inset-0 flex items-center justify-center text-[12px] text-[color:var(--ov-text)]">
                  {t("wordPlayback.loading")}
                </span>
              )}
            </div>

            <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
              {callouts.map((callout) => {
                const end = callout.above ? topRow + ROW : bottomRow;
                return (
                  <g key={callout.blob.id}>
                    <line
                      x1={callout.ax}
                      y1={callout.ay}
                      x2={callout.x}
                      y2={end}
                      stroke={callout.colour}
                      strokeWidth={1.5}
                    />
                    <circle
                      cx={callout.ax}
                      cy={callout.ay}
                      r={4}
                      fill={callout.colour}
                      stroke="#ffffff"
                      strokeWidth={1.5}
                    />
                  </g>
                );
              })}
            </svg>

            {callouts.map((callout) => {
              const width = rowWidth(callout.above);
              return (
                <div
                  key={callout.blob.id}
                  className="absolute flex flex-col items-center gap-0.5 rounded-control border bg-card px-1.5 py-1.5 text-center shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
                  style={{
                    left: callout.x - width / 2,
                    width,
                    borderColor: callout.colour,
                    ...(callout.above ? { bottom: box.h - (topRow + ROW) } : { top: bottomRow }),
                  }}
                >
                  {callout.blob.role === "mark" ? (
                    <MarkLabel
                      type={typeOf(callout.blob)}
                      colour={callout.colour}
                      name={typeName}
                    />
                  ) : (
                    <BodyLabel
                      blob={callout.blob}
                      piece={pieces.get(callout.blob.id)}
                      name={typeName}
                    />
                  )}
                </div>
              );
            })}
          </>
        )
      )}
    </div>
  );
}

function MarkLabel({
  type,
  colour,
  name,
}: {
  type: { subtype: string; typed: boolean };
  colour: string;
  name: (subtype: string) => string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <span dir="rtl" className="font-quran text-[26px] leading-none" style={{ color: colour }}>
        {type.subtype ? subtypeGlyph(type.subtype) : "?"}
      </span>
      <span dir="auto" className="text-[12.5px] font-semibold leading-tight text-ink">
        {type.subtype ? name(type.subtype) : t("wordPlayback.unknown")}
      </span>
      {type.subtype && !type.typed && (
        <span dir="auto" className="text-[10.5px] leading-tight text-ink-3">
          {t("wordPlayback.anatomy.expected")}
        </span>
      )}
    </>
  );
}

function BodyLabel({
  blob,
  piece,
  name,
}: {
  blob: CalibrationBlob;
  piece: { pieces: string[]; first: number; share: number; total: number } | undefined;
  name: (subtype: string) => string;
}) {
  const { t } = useTranslation();
  const fused = isFusedBody(blob) ? subtypeParts(blob.subtype) : [];
  const caption = !piece
    ? ""
    : piece.share === 0
      ? t("wordPlayback.anatomy.fragment")
      : !piece.pieces.length
        ? t("wordPlayback.anatomy.beyond")
        : piece.share === 1
          ? t("wordPlayback.anatomy.piece", { n: piece.first, total: piece.total })
          : t("wordPlayback.anatomy.pieces", {
              from: piece.first,
              to: piece.first + piece.share - 1,
              total: piece.total,
            });
  return (
    <>
      <span lang="ar" dir="rtl" className="font-quran text-[26px] leading-tight text-ink">
        {piece?.pieces.length ? piece.pieces.join(" ") : "—"}
      </span>
      <span dir="auto" className="text-[11.5px] leading-tight text-ink-2">
        {caption}
      </span>
      {fused.length > 0 && (
        <span dir="auto" className="text-[11px] leading-tight text-mark-text">
          {t("wordPlayback.anatomy.with", {
            marks: fused.map((part) => `${subtypeGlyph(part)} ${name(part)}`).join(" · "),
          })}
        </span>
      )}
    </>
  );
}
