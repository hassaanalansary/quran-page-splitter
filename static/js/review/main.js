import {
  loadResults,
  loadStatus,
  loadSuras,
  saveResults,
} from "./api.js";
import {
  currentLine,
  currentPage,
  currentSegment,
  cloneData,
  notify,
  pushHistory,
  redo,
  replaceResults,
  selectLine,
  selectPage,
  selectSegment,
  selectSeparator,
  state,
  subscribe,
  undo,
} from "./state.js";
import {
  fitToCanvas,
  initCanvas,
  loadCurrentPageImage,
  renderCanvas,
} from "./canvas.js";
import { recalculateNumbering, regenerateSegments } from "./numbering.js";
import { buildWarnings, readMetadataFile } from "./validation.js";

const els = {};
let loadedPageImage = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  initCanvas(els.canvas);
  wireEvents();
  subscribe(render);

  try {
    state.status = await loadStatus();
    state.suras = await loadSuras();
    state.ayaCounts = new Map(
      state.suras.map((sura) => [Number(sura.number), Number(sura.aya_count)]),
    );
    if (!state.status.review_available) {
      renderUnavailable();
      return;
    }
    replaceResults(await loadResults("latest"));
  } catch (error) {
    renderError(error.message);
  }
}

function bindElements() {
  [
    "review-status",
    "page-title",
    "canvas-hint",
    "review-canvas",
    "fit-btn",
    "undo-btn",
    "redo-btn",
    "prev-page-btn",
    "next-page-btn",
    "page-strip",
    "line-list",
    "selection-panel",
    "validation-toggle",
    "metadata-file",
    "validation-panel",
    "save-review-btn",
    "reload-original-btn",
  ].forEach((id) => {
    els[toCamel(id)] = document.getElementById(id);
  });
  els.canvas = els.reviewCanvas;
}

function wireEvents() {
  els.fitBtn.addEventListener("click", fitToCanvas);
  els.undoBtn.addEventListener("click", undo);
  els.redoBtn.addEventListener("click", redo);
  els.prevPageBtn.addEventListener("click", () => selectPage(state.currentPageIndex - 1));
  els.nextPageBtn.addEventListener("click", () => selectPage(state.currentPageIndex + 1));
  els.validationToggle.addEventListener("change", () => {
    state.validationEnabled = els.validationToggle.checked;
    notify();
  });
  els.metadataFile.addEventListener("change", async () => {
    const file = els.metadataFile.files?.[0];
    state.customAyaCounts = file ? await readMetadataFile(file) : null;
    notify();
  });
  els.saveReviewBtn.addEventListener("click", saveReview);
  els.reloadOriginalBtn.addEventListener("click", reloadOriginal);
  document.addEventListener("keydown", onKeyDown);
}

function render() {
  if (!state.results) return;
  if (state.hasEdits) {
    recalculateNumbering(state.results, state.suras);
  }
  const page = currentPage();
  const pageImage = page?.page_image_filename || null;
  if (pageImage !== loadedPageImage) {
    loadedPageImage = pageImage;
    loadCurrentPageImage();
  }
  renderHeader();
  renderPages();
  renderLines();
  renderSelection();
  renderValidation();
  renderCanvas();
}

function renderHeader() {
  const page = currentPage();
  const total = state.results?.pages?.length || 0;
  els.reviewStatus.textContent = page
    ? `page ${state.currentPageIndex + 1} / ${total} · ${page.image_filename}`
    : "no page selected";
  els.pageTitle.textContent = page
    ? `// Page ${page.page_number} · ${page.image_filename}`
    : "// Page";
  els.canvasHint.textContent = state.addSeparatorMode
    ? "Click inside the selected text line to add a separator."
    : "Double-click a selected text line to add a separator. Drag selected line edges or separator cuts.";
  els.undoBtn.disabled = state.history.length === 0;
  els.redoBtn.disabled = state.future.length === 0;
}

function renderPages() {
  els.pageStrip.innerHTML = "";
  (state.results.pages || []).forEach((page, index) => {
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

function renderSelection() {
  const line = currentLine();
  if (!line) {
    els.selectionPanel.innerHTML = `<p class="empty-state">No line selected.</p>`;
    return;
  }

  els.selectionPanel.innerHTML = `
    <div class="field-grid">
      ${numberField("line-x", "X", line.line_bbox.x)}
      ${numberField("line-y", "Y", line.line_bbox.y)}
      ${numberField("line-w", "Width", line.line_bbox.w)}
      ${numberField("line-h", "Height", line.line_bbox.h)}
    </div>
    <div class="field">
      <label>Type</label>
      <select id="line-type">
        <option value="text" ${line.type === "text" ? "selected" : ""}>text</option>
        <option value="sura_header" ${line.type === "sura_header" ? "selected" : ""}>sura_header</option>
        <option value="basmala" ${line.type === "basmala" ? "selected" : ""}>basmala</option>
      </select>
    </div>
    <div class="line-ops">
      <button id="add-line-above-btn">Add above</button>
      <button id="add-line-below-btn">Add below</button>
      <button class="danger" id="delete-line-btn">Delete line</button>
    </div>
    <div id="line-specific"></div>
  `;
  ["x", "y", "w", "h"].forEach((key) => {
    document
      .getElementById(`line-${key}`)
      .addEventListener("change", (event) => updateLineBox(key, event.target.value));
  });
  document.getElementById("line-type").addEventListener("change", (event) => {
    updateLineType(event.target.value);
  });
  document.getElementById("add-line-above-btn").addEventListener("click", () => {
    insertLine("above");
  });
  document.getElementById("add-line-below-btn").addEventListener("click", () => {
    insertLine("below");
  });
  document.getElementById("delete-line-btn").addEventListener("click", deleteLine);
  renderLineSpecific(line);
}

function renderLineSpecific(line) {
  const container = document.getElementById("line-specific");
  if (line.type === "sura_header") {
    container.innerHTML = `
      <div class="field">
        <label>Sura anchor</label>
        <select id="sura-anchor">${suraOptions(line.manual_sura_anchor || line.sura_number)}</select>
      </div>
    `;
    document.getElementById("sura-anchor").addEventListener("change", (event) => {
      editWithHistory(() => {
        line.manual_sura_anchor = Number(event.target.value);
      });
    });
    return;
  }

  if (line.type === "basmala") {
    container.innerHTML = `
      <p class="empty-state">Basmala for Sura ${line.sura_number || "?"}.</p>
    `;
    return;
  }

  const segment = currentSegment();
  container.innerHTML = `
    <div class="review-actions">
      <button id="add-separator-btn">Add separator</button>
      <button id="remove-separator-btn" ${state.selectedSeparatorIndex == null ? "disabled" : ""}>Remove selected separator</button>
      <button id="delete-segment-btn" ${state.selectedSegmentIndex == null ? "disabled" : ""}>Delete selected segment</button>
    </div>
    <div class="field">
      <label>Selected aya anchor</label>
      <input id="aya-anchor" type="number" min="1" value="${segment?.manual_aya_anchor || segment?.aya_number || ""}" ${segment ? "" : "disabled"} />
    </div>
    <div id="segment-list"></div>
  `;
  document.getElementById("add-separator-btn").addEventListener("click", () => {
    state.addSeparatorMode = true;
    notify();
  });
  document.getElementById("remove-separator-btn").addEventListener("click", () => {
    deleteSelectedSeparator();
  });
  document.getElementById("delete-segment-btn").addEventListener("click", () => {
    deleteSelectedSegment();
  });
  document.getElementById("aya-anchor").addEventListener("change", (event) => {
    if (!segment) return;
    editWithHistory(() => {
      const value = Number(event.target.value);
      if (Number.isInteger(value) && value > 0) {
        segment.manual_aya_anchor = value;
      } else {
        delete segment.manual_aya_anchor;
      }
    });
  });
  renderSegments(line);
}

function renderSegments(line) {
  const container = document.getElementById("segment-list");
  container.innerHTML = "";
  (line.segments || []).forEach((segment, index) => {
    const row = document.createElement("div");
    row.className = `segment-row${index === state.selectedSegmentIndex ? " active" : ""}`;
    row.innerHTML = `
      <div>
        <div class="segment-title">Segment ${index + 1} · S${segment.sura_number || "?"}:A${segment.aya_number || "?"}</div>
        <div class="segment-subtitle">${segment.has_separator ? "ends aya" : "continuation"} · x ${segment.bbox.x}, w ${segment.bbox.w}</div>
      </div>
      <div class="segment-actions">
        <button>Select</button>
        <button class="danger">Delete</button>
      </div>
    `;
    const buttons = row.querySelectorAll("button");
    buttons[0].addEventListener("click", () => {
      selectSegment(state.selectedLineIndex, index);
    });
    buttons[1].addEventListener("click", () => {
      selectSegment(state.selectedLineIndex, index);
      deleteSegmentAt(line, index);
    });
    container.appendChild(row);
  });

  (line.separator_cuts || []).forEach((cut, index) => {
    const row = document.createElement("div");
    row.className = `segment-row${index === state.selectedSeparatorIndex ? " active" : ""}`;
    row.innerHTML = `
      <div>
        <div class="segment-title">Separator ${index + 1}</div>
        <div class="segment-subtitle">x ${cut}</div>
      </div>
      <div class="segment-actions">
        <button>Select</button>
        <button class="danger">Delete</button>
      </div>
    `;
    const buttons = row.querySelectorAll("button");
    buttons[0].addEventListener("click", () => {
      selectSeparator(state.selectedLineIndex, index);
    });
    buttons[1].addEventListener("click", () => {
      selectSeparator(state.selectedLineIndex, index);
      deleteSelectedSeparator();
    });
    container.appendChild(row);
  });
}

function renderValidation() {
  els.validationPanel.innerHTML = "";
  if (!state.validationEnabled) {
    els.validationPanel.innerHTML = `<p class="empty-state">Validation is disabled.</p>`;
    return;
  }
  const counts = state.customAyaCounts || state.ayaCounts;
  const warnings = buildWarnings(state.results, counts);
  if (!warnings.length) {
    els.validationPanel.innerHTML = `<p class="empty-state">No advisory warnings.</p>`;
    return;
  }
  warnings.forEach((warning) => {
    const item = document.createElement("div");
    item.className = "warning-item";
    item.innerHTML = `
      Sura ${warning.sura}: expected ${warning.expected}, found ${warning.found}.
      <br />
      <button>Jump to page ${warning.pageNumber || "?"}</button>
    `;
    item.querySelector("button").addEventListener("click", () => {
      const index = (state.results.pages || []).findIndex(
        (page) => page.page_number === warning.pageNumber,
      );
      if (index >= 0) selectPage(index);
    });
    els.validationPanel.appendChild(item);
  });
}

function updateLineBox(key, rawValue) {
  const line = currentLine();
  if (!line) return;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return;
  editWithHistory(() => {
    line.line_bbox[key] = key === "w" || key === "h" ? Math.max(1, value) : Math.max(0, value);
    if (line.type === "text") regenerateSegments(line);
  });
}

function onKeyDown(event) {
  if (event.key !== "Delete" || isEditableTarget(event.target)) return;
  if (state.selectedSeparatorIndex != null) {
    event.preventDefault();
    deleteSelectedSeparator();
    return;
  }
  if (state.selectedSegmentIndex != null) {
    event.preventDefault();
    deleteSelectedSegment();
    return;
  }
  if (state.selectedLineIndex != null) {
    event.preventDefault();
    deleteLine();
  }
}

function updateLineType(type) {
  const line = currentLine();
  if (!line || !["text", "sura_header", "basmala"].includes(type)) return;
  editWithHistory(() => {
    applyLineType(line, type);
  });
}

function insertLine(position) {
  const page = currentPage();
  const line = currentLine();
  if (!page || !line || state.selectedLineIndex == null) return;
  const insertIndex =
    position === "above" ? state.selectedLineIndex : state.selectedLineIndex + 1;
  editWithHistory(() => {
    const newLine = createLineNear(page, state.selectedLineIndex, position);
    page.lines.splice(insertIndex, 0, newLine);
    state.selectedLineIndex = insertIndex;
    state.selectedSegmentIndex = null;
    state.selectedSeparatorIndex = null;
    state.addSeparatorMode = false;
  });
}

function deleteLine() {
  const page = currentPage();
  if (!page || state.selectedLineIndex == null) return;
  editWithHistory(() => {
    page.lines.splice(state.selectedLineIndex, 1);
    if (!page.lines.length) {
      state.selectedLineIndex = null;
    } else {
      state.selectedLineIndex = Math.min(state.selectedLineIndex, page.lines.length - 1);
    }
    state.selectedSegmentIndex = null;
    state.selectedSeparatorIndex = null;
    state.addSeparatorMode = false;
  });
}

function deleteSelectedSeparator() {
  const line = currentLine();
  if (!line || state.selectedSeparatorIndex == null) return;
  editWithHistory(() => {
    line.separator_cuts.splice(state.selectedSeparatorIndex, 1);
    state.selectedSeparatorIndex = null;
    state.selectedSegmentIndex = null;
    regenerateSegments(line);
  });
}

function deleteSelectedSegment() {
  const line = currentLine();
  if (!line || state.selectedSegmentIndex == null) return;
  deleteSegmentAt(line, state.selectedSegmentIndex);
}

function deleteSegmentAt(line, segmentIndex) {
  editWithHistory(() => {
    const segments = line.segments || [];
    const segment = segments[segmentIndex];
    if (!segment?.bbox) return;

    if (segments.length === 1) {
      addDeletedRange(line, segment.bbox);
      state.selectedSegmentIndex = null;
      regenerateSegments(line);
      return;
    }

    if (segmentIndex === 0) {
      deleteRightEdgeSegment(line, segment);
    } else if (segmentIndex === segments.length - 1) {
      deleteLeftEdgeSegment(line, segment);
    } else {
      addDeletedRange(line, segment.bbox);
    }

    state.selectedSegmentIndex = null;
    state.selectedSeparatorIndex = null;
    regenerateSegments(line);
  });
}

function deleteLeftEdgeSegment(line, segment) {
  const right = line.line_bbox.x + line.line_bbox.w;
  const newLeft = segment.bbox.x + segment.bbox.w;
  if (newLeft >= right) {
    addDeletedRange(line, segment.bbox);
    return;
  }
  line.line_bbox.x = newLeft;
  line.line_bbox.w = right - newLeft;
  line.separator_cuts = Array.from(
    new Set([...(line.separator_cuts || []), newLeft]),
  );
  removeDeletedRangesOutsideLine(line);
}

function deleteRightEdgeSegment(line, segment) {
  const left = line.line_bbox.x;
  const newRight = segment.bbox.x;
  if (newRight <= left) {
    addDeletedRange(line, segment.bbox);
    return;
  }
  line.line_bbox.w = newRight - left;
  line.separator_cuts = (line.separator_cuts || []).filter(
    (cut) => Math.round(Number(cut)) !== Math.round(newRight),
  );
  removeDeletedRangesOutsideLine(line);
}

function addDeletedRange(line, bbox) {
  const range = {
    x: Math.round(Number(bbox.x)),
    w: Math.round(Number(bbox.w)),
  };
  if (!range.w || range.w < 1) return;
  const exists = (line.deleted_segment_ranges || []).some(
    (item) =>
      Math.round(Number(item.x)) === range.x &&
      Math.round(Number(item.w)) === range.w,
  );
  if (!exists) {
    line.deleted_segment_ranges = [...(line.deleted_segment_ranges || []), range];
  }
}

function removeDeletedRangesOutsideLine(line) {
  const left = line.line_bbox.x;
  const right = line.line_bbox.x + line.line_bbox.w;
  line.deleted_segment_ranges = (line.deleted_segment_ranges || []).filter((range) => {
    const start = Number(range.x);
    const end = start + Number(range.w);
    return start >= left && end <= right;
  });
}

function applyLineType(line, type) {
  line.type = type;
  line.slot_count = Number(line.slot_count || 1);
  state.selectedSegmentIndex = null;
  state.selectedSeparatorIndex = null;
  state.addSeparatorMode = false;

  if (type === "text") {
    delete line.manual_sura_anchor;
    delete line.sura_transliteration;
    if (!Array.isArray(line.separator_cuts)) {
      line.separator_cuts = Array.isArray(line.segments)
        ? line.segments
            .filter((segment) => segment.has_separator && segment.bbox)
            .map((segment) => segment.bbox.x)
        : [];
    }
    regenerateSegments(line);
    return;
  }

  delete line.segments;
  delete line.separator_cuts;
  delete line.deleted_segment_ranges;
  if (type === "sura_header") {
    line.manual_sura_anchor = Number(line.sura_number || state.results?.start_sura || 1);
  } else {
    delete line.manual_sura_anchor;
    delete line.sura_transliteration;
  }
}

function createLineNear(page, selectedIndex, position) {
  const selected = page.lines[selectedIndex];
  const box = suggestedLineBox(page, selectedIndex, position);
  const line = {
    line_number: selectedIndex + (position === "above" ? 1 : 2),
    slot_count: Number(selected?.slot_count || 1),
    line_bbox: box,
    type: "text",
    separator_cuts: [],
    segments: [],
  };
  regenerateSegments(line);
  return line;
}

function suggestedLineBox(page, selectedIndex, position) {
  const selected = page.lines[selectedIndex];
  const current = selected?.line_bbox || page.crop_box || { x: 0, y: 0, w: 100, h: 40 };
  const box = { ...current };
  const minHeight = Math.max(8, Math.round(current.h * 0.35));

  if (position === "above") {
    const previous = page.lines[selectedIndex - 1]?.line_bbox;
    if (previous) {
      const previousBottom = previous.y + previous.h;
      const gap = current.y - previousBottom;
      if (gap >= minHeight) {
        return { x: current.x, y: previousBottom, w: current.w, h: gap };
      }
    }
    box.y = Math.max(0, current.y - current.h);
    return box;
  }

  const next = page.lines[selectedIndex + 1]?.line_bbox;
  const currentBottom = current.y + current.h;
  if (next) {
    const gap = next.y - currentBottom;
    if (gap >= minHeight) {
      return { x: current.x, y: currentBottom, w: current.w, h: gap };
    }
  }
  box.y = currentBottom;
  return box;
}

function editWithHistory(callback) {
  pushHistory();
  callback();
  recalculateNumbering(state.results, state.suras);
  notify();
}

async function saveReview() {
  if (!state.results) return;
  els.saveReviewBtn.disabled = true;
  els.saveReviewBtn.textContent = "Saving...";
  try {
    if (state.hasEdits) {
      recalculateNumbering(state.results, state.suras);
    }
    const payload = cloneData(state.results);
    payload._review_has_edits = state.hasEdits;
    const response = await saveResults(payload);
    replaceResults(response.data);
    alert("Corrected data saved.");
  } catch (error) {
    alert(`Save failed: ${error.message}`);
  } finally {
    els.saveReviewBtn.disabled = false;
    els.saveReviewBtn.textContent = "Save corrected JSON";
  }
}

async function reloadOriginal() {
  try {
    replaceResults(await loadResults("original"));
  } catch (error) {
    alert(`Reload failed: ${error.message}`);
  }
}

function renderUnavailable() {
  els.reviewStatus.textContent = "review unavailable";
  els.selectionPanel.innerHTML = `
    <p class="empty-state">Run a normal export with coordinate output first.</p>
  `;
}

function renderError(message) {
  els.reviewStatus.textContent = "review failed";
  els.selectionPanel.innerHTML = `<p class="empty-state">${message}</p>`;
}

function lineSummary(line) {
  if (line.type === "text") return `${line.segments?.length || 0} seg`;
  if (line.type === "sura_header") return `S${line.sura_number || "?"}`;
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

function suraOptions(selected) {
  return state.suras
    .map((sura) => {
      const number = Number(sura.number);
      const isSelected = number === Number(selected) ? "selected" : "";
      return `<option value="${number}" ${isSelected}>${number} · ${sura.name}</option>`;
    })
    .join("");
}

function toCamel(id) {
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']"),
  );
}
