"""Calibration's side of the library's prices: learned touching joins, the hand-over of
an answer to the engine, and the ayat a reading leaves short. No database."""

from django.test import SimpleTestCase

from api.services import calibration
from api.services.habit_counts import count_habits_of_page
from core.word_boundary.habits import WordHabits, count_word_habits, make_empty_habit_counts
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


def keyed(blob: dict, *letters: str) -> dict:
    """A confirmed body holding these pieces."""
    return {**blob, "decided": {"paws": list(letters), "marks": []}, "reading": None, "contents": None}


class HabitCountTests(SimpleTestCase):
    def test_a_body_holding_two_pieces_shows_the_join_it_covers(self):
        document = page(
            [TOUCHING],
            [
                row(
                    "a",
                    [
                        keyed(body(1, 300, [{"word_id": 1, "paws": 2}]), "يفر", "قو"),
                        keyed(body(2, 200, [{"word_id": 1, "paws": 1}]), "ن"),
                    ],
                    [1],
                )
            ],
        )
        counts = count_habits_of_page(document, ijam=True)
        self.assertEqual(counts["joins"]["pair"], {"ر|ق": [1, 0], "و|ن": [0, 1]})
        self.assertEqual(counts["joins"]["word"]["يفرقون|0"], [1, 0])

    def test_a_word_whose_bodies_do_not_hold_its_pieces_counts_no_join(self):
        document = page([TOUCHING], [row("a", [keyed(body(1, 300, [{"word_id": 1, "paws": 1}]), "يفر")], [1])])
        self.assertEqual(count_habits_of_page(document, ijam=True)["joins"]["pair"], {})

    def test_a_missing_paw_is_cheaper_in_a_word_likely_to_touch(self):
        habits = make_empty_habit_counts()
        for _ in range(3):
            count_word_habits(habits, WordHabits("يفرقون", ("يفر", "قو", "ن"), (True, False), ()))
        weights = calibration.price_short_words([TOUCHING, NEXT], habits)
        self.assertLess(weights[1], weights[2])
        self.assertEqual(weights[2], calibration.COUNT_WEIGHT)
        self.assertGreaterEqual(weights[1], calibration.COUNT_WEIGHT - calibration.FUSION_DISCOUNT)

    def test_illa_touches_and_ila_does_not(self):
        """إلا touched 5 times in 5 on the Shamarly pages, إلى 0 in 6: the word's own record
        prices each, where the letters إ and ل alone would pool them."""
        habits = make_empty_habit_counts()
        for _ in range(5):
            count_word_habits(habits, WordHabits("إلا", ("إ", "لا"), (True,), ()))
        for _ in range(6):
            count_word_habits(habits, WordHabits("إلى", ("إ", "لى"), (False,), ()))
        illa = {"id": 3, "text": "إِلَّا", "paws": 2, "aya": "2:5"}
        ila = {"id": 4, "text": "إِلَى", "paws": 2, "aya": "2:5"}
        weights = calibration.price_short_words([illa, ila], habits)
        self.assertLess(weights[3], weights[4])
        self.assertEqual(weights[4], calibration.COUNT_WEIGHT)


class HandOverTests(SimpleTestCase):
    def edited(self, **changes):
        return {
            "role": "mark",
            "decided": None,
            "ownership_explicit": False,
            "allocations": [],
            "proposed_role": "mark",
            "proposal": {"role": "mark", "confidence": 0.8},
            **changes,
        }

    def test_with_learning_on_the_answer_is_a_price_not_a_lock(self):
        blob = Blob(7, 0, 0, 10, 10, 100, body_score=12)
        calibration.constrain_blob_to_decisions(blob, self.edited(), {}, calibration_locks=True)
        self.assertEqual((blob.library_role, blob.library_confidence, blob.locked_role), ("mark", 0.8, None))

    def test_with_learning_off_the_engine_prices_from_geometry(self):
        blob = Blob(7, 0, 0, 10, 10, 100, body_score=12)
        calibration.constrain_blob_to_decisions(blob, self.edited(), {}, calibration_locks=False)
        self.assertIsNone(blob.library_role)

    def test_a_persons_decision_stays_a_hard_lock(self):
        blob = Blob(7, 0, 0, 10, 10, 100, body_score=12)
        calibration.constrain_blob_to_decisions(
            blob, self.edited(role="body", decided={"paws": [None], "marks": None}), {}, calibration_locks=True
        )
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
