"""The portable work bundle: export, import, and what import refuses.

The load-bearing property is the sha256 contract — a bundle's geometry is only
meaningful over the PDF it came from, so importing onto a different PDF must
fail loudly rather than produce plausible-looking nonsense.
"""

import io
import json
import zipfile

from django.core.files.uploadedfile import SimpleUploadedFile
from ninja.errors import HttpError

from api.models import EraseStroke, Line, Mushaf, Page, Segment, Template
from api.services import bundle
from api.services import mushaf as mushaf_service
from api.tests.helpers import ApiTestCase, MediaTestCase, default_user, make_pdf_bytes, make_png_bytes

SHARED_PDF = make_pdf_bytes(4)
OTHER_PDF = make_pdf_bytes(7)


def _create(owner, name, pdf_bytes=SHARED_PDF):
    return mushaf_service.create_mushaf(
        owner=owner,
        pdf_file=SimpleUploadedFile("m.pdf", pdf_bytes, "application/pdf"),
        name=name,
        qiraa=None,
        first_quran_pdf_page=1,
        last_quran_pdf_page=None,
    )["mushaf"]


def _with_work(owner, name, pdf_bytes=SHARED_PDF):
    """A mushaf with a small but complete tree, plus a template."""
    mushaf = Mushaf.objects.get(id=_create(owner, name, pdf_bytes)["id"])
    for page_number in (1, 2):
        page = Page.objects.create(
            mushaf=mushaf,
            page_number=page_number,
            bbox_x=11,
            bbox_y=22,
            bbox_w=505,
            bbox_h=707,
            reviewed=page_number == 1,
        )
        for line_number in (1, 2, 3):
            line = Line.objects.create(
                page=page,
                line_number=line_number,
                bbox_x=11,
                bbox_y=30 * line_number,
                bbox_w=480,
                bbox_h=42,
            )
            Segment.objects.create(
                line=line,
                segment_order=1,
                bbox_x=11,
                bbox_w=210,
                has_separator=True,
                aya_number=page_number * 10 + line_number,
            )
            EraseStroke.objects.create(line=line, brush_size=7, points=[[1, 2], [3, 4]])
    mushaf_service.upsert_template(
        user=owner,
        mushaf_id=mushaf.id,
        template_type="sura_header",
        image=SimpleUploadedFile("t.png", make_png_bytes((30, 30)), "image/png"),
        ignore_x=1,
        ignore_y=2,
        ignore_w=3,
        ignore_h=4,
    )
    return mushaf


def _export_bytes(mushaf, user):
    _, buffer = bundle.build(mushaf.id, user=user)
    data = buffer.read()
    buffer.close()
    return data


def _upload(data: bytes, name="work.zip"):
    return SimpleUploadedFile(name, data, "application/zip")


class ExportTests(MediaTestCase):
    def setUp(self):
        self.alice = default_user()

    def test_bundle_contains_the_expected_members(self):
        mushaf = _with_work(self.alice, "Exported")
        with zipfile.ZipFile(io.BytesIO(_export_bytes(mushaf, self.alice))) as archive:
            names = set(archive.namelist())
        self.assertIn("manifest.json", names)
        self.assertIn("pages.json", names)
        self.assertIn("templates/sura_header.png", names)

    def test_manifest_names_the_pdf_by_hash(self):
        mushaf = _with_work(self.alice, "Hashed")
        with zipfile.ZipFile(io.BytesIO(_export_bytes(mushaf, self.alice))) as archive:
            manifest = json.loads(archive.read("manifest.json"))

        self.assertEqual(manifest["schema"], "mushaf-work/v1")
        self.assertEqual(manifest["mushaf"]["pdf_sha256"], mushaf.pdf_sha256)
        self.assertEqual(
            manifest["counts"],
            {
                "pages": 2,
                "lines": 6,
                "segments": 6,
                "erase_strokes": 6,
            },
        )

    def test_the_pdf_itself_is_not_in_the_bundle(self):
        """A bundle must stay small enough to email; the hash stands in for the PDF."""
        mushaf = _with_work(self.alice, "NoPdf")
        data = _export_bytes(mushaf, self.alice)
        self.assertNotIn(b"%PDF", data)
        self.assertLess(len(data), 200_000)


class RoundTripTests(MediaTestCase):
    def setUp(self):
        self.alice = default_user()

    def test_work_survives_an_export_import_round_trip(self):
        source = _with_work(self.alice, "Source")
        data = _export_bytes(source, self.alice)
        # A second mushaf built from the *same* PDF — the supported case.
        target = Mushaf.objects.get(id=_create(self.alice, "Target")["id"])

        result = bundle.apply_bundle(target.id, _upload(data), user=self.alice)

        self.assertEqual(result["pages_imported"], 2)
        self.assertEqual(result["lines_imported"], 6)
        self.assertEqual(target.pages.count(), source.pages.count())
        self.assertEqual(
            Line.objects.filter(page__mushaf=target).count(),
            Line.objects.filter(page__mushaf=source).count(),
        )
        self.assertEqual(
            Segment.objects.filter(line__page__mushaf=target).count(),
            Segment.objects.filter(line__page__mushaf=source).count(),
        )
        self.assertEqual(
            EraseStroke.objects.filter(line__page__mushaf=target).count(),
            EraseStroke.objects.filter(line__page__mushaf=source).count(),
        )

    def test_geometry_and_aya_numbers_match_exactly(self):
        source = _with_work(self.alice, "Source")
        data = _export_bytes(source, self.alice)
        target = Mushaf.objects.get(id=_create(self.alice, "Target")["id"])

        bundle.apply_bundle(target.id, _upload(data), user=self.alice)

        page = target.pages.get(page_number=2)
        self.assertEqual((page.bbox_x, page.bbox_y, page.bbox_w, page.bbox_h), (11, 22, 505, 707))
        self.assertFalse(page.reviewed)
        self.assertTrue(target.pages.get(page_number=1).reviewed)

        for line_number in (1, 2, 3):
            line = Line.objects.get(page=page, line_number=line_number)
            self.assertEqual(line.bbox_y, 30 * line_number)
            self.assertEqual(
                list(line.segments.values_list("aya_number", flat=True)),
                [20 + line_number],
                f"line {line_number} kept the wrong segment",
            )
            self.assertEqual(line.erase_strokes.count(), 1)

    def test_templates_survive_the_round_trip(self):
        source = _with_work(self.alice, "Source")
        data = _export_bytes(source, self.alice)
        target = Mushaf.objects.get(id=_create(self.alice, "Target")["id"])

        bundle.apply_bundle(target.id, _upload(data), user=self.alice)

        template = Template.objects.get(mushaf=target, type="sura_header")
        self.assertEqual(template.ignore_rects, {"x": 1, "y": 2, "w": 3, "h": 4})
        self.assertTrue(template.image)

    def test_import_leaves_the_source_untouched(self):
        source = _with_work(self.alice, "Source")
        data = _export_bytes(source, self.alice)
        target = Mushaf.objects.get(id=_create(self.alice, "Target")["id"])

        bundle.apply_bundle(target.id, _upload(data), user=self.alice)
        target.pages.all().delete()

        self.assertEqual(source.pages.count(), 2)


class ImportRefusalTests(MediaTestCase):
    def setUp(self):
        self.alice = default_user()
        self.source = _with_work(self.alice, "Source")
        self.data = _export_bytes(self.source, self.alice)

    def test_a_different_pdf_is_refused_with_both_hashes(self):
        """The whole point of the format's sha256 contract."""
        other = Mushaf.objects.get(id=_create(self.alice, "DifferentPdf", OTHER_PDF)["id"])

        with self.assertRaises(HttpError) as ctx:
            bundle.apply_bundle(other.id, _upload(self.data), user=self.alice)

        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn(self.source.pdf_sha256[:12], str(ctx.exception))
        self.assertIn(other.pdf_sha256[:12], str(ctx.exception))
        self.assertEqual(other.pages.count(), 0)

    def test_existing_pages_block_import_unless_replacing(self):
        target = _with_work(self.alice, "AlreadyWorked")

        with self.assertRaises(HttpError) as ctx:
            bundle.apply_bundle(target.id, _upload(self.data), user=self.alice)
        self.assertEqual(ctx.exception.status_code, 409)

        result = bundle.apply_bundle(target.id, _upload(self.data), user=self.alice, replace=True)
        self.assertEqual(result["pages_imported"], 2)
        self.assertEqual(target.pages.count(), 2)

    def test_an_unknown_schema_is_refused(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("manifest.json", json.dumps({"schema": "mushaf-work/v99"}))
            archive.writestr("pages.json", json.dumps({"pages": []}))
        target = Mushaf.objects.get(id=_create(self.alice, "Target")["id"])

        with self.assertRaises(HttpError) as ctx:
            bundle.apply_bundle(target.id, _upload(buffer.getvalue()), user=self.alice)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_a_non_zip_is_refused(self):
        target = Mushaf.objects.get(id=_create(self.alice, "Target")["id"])
        with self.assertRaises(HttpError) as ctx:
            bundle.apply_bundle(target.id, _upload(b"definitely not a zip"), user=self.alice)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_a_zip_missing_pages_json_is_refused(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("manifest.json", json.dumps({"schema": bundle.SCHEMA}))
        target = Mushaf.objects.get(id=_create(self.alice, "Target")["id"])

        with self.assertRaises(HttpError) as ctx:
            bundle.apply_bundle(target.id, _upload(buffer.getvalue()), user=self.alice)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_you_cannot_import_into_someone_elses_mushaf(self):
        from api.tests.helpers import make_user

        bob = make_user("bob@example.com")
        target = Mushaf.objects.get(id=_create(self.alice, "Mine")["id"])

        with self.assertRaises(HttpError) as ctx:
            bundle.apply_bundle(target.id, _upload(self.data), user=bob)
        self.assertEqual(ctx.exception.status_code, 404)


class HostileArchiveTests(MediaTestCase):
    """Bundles are user uploads, so the reader must not trust the archive."""

    def setUp(self):
        self.alice = default_user()
        self.target = Mushaf.objects.get(id=_create(self.alice, "Target")["id"])

    def test_a_traversal_member_is_simply_never_read(self):
        """Members are fetched by exact name, so ../ entries match nothing."""
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "schema": bundle.SCHEMA,
                        "mushaf": {"pdf_sha256": self.target.pdf_sha256},
                        "templates": [{"type": "sura_header", "ignore_rects": {}}],
                    }
                ),
            )
            archive.writestr("pages.json", json.dumps({"pages": []}))
            archive.writestr("../../../../evil.png", b"pwned")
            archive.writestr("templates/../../evil2.png", b"pwned")

        result = bundle.apply_bundle(self.target.id, _upload(buffer.getvalue()), user=self.alice)

        # Import succeeds and the hostile members are ignored, not extracted.
        self.assertEqual(result["pages_imported"], 0)
        template = Template.objects.get(mushaf=self.target, type="sura_header")
        self.assertFalse(template.image)

    def test_an_oversized_member_is_refused_before_decompression(self):
        """A zip bomb: tiny compressed, enormous declared size."""
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", b"{" + b" " * (bundle.MAX_JSON_BYTES + 1))
            archive.writestr("pages.json", json.dumps({"pages": []}))

        with self.assertRaises(HttpError) as ctx:
            bundle.apply_bundle(self.target.id, _upload(buffer.getvalue()), user=self.alice)
        self.assertEqual(ctx.exception.status_code, 400)


class BundleApiTests(ApiTestCase):
    def test_download_then_import_over_http(self):
        source = _with_work(self.user, "ApiSource")
        target = Mushaf.objects.get(id=_create(self.user, "ApiTarget")["id"])

        download = self.client.get(f"/api/mushafs/{source.id}/bundle")
        self.assertEqual(download.status_code, 200)
        data = b"".join(download.streaming_content)

        resp = self.client.post(
            f"/api/mushafs/{target.id}/import",
            data={"file": _upload(data)},
        )

        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["pages_imported"], 2)
        self.assertEqual(target.pages.count(), 2)

    def test_replace_query_param_is_wired_up(self):
        """The UI sends ?replace=true; make sure Ninja actually parses it."""
        source = _with_work(self.user, "ApiSource")
        target = _with_work(self.user, "ApiTargetWithWork")
        data = _export_bytes(source, self.user)

        blocked = self.client.post(f"/api/mushafs/{target.id}/import", data={"file": _upload(data)})
        self.assertEqual(blocked.status_code, 409)

        allowed = self.client.post(
            f"/api/mushafs/{target.id}/import?replace=true",
            data={"file": _upload(data)},
        )
        self.assertEqual(allowed.status_code, 200, allowed.content)
        self.assertEqual(allowed.json()["pages_imported"], 2)

    def test_mismatched_pdf_is_a_409_over_http(self):
        source = _with_work(self.user, "ApiSource")
        other = Mushaf.objects.get(id=_create(self.user, "ApiOther", OTHER_PDF)["id"])
        data = _export_bytes(source, self.user)

        resp = self.client.post(
            f"/api/mushafs/{other.id}/import",
            data={"file": _upload(data)},
        )

        self.assertEqual(resp.status_code, 409)
