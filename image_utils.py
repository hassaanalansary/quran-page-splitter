"""Shared image utilities used by both the server pipeline and the CLI."""

import cv2
import numpy as np
from PIL import Image


def make_transparent(image: Image.Image, threshold: int = 200) -> Image.Image:
    """Convert white (or near-white) background pixels to transparent.

    Uses NumPy vectorised operations instead of pixel-by-pixel Python loops
    for significantly better performance on large images.

    Args:
        image: Input PIL image (any mode).
        threshold: Pixels with R, G, and B all above this value are
            treated as background and made fully transparent.

    Returns:
        An RGBA image with the background removed.
    """
    rgba = image.convert("RGBA")
    data = np.array(rgba)

    # Mask: pixels where R, G, and B are all above the threshold
    is_white = np.all(data[:, :, :3] > threshold, axis=2)
    data[is_white, 3] = 0

    return Image.fromarray(data, "RGBA")


def binarize_image(image: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Standardize image for analysis by flattening transparency, 
    converting to grayscale, and binarizing (Otsu thresholding + inverse)
    so that background is 0 and text is 255.
    """
    if image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info):
        base = Image.new("RGBA", image.size, (255, 255, 255, 255))
        try:
            base.paste(image.convert("RGBA"), mask=image.convert("RGBA").split()[3])
            image = base
        except Exception:
            pass
            
    gray = np.array(image.convert("L"), dtype=np.uint8)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return gray, binary


def clean_image(gray: np.ndarray, binary: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Remove background and crop tightly to all non-background content.

    Preserves everything that isn't background — text, decoration, borders.
    """
    coords = cv2.findNonZero(binary)
    if coords is None:
        return gray, binary
    x, y, w, h = cv2.boundingRect(coords)
    return gray[y : y + h, x : x + w], binary[y : y + h, x : x + w]


def right_strip(cleaned: np.ndarray, width: int | None = None, fraction: float = 0.30) -> np.ndarray:
    """Return the rightmost strip.
    If width is given, take exactly that many pixels.
    Otherwise compute from fraction.
    """
    w = width if width is not None else max(1, int(cleaned.shape[1] * fraction))
    w = min(w, cleaned.shape[1])  # can't exceed available width
    return cleaned[:, -w:]
