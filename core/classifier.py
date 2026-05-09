"""Sura-name line classifier."""

import logging

import cv2
import numpy as np
from PIL import Image

from core.config import ClassifierConfig
from core.page_processor import Page
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

    def classify_single(self, page: Page, idx: int = 0) -> bool:
        candidate_strip_gray = right_strip(page.grey, width=self._strip_width)
        candidate_strip_binary = right_strip(page.binary, width=self._strip_width)

        cleaned_gray, _ = clean_image(candidate_strip_gray, candidate_strip_binary)

        result = cv2.matchTemplate(
            cleaned_gray, self.prepared_template, cv2.TM_CCOEFF_NORMED
        )
        _, max_val, _, _ = cv2.minMaxLoc(result)

        is_sura = max_val >= self.config.match_threshold
        logger.info(
            "  line %d: score=%.4f%s", idx, max_val, " → SURA" if is_sura else ""
        )

        return is_sura

    def classify(self, images: list[Page]) -> list[bool]:
        """Classify a batch of line images, returning True for sura headers."""
        return [self.classify_single(page, idx=i) for i, page in enumerate(images)]
