"""Run from backend: PYTHONPATH=. python -m unittest discover -s ../wl-out -p test_paths.py."""

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from paths import AGREED_BODY, Reading, draw, enumerate_readings, role_counts, stretch_for
from PIL import Image

from core.word_boundary.alignment import ParseRecord, _with_body, _with_mark
from core.word_boundary.ink import Blob, analyse_line
from core.word_boundary.inputs import WordInput, aya_starts
from core.word_boundary.separators import split_separators
from core.word_boundary.span import _Event, _events, _fresh, parse_span


def word(paws=1, aya="1:1"):
    return WordInput("word", paws, 0, 0, aya)


class PathsTests(unittest.TestCase):
    def test_top_k_matches_exhaustive_order_including_geometry_and_line_wrap(self):
        words = [word(), word()]
        for wrap in (False, True):
            parts = [
                Blob(i, x, 0, width, 10, 100, body_score=14)
                for i, (x, width) in enumerate([(10, 100), (30, 60), (20, 10), (5, 10)])
            ]
            events = [_Event("blob", 0, b, i) for i, b in enumerate(parts)]
            if wrap:
                events.insert(2, _Event("line-end", 0))
            exhaustive = list(_fresh(0).items())
            for event in events:
                if event.kind == "line-end":
                    exhaustive = [
                        (k, replace(r, previous_end=None, current_left=None)) for k, r in exhaustive if k[1] == 0
                    ]
                    continue
                candidates = []
                for key, record in exhaustive:
                    candidates.append((key, _with_mark(record, event.blob)))
                    candidates.extend(_with_body(record, event.blob, event.ident, words, key))
                exhaustive = candidates
            expected = sorted(
                (r for k, r in exhaustive if k[:2] == (2, 0)), key=lambda r: (r.rank, r.groups, r.current_group)
            )
            for top in (1, 3, 100):
                self.assertEqual(
                    enumerate_readings(events, words, 0, 2, top), [Reading.from_record(r) for r in expected[:top]]
                )

    def test_count_breakdown_uses_paws_not_words(self):
        r = Reading.from_record(ParseRecord(40, (10,), ((0,),), (), 1, deviations=1, paw_errors=2))
        self.assertEqual(r.blob_cost, 0)

    def test_neighboring_aya_is_not_demoted_or_boxed_and_offsets_are_applied(self):
        by = {
            0: (0, Blob(1, 20, 20, 12, 12, 144, preferred="body")),
            1: (0, Blob(2, 70, 20, 12, 12, 144, preferred="body")),
        }
        r = Reading(0, 0, ((0,),), (20,))
        self.assertEqual(role_counts(r, by, {0}), (0, 0))
        ink = SimpleNamespace(offset_x=7, offset_y=11, separator_spans=[], symbol_spans=[])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reading.png"
            draw(r, 1, True, [(0, ink)], {0: Image.new("RGB", (1400, 100), "white")}, by, [word()], 0, path, 0, {0})
            with Image.open(path) as image:
                # Header 56 + line label 18, then image-space coordinates.
                self.assertEqual(image.getpixel((38, 74 + 42)), AGREED_BODY)
                self.assertEqual(image.getpixel((88, 74 + 42)), (255, 255, 255))

    def test_trace_uses_recovered_cursor_without_copying_engine_logic(self):
        from PIL import ImageDraw

        from core.word_boundary.inputs import LineImage

        image = Image.new("RGBA", (400, 60))
        pen = ImageDraw.Draw(image)
        for x in (100, 170, 250):
            pen.rectangle((x, 20, x + 29, 40), fill=(0, 0, 0, 255))
        ink = analyse_line(LineImage(image, "fixture", separators=[(170, 205)]))
        split_separators(ink, None)
        words = [word() for _ in range(3)] + [word(aya="1:2")]
        trace = []
        parse_span([ink], words, aya_starts=aya_starts(words), trace=trace)
        first, second = stretch_for(trace, 0, 3), stretch_for(trace, 3, 4)
        self.assertEqual((first.end_word, first.next_word), (1, 3))
        events, _ = _events([ink])
        readings = enumerate_readings(events[second.event_start : second.event_stop], words, 3, 4, 5)
        self.assertEqual(readings[0].groups, second.record.groups)

    def test_invalid_limits_and_unbounded_windows_are_explicit(self):
        with self.assertRaises(ValueError):
            enumerate_readings([], [], 0, 0, 0)
        with self.assertRaises(ValueError):
            enumerate_readings([_Event("ornament", 0)], [word()], 0, 1, 1)
        with self.assertRaises(ValueError):
            stretch_for([], 0, 1)
