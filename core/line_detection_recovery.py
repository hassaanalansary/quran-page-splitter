"""Phase C: bounded gap_threshold-only recovery (min_line_height fixed from config).

If no alternate gap yields exactly ``expected`` lines, return None so Phase B aborts.
``min_line_height`` is not swept here; use calibration + ``min_line_height_floor`` instead.
"""

from __future__ import annotations

import logging

from core.config import DetectionConfig
from script.line_cutter import get_line_boxes

logger = logging.getLogger(__name__)

_GAP_THRESHOLD_FLOOR = 0.006
_GAP_THRESHOLD_CEIL = 0.22
_GAP_STEP = 0.001
_MAX_GAP_STEPS = 80


def _gap_sweep_down(gt0: float) -> list[float]:
    """Smaller gap → more ink rows count as gaps → more bands (split)."""
    out: list[float] = []
    for k in range(1, _MAX_GAP_STEPS + 1):
        g = round(gt0 - _GAP_STEP * k, 5)
        if g < _GAP_THRESHOLD_FLOOR:
            break
        out.append(g)
    return out


def _gap_sweep_up(gt0: float) -> list[float]:
    """Larger gap → fewer gap rows → fewer bands (merge)."""
    out: list[float] = []
    for k in range(1, _MAX_GAP_STEPS + 1):
        g = round(gt0 + _GAP_STEP * k, 5)
        if g > _GAP_THRESHOLD_CEIL:
            break
        out.append(g)
    return out


def iter_recovery_candidates(
    base: DetectionConfig, initial_count: int, expected: int
) -> list[DetectionConfig]:
    """Only ``gap_threshold`` varies; min_line_height and padding match base (effective MH via as_dict)."""
    pad0 = base.padding
    gt0 = base.gap_threshold

    ordered: list[DetectionConfig] = []
    seen: set[float] = set()

    def add_gap(g: float) -> None:
        g = round(g, 5)
        if g < _GAP_THRESHOLD_FLOOR or g > _GAP_THRESHOLD_CEIL:
            return
        if g in seen:
            return
        if abs(g - gt0) < 1e-9:
            return
        seen.add(g)
        ordered.append(
            DetectionConfig(
                gap_threshold=g,
                min_line_height=base.min_line_height,
                padding=pad0,
                min_line_height_floor=base.min_line_height_floor,
            )
        )

    if initial_count < expected:
        for g in _gap_sweep_down(gt0):
            add_gap(g)
    elif initial_count > expected:
        for g in _gap_sweep_up(gt0):
            add_gap(g)
    else:
        pass

    return ordered


def _recovery_score_gap_only(cfg: DetectionConfig, base: DetectionConfig) -> float:
    """Lower is better: prefer gap closest to user's base."""
    return (cfg.gap_threshold - base.gap_threshold) ** 2


def try_recover_line_count(
    cropped_binary: np.ndarray,
    base: DetectionConfig,
    expected: int,
    initial_count: int,
) -> tuple[list[dict[str, int]], DetectionConfig] | None:
    """Try alternate gap_threshold only. Pick hit with gap nearest base; else None."""
    candidates = iter_recovery_candidates(base, initial_count, expected)
    best: tuple[float, list[dict[str, int]], DetectionConfig] | None = None
    for cfg in candidates:
        boxes = get_line_boxes(cropped_binary, **cfg.as_dict())
        if len(boxes) != expected:
            continue
        score = _recovery_score_gap_only(cfg, base)
        if best is None or score < best[0]:
            best = (score, boxes, cfg)
    if best is None:
        logger.info(
            "  Phase C: no gap-only recovery (count was %d, expected %d)",
            initial_count,
            expected,
        )
        return None
    _score, boxes, cfg = best
    logger.info(
        "  Phase C: gap-only recovery score=%.6f (gap_threshold=%s, effective min_line_height=%s)",
        _score,
        cfg.gap_threshold,
        cfg.effective_min_line_height(),
    )
    return (boxes, cfg)
