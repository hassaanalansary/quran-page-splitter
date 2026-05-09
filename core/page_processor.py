"""Single-page processing: detect → classify → export."""

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from core.aya_separator import AyaSeparatorProcessor
from core.classifier import SuraClassifier
from core.line_detector import LineDetector
from image_utils import binarize_image, make_transparent

logger = logging.getLogger(__name__)


@dataclass
class PreparedLine:
    image: Image.Image
    is_sura: bool
    line_index: int
    segment_index: int | None = None


@dataclass
class Page:
    image: Image.Image
    grey: np.ndarray
    binary: np.ndarray


class PageProcessor:
    def __init__(
        self,
        detector: LineDetector,
        results_dir: Path,
        classifier: SuraClassifier | None = None,
        aya_separator: AyaSeparatorProcessor | None = None,
    ):
        self.detector = detector
        self.results_dir = results_dir
        self.classifier = classifier
        self.aya_separator = aya_separator

    def _prepare_page(self, img: Image.Image) -> Page:
        grey, binary = binarize_image(img)
        return Page(image=img, grey=grey, binary=binary)

    def process(self, img: Image.Image, filename: str, page_index: int = 0) -> dict:
        """Detect → classify → export. Returns a result dict."""
        page = self._prepare_page(img)
        # Detect
        try:
            line_images = self.detector.detect(page, page_index=page_index)
        except Exception as e:
            logger.error("Detection failed for %s: %s", filename, e)
            return {"filename": filename, "status": "error", "message": str(e)}

        if not line_images:
            return {
                "filename": filename,
                "status": "no_lines",
                "message": "No text lines detected",
                "outputs": [],
            }

        # Classify
        labels: list[bool] | None = None
        if self.classifier is not None:
            try:
                labels = self.classifier.classify(line_images)
            except Exception as e:
                logger.warning(
                    "Classification failed for %s, skipping: %s", filename, e
                )

        prepared_lines = self._prepare_for_export(line_images, labels)

        # Export
        saved = self._export(prepared_lines, Path(filename).stem)
        logger.info(
            "Finished %s: detected=%d exported=%d",
            filename,
            len(line_images),
            len(saved),
        )
        return {
            "filename": filename,
            "status": "success",
            "lines": len(saved),
            "detected_lines": len(line_images),
            "outputs": saved,
        }

    def _prepare_for_export(
        self,
        line_images: list[Page],
        labels: list[bool] | None,
    ) -> list[PreparedLine]:
        if labels is None:
            labels = [False] * len(line_images)

        prepared: list[PreparedLine] = []
        for line_index, (line_img, is_sura) in enumerate(
            zip(line_images, labels, strict=True), start=1
        ):
            if is_sura or self.aya_separator is None:
                prepared.append(
                    PreparedLine(
                        image=line_img.image, is_sura=is_sura, line_index=line_index
                    )
                )
                continue
            split_parts = self.aya_separator.split_line(line_img.image)
            if len(split_parts) == 1:
                prepared.append(
                    PreparedLine(
                        image=split_parts[0], is_sura=False, line_index=line_index
                    )
                )
                continue
            for segment_index, segment in enumerate(split_parts, start=1):
                prepared.append(
                    PreparedLine(
                        image=segment,
                        is_sura=False,
                        line_index=line_index,
                        segment_index=segment_index,
                    )
                )
        return prepared

    def _export(
        self,
        prepared_lines: list[PreparedLine],
        stem: str,
    ) -> list[str]:
        """
        Export prepared lines to files.

        Args:
            prepared_lines: List of PreparedLine objects
            stem: Base filename without extension

        Returns:
            List of paths to saved files
        """
        saved: list[str] = []
        sura_idx = 0
        for prepared in prepared_lines:
            if prepared.is_sura:
                sura_idx += 1
                name = f"{stem}-sura-{sura_idx:02d}.png"
            elif prepared.segment_index is None:
                name = f"{stem}-l{prepared.line_index:03d}.png"
            else:
                name = f"{stem}-l{prepared.line_index:03d}-s{prepared.segment_index:02d}.png"  # noqa: E501
            out_path = self.results_dir / name
            make_transparent(prepared.image).save(out_path)
            saved.append(str(out_path))
            logger.info("Saved %s", out_path)
        return saved
