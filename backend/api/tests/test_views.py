"""End-to-end view tests through the mounted /api URLs (full stack)."""

import uuid

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart

from api.tests.helpers import ApiTestCase, MediaTestCase, make_pdf_bytes, make_png_bytes
from quran.models import Rawi
from quran.services import suras


def _create_mushaf(client, name: str = "ViewMushaf", pages: int = 5):
    return client.post(
        "/api/mushafs",
        {
            "name": name,
            "first_quran_pdf_page": 1,
            "pdf": SimpleUploadedFile(f"{name}.pdf", make_pdf_bytes(pages), "application/pdf"),
        },
    )


class SurasViewTests(MediaTestCase):
    def setUp(self):
        suras.seed_reference_data()

    def test_list(self):
        resp = self.client.get("/api/suras?qiraa=hafs")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(len(body), 114)
        self.assertEqual(body[0]["number"], 1)


class QiraatViewTests(MediaTestCase):
    def test_list(self):
        Rawi.objects.create(name="Hafs", name_arabic="حفص")
        Rawi.objects.create(name="warsh", name_arabic="ورش")
        resp = self.client.get("/api/qiraat")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual({q["name"] for q in body}, {"Hafs", "warsh"})
        self.assertIn("counting_system", body[0])


class MushafViewTests(ApiTestCase):
    def test_create_and_get(self):
        resp = _create_mushaf(self.client, "Created", 7)
        self.assertEqual(resp.status_code, 201)
        body = resp.json()
        self.assertEqual(body["mushaf"]["pdf_page_count"], 7)
        self.assertFalse(body["warnings"]["duplicate_file"])

        get_resp = self.client.get(f"/api/mushafs/{body['mushaf']['id']}")
        self.assertEqual(get_resp.status_code, 200)
        self.assertEqual(get_resp.json()["name"], "Created")

    def test_duplicate_name_409(self):
        _create_mushaf(self.client, "Dupe")
        self.assertEqual(_create_mushaf(self.client, "Dupe").status_code, 409)

    def test_list(self):
        _create_mushaf(self.client, "One")
        resp = self.client.get("/api/mushafs")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()), 1)

    def test_get_missing_404(self):
        resp = self.client.get("/api/mushafs/00000000-0000-0000-0000-000000000000")
        self.assertEqual(resp.status_code, 404)

    def test_delete(self):
        body = _create_mushaf(self.client, "Del").json()
        resp = self.client.delete(f"/api/mushafs/{body['mushaf']['id']}")
        self.assertEqual(resp.status_code, 204)

    def test_put_template(self):
        mushaf_id = _create_mushaf(self.client, "Tmpl").json()["mushaf"]["id"]
        payload = encode_multipart(
            BOUNDARY,
            {
                "image": SimpleUploadedFile("t.png", make_png_bytes(), "image/png"),
                "ignore_x": 1,
                "ignore_y": 2,
                "ignore_w": 3,
                "ignore_h": 4,
            },
        )
        resp = self.client.put(
            f"/api/mushafs/{mushaf_id}/templates/sura_header",
            data=payload,
            content_type=MULTIPART_CONTENT,
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["type"], "sura_header")

    def test_page_image(self):
        mushaf_id = _create_mushaf(self.client, "Img", 5).json()["mushaf"]["id"]
        resp = self.client.get(f"/api/mushafs/{mushaf_id}/pages/1/image")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["Content-Type"], "image/png")

    def test_stats_endpoint(self):
        mushaf_id = _create_mushaf(self.client, "StatsView").json()["mushaf"]["id"]
        resp = self.client.get(f"/api/mushafs/{mushaf_id}/stats")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["lines_cut"], 0)
        self.assertEqual(resp.json()["ayat_found"], 0)

    def test_runs_endpoint_empty(self):
        mushaf_id = _create_mushaf(self.client, "RunsView").json()["mushaf"]["id"]
        resp = self.client.get(f"/api/mushafs/{mushaf_id}/runs")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), [])

    def test_activity_endpoint(self):
        mushaf_id = _create_mushaf(self.client, "ActView").json()["mushaf"]["id"]
        resp = self.client.get(f"/api/mushafs/{mushaf_id}/activity")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([e["type"] for e in resp.json()], ["mushaf_created"])

    def test_coordinates_download(self):
        mushaf_id = _create_mushaf(self.client, "CoordView").json()["mushaf"]["id"]
        resp = self.client.get(f"/api/mushafs/{mushaf_id}/coordinates")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("attachment", resp["Content-Disposition"])
        body = resp.json()
        self.assertEqual(body["schema"], "aya-bbox/v1")
        self.assertEqual(body["pages"], [])

    def test_thumbnail_regenerate(self):
        mushaf_id = _create_mushaf(self.client, "ThumbView").json()["mushaf"]["id"]
        resp = self.client.post(f"/api/mushafs/{mushaf_id}/thumbnail")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["thumbnail_url"])

    def test_review_data_endpoint(self):
        mushaf_id = _create_mushaf(self.client, "ReviewData").json()["mushaf"]["id"]
        resp = self.client.get(f"/api/mushafs/{mushaf_id}/review-data")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["start"], {"sura": 1, "aya": 1})
        self.assertEqual(body["pages"], [])

    def test_bulk_save_endpoint(self):
        mushaf_id = _create_mushaf(self.client, "BulkSave").json()["mushaf"]["id"]
        resp = self.client.post(
            f"/api/mushafs/{mushaf_id}/pages/bulk",
            data={"pages": [], "reviewed_pages": []},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIn("start", resp.json())


class AuthGateTests(MediaTestCase):
    """The API is closed by default; only reference data is open.

    Deliberately extends MediaTestCase, not ApiTestCase — the whole point is an
    anonymous client.
    """

    def test_mushaf_routes_require_a_session(self):
        for method, path in [
            ("get", "/api/mushafs"),
            ("get", f"/api/mushafs/{uuid.uuid4()}"),
            ("get", f"/api/mushafs/{uuid.uuid4()}/stats"),
            ("delete", f"/api/mushafs/{uuid.uuid4()}"),
        ]:
            with self.subTest(path=path):
                resp = getattr(self.client, method)(path)
                self.assertEqual(resp.status_code, 401)

    def test_creating_a_mushaf_anonymously_is_rejected(self):
        self.assertEqual(_create_mushaf(self.client, "Anon").status_code, 401)

    def test_reference_data_stays_public(self):
        suras.seed_reference_data()
        for path in ("/api/suras?qiraa=hafs", "/api/qiraat", "/api/counting-systems"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)
