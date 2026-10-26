"""Tests for calibration review: process a page, correct it, preview, confirm, learn.

The engine is exercised for real, on a page drawn rather than rendered: every line
holds three letter-sized rectangles, a dot above the first, and a ring standing for
the aya ornament. So each line has five blobs whose roles are arithmetic — three
bodies, one mark, one ornament — and three one-PAW words that read exactly.

Two pages, the same picture on each, sura 2:

    page 1   line 1  aya 5  words 1-3        page 2   line 1  aya 7  words 7-9
             line 2  aya 6  words 4-6                 line 2  aya 8  words 10-12
"""

import io
import uuid
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import SimpleTestCase, override_settings
from PIL import Image, ImageDraw

from api.models import (
    CalibrationProfile,
    CalibrationReview,
    CalibrationRevision,
    CalibrationSettings,
    CalibrationSnapshot,
    Line,
    LineTypeChoices,
    LineWord,
    Page,
    Segment,
    Template,
)
from api.services import bundle, cloning, coordinates, data_export, export
from api.services import calibration as calibration_service
from api.services import calibration_snapshots as snapshots
from api.services import mushaf as mushaf_service
from api.tests.helpers import ApiTestCase, default_user, make_pdf_bytes
from quran.models import Aya, CountingSystem, Rawi, Word
from quran.services import suras

#: Where each line sits on the page, and the page-x span of each of its three words,
#: right to left — the order Arabic is read in.
LINE_TOPS = (20, 100)
BODIES = ((580, 610), (460, 490), (340, 370))
DOT = (590, 596)
RING = (200, 220)
#: The second and third bodies of a line printed as one: words 2 and 3 touching.
FUSED = (340, 490)
#: Every way the evaluation can find a reading's words wrong, none of them.
NO_WORD_ERRORS = {"words_moved": 0, "words_wrong_line": 0, "words_missing": 0, "words_duplicated": 0, "words_extra": 0}


def _ring_template() -> bytes:
    image = Image.new("RGB", (RING[1] - RING[0], 20), "white")
    ImageDraw.Draw(image).rectangle([0, 0, 19, 19], outline="black", width=3)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


#: A small mark just left of the first body, over no body at all: it attaches to
#: the nearest one, and so belongs to word 1 without lying over its letter.
STRAY = (560, 566)
#: A flat stroke over every line's second body: a mark of another shape than the dot.
BAR = (465, 485)
#: A small square on the writing line just left of the first body — where a small waw
#: or ya sits after its word's heh.
SMALL = (566, 574)


def _drawn_page(
    *,
    fused: bool = False,
    ringless: tuple[int, ...] = (),
    stray: bool = False,
    bar: bool = False,
    small: bool = False,
) -> Image.Image:
    """The picture a page renders as — see the module docstring.

    ``fused`` prints the first line's second and third bodies as one blob (words 2
    and 3 touching); ``ringless`` leaves the ornament off the lines it names, for an
    aya that runs on past them.
    """
    image = Image.new("RGB", (800, 200), "white")
    draw = ImageDraw.Draw(image)
    for number, top in enumerate(LINE_TOPS, start=1):
        for left, right in (BODIES[0], FUSED) if fused and number == 1 else BODIES:
            draw.rectangle([left, top + 8, right - 1, top + 31], fill="black")
        draw.rectangle([DOT[0], top + 1, DOT[1] - 1, top + 3], fill="black")
        if stray and number == 1:
            draw.rectangle([STRAY[0], top + 1, STRAY[1] - 1, top + 3], fill="black")
        if bar:
            draw.rectangle([BAR[0], top + 2, BAR[1] - 1, top + 3], fill="black")
        if small and number == 1:
            draw.rectangle([SMALL[0], top + 19, SMALL[1] - 1, top + 30], fill="black")
        if number not in ringless:
            draw.rectangle([RING[0], top + 10, RING[1] - 1, top + 29], outline="black", width=3)
    return image


@contextmanager
def drawn_pages(
    *,
    fused_page: int | None = None,
    ringless: dict[int, tuple[int, ...]] | None = None,
    stray: bool = False,
    bar: bool = False,
    small: bool = False,
):
    """Render every page as drawn: ``fused_page`` with its first line fused, and
    ``ringless`` mapping a page number to its lines printed without an ornament."""

    def render(mushaf, page):
        return _drawn_page(
            fused=page.page_number == fused_page,
            ringless=(ringless or {}).get(page.page_number, ()),
            stray=stray and page.page_number == 1,
            bar=bar,
            small=small and page.page_number == 1,
        )

    with mock.patch("api.services.line_images._render_page", side_effect=render):
        yield


@override_settings(PROCESS_JOBS_INLINE=True)
class CalibrationApiTestCase(ApiTestCase):
    def setUp(self):
        super().setUp()
        suras.seed_reference_data()
        kufi = CountingSystem.objects.get(name="Kufi")
        Word.objects.bulk_create(
            [Word(id=n, text=f"w{n}", paw_count=1, ijam_above=0, ijam_below=0) for n in range(1, 13)]
        )
        Aya.objects.bulk_create(
            [
                Aya(counting_system=kufi, sura_id=2, number=number, start_word_id=start)
                for number, start in ((5, 1), (6, 4), (7, 7), (8, 10))
            ]
        )
        created = mushaf_service.create_mushaf(
            pdf_file=SimpleUploadedFile("m.pdf", make_pdf_bytes(2), "application/pdf"),
            name="Calibration",
            qiraa=None,
            first_quran_pdf_page=1,
            last_quran_pdf_page=None,
            owner=default_user(),
        )
        self.mushaf = mushaf_service.get_mushaf(created["mushaf"]["id"], user=default_user())
        self.mushaf.rawi = Rawi.objects.get(name="Hafs")
        self.mushaf.save(update_fields=["rawi"])
        Template.objects.create(
            mushaf=self.mushaf, type="aya_separator", image=ContentFile(_ring_template(), name="ring.png")
        )
        for page_number, ayat in ((1, (5, 6)), (2, (7, 8))):
            page = Page.objects.create(mushaf=self.mushaf, page_number=page_number, reviewed=True)
            for number, (top, aya) in enumerate(zip(LINE_TOPS, ayat, strict=True), start=1):
                line = Line.objects.create(
                    page=page,
                    line_number=number,
                    type=LineTypeChoices.TEXT,
                    sura_id=2,
                    bbox_x=100,
                    bbox_y=top,
                    bbox_w=600,
                    bbox_h=40,
                )
                Segment.objects.create(
                    line=line, segment_order=1, bbox_x=RING[0], bbox_w=700 - RING[0], has_separator=True, aya_number=aya
                )

    # -- helpers --------------------------------------------------------------
    def url(self, page: int, suffix: str = "") -> str:
        return f"/api/mushafs/{self.mushaf.id}/pages/{page}/calibration{suffix}"

    def process(self, page: int):
        with drawn_pages():
            return self.client.post(self.url(page, "/process"))

    def document(self, page: int) -> dict:
        response = self.client.get(self.url(page))
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    @staticmethod
    def draft(document: dict, *, request_id=None, **extra) -> dict:
        """The PUT body for a document exactly as it stands."""
        return {
            "revision": document["revision"],
            "request_id": str(request_id or uuid.uuid4()),
            "lines": [
                {
                    "snapshot_id": line["snapshot_id"],
                    "blobs": [
                        {
                            key: blob[key]
                            for key in (
                                "id",
                                "role",
                                "explicit",
                                "ownership_explicit",
                                "subtype",
                                "exception",
                                "allocations",
                            )
                        }
                        for blob in line["blobs"]
                    ],
                }
                for line in document["lines"]
            ],
            **extra,
        }

    @staticmethod
    def blob_at(line: dict, left: int) -> dict:
        """A document line's blob by its page-x left edge."""
        return next(blob for blob in line["blobs"] if blob["x"] == left)

    def draft_blob(self, body: dict, index: int, left: int) -> dict:
        """The same blob in a PUT body, which carries ids and decisions, not geometry."""
        ident = self.blob_at(self.doc["lines"][index], left)["id"]
        return next(blob for blob in body["lines"][index]["blobs"] if blob["id"] == ident)

    def put(self, page: int, body: dict):
        return self.client.put(self.url(page), body, content_type="application/json")

    def confirm(self, page: int, body: dict):
        return self.client.post(self.url(page, "/confirm"), body, content_type="application/json")


class ProcessTests(CalibrationApiTestCase):
    def test_processing_measures_aligns_and_records_the_prediction(self):
        response = self.process(1)
        self.assertEqual(response.status_code, 202, response.content)
        self.assertEqual(response.json()["job"]["state"], "completed")
        self.assertEqual(response.json()["job"]["kind"], "calibration")

        document = self.document(1)
        self.assertEqual((document["revision"], document["processed"], document["stale"]), (1, True, False))
        self.assertEqual([line["line_number"] for line in document["lines"]], [1, 2])
        self.assertEqual(document["context"], [])
        first = document["lines"][0]
        self.assertEqual(sorted(blob["role"] for blob in first["blobs"]), ["body", "body", "body", "mark", "ornament"])
        self.assertEqual([word["word_id"] for word in first["words"]], [1, 2, 3])
        # Page coordinates: each word's cut sits on its own rectangle's left edge.
        self.assertEqual([word["end_x"] for word in first["words"]], [left for left, _ in BODIES])
        self.assertEqual(first["status"], "exact")
        self.assertTrue(first["image_url"].startswith("/media/mushafs/"))

        record = CalibrationRevision.objects.get(review__mushaf=self.mushaf, review__page_number=1)
        self.assertEqual((record.kind, record.number), ("processed", 1))
        self.assertEqual(len(record.payload["frozen"]["lines"]), 2)

    def test_the_label_raster_names_every_blob_at_its_own_pixels(self):
        self.process(1)
        line = self.document(1)["lines"][0]
        snapshot = CalibrationSnapshot.objects.get(pk=line["snapshot_id"])
        raster = snapshots.read_raster(snapshot)
        origin_x, origin_y = line["bbox"]["x"], line["bbox"]["y"]
        for blob in line["blobs"]:
            centre = raster[blob["y"] - origin_y + blob["h"] // 2, blob["x"] - origin_x + blob["w"] // 2]
            if blob["role"] != "ornament":  # a ring's centre is its hole
                self.assertEqual(int(centre), blob["id"])

    def test_an_unreviewed_page_is_refused_before_a_job_exists(self):
        Page.objects.filter(mushaf=self.mushaf, page_number=1).update(reviewed=False)
        self.assertEqual(self.process(1).status_code, 422)
        self.assertFalse(CalibrationReview.objects.exists())

    def test_an_unnumbered_segment_is_refused(self):
        Segment.objects.filter(line__page__page_number=1, line__line_number=2).update(aya_number=None)
        self.assertEqual(self.process(1).status_code, 422)

    def test_processing_again_is_refused_while_the_sources_are_unchanged(self):
        self.process(1)
        self.assertEqual(self.process(1).status_code, 409)

    def test_the_first_page_has_no_examples_to_learn_from(self):
        self.process(1)
        document = self.document(1)
        self.assertEqual(document["profile"]["examples"], 0)
        for blob in document["lines"][0]["blobs"]:
            self.assertIsNone(blob["proposed_role"])


class DraftTests(CalibrationApiTestCase):
    def setUp(self):
        super().setUp()
        self.process(1)
        self.doc = self.document(1)

    def test_a_draft_bumps_the_revision_but_writes_no_history(self):
        response = self.put(1, self.draft(self.doc))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["revision"], 2)
        self.assertEqual(CalibrationRevision.objects.filter(review__mushaf=self.mushaf).count(), 1)

    def test_an_older_revision_is_refused(self):
        self.put(1, self.draft(self.doc))
        self.assertEqual(self.put(1, self.draft(self.doc)).status_code, 409)

    def test_a_retried_request_lands_once_and_a_reused_id_is_refused(self):
        request_id = uuid.uuid4()
        first = self.put(1, self.draft(self.doc, request_id=request_id))
        again = self.put(1, self.draft(self.doc, request_id=request_id))
        self.assertEqual((first.json()["revision"], again.json()["revision"]), (2, 2))
        changed = self.draft(self.doc, request_id=request_id)
        changed["lines"][0]["blobs"][0]["subtype"] = "fatha"
        self.assertEqual(self.put(1, changed).status_code, 409)

    def test_edits_that_do_not_match_the_page_are_refused(self):
        body = self.draft(self.doc)
        body["lines"][0]["blobs"].pop()
        self.assertEqual(self.put(1, body).status_code, 422)
        body = self.draft(self.doc)
        ornament = next(b for b in body["lines"][0]["blobs"] if b["role"] == "ornament")
        ornament["role"] = "body"
        self.assertEqual(self.put(1, body).status_code, 422)

    def test_a_changed_source_makes_the_draft_read_only(self):
        Segment.objects.filter(line__page__page_number=1, line__line_number=1).update(bbox_w=480)
        self.assertTrue(self.document(1)["stale"])
        self.assertEqual(self.put(1, self.draft(self.doc)).status_code, 409)


class PreviewTests(CalibrationApiTestCase):
    def setUp(self):
        super().setUp()
        self.process(1)
        self.doc = self.document(1)

    def test_explicitly_unattached_mark_survives_save_preview_and_reprocess(self):
        body = self.draft(self.doc)
        self.draft_blob(body, 0, DOT[0]).update(
            role="mark",
            explicit=True,
            ownership_explicit=True,
            allocations=[],
            subtype="fatha",
            subtype_explicit=True,
        )
        saved = self.put(1, body).json()
        shown = self.client.post(self.url(1, "/preview"), self.draft(saved), content_type="application/json")
        self.assertEqual(shown.status_code, 200, shown.content)
        self.assertEqual(self.blob_at(shown.json()["lines"][0], DOT[0])["allocations"], [])
        with drawn_pages():
            calibration_service.process_page(self.mushaf, 1, expected_revision=saved["revision"], user=default_user())
        blob = self.blob_at(self.document(1)["lines"][0], DOT[0])
        self.assertEqual(blob["allocations"], [])
        self.assertTrue(blob["ownership_explicit"])
        self.assertEqual(blob["subtype"], "fatha")

    def test_preview_leaves_an_unedited_aya_unchanged(self):
        body = self.draft(self.doc)
        self.draft_blob(body, 0, BODIES[1][0]).update(role="mark", explicit=True, allocations=[])
        shown = self.client.post(self.url(1, "/preview"), body, content_type="application/json")
        self.assertEqual(shown.status_code, 200, shown.content)
        self.assertEqual(shown.json()["lines"][1], self.doc["lines"][1])

    def test_unresolved_preview_keeps_roles_allocations_and_words(self):
        from dataclasses import replace

        from core.word_boundary.engine import detect_prepared

        body = self.draft(self.doc)
        self.draft_blob(body, 0, DOT[0]).update(explicit=True)

        def unresolved(*args, **kwargs):
            result = detect_prepared(*args, **kwargs)
            return replace(
                result,
                lines=[
                    replace(line, status="unresolved", reason="human-constraints", words=[]) for line in result.lines
                ],
            )

        with mock.patch.object(calibration_service, "detect_prepared", side_effect=unresolved):
            shown = self.client.post(self.url(1, "/preview"), body, content_type="application/json")
        self.assertEqual(shown.status_code, 200, shown.content)
        row = shown.json()["lines"][0]
        self.assertEqual(row["status"], "unresolved")
        self.assertEqual(row["words"], self.doc["lines"][0]["words"])
        self.assertEqual(
            [b["allocations"] for b in row["blobs"]], [b["allocations"] for b in self.doc["lines"][0]["blobs"]]
        )

    def test_a_human_lock_is_obeyed_and_nothing_is_stored(self):
        body = self.draft(self.doc)
        middle = self.draft_blob(body, 0, BODIES[1][0])
        # A mark carries no PAW, so the body's share of word 2 goes with its role —
        # the server refuses a mark that still claims one (see the next test).
        middle.update(role="mark", explicit=True, allocations=[])
        response = self.client.post(self.url(1, "/preview"), body, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        line = response.json()["lines"][0]
        locked = self.blob_at(line, BODIES[1][0])
        self.assertEqual((locked["role"], locked["decision_source"]), ("mark", "human"))
        # Still attached to a word, as any mark is — but claiming none of its PAWs.
        self.assertTrue(all(allocation["paws"] == 0 for allocation in locked["allocations"]))
        # Three words still need three bodies, and the dot is the only ink left.
        dot = self.blob_at(line, DOT[0])
        self.assertEqual(dot["role"], "body")
        self.assertIn("search-override", dot["attention"])
        self.assertTrue(response.json()["preview"])
        self.assertEqual(CalibrationReview.objects.get(mushaf=self.mushaf, page_number=1).revision, 1)

    def test_a_mark_that_still_claims_a_paw_is_refused(self):
        body = self.draft(self.doc)
        self.draft_blob(body, 0, BODIES[1][0]).update(role="mark", explicit=True)
        response = self.client.post(self.url(1, "/preview"), body, content_type="application/json")
        self.assertEqual(response.status_code, 422)

    def test_edges_sent_by_a_client_are_ignored_and_boxes_follow_the_ink(self):
        """No edge is placed by hand: a draft carries blob decisions, and every box is
        the extent of its word's ink — whatever a client sends beside them."""
        body = self.draft(self.doc)
        body["lines"][0]["words"] = [{"word_id": 2, "start_x": 900, "end_x": 450, "override": True, "shared": False}]
        for response in (
            self.client.post(self.url(1, "/preview"), body, content_type="application/json"),
            self.put(1, body),
        ):
            self.assertEqual(response.status_code, 200, response.content)
            words = response.json()["lines"][0]["words"]
            self.assertEqual([(w["start_x"], w["end_x"]) for w in words], [(right, left) for left, right in BODIES])
            self.assertNotIn("override", words[1])

    def test_a_box_follows_the_ink_given_to_its_word(self):
        body = self.draft(self.doc)
        # The second body handed to word 1: word 1 now reaches across it, and word 2,
        # left with no ink, keeps the edges it had.
        self.draft_blob(body, 0, BODIES[1][0]).update(allocations=[{"word_id": 1, "paws": 1}], ownership_explicit=True)
        words = self.put(1, body).json()["lines"][0]["words"]
        self.assertEqual((words[0]["start_x"], words[0]["end_x"]), (BODIES[0][1], BODIES[1][0]))
        self.assertEqual((words[1]["start_x"], words[1]["end_x"]), (BODIES[1][1], BODIES[1][0]))

    def test_accepting_a_preview_stores_what_it_showed(self):
        body = self.draft(self.doc)
        self.draft_blob(body, 0, BODIES[1][0]).update(role="mark", explicit=True, allocations=[])
        shown = self.client.post(self.url(1, "/preview"), body, content_type="application/json").json()
        # A plain save stores the decisions but keeps the old reading's verdicts:
        # the dot is still the mark the first reading made it.
        saved = self.put(1, body).json()
        self.assertEqual(self.blob_at(saved["lines"][0], DOT[0])["role"], "mark")
        # Accepting re-reads under the same edits, and stores the preview itself.
        accepted = self.put(1, {**self.draft(saved), "realign": True})
        self.assertEqual(accepted.status_code, 200, accepted.content)
        stored, previewed = accepted.json()["lines"][0], shown["lines"][0]
        self.assertEqual(stored["words"], previewed["words"])
        self.assertEqual((stored["status"], stored["reason"]), (previewed["status"], previewed["reason"]))
        self.assertEqual(
            [(b["id"], b["role"], b["allocations"], b["attention"]) for b in stored["blobs"]],
            [(b["id"], b["role"], b["allocations"], b["attention"]) for b in previewed["blobs"]],
        )
        self.assertIn("search-override", self.blob_at(stored, DOT[0])["attention"])


class ConfirmTests(CalibrationApiTestCase):
    def setUp(self):
        super().setUp()
        self.process(1)
        self.doc = self.document(1)

    def test_confirming_writes_the_words(self):
        response = self.confirm(1, self.draft(self.doc))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["confirmed_revision"], 2)
        line = Line.objects.get(page__mushaf=self.mushaf, page__page_number=1, line_number=1)
        self.assertEqual(
            list(line.words.values_list("word_id", "start_x", "end_x")),
            [(word, right, left) for word, (left, right) in zip((1, 2, 3), BODIES, strict=True)],
        )
        approval = CalibrationRevision.objects.get(review__page_number=1, number=2)
        self.assertEqual(approval.kind, "confirmed")
        self.assertNotIn("context", approval.payload)

    def test_exceptions_must_be_acknowledged(self):
        body = self.draft(self.doc)
        body["lines"][0]["blobs"][0]["exception"] = "uncertain"
        self.assertEqual(self.confirm(1, body).status_code, 422)
        body["acknowledge_exceptions"] = True
        response = self.confirm(1, body)
        self.assertEqual(response.status_code, 200, response.content)
        approval = CalibrationRevision.objects.get(review__page_number=1, kind="confirmed")
        self.assertEqual([item["kind"] for item in approval.payload["acknowledged"]], ["flagged"])

    def test_a_count_that_does_not_close_is_an_exception(self):
        body = self.draft(self.doc)
        first = self.draft_blob(body, 0, BODIES[0][0])
        first["allocations"] = [{"word_id": 1, "paws": 2}]
        self.assertEqual(self.confirm(1, body).status_code, 422)


class SettingsTests(CalibrationApiTestCase):
    def test_experimental_requires_acknowledgment_and_checks_revision(self):
        url = f"/api/mushafs/{self.mushaf.id}/calibration/settings"
        data = {"revision": 0, "experimental": True}
        self.assertEqual(self.client.put(url, data, content_type="application/json").status_code, 422)
        data["acknowledge_unvalidated"] = True
        response = self.client.put(url, data, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json()["experimental"])
        self.assertEqual(self.client.put(url, data, content_type="application/json").status_code, 409)

    def test_experimental_run_keeps_an_unlocked_baseline(self):
        CalibrationSettings.objects.create(mushaf=self.mushaf, experimental=True)
        with mock.patch.object(
            calibration_service, "align_document", wraps=calibration_service.align_document
        ) as align:
            self.process(1)
        self.assertTrue(any(call.kwargs.get("calibration_locks") for call in align.call_args_list))
        doc = self.document(1)
        self.assertEqual(doc["profile"]["mode"], "experimental")
        stored = CalibrationRevision.objects.get(review__mushaf=self.mushaf, kind="processed")
        self.assertEqual(stored.payload["profile"]["mode"], "shadow")
        self.assertEqual(stored.payload["profile"]["pages"], [])
        profile = CalibrationProfile.objects.get(signature=doc["profile"]["signature"])
        self.assertEqual((profile.payload["comparison"], profile.payload["limit"]), ("descriptor32", 0.27))

    def test_the_limit_is_saved_checked_and_part_of_the_profile(self):
        url = f"/api/mushafs/{self.mushaf.id}/calibration/settings"
        data = {"revision": 0, "experimental": False, "limit": 0.4}
        response = self.client.put(url, data, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        saved = response.json()
        self.assertEqual((saved["comparison"], saved["limit"], saved["default_limit"]), ("descriptor32", 0.4, 0.27))
        for refused in ({"limit": 0}, {"limit": -1}, {"limit": 11}, {"comparison": "unknown"}):
            body = {"revision": 1, "experimental": False, **refused}
            self.assertEqual(self.client.put(url, body, content_type="application/json").status_code, 422)
        self.process(1)
        profile = CalibrationProfile.objects.get(signature=self.document(1)["profile"]["signature"])
        self.assertEqual(profile.payload["limit"], 0.4)
        # A null LIMIT is the comparison's default again.
        response = self.client.put(
            url, {"revision": 1, "experimental": False, "limit": None}, content_type="application/json"
        )
        self.assertEqual(response.json()["limit"], 0.27)

    def test_predicted_subtypes_do_not_teach_without_explicit_confirmation(self):
        self.process(1)
        doc = self.document(1)
        body = self.draft(doc)
        mark = next(b for b in body["lines"][0]["blobs"] if b["role"] == "mark")
        mark.update(subtype="fatha", subtype_explicit=False)
        self.assertEqual(self.confirm(1, body).status_code, 200)
        samples = calibration_service._samples(self.mushaf, calibration_service._approved(self.mushaf, 2))
        self.assertTrue(all(not s["subtype"] for s in samples))


class RestartTests(CalibrationApiTestCase):
    def test_restart_requires_apply_backs_up_and_excludes_old_confirmations(self):
        self.process(1)
        self.assertEqual(self.confirm(1, self.draft(self.document(1))).status_code, 200)
        self.assertTrue(LineWord.objects.filter(line__page__mushaf=self.mushaf, line__page__page_number=1).exists())
        before = self.document(1)
        output = io.StringIO()
        call_command("restart_calibration", str(self.mushaf.pk), stdout=output)
        self.assertIn("DRY RUN", output.getvalue())
        self.assertEqual(self.document(1)["revision"], before["revision"])
        with TemporaryDirectory() as directory:
            backup = Path(directory) / "backup.zip"
            call_command("restart_calibration", str(self.mushaf.pk), apply=True, backup=backup, stdout=io.StringIO())
            self.assertTrue(backup.is_file())
        review = CalibrationReview.objects.get(mushaf=self.mushaf, page_number=1)
        self.assertIsNone(review.confirmed_revision)
        self.assertEqual(calibration_service._approved(self.mushaf, 2), [])
        self.assertTrue(review.revisions.filter(kind="confirmed").exists())
        self.assertFalse(self.document(1)["processed"])
        # Words exist only by confirmation: a restarted page has none.
        self.assertFalse(LineWord.objects.filter(line__page__mushaf=self.mushaf, line__page__page_number=1).exists())


class LearningTests(CalibrationApiTestCase):
    """Page 1 confirmed, page 2 read with it."""

    def setUp(self):
        super().setUp()
        self.process(1)
        self.confirm(1, self.draft(self.document(1)))
        self.process(2)

    def test_the_next_page_is_predicted_from_the_confirmed_one_only(self):
        document = self.document(2)
        self.assertEqual(document["profile"]["pages"], [1])
        self.assertEqual(document["profile"]["examples"], 8)  # 3 bodies + 1 dot, twice
        self.assertLessEqual(document["profile"]["fingerprints"], 8)
        profile = CalibrationProfile.objects.get(signature=document["profile"]["signature"])
        self.assertEqual(profile.mode, "shadow")
        # The library answers once it knows letters and marks, and says how sure.
        blob = self.blob_at(document["lines"][0], BODIES[0][0])
        self.assertEqual(blob["proposed_role"], "body")
        self.assertEqual(blob["proposal"]["reasons"], [])
        self.assertGreater(blob["proposal"]["confidence"], 0.5)

    def test_the_inspector_shows_where_the_nearest_examples_came_from(self):
        line = self.document(2)["lines"][0]
        blob = self.blob_at(line, BODIES[0][0])
        response = self.client.get(self.url(2, "/examples"), {"snapshot": line["snapshot_id"], "blob": blob["id"]})
        self.assertEqual(response.status_code, 200, response.content)
        nearest = response.json()["neighbors"][0]
        self.assertEqual((nearest["role"], nearest["page_number"], nearest["copies"]), ("body", 1, 6))
        self.assertEqual(nearest["distance"], 0.0)
        self.assertIsNotNone(nearest["crop"])

    def test_the_evaluation_lays_three_results_against_the_confirmation(self):
        response = self.client.get(f"/api/mushafs/{self.mushaf.id}/calibration/evaluation")
        self.assertEqual(response.status_code, 200, response.content)
        report = response.json()
        self.assertEqual((report["confirmed_pages"], report["activation_allowed"]), (1, False))
        page = report["pages"][0]
        self.assertEqual(set(page["results"]), {"frozen", "canonical", "calibrated"})
        self.assertEqual(page["results"]["canonical"], {"body_as_mark": 0, "mark_as_body": 0, **NO_WORD_ERRORS})
        self.assertEqual(page["results"]["frozen"], NO_WORD_ERRORS)

    def test_visual_comparison_uses_retained_snapshots_and_confirmed_not_draft_edges(self):
        original = self.document(1)
        body = self.draft(original)
        # After confirming, the second body is given to word 1 in the draft: its box
        # now reaches across it, but the confirmed reading's does not.
        middle = self.blob_at(original["lines"][0], BODIES[1][0])["id"]
        next(blob for blob in body["lines"][0]["blobs"] if blob["id"] == middle).update(
            allocations=[{"word_id": 1, "paws": 1}], ownership_explicit=True
        )
        self.assertEqual(self.put(1, body).status_code, 200)
        with mock.patch("api.services.line_images._render_page", side_effect=AssertionError("no PDF rendering")):
            response = self.client.get(self.url(1, "/evaluation"))
        self.assertEqual(response.status_code, 200, response.content)
        row = response.json()["lines"][0]
        self.assertIn("/calibration/", row["image_url"])
        self.assertEqual(set(row["readings"]), {"frozen", "canonical", "calibrated", "confirmed"})
        self.assertEqual(row["readings"]["confirmed"]["words"][0]["end_x"], BODIES[0][0])
        self.assertEqual(self.document(1)["lines"][0]["words"][0]["end_x"], BODIES[1][0])

    def test_visual_comparison_requires_confirmation(self):
        self.assertEqual(self.client.get(self.url(2, "/evaluation")).status_code, 404)

    def test_examples_come_from_the_profile_the_page_was_read_with(self):
        line = self.document(2)["lines"][0]
        blob = self.blob_at(line, BODIES[0][0])
        query = {"snapshot": line["snapshot_id"], "blob": blob["id"]}
        before = self.client.get(self.url(2, "/examples"), query).json()
        # Page 1 is confirmed again with every blob flagged, so today it teaches
        # nothing — but page 2's proposals were made from the first confirmation.
        body = self.draft(self.document(1))
        for row in body["lines"]:
            for edit in row["blobs"]:
                edit["exception"] = "uncertain"
        self.assertEqual(self.confirm(1, {**body, "acknowledge_exceptions": True}).status_code, 200)
        after = self.client.get(self.url(2, "/examples"), query).json()
        self.assertTrue(before["neighbors"])
        self.assertEqual(after["neighbors"], before["neighbors"])

    def test_page_states_list_both_pages(self):
        response = self.client.get(f"/api/mushafs/{self.mushaf.id}/calibration/pages")
        states = {row["page"]: row for row in response.json()["pages"]}
        self.assertEqual(states[1]["confirmed_revision"], 2)
        self.assertIsNone(states[2]["confirmed_revision"])
        self.assertTrue(states[2]["processed"])


class SurvivalTests(CalibrationApiTestCase):
    def test_reprocessing_detection_keeps_snapshots_reviews_and_history(self):
        self.process(1)
        self.confirm(1, self.draft(self.document(1)))
        Page.objects.get(mushaf=self.mushaf, page_number=1).lines.all().delete()
        self.assertEqual(CalibrationSnapshot.objects.filter(mushaf=self.mushaf, page_number=1).count(), 2)
        review = CalibrationReview.objects.get(mushaf=self.mushaf, page_number=1)
        self.assertEqual(review.confirmed_revision, 2)
        self.assertFalse(LineWord.objects.filter(line__page__page_number=1).exists())
        self.assertTrue(self.document(1)["stale"])


class FusionTests(CalibrationApiTestCase):
    """Page 1's first line prints words 2 and 3 as one blob."""

    def setUp(self):
        super().setUp()
        with drawn_pages(fused_page=1):
            self.client.post(self.url(1, "/process"))
        self.doc = self.document(1)

    def share(self, body: dict, words: list[int]) -> dict:
        blob = self.draft_blob(body, 0, FUSED[0])
        blob.update(
            role="body",
            explicit=True,
            ownership_explicit=True,
            allocations=[{"word_id": word, "paws": 1} for word in words],
        )
        return body

    def test_a_word_whose_only_ink_is_a_shared_blob_is_placed(self):
        body = self.share(self.draft(self.doc), [2, 3])
        response = self.client.post(self.url(1, "/preview"), body, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        line = response.json()["lines"][0]
        self.assertEqual(line["status"], "exact")
        words = {word["word_id"]: word for word in line["words"]}
        self.assertEqual(sorted(words), [1, 2, 3])
        # Each starts or ends at the middle of the blob they share, until dragged.
        middle = (FUSED[0] + FUSED[1]) // 2
        self.assertEqual((words[2]["start_x"], words[2]["end_x"]), (FUSED[1], middle))
        self.assertEqual((words[3]["start_x"], words[3]["end_x"]), (middle, FUSED[0]))
        self.assertTrue(words[2]["shared"] and words[3]["shared"])
        self.assertEqual((words[1]["start_x"], words[1]["end_x"]), BODIES[0][::-1])
        self.assertEqual(self.blob_at(line, DOT[0])["role"], "mark")
        # Every count closes on its own share: nothing to acknowledge.
        self.assertEqual(calibration_service.exceptions(response.json()), [])

    def test_a_blob_can_only_be_shared_by_neighbouring_words(self):
        body = self.share(self.draft(self.doc), [1, 3])
        response = self.client.post(self.url(1, "/preview"), body, content_type="application/json")
        self.assertEqual(response.status_code, 422)


class FusedUnitTests(SimpleTestCase):
    def test_chains_join_and_only_neighbours_in_one_aya_do(self):
        stream = [{"id": ident, "aya": "2:5" if ident < 7 else "2:6"} for ident in range(1, 10)]

        def shared(*ids: int) -> dict:
            return {"role": "body", "ownership_explicit": True, "allocations": [{"word_id": i, "paws": 1} for i in ids]}

        units = calibration_service._fused_units
        # Blobs shared by 4-5 and by 5-6 chain into one unit of three words.
        self.assertEqual(units([{"blobs": [shared(4, 5), shared(5, 6)]}], stream), {4: [4, 5, 6]})
        # One blob cannot join words with another word between them...
        self.assertEqual(units([{"blobs": [shared(1, 3)]}], stream), {})
        # ...nor two ayat — and a chain that would is refused whole.
        self.assertEqual(units([{"blobs": [shared(5, 6), shared(6, 7)]}], stream), {})


class EvaluationCountTests(SimpleTestCase):
    def test_wrong_lines_extras_and_duplicates_are_counted(self):
        truth = {1: [((1, 1), 610, 580)], 2: [((1, 1), 490, 460)], 3: [((1, 1), 370, 340)]}
        found = {
            1: [((1, 2), 610, 580)],  # the right x on the wrong line
            2: [((1, 1), 490, 460), ((1, 2), 490, 460)],  # placed twice
            3: [((1, 1), 380, 340)],  # moved
            9: [((1, 1), 300, 250)],  # a word the page does not have
            10: [((2, 1), 300, 250)],  # the next page's word: none of this page's business
        }
        self.assertEqual(
            calibration_service._word_errors(found, truth, 1),
            {"words_moved": 1, "words_wrong_line": 1, "words_missing": 0, "words_duplicated": 1, "words_extra": 1},
        )


class ReprocessTests(CalibrationApiTestCase):
    def test_processing_again_keeps_the_decisions_on_unchanged_lines(self):
        self.process(1)
        self.doc = self.document(1)
        body = self.draft(self.doc)
        self.draft_blob(body, 0, DOT[0]).update(role="mark", explicit=True, subtype="ijamDot")
        self.assertEqual(self.put(1, body).status_code, 200)
        # Line 2 is re-reviewed: its snapshot, and so the page, goes stale.
        Segment.objects.filter(line__page__page_number=1, line__line_number=2).update(bbox_w=700 - RING[0] - 1)
        self.assertTrue(self.document(1)["stale"])
        self.assertEqual(self.process(1).status_code, 202)
        fresh = self.document(1)
        self.assertFalse(fresh["stale"])
        dot = self.blob_at(fresh["lines"][0], DOT[0])
        self.assertEqual((dot["explicit"], dot["subtype"], dot["decision_source"]), (True, "ijamDot", "human"))
        # The boxes are the new reading's, from the ink.
        words = fresh["lines"][0]["words"]
        self.assertEqual([(w["start_x"], w["end_x"]) for w in words], [(right, left) for left, right in BODIES])
        # ... and the new prediction record carries none of it.
        predicted = (
            CalibrationRevision.objects.filter(review__page_number=1, kind="processed").order_by("number").last()
        )
        assert predicted is not None
        self.assertFalse(any(blob["explicit"] for blob in predicted.payload["lines"][0]["blobs"]))


class CrossingTestCase(CalibrationApiTestCase):
    """Aya 6 runs from page 1's second line onto page 2's first: page 1's context."""

    def setUp(self):
        super().setUp()
        kufi = CountingSystem.objects.get(name="Kufi")
        Aya.objects.filter(counting_system=kufi, sura_id=2, number__in=(7, 8)).delete()
        Aya.objects.create(counting_system=kufi, sura_id=2, number=7, start_word_id=10)
        segments = Segment.objects.filter(line__page__mushaf=self.mushaf)
        segments.filter(line__page__page_number=1, line__line_number=2).update(has_separator=False)
        segments.filter(line__page__page_number=2, line__line_number=1).update(aya_number=6)
        segments.filter(line__page__page_number=2, line__line_number=2).update(aya_number=7)

    def process(self, page: int):
        with drawn_pages(ringless={1: (2,)}):
            return self.client.post(self.url(page, "/process"))


class ContextTests(CrossingTestCase):
    def test_a_changed_neighbour_stops_reading_until_the_page_is_processed_again(self):
        self.assertEqual(self.process(1).status_code, 202)
        self.doc = self.document(1)
        self.assertEqual([(row["page_number"], row["line_number"]) for row in self.doc["context"]], [(2, 1)])
        self.assertEqual([row["status"] for row in self.doc["lines"]], ["exact", "exact"])
        body = self.draft(self.doc)
        self.draft_blob(body, 0, DOT[0]).update(role="mark", explicit=True)
        self.assertEqual(self.put(1, body).status_code, 200)
        # The neighbouring line is re-reviewed.
        Segment.objects.filter(line__page__page_number=2, line__line_number=1).update(bbox_w=700 - RING[0] - 1)
        document = self.document(1)
        self.assertEqual((document["stale"], document["context_stale"]), (False, True))
        preview = self.client.post(self.url(1, "/preview"), self.draft(document), content_type="application/json")
        self.assertEqual(preview.status_code, 409)
        # Saving reads nothing, so it still works; processing again is now allowed,
        # and keeps the decision made on the unchanged line.
        self.assertEqual(self.put(1, self.draft(document)).status_code, 200)
        self.assertEqual(self.process(1).status_code, 202)
        fresh = self.document(1)
        self.assertFalse(fresh["context_stale"])
        self.assertTrue(self.blob_at(fresh["lines"][0], DOT[0])["explicit"])

    def test_changed_confirmed_labels_in_context_require_reprocessing(self):
        self.process(2)
        self.confirm(2, self.draft(self.document(2), acknowledge_exceptions=True))
        self.process(1)
        before = self.document(1)
        self.assertFalse(before["context_stale"])
        self.doc = self.document(2)
        body = self.draft(self.doc, acknowledge_exceptions=True)
        self.draft_blob(body, 0, DOT[0]).update(role="body", explicit=True)
        self.assertEqual(self.confirm(2, body).status_code, 200)
        after = self.document(1)
        self.assertTrue(after["context_stale"])
        self.assertEqual(
            self.client.post(self.url(1, "/preview"), self.draft(after), content_type="application/json").status_code,
            409,
        )
        self.process(1)
        self.assertFalse(self.document(1)["context_stale"])


class CopyTests(CalibrationApiTestCase):
    """A page processed and confirmed, then carried into another mushaf."""

    def setUp(self):
        super().setUp()
        self.process(1)
        self.confirm(1, self.draft(self.document(1)))

    def test_a_duplicate_keeps_its_reviews_current(self):
        copy = cloning.duplicate(self.mushaf, owner=self.mushaf.owner)
        document = self.client.get(f"/api/mushafs/{copy.id}/pages/1/calibration").json()
        self.assertFalse(document["stale"])
        own = str(Line.objects.get(page__mushaf=copy, page__page_number=1, line_number=1).pk)
        original = str(Line.objects.get(page__mushaf=self.mushaf, page__page_number=1, line_number=1).pk)
        self.assertEqual((document["lines"][0]["line_id"], document["lines"][0]["source_line_id"]), (own, original))
        report = self.client.get(f"/api/mushafs/{copy.id}/calibration/evaluation").json()
        self.assertEqual(report["confirmed_pages"], 1)

    def test_importing_over_a_worked_mushaf_shifts_every_revision_reference(self):
        CalibrationSettings.objects.create(mushaf=self.mushaf, experimental=True, revision=3)
        _, output = bundle.build(self.mushaf.pk, user=self.mushaf.owner)
        with output:
            data = output.read()
        bundle.apply_bundle(self.mushaf.pk, SimpleUploadedFile("work.zip", data), user=self.mushaf.owner, replace=True)
        review = CalibrationReview.objects.get(mushaf=self.mushaf, page_number=1)
        # The imported processing and confirmation follow the history they joined,
        # and the page and its approval still name the processing they came from.
        assert review.confirmed_revision is not None
        processed = review.confirmed_revision - 1
        self.assertGreater(processed, 2)
        self.assertEqual(review.payload["processed_revision"], processed)
        approval = review.revisions.get(number=review.confirmed_revision)
        self.assertEqual(approval.payload["processed_revision"], processed)
        self.assertEqual(review.revisions.get(number=processed).kind, "processed")
        self.assertFalse(self.document(1)["stale"])
        setting = CalibrationSettings.objects.get(mushaf=self.mushaf)
        self.assertFalse(setting.experimental)
        self.assertEqual(setting.revision, 4)


class MarkEdgeTests(CalibrationApiTestCase):
    """Page 1's first line carries a stray mark just left of its first body."""

    def test_a_word_spans_its_marks_as_well_as_its_bodies(self):
        with drawn_pages(stray=True):
            self.assertEqual(self.client.post(self.url(1, "/process")).status_code, 202)
        line = self.document(1)["lines"][0]
        stray = self.blob_at(line, STRAY[0])
        self.assertEqual((stray["role"], stray["allocations"]), ("mark", [{"word_id": 1, "paws": 0}]))
        first = line["words"][0]
        # Its body alone would end the word at 580; the mark carries it on to 560.
        self.assertEqual((first["word_id"], first["start_x"], first["end_x"]), (1, BODIES[0][1], STRAY[0]))

    def process_stray(self) -> None:
        with drawn_pages(stray=True):
            self.assertEqual(self.client.post(self.url(1, "/process")).status_code, 202)
        self.doc = self.document(1)

    def test_a_mark_given_to_another_word_moves_both_boxes(self):
        self.process_stray()
        body = self.draft(self.doc)
        self.draft_blob(body, 0, STRAY[0]).update(allocations=[{"word_id": 2, "paws": 0}], ownership_explicit=True)
        response = self.put(1, body)
        self.assertEqual(response.status_code, 200, response.content)
        words = response.json()["lines"][0]["words"]
        self.assertEqual((words[0]["start_x"], words[0]["end_x"]), (BODIES[0][1], BODIES[0][0]))
        self.assertEqual((words[1]["start_x"], words[1]["end_x"]), (STRAY[1], BODIES[1][0]))

    def test_sending_back_the_draft_as_it_stands_is_no_edit(self):
        self.process_stray()
        self.assertEqual(self.put(1, self.draft(self.doc)).status_code, 200)
        review = CalibrationReview.objects.get(mushaf=self.mushaf, page_number=1)
        self.assertEqual(review.payload["pending_ayas"], [])
        self.assertEqual([row["words"] for row in review.payload["lines"]], [row["words"] for row in self.doc["lines"]])


class DecisionTests(CalibrationApiTestCase):
    def setUp(self):
        super().setUp()
        self.process(1)
        self.doc = self.document(1)

    def test_a_role_sent_without_a_decision_is_no_lock(self):
        # What undoing an accepted preview sends: the reading from before it, with
        # nobody's decision on it. Stored as a reading, never as a hard lock.
        body = self.draft(self.doc)
        self.draft_blob(body, 0, DOT[0]).update(role="body", allocations=[{"word_id": 1, "paws": 0}])
        stored = self.blob_at(self.put(1, body).json()["lines"][0], DOT[0])
        self.assertEqual((stored["role"], stored["explicit"]), ("body", False))
        self.assertNotEqual(stored["decision_source"], "human")


class ScopedPreviewTests(CrossingTestCase):
    """A preview reads the page whole but takes the new reading only for what was
    edited. These pin the two ways that could lose or double a word: a word the
    reading moves to another line, and a line that gains a word of the edited aya.
    """

    def edited_aya_6(self) -> dict:
        self.assertEqual(self.process(1).status_code, 202)
        self.doc = self.document(1)
        body = self.draft(self.doc)
        # A decision on one of line 2's bodies puts aya 6 — and only aya 6 — in play.
        self.draft_blob(body, 1, BODIES[1][0]).update(explicit=True)
        return body

    def preview_with(self, move) -> dict:
        from dataclasses import replace

        from core.word_boundary.engine import detect_prepared

        def moved(*args, **kwargs):
            result = detect_prepared(*args, **kwargs)
            words = [list(line.words) for line in result.lines]
            move(words)
            return replace(
                result, lines=[replace(line, words=placed) for line, placed in zip(result.lines, words, strict=True)]
            )

        body = self.edited_aya_6()
        with mock.patch.object(calibration_service, "detect_prepared", side_effect=moved):
            response = self.client.post(self.url(1, "/preview"), body, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    @staticmethod
    def ids(row: dict) -> list[int]:
        return [word["word_id"] for word in row["words"] if word["word_id"] is not None]

    def test_a_word_moved_to_the_next_line_is_there_once(self):
        def move(words):  # word 6 leaves page 1's second line for page 2's first
            box = words[1].pop()
            words[2].insert(0, replace_components(box))

        shown = self.preview_with(move)
        everywhere = [ident for row in shown["lines"] + shown["context"] for ident in self.ids(row)]
        self.assertEqual(everywhere.count(6), 1)
        self.assertNotIn(6, self.ids(shown["lines"][1]))

    def test_a_word_moved_onto_a_line_of_another_aya_lands_there(self):
        def move(words):  # word 4 leaves the second line for the first, which holds only aya 5
            box = words[1].pop(0)
            words[0].append(replace_components(box))

        shown = self.preview_with(move)
        self.assertEqual(self.ids(shown["lines"][0]), [1, 2, 3, 4])
        self.assertNotIn(4, self.ids(shown["lines"][1]))


def replace_components(box):
    """A word box moved to another line takes none of that line's ink with it."""
    from dataclasses import replace

    return replace(box, components=[])


class ChangedAyaTests(SimpleTestCase):
    def test_ink_passed_between_ayat_brings_the_other_aya_in(self):
        original = {1: {"aya": "2:5"}, 4: {"aya": "2:6"}, 10: {"aya": "2:7"}, 11: {"aya": "2:8"}}

        def blob(ident: int, owner: int) -> dict:
            return {"id": ident, "allocations": [{"word_id": owner, "paws": 1}]}

        before = {"blobs": [blob(1, 1), blob(2, 10)]}
        after = {"blobs": [blob(1, 4), blob(2, 11)]}
        # Blob 1 passes from aya 5 to the edited aya 6, so aya 5 changed too; blob 2
        # passes between two ayat nobody edited, and brings neither in.
        scope = calibration_service._changed_ayas([(before, after, None)], {"2:6"}, original)
        self.assertEqual(scope, {"2:5", "2:6"})


class TypeSuggestionTests(CalibrationApiTestCase):
    """Every line's dot is the same drawn glyph, so one typed dot names them all."""

    def suggest(self, page: int, body: dict) -> dict:
        response = self.client.post(self.url(page, "/types"), body, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def type_dots(self, body: dict, lines: tuple[int, ...], *, explicit: bool = True) -> dict:
        for index in lines:
            self.draft_blob(body, index, DOT[0]).update(role="mark", subtype="ijamDot", subtype_explicit=explicit)
        return body

    def test_a_type_confirmed_on_one_page_is_suggested_on_the_next(self):
        self.process(1)
        self.doc = self.document(1)
        self.assertEqual(self.confirm(1, self.type_dots(self.draft(self.doc), (0, 1))).status_code, 200)
        self.process(2)
        self.doc = self.document(2)
        answer = self.suggest(2, self.draft(self.doc))
        dots = {self.blob_at(line, DOT[0])["id"] for line in self.doc["lines"]}
        found = [s for s in answer["suggestions"] if s["blob_id"] in dots]
        self.assertEqual(len(found), 2)
        self.assertTrue(all((s["subtype"], s["sure"]) == ("ijamDot", True) for s in found))
        self.assertEqual(answer["examples"], 2)

    def test_typing_a_mark_teaches_the_rest_of_the_page_at_once(self):
        self.process(1)
        self.doc = self.document(1)
        before = self.doc["revision"]
        answer = self.suggest(1, self.type_dots(self.draft(self.doc), (0,)))
        self.assertEqual(answer["typed_here"], 1)
        second = self.blob_at(self.doc["lines"][1], DOT[0])
        self.assertIn(
            ("ijamDot", True),
            [
                (s["subtype"], s["sure"])
                for s in answer["suggestions"]
                if s["snapshot_id"] == self.doc["lines"][1]["snapshot_id"] and s["blob_id"] == second["id"]
            ],
        )
        # The typed dot asks for nothing, and nothing was stored.
        first = self.blob_at(self.doc["lines"][0], DOT[0])
        self.assertFalse(
            any(
                s["blob_id"] == first["id"] and s["snapshot_id"] == self.doc["lines"][0]["snapshot_id"]
                for s in answer["suggestions"]
            )
        )
        self.assertEqual(self.document(1)["revision"], before)

    def test_a_guess_nobody_accepted_teaches_nothing(self):
        self.process(1)
        self.doc = self.document(1)
        body = self.type_dots(self.draft(self.doc), (0, 1), explicit=False)
        self.assertEqual(self.confirm(1, body).status_code, 200)
        self.process(2)
        answer = self.suggest(2, self.draft(self.document(2)))
        self.assertEqual((answer["examples"], answer["suggestions"]), (0, []))


class TypeDoubtTests(CalibrationApiTestCase):
    """Every line carries a dot and a flat bar: two mark shapes. Page 1 is confirmed
    with the dots typed ijamDot and the bars fatha; page 2 is processed and open."""

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

    def test_a_type_the_other_pages_disagree_with_is_doubted(self):
        body = self.draft(self.doc)
        slip = self.type_mark(body, 0, BAR[0], "ijamDot")
        self.type_mark(body, 0, DOT[0], "ijamDot")
        response = self.client.post(self.url(2, "/types"), body, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        doubts = [(d["blob_id"], d["typed"], d["subtype"], d["sure"]) for d in response.json()["doubts"]]
        self.assertEqual(doubts, [(slip["id"], "ijamDot", "fatha", True)])

    def test_the_evidence_is_the_nearest_examples_of_each_near_type(self):
        line = self.doc["lines"][0]
        bar = self.blob_at(line, BAR[0])
        body = {**self.draft(self.doc), "snapshot_id": line["snapshot_id"], "blob_id": bar["id"]}
        response = self.client.post(self.url(2, "/types/evidence"), body, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        answer = response.json()
        self.assertFalse(answer["typed"])
        self.assertEqual([entry["subtype"] for entry in answer["candidates"]], ["fatha", "ijamDot"])
        best = answer["candidates"][0]
        self.assertEqual(best["distance"], 0.0)
        # Both of page 1's bars are one bitmap: one example, typed twice.
        (example,) = best["examples"]
        self.assertEqual((example["page_number"], example["copies"]), (1, 2))
        self.assertEqual((example["crop"]["w"], bool(example["image_url"])), (BAR[1] - BAR[0], True))


class EraseTests(CalibrationApiTestCase):
    """The stray speck by word 1, erased: noise the line's cutting left, not ink of
    the text — read around, kept through processing, cut out of the line's PNG."""

    def setUp(self):
        super().setUp()
        with drawn_pages(stray=True):
            self.client.post(self.url(1, "/process"))
        self.doc = self.document(1)

    def erase(self, document: dict, erased: bool = True) -> dict:
        body = self.draft(document, realign=True)
        self.draft_blob(body, 0, STRAY[0])["erased"] = erased
        response = self.put(1, body)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def exported_alpha(self) -> tuple[np.ndarray, tuple[int, int]]:
        picture = io.BytesIO()
        _drawn_page(stray=True).save(picture, format="PNG")
        with mock.patch.object(export.pdf, "render_page", return_value=picture.getvalue()):
            export.export_lines(user=default_user(), mushaf_id=self.mushaf.id, page_number=1)
        line = Line.objects.get(page__mushaf=self.mushaf, page__page_number=1, line_number=1)
        with line.line_png.open("rb") as handle:
            alpha = np.asarray(Image.open(handle).convert("RGBA").getchannel("A"))
        return alpha, export._origin(line, coordinates.page_column(line.page))

    def png_state(self) -> dict:
        page = Page.objects.get(mushaf=self.mushaf, page_number=1)
        document, _ = data_export._page(data_export._Context.of(self.mushaf), page, images=False, maps=False)
        return document["lines"][0]

    def test_erased_ink_belongs_to_no_word_and_the_word_reads_without_it(self):
        line = self.doc["lines"][0]
        # Read at first as word 1's mark, so word 1's box reaches out to hold it.
        self.assertTrue(self.blob_at(line, STRAY[0])["allocations"])
        self.assertEqual(line["words"][0]["end_x"], STRAY[0])
        line = self.erase(self.doc)["lines"][0]
        stray = self.blob_at(line, STRAY[0])
        self.assertEqual((stray["erased"], stray["allocations"], stray["attention"]), (True, [], []))
        self.assertEqual(line["words"][0]["end_x"], BODIES[0][0])

    def test_an_erase_holds_when_the_page_is_processed_again(self):
        saved = self.erase(self.doc)
        with drawn_pages(stray=True):
            calibration_service.process_page(self.mushaf, 1, expected_revision=saved["revision"], user=default_user())
        line = self.document(1)["lines"][0]
        self.assertEqual(self.blob_at(line, STRAY[0])["erased"], True)
        self.assertEqual(line["words"][0]["end_x"], BODIES[0][0])

    def test_an_ornament_is_not_erased(self):
        body = self.draft(self.doc)
        next(blob for blob in body["lines"][0]["blobs"] if blob["role"] == "ornament")["erased"] = True
        self.assertEqual(self.put(1, body).status_code, 422)

    def test_the_line_image_is_exported_without_it(self):
        self.erase(self.doc)
        alpha, (left, top) = self.exported_alpha()
        middle = LINE_TOPS[0] + 2 - top
        self.assertEqual(alpha[middle, STRAY[0] + 2 - left], 0)
        self.assertGreater(alpha[middle, DOT[0] + 2 - left], 0)

    def test_the_data_export_says_a_png_was_cut_with_other_erases(self):
        saved = self.erase(self.doc)
        self.exported_alpha()
        line = self.png_state()
        self.assertFalse(line["png"]["outdated"])
        self.assertTrue(next(blob for blob in line["blobs"] if blob["box"]["page"][0] == STRAY[0])["erased"])
        self.erase(saved, erased=False)
        self.assertTrue(self.png_state()["png"]["outdated"])
