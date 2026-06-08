import { state } from "./state.js";

function normalizeRect(rect) {
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

export function currentVisibleCropRect() {
  return normalizeRect({
    left: state.cropX,
    top: state.cropY,
    width: state.cropW,
    height: state.cropH,
  });
}

export function applyCropRect(rect) {
  const normalized = normalizeRect(rect);
  state.cropX = normalized.left;
  state.cropY = normalized.top;
  state.cropW = normalized.width;
  state.cropH = normalized.height;
}

export function shouldMirrorBounds({
  alternate = state.alternateHorizontalMargin,
  imageIndex = state.selectedImageIndex,
} = {}) {
  const pageNumber = imageIndex + 1;
  return Boolean(alternate) && pageNumber % 2 === 0;
}

export function mirrorBoundsRect(rect, imageWidth) {
  const normalized = normalizeRect(rect);
  if (!Number.isFinite(imageWidth) || imageWidth <= 0) {
    return normalized;
  }
  return {
    ...normalized,
    left: Math.round(imageWidth - (normalized.left + normalized.width)),
  };
}

export function boundsRectForPage(
  rect,
  {
    alternate = state.alternateHorizontalMargin,
    imageIndex = state.selectedImageIndex,
    imageWidth = state.imgNaturalWidth,
  } = {},
) {
  const normalized = normalizeRect(rect);
  if (!shouldMirrorBounds({ alternate, imageIndex })) {
    return normalized;
  }
  return mirrorBoundsRect(normalized, imageWidth);
}

export function boundsRectFromPage(rect, options = {}) {
  return boundsRectForPage(rect, options);
}
