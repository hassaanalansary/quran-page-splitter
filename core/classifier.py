"""Sura-name line classifier."""

import logging
import cv2
import numpy as np
from PIL import Image
from image_utils import binarize_image, clean_image, right_strip

from core.config import ClassifierConfig

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

    def _prepare_template(
        self, template: Image.Image
    ) -> np.ndarray:
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

    def classify_single(self, img: Image.Image, idx: int = 0) -> bool:
        gray, binary = binarize_image(img)
        cleaned_gray, cleaned_binary = clean_image(gray, binary)
        
        candidate_strip_gray = right_strip(cleaned_gray, width=self._strip_width)
        candidate_strip_binary = right_strip(cleaned_binary, width=self._strip_width)
        
        candidate_strip_gray, _ = clean_image(candidate_strip_gray, candidate_strip_binary)

        tmpl = self.prepared_template

        result = cv2.matchTemplate(candidate_strip_gray, tmpl, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, _ = cv2.minMaxLoc(result)

        is_sura = max_val >= self.config.match_threshold
        logger.info("  line %d: score=%.4f%s", idx, max_val, " → SURA" if is_sura else "")

        return is_sura
