"""Tests for api.services.line_images — locating, cropping and ornament spans.

The geometry is the part worth pinning. Arabic runs right to left, so "the words
before this aya" are the ones at *larger* x, and getting that backwards would crop
away exactly the half we meant to keep — while still producing a plausible image.
"""

from django.test import TestCase

from api.models import Line, LineTypeChoices, Page, Segment
from api.services import line_images
from api.tests.helpers import bare_mushaf
from quran.models import Rawi
from quran.services import suras


class LineImageGeometryTests(TestCase):
    """A line 900 wide in a column starting at page x 100.

    Three segments, right to left as the pipeline writes them: aya 5 at
    x 700..900, aya 6 at x 400..700, aya 7 at x 100..400. The first two end with
    an ornament, so their bbox_x is that ornament's left edge.
    """

    @classmethod
    def setUpTestData(cls):
        suras.seed_reference_data()
        cls.mushaf = bare_mushaf("Geometry")
        cls.mushaf.rawi = Rawi.objects.get(name="Hafs")
        cls.mushaf.save(update_fields=["rawi"])
        cls.page = Page.objects.create(
            mushaf=cls.mushaf, page_number=1, bbox_x=100, bbox_y=0, bbox_w=900, bbox_h=500
        )
        cls.line = Line.objects.create(
            page=cls.page, line_number=1, type=LineTypeChoices.TEXT, bbox_x=100, bbox_y=0, bbox_w=900, bbox_h=50
        )
        for order, (x, w, sep, aya) in enumerate(
            [(700, 200, True, 5), (400, 300, True, 6), (100, 300, False, 7)], start=1
        ):
            Segment.objects.create(
                line=cls.line, segment_order=order, bbox_x=x, bbox_w=w, has_separator=sep, aya_number=aya
            )
        cls.line.sura_id = 2
        cls.line.save(update_fields=["sura"])
        cls.column = {"x": 100, "y": 0, "w": 900, "h": 500}

    def _segment(self, order):
        return self.line.segments.get(segment_order=order)

    def test_image_x_zero_is_the_column_edge(self):
        self.assertEqual(line_images._origin_x(self.column, self.line), 100)

    def test_a_line_that_already_starts_the_aya_is_not_cropped(self):
        crop = line_images._crop_for(
            self.line, self.line, self.line, self._segment(1), self._segment(3), self.column
        )
        self.assertIsNone(crop)

    def test_starting_mid_line_crops_away_the_words_to_the_right(self):
        """Start at aya 6, whose segment spans page x 400..700.

        Aya 5 sits to its right and is not ours, so the cut keeps image x up to
        that segment's right edge: 400 + 300 - 100 = 600.
        """
        crop = line_images._crop_for(
            self.line, self.line, self.line, self._segment(2), self._segment(3), self.column
        )
        self.assertEqual(crop, (0, 600))

    def test_ending_mid_line_crops_away_the_words_to_the_left(self):
        """End at aya 6: aya 7 lies to its left, so keep from x 400 - 100 = 300."""
        crop = line_images._crop_for(
            self.line, self.line, self.line, self._segment(1), self._segment(2), self.column
        )
        self.assertEqual(crop, (300, None))

    def test_both_ends_on_one_line(self):
        crop = line_images._crop_for(
            self.line, self.line, self.line, self._segment(2), self._segment(2), self.column
        )
        self.assertEqual(crop, (300, 600))

    def test_ornament_spans_come_from_the_segment_left_edge(self):
        """The pipeline cuts at the ornament's left edge, so bbox_x *is* that edge.

        The right edge is rebuilt from the template width, which is the only place
        it ever came from.
        """
        spans = line_images._separators(self.line, origin_x=100, width=900, template_width=120)
        self.assertEqual(spans, [(600, 720), (300, 420)])

    def test_spans_shift_with_the_crop(self):
        """After cropping, image x 0 has moved, and the spans move with it."""
        spans = line_images._separators(self.line, origin_x=400, width=600, template_width=120)
        self.assertEqual(spans, [(300, 420), (0, 120)])

    def test_no_template_means_find_them_yourself(self):
        self.assertIsNone(line_images._separators(self.line, origin_x=100, width=900, template_width=0))

    def test_an_exported_png_is_used_as_it_is(self):
        # Only the field's truthiness is read here, so a name is enough; the bytes
        # would only matter once something opened it.
        self.line.line_png.name = "mushafs/x/lines/page-0001/line-01.png"
        self.assertFalse(line_images._needs_render(self.mushaf, self.line, None, refresh=False))

    def test_uniform_export_forces_a_render(self):
        """A padded stored PNG is centred, so page x cannot be mapped onto it."""
        self.line.line_png.name = "mushafs/x/lines/page-0001/line-01.png"
        self.mushaf.export_uniform_size = True
        self.assertTrue(line_images._needs_render(self.mushaf, self.line, None, refresh=False))

    def test_a_crop_forces_a_render_too(self):
        self.line.line_png.name = "mushafs/x/lines/page-0001/line-01.png"
        self.assertTrue(line_images._needs_render(self.mushaf, self.line, (0, 600), refresh=False))

    def test_a_line_never_exported_must_be_rendered(self):
        self.assertTrue(line_images._needs_render(self.mushaf, self.line, None, refresh=False))


class LocateTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        suras.seed_reference_data()
        cls.mushaf = bare_mushaf("Locate")
        for page_number in (1, 2):
            page = Page.objects.create(mushaf=cls.mushaf, page_number=page_number, bbox_x=0, bbox_w=100)
            for line_number in (1, 2):
                line = Line.objects.create(
                    page=page,
                    line_number=line_number,
                    type=LineTypeChoices.TEXT,
                    sura_id=2,
                    bbox_x=0,
                    bbox_y=0,
                    bbox_w=100,
                    bbox_h=10,
                )
                # Aya 5 spans both lines of page 1 and the first of page 2.
                Segment.objects.create(
                    line=line, segment_order=1, bbox_x=0, bbox_w=100, has_separator=False, aya_number=5
                )
        # A besmella line carrying no segments must never be picked.
        Line.objects.create(
            page=Page.objects.get(mushaf=cls.mushaf, page_number=1),
            line_number=3,
            type=LineTypeChoices.BESMELLA,
            sura_id=2,
            bbox_x=0,
            bbox_y=0,
            bbox_w=100,
            bbox_h=10,
        )

    def test_finds_the_first_line_carrying_the_aya(self):
        segment = line_images.locate(self.mushaf, 2, 5)
        self.assertEqual((segment.line.page.page_number, segment.line.line_number), (1, 1))

    def test_last_finds_the_far_end_of_the_aya(self):
        segment = line_images.locate(self.mushaf, 2, 5, last=True)
        self.assertEqual((segment.line.page.page_number, segment.line.line_number), (2, 2))

    def test_an_aya_that_is_nowhere_says_so(self):
        with self.assertRaises(LookupError) as caught:
            line_images.locate(self.mushaf, 2, 99)
        self.assertIn("2:99", str(caught.exception))
