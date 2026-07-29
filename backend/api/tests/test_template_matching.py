"""Tests for the template-matching layer (pure core, no DB).

Covers the one thing the engine cannot tell by looking at a score: whether the
kernel that produced it was telling the truth. OpenCV's OpenCL
``TM_CCOEFF_NORMED`` fabricates perfect scores at some positions — measured 1.0
against the CPU kernel's 0.0726 for the same page, template and row — and a
fabrication outranks every genuine match, so it takes a header slot and evicts
a real band.

The OpenCL kernel is not available (or not faulty) on every machine, so the
fabrication is injected instead of hoped for: the sweep is stubbed to return a
score map with a 1.0 planted over blank paper, while verification runs the real
CPU ``matchTemplate``. That pins the behaviour we actually depend on.
"""

from unittest import mock

import numpy as np
from django.test import SimpleTestCase
from PIL import Image

from core import sura_header as sura_header_module
from core import template_matching
from core.sura_header import SuraHeaderLocator
from core.template_matching import (
    cpu_score_at,
    locate_x_matches,
    make_template_spec,
    needs_cpu_verification,
)

TEMPLATE_SIZE = 40
PAGE_W, PAGE_H = 400, 600
#: Where the genuine mark is stamped on the synthetic page.
REAL_X, REAL_Y = 120, 300
#: Blank paper, far from the mark — where a fabricated score gets planted.
PHANTOM_X, PHANTOM_Y = 40, 40


def _mark() -> np.ndarray:
    """A high-contrast blob: distinctive enough to score ~1.0 where it belongs."""
    tile = np.full((TEMPLATE_SIZE, TEMPLATE_SIZE), 255, dtype=np.uint8)
    tile[8:32, 8:32] = 0
    tile[14:26, 14:26] = 200
    return tile


def _page() -> np.ndarray:
    page = np.full((PAGE_H, PAGE_W), 255, dtype=np.uint8)
    page[REAL_Y : REAL_Y + TEMPLATE_SIZE, REAL_X : REAL_X + TEMPLATE_SIZE] = _mark()
    return page


def _spec(threshold: float = 0.6, **kwargs):
    return make_template_spec(
        Image.fromarray(_mark()),
        None,
        threshold,
        "sura_header",
        **kwargs,
    )


def _fabricated_map(page: np.ndarray, spec) -> np.ndarray:
    """A truthful score map with one 1.0 planted over blank paper."""
    import cv2

    honest = cv2.matchTemplate(page, spec.image, cv2.TM_CCOEFF_NORMED)
    honest[PHANTOM_Y, PHANTOM_X] = 1.0
    return honest


class ForceCpuTests(SimpleTestCase):
    def test_prefer_acceleration_off_pins_the_run_to_cpu(self):
        """The setting picks the backend, not merely how the mask is handled.

        It used to only choose mask-vs-mean-fill, so turning it off left OpenCL
        scoring anyway and the only real switch was an env var plus a restart.
        """
        self.assertTrue(_spec(prefer_acceleration=False).force_cpu)
        self.assertFalse(_spec(prefer_acceleration=True).force_cpu)

    def test_cpu_pinned_specs_are_never_verified(self):
        """Nothing to check when the trustworthy kernel produced the score."""
        self.assertFalse(needs_cpu_verification(_spec(prefer_acceleration=False)))


class CpuScoreAtTests(SimpleTestCase):
    def test_scores_high_on_the_real_mark(self):
        score = cpu_score_at(_page(), _spec(), REAL_X, REAL_Y)
        self.assertGreater(score, 0.99)

    def test_scores_low_on_blank_paper(self):
        score = cpu_score_at(_page(), _spec(), PHANTOM_X, PHANTOM_Y)
        self.assertLess(score, 0.6)

    def test_out_of_bounds_position_is_rejected_not_raised(self):
        self.assertEqual(cpu_score_at(_page(), _spec(), PAGE_W - 2, PAGE_H - 2), -1.0)


class HeaderPhantomTests(SimpleTestCase):
    def _locate(self, page, spec):
        locator = SuraHeaderLocator.__new__(SuraHeaderLocator)
        locator.max_sura_headers = 1
        locator.header = spec
        with (
            mock.patch.object(sura_header_module, "match_template", return_value=_fabricated_map(page, spec)),
            mock.patch.object(sura_header_module, "needs_cpu_verification", return_value=True),
        ):
            return locator.locate(page)

    def test_fabricated_score_is_discarded_and_the_real_band_kept(self):
        """The phantom outranks the real band and the cap is 1 — without
        verification it wins the only slot and the real header is lost."""
        page, spec = _page(), _spec()
        found = self._locate(page, spec)

        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].top, REAL_Y)
        self.assertGreater(found[0].score, 0.99)

    def test_reported_score_is_the_verified_one(self):
        """A run log that quoted the fabricated score would mislead the reader."""
        page, spec = _page(), _spec()
        found = self._locate(page, spec)
        self.assertAlmostEqual(found[0].score, cpu_score_at(page, spec, REAL_X, REAL_Y), places=5)


class SeparatorPhantomTests(SimpleTestCase):
    def test_fabricated_score_does_not_suppress_a_genuine_neighbour(self):
        """Verification has to happen before a candidate is accepted.

        A phantom admitted first would suppress everything within min_gap, so
        removing it afterwards would take the genuine separator with it.
        """
        page, spec = _page(), _spec()
        fabricated = _fabricated_map(page, spec)
        # Plant the fabrication one template-width from the real mark, inside
        # the suppression radius it would otherwise claim.
        near_x = REAL_X + TEMPLATE_SIZE // 2
        fabricated[PHANTOM_Y, PHANTOM_X] = -1.0
        fabricated[10, near_x] = 1.0

        with (
            mock.patch.object(template_matching, "match_template", return_value=fabricated),
            mock.patch.object(template_matching, "needs_cpu_verification", return_value=True),
        ):
            boxes = locate_x_matches(page, spec)

        self.assertEqual([left for left, _ in boxes], [REAL_X])
