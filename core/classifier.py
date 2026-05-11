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
from core.opencv_accel import match_template_ccoeff_normed
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
        cleaned_gray, _ = clean_image(gray, binary)
        self._strip_width = cleaned_gray.shape[1]  # exact template width after clean
        return cleaned_gray

    def classify(self, ctx: PageContext) -> None:
        """Classify each line in ctx as sura header or text. Mutates ctx.lines."""
        for line in ctx.lines:
            line_grey = ctx.line_grey(line)
            line_binary = ctx.line_binary(line)
            cleaned_gray, _ = clean_image(line_grey, line_binary)

            # Rightmost strip exactly as wide as the template — removes the sura
            # name (e.g. النبأ) and leaves the "سورة" region for matching
            strip = right_strip(cleaned_gray, width=self._strip_width)

            # Tight crop in strip dimensions: grayscale has no ink/background split
            # (near-white margins are non-zero); re-binarize to bound the crop.
            _, strip_binary = binarize_image(Image.fromarray(strip, mode="L"))
            strip, _ = clean_image(strip, strip_binary)

            max_val = self._match_score(strip)

            line.is_sura = max_val >= self.config.match_threshold
            logger.info(
                "  line %d: score=%.4f%s",
                line.line_index,
                max_val,
                " → SURA" if line.is_sura else "",
            )

    def _match_score(self, strip: np.ndarray) -> float:
        template = self.prepared_template
        t_h, t_w = template.shape[:2]
        s_h, s_w = strip.shape[:2]

        if s_h >= t_h and s_w >= t_w:
            # Normal: template slides over strip
            image, tmpl = strip, template

        elif t_h >= s_h and t_w >= s_w:
            # Swapped: clipped/small strip slides over template
            image, tmpl = template, strip

        else:
            # Mixed: strip is larger in one dimension, smaller in the other
            # Pad strip up to template size in whichever dimension it falls short
            pad_h = max(0, t_h - s_h)
            pad_w = max(0, t_w - s_w)
            strip = cv2.copyMakeBorder(
                strip,
                pad_h // 2,
                pad_h - pad_h // 2,
                pad_w // 2,
                pad_w - pad_w // 2,
                cv2.BORDER_CONSTANT,
                value=0,
            )
            image, tmpl = strip, template

        result = match_template_ccoeff_normed(image, tmpl)
        _, max_val, _, _ = cv2.minMaxLoc(result)
        return float(max_val)

