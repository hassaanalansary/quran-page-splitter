"""Tests for core.word_boundary.inputs — the contract, and the file-backed side of it.

Lives under ``quran`` rather than ``core`` because there is no test package there
and these need the same runner; nothing here touches the database.
"""

import tempfile
from pathlib import Path

from django.test import SimpleTestCase
from PIL import Image

from core.quran_text import Aya
from core.word_boundary import LineImage, aya_starts, images_from_paths, words_from_ayat


class ImagesFromPathsTests(SimpleTestCase):
    def _write(self, directory: Path, name: str) -> Path:
        path = directory / name
        Image.new("RGBA", (8, 4), (0, 0, 0, 0)).save(path)
        return path

    def test_opens_in_the_order_given_and_labels_by_filename(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            paths = [self._write(directory, f"line-{n:02d}.png") for n in (1, 2, 3)]
            lines = images_from_paths(paths)
        self.assertEqual([line.label for line in lines], ["line-01.png", "line-02.png", "line-03.png"])
        self.assertEqual(lines[0].image.size, (8, 4))

    def test_the_file_is_not_left_open(self):
        """A 388-line run would otherwise hold 388 handles until it exits."""
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            path = self._write(directory, "line-01.png")
            lines = images_from_paths([path])
            # Readable after the directory's handle would have been released, and
            # on Windows the file can still be replaced, which an open handle blocks.
            self.assertEqual(lines[0].image.size, (8, 4))
            path.unlink()

    def test_a_bare_directory_supplies_no_separators(self):
        """Files know nothing about ornaments, so the engine must find them."""
        with tempfile.TemporaryDirectory() as raw:
            lines = images_from_paths([self._write(Path(raw), "line-01.png")])
        self.assertIsNone(lines[0].separators)


class WordsFromAyatTests(SimpleTestCase):
    def test_counts_paws_and_ijam_per_word(self):
        ayat = [Aya(sura=1, number=1, words=["بِسْمِ", "ٱللَّهِ"])]
        stream = words_from_ayat(ayat)
        self.assertEqual([w.text for w in stream], ["بِسْمِ", "ٱللَّهِ"])
        self.assertEqual([w.paws for w in stream], [1, 2])
        # بسم carries one dot group below (the ب) and none above.
        self.assertEqual((stream[0].ijam_above, stream[0].ijam_below), (0, 1))
        self.assertEqual([w.aya for w in stream], ["1:1", "1:1"])

    def test_ids_are_absent_for_a_text_file(self):
        stream = words_from_ayat([Aya(sura=1, number=1, words=["بِسْمِ"])])
        self.assertIsNone(stream[0].id)


class AyaStartsTests(SimpleTestCase):
    def test_marks_every_boundary_plus_an_end_sentinel(self):
        stream = words_from_ayat(
            [Aya(sura=7, number=82, words=["a", "b"]), Aya(sura=7, number=83, words=["c"])]
        )
        self.assertEqual(aya_starts(stream), [0, 2, 3])

    def test_empty_stream(self):
        self.assertEqual(aya_starts([]), [0])


class LineImageTests(SimpleTestCase):
    def test_carries_supplied_separators_when_the_caller_has_them(self):
        line = LineImage(image=Image.new("L", (10, 2)), label="l", separators=[(1, 3)])
        self.assertEqual(line.separators, [(1, 3)])
