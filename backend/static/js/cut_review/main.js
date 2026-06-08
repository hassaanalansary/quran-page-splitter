import {
  exportLinePngs,
  loadResults,
  loadStatus,
  loadSuras,
  pageImageUrl,
  saveCutEdits,
} from "./api.js";
import {
  recalculateNumbering,
  regenerateSegments,
} from "../review/numbering.js";

const state = {
  status: null,
  data: null,
  sourceData: null,
  edits: null,
  suras: [],
  currentPageIndex: 0,
  selectedLineIndex: 0,
  image: null,
  loadedPageImage: null,
  brushSize: 16,
  activeStroke: null,
  activeEdgeDrag: null,
  dirty: false,
  view: null,
  shiftHeld: false,
  hoverEdge: null,
  mousePos: null,
};

const els = {};
let canvas;
let ctx;
let resizeObserver;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  canvas = els.cutCanvas;
  ctx = canvas.getContext("2d");
  resizeObserver = new ResizeObserver(resizeCanvas);
  resizeObserver.observe(canvas);
  wireEvents();
  resizeCanvas();
  await reloadAll();
}

function bindElements() {
  [
    "cut-status",
    "cut-page-title",
    "cut-line-title",
    "cut-canvas",
    "prev-line-btn",
    "next-line-btn",
    "undo-stroke-btn",
    "prev-page-btn",
    "next-page-btn",
    "page-strip",
    "line-list",
    "box-panel",
    "brush-size",
    "brush-readout",
    "clear-line-mask-btn",
    "save-cut-btn",
    "export-lines-btn",
    "reload-cut-btn",
    "mode-indicator",
  ].forEach((id) => {
    els[toCamel(id)] = document.getElementById(id);
  });
}

function wireEvents() {
  els.prevPageBtn.addEventListener("click", () => selectPage(state.currentPageIndex - 1));
  els.nextPageBtn.addEventListener("click", () => selectPage(state.currentPageIndex + 1));
  els.prevLineBtn.addEventListener("click", () => selectLine(state.selectedLineIndex - 1));
  els.nextLineBtn.addEventListener("click", () => selectLine(state.selectedLineIndex + 1));
  els.undoStrokeBtn.addEventListener("click", undoStroke);
  els.brushSize.addEventListener("input", () => {
    state.brushSize = Number(els.brushSize.value);
    render();
  });
  els.clearLineMaskBtn.addEventListener("click", clearLineMask);
  els.saveCutBtn.addEventListener("click", saveEdits);
  els.exportLinesBtn.addEventListener("click", exportLines);
  els.reloadCutBtn.addEventListener("click", reloadAll);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("mouseleave", onMouseLeave);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => {
    if (state.shiftHeld) {
      state.shiftHeld = false;
      state.hoverEdge = null;
      updateCursor();
      renderCanvas();
    }
  });
}

async function reloadAll() {
  try {
    state.status = await loadStatus();
    state.suras = await loadSuras();
    if (!state.status.cut_review_available) {
      renderUnavailable();
      return;
    }
    applyPayload(await loadResults(), { preserveSelection: false });
  } catch (error) {
    renderError(error.message);
  }
}

function applyPayload(payload, options = {}) {
  const pageIndex = state.currentPageIndex;
  const lineIndex = state.selectedLineIndex;
  state.sourceData = cloneData(payload.source_data);
  state.data = cloneData(payload.data);
  state.edits = cloneData(payload.edits);
  state.dirty = false;
  if (options.preserveSelection) {
    state.currentPageIndex = clamp(pageIndex, 0, (state.data.pages || []).length - 1);
    const page = currentPage();
    state.selectedLineIndex = clamp(lineIndex, 0, (page?.lines || []).length - 1);
  } else {
    state.currentPageIndex = 0;
    state.selectedLineIndex = 0;
  }
  state.image = null;
  state.loadedPageImage = null;
  loadCurrentPageImage();
  render();
}

function render() {
  if (!state.data) return;
  renderHeader();
  renderPages();
  renderLines();
  renderBoxPanel();
  renderCanvas();
}

function renderHeader() {
  const page = currentPage();
  const line = currentLine();
  const totalPages = state.data?.pages?.length || 0;
  const suffix = state.dirty ? " · unsaved" : "";
  els.cutStatus.textContent = page
    ? `page ${state.currentPageIndex + 1} / ${totalPages} · ${page.image_filename}${suffix}`
    : `no page selected${suffix}`;
  els.cutPageTitle.textContent = page
    ? `// Page ${page.page_number} · ${page.image_filename}`
    : "// Page";
  els.cutLineTitle.textContent = line
    ? `Line ${line.line_number || state.selectedLineIndex + 1} · ${line.type}`
    : "No line selected.";
  els.prevPageBtn.disabled = state.currentPageIndex <= 0;
  els.nextPageBtn.disabled = state.currentPageIndex >= totalPages - 1;
  els.prevLineBtn.disabled = state.selectedLineIndex <= 0;
  els.nextLineBtn.disabled =
    state.selectedLineIndex >= ((page?.lines || []).length - 1);
  els.undoStrokeBtn.disabled = !currentLineEdit()?.erase_strokes?.length;
  els.brushReadout.textContent = `${state.brushSize} px`;
}

function renderPages() {
  els.pageStrip.innerHTML = "";
  (state.data.pages || []).forEach((page, index) => {
    const button = document.createElement("button");
    button.className = `page-btn${index === state.currentPageIndex ? " active" : ""}`;
    button.textContent = String(page.page_number || index + 1).padStart(3, "0");
    button.addEventListener("click", () => selectPage(index));
    els.pageStrip.appendChild(button);
  });
}

function renderLines() {
  const page = currentPage();
  els.lineList.innerHTML = "";
  (page?.lines || []).forEach((line, index) => {
    const button = document.createElement("button");
    button.className = `line-btn${index === state.selectedLineIndex ? " active" : ""}`;
    button.innerHTML = `
      <span class="type-dot ${line.type}"></span>
      <span>L${line.line_number || index + 1} · ${line.type}</span>
      <span class="line-meta">${lineSummary(line)}</span>
    `;
    button.addEventListener("click", () => selectLine(index));
    els.lineList.appendChild(button);
  });
}

function renderBoxPanel() {
  const line = currentLine();
  if (!line?.line_bbox) {
    els.boxPanel.innerHTML = `<p class="empty-state">No line selected.</p>`;
    return;
  }

  const box = line.line_bbox;
  els.boxPanel.innerHTML = `
    <div class="field-grid">
      ${numberField("box-x", "X", box.x)}
      ${numberField("box-y", "Y", box.y)}
      ${numberField("box-w", "Width", box.w)}
      ${numberField("box-h", "Height", box.h)}
    </div>
    <div class="box-nudges">
      <button data-box-key="x" data-delta="-1">X-</button>
      <button data-box-key="x" data-delta="1">X+</button>
      <button data-box-key="y" data-delta="-1">Y-</button>
      <button data-box-key="y" data-delta="1">Y+</button>
      <button data-box-key="w" data-delta="-1">W-</button>
      <button data-box-key="w" data-delta="1">W+</button>
      <button data-box-key="h" data-delta="-1">H-</button>
      <button data-box-key="h" data-delta="1">H+</button>
    </div>
    <div class="review-actions">
      <button id="reset-line-box-btn">Reset Box</button>
    </div>
    <div class="cut-line-detail">
      <div>segments <span>${line.segments?.length || 0}</span></div>
      <div>eraser strokes <span>${currentLineEdit()?.erase_strokes?.length || 0}</span></div>
    </div>
  `;

  ["x", "y", "w", "h"].forEach((key) => {
    document
      .getElementById(`box-${key}`)
      .addEventListener("change", (event) => updateBoxValue(key, event.target.value));
  });
  els.boxPanel.querySelectorAll("[data-box-key]").forEach((button) => {
    button.addEventListener("click", () => {
      adjustBoxValue(button.dataset.boxKey, Number(button.dataset.delta));
    });
  });
  document.getElementById("reset-line-box-btn").addEventListener("click", resetLineBox);
}

function selectPage(index) {
  if (!state.data?.pages?.length) return;
  state.currentPageIndex = clamp(index, 0, state.data.pages.length - 1);
  state.selectedLineIndex = 0;
  state.loadedPageImage = null;
  loadCurrentPageImage();
  render();
}

function selectLine(index) {
  const page = currentPage();
  if (!page?.lines?.length) return;
  state.selectedLineIndex = clamp(index, 0, page.lines.length - 1);
  render();
}

function updateBoxValue(key, rawValue) {
  const line = currentLine();
  if (!line?.line_bbox) return;
  const value = Math.round(Number(rawValue));
  if (!Number.isFinite(value)) return;
  if (key === "w" || key === "h") {
    line.line_bbox[key] = Math.max(1, value);
  } else {
    line.line_bbox[key] = Math.max(0, value);
  }
  persistLineBoxEdit(line);
}

function adjustBoxValue(key, delta) {
  const line = currentLine();
  if (!line?.line_bbox) return;
  const current = Number(line.line_bbox[key]);
  updateBoxValue(key, current + delta);
}

function resetLineBox() {
  const sourceLine = currentSourceLine();
  const line = currentLine();
  if (!sourceLine?.line_bbox || !line?.line_bbox) return;
  line.line_bbox = cloneData(sourceLine.line_bbox);
  const edit = currentLineEdit();
  if (edit) {
    delete edit.bbox_override;
    pruneCurrentLineEdit();
  }
  updateDependentCoordinates(line);
  state.dirty = true;
  render();
}

function persistLineBoxEdit(line) {
  const edit = ensureLineEdit();
  edit.bbox_override = cloneData(line.line_bbox);
  updateDependentCoordinates(line);
  state.dirty = true;
  render();
}

function updateDependentCoordinates(line) {
  if (line.type === "text") regenerateSegments(line);
  recalculateNumbering(state.data, state.suras);
}

function onPointerDown(event) {
  if (!state.shiftHeld) {
    const edge = edgeFromEvent(event);
    if (edge) {
      canvas.setPointerCapture(event.pointerId);
      state.activeEdgeDrag = {
        edge,
        startBox: cloneData(currentLine().line_bbox),
        startView: cloneData(state.view),
      };
      return;
    }
  }

  const point = pagePointFromEvent(event);
  if (!point) return;
  canvas.setPointerCapture(event.pointerId);
  const edit = ensureLineEdit();
  const stroke = {
    id: `stroke-${Date.now()}-${Math.round(Math.random() * 100000)}`,
    brush_size: state.brushSize,
    points: [[Math.round(point.x), Math.round(point.y)]],
  };
  edit.erase_strokes = [...(edit.erase_strokes || []), stroke];
  state.activeStroke = stroke;
  state.dirty = true;
  render();
}

function onPointerMove(event) {
  const rect = canvas.getBoundingClientRect();
  state.mousePos = { x: event.clientX - rect.left, y: event.clientY - rect.top };

  if (state.activeEdgeDrag) {
    updateEdgeDrag(event);
    return;
  }

  if (state.activeStroke) {
    const point = pagePointFromEvent(event);
    if (!point) return;
    const rounded = [Math.round(point.x), Math.round(point.y)];
    const points = state.activeStroke.points;
    const last = points[points.length - 1];
    if (!last || Math.hypot(rounded[0] - last[0], rounded[1] - last[1]) >= 1) {
      points.push(rounded);
      state.dirty = true;
      renderCanvas();
    }
    return;
  }

  // Idle: update hover edge and cursor
  const edge = state.shiftHeld ? null : edgeFromEvent(event);
  if (edge !== state.hoverEdge) {
    state.hoverEdge = edge;
    updateCursor();
  }
  renderCanvas();
}

function onPointerUp() {
  state.activeStroke = null;
  state.activeEdgeDrag = null;
  updateCursor();
  render();
}

function onKeyDown(event) {
  if (event.key === "Shift" && !state.shiftHeld) {
    state.shiftHeld = true;
    state.hoverEdge = null;
    updateCursor();
    renderCanvas();
  }
}

function onKeyUp(event) {
  if (event.key === "Shift") {
    state.shiftHeld = false;
    updateCursor();
    renderCanvas();
  }
}

function onMouseLeave() {
  state.mousePos = null;
  state.hoverEdge = null;
  updateCursor();
  renderCanvas();
}

function updateEdgeDrag(event) {
  const drag = state.activeEdgeDrag;
  const line = currentLine();
  if (!drag || !line?.line_bbox) return;
  const local = previewLocalFromEvent(event, drag.startView);
  const start = drag.startBox;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  const next = { ...start };

  if (drag.edge === "left") {
    next.x = Math.min(right - 1, Math.max(0, Math.round(start.x + local.x)));
    next.w = Math.max(1, right - next.x);
  } else if (drag.edge === "right") {
    next.w = Math.max(1, Math.round(local.x));
  } else if (drag.edge === "top") {
    next.y = Math.min(bottom - 1, Math.max(0, Math.round(start.y + local.y)));
    next.h = Math.max(1, bottom - next.y);
  } else if (drag.edge === "bottom") {
    next.h = Math.max(1, Math.round(local.y));
  }

  line.line_bbox = next;
  persistLineBoxEdit(line);
}

function updateCursor() {
  let newCursor;
  if (state.shiftHeld && state.view) {
    newCursor = "none";
  } else if (!state.shiftHeld && (state.hoverEdge === "left" || state.hoverEdge === "right")) {
    newCursor = "ew-resize";
  } else if (!state.shiftHeld && (state.hoverEdge === "top" || state.hoverEdge === "bottom")) {
    newCursor = "ns-resize";
  } else {
    newCursor = "crosshair";
  }
  if (canvas.style.cursor !== newCursor) canvas.style.cursor = newCursor;
  updateModeIndicator();
}

function updateModeIndicator() {
  if (!els.modeIndicator) return;
  let badgeClass = "mode-badge";
  let badgeText = "RESIZE";
  let hintText = "hold Shift to erase";

  if (state.shiftHeld) {
    badgeClass = "mode-badge mode-badge--erase";
    badgeText = "ERASE";
    hintText = "release Shift to resize";
  } else if (state.hoverEdge === "left" || state.hoverEdge === "right") {
    badgeClass = "mode-badge mode-badge--resize";
    badgeText = "RESIZE ←→";
  } else if (state.hoverEdge === "top" || state.hoverEdge === "bottom") {
    badgeClass = "mode-badge mode-badge--resize";
    badgeText = "RESIZE ↑↓";
  }

  const html = `<span class="${badgeClass}">${badgeText}</span><span class="mode-hint">${hintText}</span>`;
  if (els.modeIndicator.innerHTML !== html) els.modeIndicator.innerHTML = html;
}

function undoStroke() {
  const edit = currentLineEdit();
  if (!edit?.erase_strokes?.length) return;
  edit.erase_strokes.pop();
  pruneCurrentLineEdit();
  state.dirty = true;
  render();
}

function clearLineMask() {
  const edit = currentLineEdit();
  if (!edit) return;
  delete edit.erase_strokes;
  pruneCurrentLineEdit();
  state.dirty = true;
  render();
}

async function saveEdits() {
  els.saveCutBtn.disabled = true;
  els.saveCutBtn.textContent = "Saving...";
  try {
    const response = await saveCutEdits(state.edits);
    applyPayload(response, { preserveSelection: true });
    alert("Cut edits saved.");
  } catch (error) {
    alert(`Save failed: ${error.message}`);
  } finally {
    els.saveCutBtn.disabled = false;
    els.saveCutBtn.textContent = "Save cut JSON";
  }
}

async function exportLines() {
  els.exportLinesBtn.disabled = true;
  els.exportLinesBtn.textContent = "Exporting...";
  try {
    const saved = await saveCutEdits(state.edits);
    applyPayload(saved, { preserveSelection: true });
    const response = await exportLinePngs();
    alert(`Exported ${response.exported_images} line PNGs.`);
  } catch (error) {
    alert(`Export failed: ${error.message}`);
  } finally {
    els.exportLinesBtn.disabled = false;
    els.exportLinesBtn.textContent = "Export line PNGs";
  }
}

async function loadCurrentPageImage() {
  const page = currentPage();
  if (!page?.page_image_filename) {
    state.image = null;
    renderCanvas();
    return;
  }
  if (state.loadedPageImage === page.page_image_filename) return;
  state.loadedPageImage = page.page_image_filename;
  const image = new Image();
  image.onload = () => {
    state.image = image;
    renderCanvas();
  };
  image.onerror = () => {
    state.image = null;
    renderCanvas();
  };
  image.src = pageImageUrl(page.page_image_filename);
}

function resizeCanvas() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    renderCanvas();
  }
}

function renderCanvas() {
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  state.view = null;

  if (!state.image || !currentLine()?.line_bbox) {
    drawEmpty("No line loaded");
    updateCursor();
    return;
  }

  drawLinePreview();
  if (state.shiftHeld && state.mousePos && state.view) {
    drawBrushCursor(state.mousePos.x, state.mousePos.y);
  }
  updateCursor();
}

function drawLinePreview() {
  const line = currentLine();
  const box = line.line_bbox;
  const width = Math.max(1, Math.round(box.w));
  const height = Math.max(1, Math.round(box.h));
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext("2d");
  offCtx.drawImage(
    state.image,
    box.x,
    box.y,
    box.w,
    box.h,
    0,
    0,
    width,
    height,
  );
  makeWhiteTransparent(offCtx, width, height);
  applyEraserStrokes(offCtx, currentLineEdit()?.erase_strokes || [], box);

  const maxWidth = Math.max(1, canvas.clientWidth - 32);
  const maxHeight = Math.max(1, canvas.clientHeight - 32);
  const scale = Math.max(0.05, Math.min(maxWidth / width, maxHeight / height));
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  const offsetX = (canvas.clientWidth - drawWidth) / 2;
  const offsetY = (canvas.clientHeight - drawHeight) / 2;
  state.view = { scale, offsetX, offsetY, bbox: cloneData(box), width, height };

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreen, offsetX, offsetY, drawWidth, drawHeight);
  drawPreviewGuides(line, offsetX, offsetY, scale, box);
  ctx.restore();
}

function makeWhiteTransparent(targetCtx, width, height) {
  const imageData = targetCtx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) {
      data[i + 3] = 0;
    }
  }
  targetCtx.putImageData(imageData, 0, 0);
}

function applyEraserStrokes(targetCtx, strokes, box) {
  targetCtx.save();
  targetCtx.globalCompositeOperation = "destination-out";
  targetCtx.lineCap = "round";
  targetCtx.lineJoin = "round";
  for (const stroke of strokes) {
    const points = stroke.points || [];
    const brush = Math.max(1, Number(stroke.brush_size || 12));
    targetCtx.lineWidth = brush;
    targetCtx.beginPath();
    points.forEach((point, index) => {
      const x = Number(point[0]) - box.x;
      const y = Number(point[1]) - box.y;
      if (index === 0) targetCtx.moveTo(x, y);
      else targetCtx.lineTo(x, y);
    });
    targetCtx.stroke();
    for (const point of points) {
      const x = Number(point[0]) - box.x;
      const y = Number(point[1]) - box.y;
      targetCtx.beginPath();
      targetCtx.arc(x, y, brush / 2, 0, Math.PI * 2);
      targetCtx.fill();
    }
  }
  targetCtx.restore();
}

function drawPreviewGuides(line, offsetX, offsetY, scale, box) {
  ctx.save();
  ctx.strokeStyle = "rgba(232, 213, 163, 0.85)";
  ctx.lineWidth = 2;
  ctx.strokeRect(offsetX, offsetY, box.w * scale, box.h * scale);
  ctx.strokeStyle = "rgba(255, 141, 106, 0.75)";
  ctx.setLineDash([8, 6]);
  for (const cut of line.separator_cuts || []) {
    const x = offsetX + (Number(cut) - box.x) * scale;
    if (x < offsetX || x > offsetX + box.w * scale) continue;
    ctx.beginPath();
    ctx.moveTo(x, offsetY);
    ctx.lineTo(x, offsetY + box.h * scale);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBrushCursor(x, y) {
  const radius = Math.max(2, (state.brushSize / 2) * state.view.scale);
  ctx.save();
  ctx.setLineDash([]);
  // Outer white ring
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Inner dark ring for contrast on light backgrounds
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, radius - 1.5), 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Centre crosshair
  const hair = 4;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - hair, y);
  ctx.lineTo(x + hair, y);
  ctx.moveTo(x, y - hair);
  ctx.lineTo(x, y + hair);
  ctx.stroke();
  ctx.restore();
}

function pagePointFromEvent(event) {
  if (!state.view) return null;
  const local = previewLocalFromEvent(event, state.view);
  if (
    local.x < 0 ||
    local.y < 0 ||
    local.x > state.view.width ||
    local.y > state.view.height
  ) {
    return null;
  }
  return {
    x: state.view.bbox.x + local.x,
    y: state.view.bbox.y + local.y,
  };
}

function previewLocalFromEvent(event, view) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - view.offsetX) / view.scale,
    y: (event.clientY - rect.top - view.offsetY) / view.scale,
  };
}

function edgeFromEvent(event) {
  if (!state.view || !currentLine()?.line_bbox) return null;
  const local = previewLocalFromEvent(event, state.view);
  const tolerance = 10 / state.view.scale;
  if (
    local.x < -tolerance ||
    local.y < -tolerance ||
    local.x > state.view.width + tolerance ||
    local.y > state.view.height + tolerance
  ) {
    return null;
  }
  if (Math.abs(local.x) <= tolerance) return "left";
  if (Math.abs(local.x - state.view.width) <= tolerance) return "right";
  if (Math.abs(local.y) <= tolerance) return "top";
  if (Math.abs(local.y - state.view.height) <= tolerance) return "bottom";
  return null;
}

function drawEmpty(text) {
  ctx.fillStyle = "#0b0b0b";
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.fillStyle = "#6b6860";
  ctx.font = "13px IBM Plex Mono, monospace";
  ctx.fillText(text, 24, 32);
}

function currentPage() {
  return state.data?.pages?.[state.currentPageIndex] || null;
}

function currentLine() {
  return currentPage()?.lines?.[state.selectedLineIndex] || null;
}

function currentSourceLine() {
  const sourcePage = state.sourceData?.pages?.[state.currentPageIndex];
  const line = currentLine();
  if (!sourcePage || !line) return null;
  return (sourcePage.lines || []).find(
    (sourceLine) => Number(sourceLine.line_number) === Number(line.line_number),
  );
}

function ensureLineEdit() {
  const pageEdit = ensurePageEdit();
  const line = currentLine();
  let lineEdit = (pageEdit.lines || []).find(
    (item) => Number(item.line_number) === Number(line.line_number),
  );
  if (!lineEdit) {
    lineEdit = { line_number: Number(line.line_number || state.selectedLineIndex + 1) };
    pageEdit.lines.push(lineEdit);
  }
  return lineEdit;
}

function ensurePageEdit() {
  const page = currentPage();
  if (!state.edits.pages) state.edits.pages = [];
  let pageEdit = state.edits.pages.find(
    (item) =>
      item.page_image_filename === page.page_image_filename ||
      Number(item.page_number) === Number(page.page_number),
  );
  if (!pageEdit) {
    pageEdit = {
      page_number: page.page_number,
      image_filename: page.image_filename,
      page_image_filename: page.page_image_filename,
      lines: [],
    };
    state.edits.pages.push(pageEdit);
  }
  if (!pageEdit.lines) pageEdit.lines = [];
  return pageEdit;
}

function currentLineEdit() {
  const page = currentPage();
  const line = currentLine();
  if (!page || !line || !state.edits?.pages) return null;
  const pageEdit = state.edits.pages.find(
    (item) =>
      item.page_image_filename === page.page_image_filename ||
      Number(item.page_number) === Number(page.page_number),
  );
  if (!pageEdit?.lines) return null;
  return pageEdit.lines.find(
    (item) => Number(item.line_number) === Number(line.line_number),
  );
}

function pruneCurrentLineEdit() {
  const page = currentPage();
  const line = currentLine();
  if (!page || !line || !state.edits?.pages) return;
  const pageEdit = state.edits.pages.find(
    (item) =>
      item.page_image_filename === page.page_image_filename ||
      Number(item.page_number) === Number(page.page_number),
  );
  if (!pageEdit?.lines) return;
  pageEdit.lines = pageEdit.lines.filter((item) => {
    if (Number(item.line_number) !== Number(line.line_number)) return true;
    return Boolean(item.bbox_override || item.erase_strokes?.length);
  });
  state.edits.pages = state.edits.pages.filter((item) => item.lines?.length);
}

function lineSummary(line) {
  if (line.type === "text") return `${line.segments?.length || 0} seg`;
  return `S${line.sura_number || "?"}`;
}

function numberField(id, label, value) {
  return `
    <div class="field">
      <label for="${id}">${label}</label>
      <input id="${id}" type="number" step="1" value="${value}" />
    </div>
  `;
}

function renderUnavailable() {
  els.cutStatus.textContent = "cut review unavailable";
  els.boxPanel.innerHTML = `<p class="empty-state">Run a coordinate export first.</p>`;
  drawEmpty("No cut data available");
}

function renderError(message) {
  els.cutStatus.textContent = "cut review failed";
  els.boxPanel.innerHTML = `<p class="empty-state">${message}</p>`;
  drawEmpty(message);
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  if (!Number.isFinite(max) || max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function toCamel(id) {
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}