"""The knife on a calibration draft: a shared body cut into one piece per word.

A body two words share (printed touching across the word break) gives each word an
edge at its middle unless a person cut it. A cut is a decision on the draft blob,
kept beside its allocations, in page pixels::

    "cut": {
        "lines":  [[x1, y1, x2, y2], ...],           # what the person drew
        "owners": [word_id, ...],                    # each piece's word, in piece order
        "pieces": [{"x", "y", "w", "h", "area"}, ...],  # measured here when accepted
    }

It changes no PAW count and nothing the reading sees: the engine still reads one
fused blob. It only says which of the blob's pixels belong to which word, for the
words' edges, the export's word map and its ink boxes. How a blob is cut is
:mod:`core.imaging.blob_cuts`.

A cut holds only while the blob is a body shared by exactly the cut's words
(:func:`cut_fits_blob`). One that no longer fits is dropped, not repaired.
"""

from __future__ import annotations

import copy
from typing import Any

import numpy as np

from api.models import CalibrationSnapshot
from api.services.calibration_snapshots import read_raster
from core.imaging.blob_cuts import BlobPieces, CutLine, cut_blob_into_pieces

Doc = dict[str, Any]

#: The most lines one cut may have: one per word break, and no blob joins this many.
MAX_CUT_LINES = 6


class CutRefused(ValueError):
    """An edit asked for a cut that cannot be made as asked."""


class LineRaster:
    """A line's label raster, read from its snapshot the first time it is asked for —
    most saves change no cut and never need it."""

    def __init__(self, snapshot_id: str) -> None:
        self.snapshot_id = snapshot_id
        self.loaded: np.ndarray | None = None

    def pixels(self) -> np.ndarray:
        if self.loaded is None:
            self.loaded = read_raster(CalibrationSnapshot.objects.get(pk=self.snapshot_id))
        return self.loaded


def cut_fits_blob(blob: Doc) -> bool:
    """Whether the blob's cut still says how it divides: a body, not erased, its pieces
    one per word, and its words exactly the words the blob is shared by."""
    cut = blob.get("cut")
    if not cut or blob.get("role") != "body" or blob.get("erased"):
        return False
    owners = list(cut.get("owners") or [])
    shared = [allocation["word_id"] for allocation in blob.get("allocations") or []]
    return len(owners) >= 2 and len(cut.get("pieces") or []) == len(owners) and sorted(owners) == sorted(shared)


def drop_cuts_that_no_longer_fit(row: Doc) -> None:
    """Take every cut off the line's blobs whose words or role changed under it. In place."""
    for blob in row["blobs"]:
        if "cut" in blob and not cut_fits_blob(blob):
            del blob["cut"]


def piece_of_word(blob: Doc, word_id: int) -> Doc | None:
    """The word's piece of a blob whose cut fits, or None when the word has none."""
    cut = blob["cut"]
    owners = cut["owners"]
    return cut["pieces"][owners.index(word_id)] if word_id in owners else None


def blob_mask(raster: np.ndarray, origin: Doc, blob: Doc) -> np.ndarray:
    """The blob's own pixels in its line's raster, cropped to its box. The raster is the
    line's crop of the page, so a raster column is the page x less ``origin["x"]``."""
    left, top = blob["x"] - origin["x"], blob["y"] - origin["y"]
    return raster[top : top + blob["h"], left : left + blob["w"]] == blob["id"]


def cut_blob_in_raster(raster: np.ndarray, origin: Doc, blob: Doc, lines: list[list[int]]) -> BlobPieces:
    """The blob cut along page-pixel lines. Labels and boxes are in the blob's own box."""
    local: list[CutLine] = [
        (x1 - blob["x"], y1 - blob["y"], x2 - blob["x"], y2 - blob["y"]) for x1, y1, x2, y2 in lines
    ]
    return cut_blob_into_pieces(blob_mask(raster, origin, blob), local)


def pieces_in_page(blob: Doc, pieces: BlobPieces) -> list[Doc]:
    """The pieces' boxes in page pixels."""
    return [
        {"x": box.x + blob["x"], "y": box.y + blob["y"], "w": box.w, "h": box.h, "area": box.area}
        for box in pieces.boxes
    ]


def set_cut_from_edit(blob: Doc, requested: Doc | None, origin: Doc, raster: LineRaster) -> None:
    """Put the cut an edit asks for on the blob, measured, or take it off when the edit
    asks for none. The blob's role and allocations are the edit's already. In place.

    Raises :class:`CutRefused` for lines out of shape or off the line, words that are
    not the blob's, or lines that don't cut it into exactly one piece per word.
    """
    if requested is None:
        blob.pop("cut", None)
        return
    lines = read_cut_lines(requested.get("lines"), origin)
    owners = read_cut_owners(requested.get("owners"), blob)
    earlier = blob.get("cut")
    if earlier and earlier.get("lines") == lines and len(earlier.get("pieces") or []) == len(owners):
        # The same lines cut the same pixels: only who owns which piece may have changed.
        pieces = copy.deepcopy(earlier["pieces"])
    else:
        pieces = pieces_in_page(blob, cut_blob_in_raster(raster.pixels(), origin, blob, lines))
    if len(pieces) != len(owners):
        raise CutRefused("the lines do not cut the blob into one piece per word")
    blob["cut"] = {"lines": lines, "owners": owners, "pieces": pieces}


def read_cut_lines(raw: Any, origin: Doc) -> list[list[int]]:
    """The cut's lines, each four whole page pixels inside the line's box."""
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_CUT_LINES:
        raise CutRefused("a cut needs one to a few lines")
    lines = []
    for line in raw:
        if not isinstance(line, list) or len(line) != 4:
            raise CutRefused("a line is four numbers")
        if any(not isinstance(value, int) or isinstance(value, bool) for value in line):
            raise CutRefused("a line is whole pixels")
        x1, y1, x2, y2 = line
        inside_x = all(origin["x"] <= x <= origin["x"] + origin["w"] for x in (x1, x2))
        inside_y = all(origin["y"] <= y <= origin["y"] + origin["h"] for y in (y1, y2))
        if not (inside_x and inside_y):
            raise CutRefused("a line is drawn on its line")
        lines.append([x1, y1, x2, y2])
    return lines


def read_cut_owners(raw: Any, blob: Doc) -> list[int]:
    """The pieces' words: exactly the words a body is shared by, in any order."""
    shared = [allocation["word_id"] for allocation in blob.get("allocations") or []]
    if blob.get("role") != "body" or blob.get("erased") or len(shared) < 2:
        raise CutRefused("only a body two words share is cut")
    if not isinstance(raw, list) or any(not isinstance(owner, int) or isinstance(owner, bool) for owner in raw):
        raise CutRefused("owners are word ids")
    if sorted(raw) != sorted(shared):
        raise CutRefused("a cut's words are the blob's words")
    return list(raw)


def word_of_each_cut_pixel(
    raster: np.ndarray, origin: Doc, blob: Doc
) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """A cut blob's pixels as raster rows and columns, with each one's word. None if
    the lines no longer cut it as stored — the rule changed under an old draft."""
    cut = blob["cut"]
    pieces = cut_blob_in_raster(raster, origin, blob, cut["lines"])
    if len(pieces.boxes) != len(cut["owners"]):
        return None
    rows, columns = np.nonzero(pieces.labels >= 0)
    words = np.asarray(cut["owners"], dtype=np.int64)[pieces.labels[rows, columns]]
    return rows + (blob["y"] - origin["y"]), columns + (blob["x"] - origin["x"]), words


__all__ = [
    "MAX_CUT_LINES",
    "CutRefused",
    "LineRaster",
    "blob_mask",
    "cut_blob_in_raster",
    "cut_fits_blob",
    "drop_cuts_that_no_longer_fit",
    "piece_of_word",
    "pieces_in_page",
    "read_cut_lines",
    "read_cut_owners",
    "set_cut_from_edit",
    "word_of_each_cut_pixel",
]
