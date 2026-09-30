"""What the text says about the ink, and doubts already answered.

* The engine's doubts about a blob — a score in the contested band, a first guess
  the count overruled, a tie — are not raised again once the confirmed examples, or
  the text, have answered them.
* The small waw and ya the text puts on the writing line (``بِهِۦ``) are found in the
  reading and locked as their word's marks, typed as small letters.
* Every word's marks are checked against the marks its text names: what the text
  surely names types the mark, a typed mark it names otherwise is doubted, and three
  loose dots in a triangle are the embraced pause sign.
"""

import io
from typing import ClassVar
from unittest import mock

from django.core.management import call_command
from django.test import SimpleTestCase

from api.models import CalibrationRevision
from api.services import calibration as calibration_service
from api.services import calibration_marks
from api.tests.test_calibration_api import BODIES, DOT, SMALL, STRAY, CalibrationApiTestCase, drawn_pages
from core.text import line_marks, text_marks
from core.word_boundary.mark_check import WordCheck
from quran.models import Word


class AnsweredDoubtTests(SimpleTestCase):
    @staticmethod
    def blob(**extra) -> dict:
        return {
            "id": 1,
            "role": "body",
            "initial_role": "mark",
            "body_score": 7,
            "explicit": False,
            "ownership_explicit": False,
            "proposed_role": None,
            "decision_source": "search",
            **extra,
        }

    @staticmethod
    def flags(blob: dict, *, ambiguous: bool = False) -> list[str]:
        return calibration_service._attention(blob, mock.Mock(ambiguous=ambiguous), set(), set(), set())

    def test_the_engines_own_doubts_are_raised_when_nothing_answered_them(self):
        self.assertEqual(self.flags(self.blob(), ambiguous=True), ["uncertain", "search-override", "ambiguous"])

    def test_examples_that_agree_answer_them(self):
        # A thin alef: scored in the contested band, its first guess overruled — and
        # five confirmed alefs say body.
        self.assertEqual(self.flags(self.blob(proposed_role="body"), ambiguous=True), [])

    def test_examples_that_disagree_still_say_so(self):
        self.assertEqual(
            self.flags(self.blob(proposed_role="mark")), ["uncertain", "search-override", "calibration-disagreement"]
        )

    def test_the_text_answers_them(self):
        blob = self.blob(role="mark", initial_role="body", decision_source="text")
        self.assertEqual(self.flags(blob, ambiguous=True), [])


class TextMarkTests(SimpleTestCase):
    def test_a_word_lists_every_mark_its_text_names_with_where_it_is_drawn(self):
        found = [(mark.kind, mark.lane, mark.letter, mark.optional, mark.pieces) for mark in text_marks("عَظِيمٌ")]
        self.assertEqual(
            found,
            [
                ("fatha", "above", 0, False, 1),
                ("ijamDot", "above", 1, False, 1),
                ("kasra", "below", 1, False, 1),
                ("ijamDot", "below", 2, False, 2),
                ("tanween", "above", 3, False, 2),
            ],
        )

    def test_a_tanween_before_a_small_meem_is_one_vowel_and_the_meem(self):
        # Tanween, shadda, then the meem: the meem still turns it into one damma.
        kinds = [mark.kind for mark in text_marks("صُمٌّۢ")]
        self.assertEqual(kinds, ["damma", "damma", "shadda", "smallLetter"])

    def test_a_carried_hamza_may_be_inside_its_letter(self):
        (hamza, *_) = text_marks("أَمْ")
        self.assertEqual((hamza.kind, hamza.optional), ("hamza", True))

    def test_the_round_zero_is_its_own_kind(self):
        self.assertEqual(text_marks("كَفَرُوا۟")[-1].kind, "roundZero")

    def test_the_small_waw_and_ya_sit_on_the_line(self):
        self.assertEqual([(m.kind, m.letter) for m in line_marks("بِهِۦ")], [("smallLetter", 1)])
        self.assertEqual([(m.kind, m.letter) for m in line_marks("دَاوُۥدَ")], [("smallLetter", 2)])
        self.assertEqual(line_marks("قَالَ"), [])

    def test_a_pause_sign_after_the_word_is_optional(self):
        last = text_marks("رَيْبَ", pause="ۛ")[-1]
        self.assertEqual((last.kind, last.optional, last.pieces), ("waqfMuanaqa", True, 3))

    def test_a_final_kaf_may_carry_its_mark(self):
        last = text_marks("ذَٰلِكَ")[-1]
        self.assertEqual((last.kind, last.optional), ("hamza", True))


def _blob(ident: int, x: int, w: int, *, role: str = "body", area: int = 720, owner: int | None = None, **extra):
    """A read row's blob on the writing line (band 100..124)."""
    return {
        "id": ident,
        "x": x,
        "y": 100,
        "w": w,
        "h": 24,
        "area": area,
        "role": role,
        "initial_role": "body",
        "explicit": False,
        "ownership_explicit": False,
        "allocations": [] if owner is None else [{"word_id": owner, "paws": 1 if role == "body" else 0}],
        **extra,
    }


class SmallLetterTests(SimpleTestCase):
    """One line: the word before (4), بِهِۦ (5) and the word after (6), right to left."""

    references: ClassVar[dict[int, dict]] = {
        4: {"id": 4, "text": "قَالَ", "aya": "2:5"},
        5: {"id": 5, "text": "بِهِۦ", "aya": "2:5"},
        6: {"id": 6, "text": "كَمَا", "aya": "2:5"},
    }

    def row(self, *blobs: dict) -> dict:
        return {
            "band": [100, 124],
            "blobs": list(blobs),
            "words": [{"word_id": ident} for ident in (4, 5, 6)],
        }

    def found(self, *blobs: dict) -> dict[int, int]:
        return calibration_service._small_letters(self.row(*blobs), self.references)

    def test_the_small_ink_just_after_the_word_is_its_small_letter(self):
        # Read as the next word's letter, as the engine is wont to.
        found = self.found(
            _blob(1, 700, 30, owner=4),
            _blob(2, 600, 30, owner=5),
            _blob(3, 590, 6, area=100, owner=6),
            _blob(4, 500, 30, owner=6),
        )
        self.assertEqual(found, {3: 5})

    def test_a_letter_there_is_not_taken_for_one(self):
        found = self.found(_blob(1, 700, 30, owner=4), _blob(2, 600, 30, owner=5), _blob(4, 560, 30, owner=6))
        self.assertEqual(found, {})

    def test_ink_a_person_called_a_letter_stays_one(self):
        found = self.found(
            _blob(1, 700, 30, owner=4),
            _blob(2, 600, 30, owner=5),
            _blob(3, 590, 6, area=100, owner=6, explicit=True),
            _blob(4, 500, 30, owner=6),
        )
        self.assertEqual(found, {})

    def test_a_small_letter_read_as_the_words_own_piece_is_found(self):
        # The word before took بِهِۦ's piece, and بِهِۦ took its small ya for one.
        found = self.found(
            _blob(1, 700, 30, owner=4),
            _blob(2, 600, 30, owner=4),
            _blob(3, 590, 6, area=100, owner=5),
            _blob(4, 500, 30, owner=6),
        )
        self.assertEqual(found, {3: 5})

    def test_a_type_the_text_set_teaches(self):
        mark = {"role": "mark", "subtype": "smallLetter", "subtype_explicit": False, "subtype_source": "text"}
        self.assertTrue(calibration_service._typed(mark))
        self.assertFalse(calibration_service._typed({**mark, "subtype_source": ""}))


class SmallLetterLockTests(CalibrationApiTestCase):
    """Page 1's first word is بِهِۦ, printed with a small square just after it on the line."""

    def setUp(self):
        super().setUp()
        Word.objects.filter(id=1).update(text="بِهِۦ")
        with drawn_pages(small=True):
            self.assertEqual(self.client.post(self.url(1, "/process")).status_code, 202)
        self.doc = self.document(1)

    def small(self, line: dict) -> dict:
        return self.blob_at(line, SMALL[0])

    def test_the_text_makes_it_the_words_small_letter(self):
        small = self.small(self.doc["lines"][0])
        self.assertEqual(
            (small["role"], small["decision_source"], small["subtype"], small.get("subtype_source")),
            ("mark", "text", "smallLetter", "text"),
        )
        self.assertEqual(small["allocations"], [{"word_id": 1, "paws": 0}])
        self.assertEqual(small["attention"], [])
        # The word's box holds it.
        first = self.doc["lines"][0]["words"][0]
        self.assertEqual((first["start_x"], first["end_x"]), (BODIES[0][1], SMALL[0]))

    def test_the_prediction_record_is_the_engine_alone(self):
        processed = CalibrationRevision.objects.get(review__mushaf=self.mushaf, review__page_number=1, kind="processed")
        small = self.blob_at(processed.payload["lines"][0], SMALL[0])
        self.assertNotIn("text_role", small)
        self.assertNotEqual(small["decision_source"], "text")

    def test_a_person_who_calls_it_a_letter_is_obeyed(self):
        body = self.draft(self.doc)
        self.draft_blob(body, 0, SMALL[0]).update(role="body", explicit=True, allocations=[])
        response = self.client.post(self.url(1, "/preview"), body, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        small = self.small(response.json()["lines"][0])
        self.assertEqual((small["role"], small["decision_source"]), ("body", "human"))
        self.assertNotIn("text_role", small)


def _dot(ident: int, x: int, y: int, size: int = 8) -> dict:
    return {"id": ident, "x": x, "y": y, "w": size, "h": size, "area": size * size - 4, "role": "mark"}


class EmbracedTests(SimpleTestCase):
    """The embraced pause sign: three loose dots in a triangle, above the line."""

    @staticmethod
    def row(*dots: dict) -> dict:
        return {"band": [100, 124], "blobs": list(dots)}

    def test_three_loose_dots_in_a_triangle_are_found(self):
        row = self.row(_dot(1, 500, 80), _dot(2, 512, 80), _dot(3, 506, 69))
        self.assertEqual(calibration_marks.embraced(row), {1, 2, 3})

    def test_a_letters_dots_nearly_touching_are_not(self):
        row = self.row(_dot(1, 500, 80), _dot(2, 507, 80), _dot(3, 503, 74))
        self.assertEqual(calibration_marks.embraced(row), set())

    def test_three_in_a_row_are_not(self):
        row = self.row(_dot(1, 500, 80), _dot(2, 512, 80), _dot(3, 524, 80))
        self.assertEqual(calibration_marks.embraced(row), set())

    def test_dots_on_the_line_are_not(self):
        row = self.row(_dot(1, 500, 104), _dot(2, 512, 104), _dot(3, 506, 94))
        self.assertEqual(calibration_marks.embraced(row), set())


class ApplyTextTypeTests(SimpleTestCase):
    @staticmethod
    def mark(ident: int, **extra) -> dict:
        return {"id": ident, "role": "mark", "subtype": "", "subtype_explicit": False, **extra}

    def test_the_text_types_what_it_surely_names_and_no_more(self):
        blobs = [
            self.mark(1),
            self.mark(2, subtype="kasra", subtype_explicit=True),
            self.mark(3, subtype="fatha", subtype_source="text"),
            self.mark(4),
        ]
        check = WordCheck(types={1: "fatha", 2: "fatha", 4: "sukun"}, sure={1, 2})
        rows = [{"snapshot_id": "s", "blobs": blobs}]
        calibration_marks.apply_text_types(rows, {"s": {7: check}})
        typed = {blob["id"]: (blob["subtype"], blob.get("subtype_source")) for blob in blobs}
        self.assertEqual(
            typed,
            {
                1: ("fatha", "text"),  # sure: typed by the text
                2: ("kasra", None),  # a person's type stays
                3: ("", None),  # no longer surely named: taken off
                4: ("", None),  # named, but not surely
            },
        )


class TextTypeTests(CalibrationApiTestCase):
    """Page 1's first word is ن: one piece and one dot above it — the drawn dot. Its
    second is نَ, whose dot and fatha the page does not print."""

    def setUp(self):
        super().setUp()
        Word.objects.filter(id=1).update(text="ن")
        Word.objects.filter(id=2).update(text="نَ")
        self.process(1)
        self.doc = self.document(1)

    def suggest(self, body: dict) -> dict:
        response = self.client.post(self.url(1, "/types"), body, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_a_mark_the_text_surely_names_is_typed_by_it(self):
        dot = self.blob_at(self.doc["lines"][0], DOT[0])
        self.assertEqual(
            (dot["subtype"], dot.get("subtype_source"), dot["subtype_explicit"]), ("ijamDot", "text", False)
        )
        # Every other line's dot belongs to a word whose text names no mark: untyped.
        self.assertEqual(self.blob_at(self.doc["lines"][1], DOT[0])["subtype"], "")

    def test_each_word_says_how_its_marks_fit_its_text(self):
        answer = self.suggest(self.draft(self.doc))
        words = {word["word_id"]: word for word in answer["words"]}
        self.assertEqual((words[1]["ok"], words[1]["missing"]), (True, []))
        self.assertEqual((words[2]["ok"], words[2]["missing"], words[2]["extra"]), (False, ["ijamDot", "fatha"], []))

    def test_a_typed_mark_the_text_names_otherwise_is_doubted_by_it(self):
        body = self.draft(self.doc)
        self.draft_blob(body, 0, DOT[0]).update(subtype="fatha", subtype_explicit=True, explicit=True)
        answer = self.suggest(body)
        dot = self.blob_at(self.doc["lines"][0], DOT[0])
        doubts = [(d["blob_id"], d["typed"], d["subtype"], d["source"]) for d in answer["doubts"]]
        self.assertIn((dot["id"], "fatha", "ijamDot", "text"), doubts)


class RetypeFromTextTests(CalibrationApiTestCase):
    """Page 1's first word is ن۟ — its dot, and a round zero over it — and page 1 is
    confirmed with the zero typed sukun, as reviewers typed it before it had a type."""

    def setUp(self):
        super().setUp()
        Word.objects.filter(id=1).update(text="ن۟")
        with drawn_pages(stray=True):
            self.assertEqual(self.client.post(self.url(1, "/process")).status_code, 202)
        self.doc = self.document(1)
        body = self.draft(self.doc)
        for left, subtype in ((DOT[0], "ijamDot"), (STRAY[0], "sukun")):
            self.draft_blob(body, 0, left).update(subtype=subtype, subtype_explicit=True, explicit=True)
        self.assertEqual(self.confirm(1, body).status_code, 200)

    def zero(self) -> dict:
        return self.blob_at(self.document(1)["lines"][0], STRAY[0])

    def test_a_dry_run_changes_nothing(self):
        before = self.document(1)["confirmed_revision"]
        call_command("retype_from_text", str(self.mushaf.id), stdout=io.StringIO())
        self.assertEqual((self.zero()["subtype"], self.document(1)["confirmed_revision"]), ("sukun", before))

    def test_applied_the_page_is_confirmed_again_with_the_zero_named(self):
        before = self.document(1)["confirmed_revision"]
        call_command("retype_from_text", str(self.mushaf.id), "--apply", stdout=io.StringIO())
        after = self.document(1)
        self.assertEqual(self.zero()["subtype"], "roundZero")
        self.assertGreater(after["confirmed_revision"], before)
        approvals = CalibrationRevision.objects.filter(review__mushaf=self.mushaf, review__page_number=1)
        self.assertEqual(approvals.get(number=after["confirmed_revision"]).kind, "confirmed")
        # The dot keeps its type, and the old confirmation stays in the page's history.
        self.assertEqual(self.blob_at(after["lines"][0], DOT[0])["subtype"], "ijamDot")
        self.assertTrue(CalibrationRevision.objects.filter(review__mushaf=self.mushaf, number=before).exists())
