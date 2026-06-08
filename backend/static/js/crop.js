import { state } from "./state.js";
import {
  updateSelectionDiv,
  updateUIFromCrop,
  updateLivePreview,
  inputX,
  inputY,
  inputW,
  inputH,
  sizeInfo,
  selBox,
} from "./ui.js";

export function clampCropBounds() {
  if (!state.img) return;
  const iw = state.imgNaturalWidth,
    ih = state.imgNaturalHeight;
  state.cropX = Math.min(
    Math.max(0, state.cropX),
    Math.max(0, iw - state.cropW),
  );
  state.cropY = Math.min(
    Math.max(0, state.cropY),
    Math.max(0, ih - state.cropH),
  );
  state.cropW = Math.min(state.cropW, iw - state.cropX);
  state.cropH = Math.min(state.cropH, ih - state.cropY);
  if (state.cropW < 1) state.cropW = 1;
  if (state.cropH < 1) state.cropH = 1;
  if (state.cropX + state.cropW > iw) state.cropX = iw - state.cropW;
  if (state.cropY + state.cropH > ih) state.cropY = ih - state.cropH;
}

export function setCrop(newX, newY, newW, newH, updateInputs = true) {
  if (!state.img) return;
  state.cropX = Math.round(newX);
  state.cropY = Math.round(newY);
  state.cropW = Math.round(newW);
  state.cropH = Math.round(newH);
  if (state.cropW < 1) state.cropW = 1;
  if (state.cropH < 1) state.cropH = 1;
  clampCropBounds();
  if (updateInputs) updateUIFromCrop();
  else {
    updateSelectionDiv();
    updateLivePreview();
  }
}

export function initDefaultCenteredCrop() {
  if (!state.img) return;
  const { imgNaturalWidth: iw, imgNaturalHeight: ih } = state;
  const size = Math.max(40, Math.min(150, iw, ih));
  setCrop(
    Math.floor((iw - size) / 2),
    Math.floor((ih - size) / 2),
    size,
    size,
    true,
  );
  state.selectionActive = true;
  updateUIFromCrop();
}

export function deactivateCrop() {
  state.selectionActive = false;
  state.cropW = state.cropH = state.cropX = state.cropY = 0;
  selBox.style.display = "none";
  [inputX, inputY, inputW, inputH].forEach((el) => {
    el.disabled = true;
    el.value = 0;
  });
  sizeInfo.innerHTML = `⚡ no active crop — press "Start cropping"`;
  updateLivePreview();
}

export function startCropping() {
  if (!state.img) return;
  deactivateCrop();
  state.selectionActive = true;
  initDefaultCenteredCrop();
}

export function onManualInputChange() {
  if (!state.selectionActive || !state.img) return;
  const x = parseInt(inputX.value, 10) || state.cropX;
  const y = parseInt(inputY.value, 10) || state.cropY;
  let w = parseInt(inputW.value, 10) || state.cropW;
  let h = parseInt(inputH.value, 10) || state.cropH;
  if (w < 1) w = 1;
  if (h < 1) h = 1;
  setCrop(x, y, w, h, false);
  clampCropBounds();
  updateUIFromCrop();
}
