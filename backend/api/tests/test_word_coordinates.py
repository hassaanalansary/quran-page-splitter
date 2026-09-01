"""Tests for api.services.word_coordinates — the engine's answer, stored.

The conversion is what these are about. The engine measures from the left edge of the
picture it was handed; the database stores page x. Get that addition wrong and every
row is still plausible — a number in range, in order, next to a real word — and every
one of them points at the wrong ink.

Results are built by hand. Running the engine here would test the engine, which sura 7
already does byte for byte; what needs pinning is the write.
"""

from django.test import TestCase
from PIL import Image

from api.models import Line, LineTypeChoices, LineWord, Mushaf, Page
from api.services import word_coordinates
from api.services.line_images import PlacedLine
from api.tests.helpers import bare_mushaf
from core.word_boundary import LineImage, WordBoundaryResult, WordBox, WordLine
from quran.models import Word
from quran.services.suras import seed_reference_data


def _box(index: int, end_x: int, word_id: int) -> WordBox:
    """One placed word. Only index, word_id and end_x are read by the service."""
    return WordBox(
        index=index,
        text=f"w{index}",
        aya="2:5",
        word_id=word_id,
        expected_paws=1,
        components=[index + 1],
        x=end_x,
        y=0,
        w=30,
        h=20,
        end_x=end_x,
    )


def _outcome(label: str, boxes: list[WordBox], *, status: str = "exact") -> WordLine:
    return WordLine(
        label=label,
        source=f"test:{label}",
        status=status,
        reason=None,
        cost=0,
        deviations=0,
        end_sequences=0,
        band=(0, 20),
        crop_offset=(0, 0),
        words=boxes,
    )


class WordCoordinateTests(TestCase):
    """Two lines of one page, deliberately placed at different origins.

    Line 1 is uncropped, so its image starts at the column edge, page x 100. Line 2 is
    the far end of the span and was cut at an aya boundary, so its image starts 300px
    further in, at page x 400. A service that reused one origin for both would put
    line 2's words a quarter of a line out.
    """

    mushaf: Mushaf
    page: Page
    line1: Line
    line2: Line

    @classmethod
    def setUpTestData(cls):
        seed_reference_data()
        Word.objects.bulk_create(
            [Word(id=n, text=f"w{n}", paw_count=1, ijam_above=0, ijam_below=0) for n in range(1, 11)]
        )
        cls.mushaf = bare_mushaf("Coordinates")
        cls.page = Page.objects.create(
            mushaf=cls.mushaf, page_number=1, bbox_x=100, bbox_y=0, bbox_w=900, bbox_h=500
        )
        cls.line1 = Line.objects.create(
            page=cls.page, line_number=1, type=LineTypeChoices.TEXT, bbox_x=100, bbox_y=0, bbox_w=900, bbox_h=50
        )
        cls.line2 = Line.objects.create(
            page=cls.page, line_number=2, type=LineTypeChoices.TEXT, bbox_x=100, bbox_y=50, bbox_w=900, bbox_h=50
        )

    def _placed(self, line: Line, origin_x: int) -> PlacedLine:
        return PlacedLine(
            image=LineImage(image=Image.new("RGBA", (4, 2)), label=f"line-{line.line_number:02d}"),
            line=line,
            origin_x=origin_x,
        )

    def _run(self, *, statuses: tuple[str, str] = ("exact", "exact")) -> word_coordinates.SaveReport:
        placements = [self._placed(self.line1, 100), self._placed(self.line2, 400)]
        result = WordBoundaryResult(
            lines=[
                _outcome("line-01", [_box(0, 250, 1), _box(1, 120, 2)], status=statuses[0]),
                _outcome(
                    "line-02",
                    [] if statuses[1] == "unresolved" else [_box(2, 50, 3)],
                    status=statuses[1],
                ),
            ],
            words_consumed=3,
            complete=True,
        )
        return word_coordinates.save_word_coordinates(result, placements)

    def test_image_x_becomes_page_x(self):
        self._run()
        self.assertEqual([w.end_x for w in self.line1.words.all()], [350, 220])

    def test_each_line_uses_its_own_origin(self):
        """The load-bearing case. Line 2's image starts 300px right of line 1's.

        Image x 50 on that line is page x 450, not 150 — and 150 would look entirely
        reasonable in the table.
        """
        self._run()
        self.assertEqual([w.end_x for w in self.line2.words.all()], [450])

    def test_word_order_runs_right_to_left_from_one(self):
        self._run()
        self.assertEqual([w.word_order for w in self.line1.words.all()], [1, 2])
        # Order 1 is the rightmost word, so its end_x is the larger.
        self.assertGreater(self.line1.words.get(word_order=1).end_x, self.line1.words.get(word_order=2).end_x)

    def test_the_word_rows_are_the_quran_words_the_engine_was_given(self):
        self._run()
        self.assertEqual([w.word_id for w in self.line1.words.all()], [1, 2])
        self.assertEqual([w.word_id for w in self.line2.words.all()], [3])

    def test_the_report_counts_what_happened(self):
        report = self._run()
        self.assertEqual((report.lines_written, report.words_written), (2, 3))
        self.assertEqual(report.lines_cleared, 0)
        self.assertEqual(report.unresolved, [])

    def test_running_again_replaces_rather_than_duplicates(self):
        self._run()
        report = self._run()
        self.assertEqual(LineWord.objects.count(), 3)
        self.assertEqual(report.lines_cleared, 3)

    def test_an_unresolved_line_loses_its_old_answer(self):
        """Visibly missing beats quietly stale: yesterday's cuts do not survive."""
        self._run()
        report = self._run(statuses=("exact", "unresolved"))
        self.assertEqual(list(self.line2.words.all()), [])
        self.assertEqual(report.unresolved, ["line-02"])
        self.assertEqual(report.lines_written, 1)
        # Line 1 still resolved, so it keeps a fresh answer.
        self.assertEqual(self.line1.words.count(), 2)

    def test_a_blank_line_is_not_reported_as_unresolved(self):
        """An ink-free line parses cleanly and simply has nothing to say."""
        report = self._run(statuses=("exact", "exact"))
        self.assertEqual(report.unresolved, [])

    def test_a_text_file_stream_is_refused(self):
        """word_id is None only when the words came from Tanzil, not the database."""
        placements = [self._placed(self.line1, 100)]
        box = _box(0, 250, 1)
        orphan = WordBox(
            index=box.index,
            text="جَوَابَ",
            aya=box.aya,
            word_id=None,
            expected_paws=box.expected_paws,
            components=box.components,
            x=box.x,
            y=box.y,
            w=box.w,
            h=box.h,
            end_x=box.end_x,
        )
        result = WordBoundaryResult(lines=[_outcome("line-01", [orphan])], words_consumed=1, complete=True)
        with self.assertRaises(ValueError) as caught:
            word_coordinates.save_word_coordinates(result, placements)
        self.assertIn("جَوَابَ", str(caught.exception))
        self.assertEqual(LineWord.objects.count(), 0)

    def test_a_mismatched_result_is_refused_rather_than_written_askew(self):
        """One placement per line, in order. Pairing them off by one would silently
        write every line's words onto its neighbour."""
        result = WordBoundaryResult(lines=[_outcome("line-01", [_box(0, 250, 1)])], words_consumed=1, complete=True)
        with self.assertRaises(ValueError):
            word_coordinates.save_word_coordinates(
                result, [self._placed(self.line1, 100), self._placed(self.line2, 400)]
            )

    def test_deleting_a_line_takes_its_words(self):
        self._run()
        self.line2.delete()
        self.assertEqual(LineWord.objects.count(), 2)
