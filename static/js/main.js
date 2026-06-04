import { state } from "./state.js";
import { mainCanvas } from "./canvas.js";
import { startCropping, onManualInputChange, setCrop } from "./crop.js";
import { onSelBoxMousemove, onSelBoxMouseDown } from "./drag.js";
import {
  selBox,
  inputX,
  inputY,
  inputW,
  inputH,
  previewCanvas,
  updateLivePreview,
  updateHeaderCoords,
  onCanvasMouseLeave,
  thumbStrip,
  carouselPrevBtn,
  carouselNextBtn,
  cropModeSelect,
  updateCropOutputStatus,
  syncCropModeUI,
} from "./ui.js";
import {
  handleFileSelection,
  fullReset,
  submitCrop,
  loadImageAtIndex,
} from "./upload.js";
import { initSuraSelects } from "./sura_selects.js";
import {
  boundsRectForPage,
  boundsRectFromPage,
  currentVisibleCropRect,
} from "./margins.js";

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const browseBtn = document.getElementById("browse-btn");
const startCropBtn = document.getElementById("start-crop-btn");
const resetBtn = document.getElementById("reset-btn");
const cropBtn = document.getElementById("crop-btn");
const saveBtn = document.getElementById("save-btn");
const newCropBtn = document.getElementById("new-crop-btn");
const submitBtn = document.getElementById("submit-btn");
const filenameInput = document.getElementById("filename-input");
const alternateHorizontalMarginInput = document.getElementById(
  "alternate-horizontal-margin",
);

function previewToBlob() {
  return new Promise((resolve) => {
    previewCanvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

function currentCropRect() {
  return currentVisibleCropRect();
}

function currentBoundsRect() {
  return boundsRectFromPage(currentVisibleCropRect());
}

function relativeIgnoreRect(templateRect) {
  const crop = currentCropRect();
  const inside =
    crop.left >= templateRect.left &&
    crop.top >= templateRect.top &&
    crop.left + crop.width <= templateRect.left + templateRect.width &&
    crop.top + crop.height <= templateRect.top + templateRect.height;
  if (!inside) return null;
  return {
    x: crop.left - templateRect.left,
    y: crop.top - templateRect.top,
    w: crop.width,
    h: crop.height,
  };
}

// ---- file selection ----
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());
browseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  fileInput.click();
});
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () =>
  dropZone.classList.remove("drag-over"),
);
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  handleFileSelection(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) handleFileSelection(fileInput.files);
});
alternateHorizontalMarginInput.addEventListener("change", () => {
  const previousAlternate = state.alternateHorizontalMargin;
  const activeBoundsCrop =
    state.activeCropMode === "bounds" &&
    state.selectionActive &&
    state.cropW > 0 &&
    state.cropH > 0;
  const canonicalBounds = activeBoundsCrop
    ? boundsRectFromPage(currentVisibleCropRect(), {
        alternate: previousAlternate,
      })
    : null;

  state.alternateHorizontalMargin = alternateHorizontalMarginInput.checked;

  if (canonicalBounds) {
    const visibleBounds = boundsRectForPage(canonicalBounds);
    setCrop(
      visibleBounds.left,
      visibleBounds.top,
      visibleBounds.width,
      visibleBounds.height,
      true,
    );
  }
});

const preferAccelerationInput = document.getElementById(
  "prefer-acceleration",
);
preferAccelerationInput.addEventListener("change", () => {
  state.preferAcceleration = preferAccelerationInput.checked;
});

initSuraSelects().catch((err) => {
  console.error(err);
  alert(
    `Could not load sura list (${err.message}). Ensure the server is running and reload.`,
  );
});

// ---- crop controls ----
startCropBtn.addEventListener("click", startCropping);
resetBtn.addEventListener("click", fullReset);
cropBtn.addEventListener("click", () => {
  if (!state.selectionActive || state.cropW <= 0 || state.cropH <= 0) return;
  updateLivePreview();
});
newCropBtn.addEventListener("click", () => {
  if (state.img) startCropping();
});

// ---- upload / save ----
submitBtn.addEventListener("click", submitCrop);
cropBtn.addEventListener("click", async () => {
  if (!state.selectionActive || state.cropW <= 0 || state.cropH <= 0) return;

  const mode = state.activeCropMode;
  if (mode === "bounds") {
    state.globalOutputs.bounds = currentBoundsRect();
    updateCropOutputStatus();
    return;
  }

  if (mode === "sura_header_ignore") {
    const templateRect = state.globalOutputs.suraHeaderRect;
    if (!templateRect) {
      alert("Crop sura_header before defining sura_header_ignore.");
      return;
    }
    const ignore = relativeIgnoreRect(templateRect);
    if (!ignore) {
      alert("sura_header_ignore must be fully inside the sura_header crop.");
      return;
    }
    state.globalOutputs.suraHeaderIgnore = ignore;
    updateCropOutputStatus();
    return;
  }

  if (mode === "aya_separator_ignore") {
    const templateRect = state.globalOutputs.ayaSeparatorRect;
    if (!templateRect) {
      alert("Crop aya_separator before defining aya_separator_ignore.");
      return;
    }
    const ignore = relativeIgnoreRect(templateRect);
    if (!ignore) {
      alert("aya_separator_ignore must be fully inside the aya_separator crop.");
      return;
    }
    state.globalOutputs.ayaSeparatorIgnore = ignore;
    updateCropOutputStatus();
    return;
  }

  const blob = await previewToBlob();
  if (!blob) return;
  if (mode === "sura_header") {
    state.globalOutputs.suraHeaderBlob = blob;
    state.globalOutputs.suraHeaderRect = currentCropRect();
    state.globalOutputs.suraHeaderIgnore = null;
  } else if (mode === "aya_separator") {
    state.globalOutputs.ayaSeparatorBlob = blob;
    state.globalOutputs.ayaSeparatorRect = currentCropRect();
    state.globalOutputs.ayaSeparatorIgnore = null;
  }
  updateCropOutputStatus();
});
saveBtn.addEventListener("click", () => {
  const filename = (filenameInput.value.trim() || "cropped") + ".png";
  previewCanvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }, "image/png");
});

// ---- crop mode + carousel ----
cropModeSelect.addEventListener("change", () => {
  state.activeCropMode = cropModeSelect.value;
  syncCropModeUI();
});

thumbStrip.addEventListener("click", (e) => {
  const btn = e.target.closest(".thumb");
  if (!btn) return;
  const index = Number(btn.dataset.index);
  if (!Number.isInteger(index)) return;
  loadImageAtIndex(index);
});

carouselPrevBtn.addEventListener("click", () => {
  loadImageAtIndex(state.selectedImageIndex - 1);
});
carouselNextBtn.addEventListener("click", () => {
  loadImageAtIndex(state.selectedImageIndex + 1);
});

// ---- manual coordinate inputs ----
[inputX, inputY, inputW, inputH].forEach((el) =>
  el.addEventListener("input", onManualInputChange),
);

// ---- canvas / selbox mouse events ----
selBox.addEventListener("mousemove", onSelBoxMousemove);
selBox.addEventListener("mousedown", onSelBoxMouseDown);
mainCanvas.addEventListener("mousemove", updateHeaderCoords);
mainCanvas.addEventListener("mouseleave", onCanvasMouseLeave);
window.addEventListener("dragstart", (e) => e.preventDefault());
