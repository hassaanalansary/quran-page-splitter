import { state } from "./state.js";
import { drawToCanvas, ctx, mainCanvas } from "./canvas.js";
import { deactivateCrop, clampCropBounds } from "./crop.js";
import {
  previewSec,
  submitBtn,
  coordsEl,
  updateQueueInfo,
  renderCarousel,
  updateCropOutputStatus,
  syncCropModeUI,
  updateUIFromCrop,
} from "./ui.js";

const MAX_FILES = 610;
const ENDPOINT = "http://localhost:8000/upload/";
const naturalNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function sortFilesByName(files) {
  return [...files].sort((a, b) => naturalNameCollator.compare(a.name, b.name));
}

// ---- queue setup ----
export function handleFileSelection(files) {
  const images = sortFilesByName(
    Array.from(files).filter((f) => f.type.startsWith("image/")),
  );
  if (images.length === 0) return;
  if (images.length > MAX_FILES) {
    alert(`Only the first ${MAX_FILES} images will be used.`);
  }
  state.imageFiles = images.slice(0, MAX_FILES);
  state.selectedImageIndex = 0;
  state.globalOutputs.bounds = null;
  state.globalOutputs.suraNameBlob = null;
  state.globalOutputs.ayaSeparatorBlob = null;
  state.activeCropMode = "bounds";
  loadImageAtIndex(0, { resetCrop: true });
  updateQueueInfo();
  renderCarousel();
  updateCropOutputStatus();
  syncCropModeUI();
}

export function loadImageAtIndex(index, options = {}) {
  const { resetCrop = false } = options;
  if (!state.imageFiles.length) return;
  const clamped = Math.max(0, Math.min(index, state.imageFiles.length - 1));
  state.selectedImageIndex = clamped;
  loadImageFile(state.imageFiles[clamped], { resetCrop });
  renderCarousel();
}

function loadImageFile(file, options = {}) {
  const { resetCrop = true } = options;
  const url = URL.createObjectURL(file);
  const imgEl = new Image();
  imgEl.onload = () => {
    state.img = imgEl;
    state.currentImageFile = file;
    state.imgNaturalWidth = imgEl.width;
    state.imgNaturalHeight = imgEl.height;
    drawToCanvas(imgEl);

    document.getElementById("drop-zone").style.display = "none";
    document.getElementById("left-stack").style.display = "flex";
    document.getElementById("canvas-wrapper").style.display = "block";
    document.getElementById("toolbar").style.display = "flex";
    previewSec.style.display = "none";
    document.getElementById("workspace").classList.add("cropper-active");

    if (resetCrop) {
      deactivateCrop();
      state.selectionActive = false;
    } else if (
      state.selectionActive &&
      state.cropW > 0 &&
      state.cropH > 0
    ) {
      clampCropBounds();
      updateUIFromCrop();
    } else if (state.globalOutputs.bounds) {
      const b = state.globalOutputs.bounds;
      state.cropX = b.left;
      state.cropY = b.top;
      state.cropW = b.width;
      state.cropH = b.height;
      state.selectionActive = true;
      clampCropBounds();
      updateUIFromCrop();
    } else {
      deactivateCrop();
      state.selectionActive = false;
    }

    document.getElementById("start-crop-btn").disabled = false;
    URL.revokeObjectURL(url);
  };
  imgEl.src = url;
}

// ---- full reset ----
export function fullReset() {
  document.getElementById("drop-zone").style.display = "";
  document.getElementById("left-stack").style.display = "none";
  document.getElementById("canvas-wrapper").style.display = "none";
  document.getElementById("toolbar").style.display = "none";
  previewSec.style.display = "none";
  document.getElementById("workspace").classList.remove("cropper-active");
  state.img = null;
  state.currentImageFile = null;
  state.imageFiles = [];
  state.selectedImageIndex = 0;
  state.activeCropMode = "bounds";
  state.alternateHorizontalMargin = false;
  document.getElementById("alternate-horizontal-margin").checked = false;
  state.globalOutputs.bounds = null;
  state.globalOutputs.suraNameBlob = null;
  state.globalOutputs.ayaSeparatorBlob = null;
  state.exportImages = true;
  state.exportCoordinates = false;
  state.startSura = 1;
  state.startAya = 1;
  document.getElementById("export-images").checked = true;
  document.getElementById("export-coordinates").checked = false;
  document.getElementById("start-sura").value = "1";
  document.getElementById("start-aya").value = "1";
  document.getElementById("start-sura-group").style.display = "none";
  document.getElementById("start-aya-group").style.display = "none";
  document.getElementById("file-input").value = "";
  deactivateCrop();
  state.selectionActive = false;
  document.getElementById("start-crop-btn").disabled = true;
  coordsEl.textContent = `x: —  y: —  |  w: —  h: —`;
  ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
  updateQueueInfo();
  renderCarousel();
  updateCropOutputStatus();
  syncCropModeUI();
}

// ---- POST submission ----
export async function submitCrop() {
  const { bounds, suraNameBlob, ayaSeparatorBlob } = state.globalOutputs;
  if (!state.imageFiles.length) {
    alert("Please upload images first.");
    return;
  }
  if (!bounds || !suraNameBlob || !ayaSeparatorBlob) {
    alert("Please complete bounds, sura_name, and aya_separator crops first.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Uploading…";

  const fd = new FormData();
  state.imageFiles.forEach((f) => fd.append("images", f));
  fd.append("crop_x", bounds.left);
  fd.append("crop_y", bounds.top);
  fd.append("crop_w", bounds.width);
  fd.append("crop_h", bounds.height);
  fd.append("sura_name", suraNameBlob, "sura_name.png");
  fd.append("aya_separator", ayaSeparatorBlob, "aya_separator.png");
  fd.append("gap_threshold", document.getElementById("gap-threshold").value);
  fd.append("min_line_height", document.getElementById("min-line-height").value);
  fd.append("padding", document.getElementById("padding").value);
  fd.append("alternate_horizontal_margin", state.alternateHorizontalMargin);
  fd.append("export_images", state.exportImages);
  fd.append("export_coordinates", state.exportCoordinates);
  fd.append("start_sura", state.startSura);
  fd.append("start_aya", state.startAya);

  try {
    const res = await fetch(ENDPOINT, { method: "POST", body: fd });
    if (res.ok) {
      alert(`✓ ${state.imageFiles.length} image(s) uploaded successfully.`);
    } else {
      alert(`Server error: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    alert(`Request failed: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "↑ Upload all";
  }
}
