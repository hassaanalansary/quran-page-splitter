"""Sura-name line classifier.

Uses template matching on the rightmost strip of each line to identify
sura header decorations. Mutates PageContext by setting is_sura on lines.
"""

import logging

import cv2
import numpy as np
from PIL import Image

from core.config import ClassifierConfig
from core.context import PageContext
from image_utils import binarize_image, clean_image, right_strip

logger = logging.getLogger(__name__)


class SuraClassifier:
    def __init__(
        self,
        template: Image.Image,
        config: ClassifierConfig | None = None,
    ):
        self.config = config or ClassifierConfig()
        self.prepared_template = self._prepare_template(template)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _prepare_template(self, template: Image.Image) -> np.ndarray:
        gray, binary = binarize_image(template)
        cleaned_gray, cleaned_binary = clean_image(gray, binary)

        strip_gray = right_strip(cleaned_gray)
        strip_binary = right_strip(cleaned_binary)

        self._strip_width = strip_gray.shape[1]
        final_gray, _ = clean_image(strip_gray, strip_binary)
        return final_gray

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def classify(self, ctx: PageContext) -> None:
        """Classify each line in ctx as sura header or text. Mutates ctx.lines."""
        for line in ctx.lines:
            line_grey = ctx.line_grey(line)
            line_binary = ctx.line_binary(line)

            candidate_strip_gray = right_strip(line_grey, width=self._strip_width)
            candidate_strip_binary = right_strip(line_binary, width=self._strip_width)

            cleaned_gray, _ = clean_image(candidate_strip_gray, candidate_strip_binary)
            result = cv2.matchTemplate(
                cleaned_gray, self.prepared_template, cv2.TM_CCOEFF_NORMED
            )
            _, max_val, _, _ = cv2.minMaxLoc(result)

            line.is_sura = bool(max_val >= self.config.match_threshold)
            logger.info(
                "  line %d: score=%.4f%s",
                line.line_index,
                max_val,
                " → SURA" if line.is_sura else "",
            )
