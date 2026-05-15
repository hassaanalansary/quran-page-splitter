import { state } from "./state.js";
import { origToCanvas, origSizeToCanvas, mainCanvas } from "./canvas.js";

// ---- DOM refs used across modules ----
export const selBox = document.getElementById("selection-box");
export const sizeInfo = document.getElementById("size-info");
export const inputX = document.getElementById("crop-x");
export const inputY = document.getElementById("crop-y");
export const inputW = document.getElementById("crop-w");
export const inputH = document.getElementById("crop-h");
export const previewSec = document.getElementById("preview-section");
export const previewCanvas = document.getElementById("preview-canvas");
export const coordsEl = document.getElementById("coords");
export const queueInfo = document.getElementById("queue-info");
export const submitBtn = document.getElementById("submit-btn");
export const carousel = document.getElementById("carousel");
export const thumbStrip = document.getElementById("thumb-strip");
export const carouselPrevBtn = document.getElementById("carousel-prev");
export const carouselNextBtn = document.getElementById("carousel-next");
export const cropModeSelect = document.getElementById("crop-mode");
export const statusBounds = document.getElementById("status-bounds");
export const statusSura = document.getElementById("status-sura");
export const statusSuraIgnore = document.getElementById("status-sura-ignore");
export const statusBasmala = document.getElementById("status-basmala");
export const statusAya = document.getElementById("status-aya");
export const statusAyaIgnore = document.getElementById("status-aya-ignore");
const thumbObjectUrls = [];
const THUMB_WINDOW_SIZE = 36;

// ---- selection box overlay ----
export function updateSelectionDiv() {
  if (!state.selectionActive || state.cropW <= 0 || state.cropH <= 0) {
    selBox.style.display = "none";
    return;
  }
  const pos = origToCanvas(state.cropX, state.cropY);
  const size = origSizeToCanvas(state.cropW, state.cropH);
  selBox.style.left = pos.x + "px";
  selBox.style.top = pos.y + "px";
  selBox.style.width = size.w + "px";
  selBox.style.height = size.h + "px";
  selBox.style.display = "block";
}

// ---- live preview canvas ----
export function updateLivePreview() {
  if (
    !state.img ||
    !state.selectionActive ||
    state.cropW <= 0 ||
    state.cropH <= 0
  ) {
    previewSec.style.display = "none";
    return;
  }
  previewCanvas.width = state.cropW;
  previewCanvas.height = state.cropH;
  const pCtx = previewCanvas.getContext("2d");
  pCtx.drawImage(
    state.img,
    state.cropX,
    state.cropY,
    state.cropW,
    state.cropH,
    0,
    0,
    state.cropW,
    state.cropH,
  );
  previewSec.style.display = "flex";
}

// ---- crop inputs + size badge ----
export function updateUIFromCrop() {
  const active = state.selectionActive && state.cropW > 0 && state.cropH > 0;
  [inputX, inputY, inputW, inputH].forEach((el) => (el.disabled = !active));
  if (!active) {
    inputX.value = inputY.value = inputW.value = inputH.value = 0;
    sizeInfo.innerHTML = `⚡ select or start cropping`;
    if (state.cropW <= 0) selBox.style.display = "none";
  } else {
    inputX.value = state.cropX;
    inputY.value = state.cropY;
    inputW.value = state.cropW;
    inputH.value = state.cropH;
    sizeInfo.innerHTML =
      `<span>${state.cropW}</span> × <span>${state.cropH}</span> px` +
      `  (x:${state.cropX}, y:${state.cropY})`;
  }
  updateSelectionDiv();
  updateLivePreview();
}

// ---- image queue badge ----
export function updateQueueInfo() {
  const n = state.imageFiles.length;
  queueInfo.textContent = n > 0 ? `${n} image${n > 1 ? "s" : ""} queued` : "";
  if (submitBtn) submitBtn.style.display = n > 0 ? "" : "none";
  if (carousel) carousel.style.display = n > 0 ? "flex" : "none";
}

export function renderCarousel() {
  if (!thumbStrip) return;
  while (thumbObjectUrls.length) {
    URL.revokeObjectURL(thumbObjectUrls.pop());
  }
  thumbStrip.innerHTML = "";
  if (!state.imageFiles.length) return;

  const half = Math.floor(THUMB_WINDOW_SIZE / 2);
  const minStart = Math.max(0, state.imageFiles.length - THUMB_WINDOW_SIZE);
  const start = Math.min(
    minStart,
    Math.max(0, state.selectedImageIndex - half),
  );
  const end = Math.min(state.imageFiles.length, start + THUMB_WINDOW_SIZE);

  for (let index = start; index < end; index += 1) {
    const file = state.imageFiles[index];
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className =
      "thumb" + (index === state.selectedImageIndex ? " active" : "");
    thumb.dataset.index = String(index);
    thumb.title = file.name;

    const img = document.createElement("img");
    const thumbUrl = URL.createObjectURL(file);
    thumbObjectUrls.push(thumbUrl);
    img.src = thumbUrl;
    img.alt = file.name;
    img.loading = "lazy";
    img.decoding = "async";
    thumb.appendChild(img);
    thumbStrip.appendChild(thumb);
  }

  const activeThumb = thumbStrip.querySelector(".thumb.active");
  if (activeThumb) {
    activeThumb.scrollIntoView({
      block: "nearest",
      inline: "center",
    });
  }
}

export function updateCropOutputStatus() {
  const {
    bounds,
    suraHeaderBlob,
    suraHeaderIgnore,
    basmalaBlob,
    ayaSeparatorBlob,
    ayaSeparatorIgnore,
  } = state.globalOutputs;
  statusBounds.textContent = `bounds: ${bounds ? "ready" : "pending"}`;
  statusSura.textContent = `sura_header: ${suraHeaderBlob ? "ready" : "pending"}`;
  statusSuraIgnore.textContent = `header_ignore: ${
    suraHeaderIgnore ? "ready" : "optional"
  }`;
  statusBasmala.textContent = `basmala: ${basmalaBlob ? "ready" : "optional"}`;
  statusAya.textContent = `aya_separator: ${ayaSeparatorBlob ? "ready" : "pending"}`;
  statusAyaIgnore.textContent = `aya_ignore: ${
    ayaSeparatorIgnore ? "ready" : "optional"
  }`;

  statusBounds.classList.toggle("complete", Boolean(bounds));
  statusSura.classList.toggle("complete", Boolean(suraHeaderBlob));
  statusSuraIgnore.classList.toggle("complete", Boolean(suraHeaderIgnore));
  statusBasmala.classList.toggle("complete", Boolean(basmalaBlob));
  statusAya.classList.toggle("complete", Boolean(ayaSeparatorBlob));
  statusAyaIgnore.classList.toggle("complete", Boolean(ayaSeparatorIgnore));
}

export function syncCropModeUI() {
  if (cropModeSelect) cropModeSelect.value = state.activeCropMode;
}

// ---- header coordinate tracker ----
export function updateHeaderCoords(e) {
  if (!state.img) return;
  const rect = mainCanvas.getBoundingClientRect();
  const cx = e.clientX - rect.left,
    cy = e.clientY - rect.top;
  if (cx >= 0 && cy >= 0 && cx <= mainCanvas.width && cy <= mainCanvas.height) {
    const ox = Math.round(cx / state.scale),
      oy = Math.round(cy / state.scale);
    coordsEl.textContent = `x: ${ox}  y: ${oy}  |  w: —  h: —`;
  } else {
    coordsEl.textContent =
      state.selectionActive && state.cropW > 0
        ? `crop: ${state.cropW}×${state.cropH}`
        : `x: —  y: —  |  w: —  h: —`;
  }
}

export function onCanvasMouseLeave() {
  coordsEl.textContent =
    state.selectionActive && state.cropW > 0
      ? `crop active: ${state.cropW}×${state.cropH}`
      : `x: —  y: —  |  w: —  h: —`;
}
