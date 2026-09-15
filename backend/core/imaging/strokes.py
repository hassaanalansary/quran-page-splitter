"""Freehand strokes painted onto a mask.

One function, because one thing needs it: a reviewer rubs out a stray mark with an
eraser brush, and the stroke they drew has to become transparency in the exported
PNG. The stroke is stored as the points the pointer passed through plus a brush
width — a path, not a bitmap — so that it survives a re-export at a different crop
and can be undone by deleting a row.

It lived in ``core.cut_review`` beside the pre-Django results.json machinery, which
made it a private helper of a module nothing else used; ``api.services.export``
imported it through the underscore. It was never about review. It is about pixels.
"""

from __future__ import annotations

from typing import Any

from PIL import ImageDraw


def apply_eraser_stroke(
    draw: ImageDraw.ImageDraw,
    stroke: dict[str, Any],
    offset_x: int,
    offset_y: int,
) -> None:
    """Paint one stroke onto ``draw`` in black, at the given offset.

    ``draw`` is expected to be drawing on an **alpha channel**, where black means
    fully transparent — so painting the stroke erases whatever it covers.

    ``offset_x`` / ``offset_y`` are where the crop being drawn starts on the page:
    strokes are stored in page coordinates and every export crops somewhere
    different, so the shift is the caller's and is applied here rather than stored.

    The path is drawn as a joined polyline **and** a disc at every point. The
    polyline alone leaves the two ends square, and a single-point stroke — a tap
    rather than a drag — would draw nothing at all.
    """
    brush_size = _positive_int(stroke.get("brush_size", 12), "brush_size")
    radius = max(1, brush_size // 2)
    points = [
        (int(point[0]) - offset_x, int(point[1]) - offset_y)
        for point in stroke.get("points", [])
        if isinstance(point, list) and len(point) >= 2
    ]
    if not points:
        return
    if len(points) > 1:
        draw.line(points, fill=0, width=brush_size, joint="curve")
    for x, y in points:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=0)


def _positive_int(value: Any, name: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if result < 1:
        raise ValueError(f"{name} must be positive")
    return result
