"""Tests for api.services.mushaf (ORM + file handling)."""

import uuid

from django.core.files.uploadedfile import SimpleUploadedFile
from ninja.errors import HttpError

from api.models import Mushaf, Page, Qiraa, Template
from api.services import mushaf as mushaf_service
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


class RenderPageImageTests(MediaTestCase):
    def setUp(self):
        self.mushaf_id = _create("R", pages=10)["id"]

    def test_renders_png(self):
        png = mushaf_service.render_page_image(self.mushaf_id, 1)
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_page_out_of_range(self):
        with self.assertRaises(HttpError):
            mushaf_service.render_page_image(self.mushaf_id, 999)
