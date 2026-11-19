"""Calibration's side of the library's prices: learned touching joins, the hand-over of
an answer to the engine, and the ayat a reading leaves short. No database."""

from django.test import SimpleTestCase

from api.services import calibration
from core.word_boundary.ink import Blob

#: يُفَرِّقُونَ is three pieces — يفر · قو · ن — and its ر is printed touching the ق.
TOUCHING = {"id": 1, "text": "يُفَرِّقُونَ", "paws": 3, "aya": "2:102"}
NEXT = {"id": 2, "text": "بِهِۦ", "paws": 1, "aya": "2:102"}


def body(ident, x, allocations, *, explicit=True):
    return {"id": ident, "x": x, "w": 20, "role": "body", "allocations": allocations, "ownership_explicit": explicit}


def page(stream, rows, context=()):
    return {"stream": stream, "lines": rows, "context": list(context)}


def row(snapshot, blobs, word_ids):
    return {"snapshot_id": snapshot, "blobs": blobs, "words": [{"word_id": ident} for ident in word_ids]}


class FusionTableTests(SimpleTestCase):
    def test_a_body_given_two_paws_shows_the_join_it_covers(self):
        document = page(
            [TOUCHING],
            [row("a", [body(1, 300, [{"word_id": 1, "paws": 2}]), body(2, 200, [{"word_id": 1, "paws": 1}])], [1])],
        )
        self.assertEqual(calibration._touching_joins(document), [(("ر", "ق"), False)])

    def test_a_body_shared_by_two_words_shows_the_join_across_the_space(self):
        shared = body(1, 300, [{"word_id": 1, "paws": 1}, {"word_id": 2, "paws": 1}])
        document = page([TOUCHING, NEXT], [row("a", [shared], [1, 2])])
        self.assertIn((("ن", "ب"), True), calibration._touching_joins(document))

    def test_every_join_a_page_prints_is_counted_inside_and_across(self):
        document = page([TOUCHING, NEXT], [row("a", [], [1, 2])])
        self.assertEqual(
            calibration._printed_joins(document),
            [(("ر", "ق"), False), (("و", "ن"), False), (("ن", "ب"), True)],
        )

    def test_a_join_is_as_likely_as_its_pair_or_else_its_last_letter(self):
        table = calibration.FusionTable(within={("ر", "ق"): (3, 9), ("ر", "و"): (0, 2)}, across={("ر", "ق"): (0, 40)})
        self.assertAlmostEqual(table.chance(("ر", "ق"), across=False), 0.3)
        # Printed too seldom to speak for itself: the ر speaks for it.
        self.assertAlmostEqual(table.chance(("ر", "و"), across=False), 3 / 12)
        # The space between words is another matter.
        self.assertEqual(table.chance(("ر", "ق"), across=True), 0.0)

    def test_a_missing_paw_is_cheaper_in_a_word_likely_to_touch(self):
        table = calibration.FusionTable(within={("ر", "ق"): (9, 9)})
        weights = calibration._short_weights([TOUCHING, NEXT], table)
        self.assertLess(weights[1], weights[2])
        self.assertEqual(weights[2], calibration.COUNT_WEIGHT)
        self.assertGreaterEqual(weights[1], calibration.COUNT_WEIGHT - calibration.FUSION_DISCOUNT)


class HandOverTests(SimpleTestCase):
    def edited(self, **changes):
        return {
            "role": "mark",
            "explicit": False,
            "ownership_explicit": False,
            "allocations": [],
            "proposed_role": "mark",
            "proposal": {"role": "mark", "confidence": 0.8},
            **changes,
        }

    def test_with_learning_on_the_answer_is_a_price_not_a_lock(self):
        blob = Blob(7, 0, 0, 10, 10, 100, body_score=12)
        calibration._constrain(blob, self.edited(), {}, calibration_locks=True)
        self.assertEqual((blob.library_role, blob.library_confidence, blob.locked_role), ("mark", 0.8, None))

    def test_with_learning_off_the_engine_prices_from_geometry(self):
        blob = Blob(7, 0, 0, 10, 10, 100, body_score=12)
        calibration._constrain(blob, self.edited(), {}, calibration_locks=False)
        self.assertIsNone(blob.library_role)

    def test_a_persons_decision_stays_a_hard_lock(self):
        blob = Blob(7, 0, 0, 10, 10, 100, body_score=12)
        calibration._constrain(blob, self.edited(role="body", explicit=True), {}, calibration_locks=True)
        self.assertEqual((blob.locked_role, blob.lock_source), ("body", "human"))


class ShortageTests(SimpleTestCase):
    def document(self):
        rows = [
            row("a", [body(1, 300, [{"word_id": 1, "paws": 1}]), body(2, 200, [{"word_id": 1, "paws": 1}])], [1]),
            row("b", [body(3, 300, [{"word_id": 2, "paws": 1}])], [2]),
        ]
        return page([TOUCHING, NEXT], rows)

    def test_an_aya_with_fewer_paws_than_its_words_spell_is_named_with_the_short_word(self):
        self.assertEqual(
            calibration._shortages(self.document(), set()),
            [{"aya": "2:102", "short": 1, "words": [1], "certain": True}],
        )

    def test_equal_readings_make_the_place_uncertain(self):
        (shortage,) = calibration._shortages(self.document(), {"a"})
        self.assertFalse(shortage["certain"])

    def test_a_whole_aya_is_not_short(self):
        document = self.document()
        document["lines"][0]["blobs"][0]["allocations"] = [{"word_id": 1, "paws": 2}]
        self.assertEqual(calibration._shortages(document, set()), [])

    def test_an_unplaced_word_is_not_counted_as_a_shortage(self):
        document = self.document()
        document["lines"][1]["words"] = []
        self.assertEqual(calibration._shortages(document, set()), [])
