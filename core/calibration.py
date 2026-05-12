"""Nominal calibration from one sura-free page: clean margins, height/N line pitch, gap from projection."""

from __future__ import annotations

import io
import logging
import statistics
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from PIL import Image

from core.config import CropConfig, DetectionConfig, ProcessingConfig
from core.context import BBox
from core.page_processor import create_context
from image_utils import clean_image
from script.line_cutter import get_line_boxes

logger = logging.getLogger(__name__)

_GAP_THRESHOLD_MIN = 0.002
_GAP_THRESHOLD_MAX = 0.22


def _crop_box_for_page(
    crop: CropConfig,
    processing: ProcessingConfig,
    page_index: int,
    img_w: int,
    img_h: int,
) -> BBox:
    """Match ``LineDetector`` crop logic (including alternate horizontal margin)."""
    x, y, w, h = crop.as_tuple()
    should_swap = processing.alternate_horizontal_margin and page_index % 2 == 0
    crop_x = (img_w - (x + w)) if should_swap else x
    left = max(0, crop_x)
    top = max(0, y)
    right = min(img_w, left + w)
    bottom = min(img_h, top + h)
    if right <= left or bottom <= top:
        raise ValueError("Crop rectangle is outside image bounds")
    return BBox(left=left, top=top, right=right, bottom=bottom)


class CalibrationRunLog:
    """Collect human-readable steps for API JSON and mirror to logger."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def add(self, msg: str) -> None:
        self.lines.append(msg)
        logger.info("[calibration] %s", msg)


def _save_binary_png(binary: np.ndarray, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.fromarray(binary.astype(np.uint8), mode="L")
    img.save(path)
    return str(path.resolve())


def _save_row_sum_chart(row_sums: np.ndarray, path: Path) -> str:
    """Write a simple horizontal profile image (dark = more ink per row)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rs = np.asarray(row_sums, dtype=np.float64)
    if rs.size == 0:
        return ""
    mx = float(rs.max()) or 1.0
    norm = (1.0 - (rs / mx)).clip(0, 1)
    h = int(norm.shape[0])
    w_chart = 320
    arr = np.zeros((h, w_chart), dtype=np.uint8)
    for y in range(h):
        v = int(255 * norm[y])
        arr[y, :] = v
    Image.fromarray(arr, mode="L").save(path)
    return str(path.resolve())


def _save_uniform_split_overlay(
    grey: np.ndarray, content_h: int, n_lines: int, path: Path
) -> str:
    """Grey image with horizontal guides at k * H/N for k = 1..N-1 (even split)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rgb = np.stack([grey.astype(np.uint8)] * 3, axis=-1)
    h = grey.shape[0]
    strip = content_h / float(n_lines)
    for k in range(1, n_lines):
        y = int(round(k * strip))
        if 0 <= y < h:
            rgb[y, :] = (255, 0, 0)
            for dy in (-1, 1):
                yy = y + dy
                if 0 <= yy < h:
                    rgb[yy, :, 0] = np.minimum(255, rgb[yy, :, 0] + 80)
    Image.fromarray(rgb, mode="RGB").save(path)
    return str(path.resolve())


def run_nominal_calibration(
    raw_bytes: bytes,
    filename: str,
    crop: CropConfig,
    processing: ProcessingConfig,
    expected_lines: int,
    padding: int,
    min_line_height_floor: int,
    nominal_height_margin_pct: float,
    export_dir: Path,
    *,
    verify_on_cropped_unclean: bool = True,
) -> dict:
    """
    One reference page (no sura title): user crop → ``clean_image`` (tight content),
    nominal vertical pitch = clean content height / N, min_line_height from margin % + padding,
    gap_threshold from row projection minima at even-split gap centers.

    ``nominal_height_margin_pct`` is the fraction *subtracted* from 1.0 before scaling
    nominal height (e.g. 0.08 → use 92% of nominal strip for min_line_height baseline).
    """
    logs = CalibrationRunLog()
    exports: list[str] = []

    def fail(msg: str, code: str = "error") -> dict:
        logs.add(f"FAILED: {msg}")
        out: dict = {
            "status": code,
            "message": msg,
            "logs": logs.lines,
            "export_paths": exports,
        }
        try:
            log_path = run_dir / "calibration.log"
            log_path.write_text("\n".join(logs.lines), encoding="utf-8")
            out["log_file"] = str(log_path.resolve())
            out["export_dir"] = str(run_dir.resolve())
        except Exception:
            pass
        return out

    logs.add(
        f"Start nominal calibration filename={filename!r} expected_lines={expected_lines}"
    )
    export_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    run_dir = export_dir / stamp
    run_dir.mkdir(parents=True, exist_ok=True)
    logs.add(f"Debug export directory: {run_dir.resolve()}")

    if expected_lines < 1:
        return fail("expected_lines must be >= 1")

    img = Image.open(io.BytesIO(raw_bytes))
    img.load()
    logs.add(f"Open image size={img.width}x{img.height}")

    ctx = create_context(img, filename, page_index=1)
    ctx.crop_box = _crop_box_for_page(
        crop, processing, 1, img.width, img.height
    )
    cb = ctx.crop_box
    logs.add(
        f"User crop applied: left={cb.left} top={cb.top} right={cb.right} bottom={cb.bottom} "
        f"(w={cb.width} h={cb.height})"
    )
    grey_crop = ctx.cropped_grey()
    bin_crop = ctx.cropped_binary()
    logs.add(f"Cropped grey/binary shape: {grey_crop.shape}")

    clean_grey, clean_binary = clean_image(grey_crop, bin_crop)
    H, Wc = int(clean_binary.shape[0]), int(clean_binary.shape[1])
    logs.add(
        f"After clean_image (margins discarded): shape H={H} W={Wc} "
        f"content-only tight box"
    )

    if H < expected_lines or Wc < 2:
        p1 = _save_binary_png(bin_crop, run_dir / "01_cropped_binary_before_clean.png")
        exports.append(p1)
        logs.add(f"Exported (debug): {p1}")
        return fail(
            f"Cleaned content too small (H={H}, W={Wc}) for {expected_lines} lines",
            "error",
        )

    p_clean = _save_binary_png(clean_binary, run_dir / "02_clean_binary.png")
    exports.append(p_clean)
    logs.add(f"Exported clean binary: {p_clean}")

    nominal_strip = H / float(expected_lines)
    logs.add(
        f"Nominal vertical pitch = content_height / N = {H} / {expected_lines} "
        f"= {nominal_strip:.3f} px (layout: stacked lines → use height, not width, for pitch)"
    )
    logs.add(f"Content width (after clean) W={Wc} px (reference only)")

    mh_raw = int(nominal_strip * (1.0 - nominal_height_margin_pct)) + padding
    recommended_mh = max(1, mh_raw)
    logs.add(
        f"min_line_height candidate = int(nominal_strip * (1 - {nominal_height_margin_pct:.4f})) + "
        f"padding({padding}) = {recommended_mh} px"
    )

    recommended_floor = min(min_line_height_floor, recommended_mh)
    logs.add(
        f"Recommended min_line_height_floor = min(user_floor={min_line_height_floor}, "
        f"recommended_mh={recommended_mh}) = {recommended_floor} "
        f"(so effective min height is max(mh, floor) and not forced above nominal strip)"
    )

    det_probe = DetectionConfig(
        gap_threshold=0.03,
        min_line_height=recommended_mh,
        padding=padding,
        min_line_height_floor=recommended_floor,
    )
    boxes_clean = get_line_boxes(clean_binary, **det_probe.as_dict())
    logs.add(
        f"Probe on *clean* crop with gap=0.03 / effective_mh={det_probe.effective_min_line_height()}: "
        f"{len(boxes_clean)} lines (diagnostic only)"
    )

    row_sums = clean_binary.sum(axis=1).astype(np.float64)
    peak = float(row_sums.max())
    if peak <= 0:
        return fail("Row projection peak is zero (empty binary after clean)")

    p_chart = _save_row_sum_chart(row_sums, run_dir / "03_row_projection_chart.png")
    exports.append(p_chart)
    logs.add(
        f"Row projection: peaks={peak:.0f} min_nonzero~{float(row_sums[row_sums > 0].min()):.2f} "
        f"chart saved {p_chart}"
    )

    window = max(2, int(round(nominal_strip * 0.08)))
    gap_samples: list[float] = []
    for k in range(1, expected_lines):
        y_center = k * nominal_strip
        iy = int(round(y_center))
        iy = max(0, min(H - 1, iy))
        lo = max(0, iy - window)
        hi = min(H, iy + window + 1)
        local_min = float(row_sums[lo:hi].min())
        gap_samples.append(local_min)
        logs.add(
            f"Gap band sample k={k} around row iy={iy} (window±{window}): "
            f"local_min_row_sum={local_min:.1f} (~{100.0 * local_min / peak:.2f}% of peak)"
        )

    if not gap_samples:
        return fail("No inter-line samples (expected_lines < 2?)")

    g_raw_median = float(statistics.median(gap_samples))
    g_mean = float(statistics.mean(gap_samples))
    positives = [g for g in gap_samples if g > 1.0]
    n_zero = sum(1 for g in gap_samples if g <= 1.0)
    p15_row = float(np.percentile(row_sums, 15))
    p25_row = float(np.percentile(row_sums, 25))

    if positives:
        g_ref = float(statistics.median(positives))
        g_method = "median_of_positive_local_mins"
        logs.add(
            f"Gap ink: raw_median(all_samples)={g_raw_median:.1f} (misleading when many exact-zero "
            f"rows hit); positives={len(positives)}/{len(gap_samples)} (zeros≈{n_zero}) → "
            f"g_ref={g_ref:.1f} via {g_method}"
        )
    else:
        g_ref = max(p15_row, 1.0)
        g_method = "fallback_p15_row_sums"
        logs.add(
            f"Gap ink: no positive local mins; using {g_method} g_ref={g_ref:.1f} "
            f"(p15={p15_row:.1f}, p25={p25_row:.1f})"
        )

    logs.add(
        f"Aggregate (all samples): median={g_raw_median:.1f}, mean={g_mean:.1f} vs peak={peak:.1f}"
    )

    gap_threshold_raw = (g_ref / peak) if peak > 0 else _GAP_THRESHOLD_MIN
    if gap_threshold_raw < 0.008:
        boosted = max(gap_threshold_raw, p25_row / peak, p15_row / peak * 1.15)
        logs.add(
            f"gap_ref/peak={gap_threshold_raw:.5f} is very small; boosted to "
            f"{boosted:.5f} using max(raw, p25/peak, 1.15*p15/peak) for stability"
        )
        gap_threshold_raw = boosted

    gap_threshold = max(_GAP_THRESHOLD_MIN, min(_GAP_THRESHOLD_MAX, float(gap_threshold_raw)))
    logs.add(
        f"Estimated gap_threshold = g_ref/peak ≈ {g_ref:.1f}/{peak:.1f} → {gap_threshold:.5f} "
        f"(clamped to [{_GAP_THRESHOLD_MIN}, {_GAP_THRESHOLD_MAX}])"
    )

    p_uniform = _save_uniform_split_overlay(
        clean_grey, H, expected_lines, run_dir / "04_uniform_split_guides.png"
    )
    exports.append(p_uniform)
    logs.add(f"Uniform H/{expected_lines} split guides overlay: {p_uniform}")

    det_final = DetectionConfig(
        gap_threshold=gap_threshold,
        min_line_height=recommended_mh,
        padding=padding,
        min_line_height_floor=recommended_floor,
    )
    boxes_final = get_line_boxes(clean_binary, **det_final.as_dict())
    logs.add(
        f"Sanity on clean binary: get_line_boxes with recommended params → "
        f"{len(boxes_final)} lines (target N={expected_lines})"
    )

    mh_use = recommended_mh
    floor_use = recommended_floor
    if len(boxes_final) != expected_lines:
        logs.add(
            f"Tuning min_line_height on clean binary (gap_threshold fixed at {gap_threshold:.5f}) "
            f"because initial count was {len(boxes_final)}"
        )
        best_mh: int | None = None
        best_dist = 10**9
        low = max(8, int(nominal_strip * 0.42))
        for mh_try in range(recommended_mh, low - 1, -max(4, int(nominal_strip * 0.02))):
            fl_try = min(min_line_height_floor, mh_try)
            det_t = DetectionConfig(
                gap_threshold=gap_threshold,
                min_line_height=mh_try,
                padding=padding,
                min_line_height_floor=fl_try,
            )
            n_try = len(get_line_boxes(clean_binary, **det_t.as_dict()))
            dist = abs(n_try - expected_lines)
            logs.add(
                f"  try min_line_height={mh_try} floor={fl_try} → {n_try} lines (Δ={dist})"
            )
            if dist < best_dist or (dist == best_dist and (best_mh is None or mh_try > best_mh)):
                best_dist = dist
                best_mh = mh_try
                floor_use = fl_try
            if n_try == expected_lines:
                mh_use = mh_try
                floor_use = fl_try
                logs.add(f"  matched N={expected_lines} at min_line_height={mh_use}")
                break
        else:
            if best_mh is not None:
                mh_use = best_mh
                floor_use = min(min_line_height_floor, mh_use)
                logs.add(
                    f"No exact N match; chose closest min_line_height={mh_use} "
                    f"(floor={floor_use}, best Δ={best_dist})"
                )

        det_final = DetectionConfig(
            gap_threshold=gap_threshold,
            min_line_height=mh_use,
            padding=padding,
            min_line_height_floor=floor_use,
        )
        boxes_final = get_line_boxes(clean_binary, **det_final.as_dict())
        logs.add(
            f"After tuning: clean binary line count = {len(boxes_final)} "
            f"(effective_mh={det_final.effective_min_line_height()})"
        )

    verify_note = ""
    if verify_on_cropped_unclean:
        det_v = DetectionConfig(
            gap_threshold=gap_threshold,
            min_line_height=mh_use,
            padding=padding,
            min_line_height_floor=floor_use,
        )
        n_unclean = len(get_line_boxes(bin_crop, **det_v.as_dict()))
        logs.add(
            f"Verification on *unclean* user crop (production-like binary): {n_unclean} lines "
            f"(expected {expected_lines}); margins change projection vs clean-only model."
        )
        verify_note = (
            f"cropped_unclean_line_count={n_unclean} (clean_suggested_count={len(boxes_final)})"
        )
        pv = run_dir / "05_cropped_binary_unclean.png"
        exports.append(_save_binary_png(bin_crop, pv))
        logs.add(f"Exported unclean cropped binary for comparison: {pv.resolve()}")

    clean_lines = len(boxes_final)
    targets_met = clean_lines == expected_lines
    if not targets_met:
        logs.add(
            f"WARNING: clean binary still has {clean_lines} lines, not {expected_lines}. "
            "Review 03_row_projection_chart.png and 04_uniform_split_guides.png; "
            "gap_threshold or crop may need manual adjustment."
        )

    result = {
        "status": "ok" if targets_met else "partial",
        "message": (
            "Nominal calibration complete"
            if targets_met
            else f"Nominal calibration finished but clean line count is {clean_lines}, not {expected_lines}"
        ),
        "targets_met": targets_met,
        "lines_on_clean_binary": clean_lines,
        "logs": logs.lines,
        "export_paths": exports,
        "export_dir": str(run_dir.resolve()),
        "derived": {
            "content_height_px": H,
            "content_width_px": Wc,
            "nominal_line_height_px": round(nominal_strip, 4),
            "nominal_height_margin_pct": nominal_height_margin_pct,
            "row_projection_peak": round(peak, 2),
            "gap_row_median_raw": round(g_raw_median, 4),
            "gap_reference_value": round(g_ref, 2),
            "gap_reference_method": g_method,
            "verify_note": verify_note or None,
        },
        "recommended": {
            "gap_threshold": det_final.gap_threshold,
            "min_line_height": det_final.min_line_height,
            "padding": det_final.padding,
            "min_line_height_floor": det_final.min_line_height_floor,
            "effective_min_line_height": det_final.effective_min_line_height(),
        },
    }
    logs.add(
        "Calibration run finished."
        + (" All targets met." if targets_met else " See warnings above.")
    )
    log_path = run_dir / "calibration.log"
    log_path.write_text("\n".join(logs.lines), encoding="utf-8")
    result["log_file"] = str(log_path.resolve())
    return result
