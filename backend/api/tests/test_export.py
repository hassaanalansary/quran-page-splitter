"""Tests for export.export_lines (transparent line PNGs) + the coordinates document."""

import zipfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from ninja.errors import HttpError
from PIL import Image

from api.models import ActivityEvent, ActivityTypeChoices, ProcessingRun
from api.services import coordinates, export, suras
from api.services import mushaf as mushaf_service
from api.tests.helpers import (
    MediaTestCase,
    bare_mushaf,
    default_user,
    make_pdf_bytes,
    make_png_bytes,
)


class ExportLinesTests(MediaTestCase):
    def setUp(self):
        suras.seed_reference_data()
        created = mushaf_service.create_mushaf(
            pdf_file=SimpleUploadedFile("m.pdf", make_pdf_bytes(2), "application/pdf"),
            name="Export",
            qiraa=None,
            first_quran_pdf_page=1,
            last_quran_pdf_page=None,
            owner=default_user(),
        )
        self.mushaf = mushaf_service.get_mushaf(created["mushaf"]["id"], user=default_user())
        run = ProcessingRun.objects.create(
            mushaf=self.mushaf,
            settings={"start_sura": 1, "start_aya": 1},
            page_range_start=1,
            page_range_end=1,
            status="completed",
        )
        self.page = coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=1,
            run=run,
            coord_page={
                "crop_box": {"x": 0, "y": 0, "w": 400, "h": 400},
                "lines": [
                    {
                        "line_number": 1,
                        "type": "sura_header",
                        "sura_number": 1,
                        "line_bbox": {"x": 100, "y": 100, "w": 200, "h": 50},
                    }
                ],
            },
        )

    def test_exports_png_and_sets_path(self):
        result = export.export_lines(mushaf_id=self.mushaf.id, page_number=1, user=default_user())
        self.assertEqual(result["exported"], 1)
        line = self.page.lines.get(line_number=1)
        self.assertTrue(line.line_png)
        self.assertTrue(line.line_png.name.endswith(".png"))
        event = ActivityEvent.objects.get(mushaf=self.mushaf, type=ActivityTypeChoices.LINES_EXPORTED)
        self.assertEqual(event.payload, {"page_number": 1, "exported": 1})

    def test_export_applies_erase_stroke(self):
        self.page.lines.get(line_number=1).erase_strokes.create(brush_size=10, points=[[120, 120], [140, 140]])
        result = export.export_lines(mushaf_id=self.mushaf.id, page_number=1, user=default_user())
        self.assertEqual(result["exported"], 1)

    def test_missing_page_rejected(self):
        with self.assertRaises(HttpError):
            export.export_lines(mushaf_id=self.mushaf.id, page_number=5, user=default_user())

    def test_exported_png_url_on_page_data(self):
        export.export_lines(mushaf_id=self.mushaf.id, page_number=1, user=default_user())
        data = coordinates.page_to_dict(self.page)
        self.assertTrue(
            data["lines"][0]["line_png"].startswith(f"/media/mushafs/{self.mushaf.id}/lines/")
        )

    def test_zip_bundles_exported_lines(self):
        export.export_lines(mushaf_id=self.mushaf.id, page_number=1, user=default_user())
        filename, buffer = export.lines_zip(mushaf_id=self.mushaf.id, user=default_user())
        self.assertEqual(filename, "Export-lines.zip")
        with zipfile.ZipFile(buffer) as archive:
            self.assertEqual(archive.namelist(), ["page-0001/line-01.png"])
            self.assertTrue(archive.read("page-0001/line-01.png").startswith(b"\x89PNG"))
        buffer.close()

    def test_zip_of_one_page_skips_the_others(self):
        export.export_lines(mushaf_id=self.mushaf.id, page_number=1, user=default_user())
        filename, buffer = export.lines_zip(mushaf_id=self.mushaf.id, page_number=1, user=default_user())
        self.assertEqual(filename, "Export-p0001-lines.zip")
        buffer.close()
        with self.assertRaises(HttpError):
            export.lines_zip(mushaf_id=self.mushaf.id, page_number=2, user=default_user())

    def test_zip_without_any_export_rejected(self):
        with self.assertRaises(HttpError):
            export.lines_zip(mushaf_id=self.mushaf.id, user=default_user())


class CoordinatesJsonTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("Coord Doc")
        run = ProcessingRun.objects.create(
            mushaf=self.mushaf,
            settings={"start_sura": 1, "start_aya": 1},
            page_range_start=1,
            page_range_end=1,
            status="completed",
        )
        coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=1,
            run=run,
            coord_page={
                "crop_box": {"x": 0, "y": 0, "w": 400, "h": 400},
                "lines": [
                    {
                        "line_number": 1,
                        "type": "text",
                        "line_bbox": {"x": 5, "y": 10, "w": 200, "h": 30},
                        "segments": [
                            {"bbox": {"x": 100, "w": 100}, "has_separator": True, "aya_number": 1, "sura_number": 1},
                            {"bbox": {"x": 5, "w": 90}, "has_separator": False, "aya_number": 2, "sura_number": 1},
                        ],
                    },
                    {
                        "line_number": 2,
                        "type": "text",
                        "line_bbox": {"x": 5, "y": 45, "w": 200, "h": 30},
                        "segments": [
                            {"bbox": {"x": 5, "w": 195}, "has_separator": True, "aya_number": 2, "sura_number": 1},
                        ],
                    },
                ],
            },
        )

    def test_document_shape_and_aya_grouping(self):
        filename, doc = export.coordinates_json(self.mushaf.id, user=default_user())
        self.assertEqual(filename, "Coord-Doc-coordinates.json")  # space sanitized
        self.assertEqual(doc["schema"], "aya-bbox/v1")
        self.assertEqual(doc["mushaf"]["name"], "Coord Doc")

        [page] = doc["pages"]
        self.assertEqual(page["page"], 1)
        self.assertEqual([a["aya"] for a in page["ayas"]], [1, 2])  # reading order
        by_key = {(a["sura"], a["aya"]): a for a in page["ayas"]}
        # aya 1: one segment; x/w from the segment, y/h from its line
        self.assertEqual(by_key[(1, 1)]["rects"], [{"x": 100, "y": 10, "w": 100, "h": 30}])
        # aya 2 spans lines 1 and 2 → both rects grouped under one entry
        self.assertEqual(len(by_key[(1, 2)]["rects"]), 2)
        self.assertEqual(by_key[(1, 2)]["rects"][1], {"x": 5, "y": 45, "w": 195, "h": 30})

    def test_pages_without_ayas_are_omitted(self):
        empty = bare_mushaf("Coord Empty")
        _, doc = export.coordinates_json(empty.id, user=default_user())
        self.assertEqual(doc["pages"], [])


class UniformSizeExportTests(MediaTestCase):
    """`Mushaf.export_uniform_size`: every line of a page exported at one size.

    The rule that matters is that padding only ever *adds* transparent space —
    a short line must come out with its pixels intact, never cropped to fit.
    """

    def setUp(self):
        suras.seed_reference_data()
        created = mushaf_service.create_mushaf(
            pdf_file=SimpleUploadedFile("m.pdf", make_pdf_bytes(2), "application/pdf"),
            name="Uniform",
            qiraa=None,
            first_quran_pdf_page=1,
            last_quran_pdf_page=None,
            owner=default_user(),
        )
        self.mushaf = mushaf_service.get_mushaf(created["mushaf"]["id"], user=default_user())
        run = ProcessingRun.objects.create(
            mushaf=self.mushaf,
            settings={"start_sura": 1, "start_aya": 1},
            page_range_start=1,
            page_range_end=1,
            status="completed",
        )
        # Two lines of deliberately different height on the same page.
        self.page = coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=1,
            run=run,
            coord_page={
                "crop_box": {"x": 0, "y": 0, "w": 400, "h": 400},
                "lines": [
                    {
                        "line_number": 1,
                        "type": "text",
                        "line_bbox": {"x": 100, "y": 40, "w": 200, "h": 40},
                    },
                    {
                        "line_number": 2,
                        "type": "text",
                        "line_bbox": {"x": 100, "y": 120, "w": 200, "h": 90},
                    },
                ],
            },
        )

    def _sizes(self) -> list[tuple[int, int]]:
        export.export_lines(mushaf_id=self.mushaf.id, page_number=1, user=default_user())
        sizes = []
        for line in self.page.lines.order_by("line_number"):
            with line.line_png.open("rb") as handle:
                sizes.append(Image.open(handle).size)
        return sizes

    def _set_uniform(self, value: bool) -> None:
        self.mushaf.export_uniform_size = value
        self.mushaf.save(update_fields=["export_uniform_size"])

    def test_off_by_default_and_heights_differ(self):
        self.assertFalse(self.mushaf.export_uniform_size)
        heights = [h for _, h in self._sizes()]
        self.assertNotEqual(heights[0], heights[1])

    def test_on_gives_every_line_the_same_size(self):
        self._set_uniform(True)
        sizes = self._sizes()
        self.assertEqual(sizes[0], sizes[1])

    def test_the_canvas_matches_the_tallest_line_and_crops_nothing(self):
        tall = max(h for _, h in self._sizes())
        self._set_uniform(True)
        padded = self._sizes()
        self.assertTrue(all(h == tall for _, h in padded), "canvas is not the tallest line's height")

    def test_the_padding_is_transparent_and_the_line_is_centred(self):
        self._set_uniform(True)
        export.export_lines(mushaf_id=self.mushaf.id, page_number=1, user=default_user())
        short = self.page.lines.get(line_number=1)
        with short.line_png.open("rb") as handle:
            rgba = Image.open(handle).convert("RGBA")
            rgba.load()

        alpha = rgba.getchannel("A")
        # The line was 40px tall on a canvas of 90 -> 25 blank rows top and bottom.
        pad = (rgba.height - 40) // 2
        self.assertGreater(pad, 0)
        top_band = alpha.crop((0, 0, rgba.width, pad))
        bottom_band = alpha.crop((0, rgba.height - pad, rgba.width, rgba.height))
        self.assertEqual(top_band.getextrema(), (0, 0), "top padding is not fully transparent")
        self.assertEqual(bottom_band.getextrema(), (0, 0), "bottom padding is not fully transparent")


class MediaLayoutTests(MediaTestCase):
    """Everything a mushaf owns lives under mushafs/<id>/ — except the shared PDF."""

    def setUp(self):
        suras.seed_reference_data()
        created = mushaf_service.create_mushaf(
            pdf_file=SimpleUploadedFile("m.pdf", make_pdf_bytes(2), "application/pdf"),
            name="Layout",
            qiraa=None,
            first_quran_pdf_page=1,
            last_quran_pdf_page=None,
            owner=default_user(),
        )
        self.mushaf = mushaf_service.get_mushaf(created["mushaf"]["id"], user=default_user())

    def test_the_pdf_is_content_addressed_outside_the_mushaf_directory(self):
        """Shared by hash so gallery copies and repeat uploads stay free."""
        self.assertEqual(self.mushaf.pdf_file.name, f"pdfs/{self.mushaf.pdf_sha256}.pdf")

    def test_the_thumbnail_lives_in_the_mushaf_directory(self):
        self.assertEqual(self.mushaf.thumbnail.name, f"mushafs/{self.mushaf.id}/thumbnail.png")

    def test_templates_live_in_the_mushaf_directory(self):
        mushaf_service.upsert_template(
            user=default_user(),
            mushaf_id=self.mushaf.id,
            template_type="sura_header",
            image=SimpleUploadedFile("t.png", make_png_bytes((20, 20)), "image/png"),
            ignore_x=None,
            ignore_y=None,
            ignore_w=None,
            ignore_h=None,
        )
        template = self.mushaf.templates.get(type="sura_header")
        self.assertEqual(template.image.name, f"mushafs/{self.mushaf.id}/templates/sura_header.png")

    def test_line_pngs_mirror_the_zip_layout(self):
        run = ProcessingRun.objects.create(
            mushaf=self.mushaf,
            settings={"start_sura": 1, "start_aya": 1},
            page_range_start=1,
            page_range_end=1,
            status="completed",
        )
        page = coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=1,
            run=run,
            coord_page={
                "crop_box": {"x": 0, "y": 0, "w": 400, "h": 400},
                "lines": [{"line_number": 3, "type": "text", "line_bbox": {"x": 10, "y": 20, "w": 200, "h": 40}}],
            },
        )
        export.export_lines(mushaf_id=self.mushaf.id, page_number=1, user=default_user())

        line = page.lines.get(line_number=3)
        self.assertEqual(
            line.line_png.name,
            f"mushafs/{self.mushaf.id}/lines/page-0001/line-03.png",
        )
