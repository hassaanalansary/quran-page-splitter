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

from api.models import Line, LineTypeChoices, LineWord, LineWordStatus, Mushaf, Page
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
        # The span asked for, which is what a run clears — not what it produced.
        return word_coordinates.save_word_coordinates(result, placements, word_range=(1, 3))

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

    def test_words_come_back_right_to_left(self):
        """Ordering is geometry, not a stored rank: -end_x is reading order.

        Nothing has to be renumbered when a word is added, deleted or moved to a
        neighbouring line, and it stays defined for a word with no label.
        """
        self._run()
        self.assertEqual([w.end_x for w in self.line1.words.all()], [350, 220])
        self.assertEqual([w.word_id for w in self.line1.words.all()], [1, 2])

    def test_the_word_rows_are_the_quran_words_the_engine_was_given(self):
        self._run()
        self.assertEqual([w.word_id for w in self.line1.words.all()], [1, 2])
        self.assertEqual([w.word_id for w in self.line2.words.all()], [3])

    def test_the_engines_verdict_is_stored_for_triage(self):
        """Without this a reviewer has no way to tell a confident cut from a guess."""
        self._run(statuses=("scored", "exact"))
        status = LineWordStatus.objects.get(line=self.line1)
        self.assertEqual(status.status, "scored")
        self.assertFalse(status.edited)

    def test_a_status_goes_when_its_line_goes(self):
        self._run()
        self.line2.delete()
        self.assertFalse(LineWordStatus.objects.filter(line_id=self.line2.pk).exists())

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
            word_coordinates.save_word_coordinates(result, placements, word_range=(1, 3))
        self.assertIn("جَوَابَ", str(caught.exception))
        self.assertEqual(LineWord.objects.count(), 0)

    def test_a_mismatched_result_is_refused_rather_than_written_askew(self):
        """One placement per line, in order. Pairing them off by one would silently
        write every line's words onto its neighbour."""
        result = WordBoundaryResult(lines=[_outcome("line-01", [_box(0, 250, 1)])], words_consumed=1, complete=True)
        with self.assertRaises(ValueError):
            word_coordinates.save_word_coordinates(
                result,
                [self._placed(self.line1, 100), self._placed(self.line2, 400)],
                word_range=(1, 3),
            )

    def test_deleting_a_line_takes_its_words(self):
        self._run()
        self.line2.delete()
        self.assertEqual(LineWord.objects.count(), 2)


class ChunkSeamTests(TestCase):
    """Two chunks meeting on one line — the case that decided the schema.

    A run is split into aya spans, and an aya boundary rarely falls at a line break,
    so consecutive chunks share the line it falls on. Chunk B must add its words to
    that line without destroying chunk A's. With a per-line rank both chunks would
    start at 1 and collide; clearing the whole line would lose A's work outright.
    """

    mushaf: Mushaf
    page: Page
    lines: list[Line]

    @classmethod
    def setUpTestData(cls):
        seed_reference_data()
        Word.objects.bulk_create(
            [Word(id=n, text=f"w{n}", paw_count=1, ijam_above=0, ijam_below=0) for n in range(1, 11)]
        )
        cls.mushaf = bare_mushaf("Seam")
        cls.page = Page.objects.create(
            mushaf=cls.mushaf, page_number=1, bbox_x=100, bbox_y=0, bbox_w=900, bbox_h=500
        )
        cls.lines = [
            Line.objects.create(
                page=cls.page,
                line_number=n,
                type=LineTypeChoices.TEXT,
                bbox_x=100,
                bbox_y=50 * n,
                bbox_w=900,
                bbox_h=50,
            )
            for n in (1, 2, 3)
        ]

    def _placed(self, line: Line, origin_x: int) -> PlacedLine:
        return PlacedLine(
            image=LineImage(image=Image.new("RGBA", (4, 2)), label=f"line-{line.line_number:02d}"),
            line=line,
            origin_x=origin_x,
        )

    def _chunk_a(self):
        """Words 1..3: all of line 1, and the start of line 2."""
        return word_coordinates.save_word_coordinates(
            WordBoundaryResult(
                lines=[
                    _outcome("line-01", [_box(0, 250, 1), _box(1, 120, 2)]),
                    _outcome("line-02", [_box(2, 50, 3)]),
                ],
                words_consumed=3,
                complete=True,
            ),
            [self._placed(self.lines[0], 100), self._placed(self.lines[1], 400)],
            word_range=(1, 3),
        )

    def _chunk_b(self):
        """Words 4..6: the rest of line 2, and all of line 3."""
        return word_coordinates.save_word_coordinates(
            WordBoundaryResult(
                lines=[
                    _outcome("line-02", [_box(3, 200, 4)]),
                    _outcome("line-03", [_box(4, 260, 5), _box(5, 130, 6)]),
                ],
                words_consumed=3,
                complete=True,
            ),
            [self._placed(self.lines[1], 100), self._placed(self.lines[2], 100)],
            word_range=(4, 6),
        )

    def test_the_second_chunk_does_not_wipe_the_first(self):
        self._chunk_a()
        self._chunk_b()
        seam = self.lines[1].words.all()
        self.assertEqual([row.word_id for row in seam], [3, 4])
        self.assertEqual(LineWord.objects.count(), 6)

    def test_the_seam_line_still_reads_right_to_left(self):
        """Word 3 ends at page x 450, word 4 at 300 — so 3 comes first."""
        self._chunk_a()
        self._chunk_b()
        self.assertEqual([row.end_x for row in self.lines[1].words.all()], [450, 300])

    def test_re_running_one_chunk_replaces_only_its_own_words(self):
        self._chunk_a()
        self._chunk_b()
        self._chunk_a()
        self.assertEqual([row.word_id for row in self.lines[1].words.all()], [3, 4])
        self.assertEqual(LineWord.objects.count(), 6)


class AddedWordTests(TestCase):
    """A word this mushaf prints that the stored Hafs text does not have.

    The reviewer supplies the cut and there is no ``Word`` row to point at, so the
    label is null. It has to survive a re-run — the engine cannot reproduce it, and
    discarding a person's work on every run would make the fix pointless.
    """

    mushaf: Mushaf
    page: Page
    line: Line

    @classmethod
    def setUpTestData(cls):
        seed_reference_data()
        Word.objects.bulk_create(
            [Word(id=n, text=f"w{n}", paw_count=1, ijam_above=0, ijam_below=0) for n in range(1, 11)]
        )
        cls.mushaf = bare_mushaf("Added")
        cls.page = Page.objects.create(
            mushaf=cls.mushaf, page_number=1, bbox_x=100, bbox_y=0, bbox_w=900, bbox_h=500
        )
        cls.line = Line.objects.create(
            page=cls.page, line_number=1, type=LineTypeChoices.TEXT, bbox_x=100, bbox_y=0, bbox_w=900, bbox_h=50
        )

    def _placed(self) -> PlacedLine:
        return PlacedLine(
            image=LineImage(image=Image.new("RGBA", (4, 2)), label="line-01"),
            line=self.line,
            origin_x=100,
        )

    def _run(self, *, second_at: int = 120):
        """``second_at`` is image x, so page x is 100 more — the origin."""
        return word_coordinates.save_word_coordinates(
            WordBoundaryResult(
                lines=[_outcome("line-01", [_box(0, 250, 1), _box(1, second_at, 2)])],
                words_consumed=2,
                complete=True,
            ),
            [self._placed()],
            word_range=(1, 2),
        )

    def test_an_added_cut_survives_a_re_run(self):
        self._run()
        LineWord.objects.create(line=self.line, word=None, end_x=280)
        self._run()
        rows = list(self.line.words.all())
        # 350, 280 (added), 220 — right to left, with the unlabelled one in place.
        self.assertEqual([row.end_x for row in rows], [350, 280, 220])
        self.assertIsNone(rows[1].word_id)

    def test_the_line_is_still_marked_as_touched_by_a_person(self):
        self._run()
        LineWord.objects.create(line=self.line, word=None, end_x=280)
        self._run()
        self.assertTrue(LineWordStatus.objects.get(line=self.line).edited)

    def test_a_cut_the_engine_later_claims_is_displaced_rather_than_crashing(self):
        """The run moves onto a human's x. unique(line, end_x) would refuse the write.

        The run wins that tie: it found a word where the person had put a cut, which
        is the very thing they were compensating for.
        """
        self._run()
        LineWord.objects.create(line=self.line, word=None, end_x=280)
        # Word 2 now lands on page x 280 — exactly where the added cut sits.
        report = self._run(second_at=180)
        self.assertEqual(report.displaced, 1)
        self.assertEqual([row.word_id for row in self.line.words.all()], [1, 2])
        self.assertEqual([row.end_x for row in self.line.words.all()], [350, 280])
