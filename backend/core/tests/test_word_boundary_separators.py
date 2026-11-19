"""Which ink an aya ornament takes: its ring and what lies within the ring's width.

The numbers are the first mushaf's opening pages as measured, where the template's
span (128 px) reaches well past the 95 px ring it found. No database, no image.
"""

from unittest import TestCase

from core.word_boundary.ink import Blob
from core.word_boundary.separators import _partition


def blob(label: int, x: int, w: int, area: int, preferred: str = "mark-only") -> Blob:
    return Blob(label=label, x=x, y=0, w=w, h=10, area=area, preferred=preferred)


def labels(blobs: list[Blob]) -> list[int]:
    return [b.label for b in blobs]


class OrnamentPieceTests(TestCase):
    def test_the_last_words_fatha_over_the_rings_shoulder_stays_text(self):
        # Page 1 line 6: span 415..543, ring 424..519, its digit, and a fatha 529..550.
        fatha, ring, digit = blob(16, 529, 21, 98), blob(11, 424, 95, 3000, "body"), blob(42, 464, 15, 200)
        kept, groups, _ = _partition([fatha, ring, digit], [(415, 543)], within_ring=True)
        self.assertEqual(labels(kept), [16])
        self.assertEqual([labels(group) for group in groups], [[11, 42]])

    def test_a_dot_inside_the_span_but_beside_the_ring_stays_text(self):
        # Page 2 line 4: span 679..807, ring 681..777, a 7 px dot at 796..803.
        dot, ring, digit = blob(43, 796, 7, 40), blob(6, 681, 96, 3000, "body"), blob(50, 723, 13, 200)
        kept, groups, _ = _partition([dot, ring, digit], [(679, 807)], within_ring=True)
        self.assertEqual(labels(kept), [43])
        self.assertEqual([labels(group) for group in groups], [[6, 50]])

    def test_ink_returned_to_the_text_does_not_split_the_ornament(self):
        ring, stray, digit = blob(1, 0, 95, 3000, "body"), blob(2, 100, 20, 90), blob(3, 40, 13, 200)
        kept, groups, _ = _partition([ring, stray, digit], [(-6, 122)], within_ring=True)
        self.assertEqual(labels(kept), [2])
        self.assertEqual([labels(group) for group in groups], [[1, 3]])

    def test_a_body_beside_the_ring_counts_among_the_bodies_before_it(self):
        letter, ring = blob(5, 130, 40, 900, "body"), blob(1, 20, 95, 3000, "body")
        _, _, befores = _partition([letter, ring], [(10, 160)], within_ring=True)
        self.assertEqual(befores, [1])

    def test_symbols_keep_every_piece_centred_in_their_span(self):
        fatha, star = blob(16, 529, 21, 98), blob(11, 424, 95, 3000)
        kept, groups, _ = _partition([fatha, star], [(415, 543)])
        self.assertEqual(kept, [])
        self.assertEqual([labels(group) for group in groups], [[16, 11]])
