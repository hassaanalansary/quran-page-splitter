"""Search regressions independent of page rendering and database state."""

import random
from dataclasses import replace

from django.test import SimpleTestCase

from core.word_boundary import WordBoundaryInput, detect_words
from core.word_boundary.alignment import _advance, _line_end, _with_body, _with_mark
from core.word_boundary.ink import Blob, analyse_line
from core.word_boundary.inputs import aya_starts
from core.word_boundary.span import _fresh, _settle, parse_span
from quran.tests.test_word_boundary import _line, _words


def blob(label, x, width=10, score=14):
    return Blob(label, x, 0, width, 10, width * 10, body_score=score)


class GeometrySearchTests(SimpleTestCase):
    def test_previous_cut_alternatives_survive_until_they_can_be_ranked(self):
        words = _words([1, 1])
        states = _fresh(0)
        for ident, part in enumerate([blob(0, 10, 100), blob(1, 30, 60), blob(2, 20)]):
            states = _advance(states, part, ident, words)
        _, winner, _, _ = _settle(states, 2)
        self.assertEqual(winner.rank, (6, 0, 0))
        self.assertEqual(winner.groups, ((1,), (2,)))

    def test_word_end_is_the_minimum_x_not_the_last_blob_x(self):
        words = _words([1, 2])
        states = _fresh(0)
        for ident, part in enumerate([blob(0, 50, 100), blob(1, 10, 100), blob(2, 60, 10)]):
            states = _advance(states, part, ident, words)
        _, winner, _, _ = _settle(states, 2)
        self.assertEqual(winner.groups, ((0,), (1, 2)))
        self.assertEqual(winner.ends, (50, 10))
        self.assertEqual(winner.inversions, 0)

    def test_normal_line_wrap_does_not_add_an_inversion(self):
        words = _words([1, 1])
        trace = []
        parse_span(
            [analyse_line(_line([100])), analyse_line(_line([200]))],
            words,
            aya_starts=aya_starts(words),
            ijam="ignore",
            trace=trace,
        )
        self.assertEqual(trace[0].record.ends, (0, 0))
        self.assertEqual(trace[0].record.inversions, 0)

    def test_two_missing_paws_are_not_one_count_penalty(self):
        states = _advance(_fresh(0), blob(0, 10), 0, _words([3]))
        _, winner, _, _ = _settle(states, 1)
        self.assertEqual((winner.cost, winner.deviations, winner.paw_errors), (40, 1, 2))

    def test_geometry_search_matches_exhaustive_small_cases(self):
        for seed in range(50):
            rng = random.Random(seed)
            words = _words([rng.choice([1, 2]), rng.choice([1, 2])])
            parts = []
            for ident in range(6):
                right = 300 - ident * 30
                width = rng.randrange(10, 120)
                parts.append(blob(ident, right - width, width, rng.choice([1, 6, 10, 14])))
            states = _fresh(0)
            exhaustive = list(states.items())
            for ident, part in enumerate(parts):
                states = _advance(states, part, ident, words)
                candidates = []
                for key, record in exhaustive:
                    candidates.append((key, _with_mark(record, part)))
                    candidates.extend(_with_body(record, part, ident, words, key))
                exhaustive = candidates
                if seed % 2 and ident == 2:
                    states = _line_end(states)
                    exhaustive = [
                        (key, replace(record, previous_end=None, current_left=None))
                        for key, record in exhaustive
                        if key[1] == 0
                    ]
            expected = min((r for key, r in exhaustive if key[:2] == (2, 0)), key=lambda r: (r.rank, r.groups))
            _, actual, _, _ = _settle(states, 2)
            with self.subTest(seed=seed):
                self.assertEqual((actual.rank, actual.groups), (expected.rank, expected.groups))


class EndpointTests(SimpleTestCase):
    def test_complete_costlier_reading_wins_at_requested_endpoint(self):
        result = detect_words(WordBoundaryInput(lines=[_line([50, 100, 150], separators=[])], words=_words([2, 2])))
        self.assertTrue(result.complete)
        self.assertEqual(result.words_consumed, 2)
        self.assertEqual(len(result.lines[0].words), 2)
        self.assertEqual(result.lines[0].cost, 20)

    def test_withdrawn_boxes_are_not_counted_as_consumed(self):
        result = detect_words(WordBoundaryInput(lines=[_line([50, 100], separators=[])], words=_words([1] * 6)))
        self.assertFalse(result.complete)
        self.assertEqual(result.words_consumed, 0)
