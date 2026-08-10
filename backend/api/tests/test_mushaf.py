"""Tests for api.services.mushaf (ORM + file handling)."""

import uuid

from django.core.files.uploadedfile import SimpleUploadedFile
from ninja.errors import HttpError

from api.models import CountingSystem, Line, Mushaf, Page, Qiraa, Segment, Template
from api.services import mushaf as mushaf_service
from api.services import suras
from api.tests.helpers import MediaTestCase, make_pdf_bytes, make_png_bytes


def _pdf_upload(num_pages: int = 10, name: str = "m.pdf") -> SimpleUploadedFile:
    return SimpleUploadedFile(name, make_pdf_bytes(num_pages), content_type="application/pdf")


def _create(name: str = "M", pages: int = 10, qiraa: str | None = None):
    return mushaf_service.create_mushaf(
        pdf_file=_pdf_upload(pages),
        name=name,
        qiraa=qiraa,
        first_quran_pdf_page=1,
        last_quran_pdf_page=None,
    )["mushaf"]


class CreateMushafTests(MediaTestCase):
    def test_creates_and_defaults_last_page(self):
        result = mushaf_service.create_mushaf(
            pdf_file=_pdf_upload(10),
            name="Madinah",
            qiraa=None,
            first_quran_pdf_page=1,
            last_quran_pdf_page=None,
        )
        data = result["mushaf"]
        self.assertEqual(data["pdf_page_count"], 10)
        self.assertEqual(data["last_quran_pdf_page"], 10)
        self.assertEqual(data["logical_page_count"], 10)
        self.assertEqual(data["processed_page_count"], 0)
        self.assertFalse(result["warnings"]["duplicate_file"])
        self.assertTrue(Mushaf.objects.filter(name="Madinah").exists())

    def test_duplicate_name_conflicts(self):
        _create("Dup")
        with self.assertRaises(HttpError):
            _create("Dup")

    def test_duplicate_file_warns(self):
        shared = make_pdf_bytes(5)
        mushaf_service.create_mushaf(
            pdf_file=SimpleUploadedFile("a.pdf", shared),
            name="A",
            qiraa=None,
            first_quran_pdf_page=1,
            last_quran_pdf_page=None,
        )
        result = mushaf_service.create_mushaf(
            pdf_file=SimpleUploadedFile("b.pdf", shared),
            name="B",
            qiraa=None,
            first_quran_pdf_page=1,
            last_quran_pdf_page=None,
        )
        self.assertTrue(result["warnings"]["duplicate_file"])

    def test_links_qiraa(self):
        Qiraa.objects.create(name="hafs", name_arabic="حفص")
        self.assertEqual(_create("WithQiraa", qiraa="hafs")["qiraa"], "hafs")

    def test_invalid_bounds(self):
        with self.assertRaises(HttpError):
            mushaf_service.create_mushaf(
                pdf_file=_pdf_upload(3),
                name="Bad",
                qiraa=None,
                first_quran_pdf_page=1,
                last_quran_pdf_page=99,  # exceeds the 3-page PDF
            )


class ReadDeleteTests(MediaTestCase):
    def test_get_dict(self):
        created = _create("Get")
        self.assertEqual(mushaf_service.get_mushaf_dict(created["id"])["name"], "Get")

    def test_get_dict_missing(self):
        with self.assertRaises(HttpError):
            mushaf_service.get_mushaf_dict(uuid.uuid4())

    def test_list_newest_first(self):
        _create("First")
        _create("Second")
        names = [m["name"] for m in mushaf_service.list_mushafs()]
        self.assertEqual(names, ["Second", "First"])

    def test_delete(self):
        created = _create("ToDelete")
        mushaf_service.delete_mushaf(created["id"])
        self.assertFalse(Mushaf.objects.filter(id=created["id"]).exists())


class UpdateMushafTests(MediaTestCase):
    def test_updates_name_and_bounds(self):
        created = _create("Up", pages=10)
        updated = mushaf_service.update_mushaf(
            created["id"],
            {"name": "Up2", "first_quran_pdf_page": 3, "last_quran_pdf_page": 8},
        )
        self.assertEqual(updated["name"], "Up2")
        self.assertEqual(updated["first_quran_pdf_page"], 3)
        self.assertEqual(updated["last_quran_pdf_page"], 8)
        self.assertEqual(updated["logical_page_count"], 6)

    def test_partial_update_leaves_other_fields(self):
        created = _create("Partial", pages=10)
        updated = mushaf_service.update_mushaf(created["id"], {"first_quran_pdf_page": 2})
        self.assertEqual(updated["first_quran_pdf_page"], 2)
        self.assertEqual(updated["last_quran_pdf_page"], 10)

    def test_qiraa_relink_then_clear(self):
        Qiraa.objects.create(name="hafs", name_arabic="حفص")
        created = _create("Q", qiraa="hafs")
        relinked = mushaf_service.update_mushaf(created["id"], {"qiraa": "hafs"})
        self.assertEqual(relinked["qiraa"], "hafs")
        cleared = mushaf_service.update_mushaf(created["id"], {"qiraa": None})
        self.assertIsNone(cleared["qiraa"])

    def test_duplicate_name_conflicts(self):
        _create("Existing")
        other = _create("Other")
        with self.assertRaises(HttpError) as ctx:
            mushaf_service.update_mushaf(other["id"], {"name": "Existing"})
        self.assertEqual(ctx.exception.status_code, 409)

    def test_invalid_bounds_rejected(self):
        created = _create("BadBounds", pages=5)
        with self.assertRaises(HttpError) as ctx:
            mushaf_service.update_mushaf(created["id"], {"last_quran_pdf_page": 99})
        self.assertEqual(ctx.exception.status_code, 400)

    def test_bounds_locked_after_processing(self):
        created = _create("Locked", pages=10)
        mushaf = Mushaf.objects.get(id=created["id"])
        Page.objects.create(mushaf=mushaf, page_number=1)
        with self.assertRaises(HttpError) as ctx:
            mushaf_service.update_mushaf(created["id"], {"first_quran_pdf_page": 2})
        self.assertEqual(ctx.exception.status_code, 409)

    def test_renaming_with_existing_pages_is_allowed(self):
        created = _create("Renamable", pages=10)
        mushaf = Mushaf.objects.get(id=created["id"])
        Page.objects.create(mushaf=mushaf, page_number=1)
        updated = mushaf_service.update_mushaf(created["id"], {"name": "Renamed"})
        self.assertEqual(updated["name"], "Renamed")


class TemplateTests(MediaTestCase):
    def setUp(self):
        self.mushaf_id = _create("T")["id"]

    def test_upsert_creates_then_updates(self):
        first = mushaf_service.upsert_template(
            mushaf_id=self.mushaf_id,
            template_type="sura_header",
            image=SimpleUploadedFile("t.png", make_png_bytes(), "image/png"),
            ignore_x=1,
            ignore_y=2,
            ignore_w=3,
            ignore_h=4,
        )
        self.assertEqual(first["ignore_rects"], {"x": 1, "y": 2, "w": 3, "h": 4})
        mushaf_service.upsert_template(
            mushaf_id=self.mushaf_id,
            template_type="sura_header",
            image=SimpleUploadedFile("t2.png", make_png_bytes(), "image/png"),
            ignore_x=None,
            ignore_y=None,
            ignore_w=None,
            ignore_h=None,
        )
        self.assertEqual(Template.objects.filter(type="sura_header").count(), 1)

    def test_invalid_type(self):
        with self.assertRaises(HttpError):
            mushaf_service.upsert_template(
                mushaf_id=self.mushaf_id,
                template_type="bogus",
                image=SimpleUploadedFile("t.png", make_png_bytes(), "image/png"),
                ignore_x=None,
                ignore_y=None,
                ignore_w=None,
                ignore_h=None,
            )

    def _upsert(self, template_type, image=True, **ignore):
        return mushaf_service.upsert_template(
            mushaf_id=self.mushaf_id,
            template_type=template_type,
            image=SimpleUploadedFile("t.png", make_png_bytes(), "image/png") if image else None,
            ignore_x=ignore.get("x"),
            ignore_y=ignore.get("y"),
            ignore_w=ignore.get("w"),
            ignore_h=ignore.get("h"),
        )

    def test_image_url_is_absolute(self):
        out = self._upsert("sura_header")
        self.assertTrue(out["image_url"].startswith("/media/"))

    def test_list_templates(self):
        self._upsert("sura_header")
        self._upsert("aya_separator")
        rows = mushaf_service.list_templates(self.mushaf_id)
        self.assertEqual({r["type"] for r in rows}, {"sura_header", "aya_separator"})
        self.assertTrue(all(r["image_url"].startswith("/media/") for r in rows))

    def test_ignore_only_update_keeps_image(self):
        first = self._upsert("aya_separator")
        updated = self._upsert("aya_separator", image=False, x=5, y=6, w=7, h=8)
        self.assertEqual(updated["ignore_rects"], {"x": 5, "y": 6, "w": 7, "h": 8})
        self.assertEqual(updated["image_url"], first["image_url"])

    def test_image_required_to_create(self):
        with self.assertRaises(HttpError):
            self._upsert("sura_header", image=False)


class MushafDetailTests(MediaTestCase):
    def setUp(self):
        suras.seed_reference_data()

    def test_includes_counting_system_and_source(self):
        kufi = CountingSystem.objects.get(name_arabic="الكوفي")
        # hafs + its Kufan counting system come from the seed now (seeded name is "Hafs").
        created = _create("Detail", qiraa="Hafs")
        detail = mushaf_service.get_mushaf_detail(created["id"])
        self.assertEqual(detail["counting_system"]["name"], kufi.name)
        self.assertEqual(detail["counting_system"]["total_ayat"], 6236)  # canonical Kufan total
        self.assertTrue(detail["pdf_url"].startswith("/media/"))
        self.assertGreater(detail["pdf_file_size"], 0)
        self.assertEqual(detail["pdf_original_name"], "m.pdf")

    def test_no_qiraa_yields_null_counting_system(self):
        detail = mushaf_service.get_mushaf_detail(_create("NoQ")["id"])
        self.assertIsNone(detail["counting_system"])


class MushafStatsTests(MediaTestCase):
    def test_aggregates_detection_counts(self):
        mushaf = Mushaf.objects.get(id=_create("Stats")["id"])
        page = Page.objects.create(mushaf=mushaf, page_number=1)

        def _line(n, line_type):
            return Line.objects.create(page=page, line_number=n, type=line_type, bbox_x=0, bbox_y=0, bbox_w=1, bbox_h=1)

        _line(1, "sura_header")
        _line(2, "besmella")
        text = _line(3, "text")
        Segment.objects.create(line=text, segment_order=1, bbox_x=0, bbox_w=1, has_separator=True, aya_number=1)
        Segment.objects.create(line=text, segment_order=2, bbox_x=1, bbox_w=1, has_separator=False)

        stats = mushaf_service.mushaf_stats(mushaf.id)
        self.assertEqual(stats["lines_cut"], 3)
        self.assertEqual(stats["sura_headers"], 1)
        self.assertEqual(stats["besmella_lines"], 1)
        self.assertEqual(stats["segments"], 2)
        self.assertEqual(stats["ayat_found"], 1)  # only the has_separator segment
        self.assertEqual(stats["exported_pngs"], 0)

    def test_empty_mushaf_is_all_zero(self):
        stats = mushaf_service.mushaf_stats(_create("Empty")["id"])
        self.assertEqual(set(stats.values()), {0})


class RenderPageImageTests(MediaTestCase):
    def setUp(self):
        self.mushaf_id = _create("R", pages=10)["id"]

    def test_renders_png(self):
        png = mushaf_service.render_page_image(self.mushaf_id, 1)
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_page_out_of_range(self):
        with self.assertRaises(HttpError):
            mushaf_service.render_page_image(self.mushaf_id, 999)
