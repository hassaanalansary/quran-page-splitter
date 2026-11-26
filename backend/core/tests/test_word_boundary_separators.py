"""Which ink an aya ornament takes, and which ink a symbol takes.

The ornament numbers are the first mushaf's opening pages as measured, where the
template's span (128 px) reaches well past the 95 px ring it found. The symbol lines
are drawn: a sign of a ring and a dot, the shape of Medina's rub' rosette. No
database.
"""

from unittest import TestCase

import numpy as np
from PIL import Image, ImageDraw

from core.word_boundary.ink import Blob, LineInk, analyse_line
from core.word_boundary.inputs import LineImage
from core.word_boundary.separators import partition_ornament_pieces, prepare_template, split_symbols

INK = (0, 0, 0, 255)


def blob(label: int, x: int, w: int, area: int, preferred: str = "mark-only") -> Blob:
    return Blob(label=label, x=x, y=0, w=w, h=10, area=area, preferred=preferred)


def labels(blobs: list[Blob]) -> list[int]:
    return [b.label for b in blobs]


class OrnamentPieceTests(TestCase):
    def test_the_last_words_fatha_over_the_rings_shoulder_stays_text(self):
        # Page 1 line 6: span 415..543, ring 424..519, its digit, and a fatha 529..550.
        fatha, ring, digit = blob(16, 529, 21, 98), blob(11, 424, 95, 3000, "body"), blob(42, 464, 15, 200)
        kept, groups, _ = partition_ornament_pieces([fatha, ring, digit], [(415, 543)])
        self.assertEqual(labels(kept), [16])
        self.assertEqual([labels(group) for group in groups], [[11, 42]])

    def test_a_dot_inside_the_span_but_beside_the_ring_stays_text(self):
        # Page 2 line 4: span 679..807, ring 681..777, a 7 px dot at 796..803.
        dot, ring, digit = blob(43, 796, 7, 40), blob(6, 681, 96, 3000, "body"), blob(50, 723, 13, 200)
        kept, groups, _ = partition_ornament_pieces([dot, ring, digit], [(679, 807)])
        self.assertEqual(labels(kept), [43])
        self.assertEqual([labels(group) for group in groups], [[6, 50]])

    def test_ink_returned_to_the_text_does_not_split_the_ornament(self):
        ring, stray, digit = blob(1, 0, 95, 3000, "body"), blob(2, 100, 20, 90), blob(3, 40, 13, 200)
        kept, groups, _ = partition_ornament_pieces([ring, stray, digit], [(-6, 122)])
        self.assertEqual(labels(kept), [2])
        self.assertEqual([labels(group) for group in groups], [[1, 3]])

    def test_a_body_beside_the_ring_counts_among_the_bodies_before_it(self):
        letter, ring = blob(5, 130, 40, 900, "body"), blob(1, 20, 95, 3000, "body")
        _, _, befores = partition_ornament_pieces([letter, ring], [(10, 160)])
        self.assertEqual(befores, [1])


def draw_sign(draw: ImageDraw.ImageDraw, x: int, y: int, fill=INK) -> None:
    """A ring and the dot inside it, 31 px across."""
    draw.ellipse([x, y, x + 30, y + 30], outline=fill, width=4)
    draw.ellipse([x + 12, y + 12, x + 18, y + 18], fill=fill)


def sign_template() -> np.ndarray:
    image = Image.new("RGB", (60, 60), "white")
    draw_sign(ImageDraw.Draw(image), 10, 10, fill=(0, 0, 0))
    return prepare_template(image, "rub_hizb")


def measure_line(*drawings) -> LineInk:
    """A line with a letter on its writing line, plus whatever ``drawings`` add."""
    image = Image.new("RGBA", (700, 150), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle([40, 70, 160, 84], fill=INK)
    for drawing in drawings:
        drawing(draw)
    return analyse_line(LineImage(image, "fixture"))


def labels_between(blobs: list[Blob], ink: LineInk, left: int, right: int) -> list[int]:
    """The blobs that start and end between ``left`` and ``right``, in image x."""
    return sorted(b.label for b in blobs if left <= b.x + ink.offset_x and b.right + ink.offset_x <= right)


def draw_lone_sign(draw: ImageDraw.ImageDraw) -> None:
    draw_sign(draw, 450, 55)


def draw_fatha_over_the_sign(draw: ImageDraw.ImageDraw) -> None:
    draw.line([(452, 22), (478, 12)], fill=INK, width=6)


def draw_letter_with_a_sign_for_a_head(draw: ImageDraw.ImageDraw) -> None:
    """The و of ولا: its head the sign's very shape, its tail running on below."""
    draw_sign(draw, 250, 55)
    draw.line([(254, 80), (200, 125)], fill=INK, width=8)


def draw_second_sign(draw: ImageDraw.ImageDraw) -> None:
    draw_sign(draw, 600, 55)


def draw_tail_grazing_the_sign(draw: ImageDraw.ImageDraw) -> None:
    """A neighbour's thin tail clipping the sign's top left corner, clear of its ring."""
    draw.line([(420, 87), (474, 33)], fill=INK, width=2)


class SymbolTests(TestCase):
    def test_a_sign_standing_alone_leaves_the_text_with_all_its_pieces(self):
        ink = measure_line(draw_lone_sign)
        sign = labels_between(ink.components, ink, 440, 490)
        split_symbols(ink, {"rub_hizb": sign_template()})
        self.assertEqual(len(sign), 2)
        self.assertEqual([(name, sorted(labels(group))) for name, group in ink.symbols], [("rub_hizb", sign)])
        self.assertEqual(labels_between(ink.components, ink, 440, 490), [])

    def test_a_letter_whose_head_has_the_signs_shape_is_no_sign(self):
        # The dot inside its head lies wholly in the box, but the most of the box's
        # ink is the letter's, which runs on outside it.
        ink = measure_line(draw_letter_with_a_sign_for_a_head)
        before = labels(ink.components)
        split_symbols(ink, {"rub_hizb": sign_template()})
        self.assertEqual(ink.symbols, [])
        self.assertEqual(labels(ink.components), before)

    def test_the_mark_above_a_sign_stays_text(self):
        ink = measure_line(draw_lone_sign, draw_fatha_over_the_sign)
        fatha = [b.label for b in ink.components if b.y + ink.offset_y < 40]
        split_symbols(ink, {"rub_hizb": sign_template()})
        self.assertEqual(len(ink.symbols), 1)
        self.assertEqual(len(fatha), 1)
        self.assertIn(fatha[0], labels(ink.components))

    def test_a_neighbours_tail_grazing_the_sign_does_not_hide_it(self):
        ink = measure_line(draw_lone_sign, draw_tail_grazing_the_sign)
        split_symbols(ink, {"rub_hizb": sign_template()})
        self.assertEqual([len(group) for _, group in ink.symbols], [2])

    def test_two_templates_on_one_sign_make_one_symbol(self):
        ink = measure_line(draw_lone_sign)
        split_symbols(ink, {"rub_hizb": sign_template(), "sajda": sign_template()})
        self.assertEqual([len(group) for _, group in ink.symbols], [2])

    def test_symbols_are_listed_right_to_left_with_their_spans(self):
        ink = measure_line(draw_lone_sign, draw_second_sign)
        split_symbols(ink, {"rub_hizb": sign_template()})
        lefts = [left + ink.offset_x for left, _ in ink.symbol_spans]
        self.assertEqual(lefts, [600, 450])
