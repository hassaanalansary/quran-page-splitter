"""Sura-name line classifier."""

import logging
import cv2
import numpy as np
from PIL import Image

from core.config import ClassifierConfig, DetectionConfig
from script.line_cutter import crop_lines

logger = logging.getLogger(__name__)


class SuraClassifier:
    def __init__(
        self,
        template: Image.Image,
        detection: DetectionConfig,
        config: ClassifierConfig | None = None,
    ):
        self.config = config or ClassifierConfig()
        self._template_edge = self._prepare_template(template, detection)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _clean(gray: np.ndarray) -> np.ndarray:
        """Remove background and crop tightly to all non-background content.

        Preserves everything that isn't background — text, decoration, borders.
        """
        _, binary = cv2.threshold(
            gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
        )
        coords = cv2.findNonZero(binary)
        if coords is None:
            return gray
        x, y, w, h = cv2.boundingRect(coords)
        return gray[y : y + h, x : x + w]

    @staticmethod
    def _right_strip(cleaned: np.ndarray, width: int | None = None, fraction: float = 0.30) -> np.ndarray:
        """Return the rightmost strip.
        If width is given, take exactly that many pixels.
        Otherwise compute from fraction (used for template preparation).
        """
        w = width if width is not None else max(1, int(cleaned.shape[1] * fraction))
        w = min(w, cleaned.shape[1])  # can't exceed available width
        return cleaned[:, -w:]

    @staticmethod
    def _vertical_clean(strip: np.ndarray) -> np.ndarray:
        """Remove empty (background) rows from top and bottom of the strip."""
        _, binary = cv2.threshold(
            strip, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
        )
        coords = cv2.findNonZero(binary)
        if coords is None:
            return strip
        _, y, _, h = cv2.boundingRect(coords)
        return strip[y : y + h, :]

    def _prepare_template(
        self, template: Image.Image, detection: DetectionConfig
    ) -> np.ndarray:
        lines = crop_lines(template, **detection.as_dict())
        prepped = lines[0] if lines else template

        gray = np.array(prepped.convert("L"), dtype=np.uint8)
        cleaned = self._clean(gray)
        strip = self._right_strip(cleaned)
        self._strip_width = strip.shape[1]
        return self._vertical_clean(strip)  # vertically tight-crop سورة


    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def classify_single(
        self,
        img: Image.Image,
        idx: int = 0,
    ) -> bool:

        return self._match(img, idx)

    # ------------------------------------------------------------------
    # Template matching
    # ------------------------------------------------------------------

    def _match(self, img: Image.Image, idx: int) -> bool:
        gray = np.array(img.convert("L"), dtype=np.uint8)
        cleaned = self._clean(gray)
        candidate_strip = self._right_strip(cleaned, width=self._strip_width)
        candidate_strip = self._vertical_clean(candidate_strip)  # same vertical tight-crop

        tmpl = self._template_edge

        result = cv2.matchTemplate(candidate_strip, tmpl, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, _ = cv2.minMaxLoc(result)

        is_sura = max_val >= self.config.match_threshold
        logger.info("  line %d: score=%.4f%s", idx, max_val, " → SURA" if is_sura else "")

        return is_sura