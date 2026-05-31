from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from PIL import Image

from core.context import BBox, LineResult, PageContext, SegmentResult
from core.coordinate_exporter import collect_page_coordinates
from core.review import (
    normalize_review_data,
    re_export_corrected_images,
    safe_page_image_filename,
)


class ReviewTests(unittest.TestCase):
    def test_safe_page_image_filename_strips_paths(self) -> None:
        self.assertEqual(
            safe_page_image_filename(7, "../bad/name page.png"),
            "0007_name_page.png",
        )
        self.assertEqual(
            safe_page_image_filename(12, r"..\bad\page?.png"),
            "0012_page_.png",
        )

    def test_coordinate_export_includes_review_fields(self) -> None:
        image = Image.new("RGB", (100, 80), "white")
        line = LineResult(
            bbox=BBox(left=10, top=20, right=90, bottom=40),
            line_index=1,
            segments=[
                SegmentResult(
                    bbox=BBox(left=55, top=20, right=90, bottom=40),
                    has_separator=True,
                    sura_number=1,
                    aya_number=1,
                ),
                SegmentResult(
                    bbox=BBox(left=10, top=20, right=55, bottom=40),
                    has_separator=False,
                    sura_number=1,
                    aya_number=2,
                ),
            ],
        )
        ctx = PageContext(
            image=image,
            grey=None,  # type: ignore[arg-type]
            binary=None,  # type: ignore[arg-type]
            filename="001.png",
            page_index=1,
            page_image_filename="0001_001.png",
            crop_box=BBox(left=5, top=6, right=95, bottom=75),
            lines=[line],
        )

        data = collect_page_coordinates(ctx)

        self.assertEqual(data["page_image_filename"], "0001_001.png")
        self.assertEqual(data["crop_box"], {"x": 5, "y": 6, "w": 90, "h": 69})
        self.assertEqual(data["lines"][0]["separator_cuts"], [55])
        self.assertTrue(data["lines"][0]["segments"][0]["has_separator"])

    def test_aya_anchor_stops_at_next_sura(self) -> None:
        data = {
            "start_sura": 1,
            "start_aya": 1,
            "pages": [
                {
                    "lines": [
                        self._text_line(
                            y=10,
                            cuts=[70, 40],
                            anchors={0: 5},
                        ),
                        {"type": "sura_header", "line_bbox": self._bbox(10, 40)},
                        self._text_line(y=70, cuts=[60]),
                    ]
                }
            ],
        }

        corrected = normalize_review_data(data)
        first_line = corrected["pages"][0]["lines"][0]
        after_header_line = corrected["pages"][0]["lines"][2]

        self.assertEqual(
            [segment["aya_number"] for segment in first_line["segments"]],
            [5, 6, 7],
        )
        self.assertEqual(after_header_line["segments"][0]["sura_number"], 2)
        self.assertEqual(after_header_line["segments"][0]["aya_number"], 1)

    def test_sura_header_anchor_propagates_later_headers(self) -> None:
        data = {
            "start_sura": 1,
            "start_aya": 1,
            "pages": [
                {
                    "lines": [
                        {
                            "type": "sura_header",
                            "manual_sura_anchor": 10,
                            "line_bbox": self._bbox(10, 10),
                        },
                        self._text_line(y=40, cuts=[60]),
                        {"type": "sura_header", "line_bbox": self._bbox(10, 70)},
                        self._text_line(y=100, cuts=[60]),
                    ]
                }
            ],
        }

        corrected = normalize_review_data(data)

        self.assertEqual(corrected["pages"][0]["lines"][0]["sura_number"], 10)
        self.assertEqual(corrected["pages"][0]["lines"][2]["sura_number"], 11)
        self.assertEqual(
            corrected["pages"][0]["lines"][3]["segments"][0]["sura_number"],
            11,
        )

    def test_re_export_keeps_original_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pages_dir = root / "pages"
            output_dir = root / "corrected_images"
            pages_dir.mkdir()
            Image.new("RGB", (100, 100), "white").save(pages_dir / "0001_page.png")
            original_png = root / "auto.png"
            original_png.write_bytes(b"original")
            results_path = root / "corrected_results.json"
            data = {
                "start_sura": 1,
                "start_aya": 1,
                "pages": [
                    {
                        "page_number": 1,
                        "image_filename": "page.png",
                        "page_image_filename": "0001_page.png",
                        "lines": [self._text_line(y=10, cuts=[60])],
                    }
                ],
            }
            results_path.write_text(json.dumps(data), encoding="utf-8")

            summary = re_export_corrected_images(results_path, pages_dir, output_dir)

            self.assertEqual(summary["exported_images"], 2)
            self.assertTrue(output_dir.exists())
            self.assertTrue(any(output_dir.iterdir()))
            self.assertTrue(original_png.exists())

    @staticmethod
    def _bbox(x: int, y: int) -> dict[str, int]:
        return {"x": x, "y": y, "w": 80, "h": 20}

    def _text_line(
        self,
        y: int,
        cuts: list[int],
        anchors: dict[int, int] | None = None,
    ) -> dict[str, Any]:
        segments: list[dict[str, Any]] = []
        line: dict[str, Any] = {
            "type": "text",
            "line_bbox": self._bbox(10, y),
            "separator_cuts": cuts,
            "segments": segments,
        }
        for index, cut in enumerate(reversed(cuts)):
            segment: dict[str, Any] = {
                "bbox": {"x": cut, "y": y, "w": 90 - cut, "h": 20},
                "has_separator": True,
            }
            if anchors and index in anchors:
                segment["manual_aya_anchor"] = anchors[index]
            segments.append(segment)
        segments.append(
            {
                "bbox": {"x": 10, "y": y, "w": 30, "h": 20},
                "has_separator": False,
            }
        )
        return line


if __name__ == "__main__":
    unittest.main()
