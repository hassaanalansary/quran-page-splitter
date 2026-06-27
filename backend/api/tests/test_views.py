"""End-to-end view tests through the mounted /api URLs (full stack)."""

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart

from api.services import suras
from api.tests.helpers import MediaTestCase, make_pdf_bytes, make_png_bytes


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


class MushafViewTests(MediaTestCase):
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
