from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from image_utils import binarize_image
from script.line_cutter import _smooth

H = 500

images_path = Path("data/quran-hafs-mushaf")
for image in list(images_path.glob("*.png"))[600:605]:
    img = Image.open(image)
    _, binary = binarize_image(img)
    row_sums = binary.sum(axis=1).astype(np.float64)
    smoothed = _smooth(row_sums)
    N = len(smoothed)
    img = np.zeros((H, N), np.uint8)
    M = max(float(smoothed.max()), 1.0)
    pts = np.column_stack(
        (np.arange(N), H - 1 - (smoothed / M * (H - 1)).astype(int))
    ).astype(np.int32)
    cv2.polylines(img, [pts], False, 255, 1)
    cv2.imwrite(image.name, img)
