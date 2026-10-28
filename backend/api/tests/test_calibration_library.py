"""Tests for the fingerprint library as Ink's Library mode shows it.

The drawn pages of :mod:`api.tests.test_calibration_api`, with a flat bar over every
line's second body: page 1 confirmed with the dots typed ijamDot and the bars fatha,
page 2 processed and open. So page 2's library holds page 1's ten examples, every
kind of them printed pixel for pixel alike: three groups, one fingerprint each.
"""

from unittest import mock

from api.models import CalibrationProfile, CalibrationSettings, LibraryCheck
from api.services import calibration as calibration_service
from api.services import calibration_library as library_service
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
        blob = self.draft_blob(body, index, left)
        blob.update(
            role="mark",
            explicit=True,
            subtype=subtype,
            subtype_explicit=True,
            allocations=[{**allocation, "paws": 0} for allocation in blob["allocations"]],
        )
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

    def checks_url(self) -> str:
        return f"/api/mushafs/{self.mushaf.id}/calibration/library/checks"


class LibraryDocumentTests(LibraryTestCase):
    def test_the_library_is_every_other_confirmed_page_kind_by_kind(self):
        library = self.library(2)
        self.assertEqual((library["pages"], library["left_out"], library["preview"]), ([1], None, False))
        self.assertEqual(library["draft_pages"], [1])
        self.assertEqual(library["examples"], 10)  # 3 bodies, a dot and a bar, twice
        kinds = [(kind["role"], kind["subtype"], kind["examples"]) for kind in library["kinds"]]
        # The typed marks first, the letters last.
        self.assertEqual(kinds, [("mark", "fatha", 2), ("mark", "ijamDot", 2), ("body", "", 6)])
        fatha = library["kinds"][0]["groups"]
        self.assertEqual(len(fatha), 1)
        self.assertEqual((fatha[0]["count"], fatha[0]["farthest"], fatha[0]["kept"]), (2, 0.0, []))
        shape = fatha[0]["fingerprint"]
        self.assertEqual(
            (shape["page_number"], shape["crop"]["w"], bool(shape["image_url"])), (1, BAR[1] - BAR[0], True)
        )
        self.assertIsNotNone(shape["confirmed_at"])
        self.assertFalse(shape["looks_right"])

    def test_a_confirmed_page_is_left_out_of_its_own_library(self):
        library = self.library(1)
        self.assertEqual((library["pages"], library["left_out"], library["kinds"]), ([], 1, []))

    def test_a_preview_builds_at_another_limit_and_saves_nothing(self):
        self.library(2)
        profiles = CalibrationProfile.objects.count()
        cached = dict(calibration_service._LIBRARIES)
        library = self.library(2, limit=0.5)
        self.assertEqual((library["preview"], library["limit"]), (True, 0.5))
        self.assertEqual(library["saved_limit"], library["default_limit"])
        self.assertEqual(CalibrationProfile.objects.count(), profiles)
        self.assertEqual(dict(calibration_service._LIBRARIES), cached)
        self.assertFalse(CalibrationSettings.objects.filter(mushaf=self.mushaf, library_limit=0.5).exists())

    def test_a_limit_out_of_range_is_refused(self):
        self.assertEqual(self.client.get(self.url(2, "/library"), {"limit": 0}).status_code, 422)

    def test_the_members_are_every_example_of_a_group_farthest_first(self):
        letters = self.library(2)["kinds"][2]["groups"][0]
        response = self.client.get(self.url(2, "/library/members"), {"group": letters["id"]})
        self.assertEqual(response.status_code, 200, response.content)
        members = response.json()
        self.assertEqual((members["total"], len(members["members"])), (6, 6))
        self.assertEqual({member["page_number"] for member in members["members"]}, {1})
        self.assertEqual(self.client.get(self.url(2, "/library/members"), {"group": "body::x:1"}).status_code, 404)


class PricingTests(LibraryTestCase):
    def test_a_page_with_a_library_is_read_with_its_answers_priced_in(self):
        with (
            mock.patch.object(calibration_service, "align_document", wraps=calibration_service.align_document) as align,
            drawn_pages(bar=True),
        ):
            self.client.post(self.url(2, "/process"))
        self.assertTrue(any(call.kwargs.get("calibration_locks") for call in align.call_args_list))
        self.assertEqual(self.document(2)["profile"]["mode"], "learned")


class CompareTests(LibraryTestCase):
    def test_a_mark_is_answered_with_its_type_and_its_distance_to_every_kept_shape(self):
        line = self.doc["lines"][0]
        bar = self.blob_at(line, BAR[0])
        answer = self.compare(self.draft(self.doc), line, bar)
        self.assertEqual(answer["answer"]["role"], "mark")
        self.assertEqual((answer["type"]["subtype"], answer["type"]["distance"]), ("fatha", 0.0))
        self.assertEqual(answer["type"]["runner_up"], "ijamDot")
        library = self.library(2)
        fingerprints = {group["fingerprint"]["key"] for kind in library["kinds"] for group in kind["groups"]}
        self.assertEqual(set(answer["distances"]), fingerprints)
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
        # A typed mark is asked of the other pages only.
        self.type_mark(body, 0, BAR[0], "fatha")
        self.assertEqual(self.compare(body, line, self.blob_at(line, BAR[0]))["own"], 0)


class LooksRightTests(LibraryTestCase):
    def test_looks_right_counts_only_while_the_label_stands(self):
        shape = self.library(2)["kinds"][0]["groups"][0]["fingerprint"]
        body = {"snapshot_id": shape["snapshot_id"], "blob_id": shape["blob_id"], "role": "mark", "subtype": "fatha"}
        self.assertEqual(self.client.put(self.checks_url(), body, content_type="application/json").status_code, 200)
        self.assertTrue(self.library(2)["kinds"][0]["groups"][0]["fingerprint"]["looks_right"])
        # Looked at as another type: it does not stand for this one.
        LibraryCheck.objects.filter(mushaf=self.mushaf).update(subtype="kasra")
        self.assertFalse(self.library(2)["kinds"][0]["groups"][0]["fingerprint"]["looks_right"])
        query = f"?snapshot={shape['snapshot_id']}&blob={shape['blob_id']}"
        self.assertEqual(self.client.delete(self.checks_url() + query).status_code, 200)
        self.assertFalse(LibraryCheck.objects.filter(mushaf=self.mushaf).exists())

    def test_the_preview_cache_is_not_the_processing_cache(self):
        library_service._PREVIEW.clear()
        self.library(2, limit=0.5)
        self.assertEqual(len(library_service._PREVIEW), 1)
