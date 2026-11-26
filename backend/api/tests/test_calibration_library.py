"""Tests for the stored fingerprint set as Ink's Library mode shows it.

The drawn pages of :mod:`api.tests.test_calibration_api`, with a flat bar over every
line's second body: page 1 confirmed with the dots typed ijamDot and the bars fatha,
page 2 processed and open. So the set holds page 1's examples, every kind of them
printed pixel for pixel alike: three groups, one fingerprint each, and no kept shapes
beside them (a copy of a fingerprint shows nothing new).
"""

from unittest import mock

from api.models import CalibrationSettings, FingerprintLibrary, FingerprintShape, RemovedShape
from api.services import calibration as calibration_service
from api.services import fingerprint_rebuild
from api.tests.helpers import default_user
from api.tests.test_calibration_api import BAR, BODIES, DOT, CalibrationApiTestCase, drawn_pages


class LibraryTestCase(CalibrationApiTestCase):
    def setUp(self):
        super().setUp()
        with drawn_pages(bar=True):
            self.client.post(self.url(1, "/process"))
        self.doc = self.document(1)
        body = self.draft(self.doc)
        for index in (0, 1):
            self.type_mark(body, index, DOT[0], "ijamDot")
            self.type_mark(body, index, BAR[0], "fatha")
        self.assertEqual(self.confirm(1, body).status_code, 200)
        with drawn_pages(bar=True):
            self.client.post(self.url(2, "/process"))
        self.doc = self.document(2)

    def type_mark(self, body: dict, index: int, left: int, subtype: str) -> dict:
        blob = self.decide(self.draft_blob(body, index, left), "mark", marks=[subtype])
        blob["allocations"] = [{**allocation, "paws": 0} for allocation in blob["allocations"]]
        return blob

    def library(self, page: int, **query) -> dict:
        response = self.client.get(self.url(page, "/library"), query)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def compare(self, body: dict, line: dict, blob: dict) -> dict:
        response = self.client.post(
            self.url(2, "/library/compare"),
            {**body, "snapshot_id": line["snapshot_id"], "blob_id": blob["id"]},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def library_url(self, action: str) -> str:
        return f"/api/mushafs/{self.mushaf.id}/calibration/library/{action}"

    def shape_body(self, shape: dict, **more) -> dict:
        return {"snapshot_id": shape["snapshot_id"], "blob_id": shape["blob_id"], **more}


class LibraryDocumentTests(LibraryTestCase):
    def test_the_library_is_the_one_set_kind_by_kind(self):
        library = self.library(2)
        library_row = FingerprintLibrary.objects.get(mushaf=self.mushaf)
        self.assertEqual((library["pages"], library["preview"], library["version"]), ([1], False, library_row.version))
        self.assertEqual(library["draft_version"], library_row.version)
        self.assertEqual((library["needs_rebuild"], library["rebuilding"], library["removed"]), (False, False, []))
        kinds = [(kind["role"], kind["kind"], len(kind["groups"])) for kind in library["kinds"]]
        # The typed marks, whole; the letters are listed on demand, key by key.
        self.assertEqual(kinds, [("mark", "fatha", 1), ("mark", "ijamDot", 1)])
        self.assertGreater(library["body_keys"], 0)
        fatha = library["kinds"][0]["groups"]
        self.assertEqual((fatha[0]["farthest"], fatha[0]["kept"]), (0.0, []))
        self.assertNotIn("count", fatha[0])
        shape = fatha[0]["fingerprint"]
        self.assertEqual(
            (shape["page_number"], shape["crop"]["w"], bool(shape["image_url"])), (1, BAR[1] - BAR[0], True)
        )
        self.assertIsNotNone(shape["confirmed_at"])
        self.assertFalse(shape["looks_right"])

    def test_a_confirmed_page_sees_the_same_set_its_own_shapes_included(self):
        self.assertEqual(self.library(1)["kinds"], self.library(2)["kinds"])

    def test_a_preview_builds_at_another_limit_and_saves_nothing(self):
        before = self.library(2)
        shapes = FingerprintShape.objects.count()
        library = self.library(2, limit=0.5)
        self.assertEqual((library["preview"], library["limit"]), (True, 0.5))
        self.assertEqual(library["saved_limit"], library["default_limit"])
        self.assertEqual((library["version"], FingerprintShape.objects.count()), (before["version"], shapes))
        self.assertFalse(CalibrationSettings.objects.filter(mushaf=self.mushaf, library_limit=0.5).exists())

    def test_a_limit_out_of_range_is_refused(self):
        self.assertEqual(self.client.get(self.url(2, "/library"), {"limit": 0}).status_code, 422)

    def test_the_preview_cache_is_not_the_lookup_cache(self):
        fingerprint_rebuild.PREVIEW_LIBRARIES.clear()
        self.library(2, limit=0.5)
        self.assertEqual(len(fingerprint_rebuild.PREVIEW_LIBRARIES), 1)


class PricingTests(LibraryTestCase):
    def test_a_page_with_a_library_is_read_with_its_answers_priced_in(self):
        # setUp processed page 2 already, and asking again from the same sources is
        # refused as already processed: read it again the way the bulk batch does.
        revision = self.document(2)["revision"]
        with (
            mock.patch.object(calibration_service, "align_document", wraps=calibration_service.align_document) as align,
            drawn_pages(bar=True),
        ):
            read = calibration_service.make_fresh_draft_of_page(
                self.mushaf, 2, expected_revision=revision, user=default_user()
            )
        self.assertTrue(read)
        self.assertTrue(any(call.kwargs.get("calibration_locks") for call in align.call_args_list))
        self.assertEqual(self.document(2)["library"]["mode"], "learned")


class KeyListTests(LibraryTestCase):
    def keys(self, **query) -> dict:
        response = self.client.get(f"/api/mushafs/{self.mushaf.id}/calibration/library/keys", query)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_body_keys_come_a_page_at_a_time_with_their_shapes(self):
        found = self.keys(show="has")
        self.assertEqual(found["per_page"], 40)
        self.assertTrue(found["keys"])
        self.assertTrue(all(item["shapes"] > 0 for item in found["keys"]))
        self.assertTrue(all(item["parts"]["paws"] for item in found["keys"]))

    def test_none_yet_lists_the_texts_pieces_the_set_has_no_shape_of(self):
        found = self.keys(show="none", letters=1)
        self.assertGreater(found["total"], 0)
        self.assertTrue(all(item["shapes"] == 0 for item in found["keys"]))
        self.assertTrue(all(len("".join(item["parts"]["paws"])) == 1 for item in found["keys"]))

    def test_one_key_opens_to_its_pictures(self):
        first = self.keys(show="has")["keys"][0]["key"]
        response = self.client.get(f"/api/mushafs/{self.mushaf.id}/calibration/library/key", {"key": first})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json()["groups"][0]["fingerprint"]["image_url"])


class CompareTests(LibraryTestCase):
    def test_a_mark_is_answered_with_its_type_and_its_distance_to_every_kept_shape(self):
        line = self.doc["lines"][0]
        bar = self.blob_at(line, BAR[0])
        answer = self.compare(self.draft(self.doc), line, bar)
        self.assertEqual(answer["answer"]["role"], "mark")
        self.assertEqual((answer["type"]["kind"], answer["type"]["distance"]), ("fatha", 0.0))
        self.assertEqual(answer["type"]["runner_up"], "ijamDot")
        library = self.library(2)
        fingerprints = {group["fingerprint"]["key"] for kind in library["kinds"] for group in kind["groups"]}
        # Every mark's fingerprint is measured — and every body's, which the view lists on demand.
        self.assertLessEqual(fingerprints, set(answer["distances"]))
        bars = library["kinds"][0]["groups"][0]["fingerprint"]["key"]
        self.assertEqual(answer["distances"][bars], 0.0)

    def test_a_body_is_answered_as_a_letter(self):
        line = self.doc["lines"][0]
        answer = self.compare(self.draft(self.doc), line, self.blob_at(line, BODIES[0][0]))
        self.assertEqual((answer["answer"]["role"], answer["answer"]["nearest_letter"]), ("body", 0.0))
        self.assertIsNone(answer["type"])

    def test_an_untyped_mark_counts_the_marks_typed_on_this_page(self):
        body = self.draft(self.doc)
        self.type_mark(body, 1, BAR[0], "fatha")
        line = self.doc["lines"][0]
        self.assertEqual(self.compare(body, line, self.blob_at(line, BAR[0]))["own"], 1)
        # A typed mark is asked of the set alone.
        self.type_mark(body, 0, BAR[0], "fatha")
        self.assertEqual(self.compare(body, line, self.blob_at(line, BAR[0]))["own"], 0)


class LeverTests(LibraryTestCase):
    def fatha(self) -> dict:
        return self.library(2)["kinds"][0]["groups"][0]["fingerprint"]

    def test_looks_right_is_a_flag_on_the_shape(self):
        shape = self.fatha()
        url = self.library_url("looks-right")
        response = self.client.put(url, self.shape_body(shape, looks_right=True), content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(self.fatha()["looks_right"])
        self.client.put(url, self.shape_body(shape, looks_right=False), content_type="application/json")
        self.assertFalse(self.fatha()["looks_right"])

    def test_a_removed_shape_leaves_the_set_and_can_be_restored(self):
        shape = self.fatha()
        response = self.client.post(self.library_url("remove"), self.shape_body(shape), content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        library = self.library(2)
        self.assertNotIn(("mark", "fatha"), [(kind["role"], kind["kind"]) for kind in library["kinds"]])
        self.assertEqual([(item["key"], item["kind"]) for item in library["removed"]], [(":fatha", "fatha")])
        # A Rebuild never brings it back.
        fingerprint_rebuild.rebuild_fingerprint_set(self.mushaf)
        self.assertNotIn(
            shape["key"], [group["fingerprint"]["key"] for kind in self.library(2)["kinds"] for group in kind["groups"]]
        )
        response = self.client.post(
            self.library_url("restore"), self.shape_body(shape), content_type="application/json"
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(RemovedShape.objects.filter(mushaf=self.mushaf).exists())
        self.assertEqual(self.library(2)["kinds"][0]["kind"], "fatha")

    def test_a_shape_outside_the_set_is_not_found(self):
        body = {"snapshot_id": self.doc["lines"][0]["snapshot_id"], "blob_id": 9999}
        self.assertEqual(
            self.client.post(self.library_url("remove"), body, content_type="application/json").status_code, 404
        )
