"""Tests for the full data export (schema mushaf-export/v2).

Built on the drawn pages of ``test_calibration_api``: every line holds three
letter-sized rectangles (one word each), a dot over the first and an aya ring. The
line boxes start at page x 100, which is also where each line's PNG is cut, so a
PNG's x is the page's less 100 and its y the page's less the line's top.
"""

import io
import json
import uuid
import zipfile

import numpy as np
from django.test import Client
from PIL import Image

from api.models import Line, LineWord, Mushaf, VisibilityChoices
from api.services import calibration_snapshots as snapshots
from api.services import export
from api.tests.helpers import default_user
from api.tests.test_calibration_api import BODIES, DOT, FUSED, LINE_TOPS, RING, CalibrationApiTestCase, drawn_pages


class ExportTestCase(CalibrationApiTestCase):
    def export(self, client: Client | None = None, *, base: str = "mushafs", **query) -> zipfile.ZipFile:
        response = (client or self.client).get(f"/api/{base}/{self.mushaf.id}/export.zip", query)
        self.assertEqual(response.status_code, 200)
        self.assertIn("-export.zip", response["Content-Disposition"])
        # Consuming the stream closes the response: the test client wraps it so, as a
        # WSGI server would. Closing it again would close the test's database connection.
        data = b"".join(response.streaming_content)
        archive = zipfile.ZipFile(io.BytesIO(data))
        self.assertIsNone(archive.testzip())
        return archive

    @staticmethod
    def page(archive: zipfile.ZipFile, number: int) -> dict:
        return json.loads(archive.read(f"pages/page-{number:04d}.json"))

    @staticmethod
    def pixels(archive: zipfile.ZipFile, name: str) -> np.ndarray:
        return snapshots.decode_labels(Image.open(io.BytesIO(archive.read(name))))

    def confirm_typed(self) -> None:
        """Process page 1 and confirm it, its first line's dot typed a fatha by hand."""
        self.process(1)
        body = self.draft(self.document(1))
        dot = self.draft_blob_of(body, DOT[0])
        dot.update(subtype="fatha", subtype_explicit=True)
        self.assertEqual(self.confirm(1, body).status_code, 200)

    def draft_blob_of(self, body: dict, left: int) -> dict:
        document = self.document(1)
        ident = self.blob_at(document["lines"][0], left)["id"]
        return next(blob for blob in body["lines"][0]["blobs"] if blob["id"] == ident)


class ConfirmedPageTests(ExportTestCase):
    def setUp(self):
        super().setUp()
        self.confirm_typed()
        self.archive = self.export()
        self.line = self.page(self.archive, 1)["lines"][0]

    def test_a_confirmed_page_carries_every_blob_with_its_class_and_type(self):
        page = self.page(self.archive, 1)
        self.assertEqual((page["schema"], page["calibration"]["state"]), ("mushaf-export/v2", "confirmed"))
        self.assertFalse(page["calibration"]["stale"])
        blobs = self.line["blobs"]
        self.assertEqual(sorted(blob["class"] for blob in blobs), ["body", "body", "body", "mark", "ornament"])
        [mark] = [blob for blob in blobs if blob["class"] == "mark"]
        self.assertEqual((mark["type"], mark["type_by"], mark["words"]), ("fatha", "person", [1]))
        [ring] = [blob for blob in blobs if blob["class"] == "ornament"]
        self.assertEqual(ring["aya"], "2:5")
        self.assertNotIn("words", ring)
        bodies = sorted((blob for blob in blobs if blob["class"] == "body"), key=lambda blob: -blob["box"]["page"][0])
        self.assertEqual([blob["words"] for blob in bodies], [[1], [2], [3]])
        self.assertEqual({blob["paws"] for blob in bodies}, {1})

    def test_every_rectangle_comes_in_page_and_png_pixels(self):
        top = LINE_TOPS[0]
        self.assertEqual(self.line["png"]["crop"], [100, top, 600, 40])
        self.assertEqual((self.line["png"]["size"], self.line["png"]["offset"]), ([600, 40], [0, 0]))
        first = self.line["words"][0]
        self.assertEqual((first["id"], first["ref"], first["text"]), (1, "2:5:1", "w1"))
        self.assertEqual(first["box"]["page"], [BODIES[0][0], top, BODIES[0][1] - BODIES[0][0], 40])
        self.assertEqual(first["box"]["png"], [BODIES[0][0] - 100, 0, BODIES[0][1] - BODIES[0][0], 40])
        # Tight to its ink: the body's rectangle and the dot above it.
        self.assertEqual(first["ink"]["page"], [BODIES[0][0], top + 1, 30, 31])
        self.assertEqual(
            sorted(first["blobs"]), sorted(blob["id"] for blob in self.line["blobs"] if 1 in blob.get("words", []))
        )
        [aya] = self.line["ayat"]
        self.assertEqual((aya["sura"], aya["aya"], aya["ends_here"]), (2, 5, True))
        self.assertEqual(aya["box"]["png"], [RING[0] - 100, 0, 700 - RING[0], 40])

    def test_the_maps_say_which_word_and_blob_each_pixel_of_ink_is(self):
        self.assertEqual(
            self.line["maps"],
            {"words": "maps/words/page-0001/line-01.png", "blobs": "maps/blobs/page-0001/line-01.png"},
        )
        words = self.pixels(self.archive, self.line["maps"]["words"])
        blobs = self.pixels(self.archive, self.line["maps"]["blobs"])
        self.assertEqual(words.shape, (40, 600))
        by_left = {blob["box"]["page"][0]: blob["id"] for blob in self.line["blobs"]}
        for number, (left, right) in enumerate(BODIES, start=1):
            x, y = (left + right) // 2 - 100, 20  # inside the body's rectangle
            self.assertEqual((words[y, x], blobs[y, x]), (number, by_left[left]))
        self.assertEqual((words[2, DOT[0] + 2 - 100], blobs[2, DOT[0] + 2 - 100]), (1, by_left[DOT[0]]))
        # An ornament is ink of no word; background is nothing.
        self.assertEqual((words[15, RING[0] + 1 - 100], blobs[15, RING[0] + 1 - 100]), (0, by_left[RING[0]]))
        self.assertEqual((words[38, 5], blobs[38, 5]), (0, 0))

    def test_the_manifest_says_what_is_inside_and_how_to_read_it(self):
        manifest = json.loads(self.archive.read("manifest.json"))
        self.assertEqual(manifest["schema"], "mushaf-export/v2")
        self.assertEqual(manifest["types"], {"fatha": 1})
        self.assertEqual(
            [(entry["page"], entry["calibration"], entry["blobs"]) for entry in manifest["pages"]],
            [(1, "confirmed", 10), (2, "none", 0)],
        )
        self.assertEqual(manifest["totals"]["by_calibration"], {"confirmed": 1, "none": 1})
        self.assertIn("README.txt", self.archive.namelist())


class SourceTests(ExportTestCase):
    def test_a_page_never_calibrated_exports_its_stored_cuts_and_no_blobs(self):
        line = Line.objects.get(page__mushaf=self.mushaf, page__page_number=2, line_number=1)
        for position, (word, (left, right)) in enumerate(zip((7, 8, 9), BODIES, strict=True)):
            LineWord.objects.create(line=line, word_id=word, position=position, start_x=right, end_x=left)
        page = self.page(self.export(), 2)
        self.assertEqual(page["calibration"], {"state": "none"})
        first = page["lines"][0]
        self.assertEqual(
            [(word["id"], word["ref"]) for word in first["words"]], [(7, "2:7:1"), (8, "2:7:2"), (9, "2:7:3")]
        )
        self.assertEqual((first["blobs"], first["maps"]), ([], {"words": None, "blobs": None}))
        self.assertIsNone(first["words"][0]["ink"])

    def test_an_unconfirmed_draft_is_exported_and_says_so(self):
        self.process(1)
        page = self.page(self.export(), 1)
        self.assertEqual(page["calibration"]["state"], "draft")
        self.assertEqual(len(page["lines"][0]["blobs"]), 5)

    def test_editing_a_confirmed_page_is_said(self):
        self.confirm_typed()
        self.assertEqual(self.put(1, self.draft(self.document(1))).status_code, 200)
        self.assertEqual(self.page(self.export(), 1)["calibration"]["state"], "edited")

    def test_a_blob_two_words_share_is_split_between_them_at_their_boxes(self):
        with drawn_pages(fused_page=1):
            self.client.post(self.url(1, "/process"))
        body = self.draft(self.document(1))
        fused = self.draft_blob_of(body, FUSED[0])
        fused.update(
            role="body",
            explicit=True,
            ownership_explicit=True,
            allocations=[{"word_id": 2, "paws": 1}, {"word_id": 3, "paws": 1}],
        )
        with drawn_pages(fused_page=1):
            saved = self.put(1, {**body, "realign": True})
        self.assertEqual(saved.status_code, 200, saved.content)
        archive = self.export()
        line = self.page(archive, 1)["lines"][0]
        words = self.pixels(archive, line["maps"]["words"])
        middle = (FUSED[0] + FUSED[1]) // 2
        self.assertEqual((words[20, middle + 5 - 100], words[20, middle - 5 - 100]), (2, 3))
        [shared] = [blob for blob in line["blobs"] if blob["box"]["page"][0] == FUSED[0]]
        self.assertEqual((shared["words"], shared["paws"]), ([2, 3], 2))


class PlacementTests(ExportTestCase):
    def test_uniform_size_moves_every_png_rectangle_by_its_padding(self):
        self.confirm_typed()
        Mushaf.objects.filter(pk=self.mushaf.pk).update(export_uniform_size=True)
        Line.objects.filter(page__mushaf=self.mushaf, page__page_number=1, line_number=2).update(bbox_h=60)
        archive = self.export()
        page = self.page(archive, 1)
        line = page["lines"][0]
        self.assertEqual((line["png"]["size"], line["png"]["offset"]), ([600, 60], [0, 10]))
        self.assertEqual(line["words"][0]["box"]["png"][1], 10)
        self.assertEqual(self.pixels(archive, line["maps"]["words"])[30, (BODIES[0][0] + BODIES[0][1]) // 2 - 100], 1)
        # The line whose box changed is no longer what the page was processed from.
        self.assertTrue(page["calibration"]["stale"])

    def test_exported_line_images_travel_with_their_placement(self):
        self.confirm_typed()
        export.export_lines(user=default_user(), mushaf_id=self.mushaf.id, page_number=1)
        archive = self.export()
        png = self.page(archive, 1)["lines"][0]["png"]
        self.assertEqual((png["file"], png["exported"], png["outdated"]), ("lines/page-0001/line-01.png", True, False))
        self.assertEqual(Image.open(io.BytesIO(archive.read(png["file"]))).size, (600, 40))

        lean = self.export(images="false", maps="false")
        png = self.page(lean, 1)["lines"][0]["png"]
        self.assertEqual((png["file"], png["exported"]), (None, True))
        self.assertFalse(any(name.startswith(("lines/", "maps/")) for name in lean.namelist()))


class ScopeTests(ExportTestCase):
    def test_one_page_or_none_at_all(self):
        archive = self.export(page=2)
        self.assertEqual(
            sorted(name for name in archive.namelist() if name.startswith("pages/")), ["pages/page-0002.json"]
        )
        self.assertEqual(self.client.get(f"/api/mushafs/{self.mushaf.id}/export.zip", {"page": 9}).status_code, 404)

    def test_the_gallery_exports_a_published_mushaf_only(self):
        anonymous = Client()
        url = f"/api/gallery/{self.mushaf.id}/export.zip"
        self.assertEqual(anonymous.get(url).status_code, 404)
        Mushaf.objects.filter(pk=self.mushaf.pk).update(visibility=VisibilityChoices.PUBLISHED)
        self.assertIn("pages/page-0001.json", self.export(anonymous, base="gallery").namelist())

    def test_someone_elses_private_mushaf_is_not_found(self):
        self.assertEqual(self.client.get(f"/api/mushafs/{uuid.uuid4()}/export.zip").status_code, 404)
