"""One run, as JSON — the artefact you grep, diff and keep.

The log beside it is prose: it says what happened in the order it happened, and a
person reads it top to bottom when one line went wrong. This is the same run as
data, so a *set* of runs can be compared — did moving a weight break a line that
used to be exact, did a re-cut template find the ornament it was missing.

Derived entirely from the input and the result, which is what makes it honest: it
cannot report a number the engine did not produce, and it stays true whichever
caller built the run — the CLI from a directory of PNGs, or the web app from the
database.
"""

from __future__ import annotations

from core.word_boundary.inputs import WordBoundaryInput
from core.word_boundary.results import STATUSES, WordBoundaryResult, WordLine


def as_dict(source: WordBoundaryInput, result: WordBoundaryResult) -> dict:
    """The whole run as plain JSON-serialisable data."""
    words = source.words
    ayat = sorted({word.aya for word in words}, key=_aya_key)
    return {
        "span": {
            "from": words[0].aya if words else None,
            "to": words[-1].aya if words else None,
            "ayat": len(ayat),
            "words": len(words),
        },
        "method": "sequential-paw",
        "separator_template": source.separator_template is not None,
        "complete": result.complete,
        "words_consumed": result.words_consumed,
        "separators_found": sum(len(line.ornaments) for line in result.lines),
        "totals": {status: sum(1 for line in result.lines if line.status == status) for status in STATUSES},
        "lines": [_line(index, line) for index, line in enumerate(result.lines)],
    }


def _aya_key(aya: str) -> tuple[int, ...]:
    """Sort "7:82" numerically. A string sort would put 7:10 before 7:2."""
    try:
        return tuple(int(part) for part in aya.split(":"))
    except ValueError:
        return (0,)


def _line(index: int, line: WordLine) -> dict:
    return {
        "index": index,
        "label": line.label,
        "image": line.source,
        "status": line.status,
        "reason": line.reason,
        "cost": line.cost,
        "deviations": line.deviations,
        "end_sequences": line.end_sequences,
        "band": {"top": line.band[0], "bottom": line.band[1]},
        "crop_offset": {"x": line.crop_offset[0], "y": line.crop_offset[1]},
        "separators": len(line.ornaments),
        "ornaments": [{"left": o.left, "right": o.right, "components": o.components} for o in line.ornaments],
        "component_roles": {
            "bodies": sum(c.role == "body" for c in line.components),
            "marks": sum(c.role == "mark" for c in line.components),
            "ornament": sum(c.role == "ornament" for c in line.components),
            "role_ambiguous": sum(c.ambiguous for c in line.components),
        },
        "segments": [
            {
                "status": s.status,
                "reason": s.reason,
                "words": s.words,
                "end_sequences": s.end_sequences,
                "deviations": s.deviations,
            }
            for s in line.segments
        ],
        "words": [
            {
                "index": box.index,
                "word": box.text,
                "word_id": box.word_id,
                "aya": box.aya,
                "expected_paws": box.expected_paws,
                "blobs": len(box.components),
                "merged": box.merged,
                "bbox": {"x": box.x, "y": box.y, "w": box.w, "h": box.h},
                "end_x": box.end_x,
            }
            for box in line.words
        ],
    }
