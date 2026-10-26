"""Erasing a blob — noise the line's cutting left — and finding the noise a person may
want to erase. No database: the API's side is in ``test_calibration_api.EraseTests``."""

from types import SimpleNamespace

import numpy as np
from django.test import SimpleTestCase
from ninja.errors import HttpError
from PIL import Image

from api.services import calibration, export
from core.word_boundary.ink import Blob

WORD = {"id": 1, "text": "بِهِۦ", "paws": 1, "aya": "2:102"}


def draft_blob(ident: int = 5, **changes) -> dict:
    return {
        "id": ident,
        "x": 100,
        "y": 10,
        "w": 6,
        "h": 3,
        "area": 18,
        "role": "mark",
        "initial_role": "mark",
        "explicit": False,
        "ownership_explicit": False,
        "subtype": "ijamDot",
        "subtype_explicit": True,
        "exception": "uncertain",
        "allocations": [{"word_id": 1, "paws": 0}],
        "attention": ["ambiguous"],
        "decision_source": "search",
        **changes,
    }


def edit(blob: dict, **changes) -> dict:
    keys = ("id", "role", "explicit", "ownership_explicit", "subtype", "exception", "allocations")
    return {**{key: blob[key] for key in keys}, **changes}


class MergeTests(SimpleTestCase):
    def test_an_erased_blob_belongs_to_no_word_has_no_type_and_keeps_its_role(self):
        blob = draft_blob()
        calibration._merge_blob(blob, edit(blob, erased=True), {1: WORD})
        self.assertEqual(
            (blob["erased"], blob["role"], blob["allocations"], blob["subtype"], blob["exception"], blob["attention"]),
            (True, "mark", [], "", "", []),
        )

    def test_a_restored_blob_is_ink_again_and_remembers_it_was_erased(self):
        blob = draft_blob()
        calibration._merge_blob(blob, edit(blob, erased=True), {1: WORD})
        calibration._merge_blob(blob, edit(blob, erased=False), {1: WORD})
        self.assertIs(blob["erased"], False)
        untouched = draft_blob()
        calibration._merge_blob(untouched, edit(untouched), {1: WORD})
        self.assertNotIn("erased", untouched)

    def test_an_ornament_is_never_erased(self):
        ring = draft_blob(role="ornament", initial_role="ornament", allocations=[], exception="", subtype="")
        with self.assertRaises(HttpError):
            calibration._merge_blob(ring, edit(ring, erased=True), {1: WORD})


class SkipTests(SimpleTestCase):
    def test_erased_ink_teaches_nothing_and_asks_nothing(self):
        erased = draft_blob(erased=True, exception="")
        self.assertFalse(calibration._eligible(erased))
        self.assertFalse(calibration._typed(erased))
        row = {"line_number": 1, "blobs": [draft_blob(erased=True)], "words": [], "status": "exact"}
        self.assertEqual(calibration.exceptions({"lines": [row]}), [])

    def test_the_engine_is_handed_the_ink_without_it(self):
        blobs = [Blob(label, 0, 0, 5, 5, 25, preferred="body" if label == 1 else "mark-only") for label in (1, 2, 3)]
        ink = SimpleNamespace(components=list(blobs), bodies=blobs[:1], marks=blobs[1:])
        calibration._without(ink, {1, 3})
        self.assertEqual(([b.label for b in ink.components], ink.bodies, [b.label for b in ink.marks]), ([2], [], [2]))

    def test_an_erase_is_carried_to_the_same_blob_when_the_page_is_processed_again(self):
        fresh = draft_blob(exception="", allocations=[{"word_id": 1, "paws": 0}])
        earlier = draft_blob(erased=True, allocations=[], subtype="", exception="")
        document = {"stream": [WORD], "lines": [{"snapshot_id": "a", "blobs": [fresh], "words": []}]}
        carried, _ = calibration._carry_decisions(document, {"a": {"blobs": [earlier], "words": []}})
        self.assertTrue(carried)
        self.assertEqual((fresh["erased"], fresh["allocations"], fresh["subtype"]), (True, [], ""))


class ExportCutTests(SimpleTestCase):
    def test_the_cut_takes_the_fringe_around_the_blob_but_never_another_blob(self):
        raster = np.zeros((5, 7), dtype=np.int32)
        raster[2, 2] = 4  # the erased speck
        raster[2, 4] = 9  # a neighbour two pixels on
        mask = calibration.erased_mask(raster, {4})
        self.assertTrue(mask[1:4, 1:4].all())
        self.assertFalse(mask[2, 4])
        self.assertEqual(int(mask.sum()), 9)

    def test_the_mask_is_cut_where_it_lies_on_the_page(self):
        rgba = Image.new("RGBA", (20, 10), (0, 0, 0, 255))
        mask = np.zeros((4, 4), dtype=bool)
        mask[1, 2] = True
        # The mask's corner at page (105, 52); the image's at (100, 50).
        export.cut_erased(rgba, (100, 50), (mask, 105, 52))
        alpha = np.asarray(rgba.getchannel("A"))
        self.assertEqual(alpha[3, 7], 0)
        self.assertEqual(int((alpha == 0).sum()), 1)


def mark(ident: int, area: int, *, y: int = 40) -> dict:
    return {"id": ident, "x": 100 + 30 * ident, "y": y, "w": 10, "h": 10, "area": area, "role": "mark"}


def library(distances: dict[int, float]):
    """A library whose every kept shape is ``distances[id]`` from each mark."""
    return SimpleNamespace(
        can_propose=True,
        limit=0.27,
        roles_of=lambda features: [{"nearest_letter": distances[f], "nearest_mark": distances[f]} for f in features],
    )


class NoiseTests(SimpleTestCase):
    def setUp(self):
        self.row = {"snapshot_id": "a", "bbox": {"x": 0, "y": 0, "w": 1000, "h": 100}, "blobs": []}

    def found(self, blobs: list[dict], distances: dict[int, float], extra: list[int]) -> list[tuple[int, str]]:
        self.row["blobs"] = blobs
        marks = [(self.row, blob, blob["id"]) for blob in blobs]
        checks = {"a": {1: SimpleNamespace(extra=extra)}}
        return [(f["blob_id"], f["kind"]) for f in calibration._noise(library(distances), marks, checks)]

    def test_a_speck_is_noise_whatever_the_library_and_the_text_say(self):
        blobs = [mark(1, 150), mark(2, 160), mark(3, 140), mark(4, 3, y=0)]
        self.assertEqual(self.found(blobs, dict.fromkeys(range(1, 5), 0.0), []), [(4, "speck")])

    def test_the_dot_inside_a_pause_sign_is_no_speck(self):
        blobs = [mark(1, 150), mark(2, 160), mark(3, 140), mark(4, 20)]
        self.assertEqual(self.found(blobs, dict.fromkeys(range(1, 5), 0.0), []), [])

    def test_a_library_that_cannot_yet_tell_finds_specks_only(self):
        blobs = [mark(1, 150), mark(2, 160), mark(3, 3)]
        self.row["blobs"] = blobs
        unsure = SimpleNamespace(can_propose=False, limit=0.27, roles_of=lambda features: [])
        checks = {"a": {1: SimpleNamespace(extra=[1, 3])}}
        found = calibration._noise(unsure, [(self.row, blob, blob["id"]) for blob in blobs], checks)
        self.assertEqual([(f["blob_id"], f["kind"]) for f in found], [(3, "speck")])

    def test_a_stranger_is_noise_only_when_its_word_has_it_left_over(self):
        blobs = [mark(1, 150), mark(2, 160), mark(3, 140)]
        far = {1: 0.1, 2: 0.4, 3: 0.4}
        # Mark 2 is like nothing kept and left over; 3 is like nothing kept but its
        # word's text wants it; 1 is left over but like a kept shape.
        self.assertEqual(self.found(blobs, far, [1, 2]), [(2, "stranger")])
